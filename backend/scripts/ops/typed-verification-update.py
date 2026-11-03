#!/usr/bin/env python3
"""Configure the audited code-only updater for typed verification format three.

This wrapper never opens a database connection or activates processing. New
format pins may be durable after admission, so partial releases complete forward
with the same source-bound immutable candidate.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("typed_verification_runtime_release", HERE / "model-validation-update.py")
code = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = code
SPEC.loader.exec_module(code)
code.RELEASE = "typed-verification-code-v1"
code.BASE_RUNTIME = code.u.REGISTRY + "runtime@sha256:bded9f019592be84ae45e078d55a52e438c3f6942b2bd1bf35d148d4ff0d6c4a"
code.ROLLOUT_MARKER = "tenderdesk-deployment/typed-verification-image"
code.PRIOR_MIGRATIONS.update({
    "20261103022500_analysis_verifier_recheck.sql": "cead30c43776e35822e4fa63476223a5ff4abe8de35218286d66dd5bd8c22382",
    "20261103031500_analysis_recheck_prompt_identity.sql": "30f79868deaa94daab1554584aede2545a1611a29f7b19d26503e75f57720f14",
    "20261103032000_model_admission_fairness.sql": "3bb13dd60fb4322ac3ba70c534ec6165a668da547318d1ea49232ae1d401c927",
})


def emit(status, **values):
    print(json.dumps({"update": "typed_verification", "release": code.RELEASE,
                      "status": status, **values}, sort_keys=True), flush=True)


# The strategy patch changes Deployment generation without replacing pods.
# Wait until the controller has acknowledged it before the shared final ready
# check, as already required by the preceding verifier-recheck release.
_patch_worker_strategy = code.patch_worker_strategy


def patch_worker_strategy(original, selected, recreate):
    _patch_worker_strategy(original, selected, recreate)
    if not recreate:
        code.u.d.wait_deployments(["worker"])


code.emit = emit
code.patch_worker_strategy = patch_worker_strategy


if __name__ == "__main__":
    sys.exit(code.main())
