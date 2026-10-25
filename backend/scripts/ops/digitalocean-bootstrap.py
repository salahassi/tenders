#!/usr/bin/env python3
"""Run disposable compatible-service acceptance against the existing managed PG.

Only a newly created, nonce-named logical database and seven nonce-named roles
may be changed. No source data, production schema, public service or real file
is read or restored. Public output is a bounded allowlist of test outcomes.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time
import urllib.parse

DIRECTORY = Path(__file__).resolve().parent
ASSETS = DIRECTORY / "bootstrap"
spec = importlib.util.spec_from_file_location("doks_preflight", DIRECTORY / "digitalocean-preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)
sys.path.insert(0, str(ASSETS))
from buildcontainers import build_bootstrap_job, SIDECAR_NAMES

ACCEPTANCE_CHECKS = {
    "services_migrated_and_fixture_ready",
    "signup_disabled_and_admin_requires_service_identity",
    "admin_invitation_password_signin_and_distinct_users",
    "user_row_isolation_update_checks_and_anon_denials",
    "service_owner_access_without_relaxing_user_rls",
    "private_bucket_two_user_upload_download_byte_equality",
    "private_file_cross_user_anon_public_denials_and_service_read",
}


class BootstrapError(Exception):
    """Fixed codes only: raw HTTP, PostgreSQL and service errors stay private."""


def emit(status: str, **safe) -> None:
    print(json.dumps({"probe": "compatible_services", "status": status, **safe}, sort_keys=True), flush=True)


def b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def jwt(secret: str, role: str) -> str:
    header = b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    now = int(time.time())
    payload = b64(json.dumps({"role": role, "aud": "authenticated", "iss": "tenderdesk-isolated-bootstrap",
                             "iat": now, "exp": now + 3600}, separators=(",", ":")).encode())
    signing_input = header + "." + payload
    return signing_input + "." + b64(hmac.new(secret.encode(), signing_input.encode(), hashlib.sha256).digest())


def private_state_path() -> Path:
    # Reuse the verified runner-directory guard; do not persist credentials here.
    return preflight.cleanup_state_path().with_name("compatible-bootstrap-cleanup.json")


def identity() -> dict:
    run = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if not re.fullmatch(r"[0-9]{1,20}", run) or not re.fullmatch(r"[0-9]{1,6}", attempt):
        raise BootstrapError("GITHUB_RUN_IDENTITY_REQUIRED")
    nonce = secrets.token_hex(4)
    owner = run + "-" + attempt + "-" + nonce
    return {
        "namespace": "td-bootstrap-" + owner,
        "database": "td_bootstrap_" + run + "_" + attempt + "_" + nonce,
        "role_prefix": "tdb_" + run[-8:] + "_" + nonce,
        "labels": {"app.kubernetes.io/managed-by": "tenderdesk-bootstrap", "tenderdesk.io/run": owner},
        "uid": None, "job_uid": None, "setup_started": False, "database_cleanup_confirmed": False,
    }


def validate_state(state: dict) -> dict:
    expected = {"namespace", "database", "role_prefix", "labels", "uid", "job_uid",
                "setup_started", "database_cleanup_confirmed"}
    if not isinstance(state, dict) or set(state) != expected:
        raise BootstrapError("INVALID_BOOTSTRAP_CLEANUP_STATE")
    run = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    owner = state.get("labels", {}).get("tenderdesk.io/run", "")
    match = re.fullmatch(re.escape(run + "-" + attempt + "-") + r"([0-9a-f]{8})", owner)
    if not match:
        raise BootstrapError("BOOTSTRAP_RUN_OWNERSHIP_MISMATCH")
    nonce = match.group(1)
    if (state["namespace"] != "td-bootstrap-" + owner
        or state["database"] != f"td_bootstrap_{run}_{attempt}_{nonce}"
        or state["role_prefix"] != f"tdb_{run[-8:]}_{nonce}"
        or state["labels"] != {"app.kubernetes.io/managed-by": "tenderdesk-bootstrap", "tenderdesk.io/run": owner}
        or not isinstance(state["uid"], str) or not state["uid"]
        or type(state["setup_started"]) is not bool
        or type(state["database_cleanup_confirmed"]) is not bool):
        raise BootstrapError("BOOTSTRAP_RESOURCE_OWNERSHIP_MISMATCH")
    return state


def save(state: dict) -> None:
    path = private_state_path()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(state, stream)


def create(manifest: dict) -> dict:
    return preflight.kubectl_json(["create", "-f", "-", "--output=json"], manifest=manifest)


def assert_namespace(state: dict) -> None:
    actual = preflight.kubectl_json(["get", "namespace", state["namespace"], "--output=json"])
    meta = actual.get("metadata", {})
    if meta.get("uid") != state["uid"] or any(meta.get("labels", {}).get(k) != v for k, v in state["labels"].items()):
        raise BootstrapError("BOOTSTRAP_NAMESPACE_OWNERSHIP_CHANGED")


def database_uri(credentials: dict, state: dict, suffix: str, password: str) -> str:
    quote = lambda s: urllib.parse.quote(str(s), safe="")
    query = urllib.parse.urlencode({"sslmode": "verify-full", "sslrootcert": "/run/db-ca/ca.crt"})
    return ("postgresql://" + quote(state["role_prefix"] + suffix) + ":" + quote(password)
            + "@" + credentials["PGHOST"] + ":" + credentials["PGPORT"] + "/"
            + quote(state["database"]) + "?" + query)


def secret_values(credentials: dict, ca: str, state: dict) -> dict:
    values = dict(credentials)
    values.update({"PGSSLCA": ca, "BOOTSTRAP_DATABASE": state["database"], "ROLE_PREFIX": state["role_prefix"],
                   "AUTH_DB_PASSWORD": secrets.token_urlsafe(36),
                   "STORAGE_DB_PASSWORD": secrets.token_urlsafe(36),
                   "REST_DB_PASSWORD": secrets.token_urlsafe(36), "JWT_SECRET": secrets.token_hex(32)})
    for key, suffix, password in (
        ("AUTH_DATABASE_URL", "_authadmin", "AUTH_DB_PASSWORD"),
        ("STORAGE_DATABASE_URL", "_storageadmin", "STORAGE_DB_PASSWORD"),
        ("POSTGREST_DATABASE_URL", "_authenticator", "REST_DB_PASSWORD"),
    ):
        values[key] = database_uri(credentials, state, suffix, values[password])
    values["ANON_KEY"] = jwt(values["JWT_SECRET"], state["role_prefix"] + "_anon")
    values["SERVICE_KEY"] = jwt(values["JWT_SECRET"], state["role_prefix"] + "_service")
    return values


def sql_job(state: dict, name: str, script: str, database: str) -> dict:
    if script not in {"setup.sql", "post-migrations.sql", "cleanup.sql"}:
        raise BootstrapError("UNREVIEWED_BOOTSTRAP_SQL")
    return {
        "apiVersion": "batch/v1", "kind": "Job",
        "metadata": {"name": name, "namespace": state["namespace"], "labels": state["labels"]},
        "spec": {"backoffLimit": 0, "activeDeadlineSeconds": 150, "ttlSecondsAfterFinished": 900,
                 "template": {"metadata": {"labels": state["labels"]}, "spec": {
                     "restartPolicy": "Never", "automountServiceAccountToken": False,
                     "securityContext": {"runAsNonRoot": True, "runAsUser": 999, "runAsGroup": 999,
                                         "seccompProfile": {"type": "RuntimeDefault"}},
                     "containers": [{
                         "name": "postgres-client", "image": preflight.CLIENT_IMAGE, "imagePullPolicy": "IfNotPresent",
                         "command": ["psql", "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--quiet",
                                     "--file", "/opt/bootstrap/" + script],
                         "envFrom": [{"secretRef": {"name": "bootstrap-secrets"}}],
                         "env": [{"name": "PGDATABASE", "value": database},
                                 {"name": "PGSSLMODE", "value": "verify-full"},
                                 {"name": "PGSSLROOTCERT", "value": "/run/db-ca/ca.crt"},
                                 {"name": "PGCONNECT_TIMEOUT", "value": "15"},
                                 {"name": "PGAPPNAME", "value": "tenderdesk-isolated-bootstrap"},
                                 {"name": "PGOPTIONS", "value": "-c statement_timeout=30000 -c lock_timeout=5000"}],
                         "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
                                             "capabilities": {"drop": ["ALL"]}},
                         "resources": {"requests": {"cpu": "50m", "memory": "32Mi"},
                                       "limits": {"cpu": "250m", "memory": "128Mi"}},
                         "volumeMounts": [{"name": "database-ca", "mountPath": "/run/db-ca", "readOnly": True},
                                          {"name": "bootstrap-code", "mountPath": "/opt/bootstrap", "readOnly": True}],
                     }],
                     "volumes": [
                         {"name": "database-ca", "secret": {"secretName": "bootstrap-secrets", "defaultMode": 0o444,
                             "items": [{"key": "PGSSLCA", "path": "ca.crt"}]}},
                         {"name": "bootstrap-code", "configMap": {"name": "bootstrap-code", "defaultMode": 0o444}},
                     ],
                 }}},
    }


def private_logs(state: dict, job: str, container: str, *, limit: int = 65536) -> str:
    return preflight.kubectl(["logs", "job/" + job, "--namespace", state["namespace"],
                              "--container", container, "--limit-bytes=" + str(limit)])


def failure_code(text: str, fallback: str) -> str:
    # Return fixed categories, never the raw log or any dynamic fragment of it.
    lowered = text.lower()
    for needle, code in (
        ("permission denied to create role", "ROLE_CREATION_DENIED"),
        ("permission denied to create database", "DATABASE_CREATION_DENIED"),
        ("permission denied to create extension", "EXTENSION_INSTALLATION_DENIED"),
        ("permission denied for schema", "SCHEMA_PRIVILEGE_DENIED"),
        ("must be owner", "OBJECT_OWNERSHIP_DENIED"),
        ("certificate verify failed", "DATABASE_TLS_VERIFICATION_FAILED"),
        ("password authentication failed", "SERVICE_DATABASE_AUTHENTICATION_FAILED"),
        ("bootstrap ownership", "DATABASE_CLEANUP_OWNERSHIP_REFUSED"),
        ("bootstrap collision", "DATABASE_OR_ROLE_ALREADY_EXISTS"),
    ):
        if needle in lowered:
            return code
    return fallback


def sql_failure_details(text: str) -> dict:
    """Extract only non-sensitive SQLSTATE, reviewed asset line and stage."""
    result = {}
    state = re.search(r"ERROR:\s+([0-9A-Z]{5}):", text)
    if state:
        result["sqlstate"] = state.group(1)
    line = re.search(r"/(setup|post-migrations|cleanup)\.sql:([0-9]{1,5}):", text)
    if line:
        result.update({"script": line.group(1) + ".sql", "line": int(line.group(2))})
    for stage in ("validated", "roles_created", "database_created", "schemas_created", "extensions_installed"):
        if "tdb_stage_" + stage in text:
            result["last_stage"] = stage
    return result


def wait_sql(state: dict, name: str) -> None:
    deadline = time.monotonic() + 185
    while time.monotonic() < deadline:
        job = preflight.kubectl_json(["get", "job", name, "--namespace", state["namespace"], "--output=json"])
        status = job.get("status", {})
        if status.get("succeeded", 0) == 1:
            return
        if status.get("failed", 0):
            try:
                logs = private_logs(state, name, "postgres-client")
            except preflight.ProbeError:
                logs = ""
            emit("sql_failed", **sql_failure_details(logs))
            raise BootstrapError(failure_code(logs, "SQL_" + name.upper().replace("-", "_") + "_FAILED"))
        time.sleep(2)
    raise BootstrapError("BOOTSTRAP_SQL_JOB_TIMEOUT")


def run_sql(state: dict, name: str, script: str, database: str) -> None:
    create(sql_job(state, name, script, database))
    wait_sql(state, name)


def wait_sidecars(state: dict) -> None:
    deadline = time.monotonic() + 600
    last_progress = None
    while time.monotonic() < deadline:
        pods = preflight.kubectl_json(["get", "pods", "--namespace", state["namespace"],
                                      "--selector=job-name=compatible-services", "--output=json"]).get("items", [])
        for pod in pods:
            statuses = pod.get("status", {}).get("initContainerStatuses", [])
            started = sum(s.get("started") is True for s in statuses if s.get("name") in SIDECAR_NAMES)
            if started != last_progress:
                emit("starting", ready_sidecars=started, expected_sidecars=len(SIDECAR_NAMES))
                last_progress = started
            if started == len(SIDECAR_NAMES):
                return
            for item in statuses:
                if item.get("name") not in SIDECAR_NAMES:
                    continue
                waiting = item.get("state", {}).get("waiting", {})
                if waiting.get("reason") in {"ErrImagePull", "ImagePullBackOff", "InvalidImageName"}:
                    raise BootstrapError("PINNED_SERVICE_IMAGE_PULL_FAILED")
                if item.get("restartCount", 0) >= 2:
                    try:
                        logs = private_logs(state, "compatible-services", item["name"])
                    except preflight.ProbeError:
                        logs = ""
                    raise BootstrapError(failure_code(logs, "SERVICE_" + item["name"].upper() + "_STARTUP_FAILED"))
        time.sleep(3)
    raise BootstrapError("COMPATIBLE_SERVICE_STARTUP_TIMEOUT")


def wait_acceptance(state: dict) -> dict:
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        job = preflight.kubectl_json(["get", "job", "compatible-services", "--namespace", state["namespace"], "--output=json"])
        status = job.get("status", {})
        if status.get("succeeded", 0) == 1 or status.get("failed", 0):
            try:
                raw = private_logs(state, "compatible-services", "acceptance", limit=16384)
                value = json.loads(raw)
            except (preflight.ProbeError, ValueError, TypeError):
                raise BootstrapError("HTTP_ACCEPTANCE_RESULT_UNAVAILABLE") from None
            # Acceptance emits only boolean test outcomes and a fixed status.
            if not isinstance(value, dict) or value.get("status") not in {"passed", "failed"}:
                raise BootstrapError("INVALID_HTTP_ACCEPTANCE_RESULT")
            checks = value.get("checks")
            if (not isinstance(checks, dict)
                or not all(k in ACCEPTANCE_CHECKS and type(v) is bool
                           for k, v in checks.items())):
                raise BootstrapError("INVALID_HTTP_ACCEPTANCE_CHECKS")
            if status.get("failed", 0) or value["status"] != "passed" or not all(checks.values()):
                code = value.get("code", "AUTH_STORAGE_HTTP_ACCEPTANCE_FAILED")
                if not isinstance(code, str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{2,80}", code):
                    code = "AUTH_STORAGE_HTTP_ACCEPTANCE_FAILED"
                emit("acceptance_failed", checks=checks, code=code)
                raise BootstrapError("AUTH_STORAGE_HTTP_ACCEPTANCE_FAILED")
            if set(checks) != ACCEPTANCE_CHECKS:
                raise BootstrapError("INCOMPLETE_HTTP_ACCEPTANCE_CHECKS")
            return checks
        time.sleep(2)
    raise BootstrapError("HTTP_ACCEPTANCE_TIMEOUT")


def wait_clients_stopped(state: dict) -> None:
    deadline = time.monotonic() + 50
    while time.monotonic() < deadline:
        pods = preflight.kubectl_json(["get", "pods", "--namespace", state["namespace"],
                                      "--selector=job-name=compatible-services", "--output=json"]).get("items", [])
        if not pods or all(p.get("status", {}).get("phase") in {"Succeeded", "Failed"} for p in pods):
            return
        time.sleep(2)
    raise BootstrapError("BOOTSTRAP_CLIENT_SHUTDOWN_NOT_CONFIRMED")


def cleanup(state: dict) -> None:
    validate_state(state)
    assert_namespace(state)
    if state["setup_started"] and not state["database_cleanup_confirmed"]:
        job = preflight.kubectl_json(["get", "job", "compatible-services", "--namespace", state["namespace"], "--output=json"])
        if job.get("metadata", {}).get("uid") != state["job_uid"]:
            raise BootstrapError("BOOTSTRAP_PARENT_JOB_OWNERSHIP_CHANGED")
        # Stop all database clients while retaining the Job-owned Secret.
        preflight.kubectl(["patch", "job", "compatible-services", "--namespace", state["namespace"],
                           "--type=merge", "--patch", '{"spec":{"suspend":true}}'])
        wait_clients_stopped(state)
        # A previous cleanup Job can have completed if the runner was interrupted.
        jobs = preflight.kubectl_json(["get", "jobs", "--namespace", state["namespace"], "--output=json"]).get("items", [])
        existing = next((j for j in jobs if j.get("metadata", {}).get("name") == "database-cleanup"), None)
        if existing is None:
            create(sql_job(state, "database-cleanup", "cleanup.sql", "defaultdb"))
        wait_sql(state, "database-cleanup")
        state["database_cleanup_confirmed"] = True
        save(state)
        emit("database_cleanup_confirmed")
    preflight.cleanup_namespace(state["namespace"], state["uid"], state["labels"])
    private_state_path().unlink(missing_ok=True)
    emit("namespace_cleanup_confirmed")


def cleanup_from_state() -> int:
    try:
        path = private_state_path()
        if not path.exists():
            emit("cleanup_not_needed")
            return 0
        cleanup(validate_state(json.loads(path.read_text())))
        return 0
    except Exception:
        emit("blocked", code="BOOTSTRAP_CLEANUP_NOT_CONFIRMED")
        return 1


def run() -> int:
    state = None
    failed = False
    try:
        preflight.validate_cluster()
        credentials, ca = preflight.target_credentials(os.environ.get("DIGITALOCEAN_ACCESS_TOKEN", ""))
        if private_state_path().exists():
            raise BootstrapError("PENDING_BOOTSTRAP_CLEANUP_REQUIRED")
        state = identity()
        created = create({"apiVersion": "v1", "kind": "Namespace",
                          "metadata": {"name": state["namespace"], "labels": {**state["labels"],
                              "pod-security.kubernetes.io/enforce": "restricted"}}})
        state["uid"] = created.get("metadata", {}).get("uid")
        if not isinstance(state["uid"], str) or not state["uid"]:
            raise BootstrapError("BOOTSTRAP_NAMESPACE_OWNERSHIP_UNCONFIRMED")
        save(state)
        parent = build_bootstrap_job(state["namespace"], state["labels"])
        parent["spec"]["suspend"] = True
        parent["spec"]["ttlSecondsAfterFinished"] = 900
        job = create(parent)
        state["job_uid"] = job.get("metadata", {}).get("uid")
        if not isinstance(state["job_uid"], str) or not state["job_uid"]:
            raise BootstrapError("BOOTSTRAP_PARENT_JOB_OWNERSHIP_UNCONFIRMED")
        save(state)
        owner = [{"apiVersion": "batch/v1", "kind": "Job", "name": "compatible-services",
                  "uid": state["job_uid"], "controller": True, "blockOwnerDeletion": False}]
        values = secret_values(credentials, ca, state)
        create({"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
                "metadata": {"name": "bootstrap-secrets", "namespace": state["namespace"],
                             "labels": state["labels"], "ownerReferences": owner},
                "data": {k: base64.b64encode(v.encode()).decode() for k, v in values.items()}})
        filenames = ("setup.sql", "post-migrations.sql", "cleanup.sql", "acceptance.py")
        create({"apiVersion": "v1", "kind": "ConfigMap",
                "metadata": {"name": "bootstrap-code", "namespace": state["namespace"],
                             "labels": state["labels"], "ownerReferences": owner},
                "data": {name: (ASSETS / name).read_text() for name in filenames}})
        create({"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
                "metadata": {"name": "private-bootstrap-only", "namespace": state["namespace"], "labels": state["labels"]},
                "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"], "ingress": [], "egress": [
                    {"ports": [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}]},
                    {"to": [{"ipBlock": {"cidr": cidr}} for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")],
                     "ports": [{"protocol": "TCP", "port": int(credentials["PGPORT"])}]},
                ]}})
        state["setup_started"] = True
        save(state)
        run_sql(state, "database-setup", "setup.sql", "defaultdb")
        emit("isolated_database_created")
        preflight.kubectl(["patch", "job", "compatible-services", "--namespace", state["namespace"],
                           "--type=merge", "--patch", '{"spec":{"suspend":false}}'])
        wait_sidecars(state)
        emit("service_migrations_started")
        run_sql(state, "post-migrations", "post-migrations.sql", state["database"])
        emit("role_and_rls_setup_passed")
        checks = wait_acceptance(state)
        emit("passed", checks=checks, production_data_restored=False, migration_ready=False)
    except (BootstrapError, preflight.ProbeError) as error:
        emit("blocked", code=str(error))
        failed = True
    except Exception:
        emit("blocked", code="UNEXPECTED_BOOTSTRAP_FAILURE")
        failed = True
    finally:
        if state is not None and state.get("uid"):
            try:
                cleanup(state)
            except Exception:
                emit("blocked", code="BOOTSTRAP_CLEANUP_NOT_CONFIRMED")
                failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--cleanup"]:
        sys.exit(cleanup_from_state())
    if sys.argv[1:]:
        emit("blocked", code="UNKNOWN_ARGUMENT")
        sys.exit(1)
    sys.exit(run())
