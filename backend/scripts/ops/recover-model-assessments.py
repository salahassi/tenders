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

SCOPE_GUARD_FIX='scope-keyword-evidence-v1'


def recovery_sql(action: str, batch_id: str, ready_aliases=(), enable_task_routing=False, guard_fix=None):
    if action not in {'sample','remaining','status','retry-sample','revalidate-sample'} or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}',batch_id):
        raise RecoveryError('ASSESSMENT_ACTION_INVALID')
    if enable_task_routing and action!='sample':raise RecoveryError('ASSESSMENT_ENABLE_SAMPLE_ONLY')
    if (action=='revalidate-sample' and guard_fix!=SCOPE_GUARD_FIX) or (guard_fix and action!='revalidate-sample'):
        raise RecoveryError('ASSESSMENT_GUARD_FIX_REQUIRED')
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
 sample_revalidated boolean:=false; sample_revalidation_already_requested boolean:=false;
 graph record; retained record; writer record; candidate jsonb; scope_policy jsonb;
 graph_before jsonb; graph_after jsonb; job_before jsonb; revalidation_reason text;
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
  IF action_name IN ('retry-sample','revalidate-sample') AND (NOT has_sample OR NOT sample_current OR waiting_successor)
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
  IF action_name='revalidate-sample' THEN
   revalidation_reason:=marker_reason||'; guard=scope-keyword-evidence-v1';
   SELECT EXISTS(SELECT 1 FROM public.audit_events a JOIN public.jobs j ON j.id=a.entity_id
    WHERE a.workspace_id=sample.workspace_id AND a.actor_id=actor AND a.action='ops.model_assessment.sample.revalidated'
     AND a.reason=revalidation_reason AND j.workspace_id=sample.workspace_id AND j.entity_id=sample.id)
    INTO sample_revalidation_already_requested;
   IF NOT sample_revalidation_already_requested THEN
    IF sample.status<>'blocked' OR sample.error_code IS DISTINCT FROM 'MODEL_CORRECTION_EXHAUSTED'
     THEN RAISE EXCEPTION 'ASSESSMENT_REVALIDATION_UNSAFE_STATE'; END IF;
    SELECT j.* INTO STRICT retry_job FROM public.jobs j JOIN public.generation_steps s
     ON s.job_id=j.id AND s.workspace_id=j.workspace_id AND s.plan_id=j.entity_id
     WHERE j.workspace_id=sample.workspace_id AND j.entity_id=sample.id AND s.status='queued' AND s.stage=sample.stage
      AND j.status IN ('blocked','failed') AND j.error_code='MODEL_CORRECTION_EXHAUSTED'
      AND NOT j.cancel_requested AND j.input_hash=sample.input_hash;
    IF EXISTS(SELECT 1 FROM public.provider_usage u JOIN public.jobs j ON j.id=u.job_id
      WHERE j.workspace_id=sample.workspace_id AND j.entity_id=sample.id AND u.state IS DISTINCT FROM 'settled')
     THEN RAISE EXCEPTION 'ASSESSMENT_REVALIDATION_USAGE_REVIEW_REQUIRED'; END IF;
    SELECT t.* INTO STRICT graph FROM app_private.model_graph_threads t
     WHERE t.workspace_id=sample.workspace_id AND t.job_id=retry_job.id AND t.task='classify_opportunity'
     ORDER BY t.created_at DESC,t.id DESC LIMIT 1;
    IF graph.status<>'needs_review' OR graph.candidate_count<>3
     THEN RAISE EXCEPTION 'ASSESSMENT_REVALIDATION_GRAPH_NOT_RETAINED'; END IF;
    SELECT gr.* INTO STRICT retained FROM app_private.model_graph_results gr
     WHERE gr.thread_id=graph.id AND gr.result_key='candidate-2';
    IF EXISTS(SELECT 1 FROM app_private.model_graph_results gr WHERE gr.thread_id=graph.id
      AND gr.result_key~'^candidate-[0-9]+$' AND substring(gr.result_key from 11)::int>2)
     OR retained.value#>>'{local_validation,version}' IS DISTINCT FROM '1'
     OR retained.value#>>'{local_validation,task}' IS DISTINCT FROM 'repair_result'
     OR retained.value#>>'{local_validation,code}' IS DISTINCT FROM 'EVIDENCE_REFERENCE_INVALID'
     OR retained.value#>>'{result,target_task}' IS DISTINCT FROM 'classify_opportunity'
     OR NOT EXISTS(SELECT 1 FROM app_private.model_graph_results pin WHERE pin.thread_id=graph.id
      AND pin.result_key='semantic-instructions-'||encode(sha256(convert_to(retained.value#>>'{local_validation,request_prefix}','UTF8')),'hex')
      AND pin.value->'version'='3'::jsonb)
     THEN RAISE EXCEPTION 'ASSESSMENT_REVALIDATION_IDENTITY_MISMATCH'; END IF;
    IF jsonb_typeof(retained.value#>'{local_validation,diagnostics}') IS DISTINCT FROM 'array'
     OR jsonb_array_length(retained.value#>'{local_validation,diagnostics}')<>1
     OR retained.value#>>'{local_validation,diagnostics,0,code}' IS DISTINCT FROM 'EVIDENCE_REFERENCE_INVALID'
     OR retained.value#>>'{local_validation,diagnostics,0,reason}' IS DISTINCT FROM 'source_missing'
     OR (SELECT jsonb_agg(p ORDER BY p) FROM jsonb_array_elements_text(retained.value#>'{local_validation,diagnostics,0,paths}') p)
      IS DISTINCT FROM '["$.factors.scope.company_evidence","$.factors.scope.notice_evidence"]'::jsonb
     THEN RAISE EXCEPTION 'ASSESSMENT_REVALIDATION_DIAGNOSTICS_MISMATCH'; END IF;
    -- Require all three received writer receipts to remain present and settled.
    FOR writer IN SELECT n,gr.value FROM generate_series(0,2) n LEFT JOIN app_private.model_graph_results gr
      ON gr.thread_id=graph.id AND gr.result_key='candidate-'||n::text LOOP
     IF writer.value IS NULL OR NOT EXISTS(SELECT 1 FROM public.provider_usage u
       WHERE u.id=(writer.value#>>'{local_validation,usage_id}')::uuid AND u.job_id=retry_job.id
        AND u.state='settled' AND u.graph_candidate_recorded)
      THEN RAISE EXCEPTION 'ASSESSMENT_REVALIDATION_WRITER_RECEIPT_MISSING'; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT gr.value#>>'{local_validation,usage_id}') FROM app_private.model_graph_results gr
      WHERE gr.thread_id=graph.id AND gr.result_key IN ('candidate-0','candidate-1','candidate-2'))<>3
     THEN RAISE EXCEPTION 'ASSESSMENT_REVALIDATION_WRITER_RECEIPT_MISSING'; END IF;
    scope_policy:=sample.frozen_context->'discovery_scope_policy';candidate:=retained.value#>'{result,result}';
    IF coalesce(scope_policy->>'scope','') NOT IN ('keywords','combined')
     OR jsonb_typeof(scope_policy->'include_keywords') IS DISTINCT FROM 'array'
     OR jsonb_typeof(scope_policy->'exclude_keywords') IS DISTINCT FROM 'array'
     OR sample.frozen_context#>>'{notice,kind}' IS DISTINCT FROM 'notice'
     OR length(coalesce(sample.frozen_context#>>'{notice,id}',''))=0
     OR length(coalesce(sample.frozen_context#>>'{notice,text}',''))=0
     OR jsonb_typeof(candidate#>'{factors,scope,rating}') IS DISTINCT FROM 'number'
     OR (candidate#>>'{factors,scope,rating}')::numeric NOT BETWEEN 0 AND 4
     OR jsonb_typeof(candidate#>'{factors,scope,company_evidence}') IS DISTINCT FROM 'array'
     OR jsonb_array_length(candidate#>'{factors,scope,company_evidence}')<>0
     OR coalesce(candidate#>>'{scope_decision,status}','') NOT IN ('in_scope','out_of_scope')
     OR jsonb_typeof(candidate#>'{scope_decision,keyword_evidence}') IS DISTINCT FROM 'array'
     OR jsonb_array_length(candidate#>'{scope_decision,keyword_evidence}')=0
     THEN RAISE EXCEPTION 'ASSESSMENT_REVALIDATION_SCOPE_POLICY_MISMATCH'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements((scope_policy->'include_keywords')||(scope_policy->'exclude_keywords')) term
      WHERE jsonb_typeof(term)<>'string' OR length(trim(term#>>'{}'))=0)
     THEN RAISE EXCEPTION 'ASSESSMENT_REVALIDATION_SCOPE_POLICY_MISMATCH'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(candidate#>'{scope_decision,keyword_evidence}') k
      WHERE coalesce(k->>'kind','') NOT IN ('include','exclude') OR NOT EXISTS(
       SELECT 1 FROM jsonb_array_elements_text(scope_policy->CASE WHEN k->>'kind'='include' THEN 'include_keywords' ELSE 'exclude_keywords' END) term
        WHERE term=k->>'keyword'))
     THEN RAISE EXCEPTION 'ASSESSMENT_REVALIDATION_KEYWORD_NOT_CONFIGURED'; END IF;
    -- This is a narrow structural eligibility guard. The deployed runtime must
    -- still revalidate exact normalized quotations and all factors, then perform
    -- independent verification. SQL never treats this candidate as accepted.
    FOR writer IN SELECT evidence FROM (VALUES(candidate#>'{factors,scope,notice_evidence}'),
      (candidate#>'{scope_decision,notice_evidence}')) arrays(evidence) LOOP
     IF jsonb_typeof(writer.evidence) IS DISTINCT FROM 'array' OR jsonb_array_length(writer.evidence)=0
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(writer.evidence) ref WHERE ref->>'id' IS DISTINCT FROM sample.frozen_context#>>'{notice,id}'
       OR length(trim(coalesce(ref->>'quote','')))=0)
      THEN RAISE EXCEPTION 'ASSESSMENT_REVALIDATION_NOTICE_EVIDENCE_MISSING'; END IF;
    END LOOP;
    SELECT jsonb_build_object(
     'thread',to_jsonb(t),
     'results',(SELECT jsonb_agg(to_jsonb(gr) ORDER BY gr.id) FROM app_private.model_graph_results gr WHERE gr.thread_id=t.id),
     'budgets',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.unit) FROM app_private.model_graph_budgets b WHERE b.thread_id=t.id),
     'checkpoints',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.namespace,c.checkpoint_id) FROM app_private.model_graph_checkpoints c WHERE c.thread_id=t.id),
     'writes',(SELECT jsonb_agg(to_jsonb(w) ORDER BY w.namespace,w.checkpoint_id,w.task_id,w.idx) FROM app_private.model_graph_writes w WHERE w.thread_id=t.id),
     'usage',(SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM public.provider_usage u WHERE u.job_id=retry_job.id),
     'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.model_attempts a WHERE a.job_id=retry_job.id))
     INTO graph_before FROM app_private.model_graph_threads t WHERE t.id=graph.id;
    job_before:=to_jsonb(retry_job);
    result:=public.app_command('job.action',jsonb_build_object('id',retry_job.id,'expected_revision',retry_job.revision,
      'action','retry','reason',revalidation_reason),'__BATCH__-scope-revalidate-'||retry_job.id::text);
    IF result->>'id' IS DISTINCT FROM retry_job.id::text OR coalesce(result->>'status','') NOT IN ('queued','running','retry_wait')
     THEN RAISE EXCEPTION 'ASSESSMENT_REVALIDATION_RETRY_NOT_ACCEPTED'; END IF;
    SELECT jsonb_build_object(
     'thread',to_jsonb(t),
     'results',(SELECT jsonb_agg(to_jsonb(gr) ORDER BY gr.id) FROM app_private.model_graph_results gr WHERE gr.thread_id=t.id),
     'budgets',(SELECT jsonb_agg(to_jsonb(b) ORDER BY b.unit) FROM app_private.model_graph_budgets b WHERE b.thread_id=t.id),
     'checkpoints',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.namespace,c.checkpoint_id) FROM app_private.model_graph_checkpoints c WHERE c.thread_id=t.id),
     'writes',(SELECT jsonb_agg(to_jsonb(w) ORDER BY w.namespace,w.checkpoint_id,w.task_id,w.idx) FROM app_private.model_graph_writes w WHERE w.thread_id=t.id),
     'usage',(SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM public.provider_usage u WHERE u.job_id=retry_job.id),
     'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.model_attempts a WHERE a.job_id=retry_job.id))
     INTO graph_after FROM app_private.model_graph_threads t WHERE t.id=graph.id;
    SELECT * INTO STRICT retry_job FROM public.jobs WHERE id=retry_job.id;
    IF graph_after IS DISTINCT FROM graph_before OR to_jsonb(retry_job)->'attempts' IS DISTINCT FROM job_before->'attempts'
      OR to_jsonb(retry_job)->'checkpoint' IS DISTINCT FROM job_before->'checkpoint'
     THEN RAISE EXCEPTION 'ASSESSMENT_REVALIDATION_RETAINED_STATE_CHANGED'; END IF;
    INSERT INTO public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
     VALUES(sample.workspace_id,actor,'ops.model_assessment.sample.revalidated',retry_job.id,revalidation_reason,gen_random_uuid());
    SELECT * INTO STRICT sample FROM public.generation_plans WHERE id=sample.id AND workspace_id=sample.workspace_id;
    sample_revalidated:=true;
   END IF;
  END IF;
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
  'sample_revalidated',sample_revalidated,'sample_revalidation_already_requested',sample_revalidation_already_requested,
  'sample_revalidation_guard',CASE WHEN action_name='revalidate-sample' THEN 'scope-keyword-evidence-v1' END,
  'retained_state_preserved_before_release',CASE WHEN sample_revalidated THEN true END,
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


def verify_guard_runtime(expected_image):
    if not isinstance(expected_image,str) or not re.fullmatch(r'registry\.digitalocean\.com/tenderdesk-a6093a76/runtime@sha256:[a-f0-9]{64}',expected_image):
        raise RecoveryError('ASSESSMENT_GUARD_RUNTIME_IMAGE_REQUIRED')
    for name in ('api','worker'):
        value=t.d.get('deployment',name) or {};meta=value.get('metadata',{});spec=value.get('spec',{});status=value.get('status',{})
        containers=spec.get('template',{}).get('spec',{}).get('containers',[])
        if (meta.get('name')!=name or meta.get('namespace')!=t.d.NAMESPACE
          or meta.get('labels',{}).get('app.kubernetes.io/managed-by')!='tenderdesk-deployment'
          or len(containers)!=1 or containers[0].get('name')!=name or containers[0].get('image')!=expected_image
          or spec.get('replicas')!=1 or status.get('observedGeneration',-1)<meta.get('generation',0)
          or status.get('readyReplicas')!=1 or status.get('updatedReplicas')!=1 or status.get('unavailableReplicas',0)!=0):
            raise RecoveryError('ASSESSMENT_GUARD_RUNTIME_NOT_VERIFIED')


def run(action,batch_id,enable_task_routing=False,wait_seconds=0,guard_fix=None,expected_runtime_image=None):
    directory=None;pod=None
    try:
        directory=t.prepare_cluster();d=t.d
        if action=='revalidate-sample':verify_guard_runtime(expected_runtime_image)
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
            receipt=json.loads(d.sql(pod,recovery_sql(action,batch_id,aliases,enable_task_routing,guard_fix)))
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
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--action',required=True,choices=['sample','remaining','status','retry-sample','revalidate-sample']);p.add_argument('--batch-id',required=True);p.add_argument('--enable-task-routing',action='store_true');p.add_argument('--wait-seconds',type=int,default=0);p.add_argument('--guard-fix');p.add_argument('--expected-runtime-image');a=p.parse_args()
    try:
        recovery_sql(a.action,a.batch_id,(),a.enable_task_routing,a.guard_fix)
        if a.action=='revalidate-sample' and (not a.expected_runtime_image or not re.fullmatch(r'registry\.digitalocean\.com/tenderdesk-a6093a76/runtime@sha256:[a-f0-9]{64}',a.expected_runtime_image)):
            raise RecoveryError('ASSESSMENT_GUARD_RUNTIME_IMAGE_REQUIRED')
        if a.expected_runtime_image and a.action!='revalidate-sample':raise RecoveryError('ASSESSMENT_GUARD_RUNTIME_ACTION_INVALID')
        if a.wait_seconds and (a.action!='status' or not 1<=a.wait_seconds<=900):raise RecoveryError('ASSESSMENT_WAIT_INVALID')
        return run(a.action,a.batch_id,a.enable_task_routing,a.wait_seconds,a.guard_fix,a.expected_runtime_image)
    except Exception as e:
        safe=str(e) if isinstance(e,(RecoveryError,t.d.DeployError,t.d.probe.ProbeError)) and re.fullmatch(r'[A-Z0-9_]{1,100}',str(e)) else 'ASSESSMENT_RECOVERY_FAILED'
        print(json.dumps({'assessment_recovery':'blocked','code':safe}),flush=True);return 1
    return 0


if __name__=='__main__':sys.exit(main())
