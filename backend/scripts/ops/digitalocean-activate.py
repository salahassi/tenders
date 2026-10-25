#!/usr/bin/env python3
"""Activate verified, empty-target maintenance without enabling business work.

The preceding production smoke must have passed in this exact workflow attempt.
Only the durable relay and native-reader schedules are enabled. Existing source
and model admission remain paused. Credentials enter private HTTP headers or a
Pod's stdin and never appear in argv, public diagnostics or generated manifests.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


deploy = module("activation_deploy", HERE / "digitalocean-deploy.py")
smoke = module("activation_smoke", HERE / "digitalocean-smoke.py")
NAMESPACE, PREFIX = deploy.NAMESPACE, deploy.PREFIX
MARKER = "tenderdesk-deployment"
REGISTRY = "registry.digitalocean.com/tenderdesk-a6093a76/"
REQUIRED_SMOKE_CHECKS = {
    "public_https_frontend_runtime_configuration_and_application_health",
    "anonymous_application_admin_and_internal_worker_denials",
    "one_preserved_owner_login_and_genuine_temporary_auth_session",
    "uninvited_signup_denied_before_account_creation_or_email",
    "real_owner_membership_application_bootstrap_and_all_frontend_lists",
    "business_history_empty_and_operating_configuration_readable",
    "isolated_private_fixture_upload_download_and_anonymous_public_denials",
    "persistent_volume_retains_exact_private_bytes_across_storage_restart",
    "isolated_fixture_cleanup_and_only_test_session_revocation",
}
EMPTY_TABLES = ("jobs", "sources", "opportunities", "notifications", "documents", "proposals", "provider_usage", "model_attempts")


class ActivationFailure(Exception):
    pass


def emit(status, checks, *, code=None, cleanup_failures=None, provider_count=0, smtp_configured=False):
    value = {"activation": "tenderdesk_empty_target_maintenance", "status": status,
             "checks": {name: True for name in checks}, "external_processing_enabled": False,
             "provider_keys_configured": provider_count, "smtp_configured": smtp_configured,
             "cutover_ready": False, "source_project_deleted": False}
    if code:
        value["code"] = code
    if cleanup_failures:
        value["cleanup_failures"] = cleanup_failures
    print(json.dumps(value, sort_keys=True), flush=True)


def private_json(path: Path, workdir: Path):
    try:
        if path.parent.resolve() != workdir.resolve() or path.is_symlink():
            raise ValueError
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as stream:
            metadata = os.fstat(stream.fileno())
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                    or metadata.st_mode & 0o077 or not 1 <= metadata.st_size <= 128 * 1024):
                raise ValueError
            raw = stream.read(128 * 1024 + 1)
        if len(raw) > 128 * 1024:
            raise ValueError
        return json.loads(raw)
    except (OSError, ValueError, UnicodeError):
        raise ActivationFailure("ACTIVATION_PRIVATE_FILE_REJECTED") from None


def validate_receipt(value, origin, environment):
    if not isinstance(value, dict) or set(value) != {"run_id", "attempt", "source_revision", "origin", "result"}:
        raise ActivationFailure("SMOKE_RECEIPT_INVALID")
    for name, pattern, key in (("run_id", r"[1-9][0-9]{0,19}", "GITHUB_RUN_ID"),
                               ("attempt", r"[1-9][0-9]{0,5}", "GITHUB_RUN_ATTEMPT"),
                               ("source_revision", r"[a-f0-9]{40}", "GITHUB_SHA")):
        expected = environment.get(key, "")
        if not isinstance(value[name], str) or not re.fullmatch(pattern, expected) or value[name] != expected:
            raise ActivationFailure("SMOKE_RECEIPT_WORKFLOW_MISMATCH")
    if value["origin"] != origin:
        raise ActivationFailure("SMOKE_RECEIPT_ORIGIN_MISMATCH")
    result = value["result"]
    if (not isinstance(result, dict) or result.get("probe") != "tenderdesk_production_smoke"
            or result.get("status") != "passed" or result.get("checks_passed") != len(REQUIRED_SMOKE_CHECKS)
            or not isinstance(result.get("checks"), dict) or set(result["checks"]) != REQUIRED_SMOKE_CHECKS
            or any(check is not True for check in result["checks"].values())
            or result.get("workspace_fixture_records_created") is not False
            or result.get("source_project_deleted") is not False or result.get("cleanup_failures")):
        raise ActivationFailure("SMOKE_RECEIPT_NOT_PASSED")


def collection_hosts(value):
    if not isinstance(value, str) or len(value) > 32000:
        raise ActivationFailure("COLLECTION_HOST_CONFIGURATION_INVALID")
    hosts = [host.strip() for host in value.split(",") if host.strip()]
    if len(hosts) > 200 or any(len(host) > 253 or ".." in host or not re.fullmatch(r"[a-z0-9][a-z0-9.-]*\.[a-z]{2,63}", host) for host in hosts):
        raise ActivationFailure("COLLECTION_HOST_CONFIGURATION_INVALID")
    return sorted(set(hosts))


@dataclass(frozen=True)
class Config:
    public: object = field(repr=False)
    runtime: dict = field(repr=False)
    hosts: list[str]
    run_id: str
    attempt: str

    @classmethod
    def load(cls, receipt=None):
        try:
            workdir = Path(os.environ["DOKS_WORKDIR"])
            metadata = workdir.lstat()
            if (not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode)
                    or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077):
                raise ValueError
        except (KeyError, OSError, ValueError):
            raise ActivationFailure("ACTIVATION_PRIVATE_DIRECTORY_REJECTED") from None
        public = smoke.public_config(private_json(workdir / "public-deployment.json", workdir))
        validate_receipt(private_json(receipt or workdir / "production-smoke.json", workdir), public["apiUrl"], os.environ)
        # Existing smoke configuration validates the exact cluster endpoint/CA,
        # namespace marker, signed API roles and mounted public configuration.
        connection = smoke.Config.load()
        if connection.origin != public["apiUrl"]:
            raise ActivationFailure("ACTIVATION_PUBLIC_CONFIGURATION_MISMATCH")
        stored = deploy.get("secret", "tenderdesk-runtime")
        owned(stored, "tenderdesk-runtime")
        runtime = deploy.decode_secret(stored)
        for key in ("APP_WORKER_SECRET", "APP_NATIVE_WORKER_SECRET"):
            value = runtime.get(key, "")
            if (not isinstance(value, str) or not 32 <= len(value) <= 256 or "\x00" in value
                    or value in (connection.service_key, connection.anon_key)):
                raise ActivationFailure("ACTIVATION_WORKER_CREDENTIAL_INVALID")
        if runtime["APP_WORKER_SECRET"] == runtime["APP_NATIVE_WORKER_SECRET"]:
            raise ActivationFailure("ACTIVATION_WORKER_CREDENTIALS_NOT_DISTINCT")
        return cls(connection, runtime, collection_hosts(runtime.get("APP_COLLECTION_HOSTS")),
                   os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"])


def owned(value, name, component=None):
    if (not isinstance(value, dict) or value.get("metadata", {}).get("name") != name
            or value["metadata"].get("namespace") != NAMESPACE
            or value["metadata"].get("labels", {}).get("app.kubernetes.io/managed-by") != MARKER
            or component is not None and value["metadata"].get("labels", {}).get("app.kubernetes.io/name") != component):
        raise ActivationFailure("ACTIVATION_RESOURCE_NOT_OWNED")
    return value


def timestamp(value):
    if value is None:
        return None
    try:
        if not isinstance(value, str):
            raise ValueError
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError
        return result.timestamp()
    except (ValueError, TypeError, OverflowError):
        raise ActivationFailure("HEARTBEAT_TIMESTAMP_INVALID") from None


class Activation:
    def __init__(self, config, client=None):
        self.config = config
        self.client = smoke.Client(config.public) if client is None else client
        self.checks = []
        self.jobs = {}
        self.cronjobs = {}
        self.changed = False
        self.workspace_id = None
        self.cleanup_failures = []

    def passed(self, name):
        if name not in self.checks:
            self.checks.append(name)

    def rows(self, table, selection, limit=1000):
        response = self.client.request("/rest/v1/" + table + "?select=" + selection + "&limit=" + str(limit), token=self.config.public.service_key)
        if response.status != 200:
            raise ActivationFailure("ACTIVATION_DATABASE_READ_FAILED")
        value = response.json("ACTIVATION_DATABASE_RESPONSE_INVALID")
        if not isinstance(value, list) or any(not isinstance(row, dict) for row in value) or len(value) >= limit and limit > 2:
            raise ActivationFailure("ACTIVATION_DATABASE_RESPONSE_INVALID")
        return value

    def empty_target(self):
        workspaces = self.rows("workspaces", "id,model_enabled", 2)
        if len(workspaces) != 1 or workspaces[0].get("model_enabled") is not False:
            raise ActivationFailure("TARGET_WORKSPACE_PROCESSING_NOT_PAUSED")
        try:
            workspace_id = str(uuid.UUID(workspaces[0]["id"]))
        except (KeyError, ValueError, TypeError):
            raise ActivationFailure("TARGET_WORKSPACE_IDENTITY_INVALID") from None
        if self.workspace_id is not None and workspace_id != self.workspace_id:
            raise ActivationFailure("TARGET_WORKSPACE_IDENTITY_CHANGED")
        self.workspace_id = workspace_id
        for table in EMPTY_TABLES:
            if self.rows(table, "id", 1):
                raise ActivationFailure("TARGET_BUSINESS_DATA_NOT_EMPTY")
        for table in ("model_execution_settings", "model_routing"):
            rows = self.rows(table, "workspace_id,enabled")
            if not rows or any(row.get("workspace_id") != workspace_id or row.get("enabled") is not False for row in rows):
                raise ActivationFailure("TARGET_EXTERNAL_PROCESSING_NOT_PAUSED")
        # Legacy provider configuration may retain enabled metadata. It cannot
        # start work without admission/jobs; preserve the Owner's configuration.
        settings = self.rows("model_settings", "workspace_id,enabled")
        if not settings or any(row.get("workspace_id") != workspace_id or type(row.get("enabled")) is not bool for row in settings):
            raise ActivationFailure("TARGET_MODEL_CONFIGURATION_INVALID")
        operations = self.rows("operations", "workspace_id,last_heartbeat_at,scheduler_enabled", 2)
        if len(operations) != 1 or operations[0].get("workspace_id") != workspace_id or type(operations[0].get("scheduler_enabled")) is not bool:
            raise ActivationFailure("TARGET_OPERATIONS_IDENTITY_INVALID")
        return timestamp(operations[0].get("last_heartbeat_at"))

    def workloads(self):
        for name in ("worker", "source-browser", "scheduler"):
            value = owned(deploy.get("deployment", name), name, name)
            spec = value.get("spec", {})
            containers = spec.get("template", {}).get("spec", {}).get("containers", [])
            if spec.get("replicas") != 1 or len(containers) != 1 or containers[0].get("name") != name or not re.fullmatch(re.escape(REGISTRY) + r"runtime@sha256:[a-f0-9]{64}", containers[0].get("image", "")):
                raise ActivationFailure("ACTIVATION_RUNTIME_WORKLOAD_INVALID")
            values = [entry for entry in containers[0].get("env", []) if entry.get("name") == "APP_RUNTIME_SERVICE"]
            if values != [{"name": "APP_RUNTIME_SERVICE", "value": name}]:
                raise ActivationFailure("ACTIVATION_RUNTIME_SERVICE_INVALID")
            if name == "scheduler":
                enabled = [entry for entry in containers[0].get("env", []) if entry.get("name") == "APP_SCHEDULER_ENABLED"]
                if len(enabled) != 1 or enabled[0].get("value") not in ("true", "false") or "valueFrom" in enabled[0]:
                    raise ActivationFailure("ACTIVATION_SCHEDULER_CONFIGURATION_INVALID")
        for name in ("browser", "ocr"):
            value = owned(deploy.get("cronjob", "native-" + name), "native-" + name, "native-" + name)
            spec = value.get("spec", {})
            pod = spec.get("jobTemplate", {}).get("spec", {}).get("template", {}).get("spec", {})
            containers = pod.get("containers", [])
            if (type(spec.get("suspend")) is not bool or spec.get("schedule") not in ("*/5 * * * *", "*/10 * * * *")
                    or spec.get("concurrencyPolicy") != "Forbid" or len(containers) != 1 or containers[0].get("name") != name
                    or not re.fullmatch(re.escape(REGISTRY + name) + r"@sha256:[a-f0-9]{64}", containers[0].get("image", ""))
                    or pod.get("automountServiceAccountToken") is not False):
                raise ActivationFailure("ACTIVATION_NATIVE_WORKLOAD_INVALID")
            values = containers[0].get("env", [])
            if ({"name": "APP_NATIVE_WORKER_URL", "value": "http://source-browser:8080/functions/v1/source-browser"} not in values
                    or {"name": "APP_NATIVE_WORKER_SECRET", "valueFrom": {"secretKeyRef": {"name": "tenderdesk-runtime", "key": "APP_NATIVE_WORKER_SECRET"}}} not in values):
                raise ActivationFailure("ACTIVATION_NATIVE_IDENTITY_CONFIGURATION_INVALID")
            self.cronjobs[name] = value
        self.passed("owned_runtime_and_native_workloads_with_immutable_images")

    def configure(self):
        response = self.client.request("/rest/v1/rpc/configure_dispatcher", token=self.config.public.service_key,
            method="POST", data={"project_url": self.config.public.origin, "collection_hosts": self.config.hosts})
        if response.status not in {200, 204}:
            raise ActivationFailure("DISPATCHER_CONFIGURATION_FAILED")
        self.changed = True
        self.passed("durable_dispatcher_configured_with_existing_worker_identity")

    def private_probe(self, component):
        if component not in {"worker", "source-browser"}:
            raise ActivationFailure("PRIVATE_PROBE_COMPONENT_INVALID")
        native = component == "source-browser"
        # The expected Secret is sent through stdin, not an argument or log.
        script = r'''
try {
 const input=JSON.parse(await new Response(Deno.stdin.readable).text());
 const native=input.native===true;
 if(typeof input.secret!=="string"||input.secret.length<32)throw Error();
 const url="http://127.0.0.1:8080/functions/v1/"+(native?"source-browser":"worker");
 const call=async(secret,action)=>fetch(url,{method:"POST",redirect:"error",headers:{"content-type":"application/json",[native?"x-native-worker-secret":"x-worker-secret"]:secret},body:JSON.stringify(native?{action,payload:{}}:{}),signal:AbortSignal.timeout(150000)});
 const denied=await call("invalid-activation-probe", "claim");
 if(denied.status!==401)throw Error();
 await denied.body?.cancel();
 const allowed=await call(input.secret,"claim");
 if(allowed.status!==200)throw Error();
 const body=await allowed.json();
 if(native?body.data!==null:body.data?.claimed!==false)throw Error();
 if(native){const ocr=await call(input.secret,"ocr_claim");if(ocr.status!==200||(await ocr.json()).data!==null)throw Error();}
 console.log(JSON.stringify({denied:401,allowed:200,empty:true,native}));
} catch { console.log(JSON.stringify({probe_failed:true})); Deno.exit(1); }
'''
        key = "APP_NATIVE_WORKER_SECRET" if native else "APP_WORKER_SECRET"
        try:
            raw = deploy.command(["exec", "-i", "deployment/" + component, "-n", NAMESPACE, "--", "deno", "eval", "--no-config", script],
                payload=json.dumps({"secret": self.config.runtime[key], "native": native}), timeout=175)
            if json.loads(raw) != {"denied": 401, "allowed": 200, "empty": True, "native": native}:
                raise ValueError
        except (ValueError, deploy.DeployError):
            raise ActivationFailure("PRIVATE_WORKER_AUTHENTICATION_OR_EMPTY_QUEUE_FAILED") from None
        self.passed("private_native_identity_and_empty_reader_queues" if native else "private_worker_identity_denial_and_authenticated_empty_invocation")

    def heartbeat(self, baseline, timeout=100):
        deadline = time.monotonic() + timeout
        while True:
            operations = self.rows("operations", "workspace_id,last_heartbeat_at,scheduler_enabled", 2)
            if len(operations) != 1 or operations[0].get("workspace_id") != self.workspace_id:
                raise ActivationFailure("TARGET_OPERATIONS_IDENTITY_INVALID")
            value = timestamp(operations[0].get("last_heartbeat_at"))
            if value is not None and (baseline is None or value > baseline) and time.time() - 90 <= value <= time.time() + 120:
                if operations[0].get("scheduler_enabled") is not True:
                    raise ActivationFailure("SCHEDULER_DATABASE_CONFIGURATION_NOT_ENABLED")
                return value
            if time.monotonic() >= deadline:
                raise ActivationFailure("SCHEDULER_HEARTBEAT_DID_NOT_ADVANCE")
            time.sleep(2)

    def scheduler(self, enabled):
        owned(deploy.get("deployment", "scheduler"), "scheduler", "scheduler")
        patch = {"spec": {"template": {"spec": {"containers": [{"name": "scheduler", "env": [{"name": "APP_SCHEDULER_ENABLED", "value": str(enabled).lower()}]}]}}}}
        deploy.command(["patch", "deployment", "scheduler", "-n", NAMESPACE, "--type=strategic", "--patch", json.dumps(patch)])
        deploy.command(["rollout", "status", "deployment/scheduler", "-n", NAMESPACE, "--timeout=180s"], timeout=200)

    def native_schedules(self, enabled):
        for name in ("browser", "ocr"):
            owned(deploy.get("cronjob", "native-" + name), "native-" + name, "native-" + name)
            patch = {"spec": {"suspend": not enabled}}
            if enabled:
                patch["spec"]["schedule"] = "*/5 * * * *"
            deploy.command(["patch", "cronjob", "native-" + name, "-n", NAMESPACE, "--type=merge", "--patch", json.dumps(patch)])
            updated = owned(deploy.get("cronjob", "native-" + name), "native-" + name, "native-" + name)
            if updated.get("spec", {}).get("suspend") is not (not enabled) or enabled and updated["spec"].get("schedule") != "*/5 * * * *":
                raise ActivationFailure("NATIVE_SCHEDULE_ACTIVATION_NOT_CONFIRMED")

    def verify_native_images(self):
        for name in ("browser", "ocr"):
            job_name = "activation-native-" + name + "-" + self.config.run_id + "-" + self.config.attempt
            if len(job_name) > 63:
                raise ActivationFailure("NATIVE_VERIFICATION_JOB_NAME_REJECTED")
            current = deploy.get("job", job_name)
            if current is not None:
                raise ActivationFailure("NATIVE_VERIFICATION_JOB_ALREADY_EXISTS")
            labels = {"app.kubernetes.io/managed-by": MARKER, "app.kubernetes.io/part-of": "tenderdesk",
                      "app.kubernetes.io/name": "activation-native-" + name,
                      "tenderdesk.io/run-id": self.config.run_id, "tenderdesk.io/run-attempt": self.config.attempt}
            spec = deepcopy(self.cronjobs[name]["spec"]["jobTemplate"]["spec"])
            spec.update({"activeDeadlineSeconds": 240, "backoffLimit": 0, "ttlSecondsAfterFinished": 600})
            spec["template"]["metadata"] = {"labels": labels}
            value = {"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": job_name, "namespace": NAMESPACE, "labels": labels}, "spec": spec}
            # Atomic create cannot overwrite an existing, same-named Job.
            self.jobs[job_name] = None
            deploy.command(["create", "-f", "-"], payload=json.dumps(value))
            created = owned(deploy.get("job", job_name), job_name, "activation-native-" + name)
            uid = created["metadata"].get("uid")
            if not isinstance(uid, str) or not uid:
                raise ActivationFailure("NATIVE_VERIFICATION_JOB_IDENTITY_INVALID")
            self.jobs[job_name] = uid
        deadline = time.monotonic() + 270
        pending = set(self.jobs)
        while pending:
            for name in list(pending):
                value = owned(deploy.get("job", name), name)
                if value["metadata"].get("uid") != self.jobs[name]:
                    raise ActivationFailure("NATIVE_VERIFICATION_JOB_IDENTITY_CHANGED")
                status_value = value.get("status", {})
                if status_value.get("failed") or any(condition.get("type") == "Failed" and condition.get("status") == "True" for condition in status_value.get("conditions", [])):
                    raise ActivationFailure("NATIVE_VERIFICATION_IMAGE_EXECUTION_FAILED")
                if status_value.get("succeeded") == 1:
                    pending.remove(name)
            if pending:
                if time.monotonic() >= deadline:
                    raise ActivationFailure("NATIVE_VERIFICATION_IMAGE_EXECUTION_TIMEOUT")
                time.sleep(2)
        self.passed("both_native_images_execute_and_finish_against_empty_private_queues")

    def cleanup_jobs(self):
        for name, uid in list(self.jobs.items()):
            try:
                current = deploy.get("job", name)
                if current is not None:
                    owned(current, name)
                    labels = current["metadata"].get("labels", {})
                    if (uid is not None and current["metadata"].get("uid") != uid or not current["metadata"].get("uid") or labels.get("tenderdesk.io/run-id") != self.config.run_id
                            or labels.get("tenderdesk.io/run-attempt") != self.config.attempt):
                        raise ActivationFailure("NATIVE_VERIFICATION_CLEANUP_IDENTITY_REJECTED")
                    deploy.command(["delete", "job", name, "-n", NAMESPACE, "--wait=true", "--timeout=60s"], timeout=80)
                del self.jobs[name]
            except Exception:
                self.cleanup_failures.append("NATIVE_VERIFICATION_CLEANUP_NOT_CONFIRMED")
        if not self.jobs:
            self.passed("owned_native_verification_jobs_removed")

    def pause_after_failure(self):
        # A configured durable wake can remain safely pending while its relay is
        # paused. Do not introduce a new SQL-admin credential for error cleanup.
        for name in ("scheduler", "native-browser", "native-ocr"):
            try:
                if name == "scheduler":
                    owned(deploy.get("deployment", name), name, name)
                    self.scheduler(False)
                else:
                    owned(deploy.get("cronjob", name), name, name)
                    deploy.command(["patch", "cronjob", name, "-n", NAMESPACE, "--type=merge", "--patch", '{"spec":{"suspend":true}}'])
            except Exception:
                self.cleanup_failures.append("MAINTENANCE_PAUSE_NOT_CONFIRMED")

    def run(self):
        try:
            self.workloads()
            before = self.empty_target()
            self.passed("empty_business_queues_and_external_work_admission_paused")
            self.configure()
            self.private_probe("worker")
            manual = self.heartbeat(before, timeout=15)
            self.passed("authenticated_worker_updates_real_operations_heartbeat")
            self.private_probe("source-browser")
            self.scheduler(True)
            self.heartbeat(manual)
            self.passed("enabled_durable_relay_advances_a_second_real_worker_heartbeat")
            self.empty_target()
            self.verify_native_images()
            self.empty_target()
            self.native_schedules(True)
            self.passed("native_reader_schedules_enabled_every_five_minutes_without_business_activation")
        except Exception:
            if self.changed:
                self.pause_after_failure()
            raise
        finally:
            self.cleanup_jobs()
        if self.cleanup_failures:
            self.pause_after_failure()
            raise ActivationFailure("ACTIVATION_CLEANUP_NOT_CONFIRMED")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    activation = None
    try:
        config = Config.load(args.receipt)
        activation = Activation(config)
        activation.passed("passed_smoke_receipt_bound_to_current_workflow_attempt_and_origin")
        activation.run()
        providers = sum(bool(value) for key, value in config.runtime.items() if key.startswith("APP_MODEL_") and key.endswith("_KEY"))
        smtp_ready = all(config.runtime.get(key) for key in ("APP_SMTP_HOST", "APP_SMTP_USER", "APP_SMTP_PASSWORD", "APP_SMTP_FROM"))
        emit("passed", activation.checks, provider_count=providers, smtp_configured=bool(smtp_ready))
        return 0
    except (ActivationFailure, deploy.DeployError, smoke.SmokeFailure) as error:
        code = error.code if isinstance(error, smoke.SmokeFailure) else str(error)
        emit("failed", activation.checks if activation else [], code=code,
             cleanup_failures=activation.cleanup_failures if activation else None)
        return 1
    except Exception:
        emit("failed", activation.checks if activation else [], code="UNEXPECTED_ACTIVATION_FAILURE",
             cleanup_failures=activation.cleanup_failures if activation else None)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
