"""Exact-job graph diagnostic guards; synthetic fixtures and no network."""
from contextlib import ExitStack, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("tested_proposal_graph_diagnostic", Path(__file__).with_name("proposal-graph-diagnostic.py"))
d = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = d
SPEC.loader.exec_module(d)
SELECTION = {"version": 1, "workspace_id": "00000000-0000-4000-8000-000000000100",
             "opportunity_id": "00000000-0000-4000-8000-000000000101", "plan_id": "00000000-0000-4000-8000-000000000102",
             "job_id": "00000000-0000-4000-8000-000000000103", "expected_runtime_image": d.RUNTIME_IMAGE}
RECEIPT = {"version": 1, "mode": "read_only_graph_diagnostic", "private_source": "PRIVATE SOURCE", "graph": {"quote": "PRIVATE QUOTE"}}


class GraphDiagnosticTests(unittest.TestCase):
    def test_selector_rejects_wrong_scope_extra_fields_and_unreviewed_runtime(self):
        with patch.object(d.access, "WORKSPACE", SELECTION["workspace_id"]):
            self.assertEqual(d.validate_selection(SELECTION), SELECTION)
            for key, value in [("version", True), ("version", 2), ("workspace_id", "00000000-0000-4000-8000-000000000999"),
                               ("plan_id", "';drop table x"), ("job_id", None), ("expected_runtime_image", d.RUNTIME_IMAGE[:-1] + "0"),
                               ("expected_runtime_image", "runtime:latest"), ("content", "PRIVATE"), ("action", "retry")]:
                with self.subTest(key=key, value=value), self.assertRaises(d.DiagnosticError):
                    d.validate_selection({**SELECTION, key: value})
            for key in SELECTION:
                with self.subTest(missing=key), self.assertRaises(d.DiagnosticError):
                    d.validate_selection({k: v for k, v in SELECTION.items() if k != key})

    def test_public_receipt_never_exports_retained_source_or_graph_payload(self):
        expected = {"proposal_graph_diagnostic": "inspected", "business_mutations": 0}
        self.assertEqual(d.public_receipt(RECEIPT), expected)
        self.assertEqual(d.public_receipt(RECEIPT, "a" * 64), {**expected, "report_sha256": "a" * 64})
        for value in [True, "PRIVATE", "a" * 65, "A" * 64]:
            with self.subTest(value=value), self.assertRaises(d.DiagnosticError):
                d.public_receipt(RECEIPT, value)
        for value in [{**RECEIPT, "version": True}, {**RECEIPT, "mode": "PRIVATE MODE"}]:
            with self.assertRaises(d.DiagnosticError):
                d.public_receipt(value)

    def run_main(self, *, fail_runtime=None, fail_sql=False, fail_cleanup=False, digest="b" * 64, limit=None):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {"DIGITALOCEAN_ACCESS_TOKEN": "fixture-secret", "GITHUB_RUN_ID": "123"}))
            stack.enter_context(patch.object(d.access, "WORKSPACE", SELECTION["workspace_id"]))
            stack.enter_context(patch.object(d.access, "prepare_cluster", return_value=Path(directory)))
            for name in ["identity", "download"]:
                stack.enter_context(patch.object(d.transfer, name))
            stack.enter_context(patch.object(d.transfer, "read_private", return_value=json.dumps(SELECTION).encode()))
            write = stack.enter_context(patch.object(d.transfer, "write_private"))
            upload = stack.enter_context(patch.object(d.transfer, "upload", return_value=digest))
            events = []
            def runtime(_image):
                events.append("runtime")
                if fail_runtime == events.count("runtime"):
                    raise d.inspector.base.ResumeError("RESUME_RUNTIME_CHANGED")
            verify = stack.enter_context(patch.object(d, "verify_runtime", side_effect=runtime))
            def sql(*_args):
                events.append("sql")
                if fail_sql:
                    raise RuntimeError("PRIVATE_SOURCE_OR_PROVIDER_ERROR")
                return json.dumps(RECEIPT)
            sql_call = stack.enter_context(patch.object(d.access.d, "sql", side_effect=sql))
            client = Mock(labels={})
            if fail_cleanup:
                client.cleanup.side_effect = RuntimeError("PRIVATE_CLEANUP_TEXT")
            construct = stack.enter_context(patch.object(d.observer, "Client", return_value=client))
            if limit is not None:
                stack.enter_context(patch.object(d, "MAX_REPORT_BYTES", limit))
            output = io.StringIO()
            with redirect_stdout(output):
                code = d.main(["--selection-object", "requests/synthetic.bundle", "--selection-sha256", "c" * 64])
            visible = output.getvalue()
            for hidden in ["PRIVATE", "fixture-secret", SELECTION["job_id"], SELECTION["workspace_id"], d.RUNTIME_IMAGE]:
                self.assertNotIn(hidden, visible)
            return {"exit": code, "receipt": json.loads(visible), "verify": verify.call_count,
                    "sql": sql_call.call_count, "constructed": construct.call_count, "cleanup": client.cleanup.call_count,
                    "upload": upload.call_count, "write": write.call_args, "events": events, "labels": client.labels}

    def test_runtime_mismatch_prevents_sql_or_private_publication_at_each_guard(self):
        for phase in [1, 2, 3]:
            with self.subTest(phase=phase):
                result = self.run_main(fail_runtime=phase)
                self.assertEqual(result["exit"], 1)
                self.assertEqual(result["receipt"]["code"], "PROPOSAL_GRAPH_RUNTIME_CHANGED")
                self.assertEqual(result["sql"], int(phase == 3))
                self.assertEqual(result["cleanup"], int(phase > 1))
                self.assertEqual(result["upload"], 0)

    def test_success_uses_three_runtime_guards_and_only_private_report_transport(self):
        result = self.run_main()
        self.assertEqual(result["exit"], 0)
        self.assertEqual(result["events"], ["runtime", "runtime", "sql", "runtime"])
        self.assertEqual(result["cleanup"], 1)
        self.assertEqual(result["upload"], 1)
        self.assertEqual(result["labels"]["app.kubernetes.io/managed-by"], d.OWNER)
        self.assertEqual(result["receipt"], {"proposal_graph_diagnostic": "inspected", "business_mutations": 0, "report_sha256": "b" * 64})
        private = json.loads(result["write"].args[1])
        self.assertEqual(private["private_source"], "PRIVATE SOURCE")
        self.assertEqual(private["verified_runtime_image"], d.RUNTIME_IMAGE)

    def test_private_errors_limits_and_cleanup_failures_have_fixed_public_codes(self):
        for args, expected in [({"fail_sql": True}, "PROPOSAL_GRAPH_DIAGNOSTIC_FAILED"),
                               ({"fail_cleanup": True}, "PROPOSAL_GRAPH_CLIENT_CLEANUP_NOT_CONFIRMED"),
                               ({"limit": 16}, "PROPOSAL_GRAPH_REPORT_TOO_LARGE"),
                               ({"digest": "PRIVATE_INVALID_DIGEST"}, "PROPOSAL_GRAPH_REPORT_DIGEST_INVALID")]:
            with self.subTest(args=args):
                result = self.run_main(**args)
                self.assertEqual(result["exit"], 1)
                self.assertEqual(result["receipt"]["code"], expected)
                self.assertEqual(result["cleanup"], 1)

    def test_push_runs_only_offline_guards_and_live_step_requires_manual_dispatch(self):
        text = (Path(__file__).resolve().parents[3] / ".github/workflows/diagnose-proposal-graph.yml").read_text()
        self.assertIn("branches: [codex/ai-reliability-resume]", text)
        self.assertIn("if: ${{ github.event_name == 'workflow_dispatch' }}", text)
        self.assertEqual(text.count("secrets.DIGITALOCEAN_ACCESS_TOKEN"), 1)
        self.assertIn("test_proposal_graph_diagnostic.py", text)
        self.assertNotIn("concurrency:", text)

    def test_exact_diagnostic_sql_against_full_schema_preserves_every_record(self):
        with patch.object(d.access, "WORKSPACE", SELECTION["workspace_id"]):
            sql = d.diagnostic_sql(SELECTION)
        self.assertIn("READ ONLY", sql)
        for forbidden in ["app_command(", "task_model_preflight(", "check_model_payload(", "UPDATE ", "INSERT ", "DELETE "]:
            self.assertNotIn(forbidden, sql)
        result = subprocess.run(["node", str(Path(__file__).with_name("test_proposal_graph_diagnostic.mjs"))],
                                input=json.dumps({"sql": sql, "selection": SELECTION}), capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr[-4000:])


if __name__ == "__main__":
    unittest.main()
