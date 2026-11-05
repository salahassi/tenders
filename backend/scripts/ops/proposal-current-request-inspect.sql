-- Scoped evidence only. Both observations use the same immutable predecessor.
-- No commands, authorization changes, locks, retries or provider calls occur here.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='5s';
WITH target AS MATERIALIZED (
 SELECT p.* FROM public.generation_plans p
 WHERE p.workspace_id='__WORKSPACE__' AND p.opportunity_id='__OPPORTUNITY__'
 AND p.id='__PLAN__' AND p.kind='proposal'
), owners AS MATERIALIZED (
 SELECT m.user_id FROM public.memberships m JOIN public.identity_allowlist a
 ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
 WHERE m.workspace_id='__WORKSPACE__' AND m.active AND m.role='Owner'
 AND a.status='active' AND a.role='Owner'
), opportunity AS (
 SELECT o.* FROM public.opportunities o JOIN target t
 ON o.workspace_id=t.workspace_id AND o.id=t.opportunity_id
), proposal AS (
 SELECT p.* FROM public.proposals p JOIN target t
 ON p.workspace_id=t.workspace_id AND p.id=t.proposal_id AND p.opportunity_id=t.opportunity_id
), latest AS (
 SELECT p.* FROM public.generation_plans p WHERE p.workspace_id='__WORKSPACE__'
 AND p.opportunity_id='__OPPORTUNITY__' AND p.kind='proposal'
 ORDER BY p.created_at DESC,p.id DESC LIMIT 1
), jobs AS MATERIALIZED (
 SELECT j.* FROM public.jobs j JOIN target t ON j.workspace_id=t.workspace_id AND j.entity_id=t.id
), threads AS MATERIALIZED (
 SELECT t.* FROM app_private.model_graph_threads t JOIN jobs j ON j.workspace_id=t.workspace_id AND j.id=t.job_id
), prospective AS MATERIALIZED (
 SELECT CASE WHEN t.package_id IS NOT NULL THEN
 app_private.draft_generation_snapshot(t.workspace_id,t.opportunity_id,t.proposal_id,t.package_id) END value FROM target t
), frozen_refs AS (
 SELECT DISTINCT r.value FROM target t CROSS JOIN LATERAL jsonb_path_query(t.frozen_context,'$.**.reference') r(value)
 WHERE jsonb_typeof(r.value)='object' AND r.value->>'entity_kind'='document'
), current_refs AS (
 SELECT DISTINCT r.value FROM prospective p CROSS JOIN LATERAL jsonb_path_query(p.value,'$.**.reference') r(value)
 WHERE jsonb_typeof(r.value)='object' AND r.value->>'entity_kind'='document'
), source_manifest AS (
 SELECT (SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') FROM frozen_refs) frozen,
 (SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') FROM current_refs) current
), protected_rows AS (
 -- Hash each complete historical row, then hash the ordered row digests.
 -- The private report contains no frozen content, prompts or provider payloads.
 SELECT 'frozen_plan' relation, t.id::text identity,
 to_jsonb(t)-ARRAY['status','revision','updated_at'] value FROM target t
 UNION ALL SELECT 'completed_steps',s.id::text,to_jsonb(s) FROM public.generation_steps s JOIN target t
 ON s.workspace_id=t.workspace_id AND s.plan_id=t.id WHERE s.status='completed'
 UNION ALL SELECT 'graph_threads',t.id,to_jsonb(t) FROM threads t
 UNION ALL SELECT 'graph_results',r.id::text,to_jsonb(r) FROM app_private.model_graph_results r JOIN threads t ON t.id=r.thread_id
 UNION ALL SELECT 'phase_pins',r.id::text,to_jsonb(r) FROM app_private.model_graph_results r JOIN threads t ON t.id=r.thread_id
 WHERE r.result_key LIKE 'semantic-instructions-%' OR r.result_key LIKE 'verification-instructions-%'
 UNION ALL SELECT 'graph_budgets',b.thread_id||':'||b.unit,to_jsonb(b) FROM app_private.model_graph_budgets b JOIN threads t ON t.id=b.thread_id
 UNION ALL SELECT 'graph_checkpoints',c.thread_id||':'||c.namespace||':'||c.checkpoint_id,to_jsonb(c)
 FROM app_private.model_graph_checkpoints c JOIN threads t ON t.id=c.thread_id
 UNION ALL SELECT 'graph_writes',w.thread_id||':'||w.namespace||':'||w.checkpoint_id||':'||w.task_id||':'||w.idx,to_jsonb(w)
 FROM app_private.model_graph_writes w JOIN threads t ON t.id=w.thread_id
 UNION ALL SELECT 'paid_usage',u.id::text,to_jsonb(u) FROM public.provider_usage u JOIN jobs j ON j.workspace_id=u.workspace_id AND j.id=u.job_id
 UNION ALL SELECT 'model_attempts',a.id::text,to_jsonb(a) FROM public.model_attempts a JOIN jobs j ON j.workspace_id=a.workspace_id AND j.id=a.job_id
 UNION ALL SELECT 'unknown_usage',u.id::text,to_jsonb(u) FROM public.provider_usage u
 JOIN jobs j ON j.workspace_id=u.workspace_id AND j.id=u.job_id WHERE u.state='unknown'
), protected_names AS (
 SELECT unnest(ARRAY['frozen_plan','completed_steps','graph_threads','graph_results','phase_pins','graph_budgets',
 'graph_checkpoints','graph_writes','paid_usage','model_attempts','unknown_usage']) relation
), history AS (
 SELECT n.relation,jsonb_build_object('count',count(r.identity),'sha256',encode(sha256(convert_to(
 coalesce(string_agg(encode(sha256(convert_to(r.value::text,'UTF8')),'hex'),E'\n' ORDER BY r.identity),''),'UTF8')),'hex')) proof
 FROM protected_names n LEFT JOIN protected_rows r ON r.relation=n.relation GROUP BY n.relation
)
SELECT jsonb_build_object(
 'version',1,'kind','current_proposal_read_only_proof','observed_at',now(),
 'selection',jsonb_build_object('version',1,'workspace_id','__WORKSPACE__','opportunity_id','__OPPORTUNITY__','plan_id','__PLAN__'),
 'actor_id',(SELECT user_id FROM owners ORDER BY user_id LIMIT 1),
 'proposal_id',(SELECT id FROM proposal),
 'expected_plan_revision',(SELECT revision FROM target),
 'expected_opportunity_revision',(SELECT revision FROM opportunity),
 'expected_proposal_revision',(SELECT revision FROM proposal),
 'preserved_input_hash',(SELECT input_hash FROM target),
 'plan_status',(SELECT status FROM target),
 'latest_plan',(SELECT jsonb_build_object('id',id,'proposal_id',proposal_id,'status',status,'revision',revision,
   'current_contract',frozen_context->'generated_delivery_version'='3'::jsonb AND frozen_context->'proposal_consistency_version'='1'::jsonb,
   'issuance_request_id',issuance_request_id) FROM latest),
 'latest_issuance',(SELECT jsonb_build_object('id',r.id,'plan_id',r.plan_id,'requested_by',r.requested_by,
   'operation',r.operation,'accepted_at',r.accepted_at,'deadline_at',r.deadline_at,'outcome',r.outcome,
   'completed_at',r.completed_at,'error_code',r.error_code,'effective_outcome',r.effective_outcome,
   'effective_error_code',r.effective_error_code,'effective_completed_at',r.effective_completed_at)
   FROM public.proposal_issuance_status r JOIN latest p ON p.workspace_id=r.workspace_id AND p.id=r.plan_id AND p.issuance_request_id=r.id),
 'proposal_plan_count',(SELECT count(*) FROM public.generation_plans WHERE workspace_id='__WORKSPACE__' AND opportunity_id='__OPPORTUNITY__' AND kind='proposal'),
 'source_manifest_sha256',(SELECT encode(sha256(convert_to(frozen::text,'UTF8')),'hex') FROM source_manifest),
 'prospective_snapshot_sha256',(SELECT encode(sha256(convert_to(value::text,'UTF8')),'hex') FROM prospective),
 'guards',jsonb_build_object(
   'database',current_database()='tenderdesk_app' AND (SELECT count(*) FROM public.workspaces)=1,
   'selected_target',(SELECT count(*) FROM target)=1 AND (SELECT count(*) FROM opportunity)=1 AND (SELECT count(*) FROM proposal)=1,
   'unique_active_owner',(SELECT count(*) FROM owners)=1,
   'no_restore',NOT EXISTS(SELECT 1 FROM public.restore_sessions WHERE workspace_id='__WORKSPACE__' AND state IN ('staging','committing')),
   'latest_selected',(SELECT id FROM latest)='__PLAN__'::uuid,
   'legacy_blocked',(SELECT status='blocked' AND (frozen_context->'generated_delivery_version' IS DISTINCT FROM '3'::jsonb
     OR frozen_context->'proposal_consistency_version' IS DISTINCT FROM '1'::jsonb) FROM target),
   'no_active_version',(SELECT active_version_id IS NULL FROM proposal) AND (SELECT base_version_id IS NULL FROM target),
   'selected_opportunity',(SELECT NOT archived AND decision='shortlisted' FROM opportunity),
   'same_language',(SELECT frozen_context->>'language' FROM target) IS NOT DISTINCT FROM (SELECT language FROM opportunity),
   'sources_match',(SELECT frozen=current AND jsonb_array_length(frozen)>0 FROM source_manifest),
   'no_active_predecessor_work',NOT EXISTS(SELECT 1 FROM jobs WHERE status='running' OR lease_token IS NOT NULL OR lease_until>now())
     AND NOT EXISTS(SELECT 1 FROM public.provider_usage u JOIN jobs j ON j.workspace_id=u.workspace_id AND j.id=u.job_id WHERE u.state='reserved')
 ),
 'protected_history',(SELECT jsonb_object_agg(relation,proof) FROM history)
);
ROLLBACK;
