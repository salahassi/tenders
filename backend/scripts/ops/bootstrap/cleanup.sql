\set ON_ERROR_STOP on
\set ECHO none
\set VERBOSITY terse
\set QUIET on
\getenv probe_database BOOTSTRAP_DATABASE
\getenv role_prefix ROLE_PREFIX
SELECT set_config('td_bootstrap.database', :'probe_database', false) AS ignored,
       set_config('td_bootstrap.prefix', :'role_prefix', false) AS ignored_prefix
\gset
-- Always connect to defaultdb before cleanup. No existing name may be adopted.
DO $probe$
DECLARE
  db text := current_setting('td_bootstrap.database');
  prefix text := current_setting('td_bootstrap.prefix');
  expected text := 'tenderdesk-isolated-bootstrap:' || db || ':' || prefix;
  suffix text;
BEGIN
  IF current_database() <> 'defaultdb'
     OR db !~ '^td_bootstrap_[0-9]+_[0-9]+_[0-9a-f]{8,16}$'
     OR prefix !~ '^tdb_[0-9]{1,12}_[0-9a-f]{8,16}$'
  THEN RAISE EXCEPTION 'BOOTSTRAP_CLEANUP_IDENTITY_REJECTED'; END IF;
  IF EXISTS (SELECT 1 FROM pg_database WHERE datname=db)
     AND ((SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=db) IS DISTINCT FROM expected
          OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=db) IS DISTINCT FROM current_user)
  THEN RAISE EXCEPTION 'BOOTSTRAP_CLEANUP_DATABASE_OWNERSHIP_REJECTED'; END IF;
  FOREACH suffix IN ARRAY ARRAY['owner','authadmin','storageadmin','authenticator','anon','authenticated','service'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=prefix || '_' || suffix)
       AND (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname=prefix || '_' || suffix) IS DISTINCT FROM expected
    THEN RAISE EXCEPTION 'BOOTSTRAP_CLEANUP_ROLE_OWNERSHIP_REJECTED'; END IF;
  END LOOP;
END
$probe$;
SELECT format('DROP DATABASE %I WITH (FORCE)', :'probe_database')
WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname=:'probe_database')
\gexec
BEGIN;
SELECT format('DROP ROLE %I', :'role_prefix' || '_' || suffix)
FROM unnest(ARRAY['authenticator','service','anon','authenticated','authadmin','storageadmin','owner']) AS suffix
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname=:'role_prefix' || '_' || suffix)
\gexec
COMMIT;
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pg_database WHERE datname=:'probe_database')
             AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN
               (:'role_prefix'||'_owner', :'role_prefix'||'_authadmin', :'role_prefix'||'_storageadmin',
                :'role_prefix'||'_authenticator', :'role_prefix'||'_anon', :'role_prefix'||'_authenticated', :'role_prefix'||'_service'))
       THEN 'cleanup_complete' ELSE 'cleanup_incomplete' END AS status;
