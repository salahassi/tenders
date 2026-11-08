#!/usr/bin/env python3
"""Native checkpoint-decoder and ACL regression; synthetic records only.

The valid envelopes come from the actual ModelGraphStore.put serializer. Only
the decoder/ACL prefix of the migration is installed in an owned, network-none
PostgreSQL container. Full receipt projection and publication are separate gates.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import time
import uuid

from postgres_races import IMAGE, docker, literal


MIGRATION = "backend/supabase/migrations/20261108220203_generated_delivery_checkpoint_report_ref.sql"
FUNCTION = "app_private.model_graph_checkpoint_report_ref(jsonb)"
ROLES = ("anon", "authenticated", "service_role", "tdp_app_anon", "tdp_app_authenticated", "tdp_app_service")
REF = "aa11bb22-cc33-dd44-ee55-ff6677889900"
OTHER_REF = "00112233-4455-6677-8899-aabbccddeeff"


def serializer_fixtures(repository):
    result = subprocess.run(
        ["node", "--experimental-transform-types", "--input-type=module", "-e",
         "import {readFileSync} from 'node:fs';"
         "import {modelGraphCheckpointFixture} from './tests/backend/modelGraphCheckpointFixture.ts';"
         "const refs=JSON.parse(readFileSync(0,'utf8'));"
         "process.stdout.write(JSON.stringify(await Promise.all(refs.map((ref,i)=>modelGraphCheckpointFixture(ref,String(i+1))))));"],
        input=json.dumps([REF, OTHER_REF]), cwd=repository / "backend",
        text=True, capture_output=True, timeout=15, check=True,
    )
    fixtures = json.loads(result.stdout)
    assert len(fixtures) == 2 and all(value["checkpoint"]["type"] == "json" for value in fixtures)
    return fixtures


def malformed_envelope(text):
    """Construct negative inputs only; positive cases use the real saver above."""
    return {"type": "json", "data": base64.b64encode(text.encode()).decode()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[3]
    source = (repository / MIGRATION).read_text()
    marker = "-- Change only wire decoding"
    assert source.count(marker) == 1, "Decoder migration extraction boundary changed"
    decoder_sql = source.split(marker)[0]
    fixtures = serializer_fixtures(repository)
    valid, alternate = (item["checkpoint"] for item in fixtures)
    cases = [
        ("actual-model-graph-store-put-wire", valid, REF),
        ("actual-model-graph-store-put-alternate-ref", alternate, OTHER_REF),
        ("raw-checkpoint-rejected", {"channel_values": {"reportRef": REF}}, None),
        ("missing-envelope-type", {"data": valid["data"]}, None),
        ("missing-envelope-data", {"type": "json"}, None),
        ("unsupported-serializer", dict(valid, type="msgpack"), None),
        ("raw-fallback-in-envelope-rejected", dict(valid, channel_values={"reportRef": REF}), None),
        ("nonstring-data", {"type": "json", "data": 123}, None),
        ("invalid-base64-characters", {"type": "json", "data": "!!!!"}, None),
        ("noncanonical-padding-bits", {"type": "json", "data": "AB=="}, None),
        ("missing-base64-padding", {"type": "json", "data": "e30"}, None),
        ("invalid-utf8", {"type": "json", "data": base64.b64encode(b"\xff").decode()}, None),
        ("invalid-json", malformed_envelope("{"), None),
        ("json-scalar", malformed_envelope('"bad"'), None),
        ("channels-array", malformed_envelope('{"channel_values":[]}'), None),
        ("missing-report-ref", malformed_envelope('{"channel_values":{}}'), None),
        ("invalid-report-uuid", malformed_envelope('{"channel_values":{"reportRef":"bad"}}'), None),
        ("noncanonical-report-uuid", malformed_envelope(json.dumps({"channel_values": {"reportRef": REF.upper()}})), None),
        ("nonstring-report-ref", malformed_envelope('{"channel_values":{"reportRef":123}}'), None),
        ("json-escaped-nul", malformed_envelope('{"channel_values":{"reportRef":"' + REF + '"},"bad":"\\u0000"}'), None),
        ("json-numeric-overflow", malformed_envelope('{"channel_values":{"reportRef":"' + REF + '"},"bad":1e999999}'), None),
        ("oversized-envelope", {"type": "json", "data": "A" * 262148}, None),
        ("json-null", None, None),
    ]
    container = "tdp-checkpoint-" + uuid.uuid4().hex[:12]
    results = []

    def sql(query, check=True):
        result = docker("exec", "-i", container, "psql", "-U", "postgres", "-AtX", "-v", "ON_ERROR_STOP=1", input=query)
        if check and result.returncode:
            raise RuntimeError(result.stderr)
        return result

    try:
        started = docker("run", "--rm", "-d", "--name", container, "--network", "none",
                         "--label", "tenderdesk.synthetic-checkpoint=true", "--tmpfs", "/var/lib/postgresql/data:rw",
                         "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE)
        if started.returncode:
            raise RuntimeError(started.stderr)
        inspected = docker("inspect", "--format", "{{json .HostConfig}}", container)
        config = json.loads(inspected.stdout)
        assert config["NetworkMode"] == "none" and not config.get("PortBindings")
        for _ in range(100):
            # TCP is unavailable on the image's temporary initialization server.
            if docker("exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres").returncode == 0:
                break
            time.sleep(.1)
        else:
            raise RuntimeError("Isolated PostgreSQL did not become ready")
        sql("begin;create schema app_private;" + "".join("create role " + role + ";" for role in ROLES) + decoder_sql + "commit;")
        for name, value, expected in cases:
            encoded = literal(json.dumps(value, ensure_ascii=True)) + "::jsonb"
            raw = sql("select to_jsonb(app_private.model_graph_checkpoint_report_ref(" + encoded + "));").stdout.strip()
            actual = json.loads(raw) if raw else None
            assert actual == expected, (name, actual, expected)
            results.append({"case": name, "passed": True})
        for role in ROLES:
            allowed = sql("select has_function_privilege(" + literal(role) + "," + literal(FUNCTION) + ",'EXECUTE');").stdout.strip()
            assert allowed == "f", (role, allowed)
            # Grant schema visibility only in this fixture, proving denial is
            # the function's actual ACL rather than a hidden-schema side effect.
            sql("grant usage on schema app_private to " + role)
            denied = sql("set role " + role + ";select app_private.model_graph_checkpoint_report_ref(" + literal(valid) + "::jsonb);", check=False)
            assert denied.returncode and "permission denied for function model_graph_checkpoint_report_ref" in denied.stderr, (role, denied.stderr)
            results.append({"case": "execute-denied-" + role, "passed": True})
        source_paths = [MIGRATION, "backend/supabase/functions/_shared/modelGraphStore.ts",
                        "backend/tests/backend/modelGraphCheckpointFixture.ts", "backend/package-lock.json",
                        "backend/scripts/testing/generated_delivery_checkpoint.py"]
        receipt = {
            "passed": True, "scope": "native-checkpoint-decoder-and-acl", "cases": results,
            "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repository, text=True).strip(),
            "sql_sha256": hashlib.sha256(source.encode()).hexdigest(),
            "source_hashes": {path: hashlib.sha256((repository / path).read_bytes()).hexdigest() for path in source_paths},
            "serializer": "actual ModelGraphStore.put via modelGraphCheckpointFixture",
            "wire_sha256": [hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest() for item in fixtures],
            "postgres_image": IMAGE, "network": "none", "production_calls": 0, "provider_calls": 0,
            "cleanup_confirmed": False,
        }
    finally:
        docker("rm", "-f", container)
        if docker("inspect", container).returncode == 0:
            raise RuntimeError("Owned checkpoint fixture container was not removed")
    receipt["cleanup_confirmed"] = True
    if args.receipt:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"passed": True, "cases": len(results), "sql_sha256": receipt["sql_sha256"], "cleanup_confirmed": True}))


if __name__ == "__main__":
    main()
