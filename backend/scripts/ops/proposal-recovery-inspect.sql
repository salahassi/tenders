BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';
DO $guard$ BEGIN
 IF current_database()<>'tenderdesk_app' OR (SELECT count(*) FROM public.workspaces)<>1
  OR NOT EXISTS(SELECT 1 FROM public.generation_plans p WHERE p.id='__PLAN__' AND p.workspace_id='__WORKSPACE__'
   AND p.opportunity_id='__OPPORTUNITY__' AND p.kind='proposal')
 THEN RAISE EXCEPTION 'PROPOSAL_INSPECTION_TARGET_MISMATCH';END IF;
END $guard$;
-- The Kubernetes outbox is an optional runtime installation, not part of the
-- portable schema. Read only its scheduling fields; never expose its lease
-- credential or dispatcher secret/configuration. No scheduler RPC is called.
DO $dispatch_metadata$ DECLARE metadata jsonb; BEGIN
 IF to_regclass('app_private.k8s_dispatch_queue') IS NOT NULL THEN
  EXECUTE $query$ SELECT jsonb_build_object('available',true,'state',(
   SELECT jsonb_build_object('generation',generation,'acknowledged_generation',acknowledged_generation,
    'pending_generations',generation-acknowledged_generation,'lease_generation',lease_generation,
    'lease_present',lease_token IS NOT NULL,'lease_until',lease_until,'lease_active',coalesce(lease_until>now(),false),
    'next_attempt_at',next_attempt_at,'last_periodic_at',last_periodic_at,'failures',failures)
   FROM app_private.k8s_dispatch_queue WHERE singleton)) $query$ INTO metadata;
 ELSE metadata:=jsonb_build_object('available',false,'state',null);END IF;
 PERFORM set_config('tenderdesk.inspection_dispatch_metadata',metadata::text,true);
END $dispatch_metadata$;
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
), timeline_jobs AS (
 SELECT j.* FROM public.jobs j JOIN target p ON p.workspace_id=j.workspace_id AND p.id=j.entity_id
), selected_attempt_history AS (
 SELECT a.job_id,a.id,a.provider,a.model,a.operation,a.round_number,a.worker_attempt,a.status,a.result_code,a.sent,a.usage_id,
  a.http_status,a.request_phase,a.provider_error_code,a.provider_error_type,a.provider_error_reason,a.started_at,a.finished_at,a.retry_after
 FROM public.model_attempts a JOIN timeline_jobs j ON j.id=a.job_id AND j.workspace_id=a.workspace_id
), selected_usage_history AS (
 SELECT u.id,u.job_id,u.provider,u.model,u.state,u.error_code,u.actual_input,u.actual_output,
  u.remote_request_id IS NOT NULL accepted_remote,u.remote_deadline,u.created_at,u.updated_at
 FROM public.provider_usage u JOIN timeline_jobs j ON j.id=u.job_id AND j.workspace_id=u.workspace_id
), selected_queue_wakes AS (
 SELECT q.job_id,q.job_revision,q.dispatched_at FROM app_private.worker_queue_wakes q
 JOIN timeline_jobs j ON j.id=q.job_id AND j.workspace_id=q.workspace_id
), workspace_reserved AS (
 SELECT * FROM public.provider_usage WHERE workspace_id='__WORKSPACE__' AND state='reserved'
), workspace_running AS (
 SELECT * FROM public.jobs WHERE workspace_id='__WORKSPACE__' AND status='running'
), due_groups AS (
 -- Raw due work is not a promise of claim eligibility: dependency, permission,
 -- source and request-specific uncertainty guards still execute in the worker.
 SELECT app_private.queue_work_class(j) work_class,j.type,j.status,
  coalesce((j.checkpoint->>'model_executor')::integer,1)<=2 executor_supported,
  count(*) due_count,min(j.next_attempt_at) oldest_due_at
 FROM public.jobs j WHERE j.workspace_id='__WORKSPACE__' AND j.status IN ('queued','retry_wait','quota_wait') AND j.next_attempt_at<=now()
 GROUP BY 1,2,3,4
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
 'latest_issuance',(SELECT jsonb_build_object('id',r.id,'plan_id',r.plan_id,'requested_by',r.requested_by,
   'operation',r.operation,'outcome',r.outcome,'error_code',r.error_code,'accepted_at',r.accepted_at,
   'deadline_at',r.deadline_at,'completed_at',r.completed_at,'effective_outcome',r.effective_outcome,
   'effective_error_code',r.effective_error_code,'effective_completed_at',r.effective_completed_at)
   FROM public.proposal_issuance_status r JOIN latest p ON p.workspace_id=r.workspace_id AND p.id=r.plan_id AND p.issuance_request_id=r.id),
 'prospective_draft_snapshot_sha256',(SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') FROM prospective),
 'workspace_evidence_revision',(SELECT evidence_revision FROM public.workspaces WHERE id='__WORKSPACE__'),
 'workflow_admission',(SELECT jsonb_build_object('enabled',a.enabled,'trial_opportunity_id',a.trial_opportunity_id,
   'selected_target_admitted',a.enabled AND (a.trial_opportunity_id IS NULL OR a.trial_opportunity_id='__OPPORTUNITY__'))
   FROM app_private.proposal_workflow_admission a WHERE singleton),
 'model_execution_enabled',coalesce((SELECT enabled FROM public.model_execution_settings WHERE workspace_id='__WORKSPACE__'),false),
 'restore_in_progress',EXISTS(SELECT 1 FROM public.restore_sessions WHERE workspace_id='__WORKSPACE__' AND state IN ('staging','committing')),
 'jobs',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'plan_id',entity_id,'type',type,'status',status,'revision',revision,
   'error_code',error_code,'attempts',attempts,'failure_count',failure_count,'input_hash',input_hash,
   'cancel_requested',cancel_requested,'lease_active',lease_until>now(),'lease_until',lease_until,'lease_present',lease_token IS NOT NULL,
   'next_attempt_at',next_attempt_at,'created_at',created_at,'updated_at',updated_at,
   'checkpoint',jsonb_build_object('model_executor',checkpoint->'model_executor','graph_thread',checkpoint->'graph_thread',
    'model_round_present',checkpoint ? 'model_round','round_input_hash',checkpoint#>'{model_round,input_hash}',
    'round_version',checkpoint#>'{model_round,version}','round_attempts',checkpoint#>'{model_routing,round_attempts}')) ORDER BY entity_id,id),'[]') FROM selected_jobs),
 'latest_attempts',(SELECT coalesce(jsonb_agg(to_jsonb(safe) ORDER BY safe.job_id),'[]') FROM (
   SELECT DISTINCT ON (a.job_id) a.job_id,a.id,a.provider,a.model,a.operation,a.status,a.result_code,a.sent,a.usage_id,
    a.http_status,a.request_phase,a.provider_error_code,a.provider_error_type,a.provider_error_reason,a.started_at,a.finished_at,a.retry_after
   FROM public.model_attempts a JOIN selected_jobs j ON j.id=a.job_id AND j.workspace_id=a.workspace_id ORDER BY a.job_id,a.id DESC) safe),
 -- Keep exact timing history for the selected plan without expanding customer
 -- prompts, remote IDs or execution metadata. LIMIT applies before JSON aggregation.
 'selected_plan_timeline',jsonb_build_object(
   'plan_id',(SELECT id FROM target),
   'attempt_total',(SELECT count(*) FROM selected_attempt_history),
   'attempts_truncated',(SELECT count(*) FROM selected_attempt_history)>2048,
   'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(safe) ORDER BY safe.started_at,safe.id),'[]') FROM (
    SELECT * FROM selected_attempt_history ORDER BY started_at,id LIMIT 2048) safe),
   'usage_total',(SELECT count(*) FROM selected_usage_history),
   'usage_truncated',(SELECT count(*) FROM selected_usage_history)>2048,
   'usage',(SELECT coalesce(jsonb_agg(to_jsonb(safe) ORDER BY safe.created_at,safe.id),'[]') FROM (
    SELECT * FROM selected_usage_history ORDER BY created_at,id LIMIT 2048) safe),
   'queue_wake_total',(SELECT count(*) FROM selected_queue_wakes),
   'queue_wakes_truncated',(SELECT count(*) FROM selected_queue_wakes)>2048,
   'queue_wakes',(SELECT coalesce(jsonb_agg(to_jsonb(safe) ORDER BY safe.dispatched_at,safe.job_id),'[]') FROM (
    SELECT * FROM selected_queue_wakes ORDER BY dispatched_at,job_id LIMIT 2048) safe)),
 'steps',(SELECT coalesce(jsonb_agg(to_jsonb(safe) ORDER BY safe.plan_id,safe.ordinal),'[]') FROM (
   SELECT s.id,s.revision,s.plan_id,s.job_id,s.task,s.stage,s.status,s.ordinal,s.repair_count FROM public.generation_steps s JOIN plans p ON p.id=s.plan_id AND p.workspace_id=s.workspace_id) safe),
 'threads',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'job_id',job_id,'status',status,'task',task,'result_id',result_id,
   'budget_version',budget_version,'candidate_count',candidate_count) ORDER BY job_id),'[]') FROM selected_threads),
 'budgets',(SELECT coalesce(jsonb_agg(to_jsonb(safe) ORDER BY safe.thread_id,safe.unit),'[]') FROM (
   SELECT b.thread_id,b.unit,b.candidates FROM app_private.model_graph_budgets b JOIN selected_threads t ON b.thread_id=t.id) safe),
 'phase_pins',(SELECT coalesce(jsonb_agg(jsonb_build_object('thread_id',r.thread_id,'key',r.result_key,'version',r.value->'version','content_hash',r.content_hash) ORDER BY r.thread_id,r.result_key),'[]')
   FROM app_private.model_graph_results r JOIN selected_threads t ON t.id=r.thread_id
   WHERE r.result_key LIKE 'semantic-instructions-%' OR r.result_key LIKE 'verification-instructions-%'),
 'usage',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'job_id',u.job_id,'provider',u.provider,'model',u.model,
   'state',u.state,'error_code',u.error_code,'actual_input',u.actual_input,'actual_output',u.actual_output,
   'accepted_remote',u.remote_request_id IS NOT NULL,'remote_deadline',u.remote_deadline,'created_at',u.created_at,
   'record_sha256',encode(sha256(convert_to(to_jsonb(u)::text,'UTF8')),'hex')) ORDER BY u.created_at,u.id),'[]')
   FROM public.provider_usage u JOIN selected_jobs j ON j.id=u.job_id AND j.workspace_id=u.workspace_id),
 'workspace_usage_guards',(SELECT jsonb_build_object('reserved',count(*) FILTER(WHERE state='reserved'),
   'unknown',count(*) FILTER(WHERE state='unknown'),
   'unknown_recent_or_remote_active',count(*) FILTER(WHERE state='unknown' AND (created_at>now()-interval '15 minutes' OR remote_deadline>now())))
   FROM public.provider_usage WHERE workspace_id='__WORKSPACE__'),
 'workspace_execution',jsonb_build_object(
   'settings',(SELECT jsonb_build_object('enabled',enabled,'revision',revision,'max_parallel_requests',max_parallel_requests)
    FROM public.model_execution_settings WHERE workspace_id='__WORKSPACE__'),
   'effective_max_parallel_requests',coalesce((SELECT max_parallel_requests FROM public.model_execution_settings WHERE workspace_id='__WORKSPACE__'),1),
   'reserved_count',(SELECT count(*) FROM workspace_reserved),
   'request_capacity_full',(SELECT count(*) FROM workspace_reserved)>=coalesce((SELECT max_parallel_requests FROM public.model_execution_settings WHERE workspace_id='__WORKSPACE__'),1),
   'reserved_rows_truncated',(SELECT count(*) FROM workspace_reserved)>64,
   'reserved_requests',(SELECT coalesce(jsonb_agg(to_jsonb(safe) ORDER BY safe.created_at,safe.id),'[]') FROM (
    SELECT u.id,u.job_id,u.provider,u.model,u.connection_id,u.model_config_id,u.remote_project_ref,u.state,u.error_code,u.created_at,u.updated_at,
     u.remote_request_id IS NOT NULL accepted_remote,u.remote_deadline,coalesce(u.remote_deadline>now(),false) remote_deadline_active,
     u.lease_token IS NOT DISTINCT FROM j.lease_token usage_matches_current_job_lease,
     j.type job_type,j.entity_id owner_entity_id,j.status job_status,j.error_code job_error_code,j.attempts job_attempts,j.cancel_requested,
     j.lease_token IS NOT NULL job_lease_present,j.lease_until job_lease_until,coalesce(j.lease_until>now(),false) job_lease_active,j.next_attempt_at,
     p.id owner_plan_id,p.kind owner_plan_kind,p.status owner_plan_status,p.stage owner_plan_stage,
     j.entity_id='__PLAN__' belongs_to_selected_plan
    FROM workspace_reserved u LEFT JOIN public.jobs j ON j.id=u.job_id AND j.workspace_id=u.workspace_id
    LEFT JOIN public.generation_plans p ON p.id=j.entity_id AND p.workspace_id=j.workspace_id ORDER BY u.created_at,u.id LIMIT 64) safe),
   'running_count',(SELECT count(*) FROM workspace_running),
   'running_with_active_lease',(SELECT count(*) FROM workspace_running WHERE lease_token IS NOT NULL AND lease_until>now()),
   'running_without_active_lease',(SELECT count(*) FROM workspace_running WHERE lease_token IS NULL OR lease_until IS NULL OR lease_until<=now()),
   'running_rows_truncated',(SELECT count(*) FROM workspace_running)>64,
   'running_jobs',(SELECT coalesce(jsonb_agg(to_jsonb(safe) ORDER BY safe.updated_at,safe.id),'[]') FROM (
    SELECT j.id,j.type,j.entity_id,j.status,j.error_code,j.attempts,j.cancel_requested,j.next_attempt_at,j.updated_at,j.lease_until,
     j.lease_token IS NOT NULL lease_present,coalesce(j.lease_until>now(),false) lease_active,
     EXISTS(SELECT 1 FROM workspace_reserved u WHERE u.job_id=j.id AND u.remote_request_id IS NOT NULL) accepted_reserved,
     j.entity_id='__PLAN__' belongs_to_selected_plan
    FROM workspace_running j ORDER BY j.updated_at,j.id LIMIT 64) safe),
   'due_by_class',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.work_class,d.type,d.status,d.executor_supported),'[]') FROM due_groups d)),
 'scheduler',jsonb_build_object(
   'operations',(SELECT jsonb_build_object('last_heartbeat_at',last_heartbeat_at,'scheduler_enabled',scheduler_enabled,'last_error_code',last_error_code)
    FROM public.operations WHERE workspace_id='__WORKSPACE__'),
   'dispatcher',(SELECT jsonb_build_object('enabled',enabled,'last_dispatch_at',last_dispatch_at,'last_worker_at',last_worker_at) FROM app_private.dispatcher_settings WHERE singleton),
   'outbox',current_setting('tenderdesk.inspection_dispatch_metadata')::jsonb,
   'queue_dispatch_state',(SELECT jsonb_build_object('cursor',cursor,'dispatch_count',dispatch_count) FROM app_private.queue_dispatch_state WHERE workspace_id='__WORKSPACE__')),
 'documents',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'revision',d.revision,'kind',d.kind,'status',d.status,
   'archived',d.archived,'original_hash',d.original_hash,'extraction_hash',d.extraction_hash,
   'extracted_characters',length(d.extracted_text)) ORDER BY d.id),'[]')
   FROM public.documents d JOIN target t ON t.workspace_id=d.workspace_id AND t.opportunity_id=d.opportunity_id WHERE d.kind='rfp'),
 'versions',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'plan_id',v.plan_id,'revision',v.revision) ORDER BY v.created_at,v.id),'[]')
   FROM public.proposal_versions v JOIN target t ON v.workspace_id=t.workspace_id AND v.proposal_id=t.proposal_id)
); COMMIT;
