#!/usr/bin/env python3
"""Release draft creation from flexible reference inputs without replaying older migrations.

The ordinary image updater supplies ownership, strict TLS, rollout, rollback and
cleanup guards. This entrypoint pins the flexible-input draft migration and
records its checksum atomically. It never resumes work or sends model requests.
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
import urllib.parse


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("flexible_input_base_update", HERE / "digitalocean-update.py")
u = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = u
SPEC.loader.exec_module(u)
MIGRATION = u.d.ROOT / "supabase/migrations/20261031202143_flexible_proposal_input_drafts.sql"
RELEASE = "flexible-proposal-inputs-v1"
ORIGINAL_PUBLIC_CHECK = u.public_check
GENERATION_MARKER = b"Generate proposal draft"
UPLOAD_MARKER = b"Upload reference files"

# Hash every existing public row, plus durable processing/accounting tables.
# Contents stay inside PostgreSQL; only equality is tested and no hash is logged.
# The release ledger is the sole intended data addition; frozen paid work remains intact.
SNAPSHOT_SQL = r"""
 state := '{}';
 FOR r IN SELECT schemaname,tablename FROM pg_catalog.pg_tables
  WHERE schemaname='public' OR (schemaname='app_private' AND tablename IN (
   'idempotency_records','generation_processing_requests','model_graph_threads','model_graph_checkpoints',
   'model_graph_writes','model_graph_results','model_graph_budgets'))
  ORDER BY schemaname,tablename
 LOOP
  EXECUTE format('SELECT count(*)::bigint,md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM %I.%I x',r.schemaname,r.tablename)
   INTO n,row_digest;
  state:=state||jsonb_build_object(r.schemaname||'.'||r.tablename,
   jsonb_build_object('count',n,'digest',row_digest));
 END LOOP;
"""


def emit(status, **values):
    print(json.dumps({"update": "flexible_inputs", "status": status, **values}, sort_keys=True), flush=True)


def migration_script(migration=None):
    migration = MIGRATION.read_text() if migration is None else migration
    if not migration.strip():
        raise u.UpdateError("FLEXIBLE_INPUTS_MIGRATION_EMPTY")
    checksum = hashlib.sha256(migration.encode("utf-8")).hexdigest()
    delimiter = "$flexible_inputs_payload$"
    while delimiter in migration:
        delimiter = delimiter[:-1] + "_$"
    return ("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL ROLE tdp_app_owner;\n"
            "SELECT pg_advisory_xact_lock(hashtextextended('tenderdesk.flexible-inputs.release',0));\n"
            "CREATE TABLE IF NOT EXISTS app_private.application_release_history (\n"
            " release text PRIMARY KEY, migration_sha256 text NOT NULL CHECK(migration_sha256 ~ '^[a-f0-9]{64}$'),\n"
            " applied_at timestamptz NOT NULL DEFAULT now());\n"
            "ALTER TABLE app_private.application_release_history ENABLE ROW LEVEL SECURITY;\n"
            "REVOKE ALL ON app_private.application_release_history FROM PUBLIC;\n"
            "DO $flexible_inputs_release$\n"
            "DECLARE r record; n bigint; row_digest text; state jsonb; before_state jsonb; prior text;\nBEGIN\n"
            " FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN\n"
            "  ('anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service')\n"
            " LOOP EXECUTE format('REVOKE ALL ON app_private.application_release_history FROM %I',r.rolname); END LOOP;\n"
            " SELECT migration_sha256 INTO prior FROM app_private.application_release_history\n"
            "  WHERE release='" + RELEASE + "' FOR UPDATE;\n"
            " IF prior IS NOT NULL AND prior<>'" + checksum + "' THEN\n"
            "  RAISE EXCEPTION 'FLEXIBLE_INPUTS_RELEASE_CHECKSUM_MISMATCH'; END IF;\n"
            " IF prior IS NULL THEN\n" + SNAPSHOT_SQL + " before_state:=state;\n"
            " EXECUTE " + delimiter + migration + delimiter + ";\n" + SNAPSHOT_SQL + """
  IF before_state IS DISTINCT FROM state THEN
   RAISE EXCEPTION 'FLEXIBLE_INPUTS_EXISTING_DATA_CHANGED'; END IF;
""" + " INSERT INTO app_private.application_release_history(release,migration_sha256)\n"
            "  VALUES('" + RELEASE + "','" + checksum + "');\n END IF;\n" + """
 IF to_regprocedure('app_private.seal_draft_package(uuid,uuid,uuid)') IS NULL
 OR to_regprocedure('app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb)') IS NULL
 OR to_regprocedure('app_private.approval_gate_before_flexible_inputs(uuid,uuid)') IS NULL
 THEN RAISE EXCEPTION 'FLEXIBLE_INPUTS_SCHEMA_INCOMPLETE'; END IF;
 IF position('draft_input_version' in pg_get_functiondef('app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb)'::regprocedure))=0
 OR position('draft_generation_snapshot' in pg_get_functiondef('app_private.generation_command(text,jsonb,text)'::regprocedure))=0
 OR position('draft_generation_snapshot' in pg_get_functiondef('app_private.refresh_proposal_evidence(uuid)'::regprocedure))=0
 OR position('approval_gate_before_flexible_inputs' in pg_get_functiondef('app_private.approval_gate(uuid,uuid)'::regprocedure))=0
 THEN RAISE EXCEPTION 'FLEXIBLE_INPUTS_WORKFLOW_INCOMPLETE'; END IF;
END $flexible_inputs_release$;
NOTIFY pgrst,'reload schema'; COMMIT;
""")


def migrate(pod):
    state = u.d.restore_state(pod)
    marker = u.owned("configmap", "database-restoration").get("data", {})
    if not state or state.get("stage") != "seed" or any(marker.get(k) != state[k] for k in ("schema_sha256", "seed_sha256")):
        raise u.UpdateError("UPDATE_EXISTING_RESTORATION_REQUIRED")
    u.d.sql(pod, (u.d.ASSETS / "check-compatible.sql").read_text())
    u.d.sql(pod, migration_script())
    emit("flexible_inputs_schema_verified", business_records_preserved=True, processing_retried=False, existing_frozen_work_preserved=True)


def public_check(configuration, core):
    ORIGINAL_PUBLIC_CHECK(configuration, core)
    expected = u.smoke.javascript_config(configuration["data"]["runtime-config.js"].encode())
    client = u.smoke.Client(u.smoke.Config(expected["appOrigin"], core["ANON_KEY"], core["SERVICE_KEY"], core["JWT_SECRET"]))
    root = client.request("/")
    pending = [(expected["appOrigin"] + "/", x.decode()) for x in
               re.findall(rb'<script[^>]+src=["\']([^"\']+\.js)["\']', root.body)[:3]]
    seen, settings, generation, opportunity = set(), b"", b"", b""
    while pending and len(seen) < 12:
        base, path = pending.pop(0)
        selected = urllib.parse.urljoin(base, "/" + path if path.startswith("assets/") else path)
        if urllib.parse.urlsplit(selected)[:2] != urllib.parse.urlsplit(expected["appOrigin"])[:2]:
            raise u.UpdateError("UPDATE_FRONTEND_ASSET_ORIGIN_INVALID")
        if selected in seen:
            continue
        seen.add(selected)
        response = client.request(urllib.parse.urlsplit(selected).path)
        if response.status != 200:
            raise u.UpdateError("UPDATE_FRONTEND_ASSET_FAILED")
        name = urllib.parse.urlsplit(selected).path.rsplit("/", 1)[-1]
        if name.startswith("Settings-"):
            settings += response.body
        if name.startswith("OpportunityDetail-"):
            opportunity += response.body
        if name.startswith(("GenerationPanel-", "generationStatus-")):
            generation += response.body
        for match in re.findall(rb'["\'`](\.?/?(?:assets/)?(?:Settings|OpportunityDetail|GenerationPanel|generationStatus)-[A-Za-z0-9_-]+\.js)["\'`]', response.body)[:8]:
            pending.append((selected, match.decode()))
    if not settings or b"Individual content permissions" in settings or b"Authorize this text" in settings:
        raise u.UpdateError("UPDATE_SEPARATE_CONTENT_PERMISSION_UI_PRESENT")
    if GENERATION_MARKER not in generation or UPLOAD_MARKER not in opportunity:
        raise u.UpdateError("UPDATE_FLEXIBLE_DRAFT_FRONTEND_MISSING")
    emit("flexible_inputs_frontend_verified", separate_content_permission_step=False, flexible_draft_inputs=True)


RUNTIME_COMPONENTS = tuple(name for name in u.COMPONENTS if name != "frontend")


def controller_owner(metadata, kind):
    owners = metadata.get("ownerReferences", [])
    if not isinstance(owners, list):
        raise u.UpdateError("FLEXIBLE_INPUTS_RUNTIME_POD_OWNERSHIP_REQUIRED")
    controllers = [owner for owner in owners if isinstance(owner, dict) and owner.get("controller") is True]
    if (len(controllers) != 1 or controllers[0].get("kind") != kind
            or controllers[0].get("apiVersion") != "apps/v1"
            or not isinstance(controllers[0].get("uid"), str) or not controllers[0]["uid"]
            or not isinstance(controllers[0].get("name"), str)
            or not re.fullmatch(r"[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?", controllers[0]["name"])):
        raise u.UpdateError("FLEXIBLE_INPUTS_RUNTIME_POD_OWNERSHIP_REQUIRED")
    return controllers[0]


def runtime_pods(name, deployment):
    # The renderer copies application labels into Pods, while apply_managed
    # labels the Deployment itself. Bind each Pod to that verified Deployment
    # through the controller UIDs instead of assuming label inheritance.
    expected = deployment.get("metadata", {})
    if (expected.get("name") != name or expected.get("namespace") != u.d.NAMESPACE
            or not isinstance(expected.get("uid"), str) or not expected["uid"]
            or expected.get("labels", {}).get("app.kubernetes.io/managed-by") != "tenderdesk-deployment"):
        raise u.UpdateError("FLEXIBLE_INPUTS_RUNTIME_POD_OWNERSHIP_REQUIRED")
    value = json.loads(u.d.command(["get", "pods", "-n", u.d.NAMESPACE,
        "-l", "app.kubernetes.io/name=" + name, "-o", "json"]))
    pods = value.get("items")
    if not isinstance(pods, list):
        raise u.UpdateError("FLEXIBLE_INPUTS_RUNTIME_POD_STATE_INVALID")
    replica_sets = {}
    for pod in pods:
        metadata = pod.get("metadata", {})
        labels = metadata.get("labels", {})
        containers = pod.get("spec", {}).get("containers", [])
        if (metadata.get("namespace") != u.d.NAMESPACE
                or not isinstance(metadata.get("uid"), str) or not metadata["uid"]
                or labels.get("app.kubernetes.io/name") != name
                or len(containers) != 1 or containers[0].get("name") != name):
            raise u.UpdateError("FLEXIBLE_INPUTS_RUNTIME_POD_OWNERSHIP_REQUIRED")
        u.image(containers[0].get("image", ""), "runtime")
        owner = controller_owner(metadata, "ReplicaSet")
        identity = (owner["name"], owner["uid"])
        if identity not in replica_sets:
            replica_set = u.d.get("replicaset", owner["name"])
            rs_metadata = (replica_set or {}).get("metadata", {})
            if (rs_metadata.get("namespace") != u.d.NAMESPACE or rs_metadata.get("name") != owner["name"]
                    or rs_metadata.get("uid") != owner["uid"]):
                raise u.UpdateError("FLEXIBLE_INPUTS_RUNTIME_POD_OWNERSHIP_REQUIRED")
            controller = controller_owner(rs_metadata, "Deployment")
            if controller["name"] != name or controller["uid"] != expected["uid"]:
                raise u.UpdateError("FLEXIBLE_INPUTS_RUNTIME_POD_OWNERSHIP_REQUIRED")
            replica_sets[identity] = True
    return pods


def wait_runtime_drain(expected, timeout=300):
    # Deployment readiness alone does not prove that old terminating workers
    # finished their last local-stage drain. Never send versioned inputs to them.
    deadline = time.monotonic() + timeout
    while True:
        pending = False
        for name in RUNTIME_COMPONENTS:
            current = u.deployment(name)
            if current["spec"]["template"]["spec"]["containers"][0]["image"] != expected:
                raise u.UpdateError("FLEXIBLE_INPUTS_RUNTIME_CHANGED")
            for pod in runtime_pods(name, current):
                if (pod.get("status", {}).get("phase") not in ("Succeeded", "Failed")
                        and pod["spec"]["containers"][0]["image"] != expected):
                    pending = True
        if not pending:
            return
        if time.monotonic() >= deadline:
            raise u.UpdateError("FLEXIBLE_INPUTS_OLD_RUNTIME_NOT_DRAINED")
        time.sleep(3)


def update():
    runtime = u.image(os.environ.get("TENDERDESK_RUNTIME_IMAGE", ""), "runtime")
    frontend = u.image(os.environ.get("TENDERDESK_FRONTEND_IMAGE", ""), "frontend")
    if not re.fullmatch(r"[0-9]{1,20}", os.environ.get("GITHUB_RUN_ID", "")) or not re.fullmatch(r"[0-9]{1,6}", os.environ.get("GITHUB_RUN_ATTEMPT", "")):
        raise u.UpdateError("UPDATE_RUN_IDENTITY_REQUIRED")
    u.d.probe.validate_cluster()
    original = {name: u.deployment(name) for name in u.COMPONENTS}
    schedules = {name: u.owned("cronjob", name)["spec"] for name in ("native-browser", "native-ocr")}
    configuration = u.owned("configmap", "frontend-config")
    core = u.d.decode_secret(u.owned("secret", "tenderdesk-core"))
    credentials, ca = u.d.probe.target_credentials(os.environ.get("DIGITALOCEAN_ACCESS_TOKEN", ""))
    if not core or not hmac.compare_digest(core.get("PGSSLCA", ""), ca):
        raise u.UpdateError("UPDATE_DATABASE_CA_CHANGED")
    admin = {**credentials, "APP_DATABASE": u.d.DATABASE, "ROLE_PREFIX": u.d.PREFIX}
    pod = "migration-client-" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
    changed = []
    schema_attempted = schema_verified = False
    try:
        u.d.sql_pod(admin)
        try:
            # New runtime understands both historical inputs and version 1.
            # Keep old SQL admission until every old process has fully drained.
            for name in RUNTIME_COMPONENTS:
                changed.append(name)
                u.patch_image(name, runtime, original[name])
            u.d.wait_deployments(list(RUNTIME_COMPONENTS))
            wait_runtime_drain(runtime)
            schema_attempted = True
            migrate(pod)
            schema_verified = True
            changed.append("frontend")
            u.patch_image("frontend", frontend, original["frontend"])
            u.d.wait_deployments(["frontend"])
            for name in u.COMPONENTS:
                current = u.deployment(name)
                expected = frontend if name == "frontend" else runtime
                if (current["spec"]["template"]["spec"]["containers"][0]["image"] != expected
                        or u.without_image(current) != u.without_image(original[name])):
                    raise u.UpdateError("UPDATE_WORKLOAD_ACCEPTANCE_FAILED")
            if any(u.owned("cronjob", name)["spec"] != spec for name, spec in schedules.items()):
                raise u.UpdateError("UPDATE_NATIVE_SCHEDULE_CHANGED")
            if u.owned("configmap", "frontend-config").get("data") != configuration.get("data"):
                raise u.UpdateError("UPDATE_PUBLIC_CONFIGURATION_CHANGED")
            public_check(configuration, core)
        except Exception:
            # SQL may commit even if its acknowledgement is lost. Once attempted,
            # keep the compatible runtime; restoring the old runtime could feed
            # version 1 inputs to code that cannot interpret them. Old frontend
            # remains compatible and may be restored independently.
            rollback = ["frontend"] if schema_attempted and "frontend" in changed else ([] if schema_attempted else list(reversed(changed)))
            failed = False
            for name in rollback:
                try:
                    previous = original[name]["spec"]["template"]["spec"]["containers"][0]["image"]
                    u.patch_image(name, previous, original[name])
                except Exception:
                    failed = True
            if rollback:
                try:
                    u.d.wait_deployments(rollback)
                except Exception:
                    failed = True
            if failed:
                raise u.UpdateError("UPDATE_ROLLBACK_NOT_CONFIRMED") from None
            emit("compatible_runtime_retained" if schema_attempted else "runtime_images_rolled_back",
                 schema_verified=schema_verified, frontend_restored="frontend" in rollback)
            raise
        emit("passed", deployments_verified=len(u.COMPONENTS), models_activated=False,
             source_seeded=False, existing_frozen_work_preserved=True)
    finally:
        u.d.cleanup_administrator(pod)


def main():
    u.update, u.emit = update, emit
    return u.main()


if __name__ == "__main__":
    sys.exit(main())
