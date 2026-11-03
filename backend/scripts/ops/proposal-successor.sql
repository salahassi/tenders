BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='90s'; SET LOCAL lock_timeout='10s';
DO $successor$
DECLARE selected jsonb:=__SELECTION__; actor uuid; p public.generation_plans; successor public.generation_plans;
 o public.opportunities; proposal public.proposals; marker public.audit_events;
 before_plan jsonb; before_jobs jsonb; before_history jsonb; history_now jsonb; current_documents jsonb;
 current_jobs jsonb; current_usage jsonb; current_admission jsonb; original_refs jsonb; successor_refs jsonb;
 prospective_context jsonb; current_evidence_revision bigint;
 relation_name text; predicate text; relation_state jsonb; command_result jsonb; receipt jsonb;
 stage text:='identity'; reason text:='Owner requested a new attempt after deployed AI reliability corrections; predecessor='||(__SELECTION__->>'plan_id');
 selection_hash text:='__SELECTION_HASH__'; prefix text:='proposal-ai-recovery-__SELECTION_HASH__';
BEGIN
 BEGIN
  IF current_database()<>'tenderdesk_app' OR (SELECT count(*) FROM public.workspaces)<>1
   OR NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=(selected->>'workspace_id')::uuid)
  THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_DATABASE_MISMATCH';END IF;
  PERFORM 1 FROM public.workspaces WHERE id=(selected->>'workspace_id')::uuid FOR UPDATE;
  SELECT m.user_id INTO STRICT actor FROM public.memberships m JOIN public.identity_allowlist a
   ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
   WHERE m.workspace_id=(selected->>'workspace_id')::uuid AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner';
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  IF app_private.member_role((selected->>'workspace_id')::uuid) IS DISTINCT FROM 'Owner'
   THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_OWNER_REQUIRED';END IF;
  IF NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='ai-execution-reliability-v1')
   OR position('then raise exception ''USAGE_REVIEW_REQUIRED'';end if;' IN pg_get_functiondef('app_private.writer_validation_handoff(uuid,uuid,text,jsonb)'::regprocedure))=0
   OR position('PROVIDER_BACKGROUND_TERMINATED' IN pg_get_functiondef('public.resume_task_model_request_phase(uuid,uuid,text,jsonb,uuid,uuid,text)'::regprocedure))=0
   THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_RELEASE_REQUIRED';END IF;
  SELECT * INTO STRICT p FROM public.generation_plans WHERE id=(selected->>'plan_id')::uuid AND workspace_id=(selected->>'workspace_id')::uuid
   AND opportunity_id=(selected->>'opportunity_id')::uuid AND proposal_id=(selected->>'proposal_id')::uuid AND kind='proposal' FOR UPDATE;
  -- This retained audit marker distinguishes a committed restart from a failed
  -- transport receipt. Replay never cancels or submits another successor.
  SELECT * INTO marker FROM public.audit_events WHERE workspace_id=p.workspace_id AND actor_id=actor
   AND action='ops.proposal.recovery.successor' AND details->>'selection_sha256'=selection_hash
   AND details->>'predecessor_plan_id'=p.id::text ORDER BY created_at,id LIMIT 1;
  IF marker.id IS NOT NULL THEN
   SELECT * INTO STRICT successor FROM public.generation_plans WHERE id=marker.entity_id AND workspace_id=p.workspace_id
    AND opportunity_id=p.opportunity_id AND proposal_id=p.proposal_id AND kind='proposal';
   IF p.status<>'canceled' THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_REPLAY_MISMATCH';END IF;
   receipt:=jsonb_build_object('status','already_started','count',0,'plan_id',successor.id,'proposal_id',successor.proposal_id,
    'predecessor_plan_id',p.id,'successor_status',successor.status,'successor_stage',successor.stage);
  ELSE
   stage:='current_target';
   IF p.revision<>(selected->>'expected_plan_revision')::integer OR p.status<>'blocked' OR p.stage<>'analysis'
    OR NOT coalesce(p.error_code IN ('MODEL_CORRECTION_EXHAUSTED','MODEL_GENERATION_ATTEMPTS_EXHAUSTED','MODEL_OPERATION_BUDGET_EXHAUSTED','MODEL_IDENTITY_CHANGED'),false)
    OR p.input_hash IS DISTINCT FROM selected->>'expected_input_hash'
    OR encode(sha256(convert_to(p.frozen_context::text,'UTF8')),'hex') IS DISTINCT FROM selected->>'expected_frozen_snapshot_sha256'
    THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_PLAN_CHANGED';END IF;
   IF p.id IS DISTINCT FROM (SELECT id FROM public.generation_plans WHERE workspace_id=p.workspace_id AND opportunity_id=p.opportunity_id
     AND kind='proposal' ORDER BY created_at DESC,id DESC LIMIT 1)
    THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_PLAN_NOT_CURRENT';END IF;
   SELECT * INTO STRICT o FROM public.opportunities WHERE id=p.opportunity_id AND workspace_id=p.workspace_id FOR UPDATE;
   SELECT * INTO STRICT proposal FROM public.proposals WHERE id=p.proposal_id AND workspace_id=p.workspace_id AND opportunity_id=p.opportunity_id FOR UPDATE;
   IF o.revision<>(selected->>'expected_opportunity_revision')::integer OR o.archived OR o.decision<>'shortlisted'
    OR proposal.revision<>(selected->>'expected_proposal_revision')::integer OR proposal.active_version_id IS NOT NULL
    OR p.base_version_id IS NOT NULL THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_BUSINESS_STATE_CHANGED';END IF;
   IF p.frozen_context->>'language' IS DISTINCT FROM o.language
    THEN RAISE EXCEPTION 'PROPOSAL_REQUEST_OPTIONS_CHANGED';END IF;
   SELECT evidence_revision INTO current_evidence_revision FROM public.workspaces WHERE id=p.workspace_id;
   IF EXISTS(SELECT 1 FROM public.restore_sessions WHERE workspace_id=p.workspace_id AND state IN ('staging','committing'))
    OR NOT EXISTS(SELECT 1 FROM public.model_execution_settings WHERE workspace_id=p.workspace_id AND enabled)
    THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_EXECUTION_UNAVAILABLE';END IF;
   SELECT jsonb_build_object('enabled',a.enabled,'trial_opportunity_id',a.trial_opportunity_id,
     'selected_target_admitted',a.enabled AND (a.trial_opportunity_id IS NULL OR a.trial_opportunity_id=p.opportunity_id))
    INTO current_admission FROM app_private.proposal_workflow_admission a WHERE singleton;
   IF coalesce(current_admission,'null'::jsonb) IS DISTINCT FROM selected->'expected_admission'
    THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_ADMISSION_CHANGED';END IF;
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'revision',d.revision,'kind',d.kind,'status',d.status,'archived',d.archived,
     'original_hash',d.original_hash,'extraction_hash',d.extraction_hash,'extracted_characters',length(d.extracted_text)) ORDER BY d.id),'[]')
    INTO current_documents FROM public.documents d WHERE d.workspace_id=p.workspace_id AND d.opportunity_id=p.opportunity_id AND d.kind='rfp';
   IF current_documents IS DISTINCT FROM selected->'expected_documents' THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_DOCUMENTS_CHANGED';END IF;
   -- The global counter includes unrelated opportunities. Bind every actual
   -- prospective draft input instead, including company sources, template,
   -- rates, reviews, language and intake metadata. Keep the full raw snapshot;
   -- no field is omitted and no old plan is refreshed or rewritten.
   IF p.package_id IS NULL THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_PACKAGE_REQUIRED';END IF;
   prospective_context:=app_private.draft_generation_snapshot(p.workspace_id,p.opportunity_id,p.proposal_id,p.package_id);
   IF encode(sha256(convert_to(prospective_context::text,'UTF8')),'hex') IS DISTINCT FROM selected->>'expected_prospective_snapshot_sha256'
    THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_RELEVANT_EVIDENCE_CHANGED';END IF;
   stage:='job_and_usage_guards';
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',j.id,'revision',j.revision) ORDER BY j.id),'[]') INTO current_jobs
    FROM public.jobs j WHERE j.workspace_id=p.workspace_id AND j.entity_id=p.id;
   IF current_jobs IS DISTINCT FROM selected->'expected_jobs' OR EXISTS(SELECT 1 FROM public.jobs j WHERE j.workspace_id=p.workspace_id AND j.entity_id=p.id
     AND (j.status NOT IN ('blocked','failed') OR j.cancel_requested OR j.lease_token IS NOT NULL OR j.lease_until IS NOT NULL OR j.input_hash IS DISTINCT FROM p.input_hash))
    OR NOT EXISTS(SELECT 1 FROM public.generation_steps WHERE workspace_id=p.workspace_id AND plan_id=p.id)
    OR EXISTS(SELECT 1 FROM public.generation_steps s WHERE s.workspace_id=p.workspace_id AND s.plan_id=p.id AND (s.status<>'queued' OR s.stage<>'analysis' OR s.task<>'analyze_chunk'))
    THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_JOB_STATE_CHANGED';END IF;
   -- Only a final graph acceptance could represent reusable finished work.
   -- Successful paid writers/verifiers and retained intermediate candidates
   -- remain eligible and are preserved by the immutable-history fingerprint.
   IF EXISTS(SELECT 1 FROM app_private.model_graph_threads t JOIN public.jobs j ON j.id=t.job_id AND j.workspace_id=t.workspace_id
    WHERE j.entity_id=p.id AND j.workspace_id=p.workspace_id AND (t.status IN ('accepted','committed') OR t.result_id IS NOT NULL))
    THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_COMPLETED_WORK_AVAILABLE';END IF;
   SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'record_sha256',encode(sha256(convert_to(to_jsonb(u)::text,'UTF8')),'hex')) ORDER BY u.id),'[]')
    INTO current_usage FROM public.provider_usage u JOIN public.jobs j ON j.id=u.job_id AND j.workspace_id=u.workspace_id
    WHERE j.workspace_id=p.workspace_id AND j.entity_id=p.id;
   IF current_usage IS DISTINCT FROM selected->'expected_usage' THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_USAGE_CHANGED';END IF;
   -- Expired historical unknown usage stays unknown. Mirror the canonical
   -- reservation freshness boundary without blocking unrelated old accounting.
   IF EXISTS(SELECT 1 FROM public.provider_usage u JOIN public.jobs j ON j.id=u.job_id AND j.workspace_id=u.workspace_id
    WHERE j.workspace_id=p.workspace_id AND j.entity_id=p.id AND (u.state='reserved' OR (u.state='unknown' AND
      (u.created_at>now()-interval '15 minutes' OR u.remote_deadline>now() OR (u.remote_request_id IS NOT NULL AND u.remote_deadline IS NULL)))))
    THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_PENDING_USAGE';END IF;
   before_plan:=to_jsonb(p)-ARRAY['status','revision','updated_at'];
   SELECT coalesce(jsonb_agg(to_jsonb(j)-ARRAY['status','cancel_requested','revision','updated_at'] ORDER BY j.id),'[]') INTO before_jobs
    FROM public.jobs j WHERE j.workspace_id=p.workspace_id AND j.entity_id=p.id;
   __HISTORY_SNAPSHOT__
   before_history:=history_now;
   SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO original_refs FROM (
    SELECT DISTINCT value FROM jsonb_path_query(p.frozen_context,'$.blocks[*].reference') r(value) WHERE value->>'entity_kind'='document') refs;
   IF original_refs='[]'::jsonb THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_ORIGINAL_DOCUMENTS_REQUIRED';END IF;
   stage:='canonical_cancel_and_generate';
   command_result:=app_private.app_command('generation.cancel',jsonb_build_object('id',p.id,'expected_revision',p.revision,'reason',reason),prefix||'-cancel');
   IF command_result->>'id' IS DISTINCT FROM p.id::text OR command_result->>'status' IS DISTINCT FROM 'canceled'
    THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_CANCEL_NOT_CONFIRMED';END IF;
   command_result:=app_private.app_command('proposal.generate',jsonb_build_object('id',o.id,'expected_revision',o.revision),prefix||'-generate');
   SELECT * INTO STRICT successor FROM public.generation_plans WHERE id=(command_result->>'id')::uuid AND workspace_id=p.workspace_id
    AND opportunity_id=p.opportunity_id AND proposal_id=p.proposal_id AND kind='proposal';
   stage:='postconditions';
   IF successor.id=p.id OR successor.status<>'queued' OR successor.stage<>'analysis'
    OR successor.workflow_version<>(selected->>'expected_workflow_version')::integer OR successor.base_version_id IS NOT NULL
    OR successor.frozen_context->>'language' IS DISTINCT FROM p.frozen_context->>'language'
    OR successor.frozen_context->'draft_input_version' IS DISTINCT FROM '1'::jsonb
    THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_RESULT_INVALID';END IF;
   IF encode(sha256(convert_to(successor.frozen_context::text,'UTF8')),'hex') IS DISTINCT FROM selected->>'expected_prospective_snapshot_sha256'
    OR successor.evidence_revision IS DISTINCT FROM current_evidence_revision
    THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_SNAPSHOT_CHANGED';END IF;
   SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO successor_refs FROM (
    SELECT DISTINCT value FROM jsonb_path_query(successor.frozen_context,'$.blocks[*].reference') r(value) WHERE value->>'entity_kind'='document') refs;
   IF successor_refs IS DISTINCT FROM original_refs THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_SELECTED_SOURCES_CHANGED';END IF;
   IF NOT EXISTS(SELECT 1 FROM app_private.generation_processing_requests WHERE workspace_id=p.workspace_id AND plan_id=successor.id
     AND requested_by=actor AND operation='proposal.generate' AND idempotency_key=prefix||'-generate')
    OR NOT EXISTS(SELECT 1 FROM public.generation_steps WHERE workspace_id=p.workspace_id AND plan_id=successor.id AND status='queued' AND task='analyze_chunk')
    OR EXISTS(SELECT 1 FROM public.provider_usage u JOIN public.jobs j ON j.id=u.job_id WHERE j.entity_id=successor.id)
    THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_REQUEST_NOT_CONFIRMED';END IF;
   IF before_plan IS DISTINCT FROM (SELECT to_jsonb(old)-ARRAY['status','revision','updated_at'] FROM public.generation_plans old WHERE old.id=p.id)
    OR NOT EXISTS(SELECT 1 FROM public.generation_plans old WHERE old.id=p.id AND old.status='canceled' AND old.revision=p.revision+1)
    OR before_jobs IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(j)-ARRAY['status','cancel_requested','revision','updated_at'] ORDER BY j.id),'[]') FROM public.jobs j WHERE j.workspace_id=p.workspace_id AND j.entity_id=p.id)
    THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_ORIGINAL_INPUTS_CHANGED';END IF;
   __HISTORY_SNAPSHOT__
   IF before_history IS DISTINCT FROM history_now THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_HISTORY_CHANGED';END IF;
   INSERT INTO public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,reason,details)
    VALUES(p.workspace_id,actor,'ops.proposal.recovery.successor','generation_plan',successor.id,reason,
     jsonb_build_object('selection_sha256',selection_hash,'predecessor_plan_id',p.id,'retained_history_sha256',encode(sha256(convert_to(history_now::text,'UTF8')),'hex'),
      'unknown_usage_preserved',true,'old_budgets_preserved',true,'prospective_snapshot_sha256',selected->>'expected_prospective_snapshot_sha256',
      'inspected_workspace_evidence_revision',selected->'expected_workspace_evidence_revision','current_workspace_evidence_revision',current_evidence_revision,'runtime_image',selected->>'expected_runtime_image'));
   receipt:=jsonb_build_object('status','started','count',1,'plan_id',successor.id,'proposal_id',successor.proposal_id,'predecessor_plan_id',p.id,
    'workflow_version',successor.workflow_version,'inspected_workspace_evidence_revision',selected->'expected_workspace_evidence_revision',
    'current_workspace_evidence_revision',current_evidence_revision,'prospective_snapshot_preserved',true,'language',successor.frozen_context->>'language','frozen_blocks',jsonb_array_length(successor.frozen_context->'blocks'),
    'original_selected_document_references_preserved',true,'immutable_history_preserved',true,'unknown_usage_preserved',true,
    'retained_history_sha256',encode(sha256(convert_to(history_now::text,'UTF8')),'hex'));
   IF NOT __RESTART__ THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_CHECK_ROLLBACK';END IF;
  END IF;
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM='PROPOSAL_SUCCESSOR_CHECK_ROLLBACK' THEN
   receipt:=jsonb_build_object('status','checked','count',0,'would_start_successor',true,'canonical_mutations_rolled_back',true,
    'predecessor_plan_id',selected->>'plan_id','workflow_version',selected->'expected_workflow_version');
  ELSE
   receipt:=jsonb_build_object('status','refused','count',0,'stage',stage,'sqlstate',SQLSTATE,
    'code',CASE WHEN SQLERRM ~ '^[A-Z][A-Z0-9_]{1,100}$' THEN SQLERRM ELSE 'PROPOSAL_SUCCESSOR_CANONICAL_COMMAND_FAILED' END);
  END IF;
 END;
 PERFORM set_config('tenderdesk.proposal_successor_receipt',(receipt||jsonb_build_object('observed_at',now()))::text,true);
END $successor$;
SELECT current_setting('tenderdesk.proposal_successor_receipt'); COMMIT;
