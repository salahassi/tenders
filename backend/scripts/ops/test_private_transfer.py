"""Cryptographic and lifecycle boundaries for private migration handoff."""
from __future__ import annotations

import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("private_transfer", Path(__file__).with_name("private-transfer.py"))
transfer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = transfer
SPEC.loader.exec_module(transfer)
BUCKET = "tenderdesk-migration-a6093a76-sfo3"
OBJECT = "bootstrap/private-source.bundle"
PASSWORD = "offline-test-key-material-" + "p" * 32
KEY = transfer.SpacesKey("offlineaccess1234", "offlinesecret-" + "s" * 32)


class PrivateTransferTests(unittest.TestCase):
    def test_encryption_roundtrip_randomization_and_no_plaintext(self):
        original = b'private migration input: "password_hash":"offline-fixture"'
        first = transfer.encrypt(original, PASSWORD, BUCKET, OBJECT)
        second = transfer.encrypt(original, PASSWORD, BUCKET, OBJECT)
        self.assertNotEqual(first, second)
        self.assertNotIn(original, first)
        self.assertEqual(transfer.decrypt(first, PASSWORD, BUCKET, OBJECT), original)

    def test_authentication_rejects_other_password_object_and_modified_bytes(self):
        ciphertext = transfer.encrypt(b"offline fixture", PASSWORD, BUCKET, OBJECT)
        for changed, password, bucket, name in (
            (ciphertext, PASSWORD + "changed", BUCKET, OBJECT),
            (ciphertext, PASSWORD, BUCKET, OBJECT + "changed"),
            (ciphertext, PASSWORD, BUCKET + "changed", OBJECT),
            (ciphertext[:-1] + bytes([ciphertext[-1] ^ 1]), PASSWORD, BUCKET, OBJECT),
            (ciphertext[:len(transfer.MAGIC)] + b"x" + ciphertext[len(transfer.MAGIC)+1:], PASSWORD, BUCKET, OBJECT),
        ):
            with self.subTest(password_changed=password != PASSWORD, name=name), self.assertRaises(transfer.TransferError) as caught:
                transfer.decrypt(changed, password, bucket, name)
            self.assertEqual(str(caught.exception), "BUNDLE_AUTHENTICATION_FAILED")

    def test_invalid_envelope_and_unsafe_target_names_are_refused(self):
        for value in (b"", transfer.MAGIC, b"plain source must never be accepted", transfer.MAGIC + b"x" * 20):
            with self.subTest(value_length=len(value)), self.assertRaises(transfer.TransferError):
                transfer.decrypt(value, PASSWORD, BUCKET, OBJECT)
        for bucket, name in (("unrelated-bucket", OBJECT), (BUCKET, "../outside"),
                             (BUCKET, "nested/../outside"), (BUCKET, "https://other/"),
                             (BUCKET, "double//separator"), (BUCKET, "x?token=private")):
            with self.subTest(bucket=bucket, name=name), self.assertRaises(transfer.TransferError):
                transfer.identity(bucket, name)

    def key_api(self, calls, *, permission="read", unexpected_grants=False):
        grant = {"bucket": "" if permission == "fullaccess" else BUCKET, "permission": permission}
        def call(token, path, *, method="GET", value=None):
            calls.append((path, method, value))
            if method == "POST":
                return {"key": {"access_key": KEY.access_key, "secret_key": KEY.secret_key,
                                "grants": [] if unexpected_grants else [grant]}}
            return {}
        return call

    def test_temporary_keys_are_scoped_and_revoked_even_when_transfer_fails(self):
        calls = []
        with patch.object(transfer, "api", side_effect=self.key_api(calls)):
            with self.assertRaisesRegex(RuntimeError, "offline failure"):
                with transfer.temporary_key("offline-token", BUCKET, "read") as key:
                    self.assertEqual(key.access_key, KEY.access_key)
                    self.assertNotIn(KEY.secret_key, repr(key))
                    raise RuntimeError("offline failure")
        self.assertEqual(calls[0][2]["grants"], [{"bucket": BUCKET, "permission": "read"}])
        self.assertEqual(calls[-1], ("spaces/keys/" + KEY.access_key, "DELETE", None))

    def test_unexpected_grant_response_revokes_key_before_rejecting(self):
        calls = []
        with patch.object(transfer, "api", side_effect=self.key_api(calls, unexpected_grants=True)):
            with self.assertRaisesRegex(transfer.TransferError, "UNEXPECTED_TRANSFER_KEY_RESPONSE"):
                with transfer.temporary_key("offline-token", BUCKET, "read"):
                    self.fail("Unexpected privileges must not be used")
        self.assertEqual(calls[-1][1], "DELETE")

    def test_revoke_failure_is_not_reported_as_transfer_success(self):
        calls = []
        original = self.key_api(calls)
        def fail_revoke(token, path, **kwargs):
            if kwargs.get("method") == "DELETE":
                raise transfer.TransferError("DO_API_HTTP_403")
            return original(token, path, **kwargs)
        with patch.object(transfer, "api", side_effect=fail_revoke), self.assertRaisesRegex(transfer.TransferError, "DO_API_HTTP_403"):
            with transfer.temporary_key("offline-token", BUCKET, "read"):
                pass

    def test_fullaccess_empty_bucket_omission_matches_live_response_without_accepting_scoped_omission(self):
        calls = []
        original = self.key_api(calls, permission="fullaccess")
        def omitted_empty_bucket(token, path, **kwargs):
            result = original(token, path, **kwargs)
            if "key" in result:
                result["key"]["grants"] = [{"permission": "fullaccess"}]
            return result
        with patch.object(transfer, "api", side_effect=omitted_empty_bucket):
            with transfer.temporary_key("offline-token", BUCKET, "fullaccess"):
                pass
        self.assertEqual(calls[-1][1], "DELETE")

    def test_signature_uses_tls_private_payload_hash_and_fixed_spaces_host(self):
        request = transfer.signed_request(KEY, BUCKET, "bootstrap/a-file.bundle", "PUT", b"offline ciphertext",
                                         now=datetime.datetime(2026, 10, 26, tzinfo=datetime.timezone.utc),
                                         extra_headers={"x-amz-acl": "private"})
        self.assertEqual(request.full_url, "https://" + BUCKET + ".sfo3.digitaloceanspaces.com/bootstrap/a-file.bundle")
        headers = {k.lower(): v for k, v in request.header_items()}
        self.assertEqual(headers["x-amz-acl"], "private")
        self.assertEqual(headers["x-amz-content-sha256"], hashlib.sha256(b"offline ciphertext").hexdigest())
        self.assertIn("20261026/us-east-1/s3/aws4_request", headers["authorization"])
        self.assertNotIn(KEY.secret_key, str(request.header_items()))

    def test_private_file_guards_reject_symlinks_public_inputs_overwrite_and_public_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            source = parent / "source.bundle"
            source.write_bytes(b"offline private fixture")
            source.chmod(0o600)
            self.assertEqual(transfer.read_private(source), b"offline private fixture")
            link = parent / "link.bundle"
            link.symlink_to(source)
            with self.assertRaises(transfer.TransferError):
                transfer.read_private(link)
            source.chmod(0o644)
            with self.assertRaisesRegex(transfer.TransferError, "PRIVATE_INPUT_FILE_PERMISSIONS_REQUIRED"):
                transfer.read_private(source)
            with self.assertRaises(transfer.TransferError):
                transfer.write_private(source, b"refuse overwrite")
            target = parent / "new.bundle"
            transfer.write_private(target, b"offline")
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            parent.chmod(0o755)
            with self.assertRaisesRegex(transfer.TransferError, "PRIVATE_OUTPUT_DIRECTORY_REQUIRED"):
                transfer.write_private(parent / "public.bundle", b"offline")

    def test_download_does_not_write_on_digest_failure_and_revokes_read_key(self):
        ciphertext = transfer.encrypt(b"offline payload", PASSWORD, BUCKET, OBJECT)
        calls = []
        with patch.object(transfer, "database_password", return_value=PASSWORD), patch.object(
            transfer, "api", side_effect=self.key_api(calls)
        ), patch.object(transfer, "spaces", return_value=ciphertext), patch.object(
            transfer, "write_private"
        ) as write, self.assertRaisesRegex(transfer.TransferError, "PRIVATE_BUNDLE_SHA256_MISMATCH"):
            transfer.download("offline-token", BUCKET, OBJECT, Path("unused"), "0" * 64)
        write.assert_not_called()
        self.assertEqual(calls[-1][1], "DELETE")

    def test_bucket_creation_uses_fullaccess_only_for_new_private_bucket_then_revokes(self):
        calls, operations = [], []
        def space(key, bucket, name, method, payload=b"", **kwargs):
            operations.append((method, kwargs))
            if len(operations) == 1:
                raise transfer.TransferError("SPACES_HTTP_404")
            return b""
        with patch.object(transfer, "api", side_effect=self.key_api(calls, permission="fullaccess")), patch.object(
            transfer, "spaces", side_effect=space
        ):
            transfer.create_bucket("offline-token", BUCKET)
        self.assertEqual(calls[0][2]["grants"], [{"bucket": "", "permission": "fullaccess"}])
        self.assertEqual([method for method, _ in operations], ["HEAD", "PUT", "HEAD"])
        self.assertEqual(operations[1][1]["extra_headers"]["x-amz-acl"], "private")
        self.assertEqual(calls[-1][1], "DELETE")

    def test_bucket_creation_refuses_existing_bucket_without_altering_it(self):
        calls = []
        with patch.object(transfer, "api", side_effect=self.key_api(calls, permission="fullaccess")), patch.object(
            transfer, "spaces", return_value=b""
        ) as space, self.assertRaisesRegex(transfer.TransferError, "MIGRATION_BUCKET_ALREADY_EXISTS"):
            transfer.create_bucket("offline-token", BUCKET)
        self.assertEqual(space.call_count, 1)
        self.assertEqual(space.call_args.args[3], "HEAD")
        self.assertEqual(calls[-1][1], "DELETE")


if __name__ == "__main__":
    unittest.main()
