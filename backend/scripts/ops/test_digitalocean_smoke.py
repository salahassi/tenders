import base64
import contextlib
import hashlib
import hmac
import importlib.util
import io
import json
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

path = Path(__file__).with_name("digitalocean-smoke.py")
spec = importlib.util.spec_from_file_location("smoke_under_test", path)
smoke = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = smoke
spec.loader.exec_module(smoke)


def key(role="tdp_app_anon", secret="signing-value-" * 4):
    b64 = lambda data: base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")
    a, b = b64({"alg": "HS256"}), b64({"role": role, "aud": "authenticated", "iss": "tenderdesk-self-hosted", "exp": int(time.time()) + 600})
    signature = base64.urlsafe_b64encode(hmac.new(secret.encode(), (a + "." + b).encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return a + "." + b + "." + signature


class GuardTests(unittest.TestCase):
    def config(self):
        return smoke.Config("https://app.example.test", "private-anon", "private-service", "signing-value-" * 4)

    def test_origin_refuses_credentials_queries_insecure_and_extra_paths(self):
        for value in ("http://app.example.test", "https://user:password@app.example.test", "https://app.example.test/path",
                      "https://app.example.test/?token=secret", "https://app.example.test/#secret", None, "https://app.example.test:444"):
            with self.subTest(value=value), self.assertRaises(smoke.SmokeFailure):
                smoke.origin(value)

    def test_only_matching_anonymous_key_is_accepted(self):
        token = key()
        smoke.jwt_claims(token, "signing-value-" * 4, "tdp_app_anon", "tenderdesk-self-hosted")
        for candidate, role, secret in ((key("tdp_app_service"), "tdp_app_anon", "signing-value-" * 4),
                                        (token, "tdp_app_anon", "different-signing-key"), (token[:-4] + "AAAA", "tdp_app_anon", "signing-value-" * 4)):
            with self.subTest(role=role), self.assertRaises(smoke.SmokeFailure):
                smoke.jwt_claims(candidate, secret, role, "tenderdesk-self-hosted")

    def test_runtime_config_is_json_only_and_canonical(self):
        value = {"apiUrl": "https://app.example.test", "appOrigin": "https://app.example.test", "publishableKey": "public-key"}
        script = ("window.__TENDERDESK_CONFIG__ = " + json.dumps(value) + ";\n").encode()
        self.assertEqual(smoke.javascript_config(script), value)
        for candidate in (script + b"alert('unexpected')", b"window.__TENDERDESK_CONFIG__ = {apiUrl:'not-json'};",
                          script.replace(b'https://app.example.test', b'http://app.example.test')):
            with self.subTest(candidate=candidate), self.assertRaises(smoke.SmokeFailure):
                smoke.javascript_config(candidate)

    def test_private_values_are_absent_from_representations_and_failures(self):
        self.assertNotIn("private-service", repr(self.config()))
        self.assertNotIn("private-body", repr(smoke.Response(500, b"private-body")))
        with self.assertRaises(smoke.SmokeFailure) as caught:
            smoke.expect(smoke.Response(500, b"private-body"), {200}, "FIXED_ERROR")
        self.assertEqual(caught.exception.code, "FIXED_ERROR")
        self.assertEqual(caught.exception.http_status, 500)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            smoke.emit("failed", ["known_check"], code=caught.exception.code, http_status=500)
        self.assertNotIn("private", output.getvalue())

    def test_credentials_do_not_follow_redirects(self):
        handler = smoke.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, "redirect", {}, "https://foreign.example.test"))

    def test_storage_restart_refuses_foreign_or_ephemeral_volumes(self):
        acceptance = smoke.Acceptance(self.config(), client=object())
        foreign = {"metadata": {"namespace": "other"}, "spec": {"replicas": 1}}
        with patch.object(smoke, "kube_json", return_value=foreign), patch.object(smoke, "kube") as kubectl:
            with self.assertRaisesRegex(smoke.SmokeFailure, "STORAGE_DEPLOYMENT_IDENTITY_REJECTED"):
                acceptance.restart_storage()
            kubectl.assert_not_called()

    def test_cleanup_always_tries_bucket_and_local_logout_after_object_failure(self):
        class Client:
            def __init__(self): self.calls = []
            def request(self, path, **kwargs):
                self.calls.append((path, kwargs))
                return smoke.Response(500 if "/object/" in path else 204, b"")
        client = Client()
        acceptance = smoke.Acceptance(self.config(), client)
        acceptance.bucket_attempted = acceptance.object_attempted = True
        acceptance.session_token = "session-private"
        acceptance.cleanup()
        self.assertEqual(acceptance.cleanup_failures, ["FIXTURE_OBJECT_CLEANUP_FAILED"])
        self.assertEqual(len(client.calls), 3)
        self.assertEqual(client.calls[-1][0], "/auth/v1/logout?scope=local")
        self.assertEqual(client.calls[0][1]["data"], {"prefixes": ["persistence-check.txt"]})

    def test_cleanup_never_targets_application_bucket_or_owner_account(self):
        class Client:
            def __init__(self): self.calls = []
            def request(self, path, **kwargs):
                self.calls.append(path)
                return smoke.Response(204, b"")
        client = Client()
        acceptance = smoke.Acceptance(self.config(), client)
        acceptance.bucket = "tenderdesk-private"
        acceptance.bucket_attempted = acceptance.object_attempted = True
        acceptance.owner_id = acceptance.unexpected_auth_user = "10000000-0000-4000-8000-000000000001"
        acceptance.cleanup()
        self.assertEqual(client.calls, [])
        self.assertEqual(len(acceptance.cleanup_failures), 2)

    def test_any_main_probe_failure_still_revokes_its_session(self):
        class Client:
            def __init__(self): self.calls = []
            def request(self, path, **kwargs):
                self.calls.append(path)
                return smoke.Response(204, b"")
        client = Client()
        acceptance = smoke.Acceptance(self.config(), client)
        acceptance.session_token = "session-private"
        with patch.object(acceptance, "public", side_effect=smoke.SmokeFailure("PUBLIC_TEST_FAILURE")):
            with self.assertRaisesRegex(smoke.SmokeFailure, "PUBLIC_TEST_FAILURE"):
                acceptance.run()
        self.assertEqual(client.calls, ["/auth/v1/logout?scope=local"])


if __name__ == "__main__":
    unittest.main()
