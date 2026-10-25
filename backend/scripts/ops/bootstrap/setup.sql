\set ON_ERROR_STOP on
\set ECHO none
\set VERBOSITY verbose
\set QUIET on
-- Isolated compatibility probe only. No source data, existing roles or existing
-- databases may be adopted. Run with psql -X, PGDATABASE=defaultdb and TLS.
\getenv probe_database BOOTSTRAP_DATABASE
\getenv role_prefix ROLE_PREFIX
\getenv auth_password AUTH_DB_PASSWORD
\getenv storage_password STORAGE_DB_PASSWORD
\getenv rest_password REST_DB_PASSWORD
SELECT set_config('td_bootstrap.database', :'probe_database', false) AS ignored,
       set_config('td_bootstrap.prefix', :'role_prefix', false) AS ignored_prefix,
       set_config('td_bootstrap.auth_password', :'auth_password', false) AS ignored_auth,
       set_config('td_bootstrap.storage_password', :'storage_password', false) AS ignored_storage,
       set_config('td_bootstrap.rest_password', :'rest_password', false) AS ignored_rest
\gset

BEGIN;
DO $probe$
DECLARE
  db text := current_setting('td_bootstrap.database');
  prefix text := current_setting('td_bootstrap.prefix');
  suffix text;
BEGIN
  IF current_database() <> 'defaultdb'
     OR db !~ '^td_bootstrap_[0-9]+_[0-9]+_[0-9a-f]{8,16}$'
     OR length(db) > 63
     OR prefix !~ '^tdb_[0-9]{1,12}_[0-9a-f]{8,16}$'
     OR length(prefix || '_authenticated') > 63
  THEN RAISE EXCEPTION 'BOOTSTRAP_IDENTITY_REJECTED'; END IF;
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname = db)
  THEN RAISE EXCEPTION 'BOOTSTRAP_DATABASE_ALREADY_EXISTS'; END IF;
  FOREACH suffix IN ARRAY ARRAY['owner','authadmin','storageadmin','authenticator','anon','authenticated','service'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = prefix || '_' || suffix)
    THEN RAISE EXCEPTION 'BOOTSTRAP_ROLE_ALREADY_EXISTS'; END IF;
  END LOOP;
  IF length(current_setting('td_bootstrap.auth_password')) < 32
     OR length(current_setting('td_bootstrap.storage_password')) < 32
     OR length(current_setting('td_bootstrap.rest_password')) < 32
  THEN RAISE EXCEPTION 'BOOTSTRAP_PASSWORD_REJECTED'; END IF;
END
$probe$;
SELECT 'tdb_stage_validated' AS status;

-- NO superuser or BYPASSRLS grant is attempted. Passwords enter through the
-- process environment, never through SQL assets or the command line.
SELECT format('CREATE ROLE %I NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'role_prefix' || '_owner')
\gexec
SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'role_prefix' || '_authadmin', :'auth_password')
\gexec
SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'role_prefix' || '_storageadmin', :'storage_password')
\gexec
SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'role_prefix' || '_authenticator', :'rest_password')
\gexec
SELECT format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'role_prefix' || '_anon')
\gexec
SELECT format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'role_prefix' || '_authenticated')
\gexec
SELECT format('CREATE ROLE %I NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'role_prefix' || '_service')
\gexec
SELECT format('COMMENT ON ROLE %I IS %L', :'role_prefix' || '_' || suffix,
              'tenderdesk-isolated-bootstrap:' || :'probe_database' || ':' || :'role_prefix')
FROM unnest(ARRAY['owner','authadmin','storageadmin','authenticator','anon','authenticated','service']) AS suffix
\gexec

-- PostgreSQL 16+ role creation grants ADMIN without necessarily granting SET.
-- Explicit membership concerns only the new, uniquely named probe roles.
-- The creator already receives ADMIN from PostgreSQL's bootstrap grantor.
-- Regranting ADMIN back to that membership fails with SQLSTATE 0LP01.
SELECT format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', :'role_prefix' || '_' || suffix, current_user)
FROM unnest(ARRAY['owner','authadmin','storageadmin']) AS suffix
\gexec
SELECT format('GRANT %I, %I, %I TO %I WITH INHERIT FALSE, SET TRUE',
              :'role_prefix' || '_anon', :'role_prefix' || '_authenticated',
              :'role_prefix' || '_service', :'role_prefix' || '_authenticator')
\gexec
-- Service access inherits ownership of fixture/public and storage tables. The
-- normal request roles inherit neither owner. This is an explicit alternative
-- to BYPASSRLS, with owner/DDL authority limited to this throwaway database.
SELECT format('GRANT %I, %I TO %I WITH INHERIT TRUE, SET TRUE',
              :'role_prefix' || '_owner', :'role_prefix' || '_storageadmin', :'role_prefix' || '_service')
\gexec
COMMIT;
SELECT 'tdb_stage_roles_created' AS status;

-- CREATE DATABASE cannot execute inside the transaction above.
SELECT format('CREATE DATABASE %I TEMPLATE template0', :'probe_database')
\gexec
SELECT format('COMMENT ON DATABASE %I IS %L', :'probe_database',
              'tenderdesk-isolated-bootstrap:' || :'probe_database' || ':' || :'role_prefix')
\gexec
SELECT 'tdb_stage_database_created' AS status;
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'probe_database')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I, %I, %I', :'probe_database',
              :'role_prefix' || '_authadmin', :'role_prefix' || '_storageadmin', :'role_prefix' || '_authenticator')
\gexec
-- Schema ownership transfer and upstream CREATE SCHEMA migrations require
-- CREATE within this new database, not the cluster-level CREATEDB attribute.
SELECT format('GRANT CREATE ON DATABASE %I TO %I, %I, %I', :'probe_database',
              :'role_prefix' || '_owner', :'role_prefix' || '_authadmin', :'role_prefix' || '_storageadmin')
\gexec
\connect :probe_database
BEGIN;
SELECT format('ALTER SCHEMA public OWNER TO %I', :'role_prefix' || '_owner')
\gexec
SELECT format('SET LOCAL ROLE %I', :'role_prefix' || '_owner')
\gexec
REVOKE ALL ON SCHEMA public FROM PUBLIC;
RESET ROLE;
SELECT format('CREATE SCHEMA auth AUTHORIZATION %I', :'role_prefix' || '_authadmin')
\gexec
SELECT format('CREATE SCHEMA storage AUTHORIZATION %I', :'role_prefix' || '_storageadmin')
\gexec
CREATE SCHEMA extensions;
SELECT 'tdb_stage_schemas_created' AS status;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION pg_trgm WITH SCHEMA extensions;
SELECT 'tdb_stage_extensions_installed' AS status;
SELECT format('GRANT USAGE ON SCHEMA extensions TO %I, %I, %I, %I, %I, %I',
              :'role_prefix' || '_authadmin', :'role_prefix' || '_storageadmin',
              :'role_prefix' || '_owner', :'role_prefix' || '_anon',
              :'role_prefix' || '_authenticated', :'role_prefix' || '_service')
\gexec
SELECT format('SET LOCAL ROLE %I', :'role_prefix' || '_authadmin')
\gexec
SELECT format('GRANT USAGE ON SCHEMA auth TO %I, %I, %I, %I, %I',
              :'role_prefix' || '_anon', :'role_prefix' || '_authenticated',
              :'role_prefix' || '_service', :'role_prefix' || '_storageadmin', :'role_prefix' || '_owner')
\gexec
RESET ROLE;
SELECT format('SET LOCAL ROLE %I', :'role_prefix' || '_owner')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I, %I, %I, %I',
              :'role_prefix' || '_anon', :'role_prefix' || '_authenticated',
              :'role_prefix' || '_service', :'role_prefix' || '_storageadmin')
\gexec
RESET ROLE;
SELECT format('SET LOCAL ROLE %I', :'role_prefix' || '_storageadmin')
\gexec
SELECT format('GRANT USAGE ON SCHEMA storage TO %I, %I, %I',
              :'role_prefix' || '_anon', :'role_prefix' || '_authenticated', :'role_prefix' || '_service')
\gexec
RESET ROLE;
SELECT format('ALTER ROLE %I IN DATABASE %I SET search_path = auth, public, extensions', :'role_prefix' || '_authadmin', :'probe_database')
\gexec
SELECT format('ALTER ROLE %I IN DATABASE %I SET search_path = storage, public, extensions', :'role_prefix' || '_storageadmin', :'probe_database')
\gexec
SELECT format('ALTER ROLE %I IN DATABASE %I SET search_path = public, storage, extensions', :'role_prefix' || '_authenticator', :'probe_database')
\gexec
COMMIT;
SELECT 'setup_complete' AS status;
