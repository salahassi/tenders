-- Read-only authorization evidence for current scheduled assessment inputs.
-- Does not invoke preflight/authorization functions (those can insert grants).
-- Returns only policy flags, provider IDs and aggregate permission counts.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout = '20s';
SET LOCAL lock_timeout = '5s';
DO $guard$
BEGIN
  IF current_database() <> 'tenderdesk_app'
    OR (SELECT count(*) FROM public.workspaces) <> 1
    OR NOT EXISTS (SELECT 1 FROM public.workspaces WHERE id = '__WORKSPACE__')
  THEN RAISE EXCEPTION 'CONTENT_PERMISSION_DIAGNOSTIC_DATABASE_MISMATCH'; END IF;
END $guard$;
WITH w AS (
 SELECT id,discovery_policy FROM public.workspaces WHERE id='__WORKSPACE__'::uuid
), policy AS (
 SELECT w.id,coalesce(w.discovery_policy->'auto_public_notices'='true'::jsonb,false) auto_public_notices,
 coalesce(w.discovery_policy->'auto_company_knowledge'='true'::jsonb,false) auto_company_knowledge,
 coalesce(w.discovery_policy->'providers','[]'::jsonb) providers,
 w.discovery_policy->>'approved_at' policy_approved_at,
 EXISTS(SELECT 1 FROM public.memberships m JOIN public.identity_allowlist a
  ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
  WHERE m.workspace_id=w.id AND m.user_id::text=w.discovery_policy->>'approved_by'
  AND m.active AND m.role='Owner' AND a.status='active') approval_current
 FROM w
), plans AS (
 SELECT p.id,p.workspace_id,p.status,p.error_code,p.frozen_context,
 request.requested_at,request.requested_at is not null valid_request_receipt
 FROM public.generation_plans p JOIN w ON w.id=p.workspace_id
 LEFT JOIN LATERAL (SELECT r.requested_at FROM app_private.generation_processing_requests r
  JOIN public.memberships m ON m.workspace_id=r.workspace_id AND m.user_id=r.requested_by
   AND m.active AND m.role IN ('Owner','Editor')
  JOIN public.identity_allowlist a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id AND a.status='active'
  WHERE r.workspace_id=p.workspace_id AND r.plan_id=p.id) request ON true
 WHERE p.kind='assessment' AND p.status IN ('running','queued','blocked')
 ORDER BY p.updated_at DESC LIMIT 200
), refs AS (
 SELECT DISTINCT p.id plan_id,p.workspace_id,p.status,p.error_code,p.valid_request_receipt,p.requested_at,
 x->>'entity_kind' entity_kind,x->>'entity_id' entity_id,x->>'content_hash' content_hash
 FROM plans p CROSS JOIN LATERAL (
  SELECT p.frozen_context#>'{notice,reference}' x
  UNION ALL
  SELECT k->'reference' FROM jsonb_array_elements(coalesce(p.frozen_context->'knowledge','[]')) k
   WHERE k->>'kind'='company' AND k->'verified'='true'::jsonb
 ) evidence
 WHERE x IS NOT NULL AND x<>'null'::jsonb
), providers AS (
 SELECT DISTINCT c.provider FROM public.model_connections c JOIN w ON w.id=c.workspace_id
 WHERE c.enabled
), permissions AS (
 SELECT r.plan_id,r.status,r.error_code,r.valid_request_receipt,r.entity_kind,p.provider,
 EXISTS(SELECT 1 FROM public.content_authorizations a WHERE a.workspace_id=r.workspace_id
  AND a.provider=p.provider AND a.entity_kind=r.entity_kind AND a.entity_id::text=r.entity_id
  AND a.content_hash=r.content_hash AND a.revoked_at IS NULL AND a.authorization_basis='explicit') explicit_authorized,
 EXISTS(SELECT 1 FROM public.content_authorizations a WHERE a.workspace_id=r.workspace_id
  AND a.provider=p.provider AND a.entity_kind=r.entity_kind AND a.entity_id::text=r.entity_id
  AND a.content_hash=r.content_hash AND a.revoked_at IS NULL AND a.authorization_basis='company_knowledge_policy') company_policy_authorized,
 EXISTS(SELECT 1 FROM public.content_authorizations a WHERE a.workspace_id=r.workspace_id
  AND a.provider=p.provider AND a.entity_kind=r.entity_kind AND a.entity_id::text=r.entity_id
  AND a.content_hash=r.content_hash AND a.revoked_at IS NOT NULL) explicit_revocation_present,
 EXISTS(SELECT 1 FROM public.content_authorizations a WHERE a.workspace_id=r.workspace_id
  AND a.provider=p.provider AND a.entity_kind=r.entity_kind AND a.entity_id::text=r.entity_id
  AND a.content_hash=r.content_hash AND a.revoked_at>=r.requested_at) revoked_since_request
 FROM refs r CROSS JOIN providers p
), counts AS (
 SELECT provider,status,error_code,valid_request_receipt,entity_kind,
 count(DISTINCT plan_id) plans,count(*) reference_count,
 count(*) FILTER(WHERE explicit_authorized) explicit_authorized_references,
 count(*) FILTER(WHERE company_policy_authorized) company_policy_references,
 count(*) FILTER(WHERE explicit_revocation_present) revoked_references,
 count(*) FILTER(WHERE revoked_since_request) revoked_since_request_references
 FROM permissions GROUP BY provider,status,error_code,valid_request_receipt,entity_kind
)
SELECT jsonb_build_object('observed_at',now(),'plans_examined',(SELECT count(*) FROM plans),
 'scope',jsonb_build_object('authorization_decision',false,'plan_limit',200,
   'plan_selection','latest_updated_active_status_assessments','provider_selection','enabled_connections',
   'limitations',jsonb_build_array('automatic_policy_grants_may_be_created_lazily',
     'stored_grants_require_current_policy_and_content_eligibility',
     'manual_receipts_authorize_only_selected_supported_inputs')),
 'policies',(SELECT coalesce(jsonb_agg(jsonb_build_object(
  'provider',p.provider,'provider_in_policy',coalesce(policy.providers ? p.provider,false),
  'auto_public_notices',policy.auto_public_notices,'auto_company_knowledge',policy.auto_company_knowledge,
  'approval_current',policy.approval_current,'policy_approved_at',policy.policy_approved_at) ORDER BY p.provider),'[]') FROM policy CROSS JOIN providers p),
 'frozen_classification_reference_permissions',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY provider,status,error_code,entity_kind),'[]') FROM counts c)
);
COMMIT;
