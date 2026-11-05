-- One selected, already-authorized request only. No leases, retries, commands,
-- expiry writes, artifact downloads, provider operations or billing mutations.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='5s';
-- These transaction-local settings retain fixed validation codes, not content.
-- Catching a stale source preserves the actual issuance timestamps in the same
-- database snapshot; it must never be presented as a current valid delivery.
DO $guard$
DECLARE p public.generation_plans; r public.proposal_issuance_requests;
 s public.proposal_delivery_snapshots; ref jsonb; requirement public.requirements;
 manifest jsonb; current_documents jsonb; saved_documents jsonb; artifact uuid;
BEGIN
 PERFORM set_config('ops.current_issuance_sources','failed',true);
 PERFORM set_config('ops.current_issuance_artifacts','not_issued',true);
 SELECT * INTO p FROM public.generation_plans WHERE workspace_id='__WORKSPACE__'
  AND opportunity_id='__OPPORTUNITY__' AND proposal_id='__PROPOSAL__' AND id='__PLAN__' AND kind='proposal';
 SELECT * INTO r FROM public.proposal_issuance_requests WHERE workspace_id='__WORKSPACE__'
  AND plan_id=p.id AND id='__ISSUANCE__' AND requested_by='__ACTOR__' AND operation='proposal.generate';
 IF p.id IS NULL OR r.id IS NULL OR p.issuance_request_id IS DISTINCT FROM r.id THEN RETURN; END IF;
 BEGIN
  PERFORM app_private.delivery_actor(p.workspace_id,'__ACTOR__');
  SELECT coalesce(jsonb_agg(DISTINCT x->'reference'),'[]') INTO manifest
   FROM jsonb_array_elements(jsonb_build_array(p.frozen_context->'notice')||coalesce(p.frozen_context->'blocks','[]')
    ||coalesce(p.frozen_context->'knowledge','[]')||coalesce(p.frozen_context->'reviews','[]')||coalesce(p.frozen_context->'rates','[]')) x
   WHERE x ? 'reference';
  PERFORM app_private.check_delivery_sources(p.workspace_id,manifest);
  PERFORM app_private.check_delivery_materials(p.workspace_id,p.frozen_context->'input_materials');
  SELECT coalesce(jsonb_agg(x->>'document_id' ORDER BY x->>'document_id'),'[]') INTO current_documents
   FROM jsonb_array_elements(app_private.delivery_input(p.workspace_id,p.opportunity_id)#>'{input_materials,documents}') x;
  SELECT coalesce(jsonb_agg(x->>'document_id' ORDER BY x->>'document_id'),'[]') INTO saved_documents
   FROM jsonb_array_elements(coalesce(p.frozen_context#>'{input_materials,documents}','[]')) x;
  IF current_documents IS DISTINCT FROM saved_documents THEN RAISE EXCEPTION 'STALE_INPUT'; END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(manifest) WHERE value->>'entity_kind'='document' LOOP
   IF app_private.current_document_extraction(p.workspace_id,(ref->>'entity_id')::uuid) IS DISTINCT FROM (ref->>'entity_id')::uuid
    THEN RAISE EXCEPTION 'STALE_INPUT'; END IF;
  END LOOP;
  FOR requirement IN SELECT * FROM public.requirements WHERE workspace_id=p.workspace_id AND plan_id=p.id LOOP
   IF requirement.source_semantics->>'review_status'='confirmed'
    AND NOT app_private.check_source_semantics(p.workspace_id,requirement.source_semantics,requirement.source_refs)
    THEN RAISE EXCEPTION 'STALE_INPUT'; END IF;
  END LOOP;
  PERFORM set_config('ops.current_issuance_sources','passed',true);
 EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('ops.current_issuance_sources',CASE WHEN SQLERRM IN ('STALE_INPUT','ROLE_FORBIDDEN','DELIVERY_SOURCE_UNAVAILABLE','RESTORE_IN_PROGRESS')
   THEN SQLERRM ELSE 'SOURCE_GUARD_FAILED' END,true);
 END;
 IF r.outcome='issued' THEN
  BEGIN
   SELECT * INTO s FROM public.proposal_delivery_snapshots WHERE id=r.issued_snapshot_id AND workspace_id=r.workspace_id AND plan_id=p.id;
   IF s.id IS NULL THEN RAISE EXCEPTION 'DELIVERY_EXPORT_INCOMPLETE'; END IF;
   SELECT a.id INTO artifact FROM public.proposal_delivery_artifacts a JOIN public.jobs j ON j.workspace_id=a.workspace_id AND j.id=a.job_id
    WHERE a.workspace_id=r.workspace_id AND a.snapshot_id=s.id AND j.checkpoint->>'issuance_request_id'=r.id::text
    AND j.status='succeeded' ORDER BY a.id LIMIT 1;
   IF artifact IS NULL THEN RAISE EXCEPTION 'DELIVERY_EXPORT_INCOMPLETE'; END IF;
   PERFORM public.delivery_artifact_context(artifact,'__ACTOR__');
   PERFORM set_config('ops.current_issuance_artifacts','passed',true);
  EXCEPTION WHEN OTHERS THEN
   PERFORM set_config('ops.current_issuance_artifacts',CASE WHEN SQLERRM IN ('STALE_INPUT','ROLE_FORBIDDEN','DELIVERY_SOURCE_UNAVAILABLE','RESTORE_IN_PROGRESS','DELIVERY_EXPORT_INCOMPLETE','DELIVERY_ARTIFACT_INVALID')
    THEN SQLERRM ELSE 'ARTIFACT_GUARD_FAILED' END,true);
  END;
 END IF;
END $guard$;
WITH target AS MATERIALIZED (
 SELECT * FROM public.generation_plans WHERE workspace_id='__WORKSPACE__' AND opportunity_id='__OPPORTUNITY__'
 AND proposal_id='__PROPOSAL__' AND id='__PLAN__' AND kind='proposal'
), request AS MATERIALIZED (
 SELECT r.* FROM public.proposal_issuance_status r JOIN target p ON p.workspace_id=r.workspace_id AND p.id=r.plan_id AND p.issuance_request_id=r.id
 WHERE r.id='__ISSUANCE__'
), proposal AS (
 SELECT p.* FROM public.proposals p JOIN target t ON p.workspace_id=t.workspace_id AND p.id=t.proposal_id
), snapshot AS MATERIALIZED (
 SELECT s.* FROM public.proposal_delivery_snapshots s JOIN request r ON r.workspace_id=s.workspace_id AND r.plan_id=s.plan_id AND r.issued_snapshot_id=s.id
), render_job AS MATERIALIZED (
 SELECT j.* FROM public.jobs j JOIN request r ON j.workspace_id=r.workspace_id AND j.checkpoint->>'issuance_request_id'=r.id::text
 JOIN snapshot s ON j.entity_id=s.id WHERE j.type='render_delivery' AND j.status='succeeded' ORDER BY j.created_at DESC,j.id DESC LIMIT 1
), artifacts AS MATERIALIZED (
 SELECT a.* FROM public.proposal_delivery_artifacts a JOIN snapshot s ON s.workspace_id=a.workspace_id AND s.id=a.snapshot_id
 JOIN render_job j ON j.workspace_id=a.workspace_id AND j.id=a.job_id
), jobs AS MATERIALIZED (
 SELECT j.* FROM public.jobs j JOIN request r ON j.workspace_id=r.workspace_id AND j.checkpoint->>'issuance_request_id'=r.id::text
)
SELECT jsonb_build_object(
 'version',1,'kind','current_proposal_issuance_observation','observed_at',clock_timestamp(),
 'target',jsonb_build_object('workspace_id','__WORKSPACE__','opportunity_id','__OPPORTUNITY__','proposal_id','__PROPOSAL__',
  'plan_id','__PLAN__','issuance_request_id','__ISSUANCE__','actor_id','__ACTOR__'),
 'guards',jsonb_build_object(
  'database',current_database()='tenderdesk_app' AND (SELECT count(*) FROM public.workspaces)=1,
  'selected_target',(SELECT count(*) FROM target)=1 AND (SELECT count(*) FROM request)=1 AND (SELECT count(*) FROM proposal)=1,
  'actor',(SELECT requested_by='__ACTOR__'::uuid AND operation='proposal.generate' FROM request)
   AND (SELECT count(*)=1 AND bool_and(m.user_id='__ACTOR__'::uuid) FROM public.memberships m JOIN public.identity_allowlist a
    ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id WHERE m.workspace_id='__WORKSPACE__' AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner'),
  'no_restore',NOT EXISTS(SELECT 1 FROM public.restore_sessions WHERE workspace_id='__WORKSPACE__' AND state IN ('staging','committing')),
  'opportunity',EXISTS(SELECT 1 FROM public.opportunities WHERE workspace_id='__WORKSPACE__' AND id='__OPPORTUNITY__' AND NOT archived),
  'latest_plan',(SELECT id FROM public.generation_plans WHERE workspace_id='__WORKSPACE__' AND opportunity_id='__OPPORTUNITY__' AND kind='proposal' ORDER BY created_at DESC,id DESC LIMIT 1)='__PLAN__'::uuid,
  'current_contract',(SELECT frozen_context->'generated_delivery_version'='3'::jsonb AND frozen_context->'proposal_consistency_version'='1'::jsonb FROM target),
  'sources',current_setting('ops.current_issuance_sources')='passed'),
 'source_check',current_setting('ops.current_issuance_sources'),
 'artifact_check',current_setting('ops.current_issuance_artifacts'),
 'issuance',(SELECT jsonb_build_object('id',id,'plan_id',plan_id,'requested_by',requested_by,'operation',operation,
  'accepted_at',accepted_at,'deadline_at',deadline_at,'outcome',outcome,'completed_at',completed_at,'error_code',error_code,
  'issued_snapshot_id',issued_snapshot_id,'effective_outcome',effective_outcome,'effective_error_code',effective_error_code,'effective_completed_at',effective_completed_at) FROM request),
 'plan',(SELECT jsonb_build_object('status',status,'error_code',error_code,'updated_at',updated_at) FROM target),
 'terminal_jobs',(SELECT coalesce(jsonb_agg(jsonb_build_object('type',type,'status',status,'error_code',error_code,'updated_at',updated_at) ORDER BY updated_at,id),'[]') FROM jobs WHERE status IN ('blocked','failed','canceled')),
 'package',(SELECT jsonb_build_object('snapshot_id',s.id,'created_at',s.created_at,
  'content_state',s.payload->>'content_state','approval_state',s.payload->>'approval_state',
  'required_volumes',app_private.delivery_volumes(s),
  'current_version',EXISTS(SELECT 1 FROM public.proposal_versions v JOIN proposal p ON p.active_version_id=v.id
    WHERE v.workspace_id=s.workspace_id AND v.plan_id=s.plan_id AND v.id::text=s.payload#>>'{generation,proposal_version_id}'
    AND v.content_hash=s.payload#>>'{generation,version_content_hash}'),
  'current_snapshot',(SELECT active_delivery_snapshot_id=s.id FROM proposal),
  'validated_generated_draft',s.payload->'version'='3'::jsonb AND s.payload->>'content_state'='generated_review_draft'
    AND s.payload#>'{generation,machine_validation,passed}'='true'::jsonb
    AND s.payload#>>'{generation,machine_validation,policy}'='generated-delivery-v1'
    AND s.plan_id::text=s.payload#>>'{generation,plan_id}'
    AND (SELECT input_hash FROM target)=s.payload#>>'{generation,plan_input_hash}',
  'render_job',(SELECT jsonb_build_object('status',status,'updated_at',updated_at) FROM render_job),
  'artifacts',(SELECT coalesce(jsonb_agg(jsonb_build_object('volume',volume,'status',status,'expected_size',expected_size,
    'content_hash',content_hash,'renderer_version',renderer_version,'created_at',created_at,'updated_at',updated_at) ORDER BY volume),'[]') FROM artifacts)) FROM snapshot s)
);
ROLLBACK;
