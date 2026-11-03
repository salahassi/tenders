#!/usr/bin/env python3
"""Privately inspect one exact proposal before coordinated canonical recovery.

Inspection is a database READ ONLY transaction. It cannot retry jobs, generate
content, authorize sources, reconcile usage or change workflow admission.
"""
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
SPEC = importlib.util.spec_from_file_location("proposal_recovery_base", HERE / "resume-requested-processing.py")
base = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = base
SPEC.loader.exec_module(base)
access, observer, transfer = base.access, base.observer, base.transfer
BUCKET = base.BUCKET


class RecoveryError(Exception):
    pass


def validate_selection(value):
    if not isinstance(value, dict) or set(value) != {"version", "workspace_id", "opportunity_id", "plan_id"} or type(value["version"]) is not int or value["version"] != 1:
        raise RecoveryError("PROPOSAL_SELECTION_INVALID")
    for key in ("workspace_id", "opportunity_id", "plan_id"):
        try:
            if not isinstance(value[key], str) or str(uuid.UUID(value[key])) != value[key]:
                raise ValueError()
        except (ValueError, AttributeError, TypeError):
            raise RecoveryError("PROPOSAL_SELECTION_INVALID") from None
    if value["workspace_id"] != access.WORKSPACE:
        raise RecoveryError("PROPOSAL_SELECTION_INVALID")
    return value


def inspection_sql(selection):
    validate_selection(selection)
    return (HERE / "proposal-recovery-inspect.sql").read_text().replace("__WORKSPACE__", selection["workspace_id"]).replace("__PLAN__", selection["plan_id"]).replace("__OPPORTUNITY__", selection["opportunity_id"])


def public_receipt(receipt, report_sha256=None):
    if not isinstance(receipt, dict) or receipt.get("version") != 1 or receipt.get("mode") != "read_only_inspection":
        raise RecoveryError("PROPOSAL_RECEIPT_INVALID")
    # Private errors, IDs, filenames, hashes and business state never enter logs.
    result = {"proposal_recovery": "inspected", "business_mutations": 0}
    if report_sha256 is not None:
        if not isinstance(report_sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", report_sha256):
            raise RecoveryError("PROPOSAL_REPORT_DIGEST_INVALID")
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
        if not re.fullmatch(r"requests/[A-Za-z0-9][A-Za-z0-9._/-]{0,160}\.bundle", args.selection_object) or not re.fullmatch(r"[a-f0-9]{64}", args.selection_sha256):
            raise RecoveryError("PROPOSAL_SELECTION_REFERENCE_INVALID")
        transfer.identity(BUCKET, args.selection_object)
        os.umask(0o077)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            directory = access.prepare_cluster()
            path = directory / "selection.json"
            transfer.download(os.environ["DIGITALOCEAN_ACCESS_TOKEN"], BUCKET, args.selection_object, path, args.selection_sha256)
            raw = transfer.read_private(path)
            if len(raw) > 8192:
                raise RecoveryError("PROPOSAL_SELECTION_INVALID")
            selection = validate_selection(json.loads(raw))
            client = observer.Client(120)
            client.labels["app.kubernetes.io/managed-by"] = "tenderdesk-proposal-recovery-inspector"
            client.prepare()
            receipt = json.loads(access.d.sql(client.pod, inspection_sql(selection)))
            public_receipt(receipt)
            receipt["runtime_images"] = {
                name: base.release.u.deployment(name)["spec"]["template"]["spec"]["containers"][0]["image"]
                for name in ("api", "worker")
            }
            output = directory / "receipt.json"
            transfer.write_private(output, json.dumps(receipt, ensure_ascii=False).encode())
            report_sha256 = transfer.upload(os.environ["DIGITALOCEAN_ACCESS_TOKEN"], BUCKET,
                            "diagnostics/proposal-recovery-" + os.environ["GITHUB_RUN_ID"] + ".bundle", output)
    except Exception as error:
        code = str(error) if isinstance(error, (RecoveryError, observer.ObserverError, access.TransferError,
            access.d.DeployError, access.d.probe.ProbeError, transfer.TransferError)) and re.fullmatch(r"[A-Z0-9_]{1,100}", str(error)) else "PROPOSAL_INSPECTION_FAILED"
    finally:
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                if client is not None:
                    client.cleanup()
        except Exception:
            code = "PROPOSAL_CLIENT_CLEANUP_NOT_CONFIRMED"
        try:
            if directory is not None:
                shutil.rmtree(directory)
        except Exception:
            code = "PROPOSAL_RUNNER_CLEANUP_NOT_CONFIRMED"
    if code is not None:
        print(json.dumps({"proposal_recovery": "failed", "code": code}), flush=True)
        return 1
    print(json.dumps(public_receipt(receipt, report_sha256)), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
