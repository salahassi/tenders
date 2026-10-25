#!/usr/bin/env python3
"""Inventory migration prerequisites without changing either database.

Run only after the workflow has validated the cluster kubeconfig. The target
probe creates a short-lived Kubernetes namespace, Secret and PostgreSQL client
Job, then removes that namespace. It does not create database objects or expose
a service. All subprocess and HTTP responses remain private unless validated
against the small output schema below.
"""

from __future__ import annotations

import base64
import json
import os
import pathlib
import re
import secrets
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request


CLUSTER_HOST = "a6093a76-a2d6-47fd-8697-579d41ed316f.k8s.ondigitalocean.com"
DATABASE_ID = "d08678a8-7201-4906-98bd-204978a7eec9"
SOURCE_PROJECT = "nqfwbqeozmuiuwbiowil"
CLIENT_IMAGE = (
    "docker.io/library/postgres:18@sha256:"
    "edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6"
)
EXTENSIONS = ("pgcrypto", "uuid-ossp", "pg_trgm", "pg_cron", "pg_net", "supabase_vault")
SCHEMAS = ("auth", "storage", "vault", "extensions", "public")
ROLE_FLAGS = ("superuser", "create_role", "create_database")

# Catalog-only SELECT: never read application rows, passwords, role names or
# stored secret values. The API probe additionally uses read_only=true; psql
# runs this in BEGIN READ ONLY with default_transaction_read_only enabled.
INVENTORY_SQL = """
SELECT jsonb_build_object(
  'server_major', current_setting('server_version_num')::integer / 10000,
  'role', (SELECT jsonb_build_object(
    'superuser', rolsuper, 'create_role', rolcreaterole,
    'create_database', rolcreatedb
  ) FROM pg_catalog.pg_roles WHERE rolname = current_user),
  'extensions', (SELECT jsonb_object_agg(wanted.name, jsonb_build_object(
    'available', EXISTS (SELECT 1 FROM pg_catalog.pg_available_extensions a WHERE a.name = wanted.name),
    'installed', EXISTS (SELECT 1 FROM pg_catalog.pg_extension e WHERE e.extname = wanted.name)
  )) FROM (VALUES ('pgcrypto'), ('uuid-ossp'), ('pg_trgm'), ('pg_cron'),
    ('pg_net'), ('supabase_vault')) AS wanted(name)),
  'schemas', (SELECT jsonb_object_agg(wanted.name, EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = wanted.name
  )) FROM (VALUES ('auth'), ('storage'), ('vault'), ('extensions'), ('public')) AS wanted(name)),
  'public_table_count', (SELECT count(*) FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p'))
) AS inventory
""".strip()


class ProbeError(Exception):
    """Only fixed, non-sensitive error codes may be presented in logs."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def emit(probe: str, status: str, **data) -> None:
    print(json.dumps({"probe": probe, "status": status, **data}, sort_keys=True), flush=True)


def request_json(url: str, token: str, *, body: dict | None = None) -> dict | list:
    headers = {"Authorization": "Bearer " + token, "Accept": "application/json"}
    payload = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body).encode()
    request = urllib.request.Request(url, headers=headers, data=payload)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
            raw = response.read(1_048_577)
    except urllib.error.HTTPError as error:
        raise ProbeError(f"HTTP_{error.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ProbeError("NETWORK_OR_TLS_FAILURE") from None
    if len(raw) > 1_048_576:
        raise ProbeError("API_RESPONSE_TOO_LARGE")
    try:
        return json.loads(raw)
    except (ValueError, UnicodeError):
        raise ProbeError("INVALID_API_JSON") from None


def validate_inventory(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {
        "server_major", "role", "extensions", "schemas", "public_table_count"
    }:
        raise ProbeError("INVALID_INVENTORY_SHAPE")
    major, count = value["server_major"], value["public_table_count"]
    if type(major) is not int or not 10 <= major <= 99:
        raise ProbeError("INVALID_SERVER_VERSION")
    if type(count) is not int or not 0 <= count <= 10_000_000:
        raise ProbeError("INVALID_TABLE_COUNT")
    roles, extensions, schemas = value["role"], value["extensions"], value["schemas"]
    if not isinstance(roles, dict) or set(roles) != set(ROLE_FLAGS):
        raise ProbeError("INVALID_ROLE_FLAGS")
    if not all(type(flag) is bool for flag in roles.values()):
        raise ProbeError("INVALID_ROLE_FLAGS")
    if not isinstance(schemas, dict) or set(schemas) != set(SCHEMAS):
        raise ProbeError("INVALID_SCHEMA_FLAGS")
    if not all(type(flag) is bool for flag in schemas.values()):
        raise ProbeError("INVALID_SCHEMA_FLAGS")
    if not isinstance(extensions, dict) or set(extensions) != set(EXTENSIONS):
        raise ProbeError("INVALID_EXTENSION_FLAGS")
    for flags in extensions.values():
        if not isinstance(flags, dict) or set(flags) != {"available", "installed"}:
            raise ProbeError("INVALID_EXTENSION_FLAGS")
        if not all(type(flag) is bool for flag in flags.values()):
            raise ProbeError("INVALID_EXTENSION_FLAGS")
    return value


def kubectl(arguments: list[str], *, manifest: dict | None = None, timeout: int = 45) -> str:
    executable = os.environ.get("KUBECTL", "")
    if not executable.startswith("/") or not os.environ.get("KUBECONFIG"):
        raise ProbeError("KUBERNETES_CLIENT_NOT_CONFIGURED")
    try:
        result = subprocess.run(
            [executable, "--request-timeout=30s", *arguments],
            input=json.dumps(manifest) if manifest is not None else None,
            capture_output=True, text=True, timeout=timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise ProbeError("KUBERNETES_COMMAND_TIMEOUT_OR_UNAVAILABLE") from None
    if result.returncode:
        raise ProbeError("KUBERNETES_COMMAND_FAILED")
    return result.stdout


def kubectl_json(arguments: list[str], *, manifest: dict | None = None) -> dict:
    try:
        value = json.loads(kubectl(arguments, manifest=manifest))
    except (ValueError, UnicodeError):
        raise ProbeError("INVALID_KUBERNETES_JSON") from None
    if not isinstance(value, dict):
        raise ProbeError("INVALID_KUBERNETES_JSON")
    return value


def validate_cluster() -> None:
    config = kubectl_json(["config", "view", "--minify", "--output=json"])
    try:
        clusters = config["clusters"]
        if not isinstance(clusters, list) or len(clusters) != 1:
            raise ProbeError("UNEXPECTED_CLUSTER_CONFIG")
        cluster = clusters[0]["cluster"]
        allowed = {"server", "certificate-authority-data", "tls-server-name",
                   "insecure-skip-tls-verify", "disable-compression"}
        if not isinstance(cluster, dict) or set(cluster) - allowed:
            raise ProbeError("UNEXPECTED_CLUSTER_TRANSPORT")
        if cluster.get("server") != "https://" + CLUSTER_HOST:
            raise ProbeError("UNEXPECTED_CLUSTER_ENDPOINT")
        if cluster.get("insecure-skip-tls-verify", False) is not False:
            raise ProbeError("CLUSTER_TLS_VERIFICATION_DISABLED")
        if cluster.get("tls-server-name", CLUSTER_HOST) != CLUSTER_HOST:
            raise ProbeError("UNEXPECTED_CLUSTER_TLS_HOSTNAME")
        if not cluster.get("certificate-authority-data"):
            raise ProbeError("CLUSTER_CA_MISSING")
    except (KeyError, TypeError, IndexError):
        raise ProbeError("UNEXPECTED_CLUSTER_CONFIG") from None


def target_credentials(token: str) -> tuple[dict[str, str], str]:
    metadata = request_json(f"https://api.digitalocean.com/v2/databases/{DATABASE_ID}", token)
    try:
        database = metadata["database"]
        if (
            database["id"] != DATABASE_ID or database["name"] != "tenderdesk-dev"
            or database["engine"] != "pg" or database["region"] != "sfo3"
        ):
            raise ProbeError("UNEXPECTED_MANAGED_DATABASE")
        connection = database["private_connection"]
        host = connection["host"]
        if not isinstance(host, str) or not re.fullmatch(
            r"private-[a-z0-9.-]+\.db\.ondigitalocean\.com", host
        ):
            raise ProbeError("PRIVATE_DATABASE_HOST_REQUIRED")
        port = connection["port"]
        if type(port) is not int or not 1 <= port <= 65535:
            raise ProbeError("INVALID_DATABASE_PORT")
        credentials = {
            "PGHOST": host, "PGPORT": str(port), "PGUSER": connection["user"],
            "PGPASSWORD": connection["password"], "PGDATABASE": connection["database"],
        }
        if any(not isinstance(v, str) or not v or "\x00" in v for v in credentials.values()):
            raise ProbeError("INCOMPLETE_DATABASE_CREDENTIALS")
    except (KeyError, TypeError):
        raise ProbeError("INCOMPLETE_DATABASE_METADATA") from None
    ca_response = request_json(f"https://api.digitalocean.com/v2/databases/{DATABASE_ID}/ca", token)
    try:
        certificate = ca_response["ca"]["certificate"]
        if not isinstance(certificate, str) or len(certificate) > 65_536:
            raise ProbeError("INVALID_DATABASE_CA")
        if "-----BEGIN CERTIFICATE-----" not in certificate:
            certificate = base64.b64decode(certificate, validate=True).decode("ascii")
        # Validate the CA syntax without changing the runtime's global trust.
        ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT).load_verify_locations(cadata=certificate)
    except (KeyError, TypeError, ValueError, UnicodeError, ssl.SSLError):
        raise ProbeError("INVALID_DATABASE_CA") from None
    return credentials, certificate


def cleanup_state_path() -> pathlib.Path:
    directory = pathlib.Path(os.environ.get("DOKS_WORKDIR", ""))
    expected = pathlib.Path(os.environ.get("RUNNER_TEMP", "/nonexistent")) / (
        "doks-access-" + os.environ.get("GITHUB_RUN_ID", "")
        + "-" + os.environ.get("GITHUB_RUN_ATTEMPT", "")
    )
    if directory != expected or not directory.is_dir():
        raise ProbeError("INVALID_CLEANUP_STATE_DIRECTORY")
    return directory / "database-preflight-cleanup.json"


def cleanup_namespace(namespace: str, uid: str, labels: dict) -> None:
    current = kubectl_json(["get", "namespace", namespace, "--output=json"])
    metadata = current.get("metadata", {})
    if metadata.get("uid") != uid or any(
        metadata.get("labels", {}).get(key) != value for key, value in labels.items()
    ):
        raise ProbeError("NAMESPACE_OWNERSHIP_CHANGED")
    kubectl(["delete", "namespace", namespace, "--wait=true", "--timeout=45s"], timeout=50)


def cleanup_from_state() -> int:
    try:
        path = cleanup_state_path()
        if not path.exists():
            emit("target_cleanup", "not_needed")
            return 0
        state = json.loads(path.read_text())
        owner = state["labels"]["tenderdesk.io/run"]
        expected_prefix = os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"] + "-"
        if (
            set(state) != {"namespace", "uid", "labels"}
            or not owner.startswith(expected_prefix)
            or not re.fullmatch(re.escape(expected_prefix) + r"[0-9a-f]{8}", owner)
            or state["namespace"] != "td-preflight-" + owner
            or state["labels"] != {"app.kubernetes.io/managed-by": "tenderdesk-preflight", "tenderdesk.io/run": owner}
            or not isinstance(state["uid"], str) or not state["uid"]
        ):
            raise ProbeError("INVALID_CLEANUP_OWNERSHIP_STATE")
        cleanup_namespace(state["namespace"], state["uid"], state["labels"])
        path.unlink()
        emit("target_cleanup", "ok")
        return 0
    except Exception:
        emit("target_cleanup", "blocked", code="TARGET_CLEANUP_NOT_CONFIRMED")
        return 1


def job_failure_code(namespace: str) -> str:
    try:
        output = kubectl([
            "logs", "job/database-inventory", "--namespace", namespace,
            "--container=postgres-client", "--limit-bytes=8192",
        ]).lower()
    except ProbeError:
        return "DATABASE_JOB_FAILED_BEFORE_OUTPUT"
    for needle, code in (
        ("certificate verify failed", "DATABASE_TLS_VERIFICATION_FAILED"),
        ("does not match host name", "DATABASE_TLS_HOSTNAME_MISMATCH"),
        ("password authentication failed", "DATABASE_AUTHENTICATION_FAILED"),
        ("no pg_hba.conf entry", "DATABASE_ACCESS_POLICY_REJECTED"),
        ("timeout expired", "DATABASE_CONNECTION_TIMEOUT"),
        ("could not translate host name", "DATABASE_DNS_FAILED"),
        ("permission denied", "DATABASE_CATALOG_PERMISSION_DENIED"),
    ):
        if needle in output:
            return code
    return "DATABASE_JOB_FAILED"


def target_inventory() -> dict:
    token = os.environ.get("DIGITALOCEAN_ACCESS_TOKEN", "")
    if not token:
        raise ProbeError("DIGITALOCEAN_ACCESS_TOKEN_MISSING")
    image = os.environ.get("POSTGRES_CLIENT_IMAGE", CLIENT_IMAGE)
    if image != CLIENT_IMAGE:
        raise ProbeError("UNREVIEWED_POSTGRES_CLIENT_IMAGE")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if not re.fullmatch(r"[0-9]{1,20}", run_id) or not re.fullmatch(r"[0-9]{1,6}", attempt):
        raise ProbeError("GITHUB_RUN_IDENTITY_REQUIRED")
    validate_cluster()
    credentials, ca = target_credentials(token)
    state_path = cleanup_state_path()
    if state_path.exists():
        raise ProbeError("PENDING_NAMESPACE_CLEANUP_REQUIRED")
    owner = f"{run_id}-{attempt}-{secrets.token_hex(4)}"
    namespace = "td-preflight-" + owner
    labels = {"app.kubernetes.io/managed-by": "tenderdesk-preflight", "tenderdesk.io/run": owner}
    created_uid = None
    try:
        created = kubectl_json(["create", "-f", "-", "--output=json"], manifest={
            "apiVersion": "v1", "kind": "Namespace",
            "metadata": {"name": namespace, "labels": labels},
        })
        created_uid = created.get("metadata", {}).get("uid")
        if not isinstance(created_uid, str) or not created_uid:
            raise ProbeError("NAMESPACE_OWNERSHIP_UNCONFIRMED")
        descriptor = os.open(state_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump({"namespace": namespace, "uid": created_uid, "labels": labels}, output)
        secret_data = {key: base64.b64encode(value.encode()).decode() for key, value in credentials.items()}
        secret_data["ca.crt"] = base64.b64encode(ca.encode()).decode()
        container = {
            "name": "postgres-client", "image": image, "imagePullPolicy": "IfNotPresent",
            "command": ["psql", "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--tuples-only",
                        "--no-align", "--quiet", "--command", "BEGIN READ ONLY;\n" + INVENTORY_SQL + ";\nROLLBACK;"],
            "env": [
                {"name": key, "valueFrom": {"secretKeyRef": {"name": "database-client", "key": key}}}
                for key in credentials
            ] + [
                {"name": "PGSSLMODE", "value": "verify-full"},
                {"name": "PGSSLROOTCERT", "value": "/run/db-ca/ca.crt"},
                {"name": "PGCONNECT_TIMEOUT", "value": "15"},
                {"name": "PGAPPNAME", "value": "tenderdesk-migration-preflight"},
                {"name": "PGOPTIONS", "value": "-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=5000"},
            ],
            "resources": {"requests": {"cpu": "50m", "memory": "64Mi"},
                          "limits": {"cpu": "250m", "memory": "128Mi"}},
            "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True,
                                "capabilities": {"drop": ["ALL"]}},
            "volumeMounts": [{"name": "database-ca", "mountPath": "/run/db-ca", "readOnly": True}],
        }
        job = kubectl_json(["create", "-f", "-", "--output=json"], manifest={
            "apiVersion": "batch/v1", "kind": "Job",
            "metadata": {"name": "database-inventory", "namespace": namespace, "labels": labels},
            "spec": {"backoffLimit": 0, "activeDeadlineSeconds": 120, "ttlSecondsAfterFinished": 120,
                     "template": {"metadata": {"labels": labels}, "spec": {
                         "restartPolicy": "Never", "automountServiceAccountToken": False,
                         "securityContext": {"runAsNonRoot": True, "runAsUser": 999,
                                             "runAsGroup": 999, "seccompProfile": {"type": "RuntimeDefault"}},
                         "containers": [container],
                         "volumes": [{"name": "database-ca", "secret": {
                             "secretName": "database-client", "defaultMode": 0o444,
                             "items": [{"key": "ca.crt", "path": "ca.crt"}],
                         }}],
                     }}},
        })
        job_uid = job.get("metadata", {}).get("uid")
        if not isinstance(job_uid, str) or not job_uid:
            raise ProbeError("JOB_OWNERSHIP_UNCONFIRMED")
        # Create the Secret only after its owning Job exists. If the runner is
        # killed, the Job deadline and TTL garbage-collect the credential Secret.
        kubectl(["create", "-f", "-"], manifest={
            "apiVersion": "v1", "kind": "Secret", "type": "Opaque",
            "metadata": {"name": "database-client", "namespace": namespace, "labels": labels,
                         "ownerReferences": [{"apiVersion": "batch/v1", "kind": "Job",
                                              "name": "database-inventory", "uid": job_uid,
                                              "controller": True, "blockOwnerDeletion": False}]},
            "data": secret_data,
        })
        deadline = time.monotonic() + 145
        while time.monotonic() < deadline:
            job = kubectl_json(["get", "job", "database-inventory", "--namespace", namespace, "--output=json"])
            status = job.get("status", {})
            if status.get("failed", 0):
                raise ProbeError(job_failure_code(namespace))
            if status.get("succeeded", 0) == 1:
                break
            time.sleep(2)
        else:
            raise ProbeError("DATABASE_JOB_TIMEOUT")
        logs = kubectl(["logs", "job/database-inventory", "--namespace", namespace, "--container=postgres-client"])
        try:
            value = json.loads(logs)
        except (ValueError, UnicodeError):
            raise ProbeError("INVALID_DATABASE_INVENTORY") from None
        return validate_inventory(value)
    finally:
        if created_uid is not None:
            try:
                cleanup_namespace(namespace, created_uid, labels)
                state_path.unlink(missing_ok=True)
                emit("target_cleanup", "ok")
            except ProbeError:
                raise ProbeError("TARGET_CLEANUP_NOT_CONFIRMED") from None


def source_inventory() -> dict:
    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "")
    if not token:
        raise ProbeError("SUPABASE_ACCESS_TOKEN_MISSING")
    result = request_json(
        f"https://api.supabase.com/v1/projects/{SOURCE_PROJECT}/database/query", token,
        body={"query": INVENTORY_SQL, "read_only": True},
    )
    if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict):
        raise ProbeError("INVALID_SOURCE_QUERY_RESULT")
    return validate_inventory(result[0].get("inventory"))


def main() -> int:
    failed = False
    for name, probe in (("managed_database", target_inventory), ("source_database", source_inventory)):
        try:
            emit(name, "ok", inventory=probe())
        except ProbeError as error:
            emit(name, "blocked", code=str(error))
            failed = True
        except Exception:
            # Never print tracebacks containing HTTP bodies, manifests, command
            # arguments or credentials. Preserve an explicit failure outcome.
            emit(name, "blocked", code="UNEXPECTED_PREFLIGHT_FAILURE")
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    if sys.argv[1:] == ["--cleanup"]:
        sys.exit(cleanup_from_state())
    if sys.argv[1:]:
        emit("preflight", "blocked", code="UNKNOWN_ARGUMENT")
        sys.exit(1)
    sys.exit(main())
