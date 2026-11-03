#!/usr/bin/env python3
"""Install the reviewed verifier-recheck runtime and one atomic migration.

Deployment never requests a recheck or creates a child job. Existing rows and
authorities remain unchanged; ambiguous outcomes retain compatible code and an
idempotent migration receipt for forward completion.
"""
from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("verifier_recheck_release_base", HERE / "model-validation-update.py")
code = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = code
SPEC.loader.exec_module(code)
code.BASE_RUNTIME = code.u.REGISTRY + "runtime@sha256:871c2f80e9b2241bf53268b0b9d867ea5c46f4f355da822c7c9ec516b1fe59fb"
code.ROLLOUT_MARKER = "tenderdesk-deployment/verifier-recheck-image"
runtime, u = code.runtime, code.u
MIGRATION = u.d.ROOT / "supabase/migrations/20261103022500_analysis_verifier_recheck.sql"
MIGRATION_SHA256 = "cead30c43776e35822e4fa63476223a5ff4abe8de35218286d66dd5bd8c22382"
RELEASE = "analysis-verifier-recheck-v1"
PRIOR_RELEASE = "ai-execution-reliability-v1"
PRIOR_CHECKSUM = "0353c429634df4f9ed3429074e8ff027ef7151b66edffdc467dae08ecb2f8f4b"
NEW_TABLE = "app_private.analysis_verifier_rechecks"
NEW_FUNCTIONS = (
    "app_private.analysis_recheck_binding(uuid)",
    "app_private.recheck_analysis_verifier(jsonb,text)",
    "app_private.guard_analysis_recheck_graph(uuid,text,text,jsonb)",
    "app_private.guard_analysis_recheck_request(uuid,text,text)",
    "app_private.guard_analysis_recheck_reservation(uuid,uuid,text,text,uuid,uuid)",
)
FUNCTION_MARKERS = {
    "app_private.check_requested_model_payload(uuid,text,jsonb)": "analysis_recheck_binding",
    "public.model_graph_store(uuid,uuid,text,text,jsonb)": "guard_analysis_recheck_graph",
    "public.prepare_task_model_route(uuid,uuid,text,jsonb,text)": "guard_analysis_recheck_request",
    "public.start_task_model_attempt(uuid,uuid,uuid,uuid,text)": "guard_analysis_recheck_request",
    "public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)": "guard_analysis_recheck_reservation",
    "public.resume_task_model_request_phase(uuid,uuid,text,jsonb,uuid,uuid,text)": "guard_analysis_recheck_request",
    "public.resume_task_model_request(uuid,uuid,text,jsonb,uuid,uuid)": "guard_analysis_recheck_request",
    "public.resume_model_request(uuid,uuid,text,text,jsonb)": "guard_analysis_recheck_request",
    "public.prepare_model_routing(uuid,uuid,jsonb)": "guard_analysis_recheck_request",
    "public.model_preflight(uuid,uuid,jsonb)": "guard_analysis_recheck_request",
    "public.model_preflight_core(uuid,uuid,jsonb)": "guard_analysis_recheck_request",
    "public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text)": "guard_analysis_recheck_request",
    "public.start_model_attempt(uuid,uuid,text,text,text,text)": "guard_analysis_recheck_request",
    "public.record_model_request_metadata(bigint,uuid,jsonb)": "parent_writer",
}

# The relation list is captured before DDL. New empty lineage is checked
# separately; every old public/private row, including paid work and the old
# release ledger, is compared inside the same repeatable-read transaction.
ROW_SNAPSHOT = """
 state:='{}'::jsonb;
 FOREACH target IN ARRAY relations_before LOOP
  EXECUTE format('SELECT count(*)::bigint,md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM %s x',target)
   INTO row_count,row_digest;
  state:=state||jsonb_build_object(target,jsonb_build_object('count',row_count,'digest',row_digest));
 END LOOP;
"""
AUTHORITY_SNAPSHOT = """
 SELECT jsonb_build_object(
  'functions',(SELECT jsonb_object_agg(p.oid::regprocedure::text,jsonb_build_object(
    'owner',p.proowner,'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig,
    'unmodified_body',CASE WHEN p.oid::regprocedure::text=ANY(__EXISTING__) THEN NULL ELSE md5(pg_get_functiondef(p.oid)) END))
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN ('public','app_private') AND p.prokind='f'
    AND p.oid::regprocedure::text=ANY(functions_before)),
  'tables',(SELECT jsonb_object_agg(c.oid::regclass::text,jsonb_build_object(
    'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity))
   FROM pg_class c WHERE c.oid::regclass::text=ANY(relations_before)),
  'policies',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.schemaname,p.tablename,p.policyname),'[]'::jsonb)
   FROM pg_policies p WHERE format('%I.%I',p.schemaname,p.tablename)=ANY(relations_before))
 ) INTO authority;
"""


def emit(status, **values):
    print(json.dumps({"update": "verifier_recheck", "release": RELEASE, "status": status, **values}, sort_keys=True), flush=True)


def verify_source():
    code.verify_source()
    if not MIGRATION.is_file() or hashlib.sha256(MIGRATION.read_bytes()).hexdigest() != MIGRATION_SHA256:
        raise u.UpdateError("VERIFIER_RECHECK_MIGRATION_SOURCE_CHANGED")


def sql_array(values):
    return "ARRAY[" + ",".join("'" + value.replace("'", "''") + "'" for value in values) + "]::text[]"


def migration_script(source=None):
    if source is None:
        source = MIGRATION.read_bytes().decode("utf-8")
        if hashlib.sha256(source.encode()).hexdigest() != MIGRATION_SHA256:
            raise u.UpdateError("VERIFIER_RECHECK_MIGRATION_SOURCE_CHANGED")
    if not source.strip():
        raise u.UpdateError("VERIFIER_RECHECK_MIGRATION_EMPTY")
    checksum = hashlib.sha256(source.encode()).hexdigest()
    delimiter = "$verifier_recheck_payload$"
    while delimiter in source:
        delimiter = delimiter[:-1] + "_$"
    markers = json.dumps(FUNCTION_MARKERS, separators=(",", ":")).replace("'", "''")
    return """BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL search_path=pg_catalog;
SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='15s';
SELECT pg_advisory_xact_lock(hashtextextended('tenderdesk.verifier-recheck.release',0));
DO $verifier_recheck_release$
DECLARE r record; target text; prior text; row_count bigint; row_digest text;
 relations_before text[]; functions_before text[]; state jsonb; rows_before jsonb;
 authority jsonb; authority_before jsonb; definition text;
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'VERIFIER_RECHECK_DATABASE_MISMATCH'; END IF;
 IF to_regclass('app_private.application_release_history') IS NULL THEN RAISE EXCEPTION 'VERIFIER_RECHECK_PRIOR_RELEASE_MISSING'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app_private.application_release_history WHERE release='__PRIOR_RELEASE__' AND migration_sha256='__PRIOR_CHECKSUM__')
 THEN RAISE EXCEPTION 'VERIFIER_RECHECK_PRIOR_RELEASE_MISMATCH'; END IF;
 SELECT migration_sha256 INTO prior FROM app_private.application_release_history WHERE release='__RELEASE__' FOR UPDATE;
 IF prior IS NOT NULL AND prior<>'__CHECKSUM__' THEN RAISE EXCEPTION 'VERIFIER_RECHECK_RELEASE_CHECKSUM_MISMATCH'; END IF;
 FOREACH target IN ARRAY __EXISTING__ LOOP
  IF to_regprocedure(target) IS NULL THEN RAISE EXCEPTION 'VERIFIER_RECHECK_FUNCTION_MISSING'; END IF;
 END LOOP;
 IF prior IS NULL THEN
  IF to_regclass('__NEW_TABLE__') IS NOT NULL OR EXISTS(
   SELECT 1 FROM unnest(__NEW_FUNCTIONS__) AS f(signature) WHERE to_regprocedure(f.signature) IS NOT NULL)
  THEN RAISE EXCEPTION 'VERIFIER_RECHECK_UNTRACKED_SCHEMA'; END IF;
  SELECT array_agg(format('%I.%I',schemaname,tablename) ORDER BY schemaname,tablename) INTO relations_before
   FROM pg_tables WHERE schemaname IN ('public','app_private');
  SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) INTO functions_before
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app_private') AND p.prokind='f';
__ROWS__
  rows_before:=state;
__AUTHORITY__
  authority_before:=authority;
  EXECUTE __DELIMITER____PAYLOAD____DELIMITER__;
__ROWS__
  IF state IS DISTINCT FROM rows_before THEN RAISE EXCEPTION 'VERIFIER_RECHECK_EXISTING_ROWS_CHANGED'; END IF;
__AUTHORITY__
  IF authority IS DISTINCT FROM authority_before THEN RAISE EXCEPTION 'VERIFIER_RECHECK_EXISTING_AUTHORITY_CHANGED'; END IF;
  IF EXISTS(SELECT 1 FROM pg_tables WHERE schemaname IN ('public','app_private')
    AND format('%I.%I',schemaname,tablename)<>ALL(relations_before||ARRAY['__NEW_TABLE__']))
   OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app_private') AND p.prokind='f'
    AND p.oid::regprocedure::text<>ALL(functions_before||__NEW_FUNCTIONS__))
  THEN RAISE EXCEPTION 'VERIFIER_RECHECK_UNEXPECTED_SCHEMA'; END IF;
  IF EXISTS(SELECT 1 FROM __NEW_TABLE__) THEN RAISE EXCEPTION 'VERIFIER_RECHECK_CHILD_ACTIVATION_FORBIDDEN'; END IF;
  INSERT INTO app_private.application_release_history(release,migration_sha256) VALUES('__RELEASE__','__CHECKSUM__');
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('__NEW_TABLE__')
   AND relowner='tdp_app_owner'::regrole AND relrowsecurity)
  OR EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='app_private' AND tablename='analysis_verifier_rechecks')
  OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   WHERE c.oid=to_regclass('__NEW_TABLE__') AND a.grantee<>c.relowner)
 THEN RAISE EXCEPTION 'VERIFIER_RECHECK_LINEAGE_AUTHORITY_INVALID'; END IF;
 FOREACH target IN ARRAY __NEW_FUNCTIONS__ LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(target) AND proowner='tdp_app_owner'::regrole
   AND prosecdef AND proconfig=ARRAY['search_path=""']::text[])
   OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid=to_regprocedure(target) AND a.grantee<>p.proowner)
  THEN RAISE EXCEPTION 'VERIFIER_RECHECK_PRIVATE_FUNCTION_AUTHORITY_INVALID'; END IF;
 END LOOP;
 FOR r IN SELECT key,value FROM jsonb_each_text('__MARKERS__'::jsonb) LOOP
  definition:=pg_get_functiondef(r.key::regprocedure);
  IF position(r.value IN definition)=0 THEN RAISE EXCEPTION 'VERIFIER_RECHECK_FUNCTION_PATCH_MISSING'; END IF;
 END LOOP;
 IF position('recheck_seed' IN pg_get_functiondef('public.model_graph_store(uuid,uuid,text,text,jsonb)'::regprocedure))=0
 THEN RAISE EXCEPTION 'VERIFIER_RECHECK_SEED_ACTION_MISSING'; END IF;
 FOREACH target IN ARRAY __EXISTING__||__NEW_FUNCTIONS__ LOOP
  IF EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=to_regprocedure(target) AND a.grantee=0 AND a.privilege_type='EXECUTE')
  THEN RAISE EXCEPTION 'VERIFIER_RECHECK_PUBLIC_EXECUTE'; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','tdp_app_anon','tdp_app_authenticated') LOOP
   IF has_function_privilege(r.rolname,target,'EXECUTE') THEN RAISE EXCEPTION 'VERIFIER_RECHECK_BROWSER_EXECUTE'; END IF;
  END LOOP;
 END LOOP;
END $verifier_recheck_release$;
NOTIFY pgrst,'reload schema'; COMMIT;
""".replace("__ROWS__", ROW_SNAPSHOT).replace("__AUTHORITY__", AUTHORITY_SNAPSHOT).replace(
        "__EXISTING__", sql_array(FUNCTION_MARKERS)).replace("__NEW_FUNCTIONS__", sql_array(NEW_FUNCTIONS)).replace(
        "__NEW_TABLE__", NEW_TABLE).replace("__MARKERS__", markers).replace("__PRIOR_RELEASE__", PRIOR_RELEASE).replace(
        "__PRIOR_CHECKSUM__", PRIOR_CHECKSUM).replace("__RELEASE__", RELEASE).replace("__CHECKSUM__", checksum).replace(
        "__DELIMITER__", delimiter).replace("__PAYLOAD__", source)


def migrate(pod):
    state = u.d.restore_state(pod)
    marker = u.owned("configmap", "database-restoration").get("data", {})
    if not state or state.get("stage") != "seed" or any(marker.get(key) != state[key] for key in ("schema_sha256", "seed_sha256")):
        raise u.UpdateError("UPDATE_EXISTING_RESTORATION_REQUIRED")
    u.d.sql(pod, (u.d.ASSETS / "check-compatible.sql").read_text())
    u.d.sql(pod, migration_script())
    emit("schema_verified", migration=MIGRATION.name, migration_sha256=MIGRATION_SHA256,
         existing_rows_preserved=True, existing_authorities_preserved=True, children_created=False)


def update():
    selected = u.image(os.environ.get("TENDERDESK_RUNTIME_IMAGE", ""), "runtime")
    if (not re.fullmatch(r"[a-f0-9]{40}", os.environ.get("GITHUB_SHA", ""))
            or not re.fullmatch(r"[0-9]{1,20}", os.environ.get("GITHUB_RUN_ID", ""))
            or not re.fullmatch(r"[0-9]{1,6}", os.environ.get("GITHUB_RUN_ATTEMPT", ""))):
        raise u.UpdateError("VERIFIER_RECHECK_RUN_IDENTITY_REQUIRED")
    if selected == code.BASE_RUNTIME:
        raise u.UpdateError("VERIFIER_RECHECK_NEW_RUNTIME_REQUIRED")
    verify_source()
    u.d.probe.validate_cluster()
    original = {name: u.deployment(name, ready=False) for name in runtime.RUNTIME_COMPONENTS}
    if any(code.image_of(value) not in (code.BASE_RUNTIME, selected) for value in original.values()):
        raise u.UpdateError("VERIFIER_RECHECK_RUNTIME_BASELINE_MISMATCH")
    if code.image_of(u.deployment("frontend")) != code.FRONTEND:
        raise u.UpdateError("VERIFIER_RECHECK_FRONTEND_BASELINE_MISMATCH")
    original["worker"] = code.worker_baseline(original["worker"], selected)
    before, retained = runtime.workload_snapshot(), runtime.retained_configuration()
    configuration = u.owned("configmap", "frontend-config")
    code.verify_unchanged(before, retained)
    core = u.d.decode_secret(u.owned("secret", "tenderdesk-core"))
    credentials, ca = u.d.probe.target_credentials(os.environ.get("DIGITALOCEAN_ACCESS_TOKEN", ""))
    if not core or not hmac.compare_digest(core.get("PGSSLCA", ""), ca):
        raise u.UpdateError("UPDATE_DATABASE_CA_CHANGED")
    if u.d.get("secret", "tenderdesk-migration-admin") is not None:
        raise u.UpdateError("VERIFIER_RECHECK_OTHER_ADMIN_IN_PROGRESS")
    pod = "migration-client-" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
    attempted = schema_attempted = schema_verified = False
    try:
        u.d.sql_pod({**credentials, "APP_DATABASE": u.d.DATABASE, "ROLE_PREFIX": u.d.PREFIX})
        attempted = True
        runtime.patch_runtime("api", selected, original["api"], code.image_of(original["api"]))
        u.d.wait_deployments(["api"])
        code.patch_worker_strategy(original["worker"], selected, True)
        code.patch_worker_image(original["worker"], selected)
        u.d.wait_deployments(["worker"])
        runtime.wait_runtime_drain(selected)
        code.verify_runtime(original, selected, transition=True)
        code.verify_unchanged(before, retained)
        schema_attempted = True
        migrate(pod)
        schema_verified = True
        code.public_check(configuration)
        code.verify_runtime(original, selected, transition=True)
        code.verify_unchanged(before, retained)
        code.patch_worker_strategy(original["worker"], selected, False)
        u.d.wait_deployments(["worker"])
        code.verify_runtime(original, selected)
        code.verify_unchanged(before, retained)
    except Exception:
        if attempted:
            emit("compatible_runtime_retained", automatic_rollback=False, forward_completion_required=True,
                 rollout_may_be_partial=True, candidate_image=selected,
                 schema_attempted=schema_attempted, schema_verified=schema_verified)
        raise
    finally:
        u.d.cleanup_administrator(pod)
    emit("passed", source_revision=os.environ["GITHUB_SHA"], runtime_image=selected,
         frontend_image=code.FRONTEND, deployments_updated=list(runtime.RUNTIME_COMPONENTS),
         other_workloads_preserved=True, configuration_preserved=True,
         migration=MIGRATION.name, migration_sha256=MIGRATION_SHA256,
         old_workers_drained_before_schema=True, processing_retried=False, children_created=False)


def main():
    try:
        update()
        return 0
    except Exception as error:
        value = getattr(error, "code", str(error))
        emit("blocked", code=value if re.fullmatch(r"[A-Z_]{1,100}", value) else "VERIFIER_RECHECK_UPDATE_FAILED")
        return 1


if __name__ == "__main__":
    sys.exit(main())
