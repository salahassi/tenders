BEGIN READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='20s';
DO $selection$
DECLARE s jsonb:='__SELECTION__'::jsonb; count_rows integer;
BEGIN
 IF current_database()<>'tenderdesk_app' OR NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=(s->>'workspace_id')::uuid)
 THEN RAISE EXCEPTION 'EXPORT_DATABASE_MISMATCH'; END IF;
 SELECT count(*) INTO count_rows FROM public.generation_plans g
 JOIN public.proposal_versions v ON v.plan_id=g.id AND v.workspace_id=g.workspace_id
 JOIN public.proposals p ON p.id=v.proposal_id AND p.workspace_id=v.workspace_id
 JOIN public.opportunities o ON o.id=g.opportunity_id AND o.workspace_id=g.workspace_id
 WHERE g.id=(s->>'plan_id')::uuid AND g.workspace_id=(s->>'workspace_id')::uuid
 AND g.opportunity_id=(s->>'opportunity_id')::uuid AND g.kind='proposal' AND g.status='completed'
 AND v.id=(s->>'proposal_version_id')::uuid AND v.revision=(s->>'expected_revision')::integer
 AND p.active_version_id=v.id AND p.opportunity_id=g.opportunity_id AND NOT o.archived;
 IF count_rows<>1 THEN RAISE EXCEPTION 'EXPORT_COMPLETED_CURRENT_VERSION_REQUIRED'; END IF;
 SELECT count(*) INTO count_rows FROM public.memberships m JOIN public.identity_allowlist a
 ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
 WHERE m.workspace_id=(s->>'workspace_id')::uuid AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner';
 IF count_rows<>1 THEN RAISE EXCEPTION 'EXPORT_EXACT_ACTIVE_OWNER_REQUIRED'; END IF;
END $selection$;
SELECT jsonb_build_object('actor_id',m.user_id,'proposal_id',v.proposal_id)
FROM public.memberships m JOIN public.identity_allowlist a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
JOIN public.proposal_versions v ON v.workspace_id=m.workspace_id
WHERE m.workspace_id=('__SELECTION__'::jsonb->>'workspace_id')::uuid AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner'
AND v.id=('__SELECTION__'::jsonb->>'proposal_version_id')::uuid;
COMMIT;
