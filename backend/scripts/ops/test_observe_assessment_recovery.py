from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("tested_assessment_observer", Path(__file__).with_name("observe-assessment-recovery.py"))
o = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = o
SPEC.loader.exec_module(o)


def snapshot(**changes):
    value = {"observed_at": "2026-10-29T00:00:00Z", "latest_total": 1, "latest_statuses": [{"status": "completed", "count": 1}],
             "current_fit_total": 1, "current_fit_needs_review": 1, "current_fit_routing": [{"routing": "needs_review", "count": 1}],
             "pending_jobs": 0, "pending_opportunities": 0, "attention_jobs": [], "attention_plans": []}
    return {**value, **changes}


class ObserverTests(unittest.TestCase):
    def test_business_needs_review_is_a_completed_fit_but_runtime_wait_prevents_completion(self):
        self.assertTrue(o.terminal(o.validate_snapshot(snapshot()), 1))
        self.assertFalse(o.terminal(snapshot(pending_jobs=1), 1))
        self.assertFalse(o.terminal(snapshot(pending_opportunities=1), 1))
        self.assertFalse(o.terminal(snapshot(current_fit_total=0), 1))
        self.assertFalse(o.terminal(snapshot(), 18))

    def test_observation_polls_with_bounded_intervals_and_returns_only_aggregates(self):
        client = unittest.mock.Mock()
        client.snapshot.side_effect = [snapshot(pending_jobs=1), snapshot()]
        clock = iter([0, 0, 15])
        sleeps = []
        output = io.StringIO()
        with redirect_stdout(output):
            result = o.observe(client, timeout=30, interval=15, minimum_completed=1, clock=lambda: next(clock), pause=sleeps.append)
        self.assertEqual(result, 0)
        self.assertEqual(sleeps, [15])
        self.assertEqual(json.loads(output.getvalue().splitlines()[-1])["assessment_observation"], "completed")
        self.assertNotIn("opportunity_id", output.getvalue())

    def test_timeout_does_not_claim_completion_and_attention_is_preserved(self):
        client = unittest.mock.Mock()
        client.snapshot.return_value = snapshot(latest_statuses=[{"status": "blocked", "count": 1}], current_fit_total=0,
            attention_jobs=[{"type": "classify_opportunity", "status": "blocked", "error_code": "MODEL_NOT_CONFIGURED", "count": 1}])
        clock = iter([0, 30])
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(o.observe(client, timeout=30, interval=15, minimum_completed=1, clock=lambda: next(clock), pause=lambda _: None), 2)
        self.assertIn('"assessment_observation": "timeout"', output.getvalue())
        self.assertIn("MODEL_NOT_CONFIGURED", output.getvalue())

    def test_minimum_one_never_labels_a_mixed_terminal_batch_all_completed(self):
        client = unittest.mock.Mock()
        client.snapshot.return_value = snapshot(latest_total=2, latest_statuses=[{"status": "completed", "count": 1}, {"status": "blocked", "count": 1}],
            attention_jobs=[{"type": "classify_opportunity", "status": "blocked", "error_code": "MODEL_NOT_CONFIGURED", "count": 1}])
        output = io.StringIO()
        with redirect_stdout(output):
            result = o.observe(client, timeout=30, interval=15, minimum_completed=1, clock=lambda: 0, pause=lambda _: None)
        self.assertEqual(result, 0)
        receipt = json.loads(output.getvalue().splitlines()[-1])
        self.assertEqual(receipt["assessment_observation"], "terminal_with_attention")
        self.assertEqual(receipt["current_fit_total"], 1)
        self.assertEqual(receipt["latest_total"], 2)

    def test_result_shape_rejects_injected_text_or_identifier_fields(self):
        with self.assertRaises(o.ObserverError): o.validate_snapshot(snapshot(customer_text="must never print"))
        with self.assertRaises(o.ObserverError): o.validate_snapshot(snapshot(attention_jobs=[{"type": "bad text", "status": "blocked", "error_code": "NO", "count": 1}]))

    def test_cleanup_deletes_only_its_nonce_owned_resources_and_never_shared_admin(self):
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}): client = o.Client(30)
        resources = {("pod", client.pod): {"metadata": client.metadata(client.pod)}, ("secret", client.secret): {"metadata": client.metadata(client.secret)}}
        with patch.object(o.d, "get", side_effect=lambda kind,name: resources.get((kind,name))), patch.object(o.d, "command") as command:
            client.cleanup()
            self.assertEqual([x.args[0][1:3] for x in command.call_args_list], [["pod", client.pod], ["secret", client.secret]])
        resources["pod", client.pod]["metadata"]["labels"] = {"app.kubernetes.io/managed-by": "foreign"}
        with patch.object(o.d, "get", side_effect=lambda kind,name: resources.get((kind,name))), patch.object(o.d, "command") as command:
            with self.assertRaises(o.ObserverError): client.cleanup()
            self.assertFalse(any(x.args[0][1] == "pod" for x in command.call_args_list))

    def test_real_read_only_sql_selects_latest_nonarchived_plans_and_current_fit_hashes(self):
        process = subprocess.run(["node", str(Path(__file__).with_name("test_observe_assessment_recovery.mjs"))],
                                 input=json.dumps({"sql": o.SQL, "workspace": o.access.WORKSPACE}), text=True, capture_output=True, timeout=90)
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)


if __name__ == "__main__": unittest.main()
