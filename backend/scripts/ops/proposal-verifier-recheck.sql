BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='90s'; SET LOCAL lock_timeout='10s';
DO $recheck$
DECLARE selected jsonb:=__SELECTION__; actor uuid;p public.generation_plans;parent public.jobs;
 original_jobs uuid[];original_audit uuid[];before_history jsonb;history_now jsonb;before_plan jsonb;
 table_name text;predicate text;projection text;part jsonb;outcome jsonb;receipt jsonb;
 existing app_private.analysis_verifier_rechecks;stage text:='identity';
 request_key text:='proposal-verifier-recheck-__SELECTION_HASH__';
BEGIN
 BEGIN
  IF current_database()<>'tenderdesk_app' OR (SELECT count(*) FROM public.workspaces)<>1
   OR NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=(selected->>'workspace_id')::uuid)
   THEN RAISE EXCEPTION 'PROPOSAL_RECHECK_DATABASE_MISMATCH';END IF;
  PERFORM 1 FROM public.workspaces WHERE id=(selected->>'workspace_id')::uuid FOR UPDATE;
  SELECT m.user_id INTO STRICT actor FROM public.memberships m JOIN public.identity_allowlist a
   ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
   WHERE m.workspace_id=(selected->>'workspace_id')::uuid AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner';
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  IF app_private.member_role((selected->>'workspace_id')::uuid) IS DISTINCT FROM 'Owner' THEN RAISE EXCEPTION 'ROLE_FORBIDDEN';END IF;
  SELECT * INTO STRICT p FROM public.generation_plans WHERE id=(selected->>'plan_id')::uuid
   AND workspace_id=(selected->>'workspace_id')::uuid AND opportunity_id=(selected->>'opportunity_id')::uuid
   AND proposal_id=(selected->>'proposal_id')::uuid AND kind='proposal' FOR UPDATE;
  SELECT * INTO STRICT parent FROM public.jobs WHERE id=(selected#>>'{payload,id}')::uuid AND workspace_id=p.workspace_id AND entity_id=p.id FOR UPDATE;
  SELECT * INTO existing FROM app_private.analysis_verifier_rechecks WHERE parent_job_id=parent.id;
  stage:='canonical_recheck';
  IF existing.child_job_id IS NOT NULL THEN
   outcome:=app_private.recheck_analysis_verifier(selected->'payload',request_key);
   receipt:=jsonb_build_object('status','already_started','count',0,'plan_id',p.id,'parent_job_id',parent.id,'child_job_id',outcome->>'id','child_step_id',outcome->>'step_id');
  ELSE
   SELECT array_agg(id ORDER BY id) INTO original_jobs FROM public.jobs WHERE workspace_id=p.workspace_id AND entity_id=p.id;
   SELECT array_agg(id ORDER BY id) INTO original_audit FROM public.audit_events WHERE workspace_id=p.workspace_id;
   before_plan:=to_jsonb(p)-ARRAY['status','error_code','revision','updated_at','evidence_revision'];
   __HISTORY__
   before_history:=history_now;
   outcome:=app_private.recheck_analysis_verifier(selected->'payload',request_key);
   stage:='postconditions';
   IF NOT EXISTS(SELECT 1 FROM public.jobs WHERE id=parent.id AND status='canceled' AND cancel_requested AND lease_token IS NULL AND lease_until IS NULL)
    OR NOT EXISTS(SELECT 1 FROM public.generation_steps WHERE job_id=parent.id AND status='split')
    OR NOT EXISTS(SELECT 1 FROM public.jobs j JOIN public.generation_steps s ON s.job_id=j.id
     WHERE j.id=(outcome->>'id')::uuid AND j.entity_id=p.id AND j.type='analyze_chunk' AND j.status='queued'
      AND s.id=(outcome->>'step_id')::uuid AND s.plan_id=p.id AND s.status='queued' AND s.task='analyze_chunk' AND s.stage='analysis')
    OR (SELECT count(*) FROM public.jobs WHERE workspace_id=p.workspace_id AND entity_id=p.id AND NOT(id=ANY(original_jobs)))<>1
    OR (SELECT to_jsonb(g)-ARRAY['status','error_code','revision','updated_at','evidence_revision'] FROM public.generation_plans g WHERE id=p.id) IS DISTINCT FROM before_plan
    THEN RAISE EXCEPTION 'PROPOSAL_RECHECK_POSTCONDITION_FAILED';END IF;
   __HISTORY__
   IF history_now IS DISTINCT FROM before_history THEN RAISE EXCEPTION 'PROPOSAL_RECHECK_HISTORY_CHANGED';END IF;
   receipt:=jsonb_build_object('status','started','count',1,'plan_id',p.id,'parent_job_id',parent.id,'child_job_id',outcome->>'id',
    'child_step_id',outcome->>'step_id','verification_revision',4,'writer_allowance',0,'verifier_allowance',3,'verifier_correction_allowance',1,
    'retained_history_sha256',encode(sha256(convert_to(history_now::text,'UTF8')),'hex'));
   IF NOT __ACTIVATE__ THEN RAISE EXCEPTION 'PROPOSAL_RECHECK_CHECK_ROLLBACK';END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='PROPOSAL_RECHECK_CHECK_ROLLBACK' THEN
   receipt:=jsonb_build_object('status','checked','count',0,'plan_id',p.id,'parent_job_id',parent.id,'verification_revision',4,
    'writer_allowance',0,'verifier_allowance',3,'verifier_correction_allowance',1);
  ELSE
   receipt:=jsonb_build_object('status','refused','count',0,'stage',stage,'code',CASE WHEN SQLERRM ~ '^[A-Z][A-Z0-9_]{1,99}$' THEN SQLERRM ELSE 'PROPOSAL_RECHECK_GUARD_FAILED' END);
  END IF;
 END;
 PERFORM set_config('tenderdesk.verifier_recheck_receipt',receipt::text,true);
END $recheck$;
SELECT current_setting('tenderdesk.verifier_recheck_receipt');
COMMIT;
