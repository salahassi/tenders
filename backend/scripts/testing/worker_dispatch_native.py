#!/usr/bin/env python3
"""Qualify actual worker/scheduler entrypoints in an immutable image, offline.

Runs the original container entrypoint/Cmd as worker, then uses docker exec only
for the synthetic loopback gateway and scheduler child. Product files are never
mounted over. Each copied source is hashed inside the actual image and compared
with this checkout; SQL durability is deliberately outside this native proof.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[3]
DRIVER = Path(__file__).resolve()
SCRIPT = DRIVER.with_suffix(".ts")
CHECKS = (
    "worker_authentication", "worker_foreground_maintenance_auth_no_rpc",
    "worker_idle_prompt", "worker_ready_response_before_maintenance",
    "worker_poll_delay_returned_without_sleep", "scheduler_maintenance_independent",
    "scheduler_completion_metadata", "scheduler_failure_retry", "shutdown_drained",
)


def docker(*args, timeout=60):
    environment = dict(os.environ)
    for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
        environment.pop(key, None)
    return subprocess.run(["docker", "--host=unix:///var/run/docker.sock", *args],
                          capture_output=True, text=True, timeout=timeout, env=environment)


def must(result, code):
    if result.returncode:
        raise RuntimeError(code + ": " + (result.stdout + result.stderr)[-1600:])
    return result.stdout


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def copied_sources():
    paths = []
    for folder in ("backend/supabase/functions", "backend/scripts/runtime", "frontend/public/fonts"):
        paths.extend(path for path in (ROOT / folder).rglob("*") if path.is_file())
    paths.extend(ROOT / "frontend/src/lib" / name for name in ("renderDocx.ts", "docxTableStream.ts"))
    return {str(path.relative_to(ROOT)): digest(path) for path in sorted(paths)}


def run(image):
    harness_hashes = {str(path.relative_to(ROOT)): digest(path) for path in (DRIVER, SCRIPT)}
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError("Pass the full immutable local image identity")
    metadata = json.loads(must(docker("image", "inspect", image), "IMAGE_INSPECTION_FAILED"))[0]
    if metadata["Id"] != image or metadata["Config"]["Entrypoint"] != ["/tini", "--", "docker-entrypoint.sh"]:
        raise ValueError("Unexpected original image identity or entrypoint")
    command = metadata["Config"]["Cmd"]
    if command[0] != "run" or command[-1] != "scripts/runtime/main.ts":
        raise ValueError("Expected the real runtime main command")
    name = "tdp-worker-native-" + os.urandom(6).hex()
    receipt = None
    cleanup = False
    started = time.monotonic()
    try:
        must(docker("run", "-d", "--name", name, "--network", "none", "--read-only",
            "--memory", "1280m", "--cpus", "2", "--pids-limit", "128",
            "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
            "--mount", f"type=bind,src={SCRIPT},dst=/native-fixture.ts,readonly",
            "-e", "APP_RUNTIME_SERVICE=worker", "-e", "SUPABASE_URL=http://127.0.0.1:8081",
            "-e", "APP_SUPABASE_PUBLISHABLE_KEY=native-fixture-public",
            "-e", "SUPABASE_SERVICE_ROLE_KEY=native-fixture-service",
            "-e", "APP_WORKER_SECRET=native-fixture-worker",
            "-e", "NO_PROXY=127.0.0.1,localhost", "-e", "no_proxy=127.0.0.1,localhost",
            image), "CONTAINER_START_FAILED")
        health = None
        for _ in range(50):
            result = docker("exec", name, "/bin/busybox", "wget", "-Y", "off", "-qO-",
                            "http://127.0.0.1:8080/healthz")
            if result.returncode == 0:
                health = json.loads(result.stdout)
                break
            time.sleep(0.1)
        if health != {"status": "ready", "component": "worker"}:
            raise RuntimeError("ACTUAL_DEFAULT_WORKER_NOT_READY: " + docker("logs", name).stderr[-1000:])
        container = json.loads(must(docker("inspect", name), "CONTAINER_INSPECTION_FAILED"))[0]
        if container["HostConfig"]["NetworkMode"] != "none" or not container["HostConfig"]["ReadonlyRootfs"]:
            raise RuntimeError("OFFLINE_ISOLATION_MISSING")
        output = must(docker("exec", "-e", "NATIVE_IMAGE_CMD=" + json.dumps(command), name,
            "/bin/deno", "run", "--cached-only", "--frozen",
            "--config=/app/backend/supabase/functions/deno.json", "--allow-env", "--allow-net",
            "--allow-sys", "--allow-run=/bin/deno", "--allow-read=/app,/deno-dir,/native-fixture.ts",
            "--allow-write=/tmp", "/native-fixture.ts", timeout=35), "NATIVE_FIXTURE_FAILED")
        native = json.loads(output.strip())
        if native.get("passed") is not True or any(native.get("checks", {}).get(check) is not True for check in CHECKS):
            raise RuntimeError("NATIVE_CHECK_MISSING")
        if native["source_sha256"] != copied_sources():
            raise RuntimeError("IMAGE_SOURCE_DIFFERS_FROM_CHECKOUT")
        if harness_hashes != {str(path.relative_to(ROOT)): digest(path) for path in (DRIVER, SCRIPT)}:
            raise RuntimeError("HARNESS_CHANGED_DURING_EXECUTION")
        must(docker("stop", "--time", "5", name), "WORKER_SHUTDOWN_FAILED")
        state = json.loads(must(docker("inspect", name), "STOPPED_INSPECTION_FAILED"))[0]["State"]
        if state["Running"] or state["ExitCode"] != 0 or state["OOMKilled"]:
            raise RuntimeError("WORKER_SHUTDOWN_NOT_DRAINED")
        receipt = {"version": 1, "kind": "proposal_dispatch_native", "image_id": image,
            "passed": True, "actual_image_entrypoint": True, "network": "none", "external_calls": 0,
            "image_entrypoint": metadata["Config"]["Entrypoint"], "image_cmd": command,
            "image_user": metadata["Config"]["User"], "hosted_acceptance": False,
            "resources": {"memory_mib": 1280, "cpus": 2, "pids_limit": 128,
                          "tmpfs_mib": 64, "readonly_rootfs": True},
            "harness_sha256": harness_hashes,
            "duration_seconds": round(time.monotonic() - started, 3), **native}
    finally:
        removed = docker("rm", "-f", name)
        cleanup = removed.returncode == 0 and docker("inspect", name).returncode != 0
    if not cleanup:
        raise RuntimeError("OWNED_CONTAINER_CLEANUP_FAILED")
    receipt["cleanup_verified"] = True
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError("Evidence output must be a fresh path")
    value = run(args.image)
    args.output.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"passed": value["passed"], "checks": len(value["checks"]),
                      "image_id": value["image_id"], "output": str(args.output)}))
