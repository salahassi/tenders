import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("verified_release_tested", Path(__file__).with_name("verify-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseGateTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {"tested_source_revision": "a" * 40, "native_source_revision": "b" * 40,
            "validation_run": 123, "images": {name: release.REGISTRY + name + "@sha256:" + "c" * 64 for name in release.COMPONENTS}}
        self.run = {"head_sha": "a" * 40, "repository": {"full_name": "salahassi/tenders"},
                    "path": ".github/workflows/deploy-digitalocean.yml", "conclusion": "failure"}
        self.jobs = {"jobs": [{"steps": [{"name": "Verify application and deployment guards", "status": "completed", "conclusion": "success"}]}]}

    def test_reuses_completed_application_checks_after_independent_image_upload_failure(self):
        release.validate_manifest(self.manifest)
        release.validate_evidence(self.manifest, self.run, self.jobs)

    def test_wrong_image_repository_component_or_mutable_reference_is_rejected(self):
        for value in ("other.example/runtime@sha256:" + "c" * 64,
                      release.REGISTRY + "browser@sha256:" + "c" * 64,
                      release.REGISTRY + "runtime:latest"):
            manifest = copy.deepcopy(self.manifest)
            manifest["images"]["runtime"] = value
            with self.assertRaises(release.ReleaseError):
                release.validate_manifest(manifest)

    def test_missing_component_boolean_run_and_invalid_revision_fail(self):
        for update in ({"validation_run": True}, {"tested_source_revision": "main"}, {"images": {}}):
            with self.assertRaises(release.ReleaseError):
                release.validate_manifest({**self.manifest, **update})

    def test_foreign_workflow_repository_and_revision_do_not_authorize_promotion(self):
        for update in ({"head_sha": "d" * 40}, {"path": ".github/workflows/unrelated.yml"},
                       {"repository": {"full_name": "other/tenders"}}):
            with self.assertRaises(release.ReleaseError):
                release.validate_evidence(self.manifest, {**self.run, **update}, self.jobs)

    def test_failed_pending_missing_and_ambiguous_application_checks_fail(self):
        for conclusion in ("failure", None):
            jobs = copy.deepcopy(self.jobs)
            jobs["jobs"][0]["steps"][0]["conclusion"] = conclusion
            with self.assertRaises(release.ReleaseError):
                release.validate_evidence(self.manifest, self.run, jobs)
        for jobs in ({"jobs": []}, {"jobs": self.jobs["jobs"] * 2}):
            with self.assertRaises(release.ReleaseError):
                release.validate_evidence(self.manifest, self.run, jobs)

    def test_native_graph_covers_transitive_static_imports(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(release, "ROOT", Path(directory)):
            root = Path(directory)
            (root / "entry.ts").write_text('import { value } from "./one.ts"; import fs from "node:fs";')
            (root / "one.ts").write_text('export { value } from "./two.ts";')
            (root / "two.ts").write_text('export const value = 1;')
            self.assertEqual({path.name for path in release.native_graph("entry.ts")}, {"entry.ts", "one.ts", "two.ts"})

    def test_dynamic_and_missing_native_dependencies_require_rebuild(self):
        for source in ('const module = import("./one.ts");', 'const module = require("./one.ts");', 'import "./missing.ts";'):
            with tempfile.TemporaryDirectory() as directory, patch.object(release, "ROOT", Path(directory)):
                (Path(directory) / "entry.ts").write_text(source)
                with self.assertRaises(release.ReleaseError):
                    release.native_graph("entry.ts")


if __name__ == "__main__":
    unittest.main()
