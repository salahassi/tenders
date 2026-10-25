#!/usr/bin/env python3
"""HTTP acceptance against disposable Auth/PostgREST/Storage native sidecars.

Only fixed check names, status codes and aggregate results reach stdout. Tokens,
passwords, action links, response bodies and generated identities stay in memory.
The surrounding job owns cleanup of the isolated namespace, database and roles.
This is a compatibility test, never a production migration or source-data test.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass


class ProbeFailure(Exception):
    def __init__(self, code: str, http_status: int | None = None):
        self.code = code
        self.http_status = http_status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def decode_segment(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def validate_test_key(token: str, secret: str, expected_role: str) -> None:
    """Fail before network work if credentials target another role or use none."""
    try:
        header, payload, signature = token.split(".")
        if json.loads(decode_segment(header)).get("alg") != "HS256":
            raise ValueError()
        expected = hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, decode_segment(signature)):
            raise ValueError()
        claims = json.loads(decode_segment(payload))
        if claims.get("role") != expected_role or claims.get("aud") != "authenticated":
            raise ValueError()
        expiry = claims.get("exp")
        if type(expiry) not in (int, float) or expiry <= time.time() + 60:
            raise ValueError()
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise ProbeFailure("INVALID_ISOLATED_API_KEY") from None


def loopback_url(value: str, port: int) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
        if (
            parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
            or parsed.port != port or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
        ):
            raise ValueError()
        return value.rstrip("/")
    except ValueError:
        raise ProbeFailure("NON_ISOLATED_SERVICE_ENDPOINT") from None


@dataclass(frozen=True)
class Config:
    database: str
    prefix: str
    auth_url: str
    rest_url: str
    storage_url: str
    anon_key: str
    service_key: str

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        database, prefix = env.get("BOOTSTRAP_DATABASE", ""), env.get("ROLE_PREFIX", "")
        if not re.fullmatch(r"td_bootstrap_[0-9]+_[0-9]+_[0-9a-f]{8,16}", database):
            raise ProbeFailure("INVALID_ISOLATED_DATABASE")
        if not re.fullmatch(r"tdb_[0-9]{1,12}_[0-9a-f]{8,16}", prefix):
            raise ProbeFailure("INVALID_ISOLATED_ROLE_PREFIX")
        if len(database) > 63 or len(prefix + "_authenticated") > 63:
            raise ProbeFailure("INVALID_ISOLATED_IDENTIFIER_LENGTH")
        secret = env.get("JWT_SECRET", "")
        if len(secret) < 32:
            raise ProbeFailure("INVALID_ISOLATED_SIGNING_SECRET")
        anon, service = env.get("ANON_KEY", ""), env.get("SERVICE_KEY", "")
        validate_test_key(anon, secret, prefix + "_anon")
        validate_test_key(service, secret, prefix + "_service")
        return cls(
            database, prefix,
            loopback_url(env.get("AUTH_URL", "http://127.0.0.1:9999"), 9999),
            loopback_url(env.get("REST_URL", "http://127.0.0.1:3000"), 3000),
            loopback_url(env.get("STORAGE_URL", "http://127.0.0.1:5000"), 5000),
            anon, service,
        )


@dataclass(frozen=True)
class Response:
    status: int
    body: bytes

    def json(self, code: str):
        try:
            return json.loads(self.body)
        except (ValueError, UnicodeError):
            raise ProbeFailure(code, self.status) from None


class Client:
    def __init__(self):
        # Native sidecars share the loopback interface. Do not send their
        # credentials to an inherited proxy or follow a redirect elsewhere.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)

    def request(self, base, path, *, token=None, method="GET", data=None, raw=None, headers=None):
        values = {"Accept": "application/json"}
        if headers:
            values.update(headers)
        if token:
            values["Authorization"] = "Bearer " + token
            values["apikey"] = token
        if data is not None:
            raw = json.dumps(data).encode()
            values["Content-Type"] = "application/json"
        req = urllib.request.Request(base + path, data=raw, headers=values, method=method)
        try:
            with self.opener.open(req, timeout=8) as result:
                body = result.read(131073)
                status = result.status
        except urllib.error.HTTPError as error:
            body, status = error.read(131073), error.code
        except (OSError, urllib.error.URLError, TimeoutError):
            return Response(0, b"")
        if len(body) > 131072:
            raise ProbeFailure("UNEXPECTED_OVERSIZED_TEST_RESPONSE")
        return Response(status, body)


def expect(response: Response, statuses, code: str) -> Response:
    if response.status not in statuses:
        raise ProbeFailure(code, response.status)
    return response


class Acceptance:
    def __init__(self, config: Config, client=None):
        self.config = config
        self.client = Client() if client is None else client
        self.checks: list[str] = []

    def passed(self, name):
        self.checks.append(name)

    def ready(self, timeout=180):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            c, cfg = self.client, self.config
            auth = c.request(cfg.auth_url, "/health")
            storage = c.request(cfg.storage_url, "/status")
            fixture = c.request(cfg.rest_url, "/td_bootstrap_records?select=id&limit=1", token=cfg.service_key)
            if auth.status == storage.status == fixture.status == 200:
                if not isinstance(fixture.json("INVALID_REST_READINESS"), list):
                    raise ProbeFailure("INVALID_REST_READINESS")
                self.passed("services_migrated_and_fixture_ready")
                return
            time.sleep(2)
        raise ProbeFailure("SERVICES_OR_POST_MIGRATION_FIXTURE_NOT_READY")

    def auth(self):
        c, cfg = self.client, self.config
        settings = expect(c.request(cfg.auth_url, "/settings", token=cfg.anon_key), {200}, "AUTH_SETTINGS_FAILED").json("AUTH_SETTINGS_INVALID")
        if settings.get("disable_signup") is not True:
            raise ProbeFailure("PUBLIC_SIGNUP_NOT_DISABLED")
        password = secrets.token_urlsafe(40) + "aA1!"
        suffix = secrets.token_hex(8)
        denied = expect(c.request(cfg.auth_url, "/signup", method="POST", token=cfg.anon_key,
                                  data={"email": f"signup-{suffix}@example.invalid", "password": password}),
                        {400, 403, 422}, "PUBLIC_SIGNUP_NOT_REJECTED")
        if denied.json("SIGNUP_DENIAL_INVALID").get("error_code") != "signup_disabled":
            raise ProbeFailure("SIGNUP_DENIAL_NOT_SIGNUP_DISABLED")
        expect(c.request(cfg.auth_url, "/admin/users", token=cfg.anon_key), {401, 403}, "ANONYMOUS_AUTH_ADMIN_ALLOWED")
        self.passed("signup_disabled_and_admin_requires_service_identity")

        # generate_link issues a genuine invitation without sending mail. No
        # SMTP provider or external email endpoint participates in this test.
        invited = expect(c.request(cfg.auth_url, "/admin/generate_link", method="POST", token=cfg.service_key,
                                   data={"type": "invite", "email": f"invite-{suffix}@example.invalid"}),
                         {200}, "ADMIN_INVITE_GENERATION_FAILED").json("ADMIN_INVITE_INVALID")
        token_hash = invited.get("hashed_token")
        if not isinstance(token_hash, str) or not token_hash:
            raise ProbeFailure("ADMIN_INVITE_TOKEN_MISSING")
        verified = expect(c.request(cfg.auth_url, "/verify", method="POST", token=cfg.anon_key,
                                    data={"type": "invite", "token_hash": token_hash}),
                          {200}, "INVITATION_ACCEPTANCE_FAILED").json("INVITATION_SESSION_INVALID")
        user_a, token_a = self.session(verified)
        expect(c.request(cfg.auth_url, "/user", method="PUT", token=token_a, data={"password": password}),
               {200}, "INVITED_PASSWORD_SETUP_FAILED")
        login = expect(c.request(cfg.auth_url, "/token?grant_type=password", method="POST", token=cfg.anon_key,
                                 data={"email": f"invite-{suffix}@example.invalid", "password": password}),
                       {200}, "INVITED_PASSWORD_LOGIN_FAILED").json("PASSWORD_SESSION_INVALID")
        user_a_login, token_a = self.session(login)
        if user_a_login != user_a:
            raise ProbeFailure("INVITED_IDENTITY_CHANGED")
        admin_b = expect(c.request(cfg.auth_url, "/admin/users", method="POST", token=cfg.service_key,
                                   data={"email": f"admin-{suffix}@example.invalid", "password": password,
                                         "email_confirm": True, "role": cfg.prefix + "_authenticated"}),
                         {200, 201}, "ADMIN_TEST_USER_CREATE_FAILED").json("ADMIN_TEST_USER_INVALID")
        login_b = expect(c.request(cfg.auth_url, "/token?grant_type=password", method="POST", token=cfg.anon_key,
                                   data={"email": f"admin-{suffix}@example.invalid", "password": password}),
                         {200}, "SECOND_PASSWORD_LOGIN_FAILED").json("SECOND_SESSION_INVALID")
        user_b, token_b = self.session(login_b)
        if user_b == user_a or admin_b.get("id") != user_b:
            raise ProbeFailure("SECOND_IDENTITY_INVALID")
        expect(c.request(cfg.auth_url, "/user", token=token_a), {200}, "AUTH_USER_LOOKUP_FAILED")
        self.passed("admin_invitation_password_signin_and_distinct_users")
        return (user_a, token_a), (user_b, token_b)

    def session(self, value):
        try:
            user, token = value["user"], value["access_token"]
            identifier = str(uuid.UUID(user["id"]))
            if user.get("role") != self.config.prefix + "_authenticated" or not isinstance(token, str):
                raise ValueError()
            return identifier, token
        except (ValueError, TypeError, KeyError):
            raise ProbeFailure("AUTHENTICATED_SESSION_INVALID") from None

    def database_rls(self, a, b):
        c, cfg = self.client, self.config
        ids = (str(uuid.uuid4()), str(uuid.uuid4()))
        representation = {"Prefer": "return=representation"}
        for (owner, token), identifier in zip((a, b), ids):
            response = expect(c.request(cfg.rest_url, "/td_bootstrap_records", method="POST", token=token,
                                        headers=representation, data={"id": identifier, "owner_id": owner, "value": "fixture"}),
                              {201}, "AUTHENTICATED_ROW_INSERT_FAILED")
            rows = response.json("ROW_INSERT_RESPONSE_INVALID")
            if len(rows) != 1 or rows[0].get("owner_id") != owner:
                raise ProbeFailure("ROW_INSERT_OWNER_INVALID")
        for (owner, token), own_id in zip((a, b), ids):
            rows = expect(c.request(cfg.rest_url, "/td_bootstrap_records?select=id,owner_id,value", token=token),
                          {200}, "AUTHENTICATED_SELECT_FAILED").json("AUTHENTICATED_SELECT_INVALID")
            if len(rows) != 1 or rows[0].get("id") != own_id or rows[0].get("owner_id") != owner:
                raise ProbeFailure("CROSS_USER_SELECT_LEAK")
        hidden = expect(c.request(cfg.rest_url, "/td_bootstrap_records?id=eq." + ids[1], method="PATCH",
                                  token=a[1], headers=representation, data={"value": "denied"}),
                        {200}, "CROSS_USER_PATCH_RESPONSE_FAILED").json("CROSS_USER_PATCH_INVALID")
        if hidden != []:
            raise ProbeFailure("CROSS_USER_PATCH_ALLOWED")
        expect(c.request(cfg.rest_url, "/td_bootstrap_records?id=eq." + ids[0], method="PATCH", token=a[1],
                         headers=representation, data={"owner_id": b[0]}), {403}, "OWNER_REASSIGNMENT_ALLOWED")
        expect(c.request(cfg.rest_url, "/td_bootstrap_records", method="POST", token=a[1],
                         data={"owner_id": b[0], "value": "denied"}), {403}, "CROSS_USER_INSERT_ALLOWED")
        expect(c.request(cfg.rest_url, "/td_bootstrap_records?select=id", token=cfg.anon_key),
               {401, 403}, "ANONYMOUS_TABLE_SELECT_ALLOWED")
        expect(c.request(cfg.rest_url, "/td_bootstrap_records", method="POST", token=cfg.anon_key,
                         data={"owner_id": a[0], "value": "denied"}), {401, 403}, "ANONYMOUS_TABLE_WRITE_ALLOWED")
        self.passed("user_row_isolation_update_checks_and_anon_denials")
        rows = expect(c.request(cfg.rest_url, "/td_bootstrap_records?select=id,owner_id,value", token=cfg.service_key),
                      {200}, "SERVICE_OWNER_SELECT_FAILED").json("SERVICE_OWNER_SELECT_INVALID")
        if {x.get("id") for x in rows} != set(ids):
            raise ProbeFailure("SERVICE_OWNER_CANNOT_SEE_BOTH_USERS")
        updated = expect(c.request(cfg.rest_url, "/td_bootstrap_records?id=eq." + ids[1], method="PATCH",
                                   token=cfg.service_key, headers=representation, data={"value": "service-updated"}),
                         {200}, "SERVICE_OWNER_UPDATE_FAILED").json("SERVICE_OWNER_UPDATE_INVALID")
        if len(updated) != 1 or updated[0].get("value") != "service-updated":
            raise ProbeFailure("SERVICE_OWNER_UPDATE_NOT_PERSISTED")
        # Recheck the ordinary user after privileged access; no policy was relaxed.
        rows_a = expect(c.request(cfg.rest_url, "/td_bootstrap_records?select=id", token=a[1]),
                        {200}, "RLS_RECHECK_FAILED").json("RLS_RECHECK_INVALID")
        if rows_a != [{"id": ids[0]}]:
            raise ProbeFailure("RLS_NOT_PRESERVED_AFTER_SERVICE_ACCESS")
        self.passed("service_owner_access_without_relaxing_user_rls")

    def storage(self, a, b):
        c, cfg = self.client, self.config
        bucket = "td-bootstrap-private"
        created = expect(c.request(cfg.storage_url, "/bucket", method="POST", token=cfg.service_key,
                                   data={"id": bucket, "name": bucket, "public": False}),
                         {200, 201}, "PRIVATE_BUCKET_CREATE_FAILED")
        created.json("PRIVATE_BUCKET_RESPONSE_INVALID")
        metadata = expect(c.request(cfg.storage_url, "/bucket/" + bucket, token=cfg.service_key),
                          {200}, "PRIVATE_BUCKET_LOOKUP_FAILED").json("PRIVATE_BUCKET_METADATA_INVALID")
        if metadata.get("public") is not False:
            raise ProbeFailure("TEST_BUCKET_NOT_PRIVATE")
        paths = (a[0] + "/probe.txt", b[0] + "/probe.txt")
        payloads = (b"isolated-storage-fixture-A\n", b"isolated-storage-fixture-B\n")
        for (_, token), path, payload in zip((a, b), paths, payloads):
            expect(c.request(cfg.storage_url, "/object/" + bucket + "/" + path, method="POST", token=token,
                             raw=payload, headers={"Content-Type": "text/plain", "x-upsert": "false"}),
                   {200, 201}, "PRIVATE_ORIGINAL_UPLOAD_FAILED")
            own = expect(c.request(cfg.storage_url, "/object/authenticated/" + bucket + "/" + path, token=token),
                         {200}, "PRIVATE_ORIGINAL_DOWNLOAD_FAILED")
            if own.body != payload or hashlib.sha256(own.body).digest() != hashlib.sha256(payload).digest():
                raise ProbeFailure("PRIVATE_ORIGINAL_BYTES_CHANGED")
        self.passed("private_bucket_two_user_upload_download_byte_equality")
        for token in (b[1], cfg.anon_key):
            denied = expect(c.request(cfg.storage_url, "/object/authenticated/" + bucket + "/" + paths[0], token=token),
                            {400, 401, 403, 404}, "PRIVATE_ORIGINAL_CROSS_USER_READ_ALLOWED")
            if denied.body == payloads[0]:
                raise ProbeFailure("PRIVATE_ORIGINAL_BYTES_LEAKED")
        expect(c.request(cfg.storage_url, "/object/public/" + bucket + "/" + paths[0]),
               {400, 401, 403, 404}, "PRIVATE_ORIGINAL_PUBLIC_READ_ALLOWED")
        expect(c.request(cfg.storage_url, "/object/" + bucket + "/" + paths[0], method="PUT", token=b[1],
                         raw=b"denied", headers={"Content-Type": "text/plain"}),
               {400, 401, 403, 404}, "PRIVATE_ORIGINAL_CROSS_USER_UPDATE_ALLOWED")
        service = expect(c.request(cfg.storage_url, "/object/authenticated/" + bucket + "/" + paths[0], token=cfg.service_key),
                         {200}, "SERVICE_PRIVATE_ORIGINAL_READ_FAILED")
        if service.body != payloads[0]:
            raise ProbeFailure("PRIVATE_ORIGINAL_CHANGED_AFTER_DENIED_WRITE")
        self.passed("private_file_cross_user_anon_public_denials_and_service_read")

    def run(self):
        self.ready()
        a, b = self.auth()
        self.database_rls(a, b)
        self.storage(a, b)
        print(json.dumps({"probe": "bootstrap_acceptance", "status": "passed", "checks": {name: True for name in self.checks},
                          "checks_passed": len(self.checks),
                          "scope": "isolated_auth_storage_role_compatibility_only", "production_data_restored": False}), flush=True)


class GuardTests(unittest.TestCase):
    def test_only_native_sidecar_urls(self):
        self.assertEqual(loopback_url("http://127.0.0.1:9999/", 9999), "http://127.0.0.1:9999")
        for url in ("https://127.0.0.1:9999", "http://example.com:9999", "http://user:pass@127.0.0.1:9999",
                    "http://127.0.0.1:9999/redirect", "http://127.0.0.1:9999?token=secret"):
            with self.subTest(url=url), self.assertRaises(ProbeFailure):
                loopback_url(url, 9999)

    def test_response_bodies_never_become_failure_messages(self):
        with self.assertRaises(ProbeFailure) as caught:
            expect(Response(500, b"private credential"), {200}, "BOUNDED_CODE")
        self.assertEqual(caught.exception.code, "BOUNDED_CODE")
        self.assertEqual(caught.exception.http_status, 500)
        self.assertNotIn("private", str(caught.exception))

    def test_foreign_or_missing_fixture_identity_rejected(self):
        for value in ("defaultdb", "tenderdesk-dev", "td_bootstrap_1_1_xxxxxxxx"):
            with self.subTest(database=value), self.assertRaises(ProbeFailure):
                Config.from_env({"BOOTSTRAP_DATABASE": value})

    def test_none_or_bad_signed_api_key_rejected(self):
        for token in ("", "a.b.c", "eyJhbGciOiJub25lIn0.e30."):
            with self.subTest(token=token), self.assertRaises(ProbeFailure):
                validate_test_key(token, "x" * 40, "tdb_1_1234abcd_service")


def main():
    acceptance = None
    try:
        acceptance = Acceptance(Config.from_env())
        acceptance.run()
        return 0
    except ProbeFailure as error:
        result = {"probe": "bootstrap_acceptance", "status": "failed", "code": error.code,
                  "checks": {name: True for name in acceptance.checks} if acceptance else {},
                  "checks_passed": len(acceptance.checks) if acceptance else 0}
        if error.http_status is not None:
            result["http_status"] = error.http_status
        print(json.dumps(result), flush=True)
        return 1
    except Exception:
        print(json.dumps({"probe": "bootstrap_acceptance", "status": "failed", "checks": {}, "code": "UNEXPECTED_PROBE_FAILURE"}), flush=True)
        return 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        unittest.main(argv=[sys.argv[0]])
    else:
        raise SystemExit(main())
