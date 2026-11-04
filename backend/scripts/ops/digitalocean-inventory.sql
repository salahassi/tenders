BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='20s'; SET LOCAL lock_timeout='5s';
DO $inventory$
DECLARE releases jsonb:='[]'; canonical jsonb:=null; routines text; result jsonb; jobs jsonb:=null; delivery jsonb:=null; capacity jsonb:=null; issuance jsonb:=null;
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'INVENTORY_DATABASE_IDENTITY_MISMATCH';END IF;
 IF to_regclass('app_private.application_release_history') IS NOT NULL THEN
  EXECUTE 'SELECT coalesce(jsonb_agg(jsonb_build_object(''release'',release,''migration_sha256'',migration_sha256,''applied_at'',applied_at) ORDER BY applied_at,release),''[]''::jsonb) FROM app_private.application_release_history' INTO releases;
 END IF;
 IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
  EXECUTE 'SELECT jsonb_build_object(''count'',count(*),''latest_version'',max(version)) FROM supabase_migrations.schema_migrations' INTO canonical;
 END IF;
 SELECT encode(sha256(convert_to(coalesce(string_agg(
  p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid)||':'||coalesce(p.proacl::text,''),E'\n' ORDER BY p.oid::regprocedure::text),''),'UTF8')),'hex') INTO routines
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app_private') AND p.prokind='f';
 IF to_regclass('public.jobs') IS NOT NULL AND to_regprocedure('app_private.queue_work_class(public.jobs)') IS NOT NULL THEN
  EXECUTE $query$WITH measured AS (SELECT app_private.queue_work_class(j) class,j.status,j.created_at,j.updated_at,j.next_attempt_at,j.lease_until
   FROM public.jobs j WHERE j.status IN ('queued','running','retry_wait','quota_wait','blocked') OR j.updated_at>=now()-interval '24 hours')
  SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY class),'[]') FROM (
   SELECT CASE WHEN class IN ('local','poll','proposal','background') THEN class ELSE 'other' END class,
    count(*) FILTER(WHERE status IN ('queued','retry_wait','quota_wait')) pending,
    count(*) FILTER(WHERE status IN ('queued','retry_wait') AND next_attempt_at<=now()) due,
    count(*) FILTER(WHERE status='running') running,count(*) FILTER(WHERE status='blocked') blocked,
    count(*) FILTER(WHERE status='running' AND (lease_until IS NULL OR lease_until<=now())) expired_leases,
    coalesce(max(greatest(0,extract(epoch FROM now()-created_at))) FILTER(WHERE status IN ('queued','retry_wait') AND next_attempt_at<=now()),0)::float8 oldest_due_age_seconds,
    count(*) FILTER(WHERE status='succeeded' AND updated_at>=now()-interval '24 hours') succeeded_in_window,
    (percentile_cont(0.95) WITHIN GROUP(ORDER BY greatest(0,extract(epoch FROM updated_at-created_at))) FILTER(WHERE status='succeeded' AND updated_at>=now()-interval '24 hours'))::float8 terminal_row_elapsed_p95_seconds
   FROM measured GROUP BY 1)x$query$ INTO jobs;
 END IF;
 IF to_regclass('public.proposal_delivery_artifacts') IS NOT NULL THEN
  EXECUTE $query$SELECT jsonb_build_object('pending',count(*) FILTER(WHERE status='pending'),'ready',count(*) FILTER(WHERE status='ready'),
   'expired',count(*) FILTER(WHERE status='expired'),'reserved_bytes',coalesce(sum(reserved_bytes),0),
   'ready_bytes',coalesce(sum(expected_size) FILTER(WHERE status='ready'),0)) FROM public.proposal_delivery_artifacts$query$ INTO delivery;
 END IF;
 IF to_regprocedure('app_private.storage_reserved_bytes(uuid)') IS NOT NULL THEN
  EXECUTE $query$SELECT jsonb_build_object('workspace_count',count(*),'total_reserved_bytes',coalesce(sum(bytes),0),
   'largest_workspace_reserved_bytes',coalesce(max(bytes),0),'workspaces_at_or_above_limit',count(*) FILTER(WHERE bytes>=262144000),'workspace_limit_bytes',262144000)
   FROM (SELECT app_private.storage_reserved_bytes(id) bytes FROM public.workspaces)x$query$ INTO capacity;
 END IF;
 IF to_regclass('public.proposal_issuance_requests') IS NOT NULL THEN
  EXECUTE $query$SELECT jsonb_build_object(
   'active_before_deadline',count(*) FILTER(WHERE outcome='active' AND deadline_at>now()),
   'expired_unsettled',count(*) FILTER(WHERE outcome='active' AND deadline_at<=now()),
   'issued_in_window',count(*) FILTER(WHERE outcome='issued' AND completed_at>=now()-interval '24 hours'),
   'failed_in_window',count(*) FILTER(WHERE outcome='failed' AND completed_at>=now()-interval '24 hours'),
   'issued_after_deadline',count(*) FILTER(WHERE outcome='issued' AND completed_at>deadline_at),
   'invalid_deadline_bindings',count(*) FILTER(WHERE deadline_version<>1 OR deadline_at IS DISTINCT FROM accepted_at+interval '600 seconds' OR completed_at<accepted_at OR (outcome<>'active' AND completed_at IS NULL)),
   'issued_latency_p95_seconds',(percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM completed_at-accepted_at)) FILTER(WHERE outcome='issued' AND completed_at>=now()-interval '24 hours'))::float8,
   'issued_latency_max_seconds',(max(extract(epoch FROM completed_at-accepted_at)) FILTER(WHERE outcome='issued' AND completed_at>=now()-interval '24 hours'))::float8,
   'deadline_seconds',600)
   FROM public.proposal_issuance_requests$query$ INTO issuance;
 END IF;
 result:=jsonb_build_object('version',1,'database_identity_verified',true,'releases',releases,'canonical_migrations',canonical,
  'routine_catalog_sha256',routines,'metrics',jsonb_build_object('window_hours',24,'jobs',jobs,'delivery',delivery,'capacity',capacity,'issuance',issuance),'capabilities',jsonb_build_object(
   'delivery_snapshots',to_regclass('public.proposal_delivery_snapshots') IS NOT NULL,
   'delivery_artifacts',to_regclass('public.proposal_delivery_artifacts') IS NOT NULL,
   'claim_executor_3',to_regprocedure('public.claim_backend_job_v3()') IS NOT NULL,
   'delivery_export_context',to_regprocedure('public.delivery_export_context(uuid,uuid)') IS NOT NULL,
   'delivery_package',to_regprocedure('public.delivery_package(uuid)') IS NOT NULL));
 PERFORM set_config('tenderdesk.inventory_receipt',result::text,true);
END $inventory$;
SELECT current_setting('tenderdesk.inventory_receipt');
ROLLBACK;
