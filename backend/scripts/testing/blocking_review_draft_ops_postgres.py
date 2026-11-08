#!/usr/bin/env python3
"""Offline actual-SQL projection proof for the bounded ordinary draft helper.

Reuses the accepted blocking-review fixture. Only the isolated database name and
operational reader role differ; command authority and all helper SQL stay exact.
No rendering, storage, auth session or network request is performed.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from unittest.mock import patch

import blocking_review_draft_export_postgres as draft
from postgres_races import IMAGE, OWNER, PostgresFixture, docker, literal as q


def load(path):
    spec = importlib.util.spec_from_file_location("native_blocking_review_draft_copy", path)
    helper = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = helper
    spec.loader.exec_module(helper)
    return helper


def run(f, x, helper, cases):
    def local(sql):
        return sql.replace("current_database()='tenderdesk_app'", "current_database()=" + q(f.database)).replace(
            "SET LOCAL ROLE tdp_app_owner", "SET LOCAL ROLE postgres")

    read_queries = []
    def read(database, sql, *, max_bytes=64 * 1024):
        read_queries.append(hashlib.sha256(sql.encode()).hexdigest())
        raw = f.sql(local(sql)).stdout.strip()
        assert len(raw.encode()) <= max_bytes
        return json.loads(raw)

    def failed_sample(target, mutation, code):
        # This isolated fault injection rolls back. Retain every real source,
        # identity, projection and validation predicate in the helper SQL.
        def changed_read(database, sql, *, max_bytes=64 * 1024):
            header = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
            assert sql.count(header) == 1
            sql = local(sql).replace(header, "BEGIN;" + mutation, 1)
            raw = f.sql(sql).stdout.strip()
            assert len(raw.encode()) <= max_bytes
            return json.loads(raw)
        before = draft.protected(f, x)
        with patch.object(helper.REQUEST, "read", side_effect=changed_read):
            try:
                helper.sample(None, target)
            except helper.DraftCopyError as error:
                assert str(error) == code, str(error)
            else:
                raise AssertionError("Changed source/currentness was accepted")
        assert draft.protected(f, x) == before

    selection = {"version": 1, "workspace_id": f.workspace, "opportunity_id": x["plan"]["opportunity_id"]}
    before = draft.protected(f, x)
    with patch.object(helper.REQUEST.auth.access, "WORKSPACE", f.workspace), \
         patch.object(helper.REQUEST, "read", side_effect=read):
        proof = helper.inspect(None, selection)
        assert proof["copy"]["version"]["blocking_finding_count"] == 6
        assert proof["copy"]["version"]["review_finding_count"] == 6
        hashes = proof["copy"]["preserved"]
        assert len(hashes) == 17 and set(hashes) == set(helper.PRESERVED)
        prepared = helper.prepare(proof)
        assert prepared["mode"] == "send"
        command = prepared["body"]["commands"][0]
        assert command == {"operation": "export.package.prepare", "input": {
            "proposal_version_id": x["version"], "expected_revision": proof["copy"]["version"]["revision"], "mode": "draft"}}
        assert prepared["command_key"] == hashlib.sha256(("batch:" + prepared["idempotency_key"] + ":1").encode()).hexdigest()
        fresh = helper.recheck(None, selection, prepared)
        assert fresh["command_key"] == prepared["command_key"]
        assert draft.protected(f, x) == before and draft.export_rows(f)["packages"] == []
        draft.case(cases, "actual-helper-inspect-prepare-recheck-are-read-only-and-bind17-history-hashes")
        package = f.command(command["operation"], command["input"], prepared["command_key"])
        accepted_id = f.scalar(local(helper.acceptance_sql(prepared)))
        assert accepted_id == package["id"]
        target = helper.verify_result(None, prepared)
        assert target["package_id"] == package["id"] and target["actor_id"] == OWNER
        assert target["preserved"] == hashes and target["failed_issuance_request_id"] == x["plan"]["issuance_request_id"]
        assert draft.protected(f, x) == before
        draft.case(cases, "actual-canonical-draft-command-and-helper-idempotency-readback-bind-exact-package")
        observed = helper.sample(None, target)
        assert observed["outcome"] == "preparing" and observed["sample"]["preserved"] == hashes
        assert observed["sample"]["findings"] == draft.REVIEW["findings"]
        receipt = helper.public_receipt(observed)
        assert receipt == {"draft_copy": "preparing", "code": None, "draft_copy_only": True,
            "generated_issuance_issued": False, "approval_granted": False, "model_calls": 0,
            "artifact_count": 0, "review_finding_count": 6, "blocking_finding_count": 6}
        assert observed["sample"]["job"]["type"] == "render_export"
        draft.case(cases, "actual-observation-sql-preserves6findings-and-does-not-claim-issued-or-approved")
        exports = draft.export_rows(f)
        existing = helper.prepare(helper.inspect(None, selection))
        assert existing["mode"] == "observe_existing" and existing["target"] == target
        assert draft.export_rows(f) == exports and draft.protected(f, x) == before
        draft.case(cases, "existing-package-discovery-is-observe-only-with-no-second-command-or-job")
        try:
            helper.recheck(None, selection, prepared)
        except helper.DraftCopyError as error:
            assert str(error) == "PROPOSAL_DRAFT_COPY_CHANGED_BEFORE_SEND"
        else:
            raise AssertionError("Stale send intent was accepted after package appeared")
        draft.case(cases, "fresh-recheck-refuses-resending-old-intent-after-package-appears")
        damaged = dict(target, preserved=dict(target["preserved"], usage="e" * 64))
        try:
            helper.sample(None, damaged)
        except helper.DraftCopyError as error:
            assert str(error) == "PROPOSAL_DRAFT_COPY_HISTORY_CHANGED"
        else:
            raise AssertionError("Changed paid-history pin was accepted")
        draft.case(cases, "helper-refuses-mismatched-paid-history-pin-without-mutation")
        for name, mutation in (
            ("source", f"update public.documents set extraction_hash=repeat('e',64) where id={q(x['document']['id'])};"),
            ("actor", f"update public.memberships set active=false where workspace_id={q(f.workspace)} and user_id={q(OWNER)};"),
            ("version", f"update public.proposal_versions set revision=revision+1 where id={q(x['version'])};"),
        ):
            failed_sample(target, mutation, "PROPOSAL_DRAFT_COPY_CURRENTNESS_FAILED")
            draft.case(cases, "actual-helper-observation-refuses-changed-" + name + "-and-fault-rolls-back")
        claimed = draft.legacy.rpc(f, "claim_backend_local_job_v7")
        assert claimed["id"] == target["job_id"] and claimed["type"] == "render_export"
        running = helper.sample(None, target, observed)
        assert running["outcome"] == "preparing" and running["sample"]["job"]["status"] == "running"
        assert running["sample"]["preserved"] == hashes and draft.protected(f, x) == before
        draft.case(cases, "actual-running-local-job-observation-keeps-all17-generation-history-pins")
    return {"read_query_sha256": sorted(set(read_queries)), "preserved_hash_count": len(hashes)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    helper_path = root / "backend/scripts/ops/proposal-draft-copy.py"
    helper_hash = hashlib.sha256(helper_path.read_bytes()).hexdigest()
    helper = load(helper_path)
    f = PostgresFixture(repository=root)
    try:
        started = docker("run", "--rm", "-d", "--name", f.container, "--network", "none", "--cpus", "1",
                         "--label", "tenderdesk.synthetic-races=true", "--tmpfs", "/var/lib/postgresql/data:rw",
                         "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE)
        if started.returncode:
            raise RuntimeError(started.stderr)
        f.owns_container = False
        f.start()
        f.owns_container = True
        draft.legacy.dispatcher_fixture(f)
        cases = []
        x, _ = draft.accepted_blocking_fixture(f, cases)
        print(json.dumps({"synthetic_draft_ops_fixture_ready": True}), flush=True)
        detail = run(f, x, helper, cases)
        assert hashlib.sha256(helper_path.read_bytes()).hexdigest() == helper_hash, "Helper changed during proof"
        receipt = f.receipt(cases)
        receipt.update({"passed": True, "production_calls": 0, "provider_calls": 0, "http_calls": 0,
                        "cpu_limit": 1, **detail,
                        "qualification": "Actual helper SQL, canonical authenticated command, immutable readback and observation proof; no render/upload/download or provider qualification.",
                        "source_hashes": {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in [
                            Path(__file__), helper_path, root / "backend/scripts/testing/blocking_review_draft_export_postgres.py",
                            root / "backend/scripts/ops/proposal-trial-request.py", root / "backend/scripts/ops/proposal-trial-observe.py",
                            root / "backend/scripts/ops/proposal-current-issuance.sql"]}})
    finally:
        f.owns_container = True
        f.close()
    assert docker("inspect", f.container).returncode != 0
    receipt["cleanup_confirmed"] = True
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"passed": len(cases), "cleanup_confirmed": True, "helper_sha256": helper_hash}))


if __name__ == "__main__":
    main()
