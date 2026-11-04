#!/usr/bin/env python3
"""Offline role-specific startup/heap proof for the exact immutable runtime image."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time
from capacity_renderer import docker


def run(image):
    inspected = docker("image", "inspect", image)
    if inspected.returncode:
        raise RuntimeError("Immutable runtime image is unavailable")
    metadata = json.loads(inspected.stdout)[0]
    if not image.startswith("sha256:") or metadata["Id"] != image:
        raise ValueError("Pass the full immutable image identity")
    expected = ["/tini", "--", "docker-entrypoint.sh"]
    if metadata["Config"]["Entrypoint"] != expected:
        raise RuntimeError("Original pinned base entrypoint has changed")
    probe = '''import {getHeapStatistics} from "node:v8";
import {renderDocx} from "/app/frontend/src/lib/renderDocx.ts";
console.log(JSON.stringify({service:Deno.env.get("APP_RUNTIME_SERVICE"),heap_size_limit:getHeapStatistics().heap_size_limit,renderer_import:typeof renderDocx==="function",runtime:Deno.version}));'''
    results = []
    with tempfile.TemporaryDirectory(prefix="tdp-runtime-smoke-") as temporary:
        folder = Path(temporary)
        folder.chmod(0o755)
        script = folder / "probe.ts"
        script.write_text(probe)
        script.chmod(0o644)
        for role, memory in (("worker", 640), ("api", 384), ("source-browser", 256), ("scheduler", 192)):
            name = "tdp-runtime-smoke-" + os.urandom(5).hex()
            common = ["--network", "none", "--memory", f"{memory}m", "--cpus", "1",
                      "--read-only", "--pids-limit", "128", "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
                      "-e", f"APP_RUNTIME_SERVICE={role}"]
            try:
                started = docker("run", "-d", "--name", name, *common,
                    "-e", "SUPABASE_URL=http://127.0.0.1:9",
                    "-e", "APP_SUPABASE_PUBLISHABLE_KEY=synthetic-public",
                    "-e", "SUPABASE_SERVICE_ROLE_KEY=synthetic-service",
                    "-e", "APP_WORKER_SECRET=synthetic-worker", image)
                if started.returncode:
                    raise RuntimeError("Runtime role did not start")
                response = None
                for _ in range(30):
                    health = docker("exec", name, "/bin/busybox", "wget", "-Y", "off", "-qO-", "http://127.0.0.1:8080/healthz")
                    if health.returncode == 0:
                        response = json.loads(health.stdout)
                        break
                    time.sleep(0.1)
                if response != {"status": "ready", "component": role}:
                    logs = docker("logs", name)
                    raise RuntimeError("Synthetic runtime startup failed: " + (logs.stdout + logs.stderr)[-1000:])
                processes = docker("top", name, "-eo", "pid,args")
                command = processes.stdout
                capped = "--v8-flags=--max-old-space-size=256" in command
                if capped:
                    raise RuntimeError("Runtime process inspection needs diagnosis: " + json.dumps({"role":role,"returncode":processes.returncode,"stdout":command,"stderr":processes.stderr}))
                measured = docker("run", "--rm", *common,
                    "--mount", f"type=bind,src={script},dst=/probe.ts,readonly", image,
                    "run", "--cached-only", "--frozen", "--config=/app/backend/supabase/functions/deno.json",
                    "--allow-env=APP_RUNTIME_SERVICE", "--allow-read=/app,/deno-dir", "/probe.ts")
                if measured.returncode:
                    raise RuntimeError("Actual image renderer/heap import probe failed: " + measured.stderr[-1000:])
                item = json.loads(measured.stdout)
                if not item["renderer_import"]:
                    raise RuntimeError("Actual image lacks a renderer dependency")
                results.append({**item, "memory_limit_mebibytes": memory,
                                "default_main_health": response, "worker_flag_present": capped})
            finally:
                docker("rm", "-f", name)
    return {"scope": "actual immutable image original default startup without parent heap override",
            "hosted_acceptance": False, "provider_calls": 0, "image_id": image,
            "entrypoint": metadata["Config"]["Entrypoint"], "cmd": metadata["Config"]["Cmd"],
            "user": metadata["Config"]["User"], "probe_sha256": hashlib.sha256(probe.encode()).hexdigest(),
            "roles": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise RuntimeError("Evidence paths must be fresh")
    receipt = run(args.image)
    args.output.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"roles": len(receipt["roles"]), "output": str(args.output)}))
