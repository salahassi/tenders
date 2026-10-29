#!/usr/bin/env python3
"""Observe aggregate assessment outcomes without changing application state."""
from __future__ import annotations
import argparse
import base64
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sys
import time

SPEC = importlib.util.spec_from_file_location("assessment_observer_access", Path(__file__).with_name("transfer-sources.py"))
access = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = access
SPEC.loader.exec_module(access)
d = access.d
OWNER = "tenderdesk-assessment-observer"
TERMINAL = {"completed", "blocked", "failed", "canceled"}

SQL = """BEGIN READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='20s';
DO $$ BEGIN
 IF current_database()<>'tenderdesk_app' OR NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id='__WORKSPACE__')
 THEN RAISE EXCEPTION 'ASSESSMENT_OBSERVER_DATABASE_MISMATCH'; END IF;
END $$;
WITH latest AS (
 SELECT DISTINCT ON (p.opportunity_id) p.id,p.workspace_id,p.opportunity_id,p.status,p.error_code,p.input_hash,p.evidence_revision
 FROM public.generation_plans p JOIN public.opportunities o ON o.workspace_id=p.workspace_id AND o.id=p.opportunity_id
 WHERE p.workspace_id='__WORKSPACE__' AND p.kind='assessment' AND NOT o.archived
 ORDER BY p.opportunity_id,p.created_at DESC,p.id DESC
), current_fits AS (
 SELECT DISTINCT ON (f.plan_id) f.routing FROM public.fit_assessments f JOIN latest p ON p.id=f.plan_id AND p.workspace_id=f.workspace_id
 WHERE f.input_hash=p.input_hash AND f.evidence_revision=p.evidence_revision AND p.status='completed'
 ORDER BY f.plan_id,f.created_at DESC,f.id DESC
), current_jobs AS (
 SELECT j.type,j.status,CASE WHEN j.error_code ~ '^[A-Z][A-Z0-9_]{1,100}$' THEN j.error_code
   WHEN j.error_code IS NULL THEN NULL ELSE 'UNCLASSIFIED' END error_code
 FROM public.jobs j JOIN latest p ON p.id=j.entity_id AND p.workspace_id=j.workspace_id
)
SELECT jsonb_build_object(
 'observed_at',now(),
 'latest_total',(SELECT count(*) FROM latest),
 'latest_statuses',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (SELECT status,count(*) count FROM latest GROUP BY status ORDER BY status)x),
 'current_fit_total',(SELECT count(*) FROM current_fits),
 'current_fit_needs_review',(SELECT count(*) FROM current_fits WHERE routing='needs_review'),
 'current_fit_routing',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (SELECT routing,count(*) count FROM current_fits GROUP BY routing ORDER BY routing)x),
 'pending_jobs',(SELECT count(*) FROM current_jobs WHERE status IN ('queued','running','retry_wait','quota_wait')),
 'pending_opportunities',(SELECT count(*) FROM public.opportunities WHERE workspace_id='__WORKSPACE__' AND NOT archived AND assessment_pending),
 'attention_jobs',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (
   SELECT type,status,error_code,count(*) count FROM current_jobs WHERE status IN ('blocked','failed')
   GROUP BY type,status,error_code ORDER BY status,error_code)x),
 'attention_plans',(SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') FROM (
   SELECT status,CASE WHEN error_code ~ '^[A-Z][A-Z0-9_]{1,100}$' THEN error_code
    WHEN error_code IS NULL THEN NULL ELSE 'UNCLASSIFIED' END error_code,count(*) count
   FROM latest WHERE status IN ('blocked','failed') GROUP BY status,error_code ORDER BY status,error_code)x)
); COMMIT;""".replace("__WORKSPACE__", access.WORKSPACE)


class ObserverError(Exception):
    pass


def validate_snapshot(value):
    expected = {"observed_at", "latest_total", "latest_statuses", "current_fit_total", "current_fit_needs_review", "current_fit_routing", "pending_jobs", "pending_opportunities", "attention_jobs", "attention_plans"}
    if not isinstance(value, dict) or set(value) != expected or not isinstance(value["observed_at"], str):
        raise ObserverError("ASSESSMENT_OBSERVER_RESULT_INVALID")
    for key in ("latest_total", "current_fit_total", "current_fit_needs_review", "pending_jobs", "pending_opportunities"):
        if type(value[key]) is not int or value[key] < 0:
            raise ObserverError("ASSESSMENT_OBSERVER_COUNT_INVALID")
    fields = {"latest_statuses": {"status", "count"}, "current_fit_routing": {"routing", "count"},
              "attention_jobs": {"type", "status", "error_code", "count"}, "attention_plans": {"status", "error_code", "count"}}
    for key, expected_fields in fields.items():
        if not isinstance(value[key], list): raise ObserverError("ASSESSMENT_OBSERVER_RESULT_INVALID")
        for row in value[key]:
            if not isinstance(row, dict) or set(row) != expected_fields or type(row["count"]) is not int or row["count"] < 0:
                raise ObserverError("ASSESSMENT_OBSERVER_AGGREGATE_INVALID")
            for name, item in row.items():
                if name == "count" or item is None: continue
                if not isinstance(item, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,100}", item):
                    raise ObserverError("ASSESSMENT_OBSERVER_LABEL_INVALID")
    if sum(row["count"] for row in value["latest_statuses"]) != value["latest_total"]:
        raise ObserverError("ASSESSMENT_OBSERVER_STATUS_COUNT_INVALID")
    return value


def terminal(snapshot, minimum_completed):
    completed = sum(row["count"] for row in snapshot["latest_statuses"] if row["status"] == "completed")
    return (snapshot["latest_total"] > 0 and completed >= minimum_completed and snapshot["current_fit_total"] >= minimum_completed
            and snapshot["pending_jobs"] == 0 and snapshot["pending_opportunities"] == 0
            and all(row["status"] in TERMINAL for row in snapshot["latest_statuses"]))


class Client:
    def __init__(self, timeout):
        run, attempt = os.environ.get("GITHUB_RUN_ID", ""), os.environ.get("GITHUB_RUN_ATTEMPT", "")
        if not re.fullmatch(r"[0-9]{1,20}", run) or not re.fullmatch(r"[0-9]{1,6}", attempt):
            raise ObserverError("ASSESSMENT_OBSERVER_RUN_IDENTITY_INVALID")
        self.nonce = secrets.token_hex(4)
        self.base = "assess-observer-" + run + "-" + attempt + "-" + self.nonce
        self.pod, self.secret = self.base + "-pg", self.base + "-db"
        self.labels = {"app.kubernetes.io/managed-by": OWNER, "tenderdesk.io/observation": self.nonce}
        self.timeout = timeout

    def metadata(self, name):
        return {"name": name, "namespace": d.NAMESPACE, "labels": self.labels}

    def prepare(self):
        namespace = d.get("namespace", d.NAMESPACE)
        if (namespace or {}).get("metadata", {}).get("labels", {}).get("app.kubernetes.io/managed-by") != "tenderdesk-deployment":
            raise ObserverError("ASSESSMENT_OBSERVER_NAMESPACE_OWNERSHIP_REQUIRED")
        credentials, ca = d.probe.target_credentials(os.environ["DIGITALOCEAN_ACCESS_TOKEN"])
        if not hmac.compare_digest(d.decode_secret(d.get("secret", "tenderdesk-core")).get("PGSSLCA", ""), ca):
            raise ObserverError("ASSESSMENT_OBSERVER_CA_MISMATCH")
        if d.get("secret", self.secret) is not None or d.get("pod", self.pod) is not None:
            raise ObserverError("ASSESSMENT_OBSERVER_RESOURCE_ALREADY_EXISTS")
        secret = {"apiVersion": "v1", "kind": "Secret", "metadata": self.metadata(self.secret), "type": "Opaque",
                  "data": {key: base64.b64encode(value.encode()).decode() for key, value in credentials.items()}}
        # create, rather than apply, refuses adopting a same-name foreign object.
        d.command(["create", "-f", "-"], payload=json.dumps(secret))
        deadline = self.timeout + 240
        pod = {"apiVersion": "v1", "kind": "Pod", "metadata": self.metadata(self.pod), "spec": {
            "restartPolicy": "Never", "activeDeadlineSeconds": deadline, "automountServiceAccountToken": False,
            "securityContext": {"runAsNonRoot": True, "runAsUser": 999, "runAsGroup": 999, "seccompProfile": {"type": "RuntimeDefault"}},
            "containers": [{"name": "postgres-client", "image": d.probe.CLIENT_IMAGE, "command": ["sleep", str(deadline)],
                "envFrom": [{"secretRef": {"name": self.secret}}], "env": [
                    {"name": "PGSSLMODE", "value": "verify-full"}, {"name": "PGSSLROOTCERT", "value": "/run/db-ca/ca.crt"},
                    {"name": "PGAPPNAME", "value": "tenderdesk-assessment-observer"}, {"name": "PGCONNECT_TIMEOUT", "value": "15"}],
                "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
                "resources": {"requests": {"cpu": "25m", "memory": "32Mi"}, "limits": {"cpu": "250m", "memory": "128Mi"}},
                "volumeMounts": [{"name": "database-ca", "mountPath": "/run/db-ca", "readOnly": True}]}],
            "volumes": [{"name": "database-ca", "secret": {"secretName": "tenderdesk-core", "defaultMode": 0o444,
                "items": [{"key": "PGSSLCA", "path": "ca.crt"}]}}]}}
        d.command(["create", "-f", "-"], payload=json.dumps(pod))
        d.command(["wait", "pod/" + self.pod, "-n", d.NAMESPACE, "--for=condition=Ready", "--timeout=120s"], timeout=140)

    def snapshot(self):
        return validate_snapshot(json.loads(d.sql(self.pod, SQL)))

    def cleanup(self):
        failed = False
        for kind, name in (("pod", self.pod), ("secret", self.secret)):
            try:
                current = d.get(kind, name)
                if current is None: continue
                meta = current.get("metadata", {})
                if meta.get("name") != name or meta.get("namespace") != d.NAMESPACE or any(meta.get("labels", {}).get(k) != v for k, v in self.labels.items()):
                    raise ObserverError("ASSESSMENT_OBSERVER_FOREIGN_CLEANUP_REFUSED")
                d.command(["delete", kind, name, "-n", d.NAMESPACE, "--ignore-not-found", "--wait=true", "--timeout=60s"], timeout=75)
            except Exception:
                failed = True
        if failed: raise ObserverError("ASSESSMENT_OBSERVER_CLEANUP_NOT_CONFIRMED")


def observe(client, *, timeout, interval, minimum_completed, clock=time.monotonic, pause=time.sleep):
    deadline = clock() + timeout
    last = None
    while True:
        snapshot = client.snapshot()
        comparison = {key: value for key, value in snapshot.items() if key != "observed_at"}
        if comparison != last:
            print(json.dumps({"assessment_observation": "progress", **snapshot}, sort_keys=True), flush=True)
            last = comparison
        if terminal(snapshot, minimum_completed):
            incomplete = any(row["count"] > 0 and row["status"] != "completed" for row in snapshot["latest_statuses"])
            outcome = "terminal_with_attention" if incomplete or snapshot["attention_jobs"] or snapshot["attention_plans"] else "completed"
            print(json.dumps({"assessment_observation": outcome, **snapshot}, sort_keys=True), flush=True)
            return 0
        remaining = deadline - clock()
        if remaining <= 0:
            print(json.dumps({"assessment_observation": "timeout", **snapshot}, sort_keys=True), flush=True)
            return 2
        pause(min(interval, remaining))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--interval", type=int, default=15)
    parser.add_argument("--minimum-completed", type=int, default=1)
    args = parser.parse_args(argv)
    if not 10 <= args.timeout <= 900 or not 10 <= args.interval <= 20 or not 1 <= args.minimum_completed <= 1000:
        parser.error("Observation limits are timeout 10–900s, interval 10–20s, minimum completed 1–1000.")
    directory = None
    client = None
    try:
        directory = access.prepare_cluster()
        client = Client(args.timeout)
        client.prepare()
        return observe(client, timeout=args.timeout, interval=args.interval, minimum_completed=args.minimum_completed)
    except Exception as error:
        code = str(error) if isinstance(error, (ObserverError, d.DeployError, d.probe.ProbeError)) and re.fullmatch(r"[A-Z_0-9]{1,100}", str(error)) else "ASSESSMENT_OBSERVER_FAILED"
        print(json.dumps({"assessment_observation": "blocked", "code": code}), flush=True)
        return 1
    finally:
        try:
            if client: client.cleanup()
        finally:
            if directory: shutil.rmtree(directory)


if __name__ == "__main__": sys.exit(main())
