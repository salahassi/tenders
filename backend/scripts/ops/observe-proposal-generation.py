#!/usr/bin/env python3
"""Observe one privately selected proposal using bounded database reads only."""
from __future__ import annotations
import argparse
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("proposal_generation_inspector", HERE / "proposal-recovery.py")
inspector = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = inspector
SPEC.loader.exec_module(inspector)
access, observer, transfer = inspector.access, inspector.observer, inspector.transfer
verify_runtime = inspector.base.verify_runtime
BUCKET = inspector.BUCKET
OWNER = "tenderdesk-proposal-generation-observer"
STATUSES = {"queued", "running", "blocked", "completed", "failed", "canceled"}
JOB_STATUSES = {"queued", "running", "retry_wait", "quota_wait", "blocked", "succeeded", "failed", "canceled"}
STAGES = {"assessment", "analysis", "planning", "detailing", "drafting", "commercial", "synthesis", "review", "reconciliation", "completed"}
# Only known application constants may enter public logs. Unknown provider or
# database text is represented by a fixed label, even if it resembles a code.
ERROR_CODES = {
    "DATA_AUTHORIZATION_REQUIRED", "DATA_POLICY_BLOCKED", "STALE_INPUT", "STALE_LEASE",
    "MODEL_CORRECTION_EXHAUSTED", "MODEL_IDENTITY_CHANGED", "MODEL_ROUND_EXHAUSTED",
    "MODEL_NOT_CONFIGURED", "MODEL_RATE_WAIT", "MODEL_CONTEXT_TOO_LARGE", "MODEL_OUTPUT_INVALID",
    "MODEL_OUTPUT_TRUNCATED", "MODEL_COVERAGE_INCOMPLETE", "MODEL_NETWORK_UNCERTAIN",
    "MODEL_RESULT_EXPIRED", "MODEL_BUDGET_EXCEEDED", "MODEL_IN_PROGRESS", "MODEL_CAPABILITY_UNSUPPORTED",
    "MODEL_GENERATION_ATTEMPTS_EXHAUSTED", "MODEL_OPERATION_BUDGET_EXHAUSTED", "MANUAL_REDUCTION_REQUIRED",
    "PROVIDER_QUOTA_WAIT", "PROVIDER_AUTH_FAILED", "PROVIDER_MODEL_NOT_FOUND", "PROVIDER_REQUEST_INVALID",
    "PROVIDER_REQUEST_REJECTED", "PROVIDER_BACKGROUND_TERMINATED", "PROVIDER_BACKGROUND_RETRIEVAL_FAILED",
    "EVIDENCE_REFERENCE_INVALID", "UNSUPPORTED_COMPANY_CLAIM", "USAGE_REVIEW_REQUIRED", "USAGE_UNKNOWN",
    "LEASE_EXPIRED_REVIEW_REQUIRED", "DATABASE_COMMAND_FAILED", "GENERATION_SUPERSEDED",
    "GENERATION_NOT_ACTIVE", "PLAN_JOB_CAP_REACHED", "QUEUE_CAP_REACHED", "SOURCE_CHANGED",
}

PROGRESS_SQL = """BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='20s'; SET LOCAL lock_timeout='5s';
DO $guard$ BEGIN
 IF current_database()<>'tenderdesk_app' OR (SELECT count(*) FROM public.workspaces)<>1
 OR NOT EXISTS(SELECT 1 FROM public.generation_plans WHERE id='__PLAN__' AND workspace_id='__WORKSPACE__'
   AND opportunity_id='__OPPORTUNITY__' AND kind='proposal')
 THEN RAISE EXCEPTION 'PROPOSAL_OBSERVER_TARGET_MISMATCH';END IF;
END $guard$;
WITH target AS (
 SELECT id,workspace_id,proposal_id,stage,status,revision,error_code FROM public.generation_plans
 WHERE id='__PLAN__' AND workspace_id='__WORKSPACE__'
), selected_jobs AS (
 SELECT j.id,j.workspace_id,j.status,j.error_code FROM public.jobs j
 JOIN target p ON p.id=j.entity_id AND p.workspace_id=j.workspace_id
)
SELECT jsonb_build_object(
 'version',1,'stage',p.stage,'plan_status',p.status,'plan_revision',p.revision,'error_code',p.error_code,
 'jobs_total',(SELECT count(*) FROM selected_jobs),
 'job_counts',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY status),'[]') FROM (
   SELECT status,count(*) count FROM selected_jobs GROUP BY status)x),
 'job_errors',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY error_code),'[]') FROM (
   SELECT error_code,count(*) count FROM selected_jobs WHERE error_code IS NOT NULL GROUP BY error_code)x),
 'pending_jobs',(SELECT count(*) FROM selected_jobs WHERE status IN ('queued','running','retry_wait','quota_wait')),
 'active_requests',(SELECT count(*) FROM public.provider_usage u JOIN selected_jobs j
   ON j.id=u.job_id AND j.workspace_id=u.workspace_id WHERE u.state='reserved'),
 'version_count',(SELECT count(*) FROM public.proposal_versions v WHERE v.workspace_id=p.workspace_id AND v.plan_id=p.id),
 'current_version',EXISTS(SELECT 1 FROM public.proposals prop JOIN public.proposal_versions v
   ON v.workspace_id=prop.workspace_id AND v.id=prop.active_version_id
   WHERE prop.workspace_id=p.workspace_id AND prop.id=p.proposal_id AND v.plan_id=p.id)
) FROM target p; COMMIT;"""


class ObservationError(Exception):
    pass


def validate_limits(timeout, interval):
    if type(timeout) is not int or not 15 <= timeout <= 900 or type(interval) is not int or not 15 <= interval <= 60:
        raise ObservationError("PROPOSAL_OBSERVER_LIMIT_INVALID")


def validate_runtime_image(value):
    if not isinstance(value, str) or not re.fullmatch(r"registry\.digitalocean\.com/tenderdesk-a6093a76/runtime@sha256:[a-f0-9]{64}", value):
        raise ObservationError("PROPOSAL_OBSERVER_RUNTIME_INVALID")


def progress_sql(selection):
    inspector.validate_selection(selection)
    return PROGRESS_SQL.replace("__WORKSPACE__", selection["workspace_id"]).replace("__PLAN__", selection["plan_id"]).replace("__OPPORTUNITY__", selection["opportunity_id"])


def validate_snapshot(value):
    fields = {"version", "stage", "plan_status", "plan_revision", "error_code", "jobs_total", "job_counts", "job_errors",
              "pending_jobs", "active_requests", "version_count", "current_version"}
    if not isinstance(value, dict) or set(value) != fields or type(value["version"]) is not int or value["version"] != 1:
        raise ObservationError("PROPOSAL_OBSERVER_RESULT_INVALID")
    if value["stage"] not in STAGES or value["plan_status"] not in STATUSES or type(value["current_version"]) is not bool:
        raise ObservationError("PROPOSAL_OBSERVER_STATE_INVALID")
    for key in ("plan_revision", "jobs_total", "pending_jobs", "active_requests", "version_count"):
        if type(value[key]) is not int or not 0 <= value[key] <= 2147483647:
            raise ObservationError("PROPOSAL_OBSERVER_COUNT_INVALID")
    if value["error_code"] is not None and not isinstance(value["error_code"], str):
        raise ObservationError("PROPOSAL_OBSERVER_RESULT_INVALID")
    for key, label in (("job_counts", "status"), ("job_errors", "error_code")):
        rows = value[key]
        if not isinstance(rows, list) or len(rows) > 1000:
            raise ObservationError("PROPOSAL_OBSERVER_RESULT_INVALID")
        seen = set()
        for row in rows:
            if (not isinstance(row, dict) or set(row) != {label, "count"} or not isinstance(row[label], str)
                or type(row["count"]) is not int or not 0 <= row["count"] <= value["jobs_total"]
                or row[label] in seen or (key == "job_counts" and row[label] not in JOB_STATUSES)):
                raise ObservationError("PROPOSAL_OBSERVER_AGGREGATE_INVALID")
            seen.add(row[label])
    counts = {r["status"]: r["count"] for r in value["job_counts"]}
    if (sum(counts.values()) != value["jobs_total"]
        or sum(counts.get(s, 0) for s in ("queued", "running", "retry_wait", "quota_wait")) != value["pending_jobs"]
        or sum(r["count"] for r in value["job_errors"]) > value["jobs_total"]):
        raise ObservationError("PROPOSAL_OBSERVER_AGGREGATE_INVALID")
    return value


def safe_error(value):
    return value if value is None or value in ERROR_CODES else "UNCLASSIFIED"


def public_snapshot(snapshot):
    validate_snapshot(snapshot)
    errors = {}
    for row in snapshot["job_errors"]:
        key = safe_error(row["error_code"])
        errors[key] = errors.get(key, 0) + row["count"]
    return {key: snapshot[key] for key in ("stage", "plan_status", "jobs_total", "job_counts", "pending_jobs", "active_requests", "version_count", "current_version")} | {
        "error_code": safe_error(snapshot["error_code"]),
        "job_errors": [{"error_code": key, "count": errors[key]} for key in sorted(errors)],
    }


class Client(observer.Client):
    def __init__(self, timeout, selection, expected_runtime):
        super().__init__(timeout + 60)  # Parent adds 240s for setup/final report/cleanup.
        self.labels["app.kubernetes.io/managed-by"] = OWNER
        self.selection = inspector.validate_selection(selection)
        validate_runtime_image(expected_runtime)
        self.expected_runtime = expected_runtime

    def snapshot(self):
        # Suppress all transport diagnostics; only the validated aggregate below
        # is allowed into public logs. Every sample checks the selected runtime.
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            verify_runtime(self.expected_runtime)
            value = json.loads(access.d.sql(self.pod, progress_sql(self.selection)))
        return validate_snapshot(value)

    def final_inspection(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            verify_runtime(self.expected_runtime)
            value = json.loads(access.d.sql(self.pod, inspector.inspection_sql(self.selection)))
            inspector.public_receipt(value)
        return value


def observe(client, *, timeout, interval, clock=time.monotonic, pause=time.sleep):
    validate_limits(timeout, interval)
    deadline = clock() + timeout
    stable = None
    stable_count = 0
    samples = 0
    while True:
        snapshot = client.snapshot()
        samples += 1
        visible = public_snapshot(snapshot)
        print(json.dumps({"proposal_observation": "progress", **visible}, sort_keys=True), flush=True)
        idle = snapshot["pending_jobs"] == 0 and snapshot["active_requests"] == 0
        if snapshot["plan_status"] == "completed" and idle and snapshot["current_version"] and snapshot["version_count"] > 0:
            return {"outcome": "completed", "exit_code": 0, "samples": samples, "snapshot": snapshot}
        attention = idle and snapshot["plan_status"] in {"blocked", "failed", "canceled", "completed"}
        fingerprint = json.dumps(snapshot, sort_keys=True) if attention else None
        stable_count = stable_count + 1 if fingerprint is not None and fingerprint == stable else 1 if attention else 0
        stable = fingerprint
        if stable_count >= 2:
            return {"outcome": "terminal_with_attention", "exit_code": 3, "samples": samples, "snapshot": snapshot}
        remaining = deadline - clock()
        if remaining <= 0:
            return {"outcome": "timeout", "exit_code": 2, "samples": samples, "snapshot": snapshot}
        pause(min(interval, remaining))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection-object", required=True)
    parser.add_argument("--selection-sha256", required=True)
    parser.add_argument("--expected-runtime-image", required=True)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--interval", type=int, default=15)
    args = parser.parse_args(argv)
    directory = client = outcome = digest = None
    code = None
    try:
        validate_limits(args.timeout, args.interval)
        validate_runtime_image(args.expected_runtime_image)
        if not re.fullmatch(r"requests/[A-Za-z0-9][A-Za-z0-9._/-]{0,160}\.bundle", args.selection_object) or not re.fullmatch(r"[a-f0-9]{64}", args.selection_sha256):
            raise ObservationError("PROPOSAL_OBSERVER_SELECTION_INVALID")
        transfer.identity(BUCKET, args.selection_object)
        os.umask(0o077)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            directory = access.prepare_cluster()
            path = directory / "selection.json"
            transfer.download(os.environ["DIGITALOCEAN_ACCESS_TOKEN"], BUCKET, args.selection_object, path, args.selection_sha256)
            raw = transfer.read_private(path)
            if len(raw) > 8192:
                raise ObservationError("PROPOSAL_OBSERVER_SELECTION_INVALID")
            selection = inspector.validate_selection(json.loads(raw))
            verify_runtime(args.expected_runtime_image)
            client = Client(args.timeout, selection, args.expected_runtime_image)
            client.prepare()
        outcome = observe(client, timeout=args.timeout, interval=args.interval)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            report = {"version": 1, "mode": "read_only_observation", **outcome,
                      "expected_runtime_image": args.expected_runtime_image,
                      "final_inspection": client.final_inspection()}
            path = directory / "observation.json"
            transfer.write_private(path, json.dumps(report, ensure_ascii=False).encode())
            digest = transfer.upload(os.environ["DIGITALOCEAN_ACCESS_TOKEN"], BUCKET,
                                     "diagnostics/proposal-observation-" + os.environ["GITHUB_RUN_ID"] + ".bundle", path)
            if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise ObservationError("PROPOSAL_OBSERVER_REPORT_INVALID")
    except Exception as error:
        code = str(error) if isinstance(error, (ObservationError, inspector.RecoveryError, observer.ObserverError,
            inspector.base.ResumeError, access.TransferError, access.d.DeployError, access.d.probe.ProbeError,
            transfer.TransferError)) and re.fullmatch(r"[A-Z0-9_]{1,100}", str(error)) else "PROPOSAL_OBSERVER_FAILED"
    finally:
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                if client is not None:
                    client.cleanup()
        except Exception:
            code = "PROPOSAL_OBSERVER_CLIENT_CLEANUP_NOT_CONFIRMED"
        try:
            if directory is not None:
                shutil.rmtree(directory)
        except Exception:
            code = "PROPOSAL_OBSERVER_RUNNER_CLEANUP_NOT_CONFIRMED"
    if code is not None:
        print(json.dumps({"proposal_observation": "failed", "code": code}), flush=True)
        return 1
    print(json.dumps({"proposal_observation": outcome["outcome"], "samples": outcome["samples"],
                      "business_mutations": 0, "report_sha256": digest}), flush=True)
    return outcome["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
