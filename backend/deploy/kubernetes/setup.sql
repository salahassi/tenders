\set ON_ERROR_STOP on
\set ECHO none
\set VERBOSITY verbose
\set QUIET on
-- Permanent, marker-owned TenderDesk roles and database only. Never DROP or
-- adopt an unmarked object. Repeated runs retain existing login passwords.
-- Administrator credentials come solely from the short-lived database init Job.
\set app_database tenderdesk_app
\set role_prefix tdp_app
\getenv auth_password AUTH_DB_PASSWORD
\getenv storage_password STORAGE_DB_PASSWORD
\getenv rest_password REST_DB_PASSWORD
SELECT set_config('td_setup.database', :'app_database', false) AS ignored,
       set_config('td_setup.prefix', :'role_prefix', false) AS ignored_prefix,
       set_config('td_setup.auth_password', :'auth_password', false) AS ignored_auth,
       set_config('td_setup.storage_password', :'storage_password', false) AS ignored_storage,
       set_config('td_setup.rest_password', :'rest_password', false) AS ignored_rest
\gset

BEGIN;
DO $setup$
DECLARE
  db text := current_setting('td_setup.database');
  prefix text := current_setting('td_setup.prefix');
  marker text := 'tenderdesk-managed-kubernetes:' || db || ':' || prefix;
  suffix text;
  existing record;
  password text;
  login_role boolean;
BEGIN
  IF current_database() <> 'defaultdb' OR db <> 'tenderdesk_app' OR prefix <> 'tdp_app'
  THEN RAISE EXCEPTION 'SETUP_IDENTITY_REJECTED'; END IF;
  IF length(current_setting('td_setup.auth_password')) < 32
     OR length(current_setting('td_setup.storage_password')) < 32
     OR length(current_setting('td_setup.rest_password')) < 32
  THEN RAISE EXCEPTION 'SETUP_PASSWORD_REJECTED'; END IF;
  IF EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = db
      AND (shobj_description(d.oid, 'pg_database') IS DISTINCT FROM marker
           OR pg_get_userbyid(d.datdba) <> current_user))
  THEN RAISE EXCEPTION 'SETUP_FOREIGN_DATABASE_REJECTED'; END IF;
  -- Check every existing role before changing any membership or creating roles.
  FOREACH suffix IN ARRAY ARRAY['owner','authadmin','storageadmin','authenticator','anon','authenticated','service'] LOOP
    SELECT r.*, shobj_description(r.oid, 'pg_authid') AS marker INTO existing
      FROM pg_roles r WHERE r.rolname = prefix || '_' || suffix;
    login_role := suffix IN ('authadmin','storageadmin','authenticator');
    IF FOUND AND (existing.marker IS DISTINCT FROM marker
       OR existing.rolsuper OR existing.rolcreatedb OR existing.rolcreaterole
       OR existing.rolreplication OR existing.rolbypassrls
       OR existing.rolcanlogin IS DISTINCT FROM login_role)
    THEN RAISE EXCEPTION 'SETUP_FOREIGN_ROLE_REJECTED'; END IF;
  END LOOP;
  FOREACH suffix IN ARRAY ARRAY['owner','authadmin','storageadmin','authenticator','anon','authenticated','service'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = prefix || '_' || suffix) THEN
      login_role := suffix IN ('authadmin','storageadmin','authenticator');
      IF login_role THEN
        password := current_setting('td_setup.' || CASE suffix
          WHEN 'authadmin' THEN 'auth_password'
          WHEN 'storageadmin' THEN 'storage_password' ELSE 'rest_password' END);
        EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', prefix || '_' || suffix, password);
      ELSE
        EXECUTE format('CREATE ROLE %I NOLOGIN %s NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
          prefix || '_' || suffix, CASE WHEN suffix IN ('owner','service') THEN 'INHERIT' ELSE 'NOINHERIT' END);
      END IF;
      EXECUTE format('COMMENT ON ROLE %I IS %L', prefix || '_' || suffix, marker);
    END IF;
  END LOOP;
END
$setup$;
-- PostgreSQL already grants ADMIN to role creators. Regranting ADMIN to one's
-- own membership fails in PG18; enable only scoped SET and keep INHERIT off.
SELECT format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', :'role_prefix' || '_' || suffix, current_user)
FROM unnest(ARRAY['owner','authadmin','storageadmin']) AS suffix
\gexec
SELECT format('GRANT %I, %I, %I TO %I WITH INHERIT FALSE, SET TRUE',
              :'role_prefix' || '_anon', :'role_prefix' || '_authenticated',
              :'role_prefix' || '_service', :'role_prefix' || '_authenticator')
\gexec
SELECT format('GRANT %I, %I TO %I WITH INHERIT TRUE, SET TRUE',
              :'role_prefix' || '_owner', :'role_prefix' || '_storageadmin', :'role_prefix' || '_service')
\gexec
COMMIT;
SELECT format('CREATE DATABASE %I TEMPLATE template0', :'app_database')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'app_database')
\gexec
SELECT format('COMMENT ON DATABASE %I IS %L', :'app_database',
              'tenderdesk-managed-kubernetes:' || :'app_database' || ':' || :'role_prefix')
\gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'app_database')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I, %I', :'app_database',
              :'role_prefix' || '_authadmin', :'role_prefix' || '_storageadmin', :'role_prefix' || '_authenticator')
\gexec
SELECT format('GRANT CREATE ON DATABASE %I TO %I, %I, %I', :'app_database',
              :'role_prefix' || '_owner', :'role_prefix' || '_authadmin', :'role_prefix' || '_storageadmin')
\gexec
\connect :app_database
BEGIN;
DO $guard$
DECLARE expected text;
BEGIN
  IF current_database() <> 'tenderdesk_app'
     OR (SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database())
       IS DISTINCT FROM 'tenderdesk-managed-kubernetes:tenderdesk_app:tdp_app'
  THEN RAISE EXCEPTION 'SETUP_DATABASE_MARKER_REJECTED'; END IF;
  FOREACH expected IN ARRAY ARRAY['auth','storage'] LOOP
    IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = expected
        AND pg_get_userbyid(nspowner) <> 'tdp_app_' || CASE expected WHEN 'auth' THEN 'authadmin' ELSE 'storageadmin' END)
    THEN RAISE EXCEPTION 'SETUP_FOREIGN_SCHEMA_REJECTED'; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'public'
      AND pg_get_userbyid(nspowner) NOT IN ('pg_database_owner', 'tdp_app_owner'))
  THEN RAISE EXCEPTION 'SETUP_PUBLIC_OWNER_REJECTED'; END IF;
END
$guard$;
ALTER SCHEMA public OWNER TO tdp_app_owner;
SET LOCAL ROLE tdp_app_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
RESET ROLE;
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION tdp_app_authadmin;
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION tdp_app_storageadmin;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO tdp_app_authadmin, tdp_app_storageadmin, tdp_app_owner, tdp_app_anon, tdp_app_authenticated, tdp_app_service;
SET LOCAL ROLE tdp_app_authadmin;
GRANT USAGE ON SCHEMA auth TO tdp_app_anon, tdp_app_authenticated, tdp_app_service, tdp_app_storageadmin, tdp_app_owner;
RESET ROLE;
SET LOCAL ROLE tdp_app_owner;
GRANT USAGE ON SCHEMA public TO tdp_app_anon, tdp_app_authenticated, tdp_app_service, tdp_app_storageadmin;
RESET ROLE;
SET LOCAL ROLE tdp_app_storageadmin;
GRANT USAGE ON SCHEMA storage TO tdp_app_anon, tdp_app_authenticated, tdp_app_service;
RESET ROLE;
ALTER ROLE tdp_app_authadmin IN DATABASE tenderdesk_app SET search_path = auth, public, extensions;
ALTER ROLE tdp_app_storageadmin IN DATABASE tenderdesk_app SET search_path = storage, public, extensions;
ALTER ROLE tdp_app_authenticator IN DATABASE tenderdesk_app SET search_path = public, storage, extensions;
COMMIT;
SELECT 'permanent_setup_complete' AS status;
