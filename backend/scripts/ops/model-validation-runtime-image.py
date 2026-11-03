#!/usr/bin/env python3
"""Build once or reuse an immutable runtime with the exact source revision."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys

REGISTRY = "registry.digitalocean.com/tenderdesk-a6093a76/runtime"
DIGEST = re.compile(re.escape(REGISTRY) + r"@sha256:[a-f0-9]{64}")


class ImageError(Exception):
    pass


def inspect(reference, revision, expected=None):
    result = subprocess.run(["docker", "image", "inspect", reference, "--format", "{{json .}}"],
                            capture_output=True, text=True, timeout=30)
    try:
        if result.returncode or len(result.stdout) > 1_048_576:
            raise ValueError()
        value = json.loads(result.stdout)
        if value.get("Config", {}).get("Labels", {}).get("org.opencontainers.image.revision") != revision:
            raise ImageError("MODEL_VALIDATION_IMAGE_SOURCE_MISMATCH")
        candidates = [item for item in value.get("RepoDigests", []) if isinstance(item, str) and DIGEST.fullmatch(item)]
        if expected is not None:
            if expected not in candidates:
                raise ImageError("MODEL_VALIDATION_IMAGE_DIGEST_MISMATCH")
            return expected
        if len(set(candidates)) != 1:
            raise ValueError()
        return candidates[0]
    except (ValueError, AttributeError, TypeError):
        raise ImageError("MODEL_VALIDATION_IMAGE_INSPECTION_FAILED") from None


def prepare():
    revision = os.environ.get("GITHUB_SHA", "")
    reuse = os.environ.get("TENDERDESK_REUSE_RUNTIME_IMAGE", "")
    if not re.fullmatch(r"[a-f0-9]{40}", revision) or (reuse and not DIGEST.fullmatch(reuse)):
        raise ImageError("MODEL_VALIDATION_IMAGE_IDENTITY_INVALID")
    reference = REGISTRY + ":" + revision
    reused = bool(reuse)
    directory = Path(os.environ["DOKS_WORKDIR"])
    with (directory / "model-validation-runtime-build.log").open("w") as log:
        def run(command):
            if subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=900).returncode:
                raise ImageError("MODEL_VALIDATION_IMAGE_COMMAND_FAILED")

        if reuse:
            run(["docker", "pull", reuse])
            selected = inspect(reuse, revision, expected=reuse)
        else:
            # A retry of the same workflow must not rebuild a different digest
            # after the first candidate has already admitted durable new pins.
            lookup = subprocess.run(["docker", "manifest", "inspect", reference],
                                    capture_output=True, text=True, timeout=90)
            if lookup.returncode == 0:
                run(["docker", "pull", reference])
                selected = inspect(reference, revision)
                reused = True
            elif re.search(r"manifest unknown|no such manifest", lookup.stderr, re.I):
                run(["docker", "build", "--platform=linux/amd64", "--file", "backend/deploy/Dockerfile",
                     "--label", "org.opencontainers.image.revision=" + revision, "--tag", reference, "."])
                run(["docker", "push", reference])
                selected = inspect(reference, revision)
            else:
                raise ImageError("MODEL_VALIDATION_IMAGE_LOOKUP_FAILED")
    with open(os.environ["GITHUB_ENV"], "a") as output:
        output.write("TENDERDESK_RUNTIME_IMAGE=" + selected + "\n")
    print(json.dumps({"image": "runtime", "status": "published", "digest": selected.split("@")[1],
                      "source_revision": revision, "existing_candidate_reused": reused}), flush=True)
    return selected


def main():
    try:
        prepare()
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, ImageError) else "MODEL_VALIDATION_IMAGE_FAILED"
        print(json.dumps({"image": "runtime", "status": "blocked", "code": code}), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
