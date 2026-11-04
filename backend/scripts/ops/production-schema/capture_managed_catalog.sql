BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='30s';SET LOCAL lock_timeout='5s';
DO $capture_guard$
DECLARE catalog_hash text;receipt text;stage text;releases jsonb;
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'RESTORE_SOURCE_DATABASE_MISMATCH';END IF;
 IF to_regclass('app_private.application_release_history') IS NULL THEN RAISE EXCEPTION 'RESTORE_SOURCE_RELEASE_REQUIRED';END IF;
 SELECT migration_sha256 INTO receipt FROM app_private.application_release_history WHERE release='proposal-delivery-reliability-v1';
 SELECT encode(sha256(convert_to(coalesce(string_agg(p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid)||':'||coalesce(p.proacl::text,''),E'\n' ORDER BY p.oid::regprocedure::text),''),'UTF8')),'hex') INTO catalog_hash
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app_private') AND p.prokind='f';
 IF receipt='__RELEASE_MANIFEST_SHA256__' AND catalog_hash=(SELECT migration_sha256 FROM app_private.application_release_history WHERE release='proposal-delivery-reliability-v1-catalog') THEN stage:='released';
 ELSE
  SELECT jsonb_object_agg(release,migration_sha256) INTO releases FROM app_private.application_release_history;
  IF receipt IS NOT NULL OR catalog_hash IS DISTINCT FROM '__BASELINE_CATALOG_SHA256__' OR releases IS DISTINCT FROM '__BASELINE_RELEASES_JSON__'::jsonb THEN RAISE EXCEPTION 'RESTORE_SOURCE_RELEASE_MISMATCH';END IF;
  stage:='baseline';
 END IF;
 PERFORM set_config('tenderdesk.restore_source_catalog_hash',catalog_hash,true);
 PERFORM set_config('tenderdesk.restore_source_stage',stage,true);
END $capture_guard$;
SELECT jsonb_build_object('catalog_sha256',current_setting('tenderdesk.restore_source_catalog_hash'),'source_stage',current_setting('tenderdesk.restore_source_stage'),'source_rows_copied',0,'catalog',jsonb_build_object(
 'relations',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.schema,x.relname),'[]') FROM (
  SELECT c.oid::bigint oid,n.nspname schema,c.relname,c.relkind,pg_get_userbyid(c.relowner) owner,c.relispartition is_partition,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,c.relacl::text acl,case when c.relkind='v' then pg_get_viewdef(c.oid) end view_definition
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p','v','m','S'))x),
 'columns',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.schema,x.relname,x.attnum),'[]') FROM (
  SELECT n.nspname schema,c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) data_type,a.attacl::text acl,a.attgenerated,a.attislocal,a.attidentity,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) default_expression,
   case when a.attcollation<>0 then (select quote_ident(collname) from pg_collation where oid=a.attcollation) end collation
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped)x),
 'constraints',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.schema,x.conname),'[]') FROM (
  SELECT c.conrelid::bigint conrelid,c.contypid::bigint contypid,c.conparentid::bigint conparentid,c.convalidated,c.contype,n.nspname schema,c.conname,pg_get_constraintdef(c.oid) definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN ('public','app_private'))x),
 'indexes',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.schema,x.table_name,x.index_name),'[]') FROM (
  SELECT n.nspname schema,t.relname table_name,i.relname index_name,p.indisvalid,p.indisready,p.indisclustered,p.indisreplident,pg_get_indexdef(p.indexrelid) definition
  FROM pg_index p JOIN pg_class t ON t.oid=p.indrelid JOIN pg_class i ON i.oid=p.indexrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname IN ('public','app_private'))x),
 'types',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.schema,x.typname),'[]') FROM (SELECT n.nspname schema,t.typname,t.typtype FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN ('public','app_private'))x),
 'sequences','[]'::jsonb,'dependencies','[]'::jsonb,
 'routines',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.schema,x.proname,x.identity_arguments),'[]') FROM (
  SELECT n.nspname schema,p.proname,pg_get_userbyid(p.proowner) owner,l.lanname language,p.prokind,pg_get_function_identity_arguments(p.oid) identity_arguments,pg_get_functiondef(p.oid) definition,p.proacl::text acl
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname IN ('public','app_private') AND p.prokind='f')x),
 'triggers-policies',jsonb_build_array(jsonb_build_object('export',jsonb_build_object(
  'triggers',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.schema,x.relname,x.tgname),'[]') FROM (SELECT n.nspname schema,c.relname,t.tgname,t.tgisinternal,t.tgenabled,pg_get_triggerdef(t.oid) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','app_private'))x),
  'policies',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.schema,x.relname,x.polname),'[]') FROM (
   SELECT n.nspname schema,c.relname,p.polname,p.polpermissive,p.polcmd,array(select case when role_id=0 then 'public' else pg_get_userbyid(role_id) end from unnest(p.polroles) role_id) roles,pg_get_expr(p.polqual,p.polrelid) using_expression,pg_get_expr(p.polwithcheck,p.polrelid) check_expression
   FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','app_private') OR (n.nspname='storage' AND c.relname='objects' AND p.polname IN ('tenderdesk_upload','tenderdesk_download','recovery_upload','tenderdesk_export_upload')))x)
 ))))) AS private_catalog;
ROLLBACK;
