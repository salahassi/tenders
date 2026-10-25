#!/usr/bin/env python3
"""Move a small encrypted migration bundle through a private DigitalOcean Space.

Every invocation creates its own temporary Spaces key and revokes it in finally.
Uploads/downloads use only a grant for the selected bucket. The explicit bucket
creation action briefly needs fullaccess because Spaces does not permit bucket
creation with a scoped key. Never put the bundle, credentials or API responses in
the repository, workflow artifacts or public logs.

The AES-256-GCM key is derived from this deployment's managed database password,
a random per-object salt and the exact bucket/object identity. Both authorized
clients obtain the password independently from DigitalOcean's management API;
neither a signing key nor a presigned URL needs to be transferred through GitHub.
Password rotation before download requires re-uploading the bundle.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass, field
import datetime
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
from typing import Iterator
import urllib.error
import urllib.parse
import urllib.request


DATABASE_ID = "d08678a8-7201-4906-98bd-204978a7eec9"
REGION = "sfo3"
SIGNING_REGION = "us-east-1"
MAX_PLAINTEXT = 64 * 1024 * 1024
MAGIC = b"TENDERDESK-PRIVATE-BUNDLE\x00\x01"
SALT_LENGTH = 32
NONCE_LENGTH = 12
TAG_LENGTH = 16
MAX_CIPHERTEXT = len(MAGIC) + SALT_LENGTH + NONCE_LENGTH + MAX_PLAINTEXT + TAG_LENGTH


class TransferError(Exception):
    """Messages are fixed codes; response bodies and credentials stay private."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def identity(bucket: str, object_name: str | None = None) -> bytes:
    if not re.fullmatch(r"tenderdesk-migration-[a-z0-9][a-z0-9-]{3,42}[a-z0-9]", bucket):
        raise TransferError("MIGRATION_BUCKET_NAME_REQUIRED")
    if object_name is not None and (
        not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}", object_name)
        or any(part in {"", ".", ".."} for part in object_name.split("/"))
    ):
        raise TransferError("INVALID_MIGRATION_OBJECT_NAME")
    return ("tenderdesk-private-transfer:v1:" + bucket + ":" + (object_name or "")).encode("ascii")


def api(token: str, path: str, *, method: str = "GET", value: dict | None = None) -> dict:
    if not token or not path.startswith(("spaces/keys", "databases/")) or ".." in path:
        raise TransferError("INVALID_DIGITALOCEAN_API_REQUEST")
    body = json.dumps(value).encode() if value is not None else None
    request = urllib.request.Request(
        "https://api.digitalocean.com/v2/" + path, data=body, method=method,
        headers={"Authorization": "Bearer " + token, "Accept": "application/json",
                 "Content-Type": "application/json"},
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=40) as response:
            raw = response.read(1_048_577)
    except urllib.error.HTTPError as error:
        raise TransferError("DO_API_HTTP_" + str(error.code)) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise TransferError("DO_API_NETWORK_OR_TLS_FAILURE") from None
    if len(raw) > 1_048_576:
        raise TransferError("DO_API_RESPONSE_TOO_LARGE")
    if not raw and method == "DELETE":
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError):
        raise TransferError("DO_API_INVALID_JSON") from None
    if not isinstance(data, dict):
        raise TransferError("DO_API_INVALID_OBJECT")
    return data


def database_password(token: str) -> str:
    data = api(token, "databases/" + DATABASE_ID).get("database", {})
    try:
        if (data["id"] != DATABASE_ID or data["name"] != "tenderdesk-dev"
            or data["engine"] != "pg" or data["region"] != REGION):
            raise TransferError("UNEXPECTED_TRANSFER_DATABASE")
        password = data["private_connection"]["password"]
        if not isinstance(password, str) or not 16 <= len(password) <= 4096 or "\x00" in password:
            raise TransferError("INVALID_TRANSFER_KEY_MATERIAL")
        return password
    except (KeyError, TypeError):
        raise TransferError("TRANSFER_DATABASE_METADATA_MISSING") from None


def derive_key(password: str, salt: bytes, associated_data: bytes) -> bytes:
    # RFC5869 HKDF-SHA256; one 32-byte output block suffices for AES-256.
    if len(salt) != SALT_LENGTH:
        raise TransferError("INVALID_BUNDLE_SALT")
    prk = hmac.new(salt, password.encode("utf-8"), hashlib.sha256).digest()
    return hmac.new(prk, associated_data + b"\x01", hashlib.sha256).digest()


def aesgcm():
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        raise TransferError("PINNED_CRYPTOGRAPHY_DEPENDENCY_REQUIRED") from None
    return AESGCM


def encrypt(data: bytes, password: str, bucket: str, object_name: str) -> bytes:
    associated_data = identity(bucket, object_name)
    if not data or len(data) > MAX_PLAINTEXT:
        raise TransferError("INVALID_PRIVATE_BUNDLE_SIZE")
    salt, nonce = secrets.token_bytes(SALT_LENGTH), secrets.token_bytes(NONCE_LENGTH)
    ciphertext = aesgcm()(derive_key(password, salt, associated_data)).encrypt(nonce, data, associated_data)
    return MAGIC + salt + nonce + ciphertext


def decrypt(data: bytes, password: str, bucket: str, object_name: str) -> bytes:
    associated_data = identity(bucket, object_name)
    minimum = len(MAGIC) + SALT_LENGTH + NONCE_LENGTH + TAG_LENGTH + 1
    if not minimum <= len(data) <= MAX_CIPHERTEXT or not data.startswith(MAGIC):
        raise TransferError("INVALID_ENCRYPTED_BUNDLE")
    offset = len(MAGIC)
    salt = data[offset:offset + SALT_LENGTH]
    nonce = data[offset + SALT_LENGTH:offset + SALT_LENGTH + NONCE_LENGTH]
    try:
        return aesgcm()(derive_key(password, salt, associated_data)).decrypt(
            nonce, data[offset + SALT_LENGTH + NONCE_LENGTH:], associated_data
        )
    except TransferError:
        raise
    except Exception:
        # Authentication failures reveal neither the bundle contents nor key.
        raise TransferError("BUNDLE_AUTHENTICATION_FAILED") from None


@dataclass(frozen=True)
class SpacesKey:
    access_key: str = field(repr=False)
    secret_key: str = field(repr=False)


@contextmanager
def temporary_key(token: str, bucket: str, permission: str) -> Iterator[SpacesKey]:
    identity(bucket)
    if permission not in {"read", "readwrite", "fullaccess"}:
        raise TransferError("INVALID_TRANSFER_KEY_PERMISSION")
    grant = {"bucket": "" if permission == "fullaccess" else bucket, "permission": permission}
    access_key = None
    try:
        result = api(token, "spaces/keys", method="POST", value={
            "name": "tenderdesk-transfer-" + secrets.token_hex(10), "grants": [grant],
        }).get("key", {})
        candidate = result.get("access_key")
        if isinstance(candidate, str) and re.fullmatch(r"[A-Za-z0-9]{8,128}", candidate):
            access_key = candidate
        secret_key = result.get("secret_key")
        actual_grants = result.get("grants")
        # The live API omits the empty bucket field for a fullaccess grant.
        if permission == "fullaccess" and actual_grants == [{"permission": "fullaccess"}]:
            actual_grants = [grant]
        if (not access_key or not isinstance(secret_key, str) or not 16 <= len(secret_key) <= 256
            or actual_grants != [grant]):
            raise TransferError("UNEXPECTED_TRANSFER_KEY_RESPONSE")
        yield SpacesKey(access_key, secret_key)
    finally:
        if access_key:
            # A revoke failure is a failed operation even after transfer succeeds.
            api(token, "spaces/keys/" + access_key, method="DELETE")


def signed_request(key: SpacesKey, bucket: str, object_name: str | None, method: str,
                   payload: bytes = b"", *, now: datetime.datetime | None = None,
                   extra_headers: dict[str, str] | None = None) -> urllib.request.Request:
    identity(bucket, object_name)
    if method not in {"GET", "HEAD", "PUT", "DELETE"}:
        raise TransferError("INVALID_SPACES_METHOD")
    now = now or datetime.datetime.now(datetime.timezone.utc)
    timestamp, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
    host = bucket + "." + REGION + ".digitaloceanspaces.com"
    path = "/" + urllib.parse.quote(object_name or "", safe="/-_.~")
    payload_hash = hashlib.sha256(payload).hexdigest()
    headers = {"host": host, "x-amz-date": timestamp, "x-amz-content-sha256": payload_hash}
    for name, value in (extra_headers or {}).items():
        if name not in {"x-amz-acl", "content-type"} or "\n" in value or "\r" in value:
            raise TransferError("INVALID_SPACES_HEADER")
        headers[name] = value
    names = sorted(headers)
    canonical_headers = "".join(name + ":" + headers[name].strip() + "\n" for name in names)
    signed_headers = ";".join(names)
    canonical_request = "\n".join((method, path, "", canonical_headers, signed_headers, payload_hash))
    scope = day + "/" + SIGNING_REGION + "/s3/aws4_request"
    string_to_sign = "AWS4-HMAC-SHA256\n" + timestamp + "\n" + scope + "\n" + hashlib.sha256(canonical_request.encode()).hexdigest()
    sign = lambda secret, value: hmac.new(secret, value.encode(), hashlib.sha256).digest()
    signing_key = sign(sign(sign(sign(("AWS4" + key.secret_key).encode(), day), SIGNING_REGION), "s3"), "aws4_request")
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
    headers["Authorization"] = ("AWS4-HMAC-SHA256 Credential=" + key.access_key + "/" + scope
                                + ", SignedHeaders=" + signed_headers + ", Signature=" + signature)
    return urllib.request.Request("https://" + host + path,
                                  data=payload if method == "PUT" else None,
                                  headers=headers, method=method)


def spaces(key: SpacesKey, bucket: str, object_name: str | None, method: str,
           payload: bytes = b"", *, extra_headers: dict[str, str] | None = None) -> bytes:
    request = signed_request(key, bucket, object_name, method, payload, extra_headers=extra_headers)
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=120) as response:
            if response.status not in {200, 201, 204}:
                raise TransferError("SPACES_UNEXPECTED_STATUS")
            raw = response.read(MAX_CIPHERTEXT + 1)
    except urllib.error.HTTPError as error:
        raise TransferError("SPACES_HTTP_" + str(error.code)) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise TransferError("SPACES_NETWORK_OR_TLS_FAILURE") from None
    if len(raw) > MAX_CIPHERTEXT:
        raise TransferError("SPACES_OBJECT_TOO_LARGE")
    return raw


def create_bucket(token: str, bucket: str) -> None:
    identity(bucket)
    payload = ('<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
               '<LocationConstraint>' + REGION + '</LocationConstraint></CreateBucketConfiguration>').encode()
    with temporary_key(token, bucket, "fullaccess") as key:
        # Never adopt or alter an existing bucket: verify absence first.
        try:
            spaces(key, bucket, None, "HEAD")
        except TransferError as error:
            if str(error) != "SPACES_HTTP_404":
                raise
        else:
            raise TransferError("MIGRATION_BUCKET_ALREADY_EXISTS")
        spaces(key, bucket, None, "PUT", payload,
               extra_headers={"x-amz-acl": "private", "content-type": "application/xml"})
        spaces(key, bucket, None, "HEAD")


def read_private(path: Path) -> bytes:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
                raise TransferError("PRIVATE_INPUT_FILE_PERMISSIONS_REQUIRED")
            if not 1 <= metadata.st_size <= MAX_PLAINTEXT:
                raise TransferError("INVALID_PRIVATE_BUNDLE_SIZE")
            data = stream.read(MAX_PLAINTEXT + 1)
    except OSError:
        raise TransferError("PRIVATE_INPUT_FILE_UNAVAILABLE") from None
    if not data or len(data) > MAX_PLAINTEXT:
        raise TransferError("INVALID_PRIVATE_BUNDLE_SIZE")
    return data


def write_private(path: Path, data: bytes) -> None:
    try:
        if not path.parent.is_dir() or stat.S_IMODE(path.parent.stat().st_mode) & 0o077:
            raise TransferError("PRIVATE_OUTPUT_DIRECTORY_REQUIRED")
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
    except OSError:
        raise TransferError("PRIVATE_OUTPUT_FILE_UNAVAILABLE") from None


def upload(token: str, bucket: str, object_name: str, path: Path) -> str:
    data = read_private(path)
    ciphertext = encrypt(data, database_password(token), bucket, object_name)
    with temporary_key(token, bucket, "readwrite") as key:
        # Read-back equality verifies the persisted bytes, not merely a PUT status.
        spaces(key, bucket, object_name, "PUT", ciphertext,
               extra_headers={"x-amz-acl": "private", "content-type": "application/octet-stream"})
        actual = spaces(key, bucket, object_name, "GET")
        if not hmac.compare_digest(ciphertext, actual):
            raise TransferError("PRIVATE_TRANSFER_READBACK_MISMATCH")
    return hashlib.sha256(data).hexdigest()


def download(token: str, bucket: str, object_name: str, path: Path,
             expected_sha256: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise TransferError("EXPECTED_BUNDLE_SHA256_REQUIRED")
    password = database_password(token)
    with temporary_key(token, bucket, "read") as key:
        ciphertext = spaces(key, bucket, object_name, "GET")
        plaintext = decrypt(ciphertext, password, bucket, object_name)
        if not hmac.compare_digest(hashlib.sha256(plaintext).hexdigest(), expected_sha256):
            raise TransferError("PRIVATE_BUNDLE_SHA256_MISMATCH")
    write_private(path, plaintext)


def delete_object(token: str, bucket: str, object_name: str) -> None:
    identity(bucket, object_name)
    with temporary_key(token, bucket, "readwrite") as key:
        spaces(key, bucket, object_name, "DELETE")
        try:
            spaces(key, bucket, object_name, "HEAD")
        except TransferError as error:
            if str(error) != "SPACES_HTTP_404":
                raise
        else:
            raise TransferError("PRIVATE_OBJECT_DELETE_NOT_CONFIRMED")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument("--create-bucket", action="store_true")
    actions.add_argument("--upload", type=Path)
    actions.add_argument("--download", type=Path)
    actions.add_argument("--delete-object", action="store_true")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--object", dest="object_name")
    parser.add_argument("--expected-sha256")
    args = parser.parse_args()
    try:
        token = os.environ.get("DIGITALOCEAN_ACCESS_TOKEN", "")
        if not token:
            raise TransferError("DIGITALOCEAN_CREDENTIAL_REQUIRED")
        identity(args.bucket, args.object_name)
        if args.create_bucket:
            if args.object_name or args.expected_sha256:
                raise TransferError("INVALID_BUCKET_CREATION_ARGUMENTS")
            create_bucket(token, args.bucket)
            action = "bucket_created"
        else:
            if not args.object_name:
                raise TransferError("MIGRATION_OBJECT_NAME_REQUIRED")
            if args.upload:
                digest = upload(token, args.bucket, args.object_name, args.upload)
                print(json.dumps({"private_transfer": "uploaded", "sha256": digest}, sort_keys=True))
                return 0
            if args.download:
                download(token, args.bucket, args.object_name, args.download, args.expected_sha256 or "")
                action = "downloaded_and_verified"
            else:
                delete_object(token, args.bucket, args.object_name)
                action = "object_deleted"
        print(json.dumps({"private_transfer": action}, sort_keys=True))
        return 0
    except TransferError as error:
        print(json.dumps({"private_transfer": "failed", "code": str(error)}, sort_keys=True))
    except Exception:
        print(json.dumps({"private_transfer": "failed", "code": "UNEXPECTED_PRIVATE_TRANSFER_FAILURE"}, sort_keys=True))
    return 1


if __name__ == "__main__":
    sys.exit(main())
