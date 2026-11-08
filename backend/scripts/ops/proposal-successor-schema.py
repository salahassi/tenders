#!/usr/bin/env python3
"""Bounded commercial successor DDL, chained to the exact pending-poll ledger.

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
SOURCE = ROOT / 'backend/supabase/migrations/20261108212048_commercial_uuid_colon_successor.sql'
RELEASE = 'proposal-commercial-successor-v1-20261108'
SOURCE_SHA256 = '1cab7a1a875b1f7180d9c1ed3faf927bb981183874bdda7463b89b779ab67935'
PARENT_SQL = '8d089d8d5237fa96e4903ddc54724318afeaeb457737341e88d7e872f49341af'
PARENT_CATALOG = '36d60b8f241ca7dccfa3dee954c97190cacacd89aa4e05f16ab2820107b0db76'
PARENT_STRUCTURE = '1b9db0709561ecb718a94a474e13aeda71d72ed641134e06c103da97ada0aa8c'
CHANGED = ('app_private.enqueue_generation(public.generation_plans,text,jsonb,integer)', 'app_private.backup_tables()')
RENAMED_FROM = 'app_private.app_command(text,jsonb,text)'
RENAMED_TO = 'app_private.app_command_before_commercial_successor(text,jsonb,text)'
ADDED = (
 'app_private.immutable_commercial_successor_lineage()',
 'app_private.commercial_candidate_contains(jsonb,text,integer)',
 'app_private.commercial_successor_proof(uuid)',
 'app_private.reprepare_commercial_successor(uuid,uuid,integer,jsonb)',
 'app_private.guard_commercial_worker_capability()',
 'app_private.app_command(text,jsonb,text)',
 'app_private.wake_backend_queue_checked_v6(uuid,uuid,bigint)',
 'public.claim_backend_job_v6()', 'public.claim_backend_local_job_v6()',
 'public.wake_backend_queue_status_v6(uuid,uuid)',
 'public.wake_backend_queue_revision_v6(uuid,uuid,bigint)',
)
NEW_TABLE = 'app_private.commercial_successor_lineage'
NEW_VIEW = 'public.recovery_commercial_successor_lineage'
ADDED_RELATIONS = (NEW_TABLE, NEW_VIEW)
NEW_TRIGGER = 'zzzzz_commercial_worker_capability'


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


parent = module('successor_parent_poll_schema', 'proposal-poll-schema.py')
admission = parent.parent
latency = parent.latency
retry = parent.retry
base = parent.base


class SuccessorSchemaError(Exception):
    pass


def require(value, code):
    if not value:
        raise SuccessorSchemaError('SUCCESSOR_SCHEMA_' + code)


def source():
    require(isinstance(SOURCE_SHA256,str) and re.fullmatch('[a-f0-9]{64}',SOURCE_SHA256), 'NOT_FROZEN')
    require(SOURCE.is_file() and not SOURCE.is_symlink(), 'SOURCE_MISSING')
    raw = SOURCE.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == SOURCE_SHA256, 'SOURCE_CHANGED')
    value = raw.decode('utf-8')
    require(value.strip() and '$successor_schema_payload$' not in value and '$successor_schema_release$' not in value,
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
        return 'SUCCESSOR_SCHEMA_SQL_FAILED'
    allowed = set(re.findall(r"RAISE EXCEPTION '([A-Z][A-Z0-9_]{0,119})'",
        Path(__file__).read_text() + (HERE / 'proposal-dispatch-schema.py').read_text() + (HERE / 'proposal-retry-schema.py').read_text() + (HERE / 'proposal-latency-schema.py').read_text() + (HERE / 'proposal-admission-schema.py').read_text() + (HERE / 'proposal-poll-schema.py').read_text() + source(), re.I))
    allowed = {value for value in allowed if re.fullmatch('[A-Z][A-Z0-9_]{0,119}', value)}
    errors = re.findall(r'(?:^|\n)[^\n]*?\b(?:ERROR|FATAL):\s+([0-9A-Z]{5}):\s*([^\r\n]*)', stderr)
    if not errors:
        return 'SUCCESSOR_SCHEMA_SQL_TRANSPORT_FAILED'
    state, message = errors[0]
    if message in allowed:
        return message
    return 'SUCCESSOR_SCHEMA_SQLSTATE_' + state


def execute_sql(database, sql):
    deploy = module('successor_schema_deploy', 'digitalocean-deploy.py')
    arguments = [os.environ['KUBECTL'], '--request-timeout=30s', 'exec', '-i', database.pod,
        '-n', deploy.NAMESPACE, '--', 'psql', '-X', '--quiet', '--no-align', '--tuples-only',
        '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=verbose', '--dbname=' + deploy.DATABASE, '--file=-']
    try:
        result = subprocess.run(arguments, input=sql, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise SuccessorSchemaError('SUCCESSOR_SCHEMA_SQL_TRANSPORT_TIMEOUT') from None
    if result.returncode:
        raise SuccessorSchemaError(sql_error_code(result.stderr)) from None
    require(isinstance(result.stdout, str) and len(result.stdout.encode()) <= 16384, 'RESULT_SIZE')
    return result.stdout


CONTRACT = """
 FOREACH target IN ARRAY __ADDED__||ARRAY['__RENAMED_TO__'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure(target) AND p.proowner='tdp_app_owner'::regrole
    AND p.proconfig=ARRAY['search_path=""']::text[] AND p.prokind='f' AND p.proparallel='u' AND NOT p.proisstrict
    AND p.proargmodes IS NULL
    AND p.prosecdef=(target NOT IN ('app_private.immutable_commercial_successor_lineage()',
      'app_private.commercial_candidate_contains(jsonb,text,integer)','app_private.guard_commercial_worker_capability()'))
    AND p.provolatile=CASE WHEN target='app_private.commercial_candidate_contains(jsonb,text,integer)' THEN 'i'::"char" ELSE 'v'::"char" END
    AND l.lanname=CASE WHEN target IN ('public.wake_backend_queue_status_v6(uuid,uuid)',
      'public.wake_backend_queue_revision_v6(uuid,uuid,bigint)') THEN 'sql' ELSE 'plpgsql' END
    AND p.prorettype=(CASE WHEN target IN ('app_private.immutable_commercial_successor_lineage()',
      'app_private.guard_commercial_worker_capability()') THEN 'trigger'
      WHEN target='app_private.commercial_candidate_contains(jsonb,text,integer)' THEN 'boolean'
      WHEN target='app_private.reprepare_commercial_successor(uuid,uuid,integer,jsonb)' THEN 'uuid' ELSE 'jsonb' END)::regtype)
   THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_ROUTINE_ATTRIBUTES';END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=to_regprocedure(target) AND (a.privilege_type<>'EXECUTE' OR
    (a.grantee<>p.proowner AND (a.is_grantable OR a.grantor<>p.proowner OR a.grantee NOT IN(
     SELECT oid FROM pg_roles WHERE (target LIKE 'public.%' AND rolname IN ('tdp_app_service','service_role'))
      OR(target='__RENAMED_FROM__' AND rolname IN ('tdp_app_authenticated','authenticated')))))))
   THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_PRIVATE_AUTHORITY';END IF;
  IF EXISTS(SELECT 1 FROM pg_roles role_row WHERE
    ((target LIKE 'public.%' AND role_row.rolname IN ('tdp_app_service','service_role'))
      OR(target='__RENAMED_FROM__' AND role_row.rolname IN ('tdp_app_authenticated','authenticated')))
    AND NOT EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
     WHERE p.oid=to_regprocedure(target) AND a.grantee=role_row.oid AND a.privilege_type='EXECUTE'))
   THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_RPC_AUTHORITY';END IF;
 END LOOP;
 FOREACH target IN ARRAY __ADDED_RELATIONS__ LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass(target) AND c.relowner='tdp_app_owner'::regrole
    AND c.relpersistence='p' AND NOT c.relforcerowsecurity
    AND ((target='__NEW_TABLE__' AND c.relkind='r' AND c.relrowsecurity AND c.reloptions IS NULL)
     OR(target='__NEW_VIEW__' AND c.relkind='v' AND NOT c.relrowsecurity AND c.reloptions=ARRAY['security_invoker=true']::text[])))
   OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
     WHERE c.oid=to_regclass(target) AND a.grantee<>c.relowner)
   OR EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl
     WHERE a.attrelid=to_regclass(target) AND acl.grantee<>'tdp_app_owner'::regrole)
   OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass(target))
   THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_LINEAGE_AUTHORITY';END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.jobs'::regclass
   AND t.tgname='zzzzz_commercial_worker_capability' AND t.tgtype=23 AND t.tgenabled='O'
   AND t.tgfoid=to_regprocedure('app_private.guard_commercial_worker_capability()') AND t.tgnargs=0
   AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgconstraint=0 AND t.tgattr=''::int2vector)
 THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_CAPABILITY_TRIGGER';END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='__NEW_TABLE__'::regclass AND NOT tgisinternal)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid='__NEW_TABLE__'::regclass
   AND t.tgname='immutable_commercial_successor_lineage' AND t.tgtype=27 AND t.tgenabled='O'
   AND t.tgfoid=to_regprocedure('app_private.immutable_commercial_successor_lineage()') AND t.tgnargs=0
   AND NOT t.tgisinternal AND t.tgqual IS NULL AND t.tgconstraint=0 AND t.tgattr=''::int2vector)
  OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='__NEW_VIEW__'::regclass AND NOT tgisinternal)
 THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_LINEAGE_TRIGGER';END IF;
 IF (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
   WHERE a.attrelid='__NEW_TABLE__'::regclass AND a.attnum>0 AND NOT a.attisdropped) IS DISTINCT FROM
   ARRAY['id','workspace_id','plan_id','recovery_version','predecessor_step_id','predecessor_job_id',
    'successor_step_id','successor_job_id','predecessor_revision','predecessor_status','predecessor_error',
    'input_hash','graph_thread','proof','proof_hash','issuance_request_id','authorized_by','operation','idempotency_key_hash','created_at']::text[]
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='__NEW_TABLE__'::regclass AND attnum>0 AND (attisdropped OR NOT attnotnull))
  OR (SELECT count(*) FROM pg_index WHERE indrelid='__NEW_TABLE__'::regclass)<>4
  OR (SELECT count(*) FROM pg_index WHERE indrelid='__NEW_TABLE__'::regclass AND indisunique AND indisvalid
    AND indpred IS NULL AND indexprs IS NULL AND indkey::text IN ('1','2 3 4','2 6','2 8'))<>4
  OR (SELECT count(*) FROM pg_constraint WHERE conrelid='__NEW_TABLE__'::regclass AND contype='c' AND convalidated)<>9
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='__NEW_TABLE__'::regclass AND contype='f'
    AND confrelid='public.workspaces'::regclass AND conkey=ARRAY[2]::smallint[] AND convalidated)
 THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_LINEAGE_STRUCTURE';END IF;
"""


ROW_ACTIVITY = parent.ROW_ACTIVITY.replace('POLL_SCHEMA_', 'SUCCESSOR_SCHEMA_')


def script(*, read_only, allow_parent=False, payload=None):
    """Explicit payload is isolated fault injection; operational paths read SOURCE."""
    require(type(read_only) is bool and type(allow_parent) is bool and (read_only or not allow_parent), 'MODE')
    require(parent.source_sha256() == PARENT_SQL, 'PARENT_SOURCE_CHANGED')
    canonical = source()
    payload = canonical if payload is None else payload
    require(isinstance(payload, str) and payload.strip() and '$successor_schema_payload$' not in payload
            and '$successor_schema_release$' not in payload, 'SOURCE_INVALID')
    checksum = hashlib.sha256(payload.encode()).hexdigest()
    # Optimize only the exact reviewed successor DDL. Arbitrary
    # fault payloads retain the original full-row proof as well as activity
    # counters; this is not a generic relaxation of migration protections.
    full_rows = '' if payload == canonical else base.ROWS
    protected = base.structure_snapshot(protected=True).replace("p.oid=to_regprocedure('public.k8s_claim_dispatch()')", "p.oid=ANY(changed_before) OR p.oid=renamed_before")
    protected = protected.replace("'acl',p.proacl", "'acl',CASE WHEN p.oid=renamed_before THEN NULL ELSE p.proacl END")
    protected = protected.replace("AND NOT t.tgisinternal)", "AND NOT t.tgisinternal AND NOT(t.tgrelid='public.jobs'::regclass AND t.tgname='"+NEW_TRIGGER+"'))")
    contract = base.CONTRACT.replace('__SERVICE_FUNCTIONS__', base.array(
        (base.CHANGED_FUNCTION, base.EXISTING_FUNCTIONS[-1], *base.NEW_FUNCTIONS)))
    contract += retry.CONTRACT.replace('__ADDED__', retry.ADDED).replace('__CHANGED__', retry.CHANGED)
    contract += latency.CONTRACT.replace('__CHANGED__', latency.CHANGED)
    contract += admission.CONTRACT.replace('__CHANGED__', admission.CHANGED)
    contract += parent.CONTRACT.replace('__ADDED__', parent.ADDED)
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
   SELECT array_agg(to_regprocedure(signature)::oid) INTO changed_before FROM unnest(__CHANGED__) signature;
   renamed_before:=to_regprocedure('__RENAMED_FROM__');
   IF renamed_before IS NULL OR array_position(changed_before,NULL) IS NOT NULL
   THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_ROUTINE_MISSING';END IF;
   __ROW_ACTIVITY__ row_activity_before:=row_activity;
   __ROWS__ rows_before:=state;
   __PROTECTED__ structure_before:=structure;
   -- Only reviewed bodies may change. A rename retains its exact original
   -- body after the exact selfqualification replacement, its OID and every
   -- attribute except the approved name and owner-only ACL tightening.
   SELECT jsonb_object_agg(p.oid::text,__ATTRIBUTES_BEFORE__) INTO routines_before FROM pg_proc p WHERE p.oid=ANY(functions_before);
   EXECUTE $successor_schema_payload$__PAYLOAD__$successor_schema_payload$;
   __ROW_ACTIVITY__
   IF row_activity IS DISTINCT FROM row_activity_before
   THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_EXISTING_ROWS_CHANGED';END IF;
   __ROWS__
   IF state IS DISTINCT FROM rows_before THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_EXISTING_ROWS_CHANGED';END IF;
   __PROTECTED__
   IF structure IS DISTINCT FROM structure_before THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_EXISTING_STRUCTURE_CHANGED';END IF;
   IF to_regprocedure('__RENAMED_TO__')::oid IS DISTINCT FROM renamed_before
    OR to_regprocedure('__RENAMED_FROM__')::oid IS NOT DISTINCT FROM renamed_before
    OR (SELECT jsonb_object_agg(p.oid::text,__ATTRIBUTES_AFTER__) FROM pg_proc p WHERE p.oid=ANY(functions_before)) IS DISTINCT FROM routines_before
   THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_EXISTING_ROUTINES_CHANGED';END IF;
   IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname IN ('public','app_private') AND p.prokind='f' AND NOT p.oid=ANY(functions_before)
      AND NOT p.oid=ANY(ARRAY(SELECT to_regprocedure(signature)::oid FROM unnest(__ADDED__) signature)))
    OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname IN ('public','app_private') AND NOT c.oid=ANY(relations_before)
      AND NOT c.oid=ANY(ARRAY(SELECT to_regclass(signature)::oid FROM unnest(__ADDED_RELATIONS__) signature))
      AND NOT(c.relkind='i' AND EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=c.oid AND indrelid='__NEW_TABLE__'::regclass)))
    OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=ANY(relations_before) AND a.attnum>0
     AND NOT (a.attrelid::text||':'||a.attnum)=ANY(attributes_before))
   THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_UNEXPECTED_ADDITION';END IF;
   IF EXISTS(SELECT 1 FROM __NEW_TABLE__) THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_NEW_ROWS_CHANGED';END IF;
   __RETRY_CONTRACT__
   __CATALOG__
   __FULL_STRUCTURE__
   structure_hash:=encode(sha256(convert_to(structure::text,'UTF8')),'hex');
   INSERT INTO app_private.application_release_history(release,migration_sha256) VALUES
    ('__RELEASE__','__CHECKSUM__'),('__RELEASE__-catalog',catalog_hash),('__RELEASE__-structure',structure_hash);
   applied:=true;
"""
    if read_only:
        apply_sql = 'NULL;' if allow_parent else "RAISE EXCEPTION 'SUCCESSOR_SCHEMA_RELEASE_MISSING';"
    attributes = "to_jsonb(p)-(CASE WHEN p.oid=ANY(changed_before) THEN 'prosrc' ELSE 'no_such_attribute' END)-(CASE WHEN p.oid=renamed_before THEN 'proname' ELSE 'no_such_attribute' END)-(CASE WHEN p.oid=renamed_before THEN 'proacl' ELSE 'no_such_attribute' END)"
    sql = """BEGIN ISOLATION LEVEL REPEATABLE READ __READ_ONLY__;
SET LOCAL ROLE tdp_app_owner;SET LOCAL search_path=public;
SET LOCAL statement_timeout='20s';SET LOCAL lock_timeout='5s';
DO $successor_schema_release$
DECLARE r record;target text;saved_manifest text;saved_catalog text;saved_structure text;
 catalog_hash text;structure_hash text;row_count bigint;row_digest text;columns_before jsonb;
 relations_before oid[];functions_before oid[];attributes_before text[];changed_before oid[];renamed_before oid;state jsonb;rows_before jsonb;
 structure jsonb;structure_before jsonb;routines_before jsonb;row_activity jsonb;row_activity_before jsonb;applied boolean:=false;
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_DATABASE_IDENTITY';END IF;
 __LOCK__
 IF to_regclass('app_private.application_release_history') IS NULL
  THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_PARENT_LEDGER';END IF;
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
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__ADMISSION_RELEASE__' AND migration_sha256='__ADMISSION_SQL__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__ADMISSION_RELEASE__-catalog' AND migration_sha256='__ADMISSION_CATALOG__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__ADMISSION_RELEASE__-structure' AND migration_sha256='__ADMISSION_STRUCTURE__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__PARENT_RELEASE__' AND migration_sha256='__PARENT_SQL__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__PARENT_RELEASE__-catalog' AND migration_sha256='__PARENT_CATALOG__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__PARENT_RELEASE__-structure' AND migration_sha256='__PARENT_STRUCTURE__')
 THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_PARENT_LEDGER';END IF;
 SELECT migration_sha256 INTO saved_manifest FROM app_private.application_release_history WHERE release='__RELEASE__';
 SELECT migration_sha256 INTO saved_catalog FROM app_private.application_release_history WHERE release='__RELEASE__-catalog';
 SELECT migration_sha256 INTO saved_structure FROM app_private.application_release_history WHERE release='__RELEASE__-structure';
 IF (saved_manifest IS NULL)<>(saved_catalog IS NULL) OR (saved_manifest IS NULL)<>(saved_structure IS NULL)
 THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_PARTIAL_RECEIPT';END IF;
 __CATALOG__
 __FULL_STRUCTURE__
 structure_hash:=encode(sha256(convert_to(structure::text,'UTF8')),'hex');
 IF saved_manifest IS NULL THEN
  IF EXISTS(SELECT 1 FROM unnest(__ADDED__) signature WHERE signature<>'__RENAMED_FROM__' AND to_regprocedure(signature) IS NOT NULL)
   OR EXISTS(SELECT 1 FROM unnest(__ADDED_RELATIONS__) signature WHERE to_regclass(signature) IS NOT NULL)
   OR to_regprocedure('__RENAMED_TO__') IS NOT NULL
  THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_UNLEDGERED_OBJECT';END IF;
  IF catalog_hash<>'__PARENT_CATALOG__' OR structure_hash<>'__PARENT_STRUCTURE__'
  THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_PARENT_CATALOG';END IF;
  __APPLY__
 ELSE
  IF saved_manifest<>'__CHECKSUM__' THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_SOURCE_CHANGED';END IF;
  IF catalog_hash IS DISTINCT FROM saved_catalog OR structure_hash IS DISTINCT FROM saved_structure
  THEN RAISE EXCEPTION 'SUCCESSOR_SCHEMA_POST_CATALOG_CHANGED';END IF;
  __RETRY_CONTRACT__
  applied:=true;
 END IF;
 __DISPATCH_CONTRACT__
 PERFORM set_config('tenderdesk.successor_schema_receipt',jsonb_build_object('release','__RELEASE__',
  'sql_sha256','__CHECKSUM__','parent_release','__PARENT_RELEASE__','parent_sql_sha256','__PARENT_SQL__',
  'catalog_sha256',catalog_hash,'structure_sha256',structure_hash,'applied',applied,
  'replayed',saved_manifest IS NOT NULL,'read_only',__READ_ONLY_JSON__,
  'row_guard','transaction_activity_and_storage_v1',
  'predecessor_receipts_preserved',true,'business_rows_changed',0,'processing_requested',false)::text,true);
END $successor_schema_release$;
SELECT current_setting('tenderdesk.successor_schema_receipt');
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
        '__LATENCY_RELEASE__': latency.RELEASE, '__LATENCY_SQL__': admission.PARENT_SQL,
        '__LATENCY_CATALOG__': admission.PARENT_CATALOG, '__LATENCY_STRUCTURE__': admission.PARENT_STRUCTURE,
        '__ADMISSION_RELEASE__': admission.RELEASE, '__ADMISSION_SQL__': parent.PARENT_SQL,
        '__ADMISSION_CATALOG__': parent.PARENT_CATALOG, '__ADMISSION_STRUCTURE__': parent.PARENT_STRUCTURE,
        '__PARENT_RELEASE__': parent.RELEASE, '__PARENT_SQL__': PARENT_SQL,
        '__PARENT_CATALOG__': PARENT_CATALOG, '__PARENT_STRUCTURE__': PARENT_STRUCTURE,
        '__RELEASE__': RELEASE, '__CHECKSUM__': checksum, '__ADDED__': base.array(ADDED),
        '__ADDED_RELATIONS__': base.array(ADDED_RELATIONS), '__NEW_TABLE__': NEW_TABLE, '__NEW_VIEW__': NEW_VIEW,
        '__CHANGED__': base.array(CHANGED), '__RENAMED_FROM__': RENAMED_FROM, '__RENAMED_TO__': RENAMED_TO,
        '__ATTRIBUTES_AFTER__': attributes,
        '__ATTRIBUTES_BEFORE__': '('+attributes+")||(CASE WHEN p.oid=renamed_before THEN jsonb_build_object('prosrc',replace(p.prosrc,'app_command.','app_command_before_commercial_successor.')) ELSE '{}'::jsonb END)",
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

