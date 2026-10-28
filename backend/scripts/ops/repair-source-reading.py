#!/usr/bin/env python3
"""Restore reader configuration changed by the source transfer, without enabling sources."""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import shutil
import sys
import importlib.util

SPEC=importlib.util.spec_from_file_location('source_reading_transfer',Path(__file__).with_name('transfer-sources.py'))
t=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=t;SPEC.loader.exec_module(t)


def repair_sql(payload):
    t.validate(payload)
    literal="'"+json.dumps(payload['sources'],ensure_ascii=False).replace("'","''")+"'::jsonb"
    tag='$repair_'+hashlib.sha256(literal.encode()).hexdigest()[:16]+'$'
    if tag in literal:raise t.TransferError('REPAIR_DELIMITER_COLLISION')
    sql=r"""BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL standard_conforming_strings=on;
SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';
LOCK TABLE public.sources IN SHARE ROW EXCLUSIVE MODE;
DO __TAG__
DECLARE incoming jsonb:=__PAYLOAD__; item jsonb; src public.sources; expected jsonb; owner_id uuid;
 changed integer:=0; retried integer:=0; n integer; approvals jsonb; original jsonb;
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'REPAIR_DATABASE_MISMATCH'; END IF;
 SELECT user_id INTO STRICT owner_id FROM public.memberships WHERE workspace_id='__WORKSPACE__' AND role='Owner' AND active;
 SELECT jsonb_object_agg(id,approval) INTO approvals FROM public.sources;
 FOR item IN SELECT value FROM jsonb_array_elements(incoming) LOOP
  SELECT * INTO STRICT src FROM public.sources WHERE workspace_id='__WORKSPACE__' AND id=(item->>'id')::uuid FOR UPDATE;
  original:=to_jsonb(src);
  IF (src.adapter_config-'automatic')<>((item->'adapter_config')-'automatic') THEN RAISE EXCEPTION 'REPAIR_PROFILE_CHANGED'; END IF;
  expected:=src.adapter_config-'automatic';
  IF item->'adapter_config'?'automatic' THEN expected:=expected||jsonb_build_object('automatic',item#>'{adapter_config,automatic}'); END IF;
  IF expected<>src.adapter_config THEN
   UPDATE public.sources SET adapter_config=expected,revision=revision+1,updated_at=now() WHERE id=src.id RETURNING * INTO src;
   IF original-ARRAY['adapter_config','revision','updated_at']<>to_jsonb(src)-ARRAY['adapter_config','revision','updated_at'] THEN RAISE EXCEPTION 'REPAIR_UNEXPECTED_CHANGE'; END IF;
   INSERT INTO public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
    VALUES(src.workspace_id,owner_id,'source.reader.restored',src.id,'Restore original reader mode after migration; approval and schedules preserved.',gen_random_uuid());
   changed:=changed+1;
  END IF;
  -- The Owner has already approved this source. Recover only its observed access-path failure.
  IF src.adapter_config#>>'{catalog,key}'='sa-etimad' AND src.approval='approved' AND src.adapter_config->'automatic'='true'::jsonb THEN
   UPDATE public.jobs SET status='queued',cancel_requested=false,attempts=0,next_attempt_at=now(),error_code=NULL,
    input_hash=src.revision::text,lease_token=NULL,lease_until=NULL,revision=revision+1,updated_at=now()
    WHERE workspace_id=src.workspace_id AND entity_id=src.id AND type='source_collect' AND status='blocked'
     AND error_code='MANUAL_SOURCE_REQUIRED' AND NOT cancel_requested;
   GET DIAGNOSTICS n=ROW_COUNT;
   IF n>0 THEN
    UPDATE public.sources SET next_due=now()+make_interval(hours=>poll_interval_hours),health='unknown',updated_at=now() WHERE id=src.id;
    INSERT INTO public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
     VALUES(src.workspace_id,owner_id,'source.reader.retry',src.id,'Retry Owner-enabled Etimad with restored browser-capable reader.',gen_random_uuid());
   END IF;
   retried:=retried+n;
  END IF;
 END LOOP;
 IF approvals<>(SELECT jsonb_object_agg(id,approval) FROM public.sources) THEN RAISE EXCEPTION 'REPAIR_APPROVAL_CHANGED'; END IF;
 PERFORM set_config('tenderdesk.reader_repair',jsonb_build_object('reader_configs_restored',changed,'selected_jobs_requeued',retried,'approvals_preserved',true)::text,true);
END __TAG__;
SELECT current_setting('tenderdesk.reader_repair'); COMMIT;"""
    return sql.replace('__TAG__',tag).replace('__WORKSPACE__',t.WORKSPACE).replace('__PAYLOAD__',literal)


def main():
    p=argparse.ArgumentParser();p.add_argument('--payload',required=True,type=Path);p.add_argument('--expected-sha256',required=True);a=p.parse_args()
    directory=None;pod=None
    try:
        raw=a.payload.read_bytes()
        if not hmac.compare_digest(hashlib.sha256(raw).hexdigest(),a.expected_sha256):raise t.TransferError('REPAIR_DIGEST_MISMATCH')
        payload=t.validate(json.loads(raw));directory=t.prepare_cluster();d=t.d
        if d.get('secret','tenderdesk-migration-admin'):raise t.TransferError('REPAIR_OTHER_ADMIN_IN_PROGRESS')
        credentials,ca=d.probe.target_credentials(os.environ['DIGITALOCEAN_ACCESS_TOKEN'])
        if not hmac.compare_digest(d.decode_secret(d.get('secret','tenderdesk-core')).get('PGSSLCA',''),ca):raise t.TransferError('REPAIR_CA_MISMATCH')
        pod='migration-client-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']
        d.sql_pod({**credentials,'APP_DATABASE':d.DATABASE,'ROLE_PREFIX':d.PREFIX})
        print(d.sql(pod,repair_sql(payload)),flush=True)
    except Exception as e:
        safe=str(e) if isinstance(e,(t.TransferError,t.d.DeployError,t.d.probe.ProbeError)) else type(e).__name__
        print(json.dumps({'repair':'failed','code':safe}));return 1
    finally:
        if pod:t.d.cleanup_administrator(pod)
        if directory:shutil.rmtree(directory)
    return 0


if __name__=='__main__':sys.exit(main())
