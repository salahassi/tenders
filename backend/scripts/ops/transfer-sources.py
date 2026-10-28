#!/usr/bin/env python3
"""Transfer the authorized private source snapshot into DO with collection disabled.

No source rows, SQL, credentials or private responses may enter public logs.
The payload is downloaded separately through the existing encrypted transport.
"""
from __future__ import annotations
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sys
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import importlib.util
SPEC = importlib.util.spec_from_file_location('sources_deploy', HERE / 'digitalocean-deploy.py')
d = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = d
SPEC.loader.exec_module(d)
WORKSPACE = '64d3c4c3-0c4a-46fa-b6ce-3b1965d3c72d'
PROJECT = 'nqfwbqeozmuiuwbiowil'
FIELDS = frozenset('id workspace_id name kind url approved_hosts approval health poll_interval_hours next_due last_success_at policy_note adapter_config created_by created_at updated_at revision tags etag last_modified policy_checked_at adapter_required'.split())


class TransferError(Exception):
    pass


def validate(payload):
    if (not isinstance(payload, dict) or set(payload) != {'captured_at', 'source_project', 'workspace_id', 'sources'}
        or payload['source_project'] != PROJECT or payload['workspace_id'] != WORKSPACE
        or not isinstance(payload['sources'], list) or len(payload['sources']) != 36):
        raise TransferError('SOURCE_PAYLOAD_MISMATCH')
    seen = set()
    for row in payload['sources']:
        if not isinstance(row, dict) or set(row) != FIELDS or row['workspace_id'] != WORKSPACE:
            raise TransferError('SOURCE_ROW_MISMATCH')
        for key in ('id', 'created_by'):
            try:
                if str(uuid.UUID(row[key])) != row[key]:
                    raise ValueError()
            except (ValueError, TypeError, AttributeError):
                raise TransferError('SOURCE_UUID_INVALID') from None
        if row['id'] in seen or not isinstance(row['adapter_config'], dict):
            raise TransferError('SOURCE_ROW_INVALID')
        seen.add(row['id'])
    return payload


def migration_sql(payload, *, verify_only=False):
    validate(payload)
    literal = "'" + json.dumps(payload['sources'], ensure_ascii=False).replace("'", "''") + "'::jsonb"
    # No TEMP privilege, superuser, dynamic identifiers or arbitrary SQL input.
    script = r"""
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL standard_conforming_strings=on;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='60s';
LOCK TABLE public.sources IN SHARE ROW EXCLUSIVE MODE;
DO $source_transfer$
DECLARE
 incoming jsonb := __PAYLOAD__;
 item jsonb; original jsonb; expected jsonb; old_rows jsonb;
 candidate public.sources; prior public.sources; after_row public.sources;
 owner_id uuid; matches integer; inserted integer:=0; matched integer:=0; disabled integer:=0;
 targets uuid[] := '{}';
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'SOURCE_DATABASE_MISMATCH'; END IF;
 IF (SELECT count(*) FROM public.workspaces)<>1 OR NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id='__WORKSPACE__')
 THEN RAISE EXCEPTION 'SOURCE_WORKSPACE_MISMATCH'; END IF;
 SELECT user_id INTO STRICT owner_id FROM public.memberships WHERE workspace_id='__WORKSPACE__' AND role='Owner' AND active;
 SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') INTO old_rows FROM public.sources s;
 FOR item IN SELECT value FROM jsonb_array_elements(incoming) LOOP
  candidate:=jsonb_populate_record(NULL::public.sources,item);
  SELECT count(*) INTO matches FROM public.sources s WHERE s.workspace_id=candidate.workspace_id AND
   (s.id=candidate.id OR (candidate.url IS NOT NULL AND s.url=candidate.url)
    OR (item#>>'{adapter_config,catalog,key}' IS NOT NULL AND s.adapter_config#>>'{catalog,key}'=item#>>'{adapter_config,catalog,key}')
    OR (candidate.kind='manual' AND candidate.url IS NULL AND s.kind='manual' AND s.url IS NULL AND s.name=candidate.name));
  IF matches>1 THEN RAISE EXCEPTION 'SOURCE_AMBIGUOUS_MATCH'; END IF;
  IF matches=1 THEN
   SELECT s.* INTO STRICT prior FROM public.sources s WHERE s.workspace_id=candidate.workspace_id AND
    (s.id=candidate.id OR (candidate.url IS NOT NULL AND s.url=candidate.url)
     OR (item#>>'{adapter_config,catalog,key}' IS NOT NULL AND s.adapter_config#>>'{catalog,key}'=item#>>'{adapter_config,catalog,key}')
     OR (candidate.kind='manual' AND candidate.url IS NULL AND s.kind='manual' AND s.url IS NULL AND s.name=candidate.name));
   original:=to_jsonb(prior);
   candidate:=prior;
   matched:=matched+1;
  ELSE
   IF EXISTS(SELECT 1 FROM public.sources WHERE id=candidate.id) THEN RAISE EXCEPTION 'SOURCE_FOREIGN_ID'; END IF;
   original:=item;
  END IF;
  IF candidate.id=ANY(targets) THEN RAISE EXCEPTION 'SOURCE_DUPLICATE_TARGET'; END IF;
  targets:=array_append(targets,candidate.id);
  candidate.approval:=CASE WHEN candidate.approval='rejected' THEN 'rejected' ELSE 'paused' END;
  candidate.next_due:=NULL;
  expected:=to_jsonb(candidate);
  IF __VERIFY_ONLY__ THEN
   IF matches<>1 OR original<>expected THEN RAISE EXCEPTION 'SOURCE_DISABLED_VERIFICATION_FAILED'; END IF;
  ELSIF matches=0 THEN
   INSERT INTO public.workspace_actors(workspace_id,id,kind) VALUES(candidate.workspace_id,candidate.created_by,'historical') ON CONFLICT DO NOTHING;
   candidate.revision:=candidate.revision+1;
   candidate.updated_at:=now();
   INSERT INTO public.sources SELECT candidate.*;
   inserted:=inserted+1;
  ELSIF original<>expected THEN
   UPDATE public.sources SET approval=candidate.approval,next_due=NULL,
    revision=revision+1,updated_at=now() WHERE id=candidate.id RETURNING * INTO candidate;
   disabled:=disabled+1;
  END IF;
  IF NOT __VERIFY_ONLY__ AND (matches=0 OR original<>expected) THEN
   INSERT INTO public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
    VALUES(candidate.workspace_id,owner_id,CASE WHEN matches=0 THEN 'source.migrated_from_supabase' ELSE 'source.migration.disabled' END,
     candidate.id,jsonb_build_object('source_project','__PROJECT__','source_id',item->>'id','original_approval',original->>'approval',
      'owner_request','Transfer sources with all collection disabled')::text,gen_random_uuid());
  END IF;
  SELECT s.* INTO STRICT after_row FROM public.sources s WHERE id=candidate.id;
  IF to_jsonb(after_row)<>to_jsonb(candidate) OR after_row.approval='approved' OR after_row.next_due IS NOT NULL
   THEN RAISE EXCEPTION 'SOURCE_COPY_MISMATCH'; END IF;
 END LOOP;
 -- Preserve every pre-existing definition, allowing only the requested disable fields.
 FOR original IN SELECT value FROM jsonb_array_elements(old_rows) LOOP
  SELECT to_jsonb(s) INTO STRICT expected FROM public.sources s WHERE s.id=(original->>'id')::uuid;
  IF (original->>'id')::uuid=ANY(targets) THEN
   IF original-ARRAY['approval','next_due','adapter_config','revision','updated_at']<>expected-ARRAY['approval','next_due','adapter_config','revision','updated_at']
    OR (original->'adapter_config')-'automatic'<>(expected->'adapter_config')-'automatic'
   THEN RAISE EXCEPTION 'SOURCE_EXISTING_DEFINITION_CHANGED'; END IF;
  ELSIF original<>expected THEN RAISE EXCEPTION 'SOURCE_UNRELATED_ROW_CHANGED'; END IF;
 END LOOP;
 PERFORM set_config('tenderdesk.source_transfer_receipt',jsonb_build_object('expected',jsonb_array_length(incoming),
  'inserted',inserted,'matched_existing',matched,'existing_disabled',disabled,'verified_disabled',cardinality(targets),
  'verify_only',__VERIFY_ONLY__)::text,true);
END $source_transfer$;
SELECT current_setting('tenderdesk.source_transfer_receipt');
COMMIT;
"""
    tag='$source_transfer_'+hashlib.sha256(literal.encode()).hexdigest()[:16]+'$'
    if tag in literal: raise TransferError('SOURCE_DELIMITER_COLLISION')
    return (script.replace('__WORKSPACE__', WORKSPACE).replace('__PROJECT__', PROJECT)
            .replace('__VERIFY_ONLY__', 'true' if verify_only else 'false').replace('$source_transfer$',tag)
            .replace('__PAYLOAD__', literal))


def prepare_cluster():
    os.umask(0o077)
    run, attempt = os.environ['GITHUB_RUN_ID'], os.environ['GITHUB_RUN_ATTEMPT']
    if not re.fullmatch(r'[0-9]{1,20}',run) or not re.fullmatch(r'[0-9]{1,6}',attempt):
        raise TransferError('SOURCE_RUN_IDENTITY_INVALID')
    directory = Path(os.environ['RUNNER_TEMP']) / ('td-sources-'+run+'-'+attempt)
    directory.mkdir(mode=0o700, exist_ok=False)
    d.runner.write(directory/'kubeconfig', d.runner.request('kubernetes/clusters/'+d.runner.CLUSTER+'/kubeconfig?expiry_seconds=3600'))
    base='https://dl.k8s.io/release/v1.37.0/bin/linux/amd64/kubectl'
    with urllib.request.urlopen(base, timeout=60) as response:
        binary=response.read(80_000_001)
    with urllib.request.urlopen(base+'.sha256', timeout=60) as response:
        checksum=response.read(100).decode().strip()
    if not re.fullmatch(r'[a-f0-9]{64}',checksum) or hashlib.sha256(binary).hexdigest()!=checksum:
        raise TransferError('SOURCE_CLIENT_CHECKSUM_FAILED')
    d.runner.write(directory/'kubectl',binary)
    (directory/'kubectl').chmod(0o700)
    os.environ.update(KUBECTL=str(directory/'kubectl'),KUBECONFIG=str(directory/'kubeconfig'))
    d.probe.validate_cluster()
    return directory


def transfer(path, digest):
    if not re.fullmatch(r'[a-f0-9]{64}',digest): raise TransferError('SOURCE_DIGEST_REQUIRED')
    raw=path.read_bytes()
    if not hmac.compare_digest(hashlib.sha256(raw).hexdigest(),digest): raise TransferError('SOURCE_DIGEST_MISMATCH')
    payload=validate(json.loads(raw))
    d.probe.validate_cluster()
    for kind,name in [('namespace',d.NAMESPACE),('configmap','database-restoration')]:
        resource=d.get(kind,name)
        if not resource or resource.get('metadata',{}).get('labels',{}).get('app.kubernetes.io/managed-by')!='tenderdesk-deployment':
            raise TransferError('SOURCE_TARGET_OWNERSHIP_REQUIRED')
    if d.get('secret','tenderdesk-migration-admin'):
        raise TransferError('SOURCE_OTHER_ADMIN_IN_PROGRESS')
    credentials,ca=d.probe.target_credentials(os.environ['DIGITALOCEAN_ACCESS_TOKEN'])
    core=d.get('secret','tenderdesk-core')
    if (not core or core.get('metadata',{}).get('labels',{}).get('app.kubernetes.io/managed-by')!='tenderdesk-deployment'
        or not hmac.compare_digest(d.decode_secret(core).get('PGSSLCA',''),ca)):
        raise TransferError('SOURCE_DATABASE_CA_MISMATCH')
    pod='migration-client-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']
    try:
        d.sql_pod({**credentials,'APP_DATABASE':d.DATABASE,'ROLE_PREFIX':d.PREFIX})
        state=d.restore_state(pod)
        marker=d.get('configmap','database-restoration')['data']
        if not state or state.get('stage')!='seed' or any(state[k]!=marker.get(k) for k in ['schema_sha256','seed_sha256']):
            raise TransferError('SOURCE_RESTORATION_IDENTITY_MISMATCH')
        receipt=json.loads(d.sql(pod,migration_sql(payload)))
        verification=json.loads(d.sql(pod,migration_sql(payload,verify_only=True)))
        if verification['verified_disabled']!=36 or not verification['verify_only']:
            raise TransferError('SOURCE_READBACK_FAILED')
        print(json.dumps({'source_transfer':'verified',**receipt},sort_keys=True),flush=True)
        return receipt
    finally:
        d.cleanup_administrator(pod)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--payload',required=True,type=Path)
    parser.add_argument('--expected-sha256',required=True)
    args=parser.parse_args()
    directory=None
    try:
        directory=prepare_cluster()
        transfer(args.payload,args.expected_sha256)
    except Exception as error:
        safe=str(error) if isinstance(error,(TransferError,d.DeployError,d.probe.ProbeError)) and re.fullmatch(r'[A-Z_0-9]{1,100}',str(error)) else 'SOURCE_TRANSFER_FAILED'
        print(json.dumps({'source_transfer':'blocked','code':safe}),flush=True)
        return 1
    finally:
        import shutil
        if directory: shutil.rmtree(directory)
    return 0


if __name__=='__main__': sys.exit(main())
