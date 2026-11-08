#!/usr/bin/env python3
"""One checkpoint decoding migration, chained to the commercial successor ledger.

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
SOURCE = ROOT / 'backend/supabase/migrations/20261108220203_generated_delivery_checkpoint_report_ref.sql'
RELEASE = 'proposal-checkpoint-report-ref-v1-20261108'
# Frozen after actual-store PostgreSQL publication races and decoder authority proof.
SOURCE_SHA256 = '6bf6a506c53bf5113a17dfbb9c12ec09fc4ee0090599931776c34ed8e2614e53'
PARENT_SQL = '1cab7a1a875b1f7180d9c1ed3faf927bb981183874bdda7463b89b779ab67935'
PARENT_CATALOG = '8654608be86c0c177d3bdbdf2b67633181989e4f76e54166571586d73a9aa8e2'
PARENT_STRUCTURE = 'c75f318758476ce7a296ef36712878505a2883c575dae5c422da7280051e270a'
CHANGED = 'public.generated_delivery_context_before_source_resolution(uuid,uuid)'
ADDED = 'app_private.model_graph_checkpoint_report_ref(jsonb)'


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


parent = module('checkpoint_parent_successor_schema', 'proposal-successor-schema.py')
poll, admission, latency, retry, base = parent.parent, parent.admission, parent.latency, parent.retry, parent.base


class CheckpointSchemaError(Exception):
    pass


def require(value, code):
    if not value:
        raise CheckpointSchemaError('CHECKPOINT_SCHEMA_' + code)


def source():
    require(isinstance(SOURCE_SHA256, str) and re.fullmatch('[a-f0-9]{64}', SOURCE_SHA256), 'NOT_FROZEN')
    require(SOURCE.is_file() and not SOURCE.is_symlink(), 'SOURCE_MISSING')
    raw = SOURCE.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == SOURCE_SHA256, 'SOURCE_CHANGED')
    value = raw.decode('utf-8')
    require(value.strip() and '$checkpoint_schema_payload$' not in value and '$checkpoint_schema_release$' not in value,
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
        return 'CHECKPOINT_SCHEMA_SQL_FAILED'
    allowed = set(re.findall(r"RAISE EXCEPTION '([A-Z][A-Z0-9_]{0,119})'",
        Path(__file__).read_text() + ''.join((HERE / ('proposal-'+name+'-schema.py')).read_text() for name in ('dispatch','retry','latency','admission','poll','successor')) + source(), re.I))
    allowed = {value for value in allowed if re.fullmatch('[A-Z][A-Z0-9_]{0,119}', value)}
    errors = re.findall(r'(?:^|\n)[^\n]*?\b(?:ERROR|FATAL):\s+([0-9A-Z]{5}):\s*([^\r\n]*)', stderr)
    if not errors:
        return 'CHECKPOINT_SCHEMA_SQL_TRANSPORT_FAILED'
    state, message = errors[0]
    if message in allowed:
        return message
    return 'CHECKPOINT_SCHEMA_SQLSTATE_' + state


def execute_sql(database, sql):
    deploy = module('checkpoint_schema_deploy', 'digitalocean-deploy.py')
    arguments = [os.environ['KUBECTL'], '--request-timeout=30s', 'exec', '-i', database.pod,
        '-n', deploy.NAMESPACE, '--', 'psql', '-X', '--quiet', '--no-align', '--tuples-only',
        '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose', '--dbname=' + deploy.DATABASE, '--file=-']
    try:
        result = subprocess.run(arguments, input=sql, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise CheckpointSchemaError('CHECKPOINT_SCHEMA_SQL_TRANSPORT_TIMEOUT') from None
    if result.returncode:
        raise CheckpointSchemaError(sql_error_code(result.stderr)) from None
    require(isinstance(result.stdout, str) and len(result.stdout.encode()) <= 16384, 'RESULT_SIZE')
    return result.stdout


CONTRACT = """
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
  WHERE p.oid=to_regprocedure('__ADDED__') AND p.proowner='tdp_app_owner'::regrole
   AND NOT p.prosecdef AND p.proconfig=ARRAY['search_path=""']::text[]
   AND p.prokind='f' AND p.provolatile='i' AND p.proparallel='u' AND NOT p.proisstrict
   AND p.proargmodes IS NULL AND p.prorettype='text'::regtype AND l.lanname='plpgsql')
 THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_HELPER_ATTRIBUTES';END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid=to_regprocedure('__ADDED__') AND
   (a.grantee<>p.proowner OR a.privilege_type<>'EXECUTE' OR a.grantor<>p.proowner))
 THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_HELPER_AUTHORITY';END IF;
 IF position('app_private.model_graph_checkpoint_report_ref(last_state.checkpoint)'
   in pg_get_functiondef('__CHANGED__'::regprocedure))=0
  OR position($raw$last_state.checkpoint#>>'{channel_values,reportRef}'$raw$
   in pg_get_functiondef('__CHANGED__'::regprocedure))<>0
 THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_CALL_SITE_CHANGED';END IF;
"""


def predecessors():
    rows = [(base.BASE_RELEASE, base.BASE_MANIFEST)]
    for obj, sha, catalog, structure in (
        (base, retry.PARENT_SQL, retry.PARENT_CATALOG, retry.PARENT_STRUCTURE),
        (retry, latency.PARENT_SQL, latency.PARENT_CATALOG, latency.PARENT_STRUCTURE),
        (latency, admission.PARENT_SQL, admission.PARENT_CATALOG, admission.PARENT_STRUCTURE),
        (admission, poll.PARENT_SQL, poll.PARENT_CATALOG, poll.PARENT_STRUCTURE),
        (poll, parent.PARENT_SQL, parent.PARENT_CATALOG, parent.PARENT_STRUCTURE),
        (parent, PARENT_SQL, PARENT_CATALOG, PARENT_STRUCTURE)):
        rows.extend([(obj.RELEASE, sha), (obj.RELEASE+'-catalog', catalog),
                     (obj.RELEASE+'-structure', structure)])
    require(len(rows) == 19 and len({name for name, _ in rows}) == 19, 'ANCESTRY_INVALID')
    return rows


def predecessor_contract():
    value = base.CONTRACT.replace('__SERVICE_FUNCTIONS__', base.array(
        (base.CHANGED_FUNCTION, base.EXISTING_FUNCTIONS[-1], *base.NEW_FUNCTIONS)))
    value += retry.CONTRACT.replace('__ADDED__', retry.ADDED).replace('__CHANGED__', retry.CHANGED)
    value += latency.CONTRACT.replace('__CHANGED__', latency.CHANGED)
    value += admission.CONTRACT.replace('__CHANGED__', admission.CHANGED)
    value += poll.CONTRACT.replace('__ADDED__', poll.ADDED)
    value += parent.CONTRACT.replace('__ADDED__', base.array(parent.ADDED)).replace(
        '__RENAMED_FROM__', parent.RENAMED_FROM).replace('__RENAMED_TO__', parent.RENAMED_TO).replace(
        '__ADDED_RELATIONS__', base.array(parent.ADDED_RELATIONS)).replace('__NEW_TABLE__', parent.NEW_TABLE).replace(
        '__NEW_VIEW__', parent.NEW_VIEW)
    return value


# These counters belong to this backend and transaction, including its live
# subtransactions; concurrent application writers cannot change them. Storage
# identity also catches TRUNCATE/rewrites, which do not increment tuple counters.
# No customer values are read, decompressed or aggregated by this proof.
ROW_ACTIVITY = """
 IF current_setting('track_counts')<>'on'
 THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_ROW_TRACKING_DISABLED';END IF;
 SELECT coalesce(jsonb_object_agg(c.oid::text,jsonb_build_object(
  'filenode',pg_relation_filenode(c.oid),
  'inserted',pg_stat_get_xact_tuples_inserted(c.oid),
  'updated',pg_stat_get_xact_tuples_updated(c.oid),
  'deleted',pg_stat_get_xact_tuples_deleted(c.oid))),'{}'::jsonb)
 INTO row_activity FROM pg_class c
 WHERE c.oid=ANY(relations_before) AND c.relkind IN ('r','p');
"""


def script(*, read_only, allow_parent=False, payload=None):
    """Explicit payload is isolated fault injection; operational paths read SOURCE."""
    require(type(read_only) is bool and type(allow_parent) is bool and (read_only or not allow_parent), 'MODE')
    require(parent.source_sha256() == PARENT_SQL, 'PARENT_SOURCE_CHANGED')
    canonical = source()
    payload = canonical if payload is None else payload
    require(isinstance(payload, str) and payload.strip() and '$checkpoint_schema_payload$' not in payload
            and '$checkpoint_schema_release$' not in payload, 'SOURCE_INVALID')
    checksum = hashlib.sha256(payload.encode()).hexdigest()
    # Optimize only the exact reviewed function-body replacement. Arbitrary
    # fault payloads retain the original full-row proof as well as activity
    # counters; this is not a generic relaxation of migration protections.
    full_rows = '' if payload == canonical else base.ROWS
    protected = base.structure_snapshot(protected=True).replace("public.k8s_claim_dispatch()", CHANGED)
    contract = predecessor_contract()
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
   SELECT to_jsonb(p)-'prosrc' INTO target_before FROM pg_proc p WHERE p.oid='__CHANGED__'::regprocedure;
   EXECUTE $checkpoint_schema_payload$__PAYLOAD__$checkpoint_schema_payload$;
   __ROW_ACTIVITY__
   IF row_activity IS DISTINCT FROM row_activity_before
   THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_EXISTING_ROWS_CHANGED';END IF;
   __ROWS__
   IF state IS DISTINCT FROM rows_before THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_EXISTING_ROWS_CHANGED';END IF;
   __PROTECTED__
   IF structure IS DISTINCT FROM structure_before THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_EXISTING_STRUCTURE_CHANGED';END IF;
   IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid='__CHANGED__'::regprocedure) IS DISTINCT FROM target_before
   THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_COMMAND_ATTRIBUTES_CHANGED';END IF;
   IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname IN ('public','app_private') AND p.prokind='f' AND NOT p.oid=ANY(functions_before)
      AND p.oid<>'__ADDED__'::regprocedure)
    OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname IN ('public','app_private') AND NOT c.oid=ANY(relations_before))
    OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=ANY(relations_before) AND a.attnum>0
     AND NOT (a.attrelid::text||':'||a.attnum)=ANY(attributes_before))
   THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_UNEXPECTED_ADDITION';END IF;
   __RETRY_CONTRACT__
   __CATALOG__
   __FULL_STRUCTURE__
   structure_hash:=encode(sha256(convert_to(structure::text,'UTF8')),'hex');
   INSERT INTO app_private.application_release_history(release,migration_sha256) VALUES
    ('__RELEASE__','__CHECKSUM__'),('__RELEASE__-catalog',catalog_hash),('__RELEASE__-structure',structure_hash);
   applied:=true;
"""
    if read_only:
        apply_sql = 'NULL;' if allow_parent else "RAISE EXCEPTION 'CHECKPOINT_SCHEMA_RELEASE_MISSING';"
    sql = """BEGIN ISOLATION LEVEL REPEATABLE READ __READ_ONLY__;
SET LOCAL ROLE tdp_app_owner;SET LOCAL search_path=public;
SET LOCAL statement_timeout='20s';SET LOCAL lock_timeout='5s';
DO $checkpoint_schema_release$
DECLARE r record;target text;saved_manifest text;saved_catalog text;saved_structure text;
 catalog_hash text;structure_hash text;row_count bigint;row_digest text;columns_before jsonb;
 relations_before oid[];functions_before oid[];attributes_before text[];state jsonb;rows_before jsonb;
 structure jsonb;structure_before jsonb;target_before jsonb;row_activity jsonb;row_activity_before jsonb;applied boolean:=false;
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_DATABASE_IDENTITY';END IF;
 __LOCK__
 IF to_regclass('app_private.application_release_history') IS NULL
  THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_PARENT_LEDGER';END IF;
 IF EXISTS(SELECT 1 FROM (VALUES __PREDECESSORS__) expected(release,migration_sha256)
  LEFT JOIN app_private.application_release_history saved USING(release)
  WHERE saved.migration_sha256 IS DISTINCT FROM expected.migration_sha256)
 THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_PARENT_LEDGER';END IF;
 IF to_regprocedure('__CHANGED__') IS NULL THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_COMMAND_MISSING';END IF;
 SELECT migration_sha256 INTO saved_manifest FROM app_private.application_release_history WHERE release='__RELEASE__';
 SELECT migration_sha256 INTO saved_catalog FROM app_private.application_release_history WHERE release='__RELEASE__-catalog';
 SELECT migration_sha256 INTO saved_structure FROM app_private.application_release_history WHERE release='__RELEASE__-structure';
 IF (saved_manifest IS NULL)<>(saved_catalog IS NULL) OR (saved_manifest IS NULL)<>(saved_structure IS NULL)
 THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_PARTIAL_RECEIPT';END IF;
 __CATALOG__
 __FULL_STRUCTURE__
 structure_hash:=encode(sha256(convert_to(structure::text,'UTF8')),'hex');
 IF saved_manifest IS NULL THEN
  IF to_regprocedure('__ADDED__') IS NOT NULL THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_UNLEDGERED_HELPER';END IF;
  IF catalog_hash<>'__PARENT_CATALOG__' OR structure_hash<>'__PARENT_STRUCTURE__'
  THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_PARENT_CATALOG';END IF;
  __APPLY__
 ELSE
  IF saved_manifest<>'__CHECKSUM__' THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_SOURCE_CHANGED';END IF;
  IF catalog_hash IS DISTINCT FROM saved_catalog OR structure_hash IS DISTINCT FROM saved_structure
  THEN RAISE EXCEPTION 'CHECKPOINT_SCHEMA_POST_CATALOG_CHANGED';END IF;
  __RETRY_CONTRACT__
  applied:=true;
 END IF;
 __DISPATCH_CONTRACT__
 PERFORM set_config('tenderdesk.checkpoint_schema_receipt',jsonb_build_object('release','__RELEASE__',
  'sql_sha256','__CHECKSUM__','parent_release','__PARENT_RELEASE__','parent_sql_sha256','__PARENT_SQL__',
  'catalog_sha256',catalog_hash,'structure_sha256',structure_hash,'applied',applied,
  'replayed',saved_manifest IS NOT NULL,'read_only',__READ_ONLY_JSON__,
  'row_guard','transaction_activity_and_storage_v1',
  'predecessor_receipts_preserved',true,'business_rows_changed',0,'processing_requested',false)::text,true);
END $checkpoint_schema_release$;
SELECT current_setting('tenderdesk.checkpoint_schema_receipt');
__NOTIFY__
COMMIT;
"""
    for key, value in {
        '__READ_ONLY__': 'READ ONLY' if read_only else '', '__READ_ONLY_JSON__': 'true' if read_only else 'false',
        '__LOCK__': '' if read_only else "PERFORM pg_advisory_xact_lock(hashtextextended('tenderdesk.retry-schema.release',0));",
        '__APPLY__': apply_sql, '__ROW_ACTIVITY__': ROW_ACTIVITY, '__ROWS__': full_rows, '__PROTECTED__': protected,
        '__RETRY_CONTRACT__': CONTRACT, '__DISPATCH_CONTRACT__': contract,
        '__CATALOG__': base.CATALOG, '__FULL_STRUCTURE__': base.structure_snapshot(protected=False),
        '__PREDECESSORS__': ','.join('('+base.literal(name)+','+base.literal(sha)+')' for name, sha in predecessors()),
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
        and value.get('row_guard') == 'transaction_activity_and_storage_v1'
        and value.get('business_rows_changed') == 0 and value.get('processing_requested') is False
        and all(isinstance(value.get(key), str) and re.fullmatch('[a-f0-9]{64}', value[key])
                for key in ('catalog_sha256', 'structure_sha256')), 'RESULT_INVALID')
    return value


def apply(database):
    return run(database, read_only=False)


def verify(database, *, allow_parent=False):
    return run(database, read_only=True, allow_parent=allow_parent)
