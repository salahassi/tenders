#!/usr/bin/env python3
"""One-time, Owner-authorized recovery of never-sent missing-key assessments.

Recurring credential sync must never call this helper. All business commands
retain canonical authorization, revisions, snapshots, idempotency and auditing.
"""
from __future__ import annotations
import argparse
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time

SPEC=importlib.util.spec_from_file_location('assessment_recovery_transfer',Path(__file__).with_name('transfer-sources.py'))
t=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=t;SPEC.loader.exec_module(t)


class RecoveryError(Exception):
    pass


def recovery_sql(action: str, batch_id: str, ready_aliases=(), enable_task_routing=False):
    if action not in {'sample','remaining','status','retry-sample'} or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}',batch_id):
        raise RecoveryError('ASSESSMENT_ACTION_INVALID')
    if enable_task_routing and action!='sample':raise RecoveryError('ASSESSMENT_ENABLE_SAMPLE_ONLY')
    aliases=sorted(set(ready_aliases))
    if any(not re.fullmatch(r'APP_MODEL_[A-Z0-9_]{1,80}_KEY',x) for x in aliases):raise RecoveryError('ASSESSMENT_ALIAS_INVALID')
    alias_sql="'"+json.dumps(aliases).replace("'","''")+"'::jsonb"
    reason='Owner-authorized automated provider remediation; batch='+batch_id
    # The admin is already authorized by the user's request. This selects a real
    # active Owner and separately confirms its Auth account before administrative
    # delegation to canonical commands. No token, session or account is minted.
    prefix=r"""BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s';
SET LOCAL ROLE tdp_app_owner;
DO $owner_guard$ DECLARE actor uuid; BEGIN
 IF current_database()<>'tenderdesk_app' OR (SELECT count(*) FROM public.workspaces)<>1
  OR NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id='__WORKSPACE__')
 THEN RAISE EXCEPTION 'ASSESSMENT_DATABASE_IDENTITY_MISMATCH'; END IF;
 SELECT m.user_id INTO STRICT actor FROM public.memberships m JOIN public.identity_allowlist a
  ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
  WHERE m.workspace_id='__WORKSPACE__' AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner';
 PERFORM set_config('tenderdesk.remediation_owner',actor::text,true);
END $owner_guard$;
RESET ROLE; SET LOCAL ROLE tdp_app_authadmin;
DO $auth_guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM auth.users u WHERE id=current_setting('tenderdesk.remediation_owner')::uuid
  AND email_confirmed_at IS NOT NULL AND nullif(to_jsonb(u)->>'deleted_at','') IS NULL
  AND coalesce(nullif(to_jsonb(u)->>'banned_until','')::timestamptz,'-infinity')<=now())
 THEN RAISE EXCEPTION 'ASSESSMENT_OWNER_ACCOUNT_INVALID'; END IF;
END $auth_guard$;
RESET ROLE; SET LOCAL ROLE tdp_app_owner;
"""
    body=r"""
DO $recover$
DECLARE actor uuid:=current_setting('tenderdesk.remediation_owner')::uuid;
 marker_reason text:='__REASON__'; sample public.generation_plans; original_sample public.generation_plans;
 latest_sample public.generation_plans; old_plan public.generation_plans; retry_job public.jobs;
 opp public.opportunities; result jsonb; settings public.model_execution_settings;
 count_started integer:=0; has_sample boolean:=false; sample_complete boolean:=false;
 sample_current boolean:=false; followed_successor boolean:=false; waiting_successor boolean:=false;
 sample_retried boolean:=false; sample_retry_already_requested boolean:=false;
 aliases jsonb:=__ALIASES__; action_name text:='__ACTION__'; snapshot jsonb;
BEGIN
 PERFORM 1 FROM public.workspaces WHERE id='__WORKSPACE__' FOR UPDATE;
 SELECT p.* INTO sample FROM public.audit_events a JOIN public.generation_plans p ON p.id=a.entity_id
  WHERE a.workspace_id='__WORKSPACE__' AND a.action='ops.model_assessment.sample' AND a.reason=marker_reason
   AND a.actor_id=actor AND p.workspace_id=a.workspace_id AND p.kind='assessment'
  ORDER BY a.created_at DESC,a.id DESC LIMIT 1;
 has_sample:=sample.id IS NOT NULL;
 IF NOT has_sample AND EXISTS(SELECT 1 FROM public.audit_events WHERE workspace_id='__WORKSPACE__'
  AND action='ops.model_assessment.sample' AND reason=marker_reason) THEN RAISE EXCEPTION 'ASSESSMENT_SAMPLE_MARKER_INVALID'; END IF;
 IF has_sample THEN
  original_sample:=sample;
  SELECT p.* INTO latest_sample FROM public.generation_plans p JOIN public.opportunities o
    ON o.id=p.opportunity_id AND o.workspace_id=p.workspace_id
   WHERE p.workspace_id=original_sample.workspace_id AND p.opportunity_id=original_sample.opportunity_id
    AND p.kind='assessment' AND NOT o.archived
   ORDER BY p.created_at DESC,p.id DESC LIMIT 1;
  -- Refreshing public notice details canonically cancels the pre-detail plan
  -- and schedules a new immutable snapshot. Observe that successor; do not
  -- retry the canceled plan or change any provider request or graph state.
  IF original_sample.status='canceled' AND original_sample.error_code='NOTICE_DETAILS_REFRESHED'
    AND latest_sample.id IS NOT NULL THEN
   IF latest_sample.status<>'canceled'
     AND (latest_sample.created_at,latest_sample.id)>(original_sample.created_at,original_sample.id) THEN
    sample:=latest_sample;followed_successor:=true;
    INSERT INTO public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
     SELECT sample.workspace_id,actor,'ops.model_assessment.sample.successor',sample.id,marker_reason,gen_random_uuid()
     WHERE NOT EXISTS(SELECT 1 FROM public.audit_events a WHERE a.workspace_id=sample.workspace_id
      AND a.actor_id=actor AND a.action='ops.model_assessment.sample.successor'
      AND a.entity_id=sample.id AND a.reason=marker_reason);
   ELSIF latest_sample.status='canceled' AND latest_sample.error_code='NOTICE_DETAILS_REFRESHED' THEN
    waiting_successor:=true;
   END IF;
  END IF;
  sample_current:=latest_sample.id IS NOT NULL AND sample.id=latest_sample.id;
 END IF;
 sample_complete:=has_sample AND sample_current AND sample.status='completed'
  AND EXISTS(SELECT 1 FROM public.fit_assessments f WHERE f.plan_id=sample.id AND f.workspace_id=sample.workspace_id);
 IF action_name<>'status' THEN
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  IF app_private.member_role('__WORKSPACE__') IS DISTINCT FROM 'Owner' THEN RAISE EXCEPTION 'ASSESSMENT_OWNER_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM public.restore_sessions WHERE workspace_id='__WORKSPACE__' AND state IN ('staging','committing'))
   THEN RAISE EXCEPTION 'ASSESSMENT_RESTORE_IN_PROGRESS'; END IF;
  IF action_name='remaining' AND NOT sample_complete THEN RAISE EXCEPTION 'ASSESSMENT_SAMPLE_NOT_COMPLETED'; END IF;
  IF action_name='retry-sample' AND (NOT has_sample OR NOT sample_current OR waiting_successor)
   THEN RAISE EXCEPTION 'ASSESSMENT_SAMPLE_RETRY_NOT_CURRENT'; END IF;
  SELECT * INTO STRICT settings FROM public.model_execution_settings WHERE workspace_id='__WORKSPACE__';
  IF NOT settings.enabled AND __ENABLE__ AND NOT has_sample THEN
   -- Check the saved assessment/default route, without changing its order or
   -- adding a provider simply because a credential happens to exist.
   IF NOT EXISTS(
    SELECT 1 FROM public.model_task_routes r JOIN public.model_configurations m ON m.id=ANY(r.model_ids)
     JOIN public.model_connections c ON c.id=m.connection_id
    WHERE r.workspace_id='__WORKSPACE__' AND r.task IN ('default','classify_opportunity')
     AND m.enabled AND c.enabled AND aliases?c.credential_alias)
   THEN RAISE EXCEPTION 'ASSESSMENT_ROUTED_CREDENTIAL_REQUIRED'; END IF;
   result:=public.app_command('model.execution.configure',jsonb_build_object('enabled',true,'expected_revision',settings.revision),
    '__BATCH__-enable-execution');
   INSERT INTO public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
    VALUES('__WORKSPACE__',actor,'ops.model_assessment.execution.enabled',(result->>'id')::uuid,marker_reason,gen_random_uuid());
   SELECT * INTO STRICT settings FROM public.model_execution_settings WHERE workspace_id='__WORKSPACE__';
  END IF;
  IF NOT settings.enabled THEN RAISE EXCEPTION 'ASSESSMENT_EXECUTION_DISABLED'; END IF;
  IF action_name='retry-sample' THEN
   SELECT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.jobs j ON j.id=a.entity_id
    WHERE a.workspace_id=sample.workspace_id AND a.actor_id=actor AND a.action='ops.model_assessment.sample.retried'
     AND a.reason=marker_reason AND j.workspace_id=sample.workspace_id AND j.entity_id=sample.id)
    INTO sample_retry_already_requested;
   IF NOT sample_retry_already_requested THEN
    IF sample.status<>'blocked' OR sample.error_code IS DISTINCT FROM 'GENERATION_HANDLER_FAILED'
     THEN RAISE EXCEPTION 'ASSESSMENT_SAMPLE_RETRY_UNSAFE_STATE'; END IF;
    IF EXISTS(SELECT 1 FROM public.provider_usage u JOIN public.jobs j ON j.id=u.job_id
      WHERE j.workspace_id=sample.workspace_id AND j.entity_id=sample.id)
     OR EXISTS(SELECT 1 FROM public.model_attempts a JOIN public.jobs j ON j.id=a.job_id
      WHERE j.workspace_id=sample.workspace_id AND j.entity_id=sample.id AND a.sent)
     THEN RAISE EXCEPTION 'ASSESSMENT_SAMPLE_RETRY_PRIOR_SEND_OR_USAGE'; END IF;
    SELECT j.* INTO STRICT retry_job FROM public.jobs j JOIN public.generation_steps s
     ON s.job_id=j.id AND s.workspace_id=j.workspace_id AND s.plan_id=j.entity_id
     WHERE j.workspace_id=sample.workspace_id AND j.entity_id=sample.id AND s.status='queued' AND s.stage=sample.stage
      AND j.status IN ('blocked','failed') AND j.error_code='GENERATION_HANDLER_FAILED'
      AND NOT j.cancel_requested AND j.input_hash=sample.input_hash;
    result:=public.app_command('job.action',jsonb_build_object('id',retry_job.id,'expected_revision',retry_job.revision,
      'action','retry','reason',marker_reason),'__BATCH__-retry-sample-'||retry_job.id::text);
    IF result->>'id' IS DISTINCT FROM retry_job.id::text OR coalesce(result->>'status','') NOT IN ('queued','running','retry_wait')
     THEN RAISE EXCEPTION 'ASSESSMENT_SAMPLE_RETRY_NOT_ACCEPTED'; END IF;
    INSERT INTO public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
     VALUES(sample.workspace_id,actor,'ops.model_assessment.sample.retried',retry_job.id,marker_reason,gen_random_uuid());
    SELECT * INTO STRICT sample FROM public.generation_plans WHERE id=sample.id AND workspace_id=sample.workspace_id;
    sample_retried:=true;
   END IF;
  END IF;
  IF action_name IN ('sample','remaining') AND (action_name='remaining' OR NOT has_sample) THEN
   FOR old_plan IN
    SELECT p.* FROM public.generation_plans p JOIN public.opportunities o ON o.id=p.opportunity_id
    WHERE p.workspace_id='__WORKSPACE__' AND p.kind='assessment' AND p.status='blocked' AND p.error_code='MODEL_NOT_CONFIGURED'
     AND NOT o.archived
     AND NOT EXISTS(SELECT 1 FROM public.generation_plans later WHERE later.workspace_id=p.workspace_id
      AND later.opportunity_id=p.opportunity_id AND later.kind='assessment' AND later.status<>'canceled'
      AND (later.created_at,later.id)>(p.created_at,p.id))
     AND NOT EXISTS(SELECT 1 FROM public.jobs j WHERE j.entity_id=p.id AND j.status='running')
     AND NOT EXISTS(SELECT 1 FROM public.model_attempts a JOIN public.jobs j ON j.id=a.job_id WHERE j.entity_id=p.id AND a.sent)
     AND NOT EXISTS(SELECT 1 FROM public.provider_usage u JOIN public.jobs j ON j.id=u.job_id WHERE j.entity_id=p.id)
    ORDER BY p.created_at,p.id LIMIT CASE WHEN action_name='sample' THEN 1 ELSE 100 END
   LOOP
    result:=public.app_command('generation.cancel',jsonb_build_object('id',old_plan.id,'expected_revision',old_plan.revision,
      'reason',marker_reason),'__BATCH__-cancel-'||old_plan.id::text);
    SELECT * INTO STRICT opp FROM public.opportunities WHERE id=old_plan.opportunity_id;
    result:=public.app_command('opportunity.assess',jsonb_build_object('id',opp.id,'expected_revision',opp.revision),
      '__BATCH__-assess-'||opp.id::text);
    INSERT INTO public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
     VALUES('__WORKSPACE__',actor,CASE WHEN action_name='sample' THEN 'ops.model_assessment.sample' ELSE 'ops.model_assessment.recovered' END,
      (result->>'id')::uuid,marker_reason,gen_random_uuid());
    IF action_name='sample' THEN
     SELECT * INTO STRICT sample FROM public.generation_plans WHERE id=(result->>'id')::uuid;
     has_sample:=true;sample_current:=true;
    END IF;
    count_started:=count_started+1;
   END LOOP;
  END IF;
 END IF;
 PERFORM set_config('tenderdesk.assessment_recovery',jsonb_build_object(
  'action',action_name,'started',count_started,'sample_exists',has_sample,'sample_status',sample.status,
  'sample_error',CASE WHEN has_sample AND NOT sample_current AND NOT waiting_successor THEN 'ASSESSMENT_SAMPLE_SUPERSEDED' ELSE sample.error_code END,
  'sample_completed',sample_complete,'sample_current',sample_current,
  'sample_followed_successor',followed_successor,'sample_waiting_successor',waiting_successor,
  'sample_retried',sample_retried,'sample_retry_already_requested',sample_retry_already_requested,
  'blocked_missing_configuration',(SELECT count(*) FROM public.generation_plans WHERE workspace_id='__WORKSPACE__'
    AND kind='assessment' AND status='blocked' AND error_code='MODEL_NOT_CONFIGURED'),
  'sample_jobs',(SELECT coalesce(jsonb_agg(jsonb_build_object('status',j.status,'error_code',j.error_code,'attempts',j.attempts)),'[]') FROM public.jobs j WHERE j.entity_id=sample.id),
  'sample_attempts',(SELECT coalesce(jsonb_agg(jsonb_build_object('provider',a.provider,'status',a.status,'result_code',a.result_code,'sent',a.sent,'http_status',a.http_status)),'[]')
    FROM public.model_attempts a JOIN public.jobs j ON j.id=a.job_id WHERE j.entity_id=sample.id)
 )::text,true);
END $recover$;
SELECT current_setting('tenderdesk.assessment_recovery'); COMMIT;
"""
    return (prefix+body).replace('__WORKSPACE__',t.WORKSPACE).replace('__ACTION__',action).replace('__ENABLE__','true' if enable_task_routing else 'false').replace('__REASON__',reason).replace('__BATCH__',batch_id).replace('__ALIASES__',alias_sql)


def run(action,batch_id,enable_task_routing=False,wait_seconds=0):
    directory=None;pod=None
    try:
        directory=t.prepare_cluster();d=t.d
        if d.get('secret','tenderdesk-migration-admin'):raise RecoveryError('ASSESSMENT_OTHER_ADMIN_IN_PROGRESS')
        credentials,ca=d.probe.target_credentials(os.environ['DIGITALOCEAN_ACCESS_TOKEN'])
        if not hmac.compare_digest(d.decode_secret(d.get('secret','tenderdesk-core')).get('PGSSLCA',''),ca):raise RecoveryError('ASSESSMENT_CA_MISMATCH')
        runtime=d.decode_secret(d.get('secret','tenderdesk-runtime')) or {}
        aliases=[k for k,v in runtime.items() if v and re.fullmatch(r'APP_MODEL_[A-Z0-9_]{1,80}_KEY',k)]
        pod='migration-client-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']
        d.sql_pod({**credentials,'APP_DATABASE':d.DATABASE,'ROLE_PREFIX':d.PREFIX})
        deadline=time.monotonic()+wait_seconds
        previous=None
        while True:
            receipt=json.loads(d.sql(pod,recovery_sql(action,batch_id,aliases,enable_task_routing)))
            public=json.dumps(receipt,sort_keys=True)
            if public!=previous:print(public,flush=True);previous=public
            if not wait_seconds or action!='status':return 0
            if receipt['sample_completed']:return 0
            if (not receipt['sample_exists'] or (not receipt.get('sample_current',True) and not receipt.get('sample_waiting_successor',False))
                or (receipt['sample_status'] in ('blocked','failed','canceled') and not receipt.get('sample_waiting_successor',False))):
                return 1
            if time.monotonic()>=deadline:return 2
            time.sleep(min(10,max(0,deadline-time.monotonic())))
    finally:
        if pod:t.d.cleanup_administrator(pod)
        if directory:shutil.rmtree(directory)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--action',required=True,choices=['sample','remaining','status','retry-sample']);p.add_argument('--batch-id',required=True);p.add_argument('--enable-task-routing',action='store_true');p.add_argument('--wait-seconds',type=int,default=0);a=p.parse_args()
    try:
        recovery_sql(a.action,a.batch_id,(),a.enable_task_routing)
        if a.wait_seconds and (a.action!='status' or not 1<=a.wait_seconds<=900):raise RecoveryError('ASSESSMENT_WAIT_INVALID')
        return run(a.action,a.batch_id,a.enable_task_routing,a.wait_seconds)
    except Exception as e:
        safe=str(e) if isinstance(e,(RecoveryError,t.d.DeployError,t.d.probe.ProbeError)) and re.fullmatch(r'[A-Z0-9_]{1,100}',str(e)) else 'ASSESSMENT_RECOVERY_FAILED'
        print(json.dumps({'assessment_recovery':'blocked','code':safe}),flush=True);return 1
    return 0


if __name__=='__main__':sys.exit(main())
