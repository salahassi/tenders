#!/usr/bin/env python3
"""Apply only the reviewed, backward-compatible Kubernetes dispatch adaptation.

The caller owns original-CA access and its temporary SQL client. This module
never configures a dispatcher, claims work, changes providers, or retries jobs.
An image rollback deliberately retains this additive, legacy-compatible schema.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE = ROOT / "backend/scripts/runtime/dispatcher.sql"
RELEASE = "proposal-dispatch-v2-20261108"
BASE_RELEASE = "proposal-delivery-reliability-v1"
BASE_MANIFEST = "ada21f57461fa81e3b45778685d86438117ef419ad8c31ceaac86c06dcb2dba3"
BASE_CATALOG = "8f82c88194713bff62224f307d8ab6744a42f4d7fa57a3559fafc4d083cddc04"
SERVICE_ROLE = "tdp_app_service"
NEW_TABLE = "app_private.k8s_maintenance_queue"
TIMER_TABLE = "app_private.k8s_dispatch_timers"
OLD_TABLE = "app_private.k8s_dispatch_queue"
CHANGED_FUNCTION = "public.k8s_claim_dispatch()"
NEW_FUNCTIONS = (
    "public.k8s_finish_dispatch_v2(uuid,bigint,boolean,boolean,integer)",
    "public.k8s_claim_maintenance()",
    "public.k8s_finish_maintenance(uuid,bigint,boolean)",
)
EXISTING_FUNCTIONS = (
    "app_private.dispatch_backend()", "public.configure_dispatcher(text,text[])",
    CHANGED_FUNCTION, "public.k8s_finish_dispatch(uuid,bigint,boolean)",
)


class SchemaError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise SchemaError("DISPATCH_SCHEMA_" + code)


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def array(values):
    return "ARRAY[" + ",".join(literal(value) for value in values) + "]::text[]"


def verified_source(expected_sql_sha256):
    require(isinstance(expected_sql_sha256, str) and
            re.fullmatch("[a-f0-9]{64}", expected_sql_sha256), "SOURCE_HASH_INVALID")
    require(SOURCE.is_file() and not SOURCE.is_symlink(), "SOURCE_MISSING")
    data = SOURCE.read_bytes()
    require(hashlib.sha256(data).hexdigest() == expected_sql_sha256, "SOURCE_CHANGED")
    return data.decode("utf-8")


# Keep the same public-schema visibility as the retained inventory/release
# catalog: public signatures are unqualified, app_private signatures qualified.
CATALOG = """SELECT encode(sha256(convert_to(coalesce(string_agg(
 p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid)||':'||coalesce(p.proacl::text,''),E'\\n'
 ORDER BY p.oid::regprocedure::text),''),'UTF8')),'hex') INTO catalog_hash
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','app_private') AND p.prokind='f';"""

ROWS = """state:='{}'::jsonb;
 FOR r IN SELECT key,value FROM jsonb_each_text(columns_before) LOOP
  EXECUTE format('SELECT count(*)::bigint,md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM (SELECT %s FROM %s) x',r.value,r.key)
   INTO row_count,row_digest;
  state:=state||jsonb_build_object(r.key,jsonb_build_object('count',row_count,'digest',row_digest));
 END LOOP;"""


def structure_snapshot(*, protected):
    """Catalog metadata only; runtime counters and live row values are excluded."""
    relations = "c.oid=ANY(relations_before)" if protected else "n.nspname IN ('public','app_private')"
    functions = "p.oid=ANY(functions_before)" if protected else "n.nspname IN ('public','app_private') AND p.prokind='f'"
    columns = "AND (a.attrelid::text||':'||a.attnum)=ANY(attributes_before)" if protected else ""
    function_body = ("CASE WHEN p.oid=to_regprocedure('public.k8s_claim_dispatch()') THEN NULL "
                     "ELSE md5(pg_get_functiondef(p.oid)) END") if protected else "md5(pg_get_functiondef(p.oid))"
    return """SELECT jsonb_build_object(
 'relations',(SELECT coalesce(jsonb_agg(jsonb_build_object('oid',c.oid,'name',c.relname,'kind',c.relkind,
  'namespace',n.nspname,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
  'options',c.reloptions,'persistence',c.relpersistence) ORDER BY c.oid),'[]')
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE __RELATIONS__),
 'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',a.attrelid,'column',to_jsonb(a),
  'default',pg_get_expr(def.adbin,def.adrelid)) ORDER BY a.attrelid,a.attnum),'[]')
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_attrdef def ON def.adrelid=a.attrelid AND def.adnum=a.attnum
  WHERE __RELATIONS__ AND a.attnum>0 __COLUMNS__),
 'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',con.conrelid,'name',con.conname,
  'definition',pg_get_constraintdef(con.oid),'validated',con.convalidated) ORDER BY con.conrelid,con.conname),'[]')
  FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE __RELATIONS__),
 'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',i.indrelid,'definition',pg_get_indexdef(i.indexrelid))
  ORDER BY i.indrelid,i.indexrelid),'[]') FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE __RELATIONS__),
 'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',t.tgrelid,'name',t.tgname,'enabled',t.tgenabled,
  'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname),'[]') FROM pg_trigger t
  JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE __RELATIONS__ AND NOT t.tgisinternal),
 'policies',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.polrelid,p.polname),'[]') FROM pg_policy p
  JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE __RELATIONS__),
 'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('oid',p.oid,'owner',p.proowner,'acl',p.proacl,
  'definer',p.prosecdef,'config',p.proconfig,'body',__FUNCTION_BODY__) ORDER BY p.oid),'[]') FROM pg_proc p
  JOIN pg_namespace n ON n.oid=p.pronamespace WHERE __FUNCTIONS__),
 'roles',(SELECT jsonb_agg(to_jsonb(role_row) ORDER BY role_row.rolname) FROM pg_roles role_row),
 'memberships',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor),'[]') FROM pg_auth_members m)
 ) INTO structure;""".replace("__RELATIONS__", relations).replace("__COLUMNS__", columns).replace(
        "__FUNCTIONS__", functions).replace("__FUNCTION_BODY__", function_body)


CONTRACT = """
 FOREACH target IN ARRAY __SERVICE_FUNCTIONS__ LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(target)
    AND proowner='tdp_app_owner'::regrole AND prosecdef AND proconfig=ARRAY['search_path=""']::text[])
   OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=to_regprocedure(target) AND
     (a.grantee NOT IN (p.proowner,'tdp_app_service'::regrole) OR a.privilege_type<>'EXECUTE'
      OR (a.grantee='tdp_app_service'::regrole AND (a.is_grantable OR a.grantor<>p.proowner))))
   OR NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=to_regprocedure(target) AND a.grantee='tdp_app_service'::regrole AND a.privilege_type='EXECUTE')
  THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_RPC_AUTHORITY';END IF;
 END LOOP;
 FOREACH target IN ARRAY ARRAY['app_private.k8s_dispatch_queue','app_private.k8s_maintenance_queue','app_private.k8s_dispatch_timers'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass(target) AND relkind='r'
    AND relowner='tdp_app_owner'::regrole AND relrowsecurity AND NOT relforcerowsecurity)
   OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid=to_regclass(target) AND a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl
    WHERE a.attrelid=to_regclass(target) AND acl.grantee<>'tdp_app_owner'::regrole)
   OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass(target))
  THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_TABLE_AUTHORITY';END IF;
 END LOOP;
 IF (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
     WHERE a.attrelid='app_private.k8s_dispatch_timers'::regclass AND a.attnum>0 AND NOT a.attisdropped)
     IS DISTINCT FROM ARRAY['dispatch_lease','due_at']::text[]
  OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='app_private.k8s_dispatch_timers'::regclass
   AND attname='dispatch_lease' AND atttypid='uuid'::regtype AND attnotnull)
  OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='app_private.k8s_dispatch_timers'::regclass
   AND attname='due_at' AND atttypid='timestamptz'::regtype AND attnotnull)
  OR (SELECT count(*) FROM pg_constraint WHERE conrelid='app_private.k8s_dispatch_timers'::regclass AND contype<>'n')<>1
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='app_private.k8s_dispatch_timers'::regclass
   AND contype='p' AND conkey=ARRAY[1]::smallint[])
  OR NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid='app_private.k8s_dispatch_timers'::regclass
   AND indisvalid AND indkey::text='2' AND indpred IS NULL)
 THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_TIMER_STRUCTURE';END IF;
 IF (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
     WHERE a.attrelid='app_private.k8s_maintenance_queue'::regclass AND a.attnum>0 AND NOT a.attisdropped)
     IS DISTINCT FROM ARRAY['singleton','generation','lease_token','lease_until','next_attempt_at','failures']::text[]
  OR (SELECT count(*) FROM pg_constraint WHERE conrelid='app_private.k8s_maintenance_queue'::regclass AND contype<>'n')<>4
 THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_MAINTENANCE_STRUCTURE';END IF;
"""


def script(expected_sql_sha256, *, read_only=False, source=None):
    # The optional explicit source exists for isolated fault-injection tests;
    # both operational entry points always read and hash the repository file.
    if source is None:
        source = verified_source(expected_sql_sha256)
    require(isinstance(source, str) and source.strip() and
            hashlib.sha256(source.encode()).hexdigest() == expected_sql_sha256, "SOURCE_CHANGED")
    require(source.count(':"service_role"') == 5, "SERVICE_BINDING_CHANGED")
    payload = source.replace(':"service_role"', '"' + SERVICE_ROLE + '"')
    delimiter = "$dispatch_schema_payload$"
    require(delimiter not in payload and "$dispatch_schema_release$" not in payload, "PAYLOAD_DELIMITER")
    initialization = """
  IF catalog_hash<>'__BASE_CATALOG__' THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_BASELINE_CATALOG';END IF;
  IF to_regclass('app_private.k8s_maintenance_queue') IS NOT NULL
   OR to_regclass('app_private.k8s_dispatch_timers') IS NOT NULL
   OR EXISTS(SELECT 1 FROM unnest(__NEW_FUNCTIONS__) f WHERE to_regprocedure(f) IS NOT NULL)
  THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_UNTRACKED_ADDITION';END IF;
  SELECT jsonb_object_agg(signature,cols) INTO columns_before FROM (
   SELECT format('%I.%I',n.nspname,c.relname) signature,string_agg(quote_ident(a.attname),',' ORDER BY a.attnum) cols
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
   WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
   GROUP BY n.nspname,c.relname)t;
  SELECT array_agg(c.oid) INTO relations_before FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','app_private');
  SELECT array_agg(p.oid) INTO functions_before FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN ('public','app_private') AND p.prokind='f';
  SELECT array_agg(a.attrelid::text||':'||a.attnum) INTO attributes_before FROM pg_attribute a
   WHERE a.attrelid=ANY(relations_before) AND a.attnum>0;
  __ROWS__ rows_before:=state;
  __PROTECTED_STRUCTURE__ structure_before:=structure;
  EXECUTE __DELIMITER____PAYLOAD____DELIMITER__;
  __ROWS__
  IF state IS DISTINCT FROM rows_before THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_EXISTING_ROWS_CHANGED';END IF;
  __PROTECTED_STRUCTURE__
  IF structure IS DISTINCT FROM structure_before THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_EXISTING_STRUCTURE_CHANGED';END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','app_private') AND p.prokind='f' AND NOT p.oid=ANY(functions_before)
     AND NOT p.oid=ANY(ARRAY(SELECT to_regprocedure(f)::oid FROM unnest(__NEW_FUNCTIONS__) f)))
   OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','app_private') AND NOT c.oid=ANY(relations_before)
     AND c.oid NOT IN ('app_private.k8s_maintenance_queue'::regclass,'app_private.k8s_dispatch_timers'::regclass)
     AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=c.oid
      AND i.indrelid IN ('app_private.k8s_maintenance_queue'::regclass,'app_private.k8s_dispatch_timers'::regclass)))
   OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=ANY(relations_before) AND a.attnum>0
    AND NOT (a.attrelid::text||':'||a.attnum)=ANY(attributes_before))
  THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_UNEXPECTED_ADDITION';END IF;
  IF EXISTS(SELECT 1 FROM app_private.k8s_dispatch_timers)
   OR (SELECT count(*) FROM app_private.k8s_maintenance_queue)<>1
   OR EXISTS(SELECT 1 FROM app_private.k8s_maintenance_queue WHERE NOT singleton OR generation<>0
    OR lease_token IS NOT NULL OR lease_until IS NOT NULL OR next_attempt_at<>'-infinity' OR failures<>0)
  THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_INITIAL_STATE_CHANGED';END IF;
  __CATALOG__
  __FULL_STRUCTURE__
  structure_hash:=encode(sha256(convert_to(structure::text,'UTF8')),'hex');
  INSERT INTO app_private.application_release_history(release,migration_sha256) VALUES
   ('__RELEASE__','__CHECKSUM__'),('__RELEASE__-catalog',catalog_hash),('__RELEASE__-structure',structure_hash);
"""
    if read_only:
        initialization = "RAISE EXCEPTION 'DISPATCH_SCHEMA_RELEASE_MISSING';"
    value = """BEGIN ISOLATION LEVEL REPEATABLE READ __READ_ONLY__;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL search_path=public;
SET LOCAL statement_timeout='20s';SET LOCAL lock_timeout='5s';
DO $dispatch_schema_release$
DECLARE r record; target text; saved_manifest text; saved_catalog text; saved_structure text;
 catalog_hash text; structure_hash text; row_count bigint; row_digest text; columns_before jsonb;
 relations_before oid[]; functions_before oid[]; attributes_before text[]; state jsonb; rows_before jsonb;
 structure jsonb; structure_before jsonb;
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_DATABASE_IDENTITY';END IF;
 __LOCK__
 IF to_regclass('app_private.application_release_history') IS NULL
  THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_BASELINE_LEDGER';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__BASE_RELEASE__' AND migration_sha256='__BASE_MANIFEST__')
  THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_BASELINE_LEDGER';END IF;
 FOREACH target IN ARRAY __EXISTING_FUNCTIONS__ LOOP
  IF to_regprocedure(target) IS NULL THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_BASELINE_ROUTINE';END IF;
 END LOOP;
 SELECT migration_sha256 INTO saved_manifest FROM app_private.application_release_history WHERE release='__RELEASE__';
 SELECT migration_sha256 INTO saved_catalog FROM app_private.application_release_history WHERE release='__RELEASE__-catalog';
 SELECT migration_sha256 INTO saved_structure FROM app_private.application_release_history WHERE release='__RELEASE__-structure';
 IF (saved_manifest IS NULL)<>(saved_catalog IS NULL) OR (saved_manifest IS NULL)<>(saved_structure IS NULL)
  THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_PARTIAL_RECEIPT';END IF;
 __CATALOG__
 IF saved_manifest IS NULL THEN
  __INITIALIZATION__
 ELSE
  IF saved_manifest<>'__CHECKSUM__' THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_RECEIPT_CHECKSUM';END IF;
  __FULL_STRUCTURE__
  structure_hash:=encode(sha256(convert_to(structure::text,'UTF8')),'hex');
  IF saved_catalog IS DISTINCT FROM catalog_hash OR saved_structure IS DISTINCT FROM structure_hash
   THEN RAISE EXCEPTION 'DISPATCH_SCHEMA_POST_CATALOG_CHANGED';END IF;
 END IF;
 __CONTRACT__
 PERFORM set_config('tenderdesk.dispatch_schema_receipt',jsonb_build_object('release','__RELEASE__',
  'sql_sha256','__CHECKSUM__','catalog_sha256',catalog_hash,'structure_sha256',structure_hash,
  'replayed',saved_manifest IS NOT NULL,'read_only',__READ_ONLY_JSON__,'legacy_finish_retained',true,
  'business_rows_changed',0,'processing_requested',false)::text,true);
END $dispatch_schema_release$;
SELECT current_setting('tenderdesk.dispatch_schema_receipt');
__NOTIFY__
COMMIT;
"""
    replacements = {
        "__READ_ONLY__": "READ ONLY" if read_only else "",
        "__READ_ONLY_JSON__": "true" if read_only else "false",
        "__LOCK__": "" if read_only else "PERFORM pg_advisory_xact_lock(hashtextextended('tenderdesk.dispatch-schema.release',0));",
        "__INITIALIZATION__": initialization, "__CONTRACT__": CONTRACT,
        "__ROWS__": ROWS, "__PROTECTED_STRUCTURE__": structure_snapshot(protected=True),
        "__FULL_STRUCTURE__": structure_snapshot(protected=False), "__CATALOG__": CATALOG,
        "__BASE_RELEASE__": BASE_RELEASE, "__BASE_MANIFEST__": BASE_MANIFEST,
        "__BASE_CATALOG__": BASE_CATALOG, "__RELEASE__": RELEASE, "__CHECKSUM__": expected_sql_sha256,
        "__EXISTING_FUNCTIONS__": array(EXISTING_FUNCTIONS), "__NEW_FUNCTIONS__": array(NEW_FUNCTIONS),
        "__SERVICE_FUNCTIONS__": array((CHANGED_FUNCTION, EXISTING_FUNCTIONS[-1], *NEW_FUNCTIONS)),
        "__DELIMITER__": delimiter, "__PAYLOAD__": payload,
        "__NOTIFY__": "" if read_only else "NOTIFY pgrst,'reload schema';",
    }
    for key, replacement in replacements.items():
        value = value.replace(key, replacement)
    require(not re.search(r"__[A-Z_]+__", value), "UNRESOLVED_TEMPLATE")
    return value


def execute_sql(client, sql):
    spec = importlib.util.spec_from_file_location("dispatch_schema_deploy", HERE / "digitalocean-deploy.py")
    deploy = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = deploy
    spec.loader.exec_module(deploy)
    return deploy.sql(client.pod, sql)


def run(client, expected_sql_sha256, *, read_only):
    value = json.loads(execute_sql(client, script(expected_sql_sha256, read_only=read_only)))
    require(isinstance(value, dict) and value.get("release") == RELEASE and
            value.get("sql_sha256") == expected_sql_sha256 and
            value.get("read_only") is read_only and value.get("legacy_finish_retained") is True and
            value.get("business_rows_changed") == 0 and value.get("processing_requested") is False and
            all(re.fullmatch("[a-f0-9]{64}", value.get(key, "")) for key in ("catalog_sha256", "structure_sha256")),
            "RESULT_INVALID")
    return value


def apply(client, expected_sql_sha256):
    return run(client, expected_sql_sha256, read_only=False)


def verify(client, expected_sql_sha256):
    return run(client, expected_sql_sha256, read_only=True)
