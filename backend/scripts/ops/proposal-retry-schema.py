#!/usr/bin/env python3
"""One atomic retry-admission migration, chained to the deployed dispatch ledger.

No business command, model call, usage settlement or routing update is executed.
The original release rows remain historical evidence; the new exact catalog is
recorded separately and verified without changing any predecessor receipt.
"""
from __future__ import annotations
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE = ROOT / 'backend/supabase/migrations/20261108175251_generation_retry_modern_usage_scope.sql'
RELEASE = 'proposal-retry-modern-usage-v1-20261108'
PARENT_SQL = '0888f615c8ef705d5495a81c6f6afb756bda149dc636d4bfe0d90e1b8af64c4c'
PARENT_CATALOG = 'abe81b431bf33d6a75cf5e40d74d27a8e00858a6da125b3f8fb0d70a571b6992'
PARENT_STRUCTURE = '1857408e09aafebb5c826558f7abb0686431ba8454636db664e83fc2780016ce'
CHANGED = 'app_private.generation_command(text,jsonb,text)'
ADDED = 'app_private.assert_generation_retry_usage(public.generation_plans,text)'


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


parent = module('retry_parent_dispatch_schema', 'proposal-dispatch-schema.py')


class RetrySchemaError(Exception):
    pass


def require(value, code):
    if not value:
        raise RetrySchemaError('RETRY_SCHEMA_' + code)


def source():
    require(SOURCE.is_file() and not SOURCE.is_symlink(), 'SOURCE_MISSING')
    value = SOURCE.read_bytes().decode('utf-8')
    require(value.strip() and '$retry_schema_payload$' not in value and '$retry_schema_release$' not in value,
            'SOURCE_INVALID')
    return value


def source_sha256():
    return hashlib.sha256(source().encode()).hexdigest()


def sql_error_code(stderr):
    """Expose only fixed migration errors or the server's five-byte SQLSTATE.

    psql verbose diagnostics can contain full SQL and customer row values in
    DETAIL/CONTEXT. Never return those lines, object names, paths or raw stderr.
    """
    if not isinstance(stderr, str) or len(stderr.encode()) > 1024 * 1024:
        return 'RETRY_SCHEMA_SQL_FAILED'
    allowed = set(re.findall(r"RAISE EXCEPTION '([A-Z][A-Z0-9_]{0,119})'",
        Path(__file__).read_text() + (HERE / 'proposal-dispatch-schema.py').read_text() + source(), re.I))
    allowed = {value for value in allowed if re.fullmatch('[A-Z][A-Z0-9_]{0,119}', value)}
    errors = re.findall(r'(?:^|\n)[^\n]*?\b(?:ERROR|FATAL):\s+([0-9A-Z]{5}):\s*([^\r\n]*)', stderr)
    if not errors:
        return 'RETRY_SCHEMA_SQL_TRANSPORT_FAILED'
    state, message = errors[0]
    if message in allowed:
        return message
    return 'RETRY_SCHEMA_SQLSTATE_' + state


def execute_sql(database, sql):
    deploy = module('retry_schema_deploy', 'digitalocean-deploy.py')
    arguments = [os.environ['KUBECTL'], '--request-timeout=30s', 'exec', '-i', database.pod,
        '-n', deploy.NAMESPACE, '--', 'psql', '-X', '--quiet', '--no-align', '--tuples-only',
        '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose', '--dbname=' + deploy.DATABASE, '--file=-']
    try:
        result = subprocess.run(arguments, input=sql, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise RetrySchemaError('RETRY_SCHEMA_SQL_TRANSPORT_TIMEOUT') from None
    if result.returncode:
        raise RetrySchemaError(sql_error_code(result.stderr)) from None
    require(isinstance(result.stdout, str) and len(result.stdout.encode()) <= 16384, 'RESULT_SIZE')
    return result.stdout


CONTRACT = """
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('__ADDED__')
  AND proowner='tdp_app_owner'::regrole AND NOT prosecdef AND proconfig=ARRAY['search_path=""']::text[])
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=to_regprocedure('__ADDED__') AND
    (a.grantee<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.grantor<>p.proowner))
 THEN RAISE EXCEPTION 'RETRY_SCHEMA_HELPER_AUTHORITY';END IF;
 IF position('perform app_private.assert_generation_retry_usage(p,idempotency_key);'
   in pg_get_functiondef('__CHANGED__'::regprocedure))=0
 THEN RAISE EXCEPTION 'RETRY_SCHEMA_CALL_SITE_CHANGED';END IF;
"""


def script(*, read_only, allow_parent=False, payload=None):
    """Explicit payload is isolated fault injection; operational paths read SOURCE."""
    require(type(read_only) is bool and type(allow_parent) is bool and (read_only or not allow_parent), 'MODE')
    payload = source() if payload is None else payload
    require(isinstance(payload, str) and payload.strip() and '$retry_schema_payload$' not in payload
            and '$retry_schema_release$' not in payload, 'SOURCE_INVALID')
    checksum = hashlib.sha256(payload.encode()).hexdigest()
    protected = parent.structure_snapshot(protected=True).replace("public.k8s_claim_dispatch()", CHANGED)
    contract = parent.CONTRACT.replace('__SERVICE_FUNCTIONS__', parent.array(
        (parent.CHANGED_FUNCTION, parent.EXISTING_FUNCTIONS[-1], *parent.NEW_FUNCTIONS)))
    apply_sql = """
   IF to_regprocedure('__ADDED__') IS NOT NULL THEN RAISE EXCEPTION 'RETRY_SCHEMA_UNTRACKED_HELPER';END IF;
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
   __PROTECTED__ structure_before:=structure;
   SELECT to_jsonb(p)-'prosrc' INTO target_before FROM pg_proc p WHERE p.oid='__CHANGED__'::regprocedure;
   EXECUTE $retry_schema_payload$__PAYLOAD__$retry_schema_payload$;
   __ROWS__
   IF state IS DISTINCT FROM rows_before THEN RAISE EXCEPTION 'RETRY_SCHEMA_EXISTING_ROWS_CHANGED';END IF;
   __PROTECTED__
   IF structure IS DISTINCT FROM structure_before THEN RAISE EXCEPTION 'RETRY_SCHEMA_EXISTING_STRUCTURE_CHANGED';END IF;
   IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid='__CHANGED__'::regprocedure) IS DISTINCT FROM target_before
   THEN RAISE EXCEPTION 'RETRY_SCHEMA_COMMAND_ATTRIBUTES_CHANGED';END IF;
   IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname IN ('public','app_private') AND p.prokind='f' AND NOT p.oid=ANY(functions_before)
      AND p.oid<>'__ADDED__'::regprocedure)
    OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname IN ('public','app_private') AND NOT c.oid=ANY(relations_before))
    OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=ANY(relations_before) AND a.attnum>0
     AND NOT (a.attrelid::text||':'||a.attnum)=ANY(attributes_before))
   THEN RAISE EXCEPTION 'RETRY_SCHEMA_UNEXPECTED_ADDITION';END IF;
   __RETRY_CONTRACT__
   __CATALOG__
   __FULL_STRUCTURE__
   structure_hash:=encode(sha256(convert_to(structure::text,'UTF8')),'hex');
   INSERT INTO app_private.application_release_history(release,migration_sha256) VALUES
    ('__RELEASE__','__CHECKSUM__'),('__RELEASE__-catalog',catalog_hash),('__RELEASE__-structure',structure_hash);
   applied:=true;
"""
    if read_only:
        apply_sql = ("IF to_regprocedure('__ADDED__') IS NOT NULL THEN RAISE EXCEPTION 'RETRY_SCHEMA_UNTRACKED_HELPER';END IF;"
                     if allow_parent else "RAISE EXCEPTION 'RETRY_SCHEMA_RELEASE_MISSING';")
    sql = """BEGIN ISOLATION LEVEL REPEATABLE READ __READ_ONLY__;
SET LOCAL ROLE tdp_app_owner;SET LOCAL search_path=public;
SET LOCAL statement_timeout='20s';SET LOCAL lock_timeout='5s';
DO $retry_schema_release$
DECLARE r record;target text;saved_manifest text;saved_catalog text;saved_structure text;
 catalog_hash text;structure_hash text;row_count bigint;row_digest text;columns_before jsonb;
 relations_before oid[];functions_before oid[];attributes_before text[];state jsonb;rows_before jsonb;
 structure jsonb;structure_before jsonb;target_before jsonb;applied boolean:=false;
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'RETRY_SCHEMA_DATABASE_IDENTITY';END IF;
 __LOCK__
 IF to_regclass('app_private.application_release_history') IS NULL
  THEN RAISE EXCEPTION 'RETRY_SCHEMA_PARENT_LEDGER';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__BASE_RELEASE__' AND migration_sha256='__BASE_MANIFEST__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__PARENT_RELEASE__' AND migration_sha256='__PARENT_SQL__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__PARENT_RELEASE__-catalog' AND migration_sha256='__PARENT_CATALOG__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__PARENT_RELEASE__-structure' AND migration_sha256='__PARENT_STRUCTURE__')
 THEN RAISE EXCEPTION 'RETRY_SCHEMA_PARENT_LEDGER';END IF;
 IF to_regprocedure('__CHANGED__') IS NULL THEN RAISE EXCEPTION 'RETRY_SCHEMA_COMMAND_MISSING';END IF;
 SELECT migration_sha256 INTO saved_manifest FROM app_private.application_release_history WHERE release='__RELEASE__';
 SELECT migration_sha256 INTO saved_catalog FROM app_private.application_release_history WHERE release='__RELEASE__-catalog';
 SELECT migration_sha256 INTO saved_structure FROM app_private.application_release_history WHERE release='__RELEASE__-structure';
 IF (saved_manifest IS NULL)<>(saved_catalog IS NULL) OR (saved_manifest IS NULL)<>(saved_structure IS NULL)
 THEN RAISE EXCEPTION 'RETRY_SCHEMA_PARTIAL_RECEIPT';END IF;
 __CATALOG__
 __FULL_STRUCTURE__
 structure_hash:=encode(sha256(convert_to(structure::text,'UTF8')),'hex');
 IF saved_manifest IS NULL THEN
  IF catalog_hash<>'__PARENT_CATALOG__' OR structure_hash<>'__PARENT_STRUCTURE__'
  THEN RAISE EXCEPTION 'RETRY_SCHEMA_PARENT_CATALOG';END IF;
  __APPLY__
 ELSE
  IF saved_manifest<>'__CHECKSUM__' THEN RAISE EXCEPTION 'RETRY_SCHEMA_SOURCE_CHANGED';END IF;
  IF catalog_hash IS DISTINCT FROM saved_catalog OR structure_hash IS DISTINCT FROM saved_structure
  THEN RAISE EXCEPTION 'RETRY_SCHEMA_POST_CATALOG_CHANGED';END IF;
  __RETRY_CONTRACT__
  applied:=true;
 END IF;
 __DISPATCH_CONTRACT__
 PERFORM set_config('tenderdesk.retry_schema_receipt',jsonb_build_object('release','__RELEASE__',
  'sql_sha256','__CHECKSUM__','parent_release','__PARENT_RELEASE__','parent_sql_sha256','__PARENT_SQL__',
  'catalog_sha256',catalog_hash,'structure_sha256',structure_hash,'applied',applied,
  'replayed',saved_manifest IS NOT NULL,'read_only',__READ_ONLY_JSON__,
  'predecessor_receipts_preserved',true,'business_rows_changed',0,'processing_requested',false)::text,true);
END $retry_schema_release$;
SELECT current_setting('tenderdesk.retry_schema_receipt');
__NOTIFY__
COMMIT;
"""
    for key, value in {
        '__READ_ONLY__': 'READ ONLY' if read_only else '', '__READ_ONLY_JSON__': 'true' if read_only else 'false',
        '__LOCK__': '' if read_only else "PERFORM pg_advisory_xact_lock(hashtextextended('tenderdesk.retry-schema.release',0));",
        '__APPLY__': apply_sql, '__ROWS__': parent.ROWS, '__PROTECTED__': protected,
        '__RETRY_CONTRACT__': CONTRACT, '__DISPATCH_CONTRACT__': contract,
        '__CATALOG__': parent.CATALOG, '__FULL_STRUCTURE__': parent.structure_snapshot(protected=False),
        '__BASE_RELEASE__': parent.BASE_RELEASE, '__BASE_MANIFEST__': parent.BASE_MANIFEST,
        '__PARENT_RELEASE__': parent.RELEASE, '__PARENT_SQL__': PARENT_SQL,
        '__PARENT_CATALOG__': PARENT_CATALOG, '__PARENT_STRUCTURE__': PARENT_STRUCTURE,
        '__RELEASE__': RELEASE, '__CHECKSUM__': checksum, '__CHANGED__': CHANGED, '__ADDED__': ADDED,
        '__PAYLOAD__': payload, '__NOTIFY__': '' if read_only else "NOTIFY pgrst,'reload schema';",
    }.items():
        sql = sql.replace(key, value)
    require(not re.search(r'__[A-Z_]+__', sql), 'TEMPLATE_INVALID')
    return sql


def run(database, *, read_only, allow_parent=False):
    raw = execute_sql(database, script(read_only=read_only, allow_parent=allow_parent))
    require(len(raw.encode()) <= 16384, 'RESULT_SIZE')
    value = json.loads(raw)
    require(isinstance(value, dict) and value.get('release') == RELEASE
        and value.get('sql_sha256') == source_sha256() and value.get('parent_release') == parent.RELEASE
        and value.get('parent_sql_sha256') == PARENT_SQL and value.get('read_only') is read_only
        and type(value.get('applied')) is bool and (value['applied'] or allow_parent)
        and type(value.get('replayed')) is bool and value.get('predecessor_receipts_preserved') is True
        and value.get('business_rows_changed') == 0 and value.get('processing_requested') is False
        and all(isinstance(value.get(key), str) and re.fullmatch('[a-f0-9]{64}', value[key])
                for key in ('catalog_sha256', 'structure_sha256')), 'RESULT_INVALID')
    return value


def apply(database):
    return run(database, read_only=False)


def verify(database, *, allow_parent=False):
    return run(database, read_only=True, allow_parent=allow_parent)


def row_digest_probe_sql():
    return """BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;SET LOCAL search_path=public;
SET LOCAL statement_timeout='20s';SET LOCAL lock_timeout='5s';
DO $retry_row_probe$
DECLARE r record;columns_before jsonb;state jsonb;row_count bigint;row_digest text;
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'RETRY_SCHEMA_DATABASE_IDENTITY';END IF;
 SELECT jsonb_object_agg(signature,cols) INTO columns_before FROM (
  SELECT format('%I.%I',n.nspname,c.relname) signature,string_agg(quote_ident(a.attname),',' ORDER BY a.attnum) cols
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
  WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
  GROUP BY n.nspname,c.relname)t;
 __ROWS__
END $retry_row_probe$;
SELECT '{"completed":true}'::jsonb;
ROLLBACK;
""".replace('__ROWS__', parent.ROWS)


def row_digest_probe(database):
    """Read the same existing row digests; emit duration/code only, no digests."""
    started = time.monotonic()
    try:
        raw = execute_sql(database, row_digest_probe_sql())
        try:
            value = json.loads(raw)
        except (ValueError, TypeError):
            raise RetrySchemaError('RETRY_SCHEMA_ROW_PROBE_INVALID') from None
        require(value == {'completed': True}, 'ROW_PROBE_INVALID')
        result = {'probe': 'existing_full_row_digest', 'completed': True, 'code': None}
    except RetrySchemaError as error:
        result = {'probe': 'existing_full_row_digest', 'completed': False, 'code': str(error)}
    return result | {'duration_seconds': round(time.monotonic() - started, 3), 'read_only': True}
