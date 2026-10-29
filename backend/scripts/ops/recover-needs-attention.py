#!/usr/bin/env python3
"""Inspect operational attention and retry eligible technical failures after acceptance.

This preserves frozen plan history, model usage and permission/human-review gates.
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

SPEC=importlib.util.spec_from_file_location('attention_assessment_recovery',Path(__file__).with_name('recover-model-assessments.py'))
r=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=r;SPEC.loader.exec_module(r)
t=r.t


def attention_sql(action,batch_id):
    if action not in {'inspect','recover'} or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}',batch_id):
        raise r.RecoveryError('ATTENTION_ACTION_INVALID')
    # Reuse the reviewed identity/account guard; the following body makes the
    # Owner delegation only after its separate sample-success guard.
    prefix=r.recovery_sql('status',batch_id).split('DO $recover$',1)[0]
    if action=='inspect':prefix=prefix.replace('BEGIN ISOLATION LEVEL SERIALIZABLE;','BEGIN READ ONLY;')
    body=r"""
DO $attention$
DECLARE actor uuid:=current_setting('tenderdesk.remediation_owner')::uuid;
 marker_reason text:='Owner-authorized Need attention retry; batch=__BATCH__';
 sample_reason text:='Owner-authorized automated provider remediation; batch=__BATCH__';
 action_name text:='__ACTION__'; sample_ok boolean; j public.jobs; p public.generation_plans;
 src public.sources; result jsonb; category text; code text;
 considered integer:=0; retried integer:=0; skipped jsonb:='{}'; details jsonb;
BEGIN
 SELECT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.generation_plans sample_plan ON sample_plan.id=a.entity_id
  JOIN public.fit_assessments f ON f.plan_id=sample_plan.id AND f.workspace_id=sample_plan.workspace_id
  WHERE a.workspace_id='__WORKSPACE__' AND a.action='ops.model_assessment.sample'
   AND a.reason=sample_reason AND sample_plan.status='completed') INTO sample_ok;
 IF action_name='recover' THEN
  IF NOT sample_ok THEN RAISE EXCEPTION 'ATTENTION_SAMPLE_NOT_COMPLETED'; END IF;
  PERFORM 1 FROM public.workspaces WHERE id='__WORKSPACE__' FOR UPDATE;
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  IF app_private.member_role('__WORKSPACE__') IS DISTINCT FROM 'Owner' THEN RAISE EXCEPTION 'ATTENTION_OWNER_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM public.restore_sessions WHERE workspace_id='__WORKSPACE__' AND state IN ('staging','committing'))
   THEN RAISE EXCEPTION 'ATTENTION_RESTORE_IN_PROGRESS'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.model_execution_settings WHERE workspace_id='__WORKSPACE__' AND enabled)
   THEN RAISE EXCEPTION 'ATTENTION_EXECUTION_DISABLED'; END IF;
 END IF;
 FOR j IN SELECT * FROM public.jobs WHERE workspace_id='__WORKSPACE__' AND status IN ('blocked','failed') ORDER BY updated_at,id LIMIT 500 LOOP
  considered:=considered+1;category:=NULL;
  IF j.cancel_requested THEN category:='cancellation_requested';
  ELSIF EXISTS(SELECT 1 FROM public.audit_events WHERE workspace_id=j.workspace_id AND action='ops.need_attention.retried'
    AND entity_id=j.id AND reason=marker_reason) THEN category:='already_retried_this_batch';
  ELSIF EXISTS(SELECT 1 FROM public.provider_usage u WHERE u.workspace_id=j.workspace_id AND u.job_id=j.id)
    OR EXISTS(SELECT 1 FROM public.model_attempts a WHERE a.workspace_id=j.workspace_id AND a.job_id=j.id AND a.sent)
   THEN category:='prior_send_or_usage_requires_review';
  ELSIF j.error_code='MODEL_NOT_CONFIGURED' THEN category:='fresh_assessment_recovery_required';
  ELSIF j.type IN ('source_collect','source_candidates') THEN
   SELECT * INTO src FROM public.sources WHERE workspace_id=j.workspace_id AND id=j.entity_id;
   IF src.id IS NULL OR src.approval<>'approved' OR src.kind='manual' OR src.adapter_required THEN category:='source_not_enabled_or_ready';
   ELSIF NOT coalesce(j.error_code=ANY(ARRAY['SOURCE_TEMPORARY_FAILURE','SOURCE_TIMEOUT','SOURCE_UNAVAILABLE','SOURCE_EMPTY','COLLECTION_LEASE_EXPIRED']),false)
    THEN category:='source_dependency_or_review_required'; END IF;
  ELSIF EXISTS(SELECT 1 FROM public.generation_steps s WHERE s.workspace_id=j.workspace_id AND s.job_id=j.id) THEN
   SELECT * INTO p FROM public.generation_plans WHERE workspace_id=j.workspace_id AND id=j.entity_id;
   IF p.id IS NULL OR p.status NOT IN ('queued','running','blocked')
    OR NOT EXISTS(SELECT 1 FROM public.generation_steps s WHERE s.workspace_id=j.workspace_id AND s.job_id=j.id
      AND s.plan_id=p.id AND s.status='queued' AND s.stage=p.stage)
    THEN category:='plan_or_step_not_current';
   ELSIF p.evidence_revision<>(SELECT evidence_revision FROM public.workspaces WHERE id=j.workspace_id)
     OR j.input_hash IS DISTINCT FROM p.input_hash THEN category:='stale_evidence_or_inputs';
   ELSIF EXISTS(SELECT 1 FROM public.generation_plans newer WHERE newer.workspace_id=p.workspace_id
      AND newer.opportunity_id=p.opportunity_id AND newer.kind=p.kind AND newer.status<>'canceled'
      AND (newer.created_at,newer.id)>(p.created_at,p.id)) THEN category:='superseded_plan';
   ELSIF EXISTS(SELECT 1 FROM public.provider_usage u JOIN public.jobs sibling ON sibling.id=u.job_id
      WHERE u.workspace_id=p.workspace_id AND sibling.entity_id=p.id)
     OR EXISTS(SELECT 1 FROM public.model_attempts a JOIN public.jobs sibling ON sibling.id=a.job_id
      WHERE a.workspace_id=p.workspace_id AND sibling.entity_id=p.id AND a.sent)
    THEN category:='retained_plan_send_or_usage_requires_review';
   ELSIF NOT coalesce(j.error_code=ANY(ARRAY['GENERATION_HANDLER_FAILED','TOKEN_COUNT_UNAVAILABLE']),false)
    THEN category:='model_dependency_or_review_required'; END IF;
  ELSE category:='unsupported_automatic_retry_type'; END IF;
  IF category IS NOT NULL THEN
   skipped:=jsonb_set(skipped,ARRAY[category],to_jsonb(coalesce((skipped->>category)::int,0)+1));
   CONTINUE;
  END IF;
  IF action_name='inspect' THEN
   skipped:=jsonb_set(skipped,ARRAY['eligible_technical_retry'],to_jsonb(coalesce((skipped->>'eligible_technical_retry')::int,0)+1));
   CONTINUE;
  END IF;
  BEGIN
   result:=public.app_command('job.action',jsonb_build_object('id',j.id,'expected_revision',j.revision,
      'action','retry','reason',marker_reason),'__BATCH__-attention-'||j.id::text);
   IF (result->>'id')::uuid IS DISTINCT FROM j.id OR coalesce(result->>'status','') NOT IN ('queued','running','retry_wait')
    THEN RAISE EXCEPTION 'ATTENTION_RETRY_NOT_ACCEPTED'; END IF;
   INSERT INTO public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
    VALUES(j.workspace_id,actor,'ops.need_attention.retried',j.id,marker_reason,gen_random_uuid());
   retried:=retried+1;
  EXCEPTION WHEN OTHERS THEN
   code:=CASE WHEN SQLERRM~'^[A-Z][A-Z0-9_]{1,100}$' THEN SQLERRM ELSE 'CANONICAL_COMMAND_REJECTED' END;
   skipped:=jsonb_set(skipped,ARRAY[code],to_jsonb(coalesce((skipped->>code)::int,0)+1));
  END;
 END LOOP;
 SELECT jsonb_build_object('attention_jobs',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM
   (SELECT type,status,error_code,count(*) FROM public.jobs WHERE workspace_id='__WORKSPACE__' AND status IN ('blocked','failed') GROUP BY type,status,error_code)x),
  'waiting_jobs',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM
   (SELECT type,status,error_code,count(*) FROM public.jobs WHERE workspace_id='__WORKSPACE__' AND status IN ('queued','running','retry_wait','quota_wait') GROUP BY type,status,error_code)x),
  'completed_assessments',(SELECT count(*) FROM public.generation_plans WHERE workspace_id='__WORKSPACE__' AND kind='assessment' AND status='completed')) INTO details;
 PERFORM set_config('tenderdesk.attention_recovery',(jsonb_build_object('action',action_name,'sample_completed',sample_ok,
  'considered',considered,'retried',retried,'held_by_reason',skipped)||details)::text,true);
END $attention$;
SELECT current_setting('tenderdesk.attention_recovery'); COMMIT;
"""
    return prefix+body.replace('__BATCH__',batch_id).replace('__ACTION__',action).replace('__WORKSPACE__',t.WORKSPACE)


def run(action,batch_id):
    directory=None;pod=None
    try:
        directory=t.prepare_cluster();d=t.d
        if d.get('secret','tenderdesk-migration-admin'):raise r.RecoveryError('ATTENTION_OTHER_ADMIN_IN_PROGRESS')
        credentials,ca=d.probe.target_credentials(os.environ['DIGITALOCEAN_ACCESS_TOKEN'])
        if not hmac.compare_digest(d.decode_secret(d.get('secret','tenderdesk-core')).get('PGSSLCA',''),ca):raise r.RecoveryError('ATTENTION_CA_MISMATCH')
        pod='migration-client-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']
        d.sql_pod({**credentials,'APP_DATABASE':d.DATABASE,'ROLE_PREFIX':d.PREFIX})
        print(d.sql(pod,attention_sql(action,batch_id)),flush=True)
    finally:
        if pod:t.d.cleanup_administrator(pod)
        if directory:shutil.rmtree(directory)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--action',required=True,choices=['inspect','recover']);p.add_argument('--batch-id',required=True);a=p.parse_args()
    try:
        attention_sql(a.action,a.batch_id)
        run(a.action,a.batch_id)
    except Exception as e:
        safe=str(e) if isinstance(e,(r.RecoveryError,t.d.DeployError,t.d.probe.ProbeError)) and re.fullmatch(r'[A-Z0-9_]{1,100}',str(e)) else 'ATTENTION_RECOVERY_FAILED'
        print(json.dumps({'attention_recovery':'blocked','code':safe}),flush=True);return 1
    return 0


if __name__=='__main__':sys.exit(main())
