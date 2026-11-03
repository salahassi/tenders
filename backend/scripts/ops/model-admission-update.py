#!/usr/bin/env python3
"""Atomically apply reviewed binding and queue SQL without replacing runtime images.

The existing claim path adopts the SQL change atomically. This release never
claims, retries, wakes or creates a job, and preserves all prior rows/authority.
"""
from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("model_admission_release_base", HERE / "verifier-recheck-update.py")
prior = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = prior
SPEC.loader.exec_module(prior)
SPEC = importlib.util.spec_from_file_location("model_admission_cluster_access", HERE / "transfer-sources.py")
access = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = access
SPEC.loader.exec_module(access)
code, runtime, u = prior.code, prior.runtime, prior.u
RUNTIME = u.REGISTRY + "runtime@sha256:bded9f019592be84ae45e078d55a52e438c3f6942b2bd1bf35d148d4ff0d6c4a"
MIGRATIONS = (
    (u.d.ROOT / "supabase/migrations/20261103031500_analysis_recheck_prompt_identity.sql",
     "30f79868deaa94daab1554584aede2545a1611a29f7b19d26503e75f57720f14", "analysis-recheck-prompt-identity-v1"),
    (u.d.ROOT / "supabase/migrations/20261103032000_model_admission_fairness.sql",
     "3bb13dd60fb4322ac3ba70c534ec6165a668da547318d1ea49232ae1d401c927", "model-admission-fairness-v1"),
)
RELEASE = "model-admission-and-recheck-binding-v1"
NEW_TABLE = "app_private.queue_model_admission_state"
FUNCTION_MARKERS = {
    "app_private.next_fair_job(uuid,boolean)": ["queue_model_admission_state", "eligible_model_classes"],
    "app_private.analysis_recheck_binding(uuid)": [
        "tenderdesk-v3.evidence-v1.tenderdesk-semantic-fidelity-v1.economy-v1",
        "writer_pin.value->'version'='4'::jsonb",
    ],
}

# Capture immutable relation definitions as well as the audited owner/ACL/body
# snapshot. Runtime row changes in other transactions are outside this snapshot;
# only writes caused by this migration can appear in its repeatable-read view.
STRUCTURE_SNAPSHOT = """
 SELECT jsonb_build_object(
  'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',a.attrelid::regclass::text,
    'column',to_jsonb(a),'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attrelid,a.attnum),'[]'::jsonb)
   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid::regclass::text=ANY(relations_before) AND a.attnum>0),
  'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,
    'name',c.conname,'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conrelid,c.conname),'[]'::jsonb)
   FROM pg_constraint c WHERE c.conrelid::regclass::text=ANY(relations_before)),
  'indexes',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.schemaname,i.indexname),'[]'::jsonb)
   FROM pg_indexes i WHERE format('%I.%I',i.schemaname,i.tablename)=ANY(relations_before)),
  'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',t.tgrelid::regclass::text,
    'name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgrelid,t.tgname),'[]'::jsonb)
   FROM pg_trigger t WHERE t.tgrelid::regclass::text=ANY(relations_before) AND NOT t.tgisinternal),
  'views',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.schemaname,v.viewname),'[]'::jsonb)
   FROM pg_views v WHERE v.schemaname IN ('public','app_private')),
  'materialized_views',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.schemaname,v.matviewname),'[]'::jsonb)
   FROM pg_matviews v WHERE v.schemaname IN ('public','app_private')),
  'roles',(SELECT jsonb_agg(to_jsonb(role_row) ORDER BY role_row.rolname) FROM pg_roles role_row),
  'memberships',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor),'[]'::jsonb) FROM pg_auth_members m)
 ) INTO structure;
"""


def emit(status, **values):
    print(json.dumps({"update": "model_admission", "release": RELEASE, "status": status, **values}, sort_keys=True), flush=True)


def verify_source():
    prior.verify_source()
    for path, checksum, _release in MIGRATIONS:
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
            raise u.UpdateError("MODEL_ADMISSION_MIGRATION_SOURCE_CHANGED")


def migration_script(sources=None):
    if sources is None:
        verify_source()
        sources = [path.read_text() for path, _checksum, _release in MIGRATIONS]
        if any(hashlib.sha256(source.encode()).hexdigest() != checksum
               for source, (_path, checksum, _release) in zip(sources, MIGRATIONS)):
            raise u.UpdateError("MODEL_ADMISSION_MIGRATION_SOURCE_CHANGED")
    if len(sources) != len(MIGRATIONS) or any(not source.strip() for source in sources):
        raise u.UpdateError("MODEL_ADMISSION_MIGRATION_EMPTY")
    source = "\n".join(sources)
    checksums = {_release: hashlib.sha256(value.encode()).hexdigest()
                 for value, (_path, _checksum, _release) in zip(sources, MIGRATIONS)}
    checksums_json = json.dumps(checksums, separators=(",", ":")).replace("'", "''")
    markers_json = json.dumps(FUNCTION_MARKERS, separators=(",", ":")).replace("'", "''")
    delimiter = "$model_admission_payload$"
    while delimiter in source:
        delimiter = delimiter[:-1] + "_$"
    return """BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL search_path=pg_catalog;
SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='15s';
SELECT pg_advisory_xact_lock(hashtextextended('tenderdesk.model-admission.release',0));
DO $model_admission_release$
DECLARE r record; target text; marker text; receipt text; receipt_count int:=0; row_count bigint; row_digest text;
 relations_before text[]; functions_before text[]; objects_before oid[]; state jsonb; rows_before jsonb;
 authority jsonb; authority_before jsonb; structure jsonb; structure_before jsonb;
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'MODEL_ADMISSION_DATABASE_MISMATCH'; END IF;
 IF to_regclass('app_private.application_release_history') IS NULL THEN RAISE EXCEPTION 'MODEL_ADMISSION_PRIOR_RELEASE_MISSING'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__PRIOR_RELEASE__' AND migration_sha256='__PRIOR_CHECKSUM__')
  OR NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__AI_RELEASE__' AND migration_sha256='__AI_CHECKSUM__')
 THEN RAISE EXCEPTION 'MODEL_ADMISSION_PRIOR_RELEASE_MISMATCH'; END IF;
 FOR r IN SELECT key,value FROM jsonb_each_text('__CHECKSUMS__'::jsonb) LOOP
  SELECT migration_sha256 INTO receipt FROM app_private.application_release_history WHERE release=r.key FOR UPDATE;
  IF receipt IS NOT NULL THEN
   IF receipt<>r.value THEN RAISE EXCEPTION 'MODEL_ADMISSION_RELEASE_CHECKSUM_MISMATCH'; END IF;
   receipt_count:=receipt_count+1;
  END IF;
 END LOOP;
 IF receipt_count NOT IN (0,2) THEN RAISE EXCEPTION 'MODEL_ADMISSION_PARTIAL_BATCH_LEDGER'; END IF;
 FOREACH target IN ARRAY __EXISTING__ LOOP
  IF to_regprocedure(target) IS NULL THEN RAISE EXCEPTION 'MODEL_ADMISSION_FUNCTION_MISSING'; END IF;
 END LOOP;
 IF receipt_count=0 THEN
  IF to_regclass('__NEW_TABLE__') IS NOT NULL THEN RAISE EXCEPTION 'MODEL_ADMISSION_UNTRACKED_SCHEMA'; END IF;
  SELECT array_agg(format('%I.%I',schemaname,tablename) ORDER BY schemaname,tablename) INTO relations_before
   FROM pg_tables WHERE schemaname IN ('public','app_private');
  SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) INTO functions_before
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app_private') AND p.prokind='f';
  SELECT array_agg(c.oid) INTO objects_before FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','app_private');
__ROWS__
  rows_before:=state;
__AUTHORITY__
  authority_before:=authority;
__STRUCTURE__
  structure_before:=structure;
  EXECUTE __DELIMITER____PAYLOAD____DELIMITER__;
__ROWS__
  IF state IS DISTINCT FROM rows_before THEN RAISE EXCEPTION 'MODEL_ADMISSION_EXISTING_ROWS_CHANGED'; END IF;
__AUTHORITY__
  IF authority IS DISTINCT FROM authority_before THEN RAISE EXCEPTION 'MODEL_ADMISSION_EXISTING_AUTHORITY_CHANGED'; END IF;
__STRUCTURE__
  IF structure IS DISTINCT FROM structure_before THEN RAISE EXCEPTION 'MODEL_ADMISSION_EXISTING_STRUCTURE_CHANGED'; END IF;
  IF EXISTS(SELECT 1 FROM pg_tables WHERE schemaname IN ('public','app_private')
    AND format('%I.%I',schemaname,tablename)<>ALL(relations_before||ARRAY['__NEW_TABLE__']))
   OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app_private') AND p.prokind='f'
    AND p.oid::regprocedure::text<>ALL(functions_before))
   OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','app_private') AND c.oid<>ALL(objects_before)
     AND c.oid<>to_regclass('__NEW_TABLE__')
     AND NOT EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=c.oid AND i.indrelid=to_regclass('__NEW_TABLE__')))
  THEN RAISE EXCEPTION 'MODEL_ADMISSION_UNEXPECTED_SCHEMA'; END IF;
  IF EXISTS(SELECT 1 FROM __NEW_TABLE__) THEN RAISE EXCEPTION 'MODEL_ADMISSION_INITIAL_CURSOR_NOT_EMPTY'; END IF;
  INSERT INTO app_private.application_release_history(release,migration_sha256)
   SELECT key,value FROM jsonb_each_text('__CHECKSUMS__'::jsonb);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('__NEW_TABLE__')
   AND relowner='tdp_app_owner'::regrole AND relrowsecurity)
  OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='app_private' AND tablename='queue_model_admission_state')
  OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   WHERE c.oid=to_regclass('__NEW_TABLE__') AND a.grantee<>c.relowner)
 THEN RAISE EXCEPTION 'MODEL_ADMISSION_CURSOR_AUTHORITY_INVALID'; END IF;
 FOR r IN SELECT key,value FROM jsonb_each('__MARKERS__'::jsonb) LOOP
  target:=r.key;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(target) AND proowner='tdp_app_owner'::regrole
    AND prosecdef AND proconfig=ARRAY['search_path=""']::text[])
  THEN RAISE EXCEPTION 'MODEL_ADMISSION_FUNCTION_AUTHORITY_INVALID'; END IF;
  FOR marker IN SELECT jsonb_array_elements_text(r.value) LOOP
   IF position(marker IN pg_get_functiondef(target::regprocedure))=0
   THEN RAISE EXCEPTION 'MODEL_ADMISSION_FUNCTION_PATCH_INVALID'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=to_regprocedure(target) AND a.grantee=0 AND a.privilege_type='EXECUTE')
  THEN RAISE EXCEPTION 'MODEL_ADMISSION_PUBLIC_EXECUTE'; END IF;
  FOR marker IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','tdp_app_anon','tdp_app_authenticated') LOOP
   IF has_function_privilege(marker,target,'EXECUTE') THEN RAISE EXCEPTION 'MODEL_ADMISSION_BROWSER_EXECUTE'; END IF;
  END LOOP;
 END LOOP;
END $model_admission_release$;
NOTIFY pgrst,'reload schema'; COMMIT;
""".replace("__ROWS__", prior.ROW_SNAPSHOT).replace("__AUTHORITY__", prior.AUTHORITY_SNAPSHOT).replace(
        "__STRUCTURE__", STRUCTURE_SNAPSHOT).replace("__EXISTING__", prior.sql_array(FUNCTION_MARKERS)).replace(
        "__NEW_TABLE__", NEW_TABLE).replace("__MARKERS__", markers_json).replace("__PRIOR_RELEASE__", prior.RELEASE).replace(
        "__PRIOR_CHECKSUM__", prior.MIGRATION_SHA256).replace("__AI_RELEASE__", prior.PRIOR_RELEASE).replace(
        "__AI_CHECKSUM__", prior.PRIOR_CHECKSUM).replace("__CHECKSUMS__", checksums_json).replace(
        "__DELIMITER__", delimiter).replace("__PAYLOAD__", source)


def verify_unchanged(before, retained):
    if runtime.workload_snapshot() != before:
        raise u.UpdateError("MODEL_ADMISSION_WORKLOAD_CHANGED")
    if runtime.retained_configuration() != retained:
        raise u.UpdateError("MODEL_ADMISSION_CONFIGURATION_CHANGED")
    for name in runtime.RUNTIME_COMPONENTS:
        if code.image_of(u.deployment(name)) != RUNTIME:
            raise u.UpdateError("MODEL_ADMISSION_RUNTIME_BASELINE_MISMATCH")
    if code.image_of(u.deployment("frontend")) != code.FRONTEND:
        raise u.UpdateError("MODEL_ADMISSION_FRONTEND_BASELINE_MISMATCH")


def migrate(pod):
    state = u.d.restore_state(pod)
    marker = u.owned("configmap", "database-restoration").get("data", {})
    if not state or state.get("stage") != "seed" or any(marker.get(key) != state[key] for key in ("schema_sha256", "seed_sha256")):
        raise u.UpdateError("UPDATE_EXISTING_RESTORATION_REQUIRED")
    u.d.sql(pod, (u.d.ASSETS / "check-compatible.sql").read_text())
    u.d.sql(pod, migration_script())
    emit("schema_verified", migrations={path.name: checksum for path, checksum, _release in MIGRATIONS},
         existing_rows_preserved=True, existing_authorities_preserved=True,
         existing_structures_preserved=True, jobs_claimed=False, processing_retried=False)


def update():
    if (not re.fullmatch(r"[a-f0-9]{40}", os.environ.get("GITHUB_SHA", ""))
            or not re.fullmatch(r"[0-9]{1,20}", os.environ.get("GITHUB_RUN_ID", ""))
            or not re.fullmatch(r"[0-9]{1,6}", os.environ.get("GITHUB_RUN_ATTEMPT", ""))):
        raise u.UpdateError("MODEL_ADMISSION_RUN_IDENTITY_REQUIRED")
    verify_source()
    u.d.probe.validate_cluster()
    before, retained = runtime.workload_snapshot(), runtime.retained_configuration()
    configuration = u.owned("configmap", "frontend-config")
    verify_unchanged(before, retained)
    core = u.d.decode_secret(u.owned("secret", "tenderdesk-core"))
    credentials, ca = u.d.probe.target_credentials(os.environ.get("DIGITALOCEAN_ACCESS_TOKEN", ""))
    if not core or not hmac.compare_digest(core.get("PGSSLCA", ""), ca):
        raise u.UpdateError("UPDATE_DATABASE_CA_CHANGED")
    pod = "migration-client-" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
    if u.d.get("secret", "tenderdesk-migration-admin") is not None or u.d.get("pod", pod) is not None:
        raise u.UpdateError("MODEL_ADMISSION_OTHER_ADMIN_IN_PROGRESS")
    schema_attempted = schema_verified = False
    try:
        u.d.sql_pod({**credentials, "APP_DATABASE": u.d.DATABASE, "ROLE_PREFIX": u.d.PREFIX})
        verify_unchanged(before, retained)
        schema_attempted = True
        migrate(pod)
        schema_verified = True
        code.public_check(configuration)
        verify_unchanged(before, retained)
    except Exception:
        emit("verification_incomplete", automatic_rollback=False, exact_release_replay_required=schema_attempted,
             schema_attempted=schema_attempted, schema_verified=schema_verified, runtime_images_changed=False)
        raise
    finally:
        u.d.cleanup_administrator(pod)
    verify_unchanged(before, retained)
    emit("passed", source_revision=os.environ["GITHUB_SHA"], runtime_image=RUNTIME,
         frontend_image=code.FRONTEND, deployments_updated=[], configuration_preserved=True,
         all_workloads_preserved=True, migrations={path.name: checksum for path, checksum, _release in MIGRATIONS},
         jobs_claimed=False, processing_retried=False, children_created=False)


def main():
    directory = None
    result = 0
    try:
        verify_source()
        if not re.fullmatch(r"[a-f0-9]{40}", os.environ.get("GITHUB_SHA", "")):
            raise u.UpdateError("MODEL_ADMISSION_RUN_IDENTITY_REQUIRED")
        directory = access.prepare_cluster()
        update()
    except Exception as error:
        value = getattr(error, "code", str(error))
        emit("blocked", code=value if re.fullmatch(r"[A-Z_]{1,100}", value) else "MODEL_ADMISSION_UPDATE_FAILED")
        result = 1
    finally:
        if directory is not None:
            try:
                shutil.rmtree(directory)
                emit("runner_files_removed")
            except OSError:
                emit("blocked", code="RUNNER_CLEANUP_NOT_CONFIRMED")
                result = 1
    return result


if __name__ == "__main__":
    sys.exit(main())
