import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("tested_queue_diagnosis", Path(__file__).with_name("diagnose-assessment-queue.py"))
q = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = q
SPEC.loader.exec_module(q)


class QueueDiagnosisTests(unittest.TestCase):
    def test_only_fixed_processing_labels_and_counts_are_projected(self):
        result = q.database_summary(json.dumps({"pending_job_counts": [{"status": "retry_wait", "error_code": "NOTICE_BROWSER_PENDING", "count": 17, "due_now": 17}],
                                               "browser_request_counts": [{"status": "queued", "error_code": None, "count": 17}],
                                               "processing_step_counts": [{"task": "read_notice_details", "status": "retry_wait", "count": 17, "due_now": 17}],
                                               "recovery_refresh_histogram": [{"refreshes": 0, "opportunities": 13}, {"refreshes": 1, "opportunities": 4}]}))
        self.assertEqual(result["pending_job_counts"][0]["error_code"], "NOTICE_BROWSER_PENDING")
        unsafe = json.dumps({"pending_job_counts": [{"status": "private-status", "error_code": "SECRET_PRIVATE_FIELD", "count": 1, "due_now": 0}], "browser_request_counts": [], "processing_step_counts": [], "recovery_refresh_histogram": []})
        output = json.dumps(q.database_summary(unsafe))
        self.assertNotIn("private-status", output)
        self.assertNotIn("SECRET_PRIVATE_FIELD", output)
        self.assertIn("OTHER_ERROR", output)
        with self.assertRaises(q.o.ObserverError):
            q.database_summary(json.dumps({"pending_job_counts": [], "browser_request_counts": [], "image": "must-not-print"}))

    def test_native_uid_lineage_excludes_unrelated_jobs_and_redacts_all_private_metadata(self):
        cron = {"metadata": {"name": "native-browser", "namespace": q.d.NAMESPACE, "uid": "cron-uid",
                             "labels": {"app.kubernetes.io/managed-by": "tenderdesk-deployment"}},
                "spec": {"suspend": False, "schedule": "PRIVATE_SCHEDULE"}, "status": {"active": [{"name": "PRIVATE_JOB_NAME"}]}}
        jobs = [{"metadata": {"namespace": q.d.NAMESPACE, "uid": "job-uid", "name": "PRIVATE_JOB_NAME",
                              "ownerReferences": [{"kind": "CronJob", "name": "native-browser", "uid": "cron-uid"}]},
                 "status": {"failed": 1, "conditions": [{"status": "True", "reason": "DeadlineExceeded"}]}},
                {"metadata": {"namespace": q.d.NAMESPACE, "uid": "unrelated"}, "status": {"active": 1}}]
        pods = [{"metadata": {"namespace": q.d.NAMESPACE, "name": "PRIVATE_POD_NAME", "ownerReferences": [{"kind": "Job", "uid": "job-uid"}]},
                 "spec": {"containers": [{"image": "PRIVATE_IMAGE"}]}, "status": {"phase": "Failed",
                    "containerStatuses": [{"state": {"terminated": {"reason": "OOMKilled", "message": "PRIVATE_CUSTOMER_MESSAGE"}}}]}},
                {"metadata": {"namespace": q.d.NAMESPACE, "ownerReferences": [{"kind": "Job", "uid": "unrelated"}]}, "status": {"phase": "Running"}}]
        with patch.object(q.d, "get", return_value=cron), patch.object(q.d, "command", side_effect=[json.dumps({"items": jobs}), json.dumps({"items": pods})]):
            result = q.kubernetes_summary()
        self.assertEqual(result["native_browser_jobs"], {"retained_total": 1, "active": 0, "succeeded": 0, "failed": 1})
        self.assertEqual(result["native_browser_pod_reasons"], {"OOMKilled": 1})
        self.assertTrue(result["native_browser_enabled"])
        self.assertNotIn("PRIVATE_", json.dumps(result))

    def test_query_is_read_only_and_returns_no_business_or_configuration_fields(self):
        query = q.query()
        self.assertIn("BEGIN READ ONLY", query)
        self.assertIn("NOT x.archived", query)
        self.assertIn("DISTINCT ON (p.opportunity_id)", query)
        self.assertIn("due_now", query)
        for forbidden in ("model_connections", "model_configurations", "provider_usage", "fit_assessments", "b.url", "prompt", "SELECT *", "INSERT INTO", "UPDATE public"):
            self.assertNotIn(forbidden, query)


if __name__ == "__main__": unittest.main()
