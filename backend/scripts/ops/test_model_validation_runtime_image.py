"""No registry calls: exercise exact candidate recovery and source binding."""
from __future__ import annotations

from contextlib import ExitStack, contextmanager, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("tested_validation_runtime_image", Path(__file__).with_name("model-validation-runtime-image.py"))
p = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = p
SPEC.loader.exec_module(p)
REVISION = "d" * 40
CANDIDATE = p.REGISTRY + "@sha256:" + "c" * 64


class RuntimeImageTests(unittest.TestCase):
    @contextmanager
    def fixture(self, *, exists=True, reuse="", label=REVISION, digest=CANDIDATE, lookup_error="no such manifest"):
        commands = []
        def run(command, **kwargs):
            commands.append(command)
            if command[1:3] == ["manifest", "inspect"]:
                return subprocess.CompletedProcess(command, 0 if exists else 1, "{}", lookup_error)
            if command[1:3] == ["image", "inspect"]:
                return subprocess.CompletedProcess(command, 0,
                    json.dumps({"Config": {"Labels": {"org.opencontainers.image.revision": label}}, "RepoDigests": [digest]}), "")
            return subprocess.CompletedProcess(command, 0)
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            environment = Path(directory) / "environment"
            stack.enter_context(patch.dict(os.environ, {"GITHUB_SHA": REVISION, "DOKS_WORKDIR": directory,
                "GITHUB_ENV": str(environment), "TENDERDESK_REUSE_RUNTIME_IMAGE": reuse}))
            stack.enter_context(patch.object(p.subprocess, "run", side_effect=run))
            stack.enter_context(redirect_stdout(io.StringIO()))
            yield commands, environment

    def test_first_build_labels_source_and_publishes_immutable_digest(self):
        with self.fixture(exists=False) as (commands, environment):
            self.assertEqual(p.prepare(), CANDIDATE)
            build = next(command for command in commands if command[1] == "build")
            self.assertIn("org.opencontainers.image.revision=" + REVISION, build)
            self.assertEqual(build[-1], ".")
            self.assertIn("backend/deploy/Dockerfile", build)
            self.assertEqual(environment.read_text(), "TENDERDESK_RUNTIME_IMAGE=" + CANDIDATE + "\n")

    def test_same_commit_retry_reuses_source_checked_candidate_without_rebuild(self):
        with self.fixture() as (commands, environment):
            p.prepare()
            self.assertIn(["docker", "pull", p.REGISTRY + ":" + REVISION], commands)
            self.assertFalse(any(command[1] in ("build", "push") for command in commands))

    def test_explicit_immutable_candidate_bypasses_mutable_tag_and_requires_exact_digest(self):
        with self.fixture(reuse=CANDIDATE) as (commands, environment):
            p.prepare()
            self.assertIn(["docker", "pull", CANDIDATE], commands)
            self.assertFalse(any(command[1] in ("manifest", "build", "push") for command in commands))
        with self.fixture(reuse=CANDIDATE, digest=p.REGISTRY + "@sha256:" + "e" * 64), self.assertRaisesRegex(p.ImageError, "DIGEST_MISMATCH"):
            p.prepare()

    def test_foreign_source_or_lookup_failure_never_rebuilds_or_publishes(self):
        for args, code in (({"label": "e" * 40}, "SOURCE_MISMATCH"),
                           ({"exists": False, "lookup_error": "network unavailable"}, "LOOKUP_FAILED")):
            with self.subTest(args=args), self.fixture(**args) as (commands, environment):
                with self.assertRaisesRegex(p.ImageError, code):
                    p.prepare()
                self.assertFalse(environment.exists())
                self.assertFalse(any(command[1] in ("build", "push") for command in commands))

    def test_untrusted_candidate_reference_refused_before_any_docker_command(self):
        for reuse in (p.REGISTRY + ":latest", "registry.example.invalid/runtime@sha256:" + "f" * 64):
            with self.subTest(reuse=reuse), self.fixture(reuse=reuse) as (commands, environment):
                with self.assertRaisesRegex(p.ImageError, "IDENTITY_INVALID"):
                    p.prepare()
                self.assertEqual(commands, [])


if __name__ == "__main__":
    unittest.main()
