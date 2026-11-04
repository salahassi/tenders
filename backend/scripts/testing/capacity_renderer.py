#!/usr/bin/env python3
"""Offline, hash-bound native renderer measurement. No hosted or model calls.

An immutable cached application image supplies Deno and dependencies. Current
sources, fonts and frozen synthetic API-generated inputs are staged read-only.
Both successful and failed process receipts are retained at a fresh output path.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
IMAGE = "sha256:08eeb4ffa1c2"  # Resolved to the exact full local identity.
MODES = (
    "standard", "final-capacity", "worker-capacity", "verifier-capacity", "verifier-matrix", "boundary-render-only", "dense-heap-matrix",
    "streamed-capacity", "streamed-render-only", "concurrent-capacity",
    "density-edges", "density-render-only", "sparse-capacity",
    "sparse-render-only", "direction-capacity", "direction-render-only",
)


def docker(*args, timeout=60):
    env = dict(os.environ)
    for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS",
                "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
        env.pop(key, None)
    return subprocess.run(
        ["docker", "--host=unix:///var/run/docker.sock", *args],
        capture_output=True, text=True, timeout=timeout, env=env,
    )


def model_names(mode):
    if mode == "boundary-render-only":
        names = ("near10m-ascii", "near10m-mixed100", "empty-rows-storage-shape")
    elif mode in ("final-capacity", "verifier-matrix"):
        names = ("dense-minimal-sparse-body-limit-authored",
                 "dense-direction-runs-authored", "dense-ragged-authored",
                 "dense-empty-body-limit-authored", "dense-paragraph-authored",
                 "dense-short-authored", "dense-body-limit-authored")
    elif mode in ("worker-capacity", "verifier-capacity"):
        names = ("dense-minimal-sparse-body-limit-authored",)
    elif mode == "dense-heap-matrix":
        names = ("dense-authored",)
    elif mode in ("streamed-capacity", "streamed-render-only", "concurrent-capacity"):
        names = ("dense-short-authored", "dense-body-limit-authored")
    elif mode in ("density-edges", "density-render-only"):
        names = ("dense-empty-body-limit-authored", "dense-paragraph-authored")
    elif mode.startswith("sparse-"):
        names = ("dense-sparse-body-limit-authored",)
    elif mode.startswith("direction-"):
        names = ("dense-direction-runs-authored",)
    else:
        names = ("en-4000", "en-100000", "ar-1000000")
    return tuple(name + ".json" for name in names)


def run(models, image, mode="standard", artifacts=None,
        verifier_source=None, renderer_source=None, parent_heap=None, image_entrypoint=False, verification_artifact=None):
    if not re.fullmatch(r"sha256:[a-f0-9]{12,64}", image):
        raise ValueError("Pass an immutable local image ID")
    inspected = docker("image", "inspect", "--format", "{{.Id}}", image)
    if inspected.returncode:
        raise RuntimeError("Required cached Deno application image is unavailable")
    identity = inspected.stdout.strip()
    memory_mib = 384 if mode.startswith("verifier-") else 640
    cpu_limit = 0.7 if mode.startswith("verifier-") else 1
    if mode.startswith("verifier-") and not verification_artifact:
        raise ValueError("Verifier qualification requires a retained actual DOCX artifact")
    parent_flag = f"--v8-flags=--max-old-space-size={parent_heap} " if parent_heap else ""
    inputs = Path(models).resolve()
    names = model_names(mode)
    if any(not (inputs / name).is_file() for name in names):
        raise ValueError("Expected frozen synthetic model files for the selected mode")
    with tempfile.TemporaryDirectory(prefix="tenderdesk-capacity-") as temporary:
        stage = Path(temporary)
        app, staged_inputs, staged_outputs = (stage / name for name in ("app", "inputs", "outputs"))
        staged_inputs.mkdir()
        staged_outputs.mkdir()
        paths = (
            "backend/supabase/functions", "frontend/src/lib/renderDocx.ts",
            "frontend/src/lib/docxTableStream.ts", "frontend/public/fonts",
            "backend/scripts/testing/capacity_renderer.ts",
            "backend/scripts/testing/capacity_delivery_worker.ts",
            "backend/scripts/testing/capacity_renderer.py",
            "frontend/package.json", "frontend/package-lock.json",
            "backend/package.json", "backend/package-lock.json",
        )
        for relative in paths:
            source, target = ROOT / relative, app / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir():
                shutil.copytree(source, target)
            else:
                shutil.copyfile(source, target)
        if renderer_source:
            shutil.copyfile(renderer_source / "frontend/src/lib/renderDocx.ts",
                            app / "frontend/src/lib/renderDocx.ts")
        if verifier_source:
            for name in ("export.ts", "boundedDocx.ts", "boundedDocxArchive.ts", "boundedXml.ts"):
                shutil.copyfile(verifier_source / "backend/supabase/functions/_shared" / name,
                                app / "backend/supabase/functions/_shared" / name)
        for name in names:
            shutil.copyfile(inputs / name, staged_inputs / name)
        if verification_artifact:
            if mode == "verifier-matrix":
                for name in names:
                    shutil.copyfile(verification_artifact / (name.removesuffix(".json") + "-128.docx"), staged_inputs / name.replace(".json", ".docx"))
            else:
                shutil.copyfile(verification_artifact, staged_inputs / "verification.docx")
        hashes = {}
        for path in stage.rglob("*"):
            path.chmod(0o755 if path.is_dir() else 0o644)
            if path.is_file():
                hashes[str(path.relative_to(stage))] = hashlib.sha256(path.read_bytes()).hexdigest()
        stage.chmod(0o755)
        staged_outputs.chmod(0o777)
        container = "tdp-capacity-" + os.urandom(6).hex()
        started = time.monotonic()
        try:
            base = ["run", "--name", container, "--network", "none", "--memory", f"{memory_mib}m",
                    "--cpus", str(cpu_limit), "--pids-limit", "128", "--read-only", "--tmpfs",
                    "/tmp:rw,noexec,nosuid,size=64m",
                    "--mount", f"type=bind,src={staged_inputs},dst=/inputs,readonly",
                    "--mount", f"type=bind,src={staged_outputs},dst=/outputs"]
            if image_entrypoint:
                if parent_heap or verifier_source or renderer_source:
                    raise ValueError("Actual-image qualification cannot override product code or heap flags")
                result = docker(*base, "-e", f"APP_RUNTIME_SERVICE={'api' if mode.startswith('verifier-') else 'worker'}",
                    "--mount", f"type=bind,src={app / 'backend/scripts/testing'},dst=/app/backend/scripts/testing,readonly",
                    identity, "run", "--cached-only", "--frozen",
                    "--config=/app/backend/supabase/functions/deno.json",
                    "--allow-read=/app,/deno-dir,/inputs", "--allow-write=/outputs",
                    "--allow-env=APP_RUNTIME_SERVICE",
                    "--allow-run=/bin/deno,/bin/cat",
                    "/app/backend/scripts/testing/capacity_renderer.ts", "/inputs", mode, timeout=360)
                for relative in ("backend/supabase/functions", "backend/scripts/runtime", "frontend/src/lib", "frontend/public/fonts"):
                    actual = stage / "actual-image" / relative
                    actual.parent.mkdir(parents=True, exist_ok=True)
                    copied = docker("cp", f"{container}:/app/{relative}", str(actual))
                    if copied.returncode: raise RuntimeError("Cannot bind evidence to actual image sources")
                    prefix = "app/" + relative + "/"
                    hashes = {key: value for key, value in hashes.items() if not key.startswith(prefix)}
                    for path in actual.rglob("*"):
                        if path.is_file() and "node_modules" not in path.parts:
                            hashes[prefix + str(path.relative_to(actual))] = hashlib.sha256(path.read_bytes()).hexdigest()
            else:
                result = docker(*base, "--entrypoint", "/bin/sh",
                    "--mount", f"type=bind,src={app},dst=/app,readonly", identity, "-c",
                    '/bin/deno run --cached-only --frozen ' + parent_flag +
                    '--config=/app/backend/supabase/functions/deno.json '
                    '--allow-read=/app,/deno-dir,/inputs --allow-write=/outputs '
                    '--allow-run=/bin/deno,/bin/cat /app/backend/scripts/testing/capacity_renderer.ts '
                    '/inputs "$1"; result=$?; '
                    'cat /sys/fs/cgroup/memory.peak > /outputs/cgroup_memory_peak_bytes; '
                    'cat /sys/fs/cgroup/memory.max > /outputs/cgroup_memory_limit_bytes; '
                    'exit "$result"', "capacity", mode, timeout=360)
            state = docker("inspect", "--format", "{{json .State}}", container)
            state_data = json.loads(state.stdout) if state.returncode == 0 else {}
            lines = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
            if result.returncode or len(lines) != 1:
                # This harness accepts synthetic frozen fixtures only. Keep the
                # local failure log outside committed receipts for diagnosis.
                (staged_outputs / "native-process-error.log").write_text(result.stderr)
                receipt = {
                    "scope": "offline actual Deno native process failure", "mode": mode,
                    "hosted_acceptance": False, "production_slo_qualified": False,
                    "cases": [{"name": mode, "outcome": "bounded_error",
                               "code": "NATIVE_PROCESS_FAILED", "exit_code": result.returncode,
                               "stderr_bytes": len(result.stderr.encode()),
                               "v8_heap_exhausted": bool(re.search(
                                   r"out of memory|heap limit|Allocation failed", result.stderr, re.I)),
                               "cgroup_oom_killed": state_data.get("OOMKilled", False)}],
                }
            else:
                receipt = lines[0]
            for key in ("cgroup_memory_peak_bytes", "cgroup_memory_limit_bytes"):
                file = staged_outputs / key
                receipt[key] = int(file.read_text().strip()) if file.exists() else None
            for key in ("cgroup_memory_stat", "cgroup_memory_events"):
                file = staged_outputs / key
                if file.exists():
                    receipt[key] = {line.split()[0]: int(line.split()[1]) for line in file.read_text().splitlines()}
            if artifacts:
                shutil.copytree(staged_outputs, artifacts)
            receipt.update(
                image_id=identity, parent_old_space_limit_mebibytes=parent_heap,
                actual_image_entrypoint=image_entrypoint,
                runtime_source="immutable image; only synthetic harness mounted" if image_entrypoint else "hash-bound staged source overlay",
                container_limits={"memory_bytes": memory_mib * 1024 * 1024, "cpus": cpu_limit,
                                  "pids": 128, "network": "none", "read_only_root": True,
                                  "tmpfs_bytes": 64 * 1024 * 1024},
                elapsed_ms=round((time.monotonic() - started) * 1000),
                source_and_input_sha256=hashes,
            )
            return receipt
        finally:
            # Only this exact disposable container; never remove shared services.
            docker("rm", "-f", container)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--image", default=IMAGE)
    parser.add_argument("--image-entrypoint", action="store_true")
    parser.add_argument("--parent-heap", type=int, choices=(128,192,256,320,384))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--verification-artifact", type=Path)
    parser.add_argument("--verifier-source", type=Path)
    parser.add_argument("--renderer-source", type=Path)
    parser.add_argument("--mode", choices=MODES, default="standard")
    args = parser.parse_args()
    if args.output.exists():
        raise RuntimeError("Choose a new receipt path; existing evidence is immutable")
    artifacts = args.output.with_suffix("")
    if artifacts.exists():
        raise RuntimeError("Choose a new artifact path")
    receipt = run(args.models, args.image, args.mode, artifacts,
                  args.verifier_source, args.renderer_source, args.parent_heap, args.image_entrypoint, args.verification_artifact)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2) + "\n")
    failures = sum(case["outcome"] == "bounded_error" for case in receipt["cases"])
    print(json.dumps({"scope": receipt["scope"], "cases": len(receipt["cases"]),
                      "bounded_errors": failures, "output": str(args.output)}))
    raise SystemExit(1 if failures else 0)
