#!/usr/bin/env python3
"""Verify the real deployment without adding records to the Owner workspace.

The first user's temporary Auth session and private service identity stay in
memory. A nonce-named automated fixture bucket tests persistence outside the
application bucket. Only fixed check names, codes and HTTP statuses are printed.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass, field
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

NAMESPACE = "tenderdesk-dev"
PREFIX = "tdp_app"
MARKER = "tenderdesk-deployment"
BUCKET_PATTERN = r"migration-verification-[a-f0-9]{24}"
MAX_RESPONSE = 2 * 1024 * 1024
EMPTY_RESOURCES = (
    "sources", "source-runs", "opportunities", "knowledge", "jobs",
    "notifications", "audit-events", "proposals", "documents",
    "proposal-versions", "proposal-sections", "questions", "review-inputs",
    "regeneration-requests", "requirements", "fit-assessments",
    "opportunity-discovery",
)
CONFIG_RESOURCES = (
    "model-settings", "model-connections", "model-configurations",
    "model-task-routes", "model-execution-settings", "model-routing",
)


class SmokeFailure(Exception):
    def __init__(self, code: str, http_status: int | None = None):
        self.code = code
        self.http_status = http_status


def emit(status, checks, *, code=None, http_status=None, cleanup_failures=None):
    result = {"probe": "tenderdesk_production_smoke", "status": status,
              "checks": {name: True for name in checks}, "checks_passed": len(checks),
              "workspace_fixture_records_created": False, "source_project_deleted": False}
    if code:
        result["code"] = code
    if http_status is not None:
        result["http_status"] = http_status
    if cleanup_failures:
        result["cleanup_failures"] = cleanup_failures
    print(json.dumps(result, sort_keys=True), flush=True)


def kube(arguments, *, timeout=60):
    try:
        result = subprocess.run([os.environ["KUBECTL"], "--request-timeout=30s", *arguments],
                                capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise SmokeFailure("KUBERNETES_COMMAND_TIMEOUT") from None
    if result.returncode:
        raise SmokeFailure("KUBERNETES_COMMAND_FAILED")
    return result.stdout


def kube_json(kind, name):
    try:
        value = json.loads(kube(["get", kind, name, "-n", NAMESPACE, "-o", "json"]))
        if not isinstance(value, dict):
            raise ValueError
        return value
    except (ValueError, UnicodeError):
        raise SmokeFailure("KUBERNETES_RESPONSE_INVALID") from None


def origin(value):
    try:
        if not isinstance(value, str):
            raise ValueError
        parsed = urllib.parse.urlsplit(value)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.port not in (None, 443) or parsed.path not in ("", "/") or parsed.query or parsed.fragment
                or not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", parsed.hostname)
                or ".." in parsed.hostname):
            raise ValueError
        return "https://" + parsed.hostname
    except (ValueError, TypeError):
        raise SmokeFailure("PUBLIC_HTTPS_ORIGIN_INVALID") from None


def public_config(value):
    if not isinstance(value, dict) or set(value) != {"apiUrl", "publishableKey", "appOrigin"}:
        raise SmokeFailure("PUBLIC_CONFIGURATION_INVALID")
    if origin(value["apiUrl"]) != origin(value["appOrigin"]):
        raise SmokeFailure("PUBLIC_CONFIGURATION_ORIGIN_MISMATCH")
    if not isinstance(value["publishableKey"], str) or not value["publishableKey"]:
        raise SmokeFailure("PUBLIC_CONFIGURATION_KEY_MISSING")
    return {"apiUrl": origin(value["apiUrl"]), "appOrigin": origin(value["appOrigin"]),
            "publishableKey": value["publishableKey"]}


def javascript_config(raw):
    try:
        match = re.fullmatch(r"\s*window\.__TENDERDESK_CONFIG__\s*=\s*(\{.*\})\s*;?\s*", raw.decode(), re.S)
        if not match:
            raise ValueError
        return public_config(json.loads(match.group(1)))
    except (ValueError, UnicodeError):
        raise SmokeFailure("FRONTEND_CONFIGURATION_INVALID") from None


def jwt_claims(token, secret, role, issuer):
    try:
        parts = token.split(".")
        if len(parts) != 3 or any(not re.fullmatch(r"[A-Za-z0-9_-]+", part) for part in parts):
            raise ValueError
        decode = lambda part: base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))
        header, claims = json.loads(decode(parts[0])), json.loads(decode(parts[1]))
        if (not isinstance(header, dict) or header.get("alg") != "HS256" or not isinstance(claims, dict)
                or claims.get("role") != role or claims.get("aud") != "authenticated"
                or claims.get("iss") != issuer or type(claims.get("exp")) is not int
                or claims["exp"] <= time.time() + 30):
            raise ValueError
        expected = hmac.new(secret.encode(), (parts[0] + "." + parts[1]).encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, decode(parts[2])):
            raise ValueError
        return claims
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise SmokeFailure("API_IDENTITY_INVALID") from None


@dataclass(frozen=True)
class Config:
    origin: str
    anon_key: str = field(repr=False)
    service_key: str = field(repr=False)
    jwt_secret: str = field(repr=False)

    @classmethod
    def load(cls):
        # Reuse the existing strict cluster-endpoint/TLS transport guard.
        path = Path(__file__).with_name("digitalocean-preflight.py")
        spec = importlib.util.spec_from_file_location("smoke_preflight", path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        module.validate_cluster()
        namespace = kube_json("namespace", NAMESPACE)
        if namespace.get("metadata", {}).get("labels", {}).get("app.kubernetes.io/managed-by") != MARKER:
            raise SmokeFailure("DEPLOYMENT_NAMESPACE_NOT_OWNED")
        value = public_config(json.loads((Path(os.environ["DOKS_WORKDIR"]) / "public-deployment.json").read_text()))
        stored = kube_json("secret", "tenderdesk-core")
        if (stored.get("metadata", {}).get("namespace") != NAMESPACE
                or stored.get("metadata", {}).get("labels", {}).get("app.kubernetes.io/managed-by") != MARKER):
            raise SmokeFailure("DEPLOYMENT_SECRET_NOT_OWNED")
        try:
            selected = {name: base64.b64decode(stored["data"][name], validate=True).decode()
                        for name in ("ANON_KEY", "SERVICE_KEY", "JWT_SECRET")}
        except (KeyError, ValueError, UnicodeError):
            raise SmokeFailure("DEPLOYMENT_SECRET_INVALID") from None
        if len(selected["JWT_SECRET"]) < 32 or not hmac.compare_digest(value["publishableKey"], selected["ANON_KEY"]):
            raise SmokeFailure("PUBLIC_CONFIGURATION_KEY_MISMATCH")
        for key, suffix in (("ANON_KEY", "_anon"), ("SERVICE_KEY", "_service")):
            jwt_claims(selected[key], selected["JWT_SECRET"], PREFIX + suffix, "tenderdesk-self-hosted")
        mounted = kube_json("configmap", "frontend-config")
        if javascript_config(mounted.get("data", {}).get("runtime-config.js", "").encode()) != value:
            raise SmokeFailure("MOUNTED_PUBLIC_CONFIGURATION_MISMATCH")
        return cls(value["apiUrl"], selected["ANON_KEY"], selected["SERVICE_KEY"], selected["JWT_SECRET"])


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


@dataclass(frozen=True)
class Response:
    status: int
    body: bytes = field(repr=False)
    headers: dict = field(default_factory=dict)

    def json(self, code):
        try:
            return json.loads(self.body)
        except (ValueError, UnicodeError):
            raise SmokeFailure(code, self.status) from None


def expect(response, statuses, code):
    if response.status not in statuses:
        raise SmokeFailure(code, response.status)
    return response


class Client:
    def __init__(self, config):
        self.config = config
        # Keep the configured HTTPS proxy and CA roots. Never redirect service
        # credentials to another origin, even when a public endpoint redirects.
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ssl.create_default_context()), NoRedirect)

    def request(self, path, *, token=None, method="GET", data=None, raw=None, headers=None):
        if not path.startswith("/") or path.startswith("//") or "#" in path or "\r" in path or "\n" in path:
            raise SmokeFailure("REQUEST_PATH_INVALID")
        values = {"Accept": "application/json", "Cache-Control": "no-store", **(headers or {})}
        if token:
            values.update({"Authorization": "Bearer " + token, "apikey": self.config.anon_key})
        if data is not None:
            raw = json.dumps(data).encode()
            values["Content-Type"] = "application/json"
        request = urllib.request.Request(self.config.origin + path, data=raw, headers=values, method=method)
        try:
            with self.opener.open(request, timeout=20) as response:
                result = Response(response.status, response.read(MAX_RESPONSE + 1), dict(response.headers.items()))
        except urllib.error.HTTPError as error:
            result = Response(error.code, error.read(MAX_RESPONSE + 1), dict(error.headers.items()))
        except (OSError, urllib.error.URLError, TimeoutError):
            return Response(0, b"")
        if len(result.body) > MAX_RESPONSE:
            raise SmokeFailure("RESPONSE_SIZE_REJECTED", result.status)
        return result


class Acceptance:
    def __init__(self, config, client=None):
        self.config = config
        self.client = Client(config) if client is None else client
        self.checks = []
        self.session_token = None
        self.owner_id = None
        self.unexpected_auth_user = None
        self.bucket = "migration-verification-" + secrets.token_hex(12)
        self.bucket_attempted = False
        self.object_attempted = False
        self.object_path = "persistence-check.txt"
        self.payload = ("tenderdesk-isolated-persistence-fixture:" + secrets.token_hex(24) + "\n").encode()
        self.cleanup_failures = []

    def passed(self, name):
        self.checks.append(name)

    def public(self):
        deadline = time.monotonic() + 300
        while True:
            page = self.client.request("/")
            if page.status == 200:
                break
            if time.monotonic() >= deadline:
                raise SmokeFailure("PUBLIC_HTTPS_NOT_READY", page.status)
            time.sleep(3)
        if b"Tender Desk" not in page.body or b"runtime-config.js" not in page.body:
            raise SmokeFailure("FRONTEND_HTML_INVALID")
        loaded = expect(self.client.request("/runtime-config.js"), {200}, "FRONTEND_CONFIGURATION_UNAVAILABLE")
        expected = {"apiUrl": self.config.origin, "appOrigin": self.config.origin, "publishableKey": self.config.anon_key}
        if javascript_config(loaded.body) != expected:
            raise SmokeFailure("PUBLIC_FRONTEND_CONFIGURATION_MISMATCH")
        headers = {key.lower(): value for key, value in loaded.headers.items()}
        if "no-store" not in headers.get("cache-control", ""):
            raise SmokeFailure("PUBLIC_CONFIGURATION_CACHE_UNSAFE")
        health = expect(self.client.request("/functions/v1/api/v1/health", headers={"Origin": self.config.origin}),
                        {200}, "APPLICATION_HEALTH_FAILED").json("APPLICATION_HEALTH_INVALID")
        if health.get("data", {}).get("status") != "available":
            raise SmokeFailure("APPLICATION_HEALTH_INVALID")
        expect(self.client.request("/functions/v1/api/v1/bootstrap"), {401}, "ANONYMOUS_BOOTSTRAP_ALLOWED")
        expect(self.client.request("/auth/v1/admin/users", token=self.config.anon_key), {401, 403}, "ANONYMOUS_AUTH_ADMIN_ALLOWED")
        for path in ("worker", "source-browser"):
            expect(self.client.request("/functions/v1/" + path, method="POST", data={}),
                   {404}, "INTERNAL_WORKER_PUBLICLY_ROUTED")
        self.passed("public_https_frontend_runtime_configuration_and_application_health")
        self.passed("anonymous_application_admin_and_internal_worker_denials")

    def auth(self):
        users = expect(self.client.request("/auth/v1/admin/users?per_page=2&page=1", token=self.config.service_key),
                       {200}, "AUTH_USER_INVENTORY_FAILED").json("AUTH_USER_INVENTORY_INVALID")
        rows = users.get("users")
        if not isinstance(rows, list) or len(rows) != 1:
            raise SmokeFailure("EXPECTED_EXACTLY_ONE_MIGRATED_LOGIN")
        user = rows[0]
        try:
            user_id = str(uuid.UUID(user["id"]))
            if user.get("role") != PREFIX + "_authenticated" or not user.get("email") or not user.get("email_confirmed_at"):
                raise ValueError
        except (KeyError, ValueError, TypeError):
            raise SmokeFailure("FIRST_OWNER_AUTH_IDENTITY_INVALID") from None
        self.owner_id = user_id
        self.uninvited_signup_denied(user_id)
        link = expect(self.client.request("/auth/v1/admin/generate_link", token=self.config.service_key, method="POST",
                                         data={"type": "magiclink", "email": user["email"]}),
                      {200}, "FIRST_OWNER_TEST_LINK_FAILED").json("FIRST_OWNER_TEST_LINK_INVALID")
        token_hash = link.get("hashed_token")
        if not isinstance(token_hash, str) or not token_hash:
            raise SmokeFailure("FIRST_OWNER_TEST_LINK_INVALID")
        session = expect(self.client.request("/auth/v1/verify", token=self.config.anon_key, method="POST",
                                            data={"type": "magiclink", "token_hash": token_hash}),
                         {200}, "FIRST_OWNER_SESSION_FAILED").json("FIRST_OWNER_SESSION_INVALID")
        token = session.get("access_token")
        if not isinstance(token, str) or not token:
            raise SmokeFailure("FIRST_OWNER_SESSION_INVALID")
        # Preserve the token immediately so every later failure logs out only
        # this newly created session. No password or other session is changed.
        self.session_token = token
        claims = jwt_claims(token, self.config.jwt_secret, PREFIX + "_authenticated", self.config.origin + "/auth/v1")
        if claims.get("sub") != user_id or session.get("user", {}).get("id") != user_id:
            raise SmokeFailure("FIRST_OWNER_SESSION_IDENTITY_MISMATCH")
        account = expect(self.client.request("/auth/v1/user", token=token), {200}, "FIRST_OWNER_LOOKUP_FAILED").json("FIRST_OWNER_LOOKUP_INVALID")
        if account.get("id") != user_id:
            raise SmokeFailure("FIRST_OWNER_LOOKUP_INVALID")
        self.passed("one_preserved_owner_login_and_genuine_temporary_auth_session")
        return user_id

    def uninvited_signup_denied(self, owner_id):
        email = "migration-denied-" + secrets.token_hex(12) + "@example.invalid"
        denied = self.client.request("/auth/v1/signup", token=self.config.anon_key, method="POST",
                                     data={"email": email, "password": secrets.token_urlsafe(40) + "aA1!"})
        # A broken hook must not leave a fixture Auth account. Inspect only the
        # bounded fresh-user inventory and mark an exact nonce-email match for
        # independent cleanup; never delete the preserved Owner identity.
        users = expect(self.client.request("/auth/v1/admin/users?per_page=3&page=1", token=self.config.service_key),
                       {200}, "AUTH_SIGNUP_DENIAL_INVENTORY_FAILED").json("AUTH_SIGNUP_DENIAL_INVENTORY_INVALID").get("users")
        if not isinstance(users, list):
            raise SmokeFailure("AUTH_SIGNUP_DENIAL_INVENTORY_INVALID")
        unexpected = [row for row in users if row.get("email") == email and row.get("id") != owner_id]
        if len(unexpected) == 1:
            try:
                self.unexpected_auth_user = str(uuid.UUID(unexpected[0]["id"]))
            except (ValueError, KeyError, TypeError):
                raise SmokeFailure("UNINVITED_AUTH_ACCOUNT_IDENTITY_INVALID") from None
        if len(users) != 1 or unexpected or users[0].get("id") != owner_id:
            raise SmokeFailure("UNINVITED_AUTH_ACCOUNT_CREATED")
        expect(denied, {403}, "UNINVITED_SIGNUP_NOT_BLOCKED_BY_HOOK")
        error = denied.json("UNINVITED_SIGNUP_DENIAL_INVALID")
        message = error.get("msg") or error.get("message") or ""
        if not isinstance(message, str) or "invitation" not in message.lower():
            raise SmokeFailure("UNINVITED_SIGNUP_DENIAL_NOT_INVITATION_HOOK")
        self.passed("uninvited_signup_denied_before_account_creation_or_email")

    def api(self, user_id):
        def read(resource):
            return expect(self.client.request("/functions/v1/api/v1/" + resource, token=self.session_token,
                                              headers={"Origin": self.config.origin}),
                          {200}, "AUTHENTICATED_APPLICATION_READ_FAILED").json("AUTHENTICATED_APPLICATION_RESPONSE_INVALID").get("data")
        bootstrap = read("bootstrap")
        if not isinstance(bootstrap, dict):
            raise SmokeFailure("OWNER_BOOTSTRAP_INVALID")
        membership, workspace = bootstrap.get("membership", {}), bootstrap.get("workspace", {})
        if (membership.get("role") != "Owner" or membership.get("user_id") != user_id
                or not workspace.get("id") or workspace["id"] != membership.get("workspace_id")):
            raise SmokeFailure("OWNER_WORKSPACE_MEMBERSHIP_INVALID")
        for resource in EMPTY_RESOURCES:
            value = read(resource + "?limit=2")
            if not isinstance(value, dict) or value.get("records") != [] or value.get("next_cursor") is not None:
                raise SmokeFailure("HISTORICAL_BUSINESS_DATA_NOT_EMPTY")
        for resource in CONFIG_RESOURCES:
            value = read(resource + "?limit=2")
            if not isinstance(value, dict) or not isinstance(value.get("records"), list) or not value["records"]:
                raise SmokeFailure("MIGRATED_OPERATING_CONFIGURATION_MISSING")
        for resource in ("status", "model-catalog-status", "model-environment", "notification-settings"):
            if not isinstance(read(resource), dict):
                raise SmokeFailure("OWNER_OPERATIONAL_STATUS_INVALID")
        self.passed("real_owner_membership_application_bootstrap_and_all_frontend_lists")
        self.passed("business_history_empty_and_operating_configuration_readable")

    def restart_storage(self):
        value = kube_json("deployment", "storage")
        meta, spec = value.get("metadata", {}), value.get("spec", {})
        template = spec.get("template", {}).get("spec", {})
        volumes = template.get("volumes", [])
        if (meta.get("namespace") != NAMESPACE or meta.get("labels", {}).get("app.kubernetes.io/part-of") != "tenderdesk"
                or meta.get("labels", {}).get("app.kubernetes.io/name") != "storage" or spec.get("replicas") != 1
                or not any(v.get("name") == "objects" and v.get("persistentVolumeClaim", {}).get("claimName") == "private-objects" for v in volumes)):
            raise SmokeFailure("STORAGE_DEPLOYMENT_IDENTITY_REJECTED")
        claim = kube_json("pvc", "private-objects")
        if (claim.get("metadata", {}).get("namespace") != NAMESPACE or claim.get("status", {}).get("phase") != "Bound"
                or claim.get("metadata", {}).get("labels", {}).get("app.kubernetes.io/part-of") != "tenderdesk"):
            raise SmokeFailure("STORAGE_PERSISTENT_CLAIM_INVALID")
        kube(["rollout", "restart", "deployment/storage", "-n", NAMESPACE])
        kube(["rollout", "status", "deployment/storage", "-n", NAMESPACE, "--timeout=360s"], timeout=380)

    def storage(self):
        if not re.fullmatch(BUCKET_PATTERN, self.bucket):
            raise SmokeFailure("FIXTURE_BUCKET_IDENTITY_REJECTED")
        c, service = self.client, self.config.service_key
        base = "/storage/v1"
        expect(c.request(base + "/bucket/" + self.bucket, token=service), {400, 404}, "FIXTURE_BUCKET_ALREADY_EXISTS")
        self.bucket_attempted = True
        expect(c.request(base + "/bucket", token=service, method="POST",
                         data={"id": self.bucket, "name": self.bucket, "public": False}),
               {200, 201}, "FIXTURE_PRIVATE_BUCKET_CREATE_FAILED")
        metadata = expect(c.request(base + "/bucket/" + self.bucket, token=service), {200}, "FIXTURE_BUCKET_LOOKUP_FAILED").json("FIXTURE_BUCKET_LOOKUP_INVALID")
        if metadata.get("id") != self.bucket or metadata.get("public") is not False:
            raise SmokeFailure("FIXTURE_BUCKET_NOT_PRIVATE")
        self.object_attempted = True
        path = base + "/object/" + self.bucket + "/" + self.object_path
        expect(c.request(path, token=service, method="POST", raw=self.payload,
                         headers={"Content-Type": "text/plain", "x-upsert": "false"}),
               {200, 201}, "FIXTURE_PRIVATE_UPLOAD_FAILED")
        private_path = base + "/object/authenticated/" + self.bucket + "/" + self.object_path
        before = expect(c.request(private_path, token=service), {200}, "FIXTURE_PRIVATE_DOWNLOAD_FAILED")
        if before.body != self.payload:
            raise SmokeFailure("FIXTURE_PRIVATE_BYTES_CHANGED")
        for path, token in ((private_path, self.config.anon_key),
                            (base + "/object/public/" + self.bucket + "/" + self.object_path, None)):
            denied = expect(c.request(path, token=token), {400, 401, 403, 404}, "FIXTURE_PRIVATE_ACCESS_NOT_DENIED")
            if denied.body == self.payload:
                raise SmokeFailure("FIXTURE_PRIVATE_BYTES_LEAKED")
        self.passed("isolated_private_fixture_upload_download_and_anonymous_public_denials")
        self.restart_storage()
        deadline = time.monotonic() + 30
        while True:
            after = c.request(private_path, token=service)
            if after.status not in {0, 502, 503} or time.monotonic() >= deadline:
                break
            time.sleep(2)
        expect(after, {200}, "PRIVATE_FILE_MISSING_AFTER_STORAGE_RESTART")
        if after.body != self.payload or hashlib.sha256(after.body).digest() != hashlib.sha256(self.payload).digest():
            raise SmokeFailure("PRIVATE_FILE_CHANGED_AFTER_STORAGE_RESTART")
        self.passed("persistent_volume_retains_exact_private_bytes_across_storage_restart")

    def cleanup(self):
        if self.bucket_attempted:
            if not re.fullmatch(BUCKET_PATTERN, self.bucket):
                self.cleanup_failures.append("FIXTURE_BUCKET_CLEANUP_IDENTITY_REJECTED")
            else:
                if self.object_attempted:
                    try:
                        expect(self.client.request("/storage/v1/object/" + self.bucket, method="DELETE", token=self.config.service_key,
                                                   data={"prefixes": [self.object_path]}),
                               {200, 201}, "FIXTURE_OBJECT_CLEANUP_FAILED")
                    except Exception:
                        self.cleanup_failures.append("FIXTURE_OBJECT_CLEANUP_FAILED")
                try:
                    expect(self.client.request("/storage/v1/bucket/" + self.bucket, method="DELETE", token=self.config.service_key),
                           {200, 204, 404}, "FIXTURE_BUCKET_CLEANUP_FAILED")
                except Exception:
                    self.cleanup_failures.append("FIXTURE_BUCKET_CLEANUP_FAILED")
        if self.unexpected_auth_user:
            try:
                candidate = str(uuid.UUID(self.unexpected_auth_user))
                if candidate == self.owner_id:
                    raise ValueError
                expect(self.client.request("/auth/v1/admin/users/" + candidate, method="DELETE", token=self.config.service_key),
                       {200, 204, 404}, "UNEXPECTED_AUTH_FIXTURE_CLEANUP_FAILED")
            except Exception:
                self.cleanup_failures.append("UNEXPECTED_AUTH_FIXTURE_CLEANUP_FAILED")
        if self.session_token:
            try:
                expect(self.client.request("/auth/v1/logout?scope=local", method="POST", token=self.session_token),
                       {204}, "TEST_SESSION_LOGOUT_FAILED")
            except Exception:
                self.cleanup_failures.append("TEST_SESSION_LOGOUT_FAILED")
        if not self.cleanup_failures and (self.bucket_attempted or self.session_token or self.unexpected_auth_user):
            self.passed("isolated_fixture_cleanup_and_only_test_session_revocation")

    def run(self):
        try:
            self.public()
            user_id = self.auth()
            self.api(user_id)
            self.storage()
        finally:
            self.cleanup()
        if self.cleanup_failures:
            raise SmokeFailure("ISOLATED_TEST_CLEANUP_FAILED")


def main():
    acceptance = None
    try:
        acceptance = Acceptance(Config.load())
        acceptance.run()
        emit("passed", acceptance.checks)
        return 0
    except SmokeFailure as error:
        emit("failed", acceptance.checks if acceptance else [], code=error.code, http_status=error.http_status,
             cleanup_failures=acceptance.cleanup_failures if acceptance else None)
        return 1
    except Exception:
        emit("failed", acceptance.checks if acceptance else [], code="UNEXPECTED_SMOKE_FAILURE",
             cleanup_failures=acceptance.cleanup_failures if acceptance else None)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
