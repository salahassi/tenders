\set ON_ERROR_STOP on
\set ECHO none
\set VERBOSITY terse
\set QUIET on
\getenv probe_database BOOTSTRAP_DATABASE
\getenv role_prefix ROLE_PREFIX
SELECT set_config('td_bootstrap.database', :'probe_database', false) AS ignored,
       set_config('td_bootstrap.prefix', :'role_prefix', false) AS ignored_prefix
\gset
BEGIN;
DO $probe$
DECLARE
  db text := current_setting('td_bootstrap.database');
  prefix text := current_setting('td_bootstrap.prefix');
  expected text := 'tenderdesk-isolated-bootstrap:' || db || ':' || prefix;
BEGIN
  IF db !~ '^td_bootstrap_[0-9]+_[0-9]+_[0-9a-f]{8,16}$'
     OR prefix !~ '^tdb_[0-9]{1,12}_[0-9a-f]{8,16}$'
     OR current_database() <> db
     OR (SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = db) IS DISTINCT FROM expected
     OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = db) IS DISTINCT FROM current_user
     OR to_regclass('auth.users') IS NULL
     OR to_regclass('auth.schema_migrations') IS NULL
     OR to_regclass('storage.objects') IS NULL
     OR to_regclass('storage.migrations') IS NULL
     OR to_regprocedure('auth.uid()') IS NULL
  THEN RAISE EXCEPTION 'BOOTSTRAP_POST_MIGRATION_GUARD_FAILED'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE starts_with(rolname, prefix || '_') AND (rolsuper OR rolbypassrls))
  THEN RAISE EXCEPTION 'BOOTSTRAP_UNEXPECTED_ELEVATED_ROLE'; END IF;
END
$probe$;

SELECT format('SET LOCAL ROLE %I', :'role_prefix' || '_authadmin')
\gexec
SELECT format('GRANT EXECUTE ON FUNCTION auth.uid() TO %I, %I, %I',
              :'role_prefix' || '_anon', :'role_prefix' || '_authenticated', :'role_prefix' || '_service')
\gexec
RESET ROLE;
SELECT format('SET LOCAL ROLE %I', :'role_prefix' || '_owner')
\gexec
-- Automated fixture only, isolated from the actual TenderDesk application.
CREATE TABLE public.td_bootstrap_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  value text NOT NULL CHECK (length(value) <= 128)
);
ALTER TABLE public.td_bootstrap_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.td_bootstrap_records FROM PUBLIC;
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.td_bootstrap_records TO %I', :'role_prefix' || '_authenticated')
\gexec
SELECT format('CREATE POLICY td_bootstrap_self ON public.td_bootstrap_records FOR ALL TO %I USING ((SELECT auth.uid()) = owner_id) WITH CHECK ((SELECT auth.uid()) = owner_id)', :'role_prefix' || '_authenticated')
\gexec
RESET ROLE;
SELECT format('SET LOCAL ROLE %I', :'role_prefix' || '_storageadmin')
\gexec
SELECT format('GRANT USAGE ON SCHEMA storage TO %I, %I, %I', :'role_prefix' || '_anon', :'role_prefix' || '_authenticated', :'role_prefix' || '_service')
\gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects, storage.buckets TO %I, %I', :'role_prefix' || '_authenticated', :'role_prefix' || '_service')
\gexec
SELECT format('CREATE POLICY td_bootstrap_bucket_read ON storage.buckets FOR SELECT TO %I USING (id = %L)', :'role_prefix' || '_authenticated', 'td-bootstrap-private')
\gexec
SELECT format('CREATE POLICY td_bootstrap_object_self ON storage.objects FOR ALL TO %I USING (bucket_id = %L AND owner_id = (SELECT auth.uid())::text) WITH CHECK (bucket_id = %L AND owner_id = (SELECT auth.uid())::text)', :'role_prefix' || '_authenticated', 'td-bootstrap-private', 'td-bootstrap-private')
\gexec
RESET ROLE;
NOTIFY pgrst, 'reload schema';
COMMIT;
SELECT jsonb_build_object('status','post_migrations_complete',
  'auth_migrations',(SELECT count(*) FROM auth.schema_migrations),
  'storage_migrations',(SELECT count(*) FROM storage.migrations),
  'fixture_rls',(SELECT relrowsecurity FROM pg_class WHERE oid='public.td_bootstrap_records'::regclass)) AS probe;
