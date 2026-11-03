#!/usr/bin/env python3
"""Release model validation code without database or processing commands.

Writes are restricted to existing API/worker images and a guarded temporary
worker rollout strategy. New prompt revisions may become durable as soon as a
worker runs, so an ambiguous rollout retains compatible code.
"""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("validation_runtime_release", HERE / "ai-reliability-update.py")
runtime = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runtime
SPEC.loader.exec_module(runtime)
u = runtime.u
RELEASE = "model-validation-code-v1"
BASE_RUNTIME = u.REGISTRY + "runtime@sha256:2b3391d445071f196bebf4d635e23ec50d3b33a8795defbded511259ea8bde1e"
FRONTEND = u.REGISTRY + "frontend@sha256:b90ee4cea47e8208dd785aba618caaf89aadf3c8fd15e4c8172633b2883b88af"
WORKER_STRATEGY = {"type": "RollingUpdate", "rollingUpdate": {"maxSurge": 0, "maxUnavailable": 1}}
ROLLOUT_MARKER = "tenderdesk-deployment/model-validation-image"
PRIOR_MIGRATIONS = {
    "20261102231710_writer_handoff_usage_blocker.sql": "f15bd6dbfea0df624fff79e79c36770ee4625230893379fdb51e6341f09db9a1",
    "20261102231721_terminal_background_request_lifecycle.sql": "f7f4d59258ed951d4c2a955ff8cf28245f67411e658b6948fa91e09cec8ebc07",
}


def emit(status, **values):
    print(json.dumps({"update": "model_validation", "release": RELEASE, "status": status, **values}, sort_keys=True), flush=True)


def verify_source():
    # Source integrity only: this release never opens a database connection or
    # claims to have inspected the live application release ledger.
    for name, expected in PRIOR_MIGRATIONS.items():
        path = u.d.ROOT / "supabase/migrations" / name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise u.UpdateError("MODEL_VALIDATION_PRIOR_MIGRATION_CHANGED")


def image_of(value):
    return value["spec"]["template"]["spec"]["containers"][0]["image"]


def worker_baseline(value, selected):
    strategy = value["spec"].get("strategy")
    marker = value["metadata"].get("annotations", {}).get(ROLLOUT_MARKER)
    if not ((strategy == WORKER_STRATEGY and marker is None)
            or (strategy == {"type": "Recreate"} and marker == selected)):
        raise u.UpdateError("MODEL_VALIDATION_WORKER_STRATEGY_MISMATCH")
    if value["spec"]["template"]["spec"].get("terminationGracePeriodSeconds", 0) < 240:
        raise u.UpdateError("MODEL_VALIDATION_WORKER_DRAIN_GRACE_REQUIRED")
    baseline = copy.deepcopy(value)
    baseline["spec"]["strategy"] = copy.deepcopy(WORKER_STRATEGY)
    return baseline


def patch_worker_strategy(original, selected, recreate):
    current = u.deployment("worker", ready=False)
    baseline = worker_baseline(current, selected)
    if (not original["metadata"].get("uid")
            or current["metadata"].get("uid") != original["metadata"].get("uid")
            or u.without_image(baseline) != u.without_image(original)
            or image_of(current) not in (BASE_RUNTIME, selected)):
        raise u.UpdateError("MODEL_VALIDATION_CONCURRENT_WORKLOAD_CHANGE")
    desired = {"type": "Recreate"} if recreate else WORKER_STRATEGY
    if current["spec"]["strategy"] == desired:
        return
    marker_path = "/metadata/annotations/" + ROLLOUT_MARKER.replace("~", "~0").replace("/", "~1")
    operations = [
        {"op": "test", "path": "/metadata/uid", "value": current["metadata"]["uid"]},
        {"op": "test", "path": "/metadata/resourceVersion", "value": current["metadata"]["resourceVersion"]},
        {"op": "test", "path": "/spec/strategy", "value": current["spec"]["strategy"]},
        {"op": "test", "path": "/spec/template/spec/containers/0/image", "value": image_of(current)},
    ]
    if recreate:
        if current["metadata"].get("annotations") is None:
            operations.append({"op": "add", "path": "/metadata/annotations", "value": {}})
        operations.append({"op": "add", "path": marker_path, "value": selected})
    else:
        operations.extend([{"op": "test", "path": marker_path, "value": selected},
                           {"op": "remove", "path": marker_path}])
    operations.append({"op": "replace", "path": "/spec/strategy", "value": desired})
    u.d.command(["patch", "deployment", "worker", "-n", u.d.NAMESPACE, "--type=json", "--patch", json.dumps(operations)])


def patch_worker_image(original, selected):
    current = u.deployment("worker", ready=False)
    baseline = worker_baseline(current, selected)
    if (not original["metadata"].get("uid")
            or current["metadata"].get("uid") != original["metadata"].get("uid")
            or u.without_image(baseline) != u.without_image(original)
            or image_of(current) not in (BASE_RUNTIME, selected)
            or current["spec"]["strategy"] != {"type": "Recreate"}
            or current["metadata"].get("annotations", {}).get(ROLLOUT_MARKER) != selected):
        raise u.UpdateError("MODEL_VALIDATION_CONCURRENT_WORKLOAD_CHANGE")
    if image_of(current) == selected:
        return
    marker_path = "/metadata/annotations/" + ROLLOUT_MARKER.replace("~", "~0").replace("/", "~1")
    operations = [
        {"op": "test", "path": "/metadata/uid", "value": original["metadata"]["uid"]},
        {"op": "test", "path": "/metadata/resourceVersion", "value": current["metadata"]["resourceVersion"]},
        {"op": "test", "path": marker_path, "value": selected},
        {"op": "test", "path": "/spec/strategy", "value": {"type": "Recreate"}},
        {"op": "test", "path": "/spec/template/spec/containers/0/name", "value": "worker"},
        {"op": "test", "path": "/spec/template/spec/containers/0/image", "value": image_of(current)},
        {"op": "replace", "path": "/spec/template/spec/containers/0/image", "value": selected},
    ]
    u.d.command(["patch", "deployment", "worker", "-n", u.d.NAMESPACE, "--type=json", "--patch", json.dumps(operations)])


def verify_runtime(original, selected, *, transition=False):
    for name in runtime.RUNTIME_COMPONENTS:
        current = u.deployment(name)
        if name == "worker" and transition:
            current = worker_baseline(current, selected)
        if (current["metadata"].get("uid") != original[name]["metadata"].get("uid")
                or image_of(current) != selected
                or u.without_image(current) != u.without_image(original[name])):
            raise u.UpdateError("MODEL_VALIDATION_RUNTIME_ACCEPTANCE_FAILED")


def verify_unchanged(before, retained):
    after = runtime.workload_snapshot()
    if set(before) != set(after) or any(before[name] != after[name] for name in before if name not in runtime.RUNTIME_COMPONENTS):
        raise u.UpdateError("MODEL_VALIDATION_OTHER_WORKLOAD_CHANGED")
    if retained != runtime.retained_configuration():
        raise u.UpdateError("MODEL_VALIDATION_CONFIGURATION_CHANGED")


def public_check(configuration):
    public = u.smoke.javascript_config(configuration["data"]["runtime-config.js"].encode())
    # The shared acceptance sends public GET requests only. No privileged API
    # identity, user session, model request or authenticated mutation is used.
    u.public_check(configuration, {"ANON_KEY": public["publishableKey"], "SERVICE_KEY": "", "JWT_SECRET": ""})


def update():
    selected = u.image(os.environ.get("TENDERDESK_RUNTIME_IMAGE", ""), "runtime")
    if (not re.fullmatch(r"[a-f0-9]{40}", os.environ.get("GITHUB_SHA", ""))
            or not re.fullmatch(r"[0-9]{1,20}", os.environ.get("GITHUB_RUN_ID", ""))
            or not re.fullmatch(r"[0-9]{1,6}", os.environ.get("GITHUB_RUN_ATTEMPT", ""))):
        raise u.UpdateError("MODEL_VALIDATION_RUN_IDENTITY_REQUIRED")
    if selected == BASE_RUNTIME:
        raise u.UpdateError("MODEL_VALIDATION_NEW_RUNTIME_REQUIRED")
    verify_source()
    u.d.probe.validate_cluster()
    original = {name: u.deployment(name, ready=False) for name in runtime.RUNTIME_COMPONENTS}
    if any(image_of(value) not in (BASE_RUNTIME, selected) for value in original.values()):
        raise u.UpdateError("MODEL_VALIDATION_RUNTIME_BASELINE_MISMATCH")
    if image_of(u.deployment("frontend")) != FRONTEND:
        raise u.UpdateError("MODEL_VALIDATION_FRONTEND_BASELINE_MISMATCH")
    original["worker"] = worker_baseline(original["worker"], selected)
    before = runtime.workload_snapshot()
    retained = runtime.retained_configuration()
    configuration = u.owned("configmap", "frontend-config")
    verify_unchanged(before, retained)
    attempted = False
    try:
        attempted = True  # A failed response may follow an accepted patch.
        runtime.patch_runtime("api", selected, original["api"], image_of(original["api"]))
        u.d.wait_deployments(["api"])
        # Recreate waits for all old worker pods to terminate before admitting
        # a new worker. RollingUpdate can overlap terminating old processes even
        # with maxSurge=0, which is unsafe when new prompt pins become durable.
        patch_worker_strategy(original["worker"], selected, True)
        patch_worker_image(original["worker"], selected)
        u.d.wait_deployments(["worker"])
        runtime.wait_runtime_drain(selected)
        verify_runtime(original, selected, transition=True)
        verify_unchanged(before, retained)
        public_check(configuration)
        verify_runtime(original, selected, transition=True)
        verify_unchanged(before, retained)
        # Restore the exact original strategy only after candidate acceptance.
        # A failed acceptance retains the owned marker for forward completion.
        patch_worker_strategy(original["worker"], selected, False)
        verify_runtime(original, selected)
        verify_unchanged(before, retained)
    except Exception:
        if attempted:
            # New workers can pin a prompt version unsupported by the original
            # image. Do not overwrite such durable work with an older runtime.
            emit("compatible_runtime_retained", automatic_rollback=False,
                 forward_completion_required=True, rollout_may_be_partial=True,
                 candidate_image=selected)
        raise
    emit("passed", source_revision=os.environ["GITHUB_SHA"], runtime_image=selected,
         frontend_image=FRONTEND, deployments_updated=list(runtime.RUNTIME_COMPONENTS),
         other_workloads_preserved=True, configuration_preserved=True,
         database_accessed=False, schema_changed=False, processing_retried=False,
         prior_migration_sources_preserved=True, old_workers_drained_before_new=True)


def main():
    try:
        update()
        return 0
    except Exception as error:
        code = getattr(error, "code", str(error))
        emit("blocked", code=code if re.fullmatch(r"[A-Z_]{1,100}", code) else "MODEL_VALIDATION_UPDATE_FAILED")
        return 1


if __name__ == "__main__":
    sys.exit(main())
