BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';
DO $guard$ BEGIN
 IF current_database()<>'tenderdesk_app' OR (SELECT count(*) FROM public.workspaces)<>1
  OR NOT EXISTS(SELECT 1 FROM public.generation_plans p WHERE p.id='__PLAN__' AND p.workspace_id='__WORKSPACE__'
   AND p.opportunity_id='__OPPORTUNITY__' AND p.kind='proposal')
 THEN RAISE EXCEPTION 'PROPOSAL_INSPECTION_TARGET_MISMATCH';END IF;
END $guard$;
WITH target AS (
 SELECT * FROM public.generation_plans WHERE id='__PLAN__' AND workspace_id='__WORKSPACE__'
), plans AS (
 SELECT p.* FROM public.generation_plans p JOIN target t ON p.workspace_id=t.workspace_id AND p.opportunity_id=t.opportunity_id
 WHERE p.kind='proposal'
), selected_jobs AS (
 SELECT j.* FROM public.jobs j JOIN plans p ON p.workspace_id=j.workspace_id AND p.id=j.entity_id
), selected_threads AS (
 SELECT t.* FROM app_private.model_graph_threads t JOIN selected_jobs j ON j.workspace_id=t.workspace_id AND j.id=t.job_id
), source_refs AS (
 SELECT DISTINCT r.value FROM target t CROSS JOIN LATERAL jsonb_path_query(t.frozen_context,'$.**.reference') r(value)
 WHERE jsonb_typeof(r.value)='object'
), source_manifest AS (
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') value FROM source_refs
), prospective AS (
 -- Read the same current draft inputs as a new canonical request. Existing
 -- package identity is checked; no package is sealed or authorization granted.
 SELECT app_private.draft_generation_snapshot(t.workspace_id,t.opportunity_id,t.proposal_id,t.package_id) value FROM target t
), latest AS (
 SELECT * FROM plans ORDER BY created_at DESC,id DESC LIMIT 1
)
SELECT jsonb_build_object(
 'version',1,'mode','read_only_inspection','observed_at',now(),
 'selection',jsonb_build_object('workspace_id','__WORKSPACE__','opportunity_id','__OPPORTUNITY__','plan_id','__PLAN__'),
 'plan', (SELECT jsonb_build_object('id',id,'proposal_id',proposal_id,'package_id',package_id,'base_version_id',base_version_id,
   'status',status,'stage',stage,'error_code',error_code,'revision',revision,'workflow_version',workflow_version,
   'execution_policy',execution_policy,'input_hash',input_hash,'evidence_revision',evidence_revision,'created_at',created_at,'updated_at',updated_at,
   'draft_input_version',frozen_context->'draft_input_version','source_reference_count',(SELECT count(*) FROM source_refs),
   'frozen_source_manifest_sha256',encode(sha256(convert_to((SELECT value::text FROM source_manifest),'UTF8')),'hex'),
   'frozen_blocks',jsonb_array_length(coalesce(frozen_context->'blocks','[]')),
   'frozen_snapshot_sha256',encode(sha256(convert_to(frozen_context::text,'UTF8')),'hex')) FROM target),
 'opportunity',(SELECT jsonb_build_object('id',o.id,'revision',o.revision,'decision',o.decision,'archived',o.archived,'language',o.language)
   FROM public.opportunities o JOIN target t ON o.workspace_id=t.workspace_id AND o.id=t.opportunity_id),
 'proposal',(SELECT jsonb_build_object('id',p.id,'revision',p.revision,'state',p.state,'active_version_id',p.active_version_id)
   FROM public.proposals p JOIN target t ON p.workspace_id=t.workspace_id AND p.id=t.proposal_id),
 'latest_plan',(SELECT jsonb_build_object('id',id,'status',status,'stage',stage,'revision',revision,'error_code',error_code,'workflow_version',workflow_version) FROM latest),
 'prospective_draft_snapshot_sha256',(SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') FROM prospective),
 'workspace_evidence_revision',(SELECT evidence_revision FROM public.workspaces WHERE id='__WORKSPACE__'),
 'workflow_admission',(SELECT jsonb_build_object('enabled',a.enabled,'trial_opportunity_id',a.trial_opportunity_id,
   'selected_target_admitted',a.enabled AND (a.trial_opportunity_id IS NULL OR a.trial_opportunity_id='__OPPORTUNITY__'))
   FROM app_private.proposal_workflow_admission a WHERE singleton),
 'model_execution_enabled',coalesce((SELECT enabled FROM public.model_execution_settings WHERE workspace_id='__WORKSPACE__'),false),
 'restore_in_progress',EXISTS(SELECT 1 FROM public.restore_sessions WHERE workspace_id='__WORKSPACE__' AND state IN ('staging','committing')),
 'jobs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'plan_id',entity_id,'type',type,'status',status,'revision',revision,
   'error_code',error_code,'attempts',attempts,'failure_count',failure_count,'input_hash',input_hash,
   'cancel_requested',cancel_requested,'lease_active',lease_until>now(),'next_attempt_at',next_attempt_at,'updated_at',updated_at) ORDER BY entity_id,id),'[]') FROM selected_jobs),
 'steps',(SELECT coalesce(jsonb_agg(to_jsonb(safe) ORDER BY safe.plan_id,safe.ordinal),'[]') FROM (
   SELECT s.plan_id,s.job_id,s.task,s.stage,s.status,s.ordinal,s.repair_count FROM public.generation_steps s JOIN plans p ON p.id=s.plan_id AND p.workspace_id=s.workspace_id) safe),
 'threads',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'job_id',job_id,'status',status,'task',task,'result_id',result_id,
   'budget_version',budget_version,'candidate_count',candidate_count) ORDER BY job_id),'[]') FROM selected_threads),
 'budgets',(SELECT coalesce(jsonb_agg(to_jsonb(safe) ORDER BY safe.thread_id,safe.unit),'[]') FROM (
   SELECT b.thread_id,b.unit,b.candidates FROM app_private.model_graph_budgets b JOIN selected_threads t ON b.thread_id=t.id) safe),
 'phase_pins',(SELECT coalesce(jsonb_agg(jsonb_build_object('thread_id',r.thread_id,'key',r.result_key,'version',r.value->'version','content_hash',r.content_hash) ORDER BY r.thread_id,r.result_key),'[]')
   FROM app_private.model_graph_results r JOIN selected_threads t ON t.id=r.thread_id WHERE r.result_key LIKE 'semantic-instructions-%'),
 'usage',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'job_id',u.job_id,'provider',u.provider,'model',u.model,
   'state',u.state,'error_code',u.error_code,'actual_input',u.actual_input,'actual_output',u.actual_output,
   'accepted_remote',u.remote_request_id IS NOT NULL,'remote_deadline',u.remote_deadline,'created_at',u.created_at,
   'record_sha256',encode(sha256(convert_to(to_jsonb(u)::text,'UTF8')),'hex')) ORDER BY u.created_at,u.id),'[]')
   FROM public.provider_usage u JOIN selected_jobs j ON j.id=u.job_id AND j.workspace_id=u.workspace_id),
 'workspace_usage_guards',(SELECT jsonb_build_object('reserved',count(*) FILTER(WHERE state='reserved'),
   'unknown',count(*) FILTER(WHERE state='unknown'),
   'unknown_recent_or_remote_active',count(*) FILTER(WHERE state='unknown' AND (created_at>now()-interval '15 minutes' OR remote_deadline>now())))
   FROM public.provider_usage WHERE workspace_id='__WORKSPACE__'),
 'documents',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'revision',d.revision,'kind',d.kind,'status',d.status,
   'archived',d.archived,'original_hash',d.original_hash,'extraction_hash',d.extraction_hash,
   'extracted_characters',length(d.extracted_text)) ORDER BY d.id),'[]')
   FROM public.documents d JOIN target t ON t.workspace_id=d.workspace_id AND t.opportunity_id=d.opportunity_id WHERE d.kind='rfp'),
 'versions',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'plan_id',v.plan_id,'revision',v.revision) ORDER BY v.created_at,v.id),'[]')
   FROM public.proposal_versions v JOIN target t ON v.workspace_id=t.workspace_id AND v.proposal_id=t.proposal_id)
); COMMIT;
