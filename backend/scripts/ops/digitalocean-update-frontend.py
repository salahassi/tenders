#!/usr/bin/env python3
"""Replace only the owned frontend image, with HTTP/browser acceptance and rollback.

No database, Secret, runtime image, schedule, or public configuration is written.
Cluster access and registry credentials are prepared separately by the runner.
"""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("frontend_update_deploy", HERE / "digitalocean-deploy.py")
d = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = d
SPEC.loader.exec_module(d)
u = d.module("frontend_update_guards", HERE / "digitalocean-update.py")
# Share the helper's deployment adapter, including its exception types.
d = u.d
smoke = u.smoke
REPOSITORY = d.ROOT.parent
MAX_BROWSER_OUTPUT = 128 * 1024


class FrontendUpdateError(Exception):
    pass


def emit(status, **values):
    print(json.dumps({"update": "frontend_only", "status": status, **values}, sort_keys=True), flush=True)


def namespace_owned():
    value = d.get("namespace", d.NAMESPACE)
    meta = (value or {}).get("metadata", {})
    if (meta.get("name") != d.NAMESPACE
            or meta.get("labels", {}).get("app.kubernetes.io/managed-by") != "tenderdesk-deployment"):
        raise FrontendUpdateError("FRONTEND_NAMESPACE_NOT_OWNED")


def specs(kind):
    try:
        value = json.loads(d.command(["get", kind, "-n", d.NAMESPACE, "-o", "json"]))
        items = value["items"]
        if not isinstance(items, list):
            raise ValueError()
        result = {}
        for item in items:
            meta = item["metadata"]
            name = meta["name"]
            if (not isinstance(name, str) or not name or name in result
                    or meta.get("namespace") != d.NAMESPACE or not isinstance(item["spec"], dict)):
                raise ValueError()
            if kind != "deployments" or name != "frontend":
                result[name] = copy.deepcopy(item["spec"])
        return result
    except (KeyError, TypeError, ValueError):
        raise FrontendUpdateError("FRONTEND_RESOURCE_SNAPSHOT_INVALID") from None


def configuration_data(value):
    return {key: copy.deepcopy(value.get(key)) for key in ("data", "binaryData", "immutable")}


def snapshot():
    return {"deployments": specs("deployments"), "cronjobs": specs("cronjobs"),
            "configuration": configuration_data(u.owned("configmap", "frontend-config"))}


def preserved(before):
    namespace_owned()
    if snapshot() != before:
        raise FrontendUpdateError("FRONTEND_UNRELATED_CONFIGURATION_CHANGED")


def selected_image(workload):
    return workload["spec"]["template"]["spec"]["containers"][0]["image"]


def patch_frontend(selected, original, allowed_images):
    """Compare the live configuration and image before an atomic image-only patch."""
    namespace_owned()
    current = u.deployment("frontend", ready=False)
    if (not isinstance(original["metadata"].get("uid"), str) or not original["metadata"]["uid"]
            or current["metadata"].get("uid") != original["metadata"].get("uid")
            or u.without_image(current) != u.without_image(original)):
        raise FrontendUpdateError("FRONTEND_WORKLOAD_CONFIGURATION_CHANGED")
    current_image = selected_image(current)
    if current_image not in allowed_images:
        raise FrontendUpdateError("FRONTEND_CONCURRENT_IMAGE_CHANGED")
    if current_image == selected:
        return
    operations = [
        {"op": "test", "path": "/metadata/resourceVersion", "value": current["metadata"]["resourceVersion"]},
        {"op": "test", "path": "/metadata/uid", "value": current["metadata"]["uid"]},
        {"op": "test", "path": "/spec/template/spec/containers/0/name", "value": "frontend"},
        {"op": "test", "path": "/spec/template/spec/containers/0/image", "value": current_image},
        {"op": "replace", "path": "/spec/template/spec/containers/0/image", "value": selected},
    ]
    d.command(["patch", "deployment", "frontend", "-n", d.NAMESPACE, "--type=json", "--patch", json.dumps(operations)])


def build_assets(directory=None):
    directory = Path(directory) if directory is not None else REPOSITORY / "frontend/dist"
    try:
        index = (directory / "index.html").read_bytes()
        files = sorted((directory / "assets").rglob("*"))
        assets = {}
        for path in files:
            if path.is_file() and path.suffix in (".js", ".mjs", ".css"):
                relative = path.relative_to(directory).as_posix()
                if (not re.fullmatch(r"assets/[A-Za-z0-9_./-]+", relative)
                        or ".." in relative.split("/") or path.is_symlink()):
                    raise ValueError()
                data = path.read_bytes()
                if not data or len(data) > smoke.MAX_RESPONSE:
                    raise ValueError()
                assets["/" + relative] = data
        if (not index or len(index) > smoke.MAX_RESPONSE or not 1 <= len(assets) <= 200
                or not any(path.endswith(".css") for path in assets)
                or not any(re.search(r"/extraction\.worker-[\w-]+\.js$", path) for path in assets)
                or not any(re.search(r"/pdf\.worker[^/]*\.mjs$", path) for path in assets)):
            raise ValueError()
        return {"index": index, "assets": assets}
    except (OSError, ValueError):
        raise FrontendUpdateError("FRONTEND_BUILD_ASSETS_REQUIRED") from None


def header(response, name):
    return next((str(value) for key, value in response.headers.items() if key.lower() == name.lower()), "")


def browser_check(origin):
    script = REPOSITORY / "frontend/deploy/verify-pdf-worker.mjs"
    if not script.is_file():
        raise FrontendUpdateError("FRONTEND_BROWSER_ACCEPTANCE_REQUIRED")
    try:
        # Subprocess diagnostics remain private and cannot become workflow logs.
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(["node", str(script), origin], stdout=output, stderr=subprocess.STDOUT,
                                    timeout=180, check=False)
            if output.tell() > MAX_BROWSER_OUTPUT:
                raise FrontendUpdateError("FRONTEND_BROWSER_OUTPUT_REJECTED")
            if result.returncode:
                raise FrontendUpdateError("FRONTEND_BROWSER_ACCEPTANCE_FAILED")
    except (OSError, subprocess.TimeoutExpired):
        raise FrontendUpdateError("FRONTEND_BROWSER_ACCEPTANCE_UNAVAILABLE") from None
    emit("browser_pdf_extraction_verified")


def public_check(configuration, expected):
    public = smoke.javascript_config(configuration["data"]["runtime-config.js"].encode())
    # Only public GETs are used; no service identity or application session exists.
    client = smoke.Client(smoke.Config(public["appOrigin"], public["publishableKey"], "", ""))
    root = client.request("/")
    if root.status != 200 or root.body != expected["index"]:
        raise FrontendUpdateError("FRONTEND_PUBLIC_BUILD_MISMATCH")
    loaded = client.request("/runtime-config.js")
    if loaded.status != 200 or smoke.javascript_config(loaded.body) != public:
        raise FrontendUpdateError("FRONTEND_PUBLIC_CONFIGURATION_MISMATCH")
    for path, content in expected["assets"].items():
        response = client.request(path)
        if (response.status != 200
                or hashlib.sha256(response.body).digest() != hashlib.sha256(content).digest()):
            raise FrontendUpdateError("FRONTEND_PUBLIC_ASSET_MISMATCH")
        mime = header(response, "content-type").split(";", 1)[0].strip().lower()
        allowed = ("text/css",) if path.endswith(".css") else ("application/javascript", "text/javascript")
        if mime not in allowed:
            raise FrontendUpdateError("FRONTEND_ASSET_MIME_INVALID")
        cache = {part.strip().lower() for part in header(response, "cache-control").split(",")}
        if (not {"public", "max-age=31536000", "immutable"}.issubset(cache)
                or header(response, "x-content-type-options").lower() != "nosniff"):
            raise FrontendUpdateError("FRONTEND_ASSET_HEADERS_INVALID")
    for suffix in ("mjs", "js", "css"):
        missing = client.request("/assets/__frontend_acceptance_absent__." + suffix)
        if missing.status != 404:
            raise FrontendUpdateError("FRONTEND_MISSING_ASSET_BOUNDARY_FAILED")
    if client.request("/functions/v1/api/v1/health", headers={"Origin": public["appOrigin"]}).status != 200:
        raise FrontendUpdateError("FRONTEND_APPLICATION_HEALTH_FAILED")
    if client.request("/functions/v1/api/v1/bootstrap").status != 401:
        raise FrontendUpdateError("FRONTEND_ANONYMOUS_BOUNDARY_FAILED")
    browser_check(public["appOrigin"])
    emit("public_build_configuration_and_assets_verified", assets_verified=len(expected["assets"]))
    return public["appOrigin"]


def update():
    candidate = u.image(os.environ.get("TENDERDESK_FRONTEND_IMAGE", ""), "frontend")
    if (not re.fullmatch(r"[0-9]{1,20}", os.environ.get("GITHUB_RUN_ID", ""))
            or not re.fullmatch(r"[0-9]{1,6}", os.environ.get("GITHUB_RUN_ATTEMPT", ""))
            or not re.fullmatch(r"[a-f0-9]{40}", os.environ.get("GITHUB_SHA", ""))):
        raise FrontendUpdateError("FRONTEND_RUN_IDENTITY_REQUIRED")
    expected = build_assets()
    d.probe.validate_cluster()
    namespace_owned()
    original = u.deployment("frontend")
    previous = selected_image(original)
    configuration = u.owned("configmap", "frontend-config")
    smoke.javascript_config(configuration["data"]["runtime-config.js"].encode())
    before = snapshot()
    preserved(before)
    try:
        # A failed command can still have been accepted by the API server.
        patch_frontend(candidate, original, {previous})
        d.wait_deployments(["frontend"], seconds=240)
        current = u.deployment("frontend")
        if selected_image(current) != candidate or u.without_image(current) != u.without_image(original):
            raise FrontendUpdateError("FRONTEND_WORKLOAD_ACCEPTANCE_FAILED")
        preserved(before)
        origin = public_check(configuration, expected)
        preserved(before)
    except Exception:
        try:
            # Never overwrite another operator's image or configuration changes.
            patch_frontend(previous, original, {candidate, previous})
            d.wait_deployments(["frontend"], seconds=240)
            restored = u.deployment("frontend")
            if selected_image(restored) != previous or u.without_image(restored) != u.without_image(original):
                raise FrontendUpdateError("FRONTEND_ROLLBACK_IMAGE_MISMATCH")
        except Exception:
            raise FrontendUpdateError("FRONTEND_ROLLBACK_NOT_CONFIRMED") from None
        emit("frontend_image_rolled_back")
        raise
    if os.environ.get("GITHUB_ENV"):
        with open(os.environ["GITHUB_ENV"], "a") as stream:
            stream.write("TENDERDESK_DEPLOYED_ORIGIN=" + origin + "\n")
    emit("passed", source_revision=os.environ["GITHUB_SHA"], deployments_updated=["frontend"],
         other_workload_specs_preserved=True, public_configuration_preserved=True,
         database_accessed=False, secrets_accessed=False, models_activated=False)


def main():
    try:
        update()
        return 0
    except (FrontendUpdateError, u.UpdateError, d.DeployError, d.probe.ProbeError, smoke.SmokeFailure) as error:
        code = getattr(error, "code", str(error))
        emit("blocked", code=code if re.fullmatch(r"[A-Z_]{1,100}", code) else "FRONTEND_UPDATE_FAILED")
    except Exception:
        emit("blocked", code="UNEXPECTED_FRONTEND_UPDATE_FAILURE")
    return 1


if __name__ == "__main__":
    sys.exit(main())
