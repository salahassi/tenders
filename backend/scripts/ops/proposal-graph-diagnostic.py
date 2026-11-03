#!/usr/bin/env python3
"""Read one exact proposal job's retained graph privately, without model calls."""
from __future__ import annotations
import argparse
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("proposal_graph_inspector", HERE / "proposal-recovery.py")
inspector = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = inspector
SPEC.loader.exec_module(inspector)
access, observer, transfer = inspector.access, inspector.observer, inspector.transfer
verify_runtime = inspector.base.verify_runtime
BUCKET = inspector.BUCKET
OWNER = "tenderdesk-proposal-graph-diagnostic"
RUNTIME_IMAGE_PATTERN = r"registry\.digitalocean\.com/tenderdesk-a6093a76/runtime@sha256:[a-f0-9]{64}"
MAX_REPORT_BYTES = 32 * 1024 * 1024


class DiagnosticError(Exception):
    pass


def validate_selection(value):
    keys = {"version", "workspace_id", "opportunity_id", "plan_id", "job_id", "expected_runtime_image"}
    if not isinstance(value, dict) or set(value) != keys or type(value["version"]) is not int or value["version"] != 1:
        raise DiagnosticError("PROPOSAL_GRAPH_SELECTION_INVALID")
    for key in ("workspace_id", "opportunity_id", "plan_id", "job_id"):
        try:
            if not isinstance(value[key], str) or str(uuid.UUID(value[key])) != value[key]:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise DiagnosticError("PROPOSAL_GRAPH_SELECTION_INVALID") from None
    if value["workspace_id"] != access.WORKSPACE or not isinstance(value["expected_runtime_image"], str) or not re.fullmatch(RUNTIME_IMAGE_PATTERN, value["expected_runtime_image"]):
        raise DiagnosticError("PROPOSAL_GRAPH_SELECTION_INVALID")
    return value


def diagnostic_sql(selection):
    validate_selection(selection)
    source = (HERE / "proposal-graph-diagnostic.sql").read_text()
    for marker, field in (("WORKSPACE", "workspace_id"), ("OPPORTUNITY", "opportunity_id"), ("PLAN", "plan_id"), ("JOB", "job_id")):
        source = source.replace("__" + marker + "__", selection[field])
    return source.replace("__MAX_REPORT_BYTES__", str(MAX_REPORT_BYTES))


def public_receipt(receipt, report_sha256=None):
    if not isinstance(receipt, dict) or type(receipt.get("version")) is not int or receipt["version"] != 1 or receipt.get("mode") != "read_only_graph_diagnostic":
        raise DiagnosticError("PROPOSAL_GRAPH_RECEIPT_INVALID")
    result = {"proposal_graph_diagnostic": "inspected", "business_mutations": 0}
    if report_sha256 is not None:
        if not isinstance(report_sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", report_sha256):
            raise DiagnosticError("PROPOSAL_GRAPH_REPORT_DIGEST_INVALID")
        result["report_sha256"] = report_sha256
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection-object", required=True)
    parser.add_argument("--selection-sha256", required=True)
    args = parser.parse_args(argv)
    directory = client = receipt = report_sha256 = None
    code = None
    try:
        source_sha = os.environ.get("GITHUB_SHA", "")
        if not re.fullmatch(r"[a-f0-9]{40}", source_sha):
            raise DiagnosticError("PROPOSAL_GRAPH_SOURCE_REVISION_INVALID")
        if not re.fullmatch(r"requests/[A-Za-z0-9][A-Za-z0-9._/-]{0,160}\.bundle", args.selection_object) or not re.fullmatch(r"[a-f0-9]{64}", args.selection_sha256):
            raise DiagnosticError("PROPOSAL_GRAPH_SELECTION_REFERENCE_INVALID")
        transfer.identity(BUCKET, args.selection_object)
        os.umask(0o077)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            directory = access.prepare_cluster()
            path = directory / "selection.json"
            transfer.download(os.environ["DIGITALOCEAN_ACCESS_TOKEN"], BUCKET, args.selection_object, path, args.selection_sha256)
            raw = transfer.read_private(path)
            if len(raw) > 8192:
                raise DiagnosticError("PROPOSAL_GRAPH_SELECTION_INVALID")
            selection = validate_selection(json.loads(raw))
            verify_runtime(selection["expected_runtime_image"])
            client = observer.Client(120)
            client.labels["app.kubernetes.io/managed-by"] = OWNER
            client.prepare()
            verify_runtime(selection["expected_runtime_image"])
            raw = access.d.sql(client.pod, diagnostic_sql(selection))
            if len(raw.encode("utf8")) > MAX_REPORT_BYTES:
                raise DiagnosticError("PROPOSAL_GRAPH_REPORT_TOO_LARGE")
            receipt = json.loads(raw)
            public_receipt(receipt)
            verify_runtime(selection["expected_runtime_image"])
            receipt["verified_runtime_image"] = selection["expected_runtime_image"]
            receipt["diagnostic_source_sha"] = source_sha
            data = json.dumps(receipt, ensure_ascii=False).encode("utf8")
            if len(data) > MAX_REPORT_BYTES:
                raise DiagnosticError("PROPOSAL_GRAPH_REPORT_TOO_LARGE")
            output = directory / "receipt.json"
            transfer.write_private(output, data)
            report_sha256 = transfer.upload(os.environ["DIGITALOCEAN_ACCESS_TOKEN"], BUCKET,
                "diagnostics/proposal-graph-" + os.environ["GITHUB_RUN_ID"] + ".bundle", output)
            public_receipt(receipt, report_sha256)
    except Exception as error:
        # Never echo a database/provider exception, even an uppercase string.
        # Its contents may include a customer's rejected report or source text.
        if isinstance(error, DiagnosticError) and str(error) in {
            "PROPOSAL_GRAPH_SELECTION_INVALID", "PROPOSAL_GRAPH_SELECTION_REFERENCE_INVALID",
            "PROPOSAL_GRAPH_REPORT_TOO_LARGE", "PROPOSAL_GRAPH_RECEIPT_INVALID", "PROPOSAL_GRAPH_REPORT_DIGEST_INVALID",
            "PROPOSAL_GRAPH_SOURCE_REVISION_INVALID",
        }:
            code = str(error)
        elif isinstance(error, inspector.base.ResumeError) and str(error) == "RESUME_RUNTIME_CHANGED":
            code = "PROPOSAL_GRAPH_RUNTIME_CHANGED"
        else:
            code = "PROPOSAL_GRAPH_DIAGNOSTIC_FAILED"
    finally:
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                if client is not None:
                    client.cleanup()
        except Exception:
            code = "PROPOSAL_GRAPH_CLIENT_CLEANUP_NOT_CONFIRMED"
        try:
            if directory is not None:
                shutil.rmtree(directory)
        except Exception:
            code = "PROPOSAL_GRAPH_RUNNER_CLEANUP_NOT_CONFIRMED"
    if code is not None:
        print(json.dumps({"proposal_graph_diagnostic": "failed", "code": code}), flush=True)
        return 1
    print(json.dumps(public_receipt(receipt, report_sha256)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
