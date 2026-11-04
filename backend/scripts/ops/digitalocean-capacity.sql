-- Settings only: no application rows, query text, connection strings or changes.
BEGIN READ ONLY;
DO $capacity$
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'CAPACITY_DATABASE_IDENTITY_MISMATCH';END IF;
 -- Preserve the fresh observer login's settings before the bounded query override.
 -- SET ROLE does not load another role's login defaults; do not use it as proof.
 PERFORM set_config('tenderdesk.capacity_settings',(
  SELECT jsonb_agg(jsonb_build_object('name',name,'setting',setting::bigint,'unit',unit,
   'source',source,'reset_setting',reset_val::bigint,'boot_setting',boot_val::bigint) ORDER BY name)::text
  FROM pg_settings WHERE name IN ('statement_timeout','work_mem','max_connections')),true);
END $capacity$;
SET LOCAL statement_timeout='20s'; SET LOCAL lock_timeout='5s';
SELECT jsonb_build_object('version',1,'database_identity_verified',true,
 'observed_login_role',CASE WHEN session_user='doadmin' THEN 'doadmin' ELSE 'unrecognized' END,
 'observed_login_settings',current_setting('tenderdesk.capacity_settings')::jsonb,
 'query_overrides',jsonb_build_object('statement_timeout_ms',20000,'lock_timeout_ms',5000),
 'configured_defaults',coalesce((
  SELECT jsonb_agg(jsonb_build_object('scope',CASE WHEN x.setdatabase=0 THEN 'all_databases' ELSE 'current_database' END,
   'role',CASE WHEN x.setrole=0 THEN null ELSE r.rolname END,'name',split_part(v,'=',1),'value',substring(v FROM position('=' IN v)+1))
   ORDER BY x.setdatabase,x.setrole,split_part(v,'=',1))
  FROM pg_db_role_setting x LEFT JOIN pg_roles r ON r.oid=x.setrole CROSS JOIN LATERAL unnest(x.setconfig) v
  WHERE x.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
   AND (x.setrole=0 OR r.rolname IN ('tdp_app_owner','tdp_app_authenticator','tdp_app_anon','tdp_app_authenticated','tdp_app_service'))
   AND split_part(v,'=',1) IN ('statement_timeout','work_mem','max_connections')),'[]'::jsonb),
 'basis','observer_login_and_catalog_defaults_not_rest_transaction_effective');
ROLLBACK;
