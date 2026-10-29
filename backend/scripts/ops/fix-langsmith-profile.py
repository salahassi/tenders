#!/usr/bin/env python3
"""Pin disabled-tracing profile lookup inside the existing Deno read scope.

This changes only an explicit runtime environment selector; it neither broadens
filesystem permissions nor submits model/tracing requests.
"""
from __future__ import annotations
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sys

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("langsmith_profile_access", HERE / "transfer-sources.py")
access = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = access
SPEC.loader.exec_module(access)
d = access.d
COMPONENTS = ("api", "worker")
VARIABLE = "LANGSMITH_CONFIG_FILE"
PROFILE = "/app/backend/.langsmith-disabled.json"
IMAGE = re.compile(r"registry\.digitalocean\.com/tenderdesk-a6093a76/runtime@sha256:[a-f0-9]{64}")
SMOKE = HERE / "langsmith-runtime-smoke.mjs"


class ProfileError(Exception):
    pass


def owned(kind, name):
    value = d.get(kind, name)
    metadata = (value or {}).get("metadata", {})
    if (metadata.get("name") != name or metadata.get("labels", {}).get("app.kubernetes.io/managed-by") != "tenderdesk-deployment"
            or (kind != "namespace" and metadata.get("namespace") != d.NAMESPACE)):
        raise ProfileError("LANGSMITH_PROFILE_OWNERSHIP_REQUIRED")
    return value


def workload(name):
    value = owned("deployment", name)
    spec, status = value.get("spec", {}), value.get("status", {})
    containers = spec.get("template", {}).get("spec", {}).get("containers", [])
    if (spec.get("replicas") != 1 or len(containers) != 1 or containers[0].get("name") != name
            or not IMAGE.fullmatch(containers[0].get("image", ""))
            or status.get("observedGeneration", -1) < value["metadata"].get("generation", 0)
            or status.get("readyReplicas") != 1 or status.get("updatedReplicas") != 1
            or status.get("unavailableReplicas", 0) != 0):
        raise ProfileError("LANGSMITH_PROFILE_READY_RUNTIME_REQUIRED")
    env = containers[0].get("env")
    if not isinstance(env, list):
        raise ProfileError("LANGSMITH_PROFILE_ENVIRONMENT_INVALID")
    existing = [entry for entry in env if entry.get("name") == VARIABLE]
    if len(existing) > 1 or (existing and existing != [{"name": VARIABLE, "value": PROFILE}]):
        raise ProfileError("LANGSMITH_PROFILE_FOREIGN_SELECTOR_REFUSED")
    return value


def without_selector(spec):
    value = copy.deepcopy(spec)
    container = value["template"]["spec"]["containers"][0]
    container["env"] = [entry for entry in container["env"] if entry.get("name") != VARIABLE]
    return value


def repair():
    owned("namespace", d.NAMESPACE)
    original = {name: workload(name) for name in COMPONENTS}
    changed = []
    for name in COMPONENTS:
        initial = original[name]
        env = initial["spec"]["template"]["spec"]["containers"][0]["env"]
        if not any(entry.get("name") == VARIABLE for entry in env):
            current = workload(name)
            if current["spec"] != initial["spec"]:
                raise ProfileError("LANGSMITH_PROFILE_CONCURRENT_CHANGE")
            operations = [{"op": "test", "path": "/metadata/resourceVersion", "value": current["metadata"]["resourceVersion"]},
                          {"op": "add", "path": "/spec/template/spec/containers/0/env", "value": [*env, {"name": VARIABLE, "value": PROFILE}]}]
            d.command(["patch", "deployment", name, "-n", d.NAMESPACE, "--type=json", "--patch-file=/dev/stdin"], payload=json.dumps(operations))
            changed.append(name)
            d.wait_deployments([name], seconds=300)
        current = workload(name)
        if without_selector(current["spec"]) != without_selector(initial["spec"]):
            raise ProfileError("LANGSMITH_PROFILE_UNEXPECTED_CONFIGURATION_CHANGE")
        proof = d.command(["exec", "deployment/" + name, "-n", d.NAMESPACE, "--container=" + name, "--", "deno", "eval",
                           'console.log(JSON.stringify({profile_configured:Deno.env.get("LANGSMITH_CONFIG_FILE")==="/app/backend/.langsmith-disabled.json"}));'])
        if json.loads(proof) != {"profile_configured": True}:
            raise ProfileError("LANGSMITH_PROFILE_PROCESS_NOT_RELOADED")
    # Execute the pinned real dependency under the production filesystem scope.
    # No allow-net flag is supplied and the fixture also rejects fetch calls.
    raw = d.command(["exec", "-i", "deployment/worker", "-n", d.NAMESPACE, "--container=worker", "--", "deno", "run",
                     "--cached-only", "--frozen", "--config=/app/backend/supabase/functions/deno.json", "--allow-env", "--allow-sys",
                     "--allow-read=/app,/deno-dir,/tmp", "--allow-write=/tmp", "-"], payload=SMOKE.read_text(), timeout=60)
    expected = {"local_graph": "passed", "home_profile_read_denied": True, "outbound_trace_calls": 0}
    if json.loads(raw) != expected:
        raise ProfileError("LANGSMITH_PROFILE_RESTRICTED_SMOKE_FAILED")
    return {"langsmith_profile": "verified", "updated": changed, "profile_path": PROFILE,
            "restricted_dependency_smoke": expected, "permissions_broadened": False}


def main():
    directory = None
    candidate = None
    try:
        run, attempt = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", "")
        if os.environ.get("RUNNER_TEMP") and re.fullmatch(r"[0-9]{1,20}", run) and re.fullmatch(r"[0-9]{1,6}", attempt):
            path = Path(os.environ["RUNNER_TEMP"]) / ("td-sources-" + run + "-" + attempt)
            if not path.exists() and not path.is_symlink(): candidate = path
        directory = access.prepare_cluster()
        print(json.dumps(repair(), sort_keys=True), flush=True)
    except Exception as error:
        code = str(error) if isinstance(error, (ProfileError, d.DeployError, d.probe.ProbeError)) and re.fullmatch(r"[A-Z_0-9]{1,100}", str(error)) else "LANGSMITH_PROFILE_REPAIR_FAILED"
        print(json.dumps({"langsmith_profile": "blocked", "code": code}), flush=True)
        return 1
    finally:
        if directory: shutil.rmtree(directory)
        elif candidate is not None and candidate.is_dir() and not candidate.is_symlink(): shutil.rmtree(candidate)
    return 0


if __name__ == "__main__": sys.exit(main())
