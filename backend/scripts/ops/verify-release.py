#!/usr/bin/env python3
"""Reuse published immutable images only with matching verified source inputs."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
REGISTRY = "registry.digitalocean.com/tenderdesk-a6093a76/"
COMPONENTS = {"https", "runtime", "frontend", "browser", "ocr"}


class ReleaseError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def validate_manifest(value):
    if not isinstance(value, dict) or set(value) != {"tested_source_revision", "validation_run", "native_source_revision", "images"}:
        raise ReleaseError("RELEASE_MANIFEST_INVALID")
    if any(not isinstance(value[key], str) or not re.fullmatch(r"[a-f0-9]{40}", value[key]) for key in ("tested_source_revision", "native_source_revision")):
        raise ReleaseError("RELEASE_SOURCE_REVISION_INVALID")
    if type(value["validation_run"]) is not int or value["validation_run"] < 1:
        raise ReleaseError("RELEASE_VALIDATION_RUN_INVALID")
    if not isinstance(value["images"], dict) or set(value["images"]) != COMPONENTS:
        raise ReleaseError("RELEASE_COMPONENTS_INVALID")
    for name, reference in value["images"].items():
        if not isinstance(reference, str) or not re.fullmatch(re.escape(REGISTRY + name) + r"@sha256:[a-f0-9]{64}", reference):
            raise ReleaseError("RELEASE_IMMUTABLE_IMAGE_REQUIRED")
    return value


def validate_evidence(value, run, jobs):
    if (not isinstance(run, dict) or run.get("head_sha") != value["tested_source_revision"]
        or run.get("repository", {}).get("full_name") != "salahassi/tenders"
        or run.get("path", "").split("@")[0] != ".github/workflows/deploy-digitalocean.yml"):
        raise ReleaseError("RELEASE_VALIDATION_SOURCE_MISMATCH")
    if not isinstance(jobs, dict) or not isinstance(jobs.get("jobs"), list):
        raise ReleaseError("RELEASE_VALIDATION_JOBS_INVALID")
    passed = [step for job in jobs["jobs"] for step in job.get("steps", [])
              if step.get("name") == "Verify application and deployment guards"
              and step.get("status") == "completed" and step.get("conclusion") == "success"]
    if len(passed) != 1:
        raise ReleaseError("RELEASE_APPLICATION_CHECKS_NOT_PASSED")


def api(path):
    headers = {"Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_READ_TOKEN")
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request("https://api.github.com/repos/salahassi/tenders/" + path, headers=headers)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError
        return json.loads(raw)
    except Exception:
        raise ReleaseError("RELEASE_VALIDATION_API_UNAVAILABLE") from None


def git(arguments):
    result = subprocess.run(["git", *arguments], cwd=ROOT, capture_output=True, timeout=60)
    if result.returncode:
        raise ReleaseError("RELEASE_SOURCE_INPUT_CHECK_FAILED")
    return result.stdout


def native_graph(entrypoint):
    visited, pending = set(), [ROOT / entrypoint]
    while pending:
        path = pending.pop().resolve()
        if path in visited:
            continue
        if not path.is_relative_to(ROOT) or not path.is_file():
            raise ReleaseError("NATIVE_SOURCE_IMPORT_INVALID")
        source = path.read_text()
        if re.search(r"\b(?:import|require)\s*\(", source):
            raise ReleaseError("NATIVE_DYNAMIC_SOURCE_IMPORT_REQUIRES_REBUILD")
        visited.add(path)
        for relative in re.findall(r'''(?:\bfrom\s*|\bimport\s*)["'](\.{1,2}/[^"']+)["']''', source):
            dependency = (path.parent / relative).resolve()
            if not dependency.suffix:
                dependency = dependency.with_suffix(".ts")
            pending.append(dependency)
    return visited


def verify_inputs(value):
    for revision in {value["tested_source_revision"], value["native_source_revision"]}:
        git(["fetch", "--depth=1", "origin", revision])
    # App code, tests, build inputs and previously validated operations are
    # unchanged. Only this read-only promotion gate, its manifest/tests and
    # documentation are excluded; no implementation file may silently differ.
    git(["diff", "--exit-code", value["tested_source_revision"], "HEAD", "--", "backend", "frontend", ".dockerignore",
         ".github/workflows/deploy-digitalocean.yml", ":!backend/docs/**", ":!backend/deploy/verified-release.json",
         ":!backend/scripts/ops/verify-release.py", ":!backend/scripts/ops/test_verified_release.py"])
    native = value["native_source_revision"]
    git(["diff", "--exit-code", native, "HEAD", "--", "backend/package.json", "backend/package-lock.json",
         "backend/deploy/Dockerfile.browser", "backend/deploy/Dockerfile.ocr"])
    counts = {}
    for name, entry in (("browser", "backend/scripts/backend/browser-source-worker.ts"),
                        ("ocr", "backend/scripts/backend/public-notice-ocr-worker.ts")):
        graph = native_graph(entry)
        for path in graph:
            baseline = git(["show", native + ":" + path.relative_to(ROOT).as_posix()])
            if baseline != path.read_bytes():
                raise ReleaseError("NATIVE_WORKER_SOURCE_CHANGED")
        counts[name] = len(graph)
    return counts


def main():
    value = validate_manifest(json.loads((ROOT / "backend/deploy/verified-release.json").read_text()))
    run = str(value["validation_run"])
    validate_evidence(value, api("actions/runs/" + run), api("actions/runs/" + run + "/jobs"))
    counts = verify_inputs(value)
    with open(os.environ["GITHUB_ENV"], "a") as stream:
        for name, reference in value["images"].items():
            stream.write("TENDERDESK_" + name.upper() + "_IMAGE=" + reference + "\n")
    print(json.dumps({"verified_release": "published_images_match_verified_application",
                      "tested_source_revision": value["tested_source_revision"], "native_module_counts": counts,
                      "images": len(value["images"])}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error) if isinstance(error, ReleaseError) else "RELEASE_VERIFICATION_FAILED"
        print(json.dumps({"verified_release": "blocked", "code": code}), flush=True)
        sys.exit(1)
