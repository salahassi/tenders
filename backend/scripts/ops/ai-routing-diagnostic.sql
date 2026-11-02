-- Diagnosis only. Workspace constant matches transfer-sources.py access.WORKSPACE.
-- Explicit metadata projections exclude prompts, document text, and credentials.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout = '25s';
SET LOCAL lock_timeout = '5s';
DO $guard$
BEGIN
  IF current_database() <> 'tenderdesk_app'
    OR (SELECT count(*) FROM public.workspaces) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = '__WORKSPACE__')
  THEN RAISE EXCEPTION 'QWEN_DIAGNOSTIC_DATABASE_MISMATCH'; END IF;
END $guard$;
WITH target AS (
  SELECT '__WORKSPACE__'::uuid AS workspace_id
), provider_history AS (
  SELECT a.provider, count(*) AS attempts,
    count(*) FILTER (WHERE a.sent) AS sent_attempts,
    count(*) FILTER (WHERE a.result_code = 'SUCCEEDED') AS successful_attempts,
    min(a.started_at) AS first_attempt_at,
    max(a.started_at) AS latest_attempt_at,
    max(a.started_at) FILTER (WHERE a.sent) AS latest_sent_at,
    max(a.started_at) FILTER (WHERE a.result_code = 'SUCCEEDED') AS latest_success_at,
    (array_agg(a.result_code ORDER BY a.started_at DESC, a.id DESC))[1] AS latest_result_code,
    (array_agg(a.model ORDER BY a.started_at DESC, a.id DESC))[1] AS latest_model
  FROM public.model_attempts a JOIN target t USING (workspace_id)
  GROUP BY a.provider
), current_routes AS (
  SELECT r.task, r.strategy, r.inherit_default, r.next_position,
    r.revision, r.created_at, r.updated_at,
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'position', x.position, 'model_config_id', x.model_id,
      'connection_id', m.connection_id, 'provider', c.provider,
      'model', m.model, 'model_enabled', m.enabled, 'connection_enabled', c.enabled
    ) ORDER BY x.position), '[]'::jsonb)
    FROM unnest(r.model_ids) WITH ORDINALITY x(model_id, position)
    LEFT JOIN public.model_configurations m ON m.workspace_id = r.workspace_id AND m.id = x.model_id
    LEFT JOIN public.model_connections c ON c.workspace_id = r.workspace_id AND c.id = m.connection_id
    ) AS models
  FROM public.model_task_routes r JOIN target t USING (workspace_id)
), current_catalog AS (
  SELECT c.provider, c.id AS connection_id, m.id AS model_config_id, m.model,
    c.enabled AS connection_enabled, m.enabled AS model_enabled,
    c.created_at AS connection_created_at, c.updated_at AS connection_updated_at,
    m.created_at AS model_created_at, m.updated_at AS model_updated_at
  FROM public.model_connections c JOIN target t USING (workspace_id)
  JOIN public.model_configurations m ON m.workspace_id = c.workspace_id AND m.connection_id = c.id
), running_classify AS MATERIALIZED (
  SELECT j.id, j.status, j.error_code, j.attempts, j.next_attempt_at,
    j.created_at, j.updated_at, p.created_at AS plan_created_at,
    j.checkpoint->>'model_executor' AS model_executor,
    j.checkpoint#>>'{model_operation,task}' AS operation_task,
    j.checkpoint#>>'{model_routing,strategy}' AS routing_strategy,
    j.checkpoint AS internal_checkpoint
  FROM public.jobs j JOIN target t USING (workspace_id)
  JOIN public.generation_plans p ON p.workspace_id = j.workspace_id AND p.id = j.entity_id
  WHERE j.type = 'classify_opportunity' AND p.kind = 'assessment' AND p.status = 'running'
    AND j.status IN ('queued', 'running', 'retry_wait', 'quota_wait', 'blocked', 'failed')
), frozen_metadata AS MATERIALIZED (
  SELECT j.id, j.status, j.error_code, j.attempts, j.next_attempt_at,
    j.created_at, j.updated_at, j.plan_created_at,
    j.model_executor, j.operation_task, j.routing_strategy,
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'position', f.position, 'provider', f.value->>'provider', 'model', f.value->>'model',
      'enabled', f.value->'enabled', 'connection_id', f.value->>'connection_id',
      'model_config_id', f.value->>'model_config_id'
    ) ORDER BY f.position), '[]'::jsonb)
    FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(j.internal_checkpoint#>'{model_routing,providers}') = 'array'
      THEN j.internal_checkpoint#>'{model_routing,providers}' ELSE '[]'::jsonb END
    ) WITH ORDINALITY f(value, position)) AS frozen_providers,
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'task', r.value->>'task', 'strategy', r.value->>'strategy',
      'inherit_default', r.value->'inherit_default',
      'models', (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'position', ids.position, 'model_config_id', ids.value,
        'connection_id', m.value->>'connection_id', 'provider', m.value->>'provider',
        'model', m.value->>'model', 'enabled', m.value->'enabled'
      ) ORDER BY ids.position), '[]'::jsonb)
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.value->'model_ids') = 'array'
        THEN r.value->'model_ids' ELSE '[]'::jsonb END) WITH ORDINALITY ids(value, position)
      LEFT JOIN LATERAL (
        SELECT model.value FROM jsonb_array_elements(CASE
          WHEN jsonb_typeof(j.internal_checkpoint#>'{model_catalog_snapshot,models}') = 'array'
          THEN j.internal_checkpoint#>'{model_catalog_snapshot,models}' ELSE '[]'::jsonb END
        ) model(value) WHERE model.value->>'model_config_id' = ids.value LIMIT 1
      ) m ON true)
    ) ORDER BY r.value->>'task'), '[]'::jsonb)
    FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(j.internal_checkpoint#>'{model_catalog_snapshot,routes}') = 'array'
      THEN j.internal_checkpoint#>'{model_catalog_snapshot,routes}' ELSE '[]'::jsonb END
    ) r(value) WHERE r.value->>'task' IN ('default', 'classify_opportunity')) AS frozen_routes
  FROM running_classify j
), classified AS MATERIALIZED (
  SELECT f.*, md5(jsonb_build_object('providers', frozen_providers, 'routes', frozen_routes)::text) AS pool_signature
  FROM frozen_metadata f
), frozen_pools AS (
  SELECT pool_signature, model_executor, operation_task, routing_strategy,
    status, error_code, frozen_providers, frozen_routes, count(*) AS job_count,
    min(created_at) AS earliest_job_created_at, max(created_at) AS latest_job_created_at,
    min(updated_at) AS earliest_job_updated_at, max(updated_at) AS latest_job_updated_at,
    min(plan_created_at) AS earliest_plan_created_at, max(plan_created_at) AS latest_plan_created_at
  FROM classified
  GROUP BY pool_signature, model_executor, operation_task, routing_strategy,
    status, error_code, frozen_providers, frozen_routes
), recent_classify_jobs AS (
  SELECT id, status, error_code, attempts, next_attempt_at, created_at, updated_at,
    plan_created_at, model_executor, operation_task, routing_strategy, pool_signature
  FROM classified ORDER BY updated_at DESC, id DESC LIMIT 12
), qwen_usage AS (
  SELECT u.provider, u.model, u.state, u.error_code, count(*) AS records,
    min(u.created_at) AS earliest_created_at, max(u.created_at) AS latest_created_at,
    max(u.updated_at) AS latest_updated_at
  FROM public.provider_usage u JOIN target t USING (workspace_id)
  WHERE u.provider IN ('qwencloud', 'qwen_free')
  GROUP BY u.provider, u.model, u.state, u.error_code
)
SELECT jsonb_build_object(
  'observed_at', now(),
  'provider_history', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY provider), '[]'::jsonb) FROM provider_history x),
  'current_routes', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY task), '[]'::jsonb) FROM current_routes x),
  'current_catalog', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY provider, model), '[]'::jsonb) FROM current_catalog x),
  'frozen_pools', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY job_count DESC, pool_signature), '[]'::jsonb) FROM frozen_pools x),
  'recent_classify_jobs', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY updated_at DESC, id DESC), '[]'::jsonb) FROM recent_classify_jobs x),
  'qwen_usage', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY provider, model, state), '[]'::jsonb) FROM qwen_usage x)
);
COMMIT;
