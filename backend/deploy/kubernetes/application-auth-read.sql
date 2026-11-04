-- Platform-owned Auth tables, not application migrations. The caller supplies
-- the exact reviewed database/role family and an enclosing transaction.
-- A REPEATABLE READ caller must lock these Auth relations before its first query
-- snapshot, as proposal-delivery-release.py does. A late lock cannot refresh an
-- old snapshot. Fresh schema provisioning uses READ COMMITTED.
DO $auth_read_preflight$
BEGIN
 IF current_database()<>__DATABASE__ OR
  (select shobj_description(oid,'pg_database') from pg_database where datname=current_database()) IS DISTINCT FROM __MARKER__
 THEN RAISE EXCEPTION 'APPLICATION_AUTH_DATABASE_MISMATCH';END IF;
 IF NOT pg_has_role(session_user,__AUTH_ROLE__,'SET') OR NOT pg_has_role(session_user,__APP_ROLE__,'SET')
 THEN RAISE EXCEPTION 'APPLICATION_AUTH_SET_ROLE_REQUIRED';END IF;
END $auth_read_preflight$;
RESET ROLE;
SET LOCAL ROLE __AUTH_IDENTIFIER__;
DO $auth_read_policy$
DECLARE target text; relation_id oid; app_role oid; auth_role oid; policy_row pg_policy;
 before_authority jsonb; after_authority jsonb;
BEGIN
 SELECT oid INTO app_role FROM pg_roles WHERE rolname=__APP_ROLE__ AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb;
 SELECT oid INTO auth_role FROM pg_roles WHERE rolname=__AUTH_ROLE__ AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb;
 IF app_role IS NULL OR auth_role IS NULL OR current_user<>__AUTH_ROLE__
  OR pg_has_role(app_role,auth_role,'USAGE') THEN RAISE EXCEPTION 'APPLICATION_AUTH_ROLE_MISMATCH';END IF;
 -- The relation locks already serialize both policy writes. Do not introduce
 -- a second lock ordering against the release's pre-snapshot Auth locks.
 LOCK TABLE auth.users,auth.identities IN SHARE ROW EXCLUSIVE MODE;
 SELECT jsonb_build_object(
  'tables',(select jsonb_agg(jsonb_build_object('id',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity) order by c.oid) from pg_class c where c.oid in ('auth.users'::regclass,'auth.identities'::regclass)),
  'columns',(select jsonb_agg(jsonb_build_object('relation',a.attrelid,'number',a.attnum,'acl',a.attacl) order by a.attrelid,a.attnum) from pg_attribute a where a.attrelid in ('auth.users'::regclass,'auth.identities'::regclass) and a.attnum>0 and not a.attisdropped),
  'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
  'memberships',(select coalesce(jsonb_agg(to_jsonb(r) order by r.roleid,r.member,r.grantor),'[]') from pg_auth_members r),
  'other_policies',(select coalesce(jsonb_agg(to_jsonb(p) order by p.oid),'[]') from pg_policy p where p.polrelid in ('auth.users'::regclass,'auth.identities'::regclass) and p.polname<>'tenderdesk_application_identity_read')
 ) INTO before_authority;
 FOREACH target IN ARRAY ARRAY['users','identities'] LOOP
  relation_id:=to_regclass('auth.'||target);
  IF NOT EXISTS(select 1 from pg_class c where c.oid=relation_id and c.relkind='r' and c.relowner=auth_role and c.relrowsecurity and not c.relforcerowsecurity)
   OR NOT has_table_privilege(app_role,relation_id,'SELECT') OR NOT has_schema_privilege(app_role,'auth','USAGE')
  THEN RAISE EXCEPTION 'APPLICATION_AUTH_TABLE_MISMATCH';END IF;
  IF has_table_privilege(__ANON_ROLE__,relation_id,'SELECT') OR has_table_privilege(__MEMBER_ROLE__,relation_id,'SELECT')
  THEN RAISE EXCEPTION 'APPLICATION_AUTH_BROWSER_PRIVILEGE';END IF;
  -- An unknown applicable policy could intentionally restrict these reads.
  -- Never weaken it by adding a new permissive policy alongside it.
  IF EXISTS(select 1 from pg_policy p where p.polrelid=relation_id and p.polcmd in ('r','*')
    and p.polname<>'tenderdesk_application_identity_read'
    and exists(select 1 from unnest(p.polroles) role_id where case when role_id=0 then true else pg_has_role(app_role,role_id,'USAGE') end))
  THEN RAISE EXCEPTION 'APPLICATION_AUTH_POLICY_CONFLICT';END IF;
  SELECT * INTO policy_row FROM pg_policy WHERE polrelid=relation_id AND polname='tenderdesk_application_identity_read';
  IF FOUND THEN
   IF policy_row.polcmd<>'r' OR NOT policy_row.polpermissive OR policy_row.polroles IS DISTINCT FROM ARRAY[app_role]
    OR policy_row.polwithcheck IS NOT NULL OR pg_get_expr(policy_row.polqual,policy_row.polrelid) IS DISTINCT FROM 'true'
   THEN RAISE EXCEPTION 'APPLICATION_AUTH_POLICY_DRIFT';END IF;
  ELSE
   EXECUTE format('CREATE POLICY tenderdesk_application_identity_read ON auth.%I FOR SELECT TO %I USING (true)',target,__APP_ROLE__);
  END IF;
 END LOOP;
 SELECT jsonb_build_object(
  'tables',(select jsonb_agg(jsonb_build_object('id',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity) order by c.oid) from pg_class c where c.oid in ('auth.users'::regclass,'auth.identities'::regclass)),
  'columns',(select jsonb_agg(jsonb_build_object('relation',a.attrelid,'number',a.attnum,'acl',a.attacl) order by a.attrelid,a.attnum) from pg_attribute a where a.attrelid in ('auth.users'::regclass,'auth.identities'::regclass) and a.attnum>0 and not a.attisdropped),
  'roles',(select jsonb_agg(to_jsonb(r) order by r.oid) from pg_roles r),
  'memberships',(select coalesce(jsonb_agg(to_jsonb(r) order by r.roleid,r.member,r.grantor),'[]') from pg_auth_members r),
  'other_policies',(select coalesce(jsonb_agg(to_jsonb(p) order by p.oid),'[]') from pg_policy p where p.polrelid in ('auth.users'::regclass,'auth.identities'::regclass) and p.polname<>'tenderdesk_application_identity_read')
 ) INTO after_authority;
 IF before_authority IS DISTINCT FROM after_authority THEN RAISE EXCEPTION 'APPLICATION_AUTH_AUTHORITY_CHANGED';END IF;
END $auth_read_policy$;
RESET ROLE;
SET LOCAL ROLE __APP_IDENTIFIER__;
