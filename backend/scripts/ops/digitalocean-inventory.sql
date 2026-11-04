BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='20s'; SET LOCAL lock_timeout='5s';
DO $inventory$
DECLARE releases jsonb:='[]'; canonical jsonb:=null; routines text; result jsonb;
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
 result:=jsonb_build_object('version',1,'database_identity_verified',true,'releases',releases,'canonical_migrations',canonical,
  'routine_catalog_sha256',routines,'capabilities',jsonb_build_object(
   'delivery_snapshots',to_regclass('public.proposal_delivery_snapshots') IS NOT NULL,
   'delivery_artifacts',to_regclass('public.proposal_delivery_artifacts') IS NOT NULL,
   'claim_executor_3',to_regprocedure('public.claim_backend_job_v3()') IS NOT NULL,
   'delivery_export_context',to_regprocedure('public.delivery_export_context(uuid,uuid)') IS NOT NULL,
   'delivery_package',to_regprocedure('public.delivery_package(uuid)') IS NOT NULL));
 PERFORM set_config('tenderdesk.inventory_receipt',result::text,true);
END $inventory$;
SELECT current_setting('tenderdesk.inventory_receipt');
ROLLBACK;
