#!/usr/bin/env python3
"""Read anonymous assessment-wait and owned native-worker health counters."""
import collections
import importlib.util
import json
import re
import shutil
import sys
from pathlib import Path

SPEC = importlib.util.spec_from_file_location("assessment_queue_observer", Path(__file__).with_name("observe-assessment-recovery.py"))
o = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = o
SPEC.loader.exec_module(o)
d = o.d
ERRORS = frozenset({"NOTICE_BROWSER_PENDING", "SOURCE_BROWSER_PENDING", "NOTICE_OCR_PENDING", "SOURCE_OCR_PENDING", "MODEL_IN_PROGRESS",
    "MODEL_NOT_CONFIGURED", "GENERATION_HANDLER_FAILED", "MODEL_ROUND_EXHAUSTED", "MODEL_CORRECTION_EXHAUSTED", "MODEL_OUTPUT_INVALID",
    "MODEL_OUTPUT_TRUNCATED", "MODEL_RATE_WAIT", "MODEL_DAILY_QUOTA_WAIT", "PROVIDER_QUOTA_WAIT", "MODEL_NETWORK_UNCERTAIN",
    "MODEL_RESPONSE_UNAVAILABLE", "MODEL_IDENTITY_CHANGED", "DATA_AUTHORIZATION_REQUIRED", "SOURCE_BROWSER_FAILED", "SOURCE_TIMEOUT",
    "SOURCE_LOGIN_REQUIRED", "SOURCE_HUMAN_VERIFICATION_REQUIRED", "STALE_INPUT", "USAGE_UNKNOWN", "LEASE_EXPIRED_REVIEW_REQUIRED",
    "NOTICE_DETAILS_REQUIRED", "NOTICE_DETAILS_REFRESHED", "EVIDENCE_REFERENCE_INVALID", "NOTICE_DETAILS_UNAVAILABLE", "MODEL_CONTEXT_TOO_LARGE"})
STATUSES = frozenset({"queued", "running", "retry_wait", "quota_wait", "blocked", "failed", "canceled", "succeeded", "ready"})
PHASES = frozenset({"Pending", "Running", "Succeeded", "Failed", "Unknown"})
TASKS = frozenset({"read_notice_details", "classify_opportunity", "advance_plan", "OTHER_TASK"})
REASONS = frozenset({"OOMKilled", "DeadlineExceeded", "ImagePullBackOff", "ErrImagePull", "CrashLoopBackOff", "ContainerCreating",
    "CreateContainerConfigError", "CreateContainerError", "Error", "Completed", "Evicted", "NodeLost", "Unschedulable", "BackOff", "PodInitializing",
    "BackoffLimitExceeded", "FailedCreate", "FailedScheduling"})


def fixed(value, allowed, other):
    return value if isinstance(value, str) and value in allowed else other


def query():
    codes = ",".join("'" + code + "'" for code in sorted(ERRORS))
    return """BEGIN READ ONLY; SET LOCAL ROLE tdp_app_owner; SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_database()<>'tenderdesk_app' OR NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id='__WORKSPACE__')
 THEN RAISE EXCEPTION 'ASSESSMENT_QUEUE_DATABASE_MISMATCH'; END IF; END $$;
WITH latest AS (
 SELECT DISTINCT ON (p.opportunity_id) p.id,p.workspace_id FROM public.generation_plans p
 JOIN public.opportunities x ON x.id=p.opportunity_id AND x.workspace_id=p.workspace_id
 WHERE p.workspace_id='__WORKSPACE__' AND p.kind='assessment' AND NOT x.archived
 ORDER BY p.opportunity_id,p.created_at DESC,p.id DESC
), jobs AS (
 SELECT j.id,j.workspace_id,j.status,j.next_attempt_at,
  CASE WHEN j.type='classify_opportunity' AND app_private.queue_needs_notice_details(j) THEN 'read_notice_details'
   WHEN j.type IN ('classify_opportunity','advance_plan') THEN j.type ELSE 'OTHER_TASK' END task,
  CASE WHEN j.error_code IN (__ERRORS__) THEN j.error_code WHEN j.error_code IS NULL THEN NULL ELSE 'OTHER_ERROR' END error_code
 FROM public.jobs j JOIN latest p ON p.id=j.entity_id AND p.workspace_id=j.workspace_id
 WHERE j.status IN ('queued','running','retry_wait','quota_wait','blocked','failed')
), recovery_starts AS (
 SELECT p.opportunity_id,max(a.created_at) started FROM public.audit_events a
 JOIN public.generation_plans p ON p.workspace_id=a.workspace_id AND p.id=a.entity_id
 WHERE a.workspace_id='__WORKSPACE__' AND a.action='ops.model_assessment.recovered' AND p.kind='assessment'
 GROUP BY p.opportunity_id
), refresh_counts AS (
 SELECT r.opportunity_id,count(p.id) refreshes FROM recovery_starts r LEFT JOIN public.generation_plans p
  ON p.workspace_id='__WORKSPACE__' AND p.opportunity_id=r.opportunity_id AND p.kind='assessment'
  AND p.status='canceled' AND p.error_code='NOTICE_DETAILS_REFRESHED' AND p.updated_at>=r.started
 GROUP BY r.opportunity_id
)
SELECT jsonb_build_object(
 'pending_job_counts',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (
   SELECT status,error_code,count(*) count,count(*) FILTER(WHERE next_attempt_at<=now()) due_now
   FROM jobs GROUP BY status,error_code ORDER BY status,error_code)x),
 'processing_step_counts',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (
   SELECT task,status,count(*) count,count(*) FILTER(WHERE next_attempt_at<=now()) due_now
   FROM jobs GROUP BY task,status ORDER BY task,status)x),
 'recovery_refresh_histogram',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (
   SELECT refreshes,count(*) opportunities FROM refresh_counts GROUP BY refreshes ORDER BY refreshes)x),
 'browser_request_counts',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (
   SELECT b.status,CASE WHEN b.error_code IN (__ERRORS__) THEN b.error_code WHEN b.error_code IS NULL THEN NULL ELSE 'OTHER_ERROR' END error_code,
    count(*) count FROM public.source_browser_requests b JOIN jobs j ON j.id=b.job_id AND j.workspace_id=b.workspace_id
    WHERE b.workspace_id='__WORKSPACE__' GROUP BY b.status,b.error_code ORDER BY b.status,b.error_code)x)
); COMMIT;""".replace("__WORKSPACE__", o.access.WORKSPACE).replace("__ERRORS__", codes)


def database_summary(raw):
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != {"pending_job_counts", "browser_request_counts", "processing_step_counts", "recovery_refresh_histogram"}:
        raise o.ObserverError("ASSESSMENT_QUEUE_RESULT_INVALID")
    result = {}
    for key in ("pending_job_counts", "browser_request_counts"):
        rows = value[key]
        if not isinstance(rows, list): raise o.ObserverError("ASSESSMENT_QUEUE_RESULT_INVALID")
        result[key] = []
        for row in rows:
            expected = {"status", "error_code", "count", "due_now"} if key == "pending_job_counts" else {"status", "error_code", "count"}
            if not isinstance(row, dict) or set(row) != expected: raise o.ObserverError("ASSESSMENT_QUEUE_RESULT_INVALID")
            counts = {name: row[name] for name in expected & {"count", "due_now"}}
            if any(type(number) is not int or number < 0 for number in counts.values()): raise o.ObserverError("ASSESSMENT_QUEUE_COUNT_INVALID")
            result[key].append({"status": fixed(row["status"], STATUSES, "OTHER_STATUS"),
                                "error_code": None if row["error_code"] is None else fixed(row["error_code"], ERRORS, "OTHER_ERROR"), **counts})
    phases = value["processing_step_counts"]
    histogram = value["recovery_refresh_histogram"]
    if not isinstance(phases, list) or not isinstance(histogram, list): raise o.ObserverError("ASSESSMENT_QUEUE_RESULT_INVALID")
    result["processing_step_counts"] = []
    for row in phases:
        if not isinstance(row, dict) or set(row) != {"task", "status", "count", "due_now"} or any(type(row[k]) is not int or row[k]<0 for k in ("count", "due_now")):
            raise o.ObserverError("ASSESSMENT_QUEUE_RESULT_INVALID")
        result["processing_step_counts"].append({"task": fixed(row["task"], TASKS, "OTHER_TASK"), "status": fixed(row["status"], STATUSES, "OTHER_STATUS"), "count": row["count"], "due_now": row["due_now"]})
    result["recovery_refresh_histogram"] = []
    for row in histogram:
        if not isinstance(row, dict) or set(row) != {"refreshes", "opportunities"} or any(type(v) is not int or v<0 for v in row.values()):
            raise o.ObserverError("ASSESSMENT_QUEUE_RESULT_INVALID")
        result["recovery_refresh_histogram"].append(row)
    return result


def kubernetes_summary():
    cron = d.get("cronjob", "native-browser")
    meta = (cron or {}).get("metadata", {})
    if (meta.get("name") != "native-browser" or meta.get("namespace") != d.NAMESPACE or not meta.get("uid")
        or meta.get("labels", {}).get("app.kubernetes.io/managed-by") != "tenderdesk-deployment"):
        raise o.ObserverError("ASSESSMENT_QUEUE_NATIVE_OWNERSHIP_REQUIRED")
    all_jobs = json.loads(d.command(["get", "jobs", "-n", d.NAMESPACE, "-o", "json"]))["items"]
    selected = [j for j in all_jobs if j.get("metadata", {}).get("namespace") == d.NAMESPACE
        and any(r.get("kind") == "CronJob" and r.get("uid") == meta["uid"] and r.get("name") == "native-browser"
            for r in j.get("metadata", {}).get("ownerReferences", []))]
    job_uids = {j["metadata"].get("uid") for j in selected if j["metadata"].get("uid")}
    jobs = {"retained_total": len(selected), "active": 0, "succeeded": 0, "failed": 0}
    job_reasons, pod_reasons, phases = collections.Counter(), collections.Counter(), collections.Counter()
    for job in selected:
        status = job.get("status", {})
        for field in ("active", "succeeded", "failed"): jobs[field] += int(bool(status.get(field)))
        for condition in status.get("conditions", []):
            if condition.get("status") == "True" and condition.get("reason"):
                job_reasons[fixed(condition["reason"], REASONS, "OTHER_REASON")] += 1
    all_pods = json.loads(d.command(["get", "pods", "-n", d.NAMESPACE, "-o", "json"]))["items"]
    selected_pods = [p for p in all_pods if p.get("metadata", {}).get("namespace") == d.NAMESPACE
        and any(r.get("kind") == "Job" and r.get("uid") in job_uids for r in p.get("metadata", {}).get("ownerReferences", []))]
    for pod in selected_pods:
        status = pod.get("status", {})
        phases[fixed(status.get("phase"), PHASES, "Unknown")] += 1
        if status.get("reason"): pod_reasons[fixed(status["reason"], REASONS, "OTHER_REASON")] += 1
        for container in status.get("containerStatuses", []):
            for state in container.get("state", {}).values():
                if state.get("reason"): pod_reasons[fixed(state["reason"], REASONS, "OTHER_REASON")] += 1
    return {"native_browser_enabled": cron.get("spec", {}).get("suspend") is not True,
            "native_browser_active_count": len(cron.get("status", {}).get("active", [])),
            "native_browser_jobs": jobs, "native_browser_job_reasons": dict(job_reasons),
            "native_browser_pod_phases": dict(phases), "native_browser_pod_reasons": dict(pod_reasons)}


def main():
    directory = None
    client = None
    try:
        directory = o.access.prepare_cluster()
        native = kubernetes_summary()
        client = o.Client(10)
        client.prepare()
        summary = database_summary(d.sql(client.pod, query()))
        print(json.dumps({"assessment_queue_snapshot": "captured", **summary, **native}, sort_keys=True), flush=True)
    except Exception as error:
        code = str(error) if isinstance(error, (o.ObserverError, d.DeployError, d.probe.ProbeError)) and re.fullmatch(r"[A-Z_0-9]{1,100}", str(error)) else "ASSESSMENT_QUEUE_SNAPSHOT_FAILED"
        print(json.dumps({"assessment_queue_snapshot": "blocked", "code": code}), flush=True)
        return 1
    finally:
        try:
            if client: client.cleanup()
        finally:
            if directory: shutil.rmtree(directory)
    return 0


if __name__ == "__main__": sys.exit(main())
