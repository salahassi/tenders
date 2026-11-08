#!/usr/bin/env python3
"""Offline full-schema legacy-review recovery authority and history proof.

Synthetic accepted records represent retained paid work; they are not provider
or semantic qualification. ModelGraphStore.put, normal finalization, canonical
failure/retry, real PostgreSQL roles and lock races exercise production paths.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import uuid

from postgres_races import OWNER, PostgresFixture, literal as q
from commercial_successor_postgres import dispatcher_fixture, schema_fingerprints
from legacy_review_trial_harness import run as trial_harness


def uid():
    return str(uuid.uuid4())


def compact_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def node(f, code, value):
    result = subprocess.run(["node", "--experimental-transform-types", "--input-type=module", "-e",
                             "import {readFileSync} from 'node:fs';const input=JSON.parse(readFileSync(0,'utf8'));" + code],
                            input=json.dumps(value), cwd=f.repository / "backend", text=True,
                            capture_output=True, timeout=30, check=True)
    return json.loads(result.stdout)


def rpc(f, name, args=(), actor=None):
    role = "authenticated" if actor else "service_role"
    identity = "set local request.jwt.claim.sub=" + q(actor) + ";" if actor else ""
    return f.value(f"begin;set local role {role};{identity}select coalesce(to_jsonb(public.{name}"
                   f"({','.join(q(x) for x in args)})),'null'::jsonb);commit;")


def retained_graphs(f, jobs, outputs=None):
    records = []
    for job in jobs:
        step = f.value(f"select to_jsonb(s) from public.generation_steps s where job_id={q(job)}")
        thread = hashlib.sha256(job.encode()).hexdigest()
        accepted, checked = uid(), uid()
        output = (outputs or {}).get(job, step["output"])
        report = {"checked_candidate_hash": compact_hash(output), "reviewed_all_content": True,
                  "required_ids": [], "checked_content_ids": [], "requirement_checks": [], "claims": [], "findings": []}
        records.append({"step": step, "output": output, "thread": thread, "accepted": accepted, "checked": checked, "report": report})
    packed = node(f, "import {modelGraphCheckpointFixture} from './tests/backend/modelGraphCheckpointFixture.ts';"
                    "process.stdout.write(JSON.stringify(await Promise.all(input.map(ref=>modelGraphCheckpointFixture(ref)))));",
                  [r["checked"] for r in records])
    for r, checkpoint in zip(records, packed):
        step = r["step"]
        report = {"result": r["report"], "coverage": "aggregate"}
        f.sql(f"""begin;
          insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,status,result_id,candidate_count,budget_version)
          values({q(r['thread'])},{q(f.workspace)},{q(step['job_id'])},repeat('f',64),{q(step['task'])},'committed',null,1,2);
          insert into app_private.model_graph_results(id,thread_id,result_key,value,content_hash)
          values({q(r['accepted'])},{q(r['thread'])},'accepted',{q(r['output'])}::jsonb,encode(sha256(convert_to(({q(r['output'])}::jsonb)::text,'UTF8')),'hex')),
            ({q(r['checked'])},{q(r['thread'])},'chosen-verification',{q(report)}::jsonb,encode(sha256(convert_to(({q(report)}::jsonb)::text,'UTF8')),'hex'));
          update app_private.model_graph_threads set result_id={q(r['accepted'])} where id={q(r['thread'])};
          insert into app_private.model_graph_checkpoints(thread_id,checkpoint_id,checkpoint,metadata)
          values({q(r['thread'])},'0001',{q(checkpoint['checkpoint'])}::jsonb,{q(checkpoint['metadata'])}::jsonb);
          insert into app_private.model_graph_budgets(thread_id,unit,candidates) values({q(r['thread'])},'writer',1);
          update public.jobs set checkpoint=checkpoint||jsonb_build_object('graph_thread',{q(r['thread'])}) where id={q(step['job_id'])};
          insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,
           settings_revision,reserved_input,reserved_output,state,created_by,graph_candidate_recorded)
          values({q(f.workspace)},{q(step['job_id'])},gen_random_uuid(),{q('synthetic-paid-'+step['job_id'])},'openai','synthetic-model',repeat('a',64),
           current_date,1,100,100,'settled',{q(OWNER)},true);
          commit;""")
    return records


def enqueue(f, plan, task, stage, input_value, output=None):
    job = f.scalar(f"update public.generation_plans set stage={q(stage)} where id={q(plan)};"
                   f"select app_private.enqueue_generation(p,{q(task)},{q(input_value)}::jsonb) from public.generation_plans p where id={q(plan)};")
    if output is not None:
        f.sql(f"update public.generation_steps set status='completed',output={q(output)}::jsonb where job_id={q(job)};"
              f"update public.jobs set status='succeeded' where id={q(job)};")
    return job


def setup(f):
    f.sql(f"insert into public.model_execution_settings(workspace_id,enabled,admitted_after,created_by) "
          f"values({q(f.workspace)},true,now()-interval '1 day',{q(OWNER)}) on conflict(workspace_id) do nothing")
    opportunity = f.opportunity("Configure the approval workflow and provide documented handover.")
    document = f.upload(opportunity)
    f.command("document.confirm", {"id": document["id"], "expected_revision": document["revision"]})
    plan = f.command("proposal.generate", {"id": opportunity["id"], "expected_revision": opportunity["revision"]})
    # Admission may prepare a source-only baseline snapshot. Rendering that
    # separate fixture artifact is outside this SQL recovery proof.
    f.sql("update public.jobs set status='canceled' where type='render_delivery' and status='queued'")
    p = f.value(f"select to_jsonb(p) from public.generation_plans p where id={q(plan['id'])}")
    assert p["workflow_version"] == 1
    analysis = {"requirements": [], "questions": [], "separate_volumes": False}
    f.sql(f"update public.generation_steps set status='completed',output={q(analysis)}::jsonb where plan_id={q(p['id'])};"
          f"update public.jobs set status='succeeded' where entity_id={q(p['id'])};")
    jobs = f.value(f"select jsonb_agg(job_id order by ordinal) from public.generation_steps where plan_id={q(p['id'])}")
    source = p["frozen_context"]["blocks"][0]
    while len(jobs) < 12:
        jobs.append(enqueue(f, p["id"], "analyze_chunk", "analysis", {"block_id": source["id"], "start": 0, "end": len(source["text"])}, analysis))
    sections = [{"key": f"section-{i}", "title": f"Workflow component {i}", "volume": "technical", "requirement_ids": []}
                for i in range(1, 18)]
    jobs.append(enqueue(f, p["id"], "plan_proposal", "planning", {"requirement_ids": []}, {"sections": sections, "questions": []}))
    for section in sections:
        output = {"key": section["key"], "title": section["title"],
                  "content_blocks": [{"type": "paragraph", "text": "Configure the documented workflow, verify routing and preserve the signed handover record for buyer review."}],
                  "requirement_ids": [], "evidence_refs": [], "company_claims": [], "assumptions": [], "questions": []}
        jobs.append(enqueue(f, p["id"], "draft_section", "drafting", {"section": section, "requirement_ids": [], "rfp_context_version": 1}, output))
    jobs.append(enqueue(f, p["id"], "plan_commercial", "commercial", {"requirement_ids": []}, {"lines": [], "tasks": [], "questions": []}))
    assert len(jobs) == 31
    graphs = retained_graphs(f, jobs)
    for stage, following in (("analysis", "planning"), ("planning", "drafting"), ("drafting", "commercial"), ("commercial", "review")):
        enqueue(f, p["id"], "advance_plan", stage, {}, {"next_stage": following})
    split = enqueue(f, p["id"], "plan_commercial", "commercial", {"requirement_ids": []})
    f.sql(f"update public.generation_steps set status='split' where job_id={q(split)};update public.jobs set status='canceled' where id={q(split)};")
    advance = enqueue(f, p["id"], "advance_plan", "review", {})
    lease = uid()
    f.sql(f"update public.jobs set status='running',lease_token={q(lease)},lease_until=now()+interval '5 minutes' where id={q(advance)};"
          f"update public.generation_plans set status='running' where id={q(p['id'])};")
    context = rpc(f, "generation_context", (advance, lease))
    result = node(f, "import {nextStage} from './supabase/functions/_shared/generation.ts';process.stdout.write(JSON.stringify(await nextStage(input)));", context)
    assert result["next_stage"] == "completed"
    rpc(f, "advance_generation", (advance, lease, result["next_stage"], result["requirements"], result["steps"], result["final_result"]))
    f.sql("update public.jobs set status='canceled' where type='render_delivery' and status='queued'")
    prepare = rpc(f, "claim_backend_local_job_v7")
    assert prepare["type"] == "prepare_generated_delivery", (prepare["type"], p["frozen_context"].get("generated_delivery_version"))
    # A retained metadata annotation makes an accidental blanket version UPDATE
    # observable even when the two assembly consistency reports otherwise agree.
    f.sql(f"update public.proposal_versions set consistency_report=consistency_report||'{{\"synthetic_retained_annotation\":true}}'::jsonb where plan_id={q(p['id'])};")
    before_context = rpc(f, "generated_delivery_context", (prepare["id"], prepare["lease_token"]))
    assert len(before_context["accepted_receipts"]) == 31
    rpc(f, "fail_generated_delivery", (prepare["id"], prepare["lease_token"], "GENERATED_DELIVERY_VALIDATION_FAILED"))
    p = f.value(f"select to_jsonb(p) from public.generation_plans p where id={q(p['id'])}")
    assert (p["status"], p["stage"], p["error_code"]) == ("failed", "completed", "GENERATED_DELIVERY_VALIDATION_FAILED")
    return {"plan": p, "prepare": prepare["id"], "document": document, "graphs": graphs,
            "version": before_context["version"]["id"], "old_context": before_context}


def snapshot(f, x):
    plan = q(x["plan"]["id"])
    return f.value(f"""select jsonb_build_object(
      'plan',(select to_jsonb(p) from public.generation_plans p where id={plan}),
      'jobs',(select jsonb_agg(to_jsonb(j) order by id) from public.jobs j where entity_id={plan}),
      'steps',(select jsonb_agg(to_jsonb(s) order by ordinal) from public.generation_steps s where plan_id={plan}),
      'versions',(select jsonb_agg(to_jsonb(v) order by id) from public.proposal_versions v where plan_id={plan}),
      'sections',(select jsonb_agg(to_jsonb(s) order by id) from public.proposal_sections s where proposal_version_id in(select id from public.proposal_versions where plan_id={plan})),
      'graphs',(select jsonb_agg(to_jsonb(g) order by id) from app_private.model_graph_threads g where job_id in(select id from public.jobs where entity_id={plan})),
      'results',(select jsonb_agg(to_jsonb(r) order by id) from app_private.model_graph_results r where thread_id in(select id from app_private.model_graph_threads where job_id in(select id from public.jobs where entity_id={plan}))),
      'budgets',(select jsonb_agg(to_jsonb(b) order by thread_id,unit) from app_private.model_graph_budgets b where thread_id in(select id from app_private.model_graph_threads where job_id in(select id from public.jobs where entity_id={plan}))),
      'usage',(select jsonb_agg(to_jsonb(u) order by id) from public.provider_usage u where job_id in(select id from public.jobs where entity_id={plan})),
      'issuance',(select jsonb_agg(to_jsonb(i) order by id) from public.proposal_issuance_requests i where plan_id={plan}),
      'lineage',(select jsonb_agg(to_jsonb(l) order by id) from app_private.legacy_zero_inventory_review_lineage l where plan_id={plan}),
      'audit',(select jsonb_agg(to_jsonb(a) order by id) from public.audit_events a where entity_id={plan}),
      'dispatches',(select count(*) from app_private.test_successor_dispatches))""")


def payload(x):
    return {"id": x["plan"]["id"], "expected_revision": x["plan"]["revision"], "reason": "Complete the missing whole-proposal review of retained synthetic work."}


def refusal(f, x, errors, mutation="", body=None):
    before = snapshot(f, x)
    result = f.sql(f.command_sql("generation.retry", body or payload(x)).replace("begin;", "begin;" + mutation, 1), check=False)
    if isinstance(errors, str):
        errors = (errors,)
    assert result.returncode and any(error in result.stderr for error in errors), result.stderr or result.stdout
    assert snapshot(f, x) == before, "Refused recovery mutated retained state"


def authority(f, x, cases):
    refusal(f, x, "REVISION_CONFLICT", body={**payload(x), "expected_revision": x["plan"]["revision"] - 1})
    cases.append({"case": "old-revision-cannot-reopen-completed-stage", "passed": True})
    for role in ("Editor", "Reviewer"):
        refusal(f, x, ("ROLE_FORBIDDEN", "PROPOSAL_RENDER_RETRY_REQUIRED"), f"update public.memberships set role={q(role)} where user_id={q(OWNER)};")
        cases.append({"case": role.lower() + "-cannot-authorize-paid-whole-review", "passed": True})
    refusal(f, x, ("ACCESS_PENDING", "ROLE_FORBIDDEN"), f"update public.identity_allowlist set status='inactive' where user_id={q(OWNER)};")
    cases.append({"case": "revoked-owner-cannot-authorize-review", "passed": True})
    for name, mutation in {
        "evidence-revision": f"update public.workspaces set evidence_revision=evidence_revision+1 where id={q(f.workspace)};",
        "source-currentness": f"update public.documents set extraction_hash=repeat('e',64) where id={q(x['document']['id'])};",
        "active-version": f"update public.proposals set active_version_id=null where id={q(x['plan']['proposal_id'])};",
        "version-content-hash": f"update public.proposal_versions set content_hash=repeat('e',64) where id={q(x['version'])};",
        "missing-accepted-graph": f"update app_private.model_graph_threads set status='needs_review' where id={q(x['graphs'][0]['thread'])};",
        "selected-report-raw-envelope": f"update app_private.model_graph_checkpoints set checkpoint='{{\"channel_values\":{{\"reportRef\":\"{x['graphs'][0]['checked']}\"}}}}'::jsonb where thread_id={q(x['graphs'][0]['thread'])};",
    }.items():
        refusal(f, x, ("LEGACY_REVIEW_RECOVERY_NOT_SAFE", "STALE_INPUT", "GENERATION_NOT_ACTIVE"), mutation)
        cases.append({"case": name + "-change-refuses-recovery", "passed": True})
    refusal(f, x, "USAGE_REVIEW_REQUIRED", f"update public.provider_usage set state='reserved' where job_id={q(x['graphs'][0]['step']['job_id'])};")
    cases.append({"case": "reserved-usage-refuses-new-review-budget", "passed": True})
    before = snapshot(f, x)
    mutation = f"update public.provider_usage set state='unknown' where job_id={q(x['graphs'][0]['step']['job_id'])};"
    command = f.command_sql("generation.retry", payload(x)).replace("begin;", "begin;" + mutation, 1)
    check = f"""reset role;select jsonb_build_object(
      'lineage',(select count(*) from app_private.legacy_zero_inventory_review_lineage where plan_id={q(x['plan']['id'])}),
      'old_unknown',(select count(*) from public.provider_usage where job_id={q(x['graphs'][0]['step']['job_id'])} and state='unknown'),
      'new_attempts',(select count(*) from public.model_attempts where job_id in(select review_job_id from app_private.legacy_zero_inventory_review_lineage where plan_id={q(x['plan']['id'])})));rollback;"""
    historical = f.sql(command.rsplit("commit;", 1)[0] + check)
    rows = [json.loads(line) for line in historical.stdout.splitlines() if line.startswith("{")]
    assert rows[-1] == {"lineage": 1, "old_unknown": 1, "new_attempts": 0}
    assert snapshot(f, x) == before
    cases.append({"case": "modern-admission-retains-old-unknown-debt-and-admits-only-fresh-review", "passed": True})
    for state in ("failed", "canceled"):
        mutation = f"""insert into public.generation_plans(workspace_id,opportunity_id,proposal_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by,created_at)
          select workspace_id,opportunity_id,proposal_id,kind,'analysis',{q(state)},evidence_revision,input_hash,frozen_context,created_by,created_at+interval '1 second'
          from public.generation_plans where id={q(x['plan']['id'])};"""
        refusal(f, x, "LEGACY_REVIEW_RECOVERY_NOT_SAFE", mutation)
        cases.append({"case": "newer-" + state + "-plan-prevents-stale-plan-recovery", "passed": True})
    mutation = """create function app_private.synthetic_refuse_review_lineage() returns trigger language plpgsql as $$begin
      raise exception 'SYNTHETIC_REVIEW_LINEAGE_FAILURE';end$$;
      create trigger synthetic_review_failure before insert on app_private.legacy_zero_inventory_review_lineage
      for each row execute function app_private.synthetic_refuse_review_lineage();"""
    refusal(f, x, "SYNTHETIC_REVIEW_LINEAGE_FAILURE", mutation)
    cases.append({"case": "lineage-insert-failure-rolls-back-stage-job-issuance-audit-and-admission", "passed": True})


def retained(f, x, before, after):
    assert all(old in after["steps"] for old in before["steps"])
    assert all(old in after["jobs"] for old in before["jobs"])
    for field in ("versions", "sections", "graphs", "results", "budgets", "usage"):
        assert after[field] == before[field], field
    assert all(old in after["issuance"] for old in before["issuance"])
    assert len(before["steps"]) == 37
    assert sum(step["status"] == "completed" and step["task"] != "advance_plan" for step in before["steps"]) == 31
    assert len(after["steps"]) == len(before["steps"]) + 1
    assert len(after["jobs"]) == len(before["jobs"]) + 1
    assert len(after["lineage"]) == 1
    for field in ("base_version_id", "input_hash", "frozen_context", "workflow_version", "evidence_revision"):
        assert after["plan"][field] == before["plan"][field], field
    assert after["plan"]["revision"] == before["plan"]["revision"] + 1
    assert after["plan"]["stage"] == "review"
    step = next(row for row in after["steps"] if row["id"] not in {old["id"] for old in before["steps"]})
    assert step["task"] == "review_proposal" and step["status"] == "queued"
    assert step["input"] == {"requirement_ids": [], "legacy_zero_inventory_review_version": 1, "review_scope_version": 1,
                             "review_source_version": 1, "coherence_review": True,
                             "section_keys": [section["section_key"] for section in sorted(before["sections"], key=lambda s: s["ordinal"])]}
    job = next(row for row in after["jobs"] if row["id"] == step["job_id"])
    assert job["checkpoint"]["minimum_worker_executor"] == 7
    assert "graph_thread" not in job["checkpoint"]
    assert not f.value(f"select to_jsonb(exists(select 1 from app_private.model_graph_threads where job_id={q(job['id'])}))")
    issuance = next(row for row in after["issuance"] if row["id"] == after["plan"]["issuance_request_id"])
    assert issuance["operation"] == "generation.retry" and issuance["requested_by"] == OWNER
    assert job["checkpoint"]["issuance_request_id"] == issuance["id"]
    assert float(f.scalar(f"select extract(epoch from deadline_at-accepted_at) from public.proposal_issuance_requests where id={q(issuance['id'])}")) == 600
    observed = f.value(f"select jsonb_agg(id order by id) from public.jobs where checkpoint->>'issuance_request_id'={q(issuance['id'])}")
    assert observed == [job["id"]]
    return step, job


def success(f, x, cases):
    before = snapshot(f, x)
    key = uid()
    command = f.command_sql("generation.retry", payload(x), key)
    raced = f.race([command, command])
    assert all(r.returncode == 0 for r in raced), [r.stderr for r in raced]
    results = [json.loads(r.stdout) for r in raced]
    assert results[0] == results[1]
    after = snapshot(f, x)
    step, job = retained(f, x, before, after)
    assert f.command("generation.retry", payload(x), key) == results[0]
    assert snapshot(f, x) == after
    refusal(f, x, "REVISION_CONFLICT")
    conflict = f.sql(f.command_sql("generation.retry", {**payload(x), "reason": "A different reason"}, key), check=False)
    assert conflict.returncode and "IDEMPOTENCY_CONFLICT" in conflict.stderr
    assert snapshot(f, x) == after
    cases.extend([{"case": name, "passed": True} for name in (
        "same-key-real-lock-race-authorizes-one-review-and-one-600-second-issuance",
        "all31accepted-steps-old-jobs-paid-usage-and-version-metadata-retained",
        "exact-replay-has-no-new-rows-and-conflicting-body-refused",
        "old-revision-with-fresh-key-refused-after-admission")])
    for version in (5, 6):
        assert f.value(f"begin;set local role service_role;select coalesce(public.claim_backend_job_v{version}(),'null'::jsonb);rollback;") is None
    claimed = rpc(f, "claim_backend_job_v7")
    assert claimed["id"] == job["id"]
    context = rpc(f, "generation_context", (claimed["id"], claimed["lease_token"]))
    assert context["plan"]["base_version_id"] == before["plan"]["base_version_id"]
    assert len(context["steps"]) == 38
    cases.append({"case": "old5-and6-cannot-claim-recovery-but-v7-reads-pinned-old-base-context", "passed": True})
    return before, after, step, claimed


def reassemble(f, x, before, step, job, cases):
    review = {"processed_requirement_ids": [], "responses": [], "findings": [], "questions": []}
    graph = retained_graphs(f, [job["id"]], {job["id"]: review})[0]
    f.sql(f"update app_private.model_graph_threads set status='accepted' where id={q(graph['thread'])};")
    rpc(f, "complete_generation_step", (job["id"], job["lease_token"], review))
    advance = rpc(f, "claim_backend_job_v7")
    assert advance["type"] == "advance_plan" and advance["checkpoint"]["minimum_worker_executor"] == 7
    context = rpc(f, "generation_context", (advance["id"], advance["lease_token"]))
    result = node(f, "import {nextStage} from './supabase/functions/_shared/generation.ts';process.stdout.write(JSON.stringify(await nextStage(input)));", context)
    rpc(f, "advance_generation", (advance["id"], advance["lease_token"], result["next_stage"], result["requirements"], result["steps"], result["final_result"]))
    f.sql("update public.jobs set status='canceled' where type='render_delivery' and status='queued'")
    for version in (5, 6):
        assert f.value(f"begin;set local role service_role;select coalesce(public.claim_backend_local_job_v{version}(),'null'::jsonb);rollback;") is None
    projection = rpc(f, "claim_backend_local_job_v7")
    assert projection["type"] == "prepare_generated_delivery" and projection["checkpoint"]["minimum_worker_executor"] == 7
    generated = rpc(f, "generated_delivery_context", (projection["id"], projection["lease_token"]))
    assert generated["version"]["id"] != x["version"]
    assert len(generated["accepted_receipts"]) == 32 and len(generated["sections"]) == 17
    after = snapshot(f, x)
    for field in ("steps", "jobs", "versions", "sections", "graphs", "results", "budgets", "usage"):
        assert all(old in after[field] for old in before[field]), "Reassembly changed old " + field
    assert len(after["versions"]) == len(before["versions"]) + 1
    assert len(after["lineage"]) == 1
    cases.extend([{"case": name, "passed": True} for name in (
        "fresh-accepted-review-completes-through-normal-advance-and-new-version",
        "prior-version-consistency-metadata-sections-and-paid-history-remain-byte-identical",
        "projection-is-floor7-and-selects-all32-exact-accepted-receipts")])
    rpc(f, "fail_generated_delivery", (projection["id"], projection["lease_token"], "GENERATED_DELIVERY_VALIDATION_FAILED"))
    latest = f.value(f"select to_jsonb(p) from public.generation_plans p where id={q(x['plan']['id'])}")
    refusal(f, {**x, "plan": latest}, ("LEGACY_REVIEW_RECOVERY_NOT_SAFE", "PROPOSAL_RENDER_RETRY_REQUIRED"))
    cases.append({"case": "fresh-revision-after-another-failure-cannot-authorize-second-review-budget", "passed": True})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    f = PostgresFixture(repository=Path(__file__).resolve().parents[3])
    try:
        f.start()
        fingerprints = schema_fingerprints(f)
        dispatcher_fixture(f)
        x = setup(f)
        print(json.dumps({"fixture_ready": True, "accepted_steps": 31, "sections": 17}), flush=True)
        proof = f.value(f"select app_private.legacy_review_recovery_proof({q(x['plan']['id'])})")
        assert proof, "Actual failed completed-plan fixture was not eligible"
        cases = [{"case": "actual-fail-generated-delivery-produces-failed-plan-at-completed-stage", "passed": True}]
        authority(f, x, cases)
        print(json.dumps({"authority_cases": len(cases)}), flush=True)
        trial_harness(f, x, cases)
        before, after, step, claimed = success(f, x, cases)
        print(json.dumps({"admission_cases": len(cases)}), flush=True)
        reassemble(f, x, before, step, claimed, cases)
        receipt = f.receipt(cases)
        receipt["fingerprints"] = fingerprints
        args.output.write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps({"passed": len(receipt["cases"]), "plan_stage": after["plan"]["stage"]}))
    finally:
        f.close()


if __name__ == "__main__":
    main()
