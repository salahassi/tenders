"""Exercise the single reviewed resume with synthetic records and no network."""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("tested_resume_requested_processing", Path(__file__).with_name("resume-requested-processing.py"))
r = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = r
SPEC.loader.exec_module(r)
SELECTION = {"version": 1, "workspace_id": "00000000-0000-4000-8000-000000000100", "opportunity_id": "00000000-0000-4000-8000-000000000101",
             "plan_id": "00000000-0000-4000-8000-000000000102", "expected_revision": 1, "kind": "proposal", "error_code": "DATA_AUTHORIZATION_REQUIRED"}


class RequestedProcessingResumeTests(unittest.TestCase):
    def test_private_selection_accepts_only_exact_scope_and_typed_identity(self):
        with patch.object(r.access, "WORKSPACE", SELECTION["workspace_id"]):
            self.assertEqual(r.validate_selection(SELECTION), SELECTION)
            for key, value in (("version", True), ("workspace_id", "00000000-0000-4000-8000-000000000999"),
                               ("plan_id", "invalid';DROP TABLE x"), ("expected_revision", True),
                               ("kind", "assessment"), ("error_code", "OTHER_ERROR"), ("sql", "SELECT 1")):
                candidate = {**SELECTION, key: value}
                with self.subTest(key=key), self.assertRaises(r.ResumeError):
                    r.validate_selection(candidate)

    def test_public_receipt_never_includes_selection_or_other_private_values(self):
        value = {"status": "resumed", "count": 1, "plan_id": "private", "content": "private", "actor": "private",
                 "private_diagnostics": {"sqlstate": "XX001", "message": "private", "context": "private"},
                 "private_state": {"role": "private"}}
        self.assertEqual(r.public_receipt(value), {"requested_processing_resume": "resumed", "count": 1})
        self.assertNotIn("private", json.dumps(r.public_receipt(value)))
        with self.assertRaises(r.ResumeError):
            r.public_receipt({"status": "arbitrary-private-value", "count": 0})
        with self.assertRaises(r.ResumeError):
            r.public_receipt({"status": "resumed", "count": True})

    def test_real_canonical_retry_preserves_inputs_and_budgets_and_rejects_changed_state(self):
        with patch.object(r.access, "WORKSPACE", SELECTION["workspace_id"]):
            valid = r.recovery_sql(SELECTION)
            changed = r.recovery_sql({**SELECTION, "expected_revision": 2})
            diagnose = r.recovery_sql(SELECTION, diagnose_only=True)
        payload = {"selection": SELECTION, "valid": valid, "changed": changed, "diagnose": diagnose,
                   "migration_sha256": __import__("hashlib").sha256(r.release.MIGRATION.read_bytes()).hexdigest()}
        result = subprocess.run(["node", str(Path(__file__).with_name("test_resume_requested_processing.mjs"))],
                                input=json.dumps(payload), capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr[-3000:])


if __name__ == "__main__":
    unittest.main()
