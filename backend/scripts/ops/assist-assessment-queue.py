#!/usr/bin/env python3
"""Bounded assistance through the canonical authenticated private worker only.

No queue, lease, ledger, snapshot, provider limit or deployment configuration is
edited. Every invocation still enters the worker's normal authorization and
claim logic. Public output contains anonymous processing counters only.
"""
import argparse
import importlib.util
import json
import math
import re
import shutil
import sys
import time
from pathlib import Path


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


o = module("assessment_assist_observer", "observe-assessment-recovery.py")
q = module("assessment_assist_diagnostic", "diagnose-assessment-queue.py")
r = module("assessment_assist_recovery", "recover-model-assessments.py")
d = o.d
EXPECTED_IMAGE = "registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:74db4c5aa8a534de1a7e85dcd590a9605b89357bbd6aa859d61f63d828139b06"
QUOTA = {"MODEL_RATE_WAIT", "MODEL_DAILY_QUOTA_WAIT", "PROVIDER_QUOTA_WAIT"}
UNKNOWN = {"USAGE_UNKNOWN", "MODEL_NETWORK_UNCERTAIN", "LEASE_EXPIRED_REVIEW_REQUIRED"}
WORKER_SCRIPT = r"""let ok=false,claimed=false;
try {
 const secret=Deno.env.get("APP_WORKER_SECRET");
 if(secret){
  const response=await fetch("http://worker:8080/functions/v1/worker",{
   method:"POST",redirect:"error",headers:{"content-type":"application/json","x-worker-secret":secret},
   body:"{}",signal:AbortSignal.timeout(__TIMEOUT__)
  });
  if(response.status===200){
   const body=await response.json();
   ok=true;claimed=body?.data?.claimed!==false&&typeof body?.data?.job_id==="string";
  }else await response.body?.cancel();
 }
}catch{ok=false;claimed=false;}
console.log(JSON.stringify({ok,claimed}));"""


class AssistError(Exception):
    pass


def verify_runtime():
    r.verify_guard_runtime(EXPECTED_IMAGE)
    namespace = d.get("namespace", d.NAMESPACE) or {}
    value = d.get("deployment", "scheduler") or {}
    metadata, spec, status = value.get("metadata", {}), value.get("spec", {}), value.get("status", {})
    containers = spec.get("template", {}).get("spec", {}).get("containers", [])
    if (namespace.get("metadata", {}).get("labels", {}).get("app.kubernetes.io/managed-by") != "tenderdesk-deployment"
        or metadata.get("name") != "scheduler" or metadata.get("namespace") != d.NAMESPACE
        or metadata.get("labels", {}).get("app.kubernetes.io/managed-by") != "tenderdesk-deployment"
        or len(containers) != 1 or containers[0].get("name") != "scheduler" or containers[0].get("image") != EXPECTED_IMAGE
        or spec.get("replicas") != 1 or status.get("observedGeneration", -1) < metadata.get("generation", 0)
        or status.get("readyReplicas") != 1 or status.get("updatedReplicas") != 1 or status.get("unavailableReplicas", 0) != 0):
        raise AssistError("ASSESSMENT_ASSIST_RUNTIME_NOT_VERIFIED")


def guard_sql(batch_id):
    if not isinstance(batch_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", batch_id):
        raise AssistError("ASSESSMENT_ASSIST_BATCH_INVALID")
    marker = "Owner-authorized automated provider remediation; batch=" + batch_id
    return """BEGIN READ ONLY; SET LOCAL ROLE tdp_app_owner; SET LOCAL statement_timeout='20s';
DO $$ BEGIN IF current_database()<>'tenderdesk_app' OR (SELECT count(*) FROM public.workspaces)<>1
 OR NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id='__WORKSPACE__')
 THEN RAISE EXCEPTION 'ASSESSMENT_ASSIST_DATABASE_MISMATCH'; END IF; END $$;
WITH approved AS (
 SELECT DISTINCT p.opportunity_id FROM public.audit_events a JOIN public.generation_plans p
  ON p.workspace_id=a.workspace_id AND p.id=a.entity_id
 WHERE a.workspace_id='__WORKSPACE__' AND a.reason='__MARKER__'
  AND a.action IN ('ops.model_assessment.sample','ops.model_assessment.recovered') AND p.kind='assessment'
), latest AS (
 SELECT DISTINCT ON (p.opportunity_id) p.id,p.workspace_id,p.opportunity_id,p.status FROM public.generation_plans p
 JOIN public.opportunities x ON x.workspace_id=p.workspace_id AND x.id=p.opportunity_id
 WHERE p.workspace_id='__WORKSPACE__' AND p.kind='assessment' AND NOT x.archived
 ORDER BY p.opportunity_id,p.created_at DESC,p.id DESC
), selected AS (SELECT l.* FROM latest l JOIN approved a ON a.opportunity_id=l.opportunity_id),
selected_jobs AS (SELECT j.* FROM public.jobs j JOIN selected p ON p.id=j.entity_id AND p.workspace_id=j.workspace_id)
SELECT jsonb_build_object(
 'approved_opportunities',(SELECT count(*) FROM approved),
 'approved_latest_plans',(SELECT count(*) FROM selected),
 'outside_batch_pending',(SELECT count(*) FROM latest l WHERE l.status IN ('queued','running','blocked') AND NOT EXISTS(SELECT 1 FROM approved a WHERE a.opportunity_id=l.opportunity_id)),
 'outside_batch_due',(SELECT count(*) FROM public.jobs j WHERE j.workspace_id='__WORKSPACE__'
  AND j.status IN ('queued','retry_wait','quota_wait') AND j.next_attempt_at<=now() AND j.lease_token IS NULL AND NOT j.cancel_requested
  AND NOT EXISTS(SELECT 1 FROM selected p WHERE p.id=j.entity_id AND p.workspace_id=j.workspace_id)),
 'running_jobs',(SELECT count(*) FROM public.jobs WHERE workspace_id='__WORKSPACE__' AND status='running'),
 'quota_wait_jobs',(SELECT count(*) FROM selected_jobs WHERE status='quota_wait' OR error_code IN ('MODEL_RATE_WAIT','MODEL_DAILY_QUOTA_WAIT','PROVIDER_QUOTA_WAIT')),
 'unknown_outcomes',(SELECT count(*) FROM public.provider_usage u JOIN selected_jobs j ON j.id=u.job_id AND j.workspace_id=u.workspace_id WHERE u.state='unknown')
  +(SELECT count(*) FROM selected_jobs WHERE error_code IN ('USAGE_UNKNOWN','MODEL_NETWORK_UNCERTAIN','LEASE_EXPIRED_REVIEW_REQUIRED'))
); COMMIT;""".replace("__WORKSPACE__", o.access.WORKSPACE).replace("__MARKER__", marker)


def guard_result(raw):
    result = json.loads(raw)
    fields = {"approved_opportunities", "approved_latest_plans", "outside_batch_pending", "outside_batch_due", "running_jobs", "quota_wait_jobs", "unknown_outcomes"}
    if not isinstance(result, dict) or set(result) != fields or any(type(v) is not int or v < 0 for v in result.values()):
        raise AssistError("ASSESSMENT_ASSIST_GUARD_INVALID")
    return result


def invoke_worker(remaining):
    if remaining <= 5: raise AssistError("ASSESSMENT_ASSIST_DEADLINE_REACHED")
    started = time.monotonic()
    pod = scheduler_pod()
    remaining -= time.monotonic() - started
    if remaining <= 5: raise AssistError("ASSESSMENT_ASSIST_DEADLINE_REACHED")
    timeout_ms = max(1, min(145_000, int((remaining - 5) * 1000)))
    script = WORKER_SCRIPT.replace("__TIMEOUT__", str(timeout_ms))
    command_budget = min(150, max(1, math.floor(remaining - 1)))
    # d.command supplies a 30s default before our arguments; this later explicit
    # value keeps kubectl's exec context within the same absolute worker budget.
    args = ["--request-timeout=" + str(command_budget) + "s", "exec", "-i", "pod/" + pod, "-n", d.NAMESPACE, "--container=scheduler", "--", "deno", "run", "--no-config", "--no-prompt",
            "--allow-env=APP_WORKER_SECRET", "--allow-net=worker:8080", "-"]
    raw = d.command(args, payload=script, timeout=command_budget)
    result = json.loads(raw)
    if not isinstance(result, dict) or set(result) != {"ok", "claimed"} or any(type(v) is not bool for v in result.values()):
        raise AssistError("ASSESSMENT_ASSIST_WORKER_PROOF_INVALID")
    return result


def scheduler_pod():
    """Resolve one Ready scheduler Pod through its verified controller UID."""
    verify_runtime()
    deployment = d.get("deployment", "scheduler")
    uid = deployment.get("metadata", {}).get("uid")
    if not uid: raise AssistError("ASSESSMENT_ASSIST_SCHEDULER_UID_REQUIRED")
    sets = json.loads(d.command(["get", "replicasets", "-n", d.NAMESPACE, "-o", "json"]))["items"]
    owned = set()
    for rs in sets:
        meta, spec = rs.get("metadata", {}), rs.get("spec", {})
        containers = spec.get("template", {}).get("spec", {}).get("containers", [])
        if (meta.get("namespace") == d.NAMESPACE and any(x.get("kind") == "Deployment" and x.get("uid") == uid for x in meta.get("ownerReferences", []))
            and len(containers) == 1 and containers[0].get("name") == "scheduler" and containers[0].get("image") == EXPECTED_IMAGE
            and rs.get("status", {}).get("readyReplicas", 0) == 1 and meta.get("uid")):
            owned.add(meta["uid"])
    pods = json.loads(d.command(["get", "pods", "-n", d.NAMESPACE, "-o", "json"]))["items"]
    selected = []
    for pod in pods:
        meta, status = pod.get("metadata", {}), pod.get("status", {})
        containers = pod.get("spec", {}).get("containers", [])
        if (meta.get("namespace") == d.NAMESPACE and not meta.get("deletionTimestamp") and meta.get("uid")
            and any(x.get("kind") == "ReplicaSet" and x.get("uid") in owned for x in meta.get("ownerReferences", []))
            and status.get("phase") == "Running" and any(x.get("type") == "Ready" and x.get("status") == "True" for x in status.get("conditions", []))
            and len(containers) == 1 and containers[0].get("name") == "scheduler" and containers[0].get("image") == EXPECTED_IMAGE):
            selected.append((meta.get("name"), meta["uid"]))
    if len(selected) != 1 or not isinstance(selected[0][0], str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{0,252}", selected[0][0]):
        raise AssistError("ASSESSMENT_ASSIST_SCHEDULER_POD_NOT_VERIFIED")
    name, selected_uid = selected[0]
    current = d.get("pod", name) or {}
    metadata, status = current.get("metadata", {}), current.get("status", {})
    if (metadata.get("uid") != selected_uid or metadata.get("deletionTimestamp") or status.get("phase") != "Running"
        or not any(x.get("type") == "Ready" and x.get("status") == "True" for x in status.get("conditions", []))):
        raise AssistError("ASSESSMENT_ASSIST_SCHEDULER_POD_CHANGED")
    return name


def run(client, *, batch_id, expected_count=18, max_seconds=600, max_invocations=60, clock=time.monotonic, pause=time.sleep, invoke=invoke_worker):
    deadline = clock() + max_seconds
    invocations = 0
    previous = None
    while True:
        snapshot = client.snapshot()
        public = o.public_snapshot(snapshot, 1)
        guard = guard_result(d.sql(client.pod, guard_sql(batch_id)))
        diagnostics = q.database_summary(d.sql(client.pod, q.query()))
        receipt = {"assessment_assist": "observing", "invocations": invocations, **public}
        if receipt != previous:
            print(json.dumps(receipt, sort_keys=True), flush=True)
            previous = receipt
        reason = None
        if (guard["approved_opportunities"] != expected_count or guard["approved_latest_plans"] != expected_count
            or guard["outside_batch_pending"] or guard["outside_batch_due"]): reason = "scope_changed"
        elif public["attention_jobs"] or public["attention_plans"]: reason = "attention_required"
        elif guard["quota_wait_jobs"] or any(x["status"] == "quota_wait" or x["error_code"] in QUOTA for x in diagnostics["pending_job_counts"]): reason = "quota_wait"
        elif guard["unknown_outcomes"] or any(x["error_code"] in UNKNOWN for x in diagnostics["pending_job_counts"]): reason = "unknown_outcome"
        elif o.terminal(snapshot, 1): reason = "drained"
        remaining = deadline - clock()
        if reason is None and (remaining <= 5 or invocations >= max_invocations): reason = "bounded_limit"
        if reason:
            print(json.dumps({"assessment_assist": reason, "invocations": invocations, **public}, sort_keys=True), flush=True)
            return 0 if reason == "drained" else 2
        due = sum(row["due_now"] for row in diagnostics["pending_job_counts"] if row["status"] in {"queued", "retry_wait"})
        if guard["running_jobs"] or due == 0:
            pause(min(15, remaining))
            continue
        # Recheck deployment provenance before every canonical worker call.
        verify_runtime()
        remaining = deadline - clock()
        if remaining <= 5: continue
        invocations += 1
        try:
            result = invoke(remaining)
        except Exception:
            print(json.dumps({"assessment_assist": "worker_outcome_unconfirmed", "invocations": invocations}, sort_keys=True), flush=True)
            return 1
        if not result["ok"] or not result["claimed"]:
            print(json.dumps({"assessment_assist": "worker_not_claimed" if result["ok"] else "worker_outcome_unconfirmed", "invocations": invocations}, sort_keys=True), flush=True)
            return 2 if result["ok"] else 1


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-id", default="provider-runtime-20261029")
    parser.add_argument("--expected-count", type=int, default=18)
    parser.add_argument("--max-seconds", type=int, default=600)
    parser.add_argument("--max-invocations", type=int, default=60)
    args = parser.parse_args(argv)
    guard_sql(args.batch_id)
    if not 1 <= args.expected_count <= 1000 or not 1 <= args.max_seconds <= 600 or not 1 <= args.max_invocations <= 60:
        parser.error("Expected population is 1–1000; assistance is bounded to 60 invocations and 600 seconds.")
    started = time.monotonic()
    directory = None
    client = None
    try:
        directory = o.access.prepare_cluster()
        verify_runtime()
        client = o.Client(600)
        client.prepare()
        remaining = args.max_seconds - (time.monotonic() - started)
        if remaining <= 0: raise AssistError("ASSESSMENT_ASSIST_DEADLINE_REACHED")
        return run(client, batch_id=args.batch_id, expected_count=args.expected_count, max_seconds=remaining, max_invocations=args.max_invocations)
    except Exception as error:
        code = str(error) if isinstance(error, (AssistError, o.ObserverError, r.RecoveryError, d.DeployError, d.probe.ProbeError)) and re.fullmatch(r"[A-Z_0-9]{1,100}", str(error)) else "ASSESSMENT_ASSIST_FAILED"
        print(json.dumps({"assessment_assist": "blocked", "code": code}), flush=True)
        return 1
    finally:
        try:
            if client: client.cleanup()
        finally:
            if directory: shutil.rmtree(directory)


if __name__ == "__main__": sys.exit(main())
