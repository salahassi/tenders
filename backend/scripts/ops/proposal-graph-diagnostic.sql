BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='5s';
DO $guard$ DECLARE retained_bytes bigint; BEGIN
 IF current_database()<>'tenderdesk_app' OR (SELECT count(*) FROM public.workspaces)<>1
  OR NOT EXISTS(SELECT 1 FROM public.generation_plans p
   JOIN public.jobs j ON j.workspace_id=p.workspace_id AND j.entity_id=p.id
   JOIN public.generation_steps s ON s.workspace_id=p.workspace_id AND s.plan_id=p.id AND s.job_id=j.id
   WHERE p.id='__PLAN__' AND p.workspace_id='__WORKSPACE__' AND p.opportunity_id='__OPPORTUNITY__'
    AND p.kind='proposal' AND j.id='__JOB__' AND j.type=s.task)
 THEN RAISE EXCEPTION 'PROPOSAL_GRAPH_TARGET_MISMATCH'; END IF;
 -- Bound retained content before constructing the JSON report. Fail without
 -- truncating a candidate or verifier artifact needed to explain the failure.
 SELECT coalesce(sum(size),0) INTO retained_bytes FROM (
  SELECT octet_length(p.frozen_context::text)::bigint size FROM public.generation_plans p
   WHERE p.workspace_id='__WORKSPACE__' AND p.id='__PLAN__'
  UNION ALL SELECT octet_length(s.input::text)+octet_length(coalesce(s.output,'null')::text)
   FROM public.generation_steps s WHERE s.workspace_id='__WORKSPACE__' AND s.plan_id='__PLAN__' AND s.job_id='__JOB__'
  UNION ALL SELECT octet_length(r.value::text) FROM app_private.model_graph_results r
   JOIN app_private.model_graph_threads t ON t.id=r.thread_id AND t.workspace_id=r.workspace_id
   WHERE t.workspace_id='__WORKSPACE__' AND t.job_id='__JOB__'
  UNION ALL SELECT octet_length(c.checkpoint::text)+octet_length(c.metadata::text) FROM app_private.model_graph_checkpoints c
   JOIN app_private.model_graph_threads t ON t.id=c.thread_id AND t.workspace_id=c.workspace_id
   WHERE t.workspace_id='__WORKSPACE__' AND t.job_id='__JOB__'
  UNION ALL SELECT octet_length(w.value::text) FROM app_private.model_graph_writes w
   JOIN app_private.model_graph_threads t ON t.id=w.thread_id AND t.workspace_id=w.workspace_id
   WHERE t.workspace_id='__WORKSPACE__' AND t.job_id='__JOB__'
 ) content_size;
 IF retained_bytes>__MAX_REPORT_BYTES__-1048576 THEN RAISE EXCEPTION 'PROPOSAL_GRAPH_REPORT_TOO_LARGE'; END IF;
 IF (SELECT count(*) FROM app_private.model_graph_threads WHERE workspace_id='__WORKSPACE__' AND job_id='__JOB__')>8
  OR (SELECT count(*) FROM app_private.model_graph_results r JOIN app_private.model_graph_threads t ON t.id=r.thread_id AND t.workspace_id=r.workspace_id WHERE t.workspace_id='__WORKSPACE__' AND t.job_id='__JOB__')>2048
  OR (SELECT count(*) FROM app_private.model_graph_checkpoints c JOIN app_private.model_graph_threads t ON t.id=c.thread_id AND t.workspace_id=c.workspace_id WHERE t.workspace_id='__WORKSPACE__' AND t.job_id='__JOB__')>1024
  OR (SELECT count(*) FROM app_private.model_graph_writes w JOIN app_private.model_graph_threads t ON t.id=w.thread_id AND t.workspace_id=w.workspace_id WHERE t.workspace_id='__WORKSPACE__' AND t.job_id='__JOB__')>8192
  OR (SELECT count(*) FROM public.model_attempts WHERE workspace_id='__WORKSPACE__' AND job_id='__JOB__')>2048
  OR (SELECT count(*) FROM public.provider_usage WHERE workspace_id='__WORKSPACE__' AND job_id='__JOB__')>2048
 THEN RAISE EXCEPTION 'PROPOSAL_GRAPH_REPORT_TOO_LARGE'; END IF;
END $guard$;
WITH selected_threads AS (
 SELECT id,workspace_id,job_id,input_hash,task,graph_version,budget_version,status,candidate_count,result_id,created_at,updated_at
 FROM app_private.model_graph_threads WHERE workspace_id='__WORKSPACE__' AND job_id='__JOB__'
), payload AS (
SELECT jsonb_build_object(
 'version',1,'mode','read_only_graph_diagnostic','observed_at',now(),
 'selection',jsonb_build_object('workspace_id','__WORKSPACE__','opportunity_id','__OPPORTUNITY__','plan_id','__PLAN__','job_id','__JOB__'),
 'plan',(SELECT jsonb_build_object('id',id,'proposal_id',proposal_id,'status',status,'stage',stage,'error_code',error_code,
  'revision',revision,'workflow_version',workflow_version,'execution_policy',execution_policy,'input_hash',input_hash,
  'evidence_revision',evidence_revision,'frozen_context',frozen_context) FROM public.generation_plans WHERE workspace_id='__WORKSPACE__' AND id='__PLAN__'),
 'step',(SELECT jsonb_build_object('id',id,'task',task,'stage',stage,'ordinal',ordinal,'status',status,'repair_count',repair_count,
  'input',input,'output',output,'revision',revision) FROM public.generation_steps WHERE workspace_id='__WORKSPACE__' AND plan_id='__PLAN__' AND job_id='__JOB__'),
 'job',(SELECT jsonb_build_object('id',id,'type',type,'status',status,'error_code',error_code,'revision',revision,
  'attempts',attempts,'failure_count',failure_count,'input_hash',input_hash,'cancel_requested',cancel_requested,
  'lease_active',lease_until>now(),'next_attempt_at',next_attempt_at,'updated_at',updated_at,
  'checkpoint',jsonb_build_object('model_executor',checkpoint->'model_executor','graph_thread',checkpoint->'graph_thread',
   'round_input_hash',checkpoint#>'{model_round,input_hash}','round_version',checkpoint#>'{model_round,version}',
   'round_attempts',checkpoint#>'{model_routing,round_attempts}')) FROM public.jobs WHERE workspace_id='__WORKSPACE__' AND id='__JOB__'),
 'threads',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM selected_threads t),
 'budgets',(SELECT coalesce(jsonb_agg(jsonb_build_object('thread_id',b.thread_id,'unit',b.unit,'candidates',b.candidates) ORDER BY b.thread_id,b.unit),'[]')
  FROM app_private.model_graph_budgets b JOIN selected_threads t ON t.id=b.thread_id AND t.workspace_id=b.workspace_id),
 -- Full immutable values include every invalid-report-* fallback, first invalid
 -- phase, writer candidate, verification scope and pinned prompt revision.
 'results',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',r.id,'thread_id',r.thread_id,'result_key',r.result_key,
  'value',r.value,'content_hash',r.content_hash,'created_at',r.created_at) ORDER BY r.thread_id,r.created_at,r.result_key),'[]')
  FROM app_private.model_graph_results r JOIN selected_threads t ON t.id=r.thread_id AND t.workspace_id=r.workspace_id),
 'checkpoints',(SELECT coalesce(jsonb_agg(jsonb_build_object('thread_id',c.thread_id,'namespace',c.namespace,'checkpoint_id',c.checkpoint_id,
  'parent_id',c.parent_id,'checkpoint',c.checkpoint,'metadata',c.metadata,'created_at',c.created_at) ORDER BY c.thread_id,c.namespace,c.checkpoint_id),'[]')
  FROM app_private.model_graph_checkpoints c JOIN selected_threads t ON t.id=c.thread_id AND t.workspace_id=c.workspace_id),
 'writes',(SELECT coalesce(jsonb_agg(jsonb_build_object('thread_id',w.thread_id,'namespace',w.namespace,'checkpoint_id',w.checkpoint_id,
  'task_id',w.task_id,'task_path',w.task_path,'idx',w.idx,'channel',w.channel,'value',w.value) ORDER BY w.thread_id,w.namespace,w.checkpoint_id,w.task_id,w.idx),'[]')
  FROM app_private.model_graph_writes w JOIN selected_threads t ON t.id=w.thread_id AND t.workspace_id=w.workspace_id),
 'attempts',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'provider',provider,'model',model,'connection_id',connection_id,
  'model_config_id',model_config_id,'operation',operation,'round_number',round_number,'worker_attempt',worker_attempt,'status',status,
  'result_code',result_code,'sent',sent,'usage_id',usage_id,'started_at',started_at,'finished_at',finished_at,'http_status',http_status,
  'reported_model',reported_model,'finish_reason',finish_reason,'request_phase',request_phase,'provider_error_code',provider_error_code,
  'provider_error_type',provider_error_type,'provider_error_reason',provider_error_reason) ORDER BY id),'[]')
  FROM public.model_attempts WHERE workspace_id='__WORKSPACE__' AND job_id='__JOB__'),
 'usage',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'provider',provider,'model',model,'connection_id',connection_id,
  'model_config_id',model_config_id,'call_key',call_key,'input_hash',input_hash,'state',state,'error_code',error_code,
  'reserved_input',reserved_input,'reserved_output',reserved_output,'actual_input',actual_input,'actual_output',actual_output,
  'accepted_remote',remote_request_id IS NOT NULL,'remote_deadline',remote_deadline,'created_at',created_at,
  'graph_candidate_recorded',graph_candidate_recorded) ORDER BY created_at,id),'[]')
  FROM public.provider_usage WHERE workspace_id='__WORKSPACE__' AND job_id='__JOB__')
) report
)
SELECT CASE WHEN octet_length(report::text)<=__MAX_REPORT_BYTES__-1024 THEN report
 ELSE jsonb_build_object('version',1,'mode','report_too_large') END AS report FROM payload;
COMMIT;
