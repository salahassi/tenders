BEGIN READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='20s';
DO $selection$
DECLARE s jsonb:='__SELECTION__'::jsonb; count_rows integer; actor uuid; snapshot public.proposal_delivery_snapshots;
BEGIN
 IF current_database()<>'tenderdesk_app' OR NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=(s->>'workspace_id')::uuid)
 THEN RAISE EXCEPTION 'DELIVERY_DATABASE_MISMATCH'; END IF;
 SELECT d.* INTO snapshot FROM public.proposal_delivery_snapshots d
 JOIN public.proposals p ON p.id=d.proposal_id AND p.workspace_id=d.workspace_id
 JOIN public.opportunities o ON o.id=d.opportunity_id AND o.workspace_id=d.workspace_id
 WHERE d.id=(s->>'snapshot_id')::uuid AND d.workspace_id=(s->>'workspace_id')::uuid
 AND d.opportunity_id=(s->>'opportunity_id')::uuid AND d.proposal_id=(s->>'proposal_id')::uuid
 AND d.content_hash=s->>'content_hash' AND p.active_delivery_snapshot_id=d.id
 AND p.delivery_revision=(s->>'delivery_revision')::integer AND NOT o.archived;
 IF snapshot.id IS NULL THEN RAISE EXCEPTION 'DELIVERY_CURRENT_SNAPSHOT_REQUIRED'; END IF;
 SELECT count(*),min(m.user_id::text)::uuid INTO count_rows,actor FROM public.memberships m JOIN public.identity_allowlist a
 ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
 WHERE m.workspace_id=(s->>'workspace_id')::uuid AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner';
 IF count_rows<>1 THEN RAISE EXCEPTION 'DELIVERY_EXACT_ACTIVE_OWNER_REQUIRED'; END IF;
 PERFORM app_private.check_delivery_snapshot(snapshot,actor);
END $selection$;
SELECT jsonb_build_object('actor_id',m.user_id)
FROM public.memberships m JOIN public.identity_allowlist a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
WHERE m.workspace_id=('__SELECTION__'::jsonb->>'workspace_id')::uuid AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner';
COMMIT;
