#!/usr/bin/env python3
"""Release the reviewed AI fixes to API/worker without changing saved work.

Only the two named function migrations and two immutable workload images are
selected. Credentials and database snapshots stay in memory or in the existing
temporary SQL client. No recovery command or inference is invoked by this file.
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
import time

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("ai_reliability_release_base", HERE / "flexible-proposal-inputs-update.py")
base = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = base
SPEC.loader.exec_module(base)
u = base.u
RUNTIME_COMPONENTS = ("api", "worker")
MIGRATIONS = tuple(u.d.ROOT / "supabase/migrations" / name for name in (
    "20261102231710_writer_handoff_usage_blocker.sql",
    "20261102231721_terminal_background_request_lifecycle.sql",
))
RELEASE = "ai-execution-reliability-v1"
FUNCTIONS = (
    "app_private.writer_validation_handoff(uuid,uuid,text,jsonb)",
    "public.resume_model_request(uuid,uuid,text,text,jsonb)",
    "public.resume_task_model_request(uuid,uuid,text,jsonb,uuid,uuid)",
    "public.resume_task_model_request_phase(uuid,uuid,text,jsonb,uuid,uuid,text)",
    "public.claim_abandoned_model_request()",
)


def emit(status, **values):
    print(json.dumps({"update": "ai_reliability", "status": status, **values}, sort_keys=True), flush=True)


def migration_script(migrations=None):
    sources = [path.read_text() for path in MIGRATIONS] if migrations is None else migrations
    if len(sources) != len(MIGRATIONS) or any(not value.strip() for value in sources):
        raise u.UpdateError("AI_RELIABILITY_MIGRATION_SET_INVALID")
    manifest = [{"name": path.name, "sha256": hashlib.sha256(value.encode()).hexdigest()}
                for path, value in zip(MIGRATIONS, sources)]
    checksum = hashlib.sha256(json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    payload = "\n".join(sources)
    delimiter = "$ai_reliability_payload$"
    while delimiter in payload:
        delimiter = delimiter[:-1] + "_$"
    targets = "ARRAY[" + ",".join("'" + name + "'" for name in FUNCTIONS) + "]::text[]"
    return """BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='15s';
SELECT pg_advisory_xact_lock(hashtextextended('tenderdesk.ai-reliability.release',0));
CREATE TABLE IF NOT EXISTS app_private.application_release_history (
 release text PRIMARY KEY, migration_sha256 text NOT NULL CHECK(migration_sha256 ~ '^[a-f0-9]{64}$'),
 applied_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE app_private.application_release_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.application_release_history FROM PUBLIC;
DO $ai_reliability_release$
DECLARE r record; n bigint; row_digest text; state jsonb; before_state jsonb;
 prior text; target text; definition text; grants_before jsonb; grants_after jsonb;
BEGIN
 IF current_database()<>'tenderdesk_app'
 THEN RAISE EXCEPTION 'AI_RELIABILITY_DATABASE_MISMATCH'; END IF;
 FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN
  ('anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service')
 LOOP EXECUTE format('REVOKE ALL ON app_private.application_release_history FROM %I',r.rolname); END LOOP;
 FOREACH target IN ARRAY __TARGETS__ LOOP
  IF to_regprocedure(target) IS NULL THEN RAISE EXCEPTION 'AI_RELIABILITY_FUNCTION_MISSING'; END IF;
 END LOOP;
 SELECT jsonb_object_agg(t.signature,jsonb_build_object('owner',p.proowner,'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig))
 INTO grants_before FROM unnest(__TARGETS__) t(signature) JOIN pg_proc p ON p.oid=t.signature::regprocedure;
 SELECT migration_sha256 INTO prior FROM app_private.application_release_history
  WHERE release='__RELEASE__' FOR UPDATE;
 IF prior IS NOT NULL AND prior<>'__CHECKSUM__' THEN
  RAISE EXCEPTION 'AI_RELIABILITY_RELEASE_CHECKSUM_MISMATCH'; END IF;
 IF prior IS NULL THEN
__SNAPSHOT__
 before_state:=state;
 EXECUTE __DELIMITER____PAYLOAD____DELIMITER__;
__SNAPSHOT__
 IF before_state IS DISTINCT FROM state THEN
  RAISE EXCEPTION 'AI_RELIABILITY_EXISTING_DATA_CHANGED'; END IF;
 INSERT INTO app_private.application_release_history(release,migration_sha256)
  VALUES('__RELEASE__','__CHECKSUM__');
 END IF;
 SELECT jsonb_object_agg(t.signature,jsonb_build_object('owner',p.proowner,'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig))
 INTO grants_after FROM unnest(__TARGETS__) t(signature) JOIN pg_proc p ON p.oid=t.signature::regprocedure;
 IF grants_before IS DISTINCT FROM grants_after THEN
  RAISE EXCEPTION 'AI_RELIABILITY_FUNCTION_AUTHORITY_CHANGED'; END IF;
 FOREACH target IN ARRAY __TARGETS__ LOOP
  definition:=pg_get_functiondef(target::regprocedure);
  IF (target LIKE 'app_private.writer_%' AND position('then raise exception ''USAGE_REVIEW_REQUIRED'';end if;' IN definition)=0)
   OR (target NOT LIKE 'app_private.writer_%' AND position('PROVIDER_BACKGROUND_TERMINATED' IN definition)=0)
  THEN RAISE EXCEPTION 'AI_RELIABILITY_FUNCTION_PATCH_MISSING'; END IF;
  IF EXISTS(SELECT 1 FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid=target::regprocedure),acldefault('f',(SELECT proowner FROM pg_proc WHERE oid=target::regprocedure))))
   WHERE grantee=0 AND privilege_type='EXECUTE') THEN RAISE EXCEPTION 'AI_RELIABILITY_PUBLIC_EXECUTE'; END IF;
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','tdp_app_anon','tdp_app_authenticated') LOOP
   IF has_function_privilege(r.rolname,target,'EXECUTE') THEN RAISE EXCEPTION 'AI_RELIABILITY_BROWSER_EXECUTE'; END IF;
  END LOOP;
 END LOOP;
END $ai_reliability_release$;
NOTIFY pgrst,'reload schema'; COMMIT;
""".replace("__TARGETS__", targets).replace("__RELEASE__", RELEASE).replace("__CHECKSUM__", checksum).replace(
        "__SNAPSHOT__", base.SNAPSHOT_SQL).replace("__DELIMITER__", delimiter).replace("__PAYLOAD__", payload)


def migrate(pod):
    state = u.d.restore_state(pod)
    marker = u.owned("configmap", "database-restoration").get("data", {})
    if not state or state.get("stage") != "seed" or any(marker.get(k) != state[k] for k in ("schema_sha256", "seed_sha256")):
        raise u.UpdateError("UPDATE_EXISTING_RESTORATION_REQUIRED")
    u.d.sql(pod, (u.d.ASSETS / "check-compatible.sql").read_text())
    u.d.sql(pod, migration_script())
    emit("schema_verified", existing_rows_preserved=True, frozen_work_preserved=True)


def workload_snapshot():
    objects = json.loads(u.d.command(["get", "deployments", "-n", u.d.NAMESPACE, "-o", "json"]))["items"]
    return {obj["metadata"]["name"]: {"uid": obj["metadata"]["uid"], "spec": obj["spec"]} for obj in objects}


def retained_configuration():
    # Secret values are compared privately, never emitted to logs or artifacts.
    return {
        "schedules": {name: u.owned("cronjob", name)["spec"] for name in ("native-browser", "native-ocr")},
        "configuration": u.owned("configmap", "frontend-config").get("data"),
        "secrets": {name: {key: obj.get(key) for key in ("data", "type", "immutable")}
                    for name in ("tenderdesk-core", "tenderdesk-runtime") for obj in [u.owned("secret", name)]},
    }


def patch_runtime(name, selected, expected, from_image):
    current = u.deployment(name, ready=False)
    actual = current["spec"]["template"]["spec"]["containers"][0]["image"]
    if (current["metadata"].get("uid") != expected["metadata"].get("uid")
            or not current["metadata"].get("uid")
            or u.without_image(current) != u.without_image(expected)
            or actual not in (from_image, selected)):
        raise u.UpdateError("AI_RELIABILITY_CONCURRENT_WORKLOAD_CHANGE")
    if actual == selected:
        return
    operations = [
        {"op": "test", "path": "/metadata/uid", "value": current["metadata"]["uid"]},
        {"op": "test", "path": "/metadata/resourceVersion", "value": current["metadata"]["resourceVersion"]},
        {"op": "test", "path": "/spec/template/spec/containers/0/name", "value": name},
        {"op": "test", "path": "/spec/template/spec/containers/0/image", "value": from_image},
        {"op": "replace", "path": "/spec/template/spec/containers/0/image", "value": selected},
    ]
    u.d.command(["patch", "deployment", name, "-n", u.d.NAMESPACE, "--type=json", "--patch", json.dumps(operations)])


def wait_runtime_drain(expected, timeout=300):
    deadline = time.monotonic() + timeout
    while True:
        pending = False
        for name in RUNTIME_COMPONENTS:
            current = u.deployment(name)
            if current["spec"]["template"]["spec"]["containers"][0]["image"] != expected:
                raise u.UpdateError("AI_RELIABILITY_RUNTIME_CHANGED")
            for pod in base.runtime_pods(name, current):
                if (pod.get("status", {}).get("phase") not in ("Succeeded", "Failed")
                        and pod["spec"]["containers"][0]["image"] != expected):
                    pending = True
        if not pending:
            return
        if time.monotonic() >= deadline:
            raise u.UpdateError("AI_RELIABILITY_OLD_RUNTIME_NOT_DRAINED")
        time.sleep(3)


def update():
    runtime = u.image(os.environ.get("TENDERDESK_RUNTIME_IMAGE", ""), "runtime")
    if not re.fullmatch(r"[0-9]{1,20}", os.environ.get("GITHUB_RUN_ID", "")) or not re.fullmatch(r"[0-9]{1,6}", os.environ.get("GITHUB_RUN_ATTEMPT", "")):
        raise u.UpdateError("UPDATE_RUN_IDENTITY_REQUIRED")
    u.d.probe.validate_cluster()
    before = workload_snapshot()
    original = {name: u.deployment(name) for name in RUNTIME_COMPONENTS}
    retained = retained_configuration()
    configuration = u.owned("configmap", "frontend-config")
    core = u.d.decode_secret(u.owned("secret", "tenderdesk-core"))
    credentials, ca = u.d.probe.target_credentials(os.environ.get("DIGITALOCEAN_ACCESS_TOKEN", ""))
    if not core or not hmac.compare_digest(core.get("PGSSLCA", ""), ca):
        raise u.UpdateError("UPDATE_DATABASE_CA_CHANGED")
    if u.d.get("secret", "tenderdesk-migration-admin") is not None:
        raise u.UpdateError("AI_RELIABILITY_OTHER_ADMIN_IN_PROGRESS")
    pod = "migration-client-" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
    changed = []
    schema_attempted = schema_verified = False
    try:
        u.d.sql_pod({**credentials, "APP_DATABASE": u.d.DATABASE, "ROLE_PREFIX": u.d.PREFIX})
        try:
            for name in RUNTIME_COMPONENTS:
                changed.append(name)  # An ambiguous accepted patch also needs rollback.
                patch_runtime(name, runtime, original[name], original[name]["spec"]["template"]["spec"]["containers"][0]["image"])
            u.d.wait_deployments(list(RUNTIME_COMPONENTS))
            wait_runtime_drain(runtime)
            schema_attempted = True
            migrate(pod)
            schema_verified = True
            for name in RUNTIME_COMPONENTS:
                current = u.deployment(name)
                if (current["spec"]["template"]["spec"]["containers"][0]["image"] != runtime
                        or u.without_image(current) != u.without_image(original[name])):
                    raise u.UpdateError("UPDATE_WORKLOAD_ACCEPTANCE_FAILED")
            after = workload_snapshot()
            if set(before) != set(after) or any(before[name] != after[name] for name in before if name not in RUNTIME_COMPONENTS):
                raise u.UpdateError("AI_RELIABILITY_OTHER_WORKLOAD_CHANGED")
            if retained != retained_configuration():
                raise u.UpdateError("AI_RELIABILITY_CONFIGURATION_CHANGED")
            u.public_check(configuration, core)
        except Exception:
            # SQL may commit before a lost acknowledgement. Keep code compatible
            # with both schemas after any migration attempt; never reset history.
            failed = False
            if not schema_attempted:
                for name in reversed(changed):
                    try:
                        patch_runtime(name, original[name]["spec"]["template"]["spec"]["containers"][0]["image"], original[name], runtime)
                    except Exception:
                        failed = True
                if changed:
                    try:
                        u.d.wait_deployments(changed)
                    except Exception:
                        failed = True
            if failed:
                raise u.UpdateError("UPDATE_ROLLBACK_NOT_CONFIRMED") from None
            emit("compatible_runtime_retained" if schema_attempted else "runtime_images_rolled_back", schema_verified=schema_verified)
            raise
        emit("passed", deployments_updated=2, other_workloads_preserved=True, processing_retried=False)
    finally:
        u.d.cleanup_administrator(pod)


def main():
    u.update, u.emit = update, emit
    return u.main()


if __name__ == "__main__":
    sys.exit(main())
