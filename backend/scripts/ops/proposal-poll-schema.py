#!/usr/bin/env python3
"""One additive accepted-poll RPC, chained to the deployed admission ledger.

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

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE = ROOT / 'backend/supabase/migrations/20261108194639_prepare_accepted_model_poll.sql'
RELEASE = 'proposal-pending-poll-v1-20261108'
SOURCE_SHA256 = '8d089d8d5237fa96e4903ddc54724318afeaeb457737341e88d7e872f49341af'
PARENT_SQL = 'fcde6425b740a60ea9001a4abefea960a4bbe461e3ec27dae70f2099f2f06562'
PARENT_CATALOG = '28dc9a60c90e6d3dd33550fb37638bf1e7a2f2b1349535a0d381fa339c1b0c1a'
PARENT_STRUCTURE = '4ede33bb5c61761c997c85d37ef2afa645ba503c8220e022db77c359b7f23312'
ADDED = 'public.prepare_accepted_model_poll(uuid,uuid,text,text,jsonb)'


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


parent = module('poll_parent_admission_schema', 'proposal-admission-schema.py')
latency = parent.parent
retry = parent.retry
base = parent.base


class PollSchemaError(Exception):
    pass


def require(value, code):
    if not value:
        raise PollSchemaError('POLL_SCHEMA_' + code)


def source():
    require(isinstance(SOURCE_SHA256,str) and re.fullmatch('[a-f0-9]{64}',SOURCE_SHA256), 'NOT_FROZEN')
    require(SOURCE.is_file() and not SOURCE.is_symlink(), 'SOURCE_MISSING')
    raw = SOURCE.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == SOURCE_SHA256, 'SOURCE_CHANGED')
    value = raw.decode('utf-8')
    require(value.strip() and '$poll_schema_payload$' not in value and '$poll_schema_release$' not in value,
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
        return 'POLL_SCHEMA_SQL_FAILED'
    allowed = set(re.findall(r"RAISE EXCEPTION '([A-Z][A-Z0-9_]{0,119})'",
        Path(__file__).read_text() + (HERE / 'proposal-dispatch-schema.py').read_text() + (HERE / 'proposal-retry-schema.py').read_text() + (HERE / 'proposal-latency-schema.py').read_text() + (HERE / 'proposal-admission-schema.py').read_text() + source(), re.I))
    allowed = {value for value in allowed if re.fullmatch('[A-Z][A-Z0-9_]{0,119}', value)}
    errors = re.findall(r'(?:^|\n)[^\n]*?\b(?:ERROR|FATAL):\s+([0-9A-Z]{5}):\s*([^\r\n]*)', stderr)
    if not errors:
        return 'POLL_SCHEMA_SQL_TRANSPORT_FAILED'
    state, message = errors[0]
    if message in allowed:
        return message
    return 'POLL_SCHEMA_SQLSTATE_' + state


def execute_sql(database, sql):
    deploy = module('poll_schema_deploy', 'digitalocean-deploy.py')
    arguments = [os.environ['KUBECTL'], '--request-timeout=30s', 'exec', '-i', database.pod,
        '-n', deploy.NAMESPACE, '--', 'psql', '-X', '--quiet', '--no-align', '--tuples-only',
        '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose', '--dbname=' + deploy.DATABASE, '--file=-']
    try:
        result = subprocess.run(arguments, input=sql, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise PollSchemaError('POLL_SCHEMA_SQL_TRANSPORT_TIMEOUT') from None
    if result.returncode:
        raise PollSchemaError(sql_error_code(result.stderr)) from None
    require(isinstance(result.stdout, str) and len(result.stdout.encode()) <= 16384, 'RESULT_SIZE')
    return result.stdout


CONTRACT = """
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
  WHERE p.oid=to_regprocedure('__ADDED__') AND p.proowner='tdp_app_owner'::regrole
   AND p.prosecdef AND p.proconfig=ARRAY['search_path=""']::text[] AND l.lanname='plpgsql'
   AND p.prorettype='jsonb'::regtype AND p.prokind='f' AND p.provolatile='v' AND p.proparallel='u'
   AND NOT p.proisstrict AND p.proargmodes IS NULL)
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=to_regprocedure('__ADDED__') AND (a.privilege_type<>'EXECUTE'
    OR a.grantee NOT IN(SELECT oid FROM pg_roles WHERE rolname IN ('tdp_app_owner','tdp_app_service','service_role'))
    OR (a.grantee<>p.proowner AND (a.is_grantable OR a.grantor<>p.proowner))))
  OR EXISTS(SELECT 1 FROM pg_roles role_row WHERE role_row.rolname IN ('tdp_app_service','service_role') AND NOT EXISTS(
   SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=to_regprocedure('__ADDED__') AND a.grantee=role_row.oid AND a.privilege_type='EXECUTE'))
 THEN RAISE EXCEPTION 'POLL_SCHEMA_RPC_AUTHORITY';END IF;
"""


ROW_ACTIVITY = parent.ROW_ACTIVITY.replace('ADMISSION_SCHEMA_', 'POLL_SCHEMA_')


def script(*, read_only, allow_parent=False, payload=None):
    """Explicit payload is isolated fault injection; operational paths read SOURCE."""
    require(type(read_only) is bool and type(allow_parent) is bool and (read_only or not allow_parent), 'MODE')
    require(parent.source_sha256() == PARENT_SQL, 'PARENT_SOURCE_CHANGED')
    canonical = source()
    payload = canonical if payload is None else payload
    require(isinstance(payload, str) and payload.strip() and '$poll_schema_payload$' not in payload
            and '$poll_schema_release$' not in payload, 'SOURCE_INVALID')
    checksum = hashlib.sha256(payload.encode()).hexdigest()
    # Optimize only the exact reviewed additive RPC. Arbitrary
    # fault payloads retain the original full-row proof as well as activity
    # counters; this is not a generic relaxation of migration protections.
    full_rows = '' if payload == canonical else base.ROWS
    protected = base.structure_snapshot(protected=True).replace("to_regprocedure('public.k8s_claim_dispatch()')", '0::oid')
    contract = base.CONTRACT.replace('__SERVICE_FUNCTIONS__', base.array(
        (base.CHANGED_FUNCTION, base.EXISTING_FUNCTIONS[-1], *base.NEW_FUNCTIONS)))
    contract += retry.CONTRACT.replace('__ADDED__', retry.ADDED).replace('__CHANGED__', retry.CHANGED)
    contract += latency.CONTRACT.replace('__CHANGED__', latency.CHANGED)
    contract += parent.CONTRACT.replace('__CHANGED__', parent.CHANGED)
    apply_sql = """
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
   __ROW_ACTIVITY__ row_activity_before:=row_activity;
   __ROWS__ rows_before:=state;
   __PROTECTED__ structure_before:=structure;
   -- The protected snapshot already hashes every existing routine body.
   SELECT jsonb_object_agg(p.oid::text,to_jsonb(p)-'prosrc') INTO routines_before FROM pg_proc p WHERE p.oid=ANY(functions_before);
   EXECUTE $poll_schema_payload$__PAYLOAD__$poll_schema_payload$;
   __ROW_ACTIVITY__
   IF row_activity IS DISTINCT FROM row_activity_before
   THEN RAISE EXCEPTION 'POLL_SCHEMA_EXISTING_ROWS_CHANGED';END IF;
   __ROWS__
   IF state IS DISTINCT FROM rows_before THEN RAISE EXCEPTION 'POLL_SCHEMA_EXISTING_ROWS_CHANGED';END IF;
   __PROTECTED__
   IF structure IS DISTINCT FROM structure_before THEN RAISE EXCEPTION 'POLL_SCHEMA_EXISTING_STRUCTURE_CHANGED';END IF;
   IF (SELECT jsonb_object_agg(p.oid::text,to_jsonb(p)-'prosrc') FROM pg_proc p WHERE p.oid=ANY(functions_before)) IS DISTINCT FROM routines_before
   THEN RAISE EXCEPTION 'POLL_SCHEMA_EXISTING_ROUTINES_CHANGED';END IF;
   IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname IN ('public','app_private') AND p.prokind='f' AND NOT p.oid=ANY(functions_before)
      AND p.oid IS DISTINCT FROM to_regprocedure('__ADDED__'))
    OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname IN ('public','app_private') AND NOT c.oid=ANY(relations_before))
    OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=ANY(relations_before) AND a.attnum>0
     AND NOT (a.attrelid::text||':'||a.attnum)=ANY(attributes_before))
   THEN RAISE EXCEPTION 'POLL_SCHEMA_UNEXPECTED_ADDITION';END IF;
   __RETRY_CONTRACT__
   __CATALOG__
   __FULL_STRUCTURE__
   structure_hash:=encode(sha256(convert_to(structure::text,'UTF8')),'hex');
   INSERT INTO app_private.application_release_history(release,migration_sha256) VALUES
    ('__RELEASE__','__CHECKSUM__'),('__RELEASE__-catalog',catalog_hash),('__RELEASE__-structure',structure_hash);
   applied:=true;
"""
    if read_only:
        apply_sql = 'NULL;' if allow_parent else "RAISE EXCEPTION 'POLL_SCHEMA_RELEASE_MISSING';"
    sql = """BEGIN ISOLATION LEVEL REPEATABLE READ __READ_ONLY__;
SET LOCAL ROLE tdp_app_owner;SET LOCAL search_path=public;
SET LOCAL statement_timeout='20s';SET LOCAL lock_timeout='5s';
DO $poll_schema_release$
DECLARE r record;target text;saved_manifest text;saved_catalog text;saved_structure text;
 catalog_hash text;structure_hash text;row_count bigint;row_digest text;columns_before jsonb;
 relations_before oid[];functions_before oid[];attributes_before text[];state jsonb;rows_before jsonb;
 structure jsonb;structure_before jsonb;routines_before jsonb;row_activity jsonb;row_activity_before jsonb;applied boolean:=false;
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'POLL_SCHEMA_DATABASE_IDENTITY';END IF;
 __LOCK__
 IF to_regclass('app_private.application_release_history') IS NULL
  THEN RAISE EXCEPTION 'POLL_SCHEMA_PARENT_LEDGER';END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__BASE_RELEASE__' AND migration_sha256='__BASE_MANIFEST__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__DISPATCH_RELEASE__' AND migration_sha256='__DISPATCH_SQL__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__DISPATCH_RELEASE__-catalog' AND migration_sha256='__DISPATCH_CATALOG__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__DISPATCH_RELEASE__-structure' AND migration_sha256='__DISPATCH_STRUCTURE__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__RETRY_RELEASE__' AND migration_sha256='__RETRY_SQL__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__RETRY_RELEASE__-catalog' AND migration_sha256='__RETRY_CATALOG__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__RETRY_RELEASE__-structure' AND migration_sha256='__RETRY_STRUCTURE__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__LATENCY_RELEASE__' AND migration_sha256='__LATENCY_SQL__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__LATENCY_RELEASE__-catalog' AND migration_sha256='__LATENCY_CATALOG__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__LATENCY_RELEASE__-structure' AND migration_sha256='__LATENCY_STRUCTURE__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__PARENT_RELEASE__' AND migration_sha256='__PARENT_SQL__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__PARENT_RELEASE__-catalog' AND migration_sha256='__PARENT_CATALOG__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__PARENT_RELEASE__-structure' AND migration_sha256='__PARENT_STRUCTURE__')
 THEN RAISE EXCEPTION 'POLL_SCHEMA_PARENT_LEDGER';END IF;
 SELECT migration_sha256 INTO saved_manifest FROM app_private.application_release_history WHERE release='__RELEASE__';
 SELECT migration_sha256 INTO saved_catalog FROM app_private.application_release_history WHERE release='__RELEASE__-catalog';
 SELECT migration_sha256 INTO saved_structure FROM app_private.application_release_history WHERE release='__RELEASE__-structure';
 IF (saved_manifest IS NULL)<>(saved_catalog IS NULL) OR (saved_manifest IS NULL)<>(saved_structure IS NULL)
 THEN RAISE EXCEPTION 'POLL_SCHEMA_PARTIAL_RECEIPT';END IF;
 __CATALOG__
 __FULL_STRUCTURE__
 structure_hash:=encode(sha256(convert_to(structure::text,'UTF8')),'hex');
 IF saved_manifest IS NULL THEN
  IF to_regprocedure('__ADDED__') IS NOT NULL THEN RAISE EXCEPTION 'POLL_SCHEMA_UNLEDGERED_RPC';END IF;
  IF catalog_hash<>'__PARENT_CATALOG__' OR structure_hash<>'__PARENT_STRUCTURE__'
  THEN RAISE EXCEPTION 'POLL_SCHEMA_PARENT_CATALOG';END IF;
  __APPLY__
 ELSE
  IF saved_manifest<>'__CHECKSUM__' THEN RAISE EXCEPTION 'POLL_SCHEMA_SOURCE_CHANGED';END IF;
  IF catalog_hash IS DISTINCT FROM saved_catalog OR structure_hash IS DISTINCT FROM saved_structure
  THEN RAISE EXCEPTION 'POLL_SCHEMA_POST_CATALOG_CHANGED';END IF;
  __RETRY_CONTRACT__
  applied:=true;
 END IF;
 __DISPATCH_CONTRACT__
 PERFORM set_config('tenderdesk.poll_schema_receipt',jsonb_build_object('release','__RELEASE__',
  'sql_sha256','__CHECKSUM__','parent_release','__PARENT_RELEASE__','parent_sql_sha256','__PARENT_SQL__',
  'catalog_sha256',catalog_hash,'structure_sha256',structure_hash,'applied',applied,
  'replayed',saved_manifest IS NOT NULL,'read_only',__READ_ONLY_JSON__,
  'row_guard','transaction_activity_and_storage_v1',
  'predecessor_receipts_preserved',true,'business_rows_changed',0,'processing_requested',false)::text,true);
END $poll_schema_release$;
SELECT current_setting('tenderdesk.poll_schema_receipt');
__NOTIFY__
COMMIT;
"""
    for key, value in {
        '__READ_ONLY__': 'READ ONLY' if read_only else '', '__READ_ONLY_JSON__': 'true' if read_only else 'false',
        '__LOCK__': '' if read_only else "PERFORM pg_advisory_xact_lock(hashtextextended('tenderdesk.retry-schema.release',0));",
        '__APPLY__': apply_sql, '__ROW_ACTIVITY__': ROW_ACTIVITY, '__ROWS__': full_rows, '__PROTECTED__': protected,
        '__RETRY_CONTRACT__': CONTRACT, '__DISPATCH_CONTRACT__': contract,
        '__CATALOG__': base.CATALOG, '__FULL_STRUCTURE__': base.structure_snapshot(protected=False),
        '__BASE_RELEASE__': base.BASE_RELEASE, '__BASE_MANIFEST__': base.BASE_MANIFEST,
        '__DISPATCH_RELEASE__': base.RELEASE, '__DISPATCH_SQL__': retry.PARENT_SQL,
        '__DISPATCH_CATALOG__': retry.PARENT_CATALOG, '__DISPATCH_STRUCTURE__': retry.PARENT_STRUCTURE,
        '__RETRY_RELEASE__': retry.RELEASE, '__RETRY_SQL__': latency.PARENT_SQL,
        '__RETRY_CATALOG__': latency.PARENT_CATALOG, '__RETRY_STRUCTURE__': latency.PARENT_STRUCTURE,
        '__LATENCY_RELEASE__': latency.RELEASE, '__LATENCY_SQL__': parent.PARENT_SQL,
        '__LATENCY_CATALOG__': parent.PARENT_CATALOG, '__LATENCY_STRUCTURE__': parent.PARENT_STRUCTURE,
        '__PARENT_RELEASE__': parent.RELEASE, '__PARENT_SQL__': PARENT_SQL,
        '__PARENT_CATALOG__': PARENT_CATALOG, '__PARENT_STRUCTURE__': PARENT_STRUCTURE,
        '__RELEASE__': RELEASE, '__CHECKSUM__': checksum, '__ADDED__': ADDED,
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
        and value.get('row_guard') == 'transaction_activity_and_storage_v1'
        and value.get('business_rows_changed') == 0 and value.get('processing_requested') is False
        and all(isinstance(value.get(key), str) and re.fullmatch('[a-f0-9]{64}', value[key])
                for key in ('catalog_sha256', 'structure_sha256')), 'RESULT_INVALID')
    return value


def apply(database):
    return run(database, read_only=False)


def verify(database, *, allow_parent=False):
    return run(database, read_only=True, allow_parent=allow_parent)

