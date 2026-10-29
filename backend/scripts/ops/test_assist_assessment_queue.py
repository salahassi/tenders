from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location("tested_assessment_assist", Path(__file__).with_name("assist-assessment-queue.py"))
a = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = a
SPEC.loader.exec_module(a)


def state(pending=1):
    return {"observed_at": "2026-10-29T00:00:00Z", "latest_total": 18,
            "latest_statuses": [{"status": "completed", "count": 18-pending}] + ([{"status": "queued", "count": pending}] if pending else []),
            "current_fit_total": 18-pending, "current_fit_needs_review": 0, "current_fit_routing": [],
            "pending_jobs": pending, "pending_opportunities": 0, "attention_jobs": [], "attention_plans": []}


def guard(**changes):
    return {**{"approved_opportunities": 18, "approved_latest_plans": 18, "outside_batch_pending": 0, "outside_batch_due": 0,
               "running_jobs": 0, "quota_wait_jobs": 0, "unknown_outcomes": 0}, **changes}


def diagnostics(due=1):
    return {"pending_job_counts": [{"status": "retry_wait", "error_code": "MODEL_IN_PROGRESS", "count": 1, "due_now": due}],
            "browser_request_counts": [], "processing_step_counts": [], "recovery_refresh_histogram": []}


class AssistTests(unittest.TestCase):
    def context(self, snapshot=None, guarded=None, due=1):
        self.addCleanup(patch.stopall)
        self.client = Mock(pod="private-pod")
        self.client.snapshot.return_value = snapshot or state()
        patch.object(a.d, "sql", return_value=json.dumps(guarded or guard())).start()
        patch.object(a.q, "database_summary", return_value=diagnostics(due)).start()
        patch.object(a, "verify_runtime").start()
        return self.client

    def test_normal_canonical_claim_then_completed_snapshot_terminates(self):
        client = self.context()
        client.snapshot.side_effect = [state(), state(0)]
        invoke = Mock(return_value={"ok": True, "claimed": True})
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(a.run(client, batch_id="approved-batch", clock=lambda: 0, invoke=invoke), 0)
        invoke.assert_called_once()
        self.assertEqual(json.loads(output.getvalue().splitlines()[-1])["assessment_assist"], "drained")
        for forbidden in ("observed_at", "current_fit_routing", "opportunity_id", "job_id", "private-pod"):
            self.assertNotIn(forbidden, output.getvalue())

    def test_scope_quota_unknown_and_attention_each_stop_before_any_invocation(self):
        for changes in ({"outside_batch_due": 1}, {"outside_batch_pending": 1}, {"approved_opportunities": 17}, {"quota_wait_jobs": 1}, {"unknown_outcomes": 1}):
            with self.subTest(changes=changes):
                client = self.context(guarded=guard(**changes))
                invoke = Mock()
                with redirect_stdout(io.StringIO()): self.assertEqual(a.run(client, batch_id="approved-batch", clock=lambda: 0, invoke=invoke), 2)
                invoke.assert_not_called()
        s = state(); s["attention_jobs"] = [{"type": "classify_opportunity", "status": "blocked", "error_code": "MODEL_CORRECTION_EXHAUSTED", "count": 1}]
        client = self.context(snapshot=s); invoke = Mock()
        with redirect_stdout(io.StringIO()): self.assertEqual(a.run(client, batch_id="approved-batch", clock=lambda: 0, invoke=invoke), 2)
        invoke.assert_not_called()

    def test_running_job_waits_and_absolute_time_budget_stops_without_invocation(self):
        client = self.context(guarded=guard(running_jobs=1))
        ticks = iter([0, 0, 600]); sleeps = []; invoke = Mock()
        with redirect_stdout(io.StringIO()):
            self.assertEqual(a.run(client, batch_id="approved-batch", clock=lambda: next(ticks), pause=sleeps.append, invoke=invoke), 2)
        self.assertEqual(sleeps, [15]); invoke.assert_not_called()

    def test_invocation_limit_and_false_claim_or_timeout_are_never_retried(self):
        client = self.context(); invoke = Mock(return_value={"ok": True, "claimed": True})
        with redirect_stdout(io.StringIO()):
            self.assertEqual(a.run(client, batch_id="approved-batch", clock=lambda: 0, max_invocations=2, invoke=invoke), 2)
        self.assertEqual(invoke.call_count, 2)
        for result in ({"ok": True, "claimed": False}, {"ok": False, "claimed": False}):
            invoke = Mock(return_value=result)
            with redirect_stdout(io.StringIO()): a.run(client, batch_id="approved-batch", clock=lambda: 0, invoke=invoke)
            invoke.assert_called_once()
        invoke = Mock(side_effect=RuntimeError("PRIVATE_REMOTE_BODY")); output = io.StringIO()
        with redirect_stdout(output): self.assertEqual(a.run(client, batch_id="approved-batch", clock=lambda: 0, invoke=invoke), 1)
        invoke.assert_called_once(); self.assertNotIn("PRIVATE_REMOTE_BODY", output.getvalue())

    def test_worker_code_has_literal_private_destination_narrow_permissions_and_boolean_only_proof(self):
        with patch.object(a, "scheduler_pod", return_value="verified-scheduler-pod"), patch.object(a.time, "monotonic", return_value=0), patch.object(a.d, "command", return_value='{"ok":true,"claimed":false}') as command:
            self.assertEqual(a.invoke_worker(35), {"ok": True, "claimed": False})
        args = command.call_args.args[0]; script = command.call_args.kwargs["payload"]
        self.assertIn("--allow-env=APP_WORKER_SECRET", args)
        self.assertEqual(args[0], "--request-timeout=34s")
        self.assertIn("--allow-net=worker:8080", args)
        self.assertNotIn("--allow-read", args)
        self.assertNotIn("--allow-all", args)
        self.assertIn('fetch("http://worker:8080/functions/v1/worker"', script)
        self.assertIn("AbortSignal.timeout(30000)", script)
        self.assertIn("console.log(JSON.stringify({ok,claimed}))", script)
        self.assertLessEqual(command.call_args.kwargs["timeout"], 34)

    def test_guard_is_read_only_and_rejects_untrusted_batch_or_shape(self):
        query = a.guard_sql("approved-batch")
        self.assertIn("BEGIN READ ONLY", query)
        self.assertIn("ops.model_assessment.sample", query)
        self.assertIn("ops.model_assessment.recovered", query)
        self.assertIn("outside_batch_due", query)
        self.assertIn("(SELECT count(*) FROM public.workspaces)<>1", query)
        for statement in ("UPDATE public", "INSERT INTO", "DELETE FROM", "app_command", "claim_backend"):
            self.assertNotIn(statement, query)
        with self.assertRaises(a.AssistError): a.guard_sql("batch'; select secret;")
        with self.assertRaises(a.AssistError): a.guard_result(json.dumps({**guard(), "private": "must-not-print"}))

    def test_scheduler_pod_is_selected_by_controller_uid_image_and_ready_state_then_rechecked(self):
        container = {"name": "scheduler", "image": a.EXPECTED_IMAGE}
        rs = {"metadata": {"namespace": a.d.NAMESPACE, "uid": "rs-uid", "ownerReferences": [{"kind": "Deployment", "uid": "deployment-uid"}]},
              "spec": {"template": {"spec": {"containers": [container]}}}, "status": {"readyReplicas": 1}}
        pod = {"metadata": {"name": "scheduler-verified", "namespace": a.d.NAMESPACE, "uid": "pod-uid", "ownerReferences": [{"kind": "ReplicaSet", "uid": "rs-uid"}]},
               "spec": {"containers": [container]}, "status": {"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]}}
        def get(kind, name): return {"metadata": {"uid": "deployment-uid"}} if kind == "deployment" else pod
        with patch.object(a, "verify_runtime"), patch.object(a.d, "get", side_effect=get), patch.object(a.d, "command", side_effect=[json.dumps({"items": [rs]}), json.dumps({"items": [pod]})]):
            self.assertEqual(a.scheduler_pod(), "scheduler-verified")
        with patch.object(a, "verify_runtime"), patch.object(a.d, "get", side_effect=[{"metadata": {"uid": "deployment-uid"}}, {"metadata": {"uid": "different-uid"}}]), \
             patch.object(a.d, "command", side_effect=[json.dumps({"items": [rs]}), json.dumps({"items": [pod]})]):
            with self.assertRaisesRegex(a.AssistError, "SCHEDULER_POD_CHANGED"): a.scheduler_pod()


if __name__ == "__main__": unittest.main()
