#!/usr/bin/env python3
"""Offline canonical draft export after an accepted blocking whole review.

Synthetic accepted model records exercise SQL authority and saved content; they
are not provider qualification. No product migration or hosted mutation occurs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import legacy_review_recovery_postgres as legacy
from postgres_races import IMAGE, OWNER, PostgresFixture, docker, literal as q


COMMERCIAL = {
    "lines": [{"description": "Proposed workflow service", "quantity": None, "unit": "service",
               "rate_id": None, "period_count": None, "included_in_base": True, "charge_group": "one_time",
               "tax_category": "", "requirement_ids": [], "section_ids": ["section-1"],
               "deliverable": "Documented handover", "basis": "Proposed service; buyer confirmation is required."}],
    "tasks": [{"key": "handover", "title": "Documented handover", "predecessors": [], "role": "Consultant",
               "effort_days": None, "allocation": None, "duration_days": None,
               "basis": "Proposed delivery activity; schedule requires confirmation."}],
    "questions": [{"question": "Which prices and taxes have been approved?", "blocking_level": "finalization",
                   "requirement_ids": []}],
}
REVIEW = {"processed_requirement_ids": [], "responses": [], "findings": [
    {"severity": "blocking", "category": "Synthetic review", "detail": detail,
     "section_ids": ["section-1"], "requirement_ids": []} for detail in (
        "Confirm the quantity attribution before external use.",
        "Resolve the proposed schedule contradiction before external use.",
        "Confirm the price basis before final approval.",
        "Confirm the acceptance criteria before final approval.",
        "Confirm the support scope before final approval.",
        "Confirm the applicable tax treatment before final approval.")
]}


def case(cases, name):
    cases.append({"case": name, "passed": True})


def protected(f, x):
    state = legacy.snapshot(f, x)
    # Export scheduling legitimately increments the synthetic dispatcher counter.
    state.pop("dispatches")
    state["all_usage"] = f.value("select coalesce(jsonb_agg(to_jsonb(u) order by id),'[]') from public.provider_usage u")
    state["approvals"] = f.value("select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.approvals a")
    state["questions"] = f.value("select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.questions a")
    return state


def export_rows(f):
    return f.value("""select jsonb_build_object(
      'packages',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from public.export_packages x),
      'requests',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from public.export_requests x),
      'slots',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from public.export_package_volumes x),
      'jobs',(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from public.jobs x where type='render_export'))""")


def refused(f, x, body, code, mutation="", key=None):
    before, exports = protected(f, x), export_rows(f)
    sql = f.command_sql("export.package.prepare", body, key).replace("begin;", "begin;" + mutation, 1)
    result = f.sql(sql, check=False)
    assert result.returncode and code in result.stderr, result.stderr or result.stdout
    assert protected(f, x) == before and export_rows(f) == exports, "Refused export changed state"


def accepted_blocking_fixture(f, cases):
    original = legacy.enqueue
    def enqueue(*args, **kwargs):
        values = list(args)
        if len(values) > 5 and values[2] == "plan_commercial" and values[5] is not None:
            values[5] = COMMERCIAL
        return original(*values, **kwargs)
    legacy.enqueue = enqueue
    try:
        x = legacy.setup(f)
    finally:
        legacy.enqueue = original
    f.command("generation.retry", legacy.payload(x))
    review_job = legacy.rpc(f, "claim_backend_job_v7")
    assert review_job["type"] == "review_proposal"
    graph = legacy.retained_graphs(f, [review_job["id"]], {review_job["id"]: REVIEW})[0]
    f.sql(f"update app_private.model_graph_threads set status='accepted' where id={q(graph['thread'])}")
    legacy.rpc(f, "complete_generation_step", (review_job["id"], review_job["lease_token"], REVIEW))
    advance = legacy.rpc(f, "claim_backend_job_v7")
    assert advance["type"] == "advance_plan"
    context = legacy.rpc(f, "generation_context", (advance["id"], advance["lease_token"]))
    result = legacy.node(f, "import {nextStage} from './supabase/functions/_shared/generation.ts';"
                        "process.stdout.write(JSON.stringify(await nextStage(input)));", context)
    legacy.rpc(f, "advance_generation", (advance["id"], advance["lease_token"], result["next_stage"],
                                         result["requirements"], result["steps"], result["final_result"]))
    projection = legacy.rpc(f, "claim_backend_local_job_v7")
    assert projection["type"] == "prepare_generated_delivery"
    saved = legacy.rpc(f, "generated_delivery_context", (projection["id"], projection["lease_token"]))
    assert len(saved["accepted_receipts"]) == 32 and len(saved["sections"]) == 17
    assert saved["version"]["review_result"]["findings"] == REVIEW["findings"]
    assert saved["version"]["commercial_draft"] == {"lines": COMMERCIAL["lines"], "tasks": COMMERCIAL["tasks"], "confirmed": False}
    legacy.rpc(f, "fail_generated_delivery", (projection["id"], projection["lease_token"], "GENERATED_DELIVERY_VALIDATION_FAILED"))
    x["plan"] = f.value(f"select to_jsonb(p) from public.generation_plans p where id={q(x['plan']['id'])}")
    x["version"] = saved["version"]["id"]
    assert (x["plan"]["status"], x["plan"]["stage"]) == ("failed", "completed")
    active = f.scalar(f"select p.active_version_id from public.proposals p join public.proposal_versions v on v.proposal_id=p.id where v.id={q(x['version'])}")
    assert active == x["version"]
    case(cases, "actual-fail-transition-current-version-has32-accepted-records17sections-and6blocking-findings")
    return x, saved


def proof(f, x, saved, cases):
    body = {"proposal_version_id": x["version"], "expected_revision": saved["version"]["revision"], "mode": "draft"}
    refused(f, x, {**body, "mode": "final"}, "APPROVAL_REQUIRED")
    case(cases, "final-export-still-requires-approval-and-rollback-preserves-all-state")
    refused(f, x, {**body, "expected_revision": body["expected_revision"] + 1}, "REVISION_CONFLICT")
    case(cases, "stale-version-revision-refused-without-export-or-paid-work")
    revoked = f"update public.memberships set active=false where workspace_id={q(f.workspace)} and user_id={q(OWNER)};"
    refused(f, x, body, "ROLE_FORBIDDEN", revoked)
    case(cases, "revoked-owner-refused-and-revocation-test-rolls-back")
    stale = f"update public.documents set extraction_hash=repeat('e',64),revision=revision+1 where id={q(x['document']['id'])};"
    refused(f, x, body, "STALE_INPUT", stale)
    case(cases, "changed-source-refused-and-source-test-rolls-back")
    before, old_jobs = protected(f, x), f.value("select jsonb_agg(id order by id) from public.jobs")
    key = legacy.uid()
    package = f.command("export.package.prepare", body, key)
    assert package["mode"] == "draft" and package["status"] == "preparing"
    assert protected(f, x) == before
    new_jobs = f.value(f"select jsonb_agg(to_jsonb(j) order by id) from public.jobs j where id not in(select jsonb_array_elements_text({q(old_jobs)}::jsonb)::uuid)")
    assert len(new_jobs) == 1 and new_jobs[0]["type"] == "render_export" and new_jobs[0]["status"] == "queued"
    assert new_jobs[0]["entity_id"] == package["id"]
    assert f.scalar(f"select (deadline_at=accepted_at+interval '600 seconds')::text from public.export_packages where id={q(package['id'])}") == "true"
    case(cases, "draft-command-queues-one-local-render-only-with-normal600second-deadline")
    case(cases, "all-generation-jobs32paid-records-review-issuance-budgets-questions-and-approvals-unchanged")
    requests = f.value(f"select jsonb_agg(to_jsonb(r)) from public.export_requests r join public.export_package_volumes v on v.export_id=r.id where v.package_id={q(package['id'])}")
    assert len(requests) == 1 and requests[0]["volume"] == "combined"
    request = requests[0]
    assert request["mode"] == "draft" and request["approval_id"] is None
    assert request["snapshot"]["review_result"]["findings"] == REVIEW["findings"]
    assert request["snapshot"]["commercial_draft"] == saved["version"]["commercial_draft"]
    assert any(qn["question"] == COMMERCIAL["questions"][0]["question"] for qn in request["snapshot"]["questions"])
    rendered = legacy.node(f, "import {buildExportModel,exportParagraphs} from './supabase/functions/_shared/export.ts';"
                           "const m=buildExportModel(input);process.stdout.write(JSON.stringify({mode:m.mode,text:exportParagraphs(m).join('\\n')}));", request)
    assert rendered["mode"] == "draft" and "DRAFT — Review before external use" in rendered["text"]
    assert all(finding["detail"] in rendered["text"] for finding in REVIEW["findings"])
    # Normal assembly also materializes blocking findings as finalization
    # questions. The renderer de-duplicates identical finding text and retains
    # the stronger "Required before final approval" label on those questions.
    assert "Required before final approval" in rendered["text"]
    assert "[INPUT REQUIRED:" in rendered["text"]
    assert COMMERCIAL["questions"][0]["question"] in rendered["text"]
    case(cases, "frozen-draft-preserves6findings-null-commercial-inputs-and-unresolved-question")
    case(cases, "production-render-model-visibly-labels-draft-all6findings-and-missing-inputs")
    rows = export_rows(f)
    assert f.command("export.package.prepare", body, key) == package
    assert export_rows(f) == rows and protected(f, x) == before
    refused(f, x, {**body, "mode": "final"}, "IDEMPOTENCY_CONFLICT", key=key)
    case(cases, "same-key-replay-no-new-job-and-conflicting-body-refused")
    claimed = legacy.rpc(f, "claim_backend_local_job_v7")
    assert claimed["type"] == "render_export" and claimed["id"] == new_jobs[0]["id"]
    render_context = legacy.rpc(f, "export_render_context", (claimed["id"], claimed["lease_token"]))
    assert render_context["package"]["mode"] == "draft"
    assert render_context["volumes"][0]["request"]["snapshot"]["review_result"]["findings"] == REVIEW["findings"]
    assert protected(f, x) == before
    case(cases, "current-worker-claims-local-render-and-rechecks-authorized-blocking-draft-context")
    # No worker/model/render side effects: this proof ends at authorized context.
    return len(new_jobs), len(before["all_usage"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    f = PostgresFixture(repository=Path(__file__).resolve().parents[3])
    try:
        started = docker("run", "--rm", "-d", "--name", f.container, "--network", "none", "--cpus", "1",
                         "--label", "tenderdesk.synthetic-races=true", "--tmpfs", "/var/lib/postgresql/data:rw",
                         "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE)
        if started.returncode:
            raise RuntimeError(started.stderr)
        f.owns_container = False
        f.start()
        f.owns_container = True
        legacy.dispatcher_fixture(f)
        cases = []
        x, saved = accepted_blocking_fixture(f, cases)
        print(json.dumps({"synthetic_failed_review_fixture_ready": True}), flush=True)
        new_jobs, paid = proof(f, x, saved, cases)
        receipt = f.receipt(cases)
        receipt.update({"passed": True, "production_calls": 0, "provider_calls": 0, "cpu_limit": 1,
                        "new_local_jobs": new_jobs, "retained_synthetic_paid_records": paid,
                        "qualification": "Canonical SQL draft authority and production render-model proof only; no document bytes rendered, uploaded or downloaded.",
                        "source_hashes": {str(p.relative_to(f.repository)): hashlib.sha256(p.read_bytes()).hexdigest() for p in [
                            Path(__file__), f.repository/'backend/scripts/testing/legacy_review_recovery_postgres.py',
                            f.repository/'backend/supabase/functions/_shared/export.ts']}})
    finally:
        f.owns_container = True
        f.close()
    assert docker("inspect", f.container).returncode != 0
    receipt["cleanup_confirmed"] = True
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"passed": len(cases), "cleanup_confirmed": True}))


if __name__ == "__main__":
    main()
