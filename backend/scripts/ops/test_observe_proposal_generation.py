"""Read-only proposal observation checks; no external calls."""
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

SPEC = importlib.util.spec_from_file_location("tested_proposal_observer", Path(__file__).with_name("observe-proposal-generation.py"))
o = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = o
SPEC.loader.exec_module(o)
SELECTION = {"version": 1, "workspace_id": "00000000-0000-4000-8000-000000000100",
             "opportunity_id": "00000000-0000-4000-8000-000000000101", "plan_id": "00000000-0000-4000-8000-000000000102"}
IMAGE = "registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:" + "a" * 64


def snapshot(status="queued", **changes):
    job_status = {"completed": "succeeded", "blocked": "blocked", "failed": "failed", "canceled": "canceled"}.get(status, status)
    value = {"version": 1, "stage": "analysis" if status != "completed" else "completed", "plan_status": status,
             "plan_revision": 1, "error_code": None, "jobs_total": 1, "job_counts": [{"status": job_status, "count": 1}],
             "job_errors": [], "pending_jobs": int(job_status in {"queued", "running", "retry_wait", "quota_wait"}),
             "active_requests": 0, "version_count": int(status == "completed"), "current_version": status == "completed"}
    return {**value, **changes}


def run_observation(values, timeout=90):
    client = Mock()
    client.snapshot.side_effect = values
    now = [0]
    sleeps = []
    def pause(seconds):
        sleeps.append(seconds)
        now[0] += seconds
    output = io.StringIO()
    with redirect_stdout(output):
        result = o.observe(client, timeout=timeout, interval=15, clock=lambda: now[0], pause=pause)
    return result, sleeps, output.getvalue()


class ProposalObserverTests(unittest.TestCase):
    def test_queued_and_running_are_observed_until_a_current_completed_version(self):
        result, sleeps, output = run_observation([snapshot(), snapshot("running"), snapshot("completed")])
        self.assertEqual(result["outcome"], "completed")
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(sleeps, [15, 15])
        self.assertEqual(len(output.splitlines()), 3)
        self.assertNotIn("plan_id", output)

    def test_blocked_requires_two_stable_idle_samples_and_resets_after_progress(self):
        for status in ["blocked", "failed", "canceled"]:
            result, sleeps, _ = run_observation([snapshot(status), snapshot("queued"), snapshot(status), snapshot(status)])
            self.assertEqual(result["outcome"], "terminal_with_attention")
            self.assertEqual(result["samples"], 4)
            self.assertEqual(sleeps, [15, 15, 15])

    def test_queued_wait_and_active_reserved_request_timeout_without_false_terminal(self):
        for value in [snapshot(), snapshot("blocked", active_requests=1),
                      snapshot("blocked", job_counts=[{"status": "retry_wait", "count": 1}], pending_jobs=1)]:
            result, sleeps, _ = run_observation([value, value, value], timeout=30)
            self.assertEqual(result["outcome"], "timeout")
            self.assertEqual(result["exit_code"], 2)
            self.assertEqual(sleeps, [15, 15])

    def test_completed_without_published_current_version_is_attention(self):
        value = snapshot("completed", current_version=False, version_count=0)
        result, _, _ = run_observation([value, value])
        self.assertEqual(result["outcome"], "terminal_with_attention")

    def test_public_projection_has_fixed_labels_and_merges_unknown_error_text(self):
        value = snapshot("blocked", error_code="PRIVATE_ACCOUNT_123", jobs_total=2,
                         job_counts=[{"status": "blocked", "count": 2}],
                         job_errors=[{"error_code": "PRIVATE FIRST", "count": 1}, {"error_code": "PRIVATE_SECOND", "count": 1}])
        visible = o.public_snapshot(value)
        self.assertEqual(visible["error_code"], "UNCLASSIFIED")
        self.assertEqual(visible["job_errors"], [{"error_code": "UNCLASSIFIED", "count": 2}])
        self.assertNotIn("PRIVATE", json.dumps(visible))
        self.assertNotIn("plan_revision", visible)
        for changes in [{"source_text": "private"}, {"stage": "private"}, {"jobs_total": True},
                        {"pending_jobs": 0}, {"job_counts": [{"status": "private", "count": 1}]}]:
            with self.subTest(changes=changes), self.assertRaises(o.ObservationError):
                o.public_snapshot(snapshot(**changes))

    def test_selection_limits_runtime_guard_and_client_deadline(self):
        for timeout, interval in [(901, 15), (14, 15), (60, 14), (60, 61), (True, 15)]:
            with self.subTest(timeout=timeout, interval=interval), self.assertRaises(o.ObservationError):
                o.validate_limits(timeout, interval)
        for image in ["latest", IMAGE + "private", True]:
            with self.assertRaises(o.ObservationError):
                o.validate_runtime_image(image)
        with patch.object(o.access, "WORKSPACE", SELECTION["workspace_id"]), patch.dict(os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}):
            client = o.Client(900, SELECTION, IMAGE)
            self.assertEqual(client.timeout + 240, 1200)
            self.assertEqual(client.labels["app.kubernetes.io/managed-by"], o.OWNER)
            with patch.object(o, "verify_runtime", side_effect=o.inspector.base.ResumeError("RESUME_RUNTIME_CHANGED")), patch.object(o.access.d, "sql") as sql:
                with self.assertRaises(o.inspector.base.ResumeError):
                    client.snapshot()
                sql.assert_not_called()
            with self.assertRaises(o.inspector.RecoveryError):
                o.progress_sql({**SELECTION, "provider": "qwencloud"})

    def test_owned_cleanup_refuses_foreign_resources(self):
        with patch.object(o.access, "WORKSPACE", SELECTION["workspace_id"]), patch.dict(os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}):
            client = o.Client(900, SELECTION, IMAGE)
        resources = {("pod", client.pod): {"metadata": client.metadata(client.pod)},
                     ("secret", client.secret): {"metadata": client.metadata(client.secret)}}
        resources["pod", client.pod]["metadata"]["labels"] = {"app.kubernetes.io/managed-by": "foreign"}
        with patch.object(o.observer.d, "get", side_effect=lambda kind, name: resources.get((kind, name))), patch.object(o.observer.d, "command") as command:
            with self.assertRaises(o.observer.ObserverError):
                client.cleanup()
            self.assertFalse(any(call.args[0][1] == "pod" for call in command.call_args_list))

    def test_main_keeps_final_report_private_and_cleanup_failure_fails_closed(self):
        for fail_cleanup in [False, True]:
            with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                stack.enter_context(patch.dict(os.environ, {"DIGITALOCEAN_ACCESS_TOKEN": "fixture-secret", "GITHUB_RUN_ID": "123"}))
                stack.enter_context(patch.object(o.access, "WORKSPACE", SELECTION["workspace_id"]))
                stack.enter_context(patch.object(o.access, "prepare_cluster", return_value=Path(directory)))
                for name in ["identity", "download", "write_private"]:
                    stack.enter_context(patch.object(o.transfer, name))
                stack.enter_context(patch.object(o.transfer, "read_private", return_value=json.dumps(SELECTION).encode()))
                upload = stack.enter_context(patch.object(o.transfer, "upload", return_value="b" * 64))
                stack.enter_context(patch.object(o, "verify_runtime"))
                client = Mock()
                client.final_inspection.return_value = {"private": "PRIVATE_FINAL_REPORT"}
                if fail_cleanup:
                    client.cleanup.side_effect = RuntimeError("PRIVATE CLEANUP FAILURE")
                stack.enter_context(patch.object(o, "Client", return_value=client))
                stack.enter_context(patch.object(o, "observe", return_value={"outcome": "completed", "exit_code": 0, "samples": 2, "snapshot": snapshot("completed")}))
                output = io.StringIO()
                with redirect_stdout(output):
                    result = o.main(["--selection-object", "requests/synthetic.bundle", "--selection-sha256", "c" * 64,
                                     "--expected-runtime-image", IMAGE, "--timeout", "30"])
                self.assertEqual(result, 1 if fail_cleanup else 0)
                upload.assert_called_once()
                client.cleanup.assert_called_once()
                self.assertNotIn("PRIVATE", output.getvalue())
                self.assertNotIn("fixture-secret", output.getvalue())
                self.assertNotIn(SELECTION["plan_id"], output.getvalue())
                if not fail_cleanup:
                    self.assertEqual(json.loads(output.getvalue())["report_sha256"], "b" * 64)

    def test_workflow_push_runs_only_offline_guards(self):
        workflow = (Path(__file__).resolve().parents[3] / ".github/workflows/observe-proposal-generation.yml").read_text()
        self.assertIn("branches: [codex/ai-reliability-resume]", workflow)
        self.assertIn("if: ${{ github.event_name == 'workflow_dispatch' }}", workflow)
        self.assertEqual(workflow.count("secrets.DIGITALOCEAN_ACCESS_TOKEN"), 1)
        self.assertIn("test_observe_proposal_generation.py", workflow)
        self.assertNotIn("concurrency:", workflow)

    def test_progress_sql_is_exact_readonly_and_scoped_against_full_schema(self):
        with patch.object(o.access, "WORKSPACE", SELECTION["workspace_id"]):
            sql = o.progress_sql(SELECTION)
        for forbidden in ["app_command(", "task_model_preflight(", "check_model_payload(", "UPDATE ", "INSERT ", "DELETE "]:
            self.assertNotIn(forbidden, sql)
        self.assertIn("REPEATABLE READ READ ONLY", sql)
        result = subprocess.run(["node", str(Path(__file__).with_name("test_observe_proposal_generation.mjs"))],
                                input=json.dumps({"sql": sql, "selection": SELECTION}), capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr[-4000:])


if __name__ == "__main__":
    unittest.main()
