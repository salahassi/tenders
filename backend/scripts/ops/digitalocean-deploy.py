#!/usr/bin/env python3
"""Deploy the selected empty application and its private first-owner seed.

The public runner must never emit SQL, API bodies, credentials or resource
manifests. Production resources remain after a failed rollout for repair; only
the short-lived administrator Secret and SQL-client Pod are removed.
"""
from __future__ import annotations

import argparse
import base64
from email.utils import parseaddr
import hashlib
import hmac
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import tarfile
import time
import urllib.parse

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ASSETS = ROOT / "deploy/kubernetes"


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result


probe = module("deploy_probe", HERE / "digitalocean-preflight.py")
renderer = module("deploy_render", ASSETS / "render.py")
runner = module("deploy_runner", HERE / "digitalocean-runner.py")
NAMESPACE = "tenderdesk-dev"
DATABASE = "tenderdesk_app"
PREFIX = "tdp_app"
MARKER = {"app.kubernetes.io/managed-by": "tenderdesk-deployment"}
CORE_KEYS = {"AUTH_DB_PASSWORD", "STORAGE_DB_PASSWORD", "REST_DB_PASSWORD", "AUTH_DATABASE_URL",
             "STORAGE_DATABASE_URL", "POSTGREST_DATABASE_URL", "JWT_SECRET", "ANON_KEY", "SERVICE_KEY", "PGSSLCA"}
MAX_BUNDLE_BYTES = 16 * 1024 * 1024
MAX_MEMBER_BYTES = 5_000_000


class DeployError(Exception):
    pass


def emit(status, **safe):
    print(json.dumps({"deployment": "tenderdesk-dev", "status": status, **safe}, sort_keys=True), flush=True)


def command(arguments, *, payload=None, timeout=60):
    try:
        result = subprocess.run([os.environ["KUBECTL"], "--request-timeout=30s", *arguments],
                                input=payload, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise DeployError("KUBERNETES_COMMAND_TIMEOUT") from None
    if result.returncode:
        raise DeployError("KUBERNETES_COMMAND_FAILED")
    return result.stdout


def get(kind, name):
    value = command(["get", kind, name, "-n", NAMESPACE, "--ignore-not-found", "-o", "json"])
    return json.loads(value) if value.strip() else None


def apply(value):
    command(["apply", "--server-side", "--field-manager=tenderdesk-deployment", "-f", "-"], payload=json.dumps(value))


def apply_managed(objects):
    # Check the entire batch before replacing any existing resource. A namespace
    # marker alone does not authorize adopting another controller's objects.
    for value in objects:
        current = get(value["kind"].lower(), value["metadata"]["name"])
        if current is not None and current.get("metadata", {}).get("labels", {}).get("app.kubernetes.io/managed-by") != MARKER["app.kubernetes.io/managed-by"]:
            raise DeployError("EXISTING_APPLICATION_RESOURCE_NOT_OWNED")
    for value in objects:
        value["metadata"].setdefault("labels", {}).update(MARKER)
    apply({"apiVersion": "v1", "kind": "List", "items": objects})


def secret_rollout_revision(objects, core, runtime):
    # Kubernetes does not restart envFrom consumers when a Secret changes.
    # Only an opaque hash is put in workload metadata; credentials stay solely
    # in Secrets and in this process. The random worker/signing secrets give
    # this combined hash strong entropy even when optional settings are empty.
    revision = hashlib.sha256(json.dumps({"core": core, "runtime": runtime}, sort_keys=True,
                                         separators=(",", ":")).encode()).hexdigest()
    def uses_secret(value):
        if isinstance(value, list):
            return any(uses_secret(item) for item in value)
        if not isinstance(value, dict):
            return False
        for key, item in value.items():
            if key in {"secretRef", "secretKeyRef", "secret"} and isinstance(item, dict):
                if item.get("name", item.get("secretName")) in {"tenderdesk-core", "tenderdesk-runtime"}:
                    return True
            if uses_secret(item):
                return True
        return False
    for value in objects:
        if value.get("kind") == "Deployment" and uses_secret(value["spec"]["template"]["spec"]):
            value["spec"]["template"].setdefault("metadata", {}).setdefault("annotations", {})[
                "tenderdesk.io/secret-revision"] = revision


def metadata(name):
    return {"name": name, "namespace": NAMESPACE, "labels": MARKER}


def decode_secret(value):
    if value is None:
        return None
    if value.get("metadata", {}).get("labels", {}).get(next(iter(MARKER))) != next(iter(MARKER.values())):
        raise DeployError("EXISTING_SECRET_NOT_OWNED_BY_DEPLOYMENT")
    try:
        return {key: base64.b64decode(raw, validate=True).decode() for key, raw in value["data"].items()}
    except (KeyError, ValueError, UnicodeError):
        raise DeployError("INVALID_DEPLOYMENT_SECRET") from None


def put_secret(name, values):
    # Namespace ownership does not authorize replacing a separately provisioned
    # Secret. Refuse foreign objects, including a leftover administrator Secret.
    existing = get("secret", name)
    if existing is not None:
        decode_secret(existing)
    apply({"apiVersion": "v1", "kind": "Secret", "metadata": metadata(name), "type": "Opaque",
           "data": {key: base64.b64encode(value.encode()).decode() for key, value in values.items()}})


def token(secret, role):
    b64 = lambda value: base64.urlsafe_b64encode(value).decode().rstrip("=")
    now = int(time.time())
    head = b64(b'{"alg":"HS256","typ":"JWT"}')
    claims = b64(json.dumps({"role": role, "aud": "authenticated", "iss": "tenderdesk-self-hosted",
                             "iat": now, "exp": now + 5 * 365 * 86400}, separators=(",", ":")).encode())
    text = head + "." + claims
    return text + "." + b64(hmac.new(secret.encode(), text.encode(), hashlib.sha256).digest())


def uri(credentials, suffix, password):
    quote = lambda value: urllib.parse.quote(str(value), safe="")
    query = urllib.parse.urlencode({"sslmode": "verify-full", "sslrootcert": "/run/db-ca/ca.crt"})
    return ("postgresql://" + quote(PREFIX + suffix) + ":" + quote(password) + "@" + credentials["PGHOST"]
            + ":" + credentials["PGPORT"] + "/" + DATABASE + "?" + query)


def verify_api_key(value, secret, expected_role):
    try:
        parts = value.split(".")
        if len(parts) != 3 or any(not re.fullmatch(r"[A-Za-z0-9_-]+", part) for part in parts):
            raise ValueError
        decode = lambda part: base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))
        header, claims = json.loads(decode(parts[0])), json.loads(decode(parts[1]))
        if (not isinstance(header, dict) or header.get("alg") != "HS256"
            or not isinstance(claims, dict) or claims.get("role") != expected_role
            or claims.get("aud") != "authenticated" or claims.get("iss") != "tenderdesk-self-hosted"
            or type(claims.get("exp")) is not int or claims["exp"] <= int(time.time())):
            raise ValueError
        expected = hmac.new(secret.encode(), (parts[0] + "." + parts[1]).encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, decode(parts[2])):
            raise ValueError
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise DeployError("EXISTING_CORE_API_KEY_INVALID") from None


def core_credentials(credentials, ca):
    existing = decode_secret(get("secret", "tenderdesk-core"))
    if existing is not None:
        if set(existing) != CORE_KEYS or any(not value for value in existing.values()):
            raise DeployError("EXISTING_CORE_SECRET_INCOMPLETE")
        if not hmac.compare_digest(existing["PGSSLCA"].strip(), ca.strip()):
            raise DeployError("EXISTING_CORE_DATABASE_CA_CHANGED")
        if any(len(existing[key]) < 32 for key in ("AUTH_DB_PASSWORD", "STORAGE_DB_PASSWORD", "REST_DB_PASSWORD", "JWT_SECRET")):
            raise DeployError("EXISTING_CORE_SECRET_INCOMPLETE")
        for key, suffix, password in (("AUTH_DATABASE_URL", "_authadmin", "AUTH_DB_PASSWORD"),
                                     ("STORAGE_DATABASE_URL", "_storageadmin", "STORAGE_DB_PASSWORD"),
                                     ("POSTGREST_DATABASE_URL", "_authenticator", "REST_DB_PASSWORD")):
            try:
                parsed = urllib.parse.urlsplit(existing[key])
                valid = (parsed.scheme == "postgresql" and parsed.hostname == credentials["PGHOST"]
                         and parsed.port == int(credentials["PGPORT"]) and parsed.path == "/" + DATABASE
                         and not parsed.fragment and urllib.parse.unquote(parsed.username or "") == PREFIX + suffix
                         and urllib.parse.unquote(parsed.password or "") == existing[password]
                         and urllib.parse.parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
                         == {"sslmode": ["verify-full"], "sslrootcert": ["/run/db-ca/ca.crt"]})
            except (ValueError, TypeError):
                valid = False
            if not valid:
                raise DeployError("EXISTING_CORE_DATABASE_IDENTITY_CHANGED")
        verify_api_key(existing["ANON_KEY"], existing["JWT_SECRET"], PREFIX + "_anon")
        verify_api_key(existing["SERVICE_KEY"], existing["JWT_SECRET"], PREFIX + "_service")
        return existing
    values = {"PGSSLCA": ca, "JWT_SECRET": secrets.token_hex(32),
              **{key: secrets.token_urlsafe(36) for key in ("AUTH_DB_PASSWORD", "STORAGE_DB_PASSWORD", "REST_DB_PASSWORD")}}
    for key, suffix, password in (("AUTH_DATABASE_URL", "_authadmin", "AUTH_DB_PASSWORD"),
                                  ("STORAGE_DATABASE_URL", "_storageadmin", "STORAGE_DB_PASSWORD"),
                                  ("POSTGREST_DATABASE_URL", "_authenticator", "REST_DB_PASSWORD")):
        values[key] = uri(credentials, suffix, values[password])
    values["ANON_KEY"] = token(values["JWT_SECRET"], PREFIX + "_anon")
    values["SERVICE_KEY"] = token(values["JWT_SECRET"], PREFIX + "_service")
    put_secret("tenderdesk-core", values)
    return values


def runtime_credentials():
    values = decode_secret(get("secret", "tenderdesk-runtime")) or {}
    for key in ("APP_WORKER_SECRET", "APP_NATIVE_WORKER_SECRET"):
        values.setdefault(key, secrets.token_urlsafe(48))
        if len(values[key]) < 32 or "\x00" in values[key]:
            raise DeployError("EXISTING_RUNTIME_WORKER_SECRET_INVALID")
    for key, value in os.environ.items():
        if value and (re.fullmatch(r"APP_MODEL_[A-Z0-9_]{1,100}", key)
                      or key in {"APP_SMTP_HOST", "APP_SMTP_PORT", "APP_SMTP_USER", "APP_SMTP_PASSWORD", "APP_SMTP_FROM"}):
            values[key] = value
    if values.get("APP_SMTP_FROM"):
        sender_name, mailbox = parseaddr(values["APP_SMTP_FROM"])
        if mailbox:
            values["AUTH_SMTP_ADMIN_EMAIL"] = mailbox
            values["AUTH_SMTP_SENDER_NAME"] = sender_name or "TenderDesk"
    if "APP_COLLECTION_HOSTS" not in values:
        hosts = json.loads((ROOT / "deploy/collection-hosts.json").read_text())
        if not isinstance(hosts, list) or not hosts or not all(
            isinstance(host, str) and re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", host) for host in hosts
        ):
            raise DeployError("COLLECTION_HOST_CONFIGURATION_INVALID")
        values["APP_COLLECTION_HOSTS"] = ",".join(sorted(set(hosts)))
    put_secret("tenderdesk-runtime", values)
    return values


def verify_bundle(path, digest):
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise DeployError("PRIVATE_BUNDLE_DIGEST_MISMATCH")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as stream:
            status = os.fstat(stream.fileno())
            if not stat.S_ISREG(status.st_mode) or status.st_mode & 0o077:
                raise DeployError("PRIVATE_BUNDLE_FILE_PERMISSIONS_REQUIRED")
            if not 1 <= status.st_size <= MAX_BUNDLE_BYTES:
                raise DeployError("PRIVATE_BUNDLE_SIZE_REJECTED")
            raw = stream.read(MAX_BUNDLE_BYTES + 1)
        if len(raw) > MAX_BUNDLE_BYTES:
            raise DeployError("PRIVATE_BUNDLE_SIZE_REJECTED")
        if hashlib.sha256(raw).hexdigest() != digest:
            raise DeployError("PRIVATE_BUNDLE_DIGEST_MISMATCH")
        # Parse exactly the bytes whose digest was checked; avoid reopening a
        # replaceable path after verification and never extract onto disk.
        import io
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
            members = archive.getmembers()
            if len(members) != 3 or {member.name for member in members} != {"schema.sql", "seed.sql", "manifest.json"}:
                raise DeployError("PRIVATE_BUNDLE_CONTENTS_REJECTED")
            if any(not member.isfile() or not 1 <= member.size <= MAX_MEMBER_BYTES for member in members):
                raise DeployError("PRIVATE_BUNDLE_MEMBER_REJECTED")
            if next(member.size for member in members if member.name == "manifest.json") > 65_536:
                raise DeployError("PRIVATE_BUNDLE_MANIFEST_REJECTED")
            files = {member.name: archive.extractfile(member).read() for member in members}
        manifest = json.loads(files["manifest.json"])
    except DeployError:
        raise
    except (OSError, ValueError, UnicodeError, tarfile.TarError):
        raise DeployError("PRIVATE_BUNDLE_FORMAT_REJECTED") from None
    if (not isinstance(manifest, dict) or set(manifest) != {"database", "role_prefix", "scope", "sha256"}
        or manifest.get("database") != DATABASE or manifest.get("role_prefix") != PREFIX
        or manifest.get("scope") != "first-owner-and-configuration"):
        raise DeployError("PRIVATE_BUNDLE_SCOPE_MISMATCH")
    if (not isinstance(manifest["sha256"], dict) or set(manifest["sha256"]) != {"schema.sql", "seed.sql"}
        or any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value)
               for value in manifest["sha256"].values())):
        raise DeployError("PRIVATE_BUNDLE_MANIFEST_REJECTED")
    for name in ("schema.sql", "seed.sql"):
        if hashlib.sha256(files[name]).hexdigest() != manifest.get("sha256", {}).get(name):
            raise DeployError("PRIVATE_BUNDLE_MEMBER_DIGEST_MISMATCH")
        try:
            if "\x00" in files[name].decode("utf-8"):
                raise UnicodeError
        except UnicodeError:
            raise DeployError("PRIVATE_BUNDLE_SQL_ENCODING_REJECTED") from None
    return files, manifest


def ensure_namespace():
    current = get("namespace", NAMESPACE)
    if current is None:
        value = renderer.namespace_object(NAMESPACE)
        value["metadata"]["labels"].update(MARKER)
        apply(value)
    elif current.get("metadata", {}).get("labels", {}).get("app.kubernetes.io/managed-by") != MARKER["app.kubernetes.io/managed-by"]:
        raise DeployError("EXISTING_NAMESPACE_NOT_OWNED_BY_DEPLOYMENT")


def registry_pull_secret():
    existing = get("secret", "tenderdesk-registry")
    if existing is not None:
        decode_secret(existing)
    try:
        raw = runner.docker_credentials(write_access=False)
    except Exception:
        raise DeployError("REGISTRY_PULL_SECRET_PREPARATION_FAILED") from None
    apply({"apiVersion": "v1", "kind": "Secret", "metadata": metadata("tenderdesk-registry"),
           "type": "kubernetes.io/dockerconfigjson", "data": {".dockerconfigjson": base64.b64encode(raw).decode()}})


def restore_state(pod):
    query = """BEGIN; SET LOCAL ROLE tdp_app_owner;
SELECT to_regclass('app_private.deployment_restore_state') IS NOT NULL AS restore_state_exists
\\gset
\\if :restore_state_exists
DO $guard$ BEGIN
 IF (SELECT pg_get_userbyid(c.relowner) <> 'tdp_app_owner'
            OR obj_description(c.oid, 'pg_class') IS DISTINCT FROM 'tenderdesk-managed-kubernetes:restore-ledger:v1'
       FROM pg_class c WHERE c.oid='app_private.deployment_restore_state'::regclass)
 THEN RAISE EXCEPTION 'RESTORE_LEDGER_OWNERSHIP_REJECTED'; END IF;
END $guard$;
SELECT jsonb_build_object('stage',stage,'schema_sha256',schema_sha256,'seed_sha256',seed_sha256)
FROM app_private.deployment_restore_state WHERE singleton;
\\else
SELECT '{"stage":"absent"}';
\\endif
COMMIT;"""
    raw = sql(pod, query)
    try:
        state = json.loads(raw)
        if state == {"stage": "absent"}:
            return None
        if (not isinstance(state, dict) or set(state) != {"stage", "schema_sha256", "seed_sha256"}
            or state["stage"] not in {"schema", "seed"}
            or any(not isinstance(state[key], str) or not re.fullmatch(r"[a-f0-9]{64}", state[key])
                   for key in ("schema_sha256", "seed_sha256"))):
            raise ValueError
        return state
    except (ValueError, TypeError):
        raise DeployError("RESTORE_LEDGER_STATE_REJECTED") from None


def with_restore_checkpoint(script, stage, manifest):
    # Both reviewed generators emit one outer transaction ending in COMMIT.
    # Put the checkpoint in that transaction, never in a later Kubernetes API
    # write: interrupted runners can then distinguish completed schema/seed work.
    match = re.search(r"\bCOMMIT;\s*\Z", script)
    opening = script.lstrip()
    while opening.startswith("--"):
        opening = opening.partition("\n")[2].lstrip()
    if not match or not re.match(r"BEGIN\s*;", opening) or stage not in {"schema", "seed"}:
        raise DeployError("RESTORE_TRANSACTION_CHECKPOINT_REJECTED")
    hashes = manifest["sha256"]
    if any(not re.fullmatch(r"[a-f0-9]{64}", hashes[key]) for key in ("schema.sql", "seed.sql")):
        raise DeployError("RESTORE_TRANSACTION_CHECKPOINT_REJECTED")
    if stage == "schema":
        checkpoint = """SET LOCAL ROLE tdp_app_owner;
CREATE TABLE app_private.deployment_restore_state (
 singleton boolean PRIMARY KEY CHECK(singleton),
 stage text NOT NULL CHECK(stage IN ('schema','seed')),
 schema_sha256 text NOT NULL CHECK(schema_sha256 ~ '^[a-f0-9]{64}$'),
 seed_sha256 text NOT NULL CHECK(seed_sha256 ~ '^[a-f0-9]{64}$')
);
COMMENT ON TABLE app_private.deployment_restore_state IS 'tenderdesk-managed-kubernetes:restore-ledger:v1';
REVOKE ALL ON app_private.deployment_restore_state FROM PUBLIC, tdp_app_anon, tdp_app_authenticated;
INSERT INTO app_private.deployment_restore_state(singleton,stage,schema_sha256,seed_sha256)
VALUES(true,'schema','%s','%s');
RESET ROLE;
""" % (hashes["schema.sql"], hashes["seed.sql"])
    else:
        checkpoint = """SET LOCAL ROLE tdp_app_owner;
DO $checkpoint$ BEGIN
 UPDATE app_private.deployment_restore_state SET stage='seed'
 WHERE singleton AND stage='schema' AND schema_sha256='%s' AND seed_sha256='%s';
 IF NOT FOUND THEN RAISE EXCEPTION 'RESTORE_SEED_CHECKPOINT_REJECTED'; END IF;
END $checkpoint$;
RESET ROLE;
""" % (hashes["schema.sql"], hashes["seed.sql"])
    return script[:match.start()] + checkpoint + "COMMIT;\n"


def restore_application(pod, files, manifest):
    state = restore_state(pod)
    status = get("configmap", "database-restoration")
    expected = {"schema_sha256": manifest["sha256"]["schema.sql"], "seed_sha256": manifest["sha256"]["seed.sql"]}
    if status:
        if status.get("metadata", {}).get("labels", {}).get("app.kubernetes.io/managed-by") != MARKER["app.kubernetes.io/managed-by"]:
            raise DeployError("EXISTING_RESTORATION_MARKER_NOT_OWNED")
        if any(status.get("data", {}).get(key) != value for key, value in expected.items()):
            raise DeployError("RESTORED_DATABASE_REVISION_MISMATCH")
        if state is None or state["stage"] != "seed":
            raise DeployError("RESTORATION_MARKER_WITHOUT_DATABASE_CHECKPOINT")
    if state is not None and any(state[key] != value for key, value in expected.items()):
        raise DeployError("RESTORED_DATABASE_REVISION_MISMATCH")
    if state is None:
        sql(pod, with_restore_checkpoint(files["schema.sql"].decode(), "schema", manifest))
        emit("application_schema_restored")
        state = {**expected, "stage": "schema"}
    if state["stage"] == "schema":
        sql(pod, with_restore_checkpoint(files["seed.sql"].decode(), "seed", manifest))
        emit("first_owner_and_configuration_restored", historical_business_rows_copied=False)
    else:
        emit("existing_restoration_preserved")
    apply({"apiVersion": "v1", "kind": "ConfigMap", "metadata": metadata("database-restoration"), "data": {
        **expected, "scope": "first-owner-and-configuration", "source_revision": os.environ.get("GITHUB_SHA", "unknown")}})


def cleanup_administrator(pod):
    failed = False
    for kind, name in (("pod", pod), ("secret", "tenderdesk-migration-admin")):
        if not name:
            continue
        try:
            existing = get(kind, name)
            if existing is None:
                continue
            if existing.get("metadata", {}).get("labels", {}).get("app.kubernetes.io/managed-by") != MARKER["app.kubernetes.io/managed-by"]:
                raise DeployError("FOREIGN_ADMINISTRATOR_RESOURCE_CLEANUP_REFUSED")
            # Wait for the SQL client's termination before normal Secret removal.
            command(["delete", kind, name, "-n", NAMESPACE, "--ignore-not-found", "--wait=true", "--timeout=60s"], timeout=75)
        except Exception:
            failed = True
            emit("administrator_cleanup_failed", component="sql_client" if kind == "pod" else "administrator_secret")
    if failed:
        raise DeployError("ADMINISTRATOR_CLEANUP_NOT_CONFIRMED")
    emit("administrator_resources_removed")


def sql_pod(admin):
    put_secret("tenderdesk-migration-admin", admin)
    name = "migration-client-" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
    pod = {"apiVersion": "v1", "kind": "Pod", "metadata": metadata(name), "spec": {
        "restartPolicy": "Never", "activeDeadlineSeconds": 2400, "automountServiceAccountToken": False,
        "securityContext": {"runAsNonRoot": True, "runAsUser": 999, "runAsGroup": 999, "seccompProfile": {"type": "RuntimeDefault"}},
        "containers": [{"name": "postgres-client", "image": probe.CLIENT_IMAGE, "command": ["sleep", "2400"],
            "envFrom": [{"secretRef": {"name": "tenderdesk-migration-admin"}}],
            "env": [{"name": "PGSSLMODE", "value": "verify-full"}, {"name": "PGSSLROOTCERT", "value": "/run/db-ca/ca.crt"},
                    {"name": "PGAPPNAME", "value": "tenderdesk-deployment"}, {"name": "PGCONNECT_TIMEOUT", "value": "15"}],
            "securityContext": {"allowPrivilegeEscalation": False, "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
            "resources": {"requests": {"cpu": "25m", "memory": "32Mi"}, "limits": {"cpu": "500m", "memory": "256Mi"}},
            "volumeMounts": [{"name": "database-ca", "mountPath": "/run/db-ca", "readOnly": True}]}],
        "volumes": [{"name": "database-ca", "secret": {"secretName": "tenderdesk-core", "defaultMode": 0o444,
                                                        "items": [{"key": "PGSSLCA", "path": "ca.crt"}]}}]}}
    apply_managed([pod])
    command(["wait", "pod/" + name, "-n", NAMESPACE, "--for=condition=Ready", "--timeout=180s"], timeout=200)
    return name


def sql(pod, script, *, database=DATABASE, variables=None):
    arguments = ["exec", "-i", pod, "-n", NAMESPACE, "--", "psql", "-X", "--quiet", "--no-align", "--tuples-only",
                 "--set=ON_ERROR_STOP=1", "--set=VERBOSITY=verbose", "--dbname=" + database]
    for key, value in (variables or {}).items():
        arguments += ["--set=" + key + "=" + value]
    arguments += ["--file=-"]
    try:
        result = subprocess.run([os.environ["KUBECTL"], "--request-timeout=30s", *arguments], input=script,
                                capture_output=True, text=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired):
        raise DeployError("MIGRATION_SQL_TIMEOUT") from None
    if result.returncode:
        state = re.search(r"ERROR:\s+([A-Z0-9]{5}):", result.stderr)
        line = re.search(r"psql:<stdin>:([0-9]{1,6}):", result.stderr)
        emit("sql_failed", sqlstate=state.group(1) if state else "unknown", line=int(line.group(1)) if line else None)
        raise DeployError("MIGRATION_SQL_FAILED")
    return result.stdout.strip()


def wait_deployments(names, seconds=400):
    for name in names:
        try:
            command(["rollout", "status", "deployment/" + name, "-n", NAMESPACE, "--timeout=" + str(seconds) + "s"], timeout=seconds + 15)
        except DeployError:
            # Categories and component identifiers are safe; service logs are not.
            pods = json.loads(command(["get", "pods", "-n", NAMESPACE, "-l", "app.kubernetes.io/name=" + name, "-o", "json"]))
            reasons = sorted({item.get("state", {}).get("waiting", {}).get("reason", "unready")
                              for pod in pods.get("items", []) for item in pod.get("status", {}).get("containerStatuses", [])})
            allowed = {"ImagePullBackOff", "ErrImagePull", "CrashLoopBackOff", "ContainerCreating", "CreateContainerConfigError", "unready"}
            emit("rollout_failed", component=name, reasons=[reason for reason in reasons if reason in allowed])
            raise DeployError("APPLICATION_ROLLOUT_FAILED") from None
        emit("component_ready", component=name)


def public_url():
    supplied = os.environ.get("TENDERDESK_PUBLIC_ORIGIN", "")
    if supplied:
        return renderer.public_origin(supplied)[0]
    deadline = time.monotonic() + 480
    while time.monotonic() < deadline:
        service = get("service", "public") or {}
        for entry in service.get("status", {}).get("loadBalancer", {}).get("ingress", []):
            address = entry.get("ip", "")
            try:
                ip = ipaddress.ip_address(address)
                if ip.version == 4 and ip.is_global:
                    return "https://tenderdesk." + address + ".sslip.io"
            except ValueError:
                pass
        time.sleep(5)
    raise DeployError("PUBLIC_LOAD_BALANCER_ADDRESS_TIMEOUT")


def deploy(args):
    files, manifest = verify_bundle(args.bundle, args.sha256)
    probe.validate_cluster()
    ensure_namespace()
    registry_pull_secret()
    # Allocate the address while the private database is being prepared.
    apply_managed([renderer.public_entrypoint(NAMESPACE)[1]])
    credentials, ca = probe.target_credentials(os.environ.get("DIGITALOCEAN_ACCESS_TOKEN", ""))
    core = core_credentials(credentials, ca)
    runtime = runtime_credentials()
    admin = {**credentials, **core, "APP_DATABASE": DATABASE, "ROLE_PREFIX": PREFIX,
             "APP_WORKER_SECRET": runtime["APP_WORKER_SECRET"]}
    pod = None
    try:
        pod = "migration-client-" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
        sql_pod(admin)
        sql(pod, (ASSETS / "setup.sql").read_text(), database="defaultdb")
        emit("database_initialized")
        origin = public_url()
        configuration = {"namespace": NAMESPACE, "public_origin": origin, "role_prefix": PREFIX,
                         "publishable_key": core["ANON_KEY"], "scheduler_enabled": False,
                         "native_workers_enabled": False, "image_pull_secret": "tenderdesk-registry"}
        for name in ("runtime", "frontend", "browser", "ocr", "https"):
            value = os.environ.get("TENDERDESK_" + name.upper() + "_IMAGE", "")
            if value:
                configuration[name + "_image"] = value
        objects = renderer.build(configuration)
        secret_rollout_revision(objects, core, runtime)
        # Namespace and entrypoint are already ownership-checked above.
        apply_managed([x for x in objects if x["kind"] != "Namespace"])
        wait_deployments(["auth", "rest", "storage"])
        restore_application(pod, files, manifest)
        sql(pod, (ASSETS / "check-compatible.sql").read_text())
        emit("application_rpc_compatibility_verified")
        invitations = "BEGIN; SET LOCAL ROLE tdp_app_owner;\n" + (ROOT / "scripts/runtime/auth-invitations.sql").read_text() + "\nCOMMIT;"
        sql(pod, invitations, variables={"auth_role": PREFIX + "_authadmin"})
        adaptation = "BEGIN; SET LOCAL ROLE tdp_app_owner;\n" + (ROOT / "scripts/runtime/dispatcher.sql").read_text() + "\nCOMMIT;"
        sql(pod, adaptation, variables={"service_role": PREFIX + "_service"})
        # Store only the hash. The background relay remains disabled until the
        # application acceptance stage, and source schedules remain untouched.
        worker_hash = hashlib.sha256(runtime["APP_WORKER_SECRET"].encode()).hexdigest()
        hosts = runtime["APP_COLLECTION_HOSTS"].split(",")
        if not all(re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", host) for host in hosts):
            raise DeployError("COLLECTION_HOST_CONFIGURATION_INVALID")
        host_array = "{" + ",".join(hosts) + "}"
        configure = """BEGIN; SET LOCAL ROLE tdp_app_owner;
INSERT INTO app_private.dispatcher_settings(singleton,project_url,secret_hash,collection_hosts,enabled)
VALUES(true,'%s','%s','%s',false) ON CONFLICT(singleton) DO UPDATE SET project_url=excluded.project_url,secret_hash=excluded.secret_hash,collection_hosts=excluded.collection_hosts;
NOTIFY pgrst, 'reload schema'; COMMIT;""" % (origin, worker_hash, host_array)
        sql(pod, configure)
        wait_deployments(["gateway", "api", "worker", "source-browser", "scheduler", "frontend", "https"])
        public = {"apiUrl": origin, "appOrigin": origin, "publishableKey": core["ANON_KEY"]}
        output = Path(os.environ["DOKS_WORKDIR"]) / "public-deployment.json"
        output.write_text(json.dumps(public) + "\n")
        output.chmod(0o600)
        if os.environ.get("GITHUB_ENV"):
            with open(os.environ["GITHUB_ENV"], "a") as stream:
                stream.write("TENDERDESK_DEPLOYED_ORIGIN=" + origin + "\n")
        emit("runtime_deployed", public_origin=origin, production_cutover_complete=False,
             provider_keys_configured=sum(1 for key, value in runtime.items() if key.endswith("_KEY") and key.startswith("APP_MODEL_") and value),
             smtp_configured=all(runtime.get(key) for key in ("APP_SMTP_HOST", "APP_SMTP_USER", "APP_SMTP_PASSWORD", "APP_SMTP_FROM")),
             source_project_deleted=False)
    finally:
        cleanup_administrator(pod)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    args = parser.parse_args()
    try:
        deploy(args)
        return 0
    except (DeployError, probe.ProbeError) as error:
        emit("blocked", code=str(error))
        return 1
    except Exception:
        emit("blocked", code="UNEXPECTED_DEPLOYMENT_FAILURE")
        return 1


if __name__ == "__main__":
    sys.exit(main())
