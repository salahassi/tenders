#!/usr/bin/env python3
"""Full-schema, offline commercial-successor authority and concurrency checks.

Only synthetic records in an owned, network-none PostgreSQL container. The
canonical authenticated command is exercised; no provider or hosted calls occur.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import uuid

from postgres_races import OWNER, PostgresFixture, literal as q


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def schema_fingerprints(f):
    path = f.repository / "backend/scripts/ops/proposal-dispatch-schema.py"
    spec = importlib.util.spec_from_file_location("synthetic_successor_schema", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return f.value("begin isolation level repeatable read read only;set local search_path=public;set local statement_timeout='20s';"
                   "do $$declare catalog_hash text;structure jsonb;begin " + module.CATALOG + module.structure_snapshot(protected=False) +
                   "perform set_config('synthetic.successor_fingerprints',jsonb_build_object('scope','isolated_postgresql_fixture',"
                   "'catalog_sha256',catalog_hash,'structure_sha256',encode(sha256(convert_to(structure::text,'UTF8')),'hex'))::text,true);"
                   "end$$;select current_setting('synthetic.successor_fingerprints')::jsonb;rollback;")


def rpc(f, name, args=(), service=False):
    role = "service_role" if service else "authenticated"
    return f.value(f"begin;set local role {role};set local request.jwt.claim.sub={q(OWNER)};"
                   f"select coalesce(to_jsonb(public.{name}({','.join(q(value) for value in args)})),'null'::jsonb);commit;")


def dispatcher_fixture(f):
    # Replace only the external dispatcher side effect. The admission and wake
    # SQL remains the complete migrated implementation under actual roles.
    f.sql("""create table app_private.test_successor_dispatches(id bigint generated always as identity);
      create table app_private.k8s_dispatch_queue(synthetic_fixture boolean);
      create or replace function app_private.dispatch_backend() returns void language plpgsql security definer set search_path='' as $$
      begin insert into app_private.test_successor_dispatches default values;end$$;
      insert into app_private.dispatcher_settings(singleton,project_url,secret_hash,enabled)
      values(true,'https://synthetic.supabase.co','synthetic-only',true);""")


def setup(f):
    f.sql(f"insert into public.model_execution_settings(workspace_id,enabled,admitted_after,created_by) "
          f"values({q(f.workspace)},true,now()-interval '1 day',{q(OWNER)}) on conflict(workspace_id) do nothing")
    opportunity = f.opportunity("Implement an approval workflow and provide a documented handover.")
    document = f.upload(opportunity)
    f.command("document.confirm", {"id": document["id"], "expected_revision": document["revision"]})
    generated = f.command("proposal.generate", {"id": opportunity["id"], "expected_revision": opportunity["revision"]})
    plan = f.value(f"select to_jsonb(p) from public.generation_plans p where id={q(generated['id'])}")
    # Represent retained successful work explicitly. These synthetic rows are
    # test inputs, never an alternative production path to model acceptance.
    f.sql(f"""begin;
      update public.jobs set status='succeeded',lease_token=null,lease_until=null where entity_id={q(plan['id'])};
      update public.generation_steps set status='completed',output='{{"synthetic":"retained-analysis"}}' where plan_id={q(plan['id'])};
      do $$declare p public.generation_plans;j uuid;n integer;begin
        select * into p from public.generation_plans where id={q(plan['id'])};
        select count(*) into n from public.generation_steps where plan_id=p.id and task='analyze_chunk';
        for i in 1..greatest(0,12-n) loop
          j:=app_private.enqueue_generation(p,'analyze_chunk',jsonb_build_object('synthetic_saved_analysis',i));
          update public.jobs set status='succeeded' where id=j;
          update public.generation_steps set status='completed',output='{{"synthetic":"retained-analysis"}}' where job_id=j;
        end loop;
      end$$;
      update public.generation_plans set stage='drafting' where id={q(plan['id'])};
      do $$declare p public.generation_plans;j uuid;begin
        select * into p from public.generation_plans where id={q(plan['id'])};
        for i in 1..17 loop
          j:=app_private.enqueue_generation(p,'draft_section',jsonb_build_object('key','section-'||i));
          update public.jobs set status='succeeded' where id=j;
          update public.generation_steps set status='completed',output=jsonb_build_object(
            'key','section-'||i,'title','Synthetic saved section','volume','technical',
            'content_blocks',jsonb_build_array(jsonb_build_object('type','paragraph','text','Saved synthetic solution.')),
            'requirement_ids','[]'::jsonb,'evidence_refs','[]'::jsonb,'company_claims','[]'::jsonb,
            'assumptions','[]'::jsonb,'questions','[]'::jsonb) where job_id=j;
        end loop;
      end$$;
      update public.generation_plans set stage='commercial' where id={q(plan['id'])};commit;""")
    thread = digest(str(uuid.uuid4()))
    job = str(uuid.uuid4())
    step = str(uuid.uuid4())
    # This fixture deliberately seeds a historical, flag-absent commercial job.
    # Newly enqueued commercial jobs must receive version2 through production SQL.
    f.sql(f"""begin;
      insert into public.jobs(id,workspace_id,type,entity_id,input_hash,status,created_by,checkpoint)
      values({q(job)},{q(f.workspace)},'plan_commercial',{q(plan['id'])},{q(plan['input_hash'])},'queued',{q(OWNER)},
        jsonb_build_object('model_executor',2,'graph_thread',{q(thread)},'model_routing',jsonb_build_object('mode','round_robin','providers','[]'::jsonb)));
      insert into public.generation_steps(id,workspace_id,plan_id,job_id,task,stage,ordinal,input,created_by)
      select {q(step)},workspace_id,id,{q(job)},'plan_commercial','commercial',
        (select max(ordinal)+1 from public.generation_steps where plan_id=p.id),
        '{{"requirement_ids":[],"workflow_version":2}}',{q(OWNER)} from public.generation_plans p where id={q(plan['id'])};
      insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,status,candidate_count,budget_version)
      values({q(thread)},{q(f.workspace)},{q(job)},repeat('f',64),'plan_commercial','needs_review',1,2);
      insert into app_private.model_graph_budgets(thread_id,unit,candidates)
      values({q(thread)},'writer',1),({q(thread)},'writer-repair',2);
      insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
        application_day,settings_revision,reserved_input,reserved_output,state,created_by,graph_candidate_recorded)
      select {q(f.workspace)},{q(job)},gen_random_uuid(),'synthetic-retained-paid-'||n,'openai','synthetic-model',repeat('a',64),
        current_date,1,100,100,'settled',{q(OWNER)},true from generate_series(0,2) n;
      commit;""")
    frozen = plan["frozen_context"]
    source = next(block for block in frozen["blocks"] if re.fullmatch(r"[a-f0-9-]{36}", block["id"]))
    quote = source["id"] + ": Documented handover."
    candidate = {"lines": [], "tasks": [{"key": "handover", "title": "Handover", "predecessors": [],
                  "role": "Consultant", "effort_days": None, "allocation": None, "duration_days": None, "basis": quote}],
                 "questions": ["Which approved tax category applies to this proposal?"]}
    candidates = []
    for i in range(3):
        record = {"result": candidate, "producer": None}
        saved = f.value(f"insert into app_private.model_graph_results(thread_id,result_key,value,content_hash) "
                        f"values({q(thread)},{q('candidate-'+str(i))},{q(record)}::jsonb,"
                        f"encode(sha256(convert_to(({q(record)}::jsonb)::text,'UTF8')),'hex')) returning to_jsonb(model_graph_results)")
        candidates.append(saved)
    candidate_hash = digest(candidates[-1]["value"]["result"])
    phase = "verification-v3-" + candidate_hash + "-content-1"
    report = {"checked_candidate_hash": candidate_hash, "reviewed_all_content": True,
              "required_ids": [], "checked_content_ids": ["content-0"], "requirement_checks": [], "findings": [],
              "claims": [{"id": "claim-1", "kind": "tender_fact", "status": "supported", "candidate_quote": quote,
                          "source_refs": [{"id": source["id"], "quote": "handover condition"}]}]}
    numeric = list(dict.fromkeys(str(int(x)) for x in re.findall(r"\d+", source["id"])))
    invalid = {"verification_key": phase, "result": report, "code": "EVIDENCE_REFERENCE_INVALID", "producer": None,
               "validation_diagnostics": [{"code": "EVIDENCE_REFERENCE_INVALID", "reason": "numeric_evidence_mismatch",
                 "paths": ["$.claims[0].candidate_quote", "$.claims[0].source_refs"],
                 "evidence_ids": [source["id"]], "numeric_literals": numeric}]}
    invalid_row = f.value(f"insert into app_private.model_graph_results(thread_id,result_key,value,content_hash) "
                         f"values({q(thread)},{q('invalid-report-'+digest(invalid))},{q(invalid)}::jsonb,"
                         f"encode(sha256(convert_to(({q(invalid)}::jsonb)::text,'UTF8')),'hex')) returning to_jsonb(model_graph_results)")
    serialized_checkpoint = {"type": "json", "data": base64.b64encode(json.dumps({"channel_values": {
        "repairCount": 2, "candidateRef": candidates[-1]["id"], "reportRef": invalid_row["id"]}},
        separators=(",", ":")).encode()).decode()}
    f.sql(f"""begin;
      insert into app_private.model_graph_checkpoints(thread_id,checkpoint_id,checkpoint,metadata)
      values({q(thread)},'synthetic-terminal',{q(serialized_checkpoint)}::jsonb, '{{}}');
      select app_private.fail_proposal_issuance({q(plan['issuance_request_id'])},'MODEL_CORRECTION_EXHAUSTED');
      update public.jobs set status='failed',error_code='MODEL_CORRECTION_EXHAUSTED' where id={q(job)};
      update public.generation_plans set status='failed',error_code='MODEL_CORRECTION_EXHAUSTED' where id={q(plan['id'])};
      commit;""")
    plan = f.value(f"select to_jsonb(p) from public.generation_plans p where id={q(plan['id'])}")
    return {"plan": plan, "job": job, "step": step, "thread": thread, "source": source,
            "candidates": candidates, "invalid": invalid_row, "document": document}


def snapshot(f, x):
    return f.value(f"""select jsonb_build_object(
      'plan',(select to_jsonb(p) from public.generation_plans p where id={q(x['plan']['id'])}),
      'jobs',(select jsonb_agg(to_jsonb(j) order by id) from public.jobs j where entity_id={q(x['plan']['id'])}),
      'steps',(select jsonb_agg(to_jsonb(s) order by ordinal) from public.generation_steps s where plan_id={q(x['plan']['id'])}),
      'graph',(select to_jsonb(t) from app_private.model_graph_threads t where id={q(x['thread'])}),
      'results',(select jsonb_agg(to_jsonb(r) order by id) from app_private.model_graph_results r where thread_id={q(x['thread'])}),
      'budgets',(select jsonb_agg(to_jsonb(b) order by unit) from app_private.model_graph_budgets b where thread_id={q(x['thread'])}),
      'usage',(select jsonb_agg(to_jsonb(u) order by id) from public.provider_usage u where job_id={q(x['job'])}),
      'issuance',(select jsonb_agg(to_jsonb(i) order by id) from public.proposal_issuance_requests i where plan_id={q(x['plan']['id'])}),
      'lineage',(select jsonb_agg(to_jsonb(l) order by id) from app_private.commercial_successor_lineage l where plan_id={q(x['plan']['id'])}),
      'audit',(select jsonb_agg(to_jsonb(a) order by id) from public.audit_events a where entity_id={q(x['plan']['id'])}),
      'dispatches',(select count(*) from app_private.test_successor_dispatches),
      'idempotency',(select jsonb_agg(to_jsonb(r) order by key) from app_private.idempotency_records r where workspace_id={q(f.workspace)}))""")


def payload(x):
    return {"id": x["plan"]["id"], "expected_revision": x["plan"]["revision"], "reason": "Resume saved synthetic commercial work."}


def refusal(f, x, error, mutation="", body=None, operation="generation.retry"):
    before = snapshot(f, x)
    sql = f.command_sql(operation, body or payload(x))
    result = f.sql(sql.replace("begin;", "begin;" + mutation, 1), check=False)
    expected = (error,) if isinstance(error, str) else error
    assert result.returncode and any(code in result.stderr for code in expected), result.stderr or result.stdout
    assert snapshot(f, x) == before, "Rejected command changed retained state"


def authority_cases(f, x, cases):
    refusal(f, x, "REVISION_CONFLICT", body={**payload(x), "expected_revision": x["plan"]["revision"] - 1})
    cases.append({"case": "stale-plan-revision-rejected-before-successor", "passed": True})
    refusal(f, x, "ROLE_FORBIDDEN", f"update public.memberships set role='Reviewer' where user_id={q(OWNER)};")
    cases.append({"case": "reviewer-cannot-authorize-successor", "passed": True})
    refusal(f, x, "ACCESS_PENDING", f"update public.identity_allowlist set status='inactive' where user_id={q(OWNER)};")
    cases.append({"case": "inactive-allowlist-cannot-authorize-successor", "passed": True})
    refusal(f, x, ("STALE_INPUT", "GENERATION_NOT_ACTIVE"), f"update public.workspaces set evidence_revision=evidence_revision+1 where id={q(f.workspace)};")
    cases.append({"case": "changed-evidence-retains-old-graph-and-no-new-issuance", "passed": True})
    refusal(f, x, ("STALE_INPUT", "GENERATION_NOT_ACTIVE"), f"update public.documents set extraction_hash=repeat('e',64) where id={q(x['document']['id'])};")
    cases.append({"case": "current-source-change-rejected", "passed": True})
    for state in ("reserved", "unknown"):
        refusal(f, x, "USAGE_REVIEW_REQUIRED", f"update public.provider_usage set state={q(state)} where job_id={q(x['job'])};")
        cases.append({"case": state + "-predecessor-usage-prevents-new-budget", "passed": True})
    refusal(f, x, "GENERATION_BUSY", f"insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,lease_token,lease_until) "
            f"select workspace_id,'advance_plan',id,input_hash,'running',created_by,gen_random_uuid(),now()+interval '1 minute' "
            f"from public.generation_plans where id={q(x['plan']['id'])};")
    cases.append({"case": "running-predecessor-keeps-existing-lease-authority", "passed": True})


def proof_cases(f, x, cases):
    proof = f.value(f"select app_private.commercial_successor_proof({q(x['job'])})")
    assert isinstance(proof, dict) and proof, "Synthetic UUID-only diagnostic was not proved"
    changes = {
        "missing-retained-diagnostic": f"delete from app_private.model_graph_results where id={q(x['invalid']['id'])};",
        "diagnostic-overflow": f"update app_private.model_graph_results set value=value||'{{\"omitted_diagnostic_count\":1}}'::jsonb where id={q(x['invalid']['id'])};",
        "non-numeric-diagnostic": f"update app_private.model_graph_results set value=jsonb_set(value,'{{validation_diagnostics,0,reason}}','\"source_quote_mismatch\"') where id={q(x['invalid']['id'])};",
        "additional-factual-number": f"update app_private.model_graph_results set value=jsonb_set(value,'{{result,claims,0,candidate_quote}}',to_jsonb((value#>>'{{result,claims,0,candidate_quote}}')||' Commit to 900 days.')) where id={q(x['invalid']['id'])};",
        "unknown-source-uuid": f"update app_private.model_graph_results set value=jsonb_set(value,'{{result,claims,0,source_refs,0,id}}',to_jsonb(gen_random_uuid()::text)) where id={q(x['invalid']['id'])};",
        "altered-source-quote": f"update app_private.model_graph_results set value=jsonb_set(value,'{{result,claims,0,source_refs,0,quote}}','\"Never present in this source.\"') where id={q(x['invalid']['id'])};",
        "numeric-fragment-mismatch": f"update app_private.model_graph_results set value=jsonb_set(value,'{{validation_diagnostics,0,numeric_literals}}','[\"9999999999\"]') where id={q(x['invalid']['id'])};",
        "unconsumed-repair-budget": f"update app_private.model_graph_budgets set candidates=1 where thread_id={q(x['thread'])} and unit='writer-repair';",
        "missing-final-candidate": f"delete from app_private.model_graph_results where id={q(x['candidates'][-1]['id'])};",
        "already-version-two": f"update public.generation_steps set input=input||'{{\"commercial_input_version\":2}}'::jsonb where id={q(x['step'])};",
        "accepted-old-graph": f"update app_private.model_graph_threads set status='accepted',result_id={q(x['candidates'][-1]['id'])} where id={q(x['thread'])};",
    }
    for name, mutation in changes.items():
        # Match the application's immutable content checksum after deliberate
        # synthetic fixture edits, so rejection cannot rely only on stale hashes.
        mutation += f"update app_private.model_graph_results set content_hash=encode(sha256(convert_to(value::text,'UTF8')),'hex') where thread_id={q(x['thread'])};"
        refusal(f, x, "COMMERCIAL_SUCCESSOR_NOT_SAFE", mutation)
        cases.append({"case": name + "-cannot-authorize-successor", "passed": True})
    refusal(f, x, "ROLE_FORBIDDEN", f"update public.memberships set role='Editor' where user_id={q(OWNER)};")
    cases.append({"case": "editor-cannot-authorize-new-commercial-budget", "passed": True})


def partial_rollback(f, x, cases):
    mutation = f"""create function app_private.synthetic_reject_successor() returns trigger language plpgsql as $$begin
      if new.task='plan_commercial' and new.input->>'commercial_input_version'='2' then
        raise exception 'SYNTHETIC_SUCCESSOR_INSERT_FAILURE';end if;return new;end$$;
      create trigger synthetic_reject_successor before insert on public.generation_steps
      for each row execute function app_private.synthetic_reject_successor();"""
    refusal(f, x, "SYNTHETIC_SUCCESSOR_INSERT_FAILURE", mutation)
    assert not f.value("select to_jsonb(exists(select 1 from pg_proc where proname='synthetic_reject_successor'))")
    cases.append({"case": "successor-insert-failure-rolls-back-canonical-retry-issuance-split-audit-and-receipt", "passed": True})


def ordinary_retry(f, x, cases):
    before = snapshot(f, x)
    original_job = next(row for row in before["jobs"] if row["id"] == x["job"])
    for state, error in (("failed", "PROPOSAL_ISSUANCE_TIMEOUT"), ("v2", "PROPOSAL_ISSUANCE_TIMEOUT"), ("blocked", "NO_AGENTS_AVAILABLE"),
                         ("blocked", "MODEL_CORRECTION_EXHAUSTED"), ("nested", "MODEL_CORRECTION_EXHAUSTED")):
        mutation = "" if state == "nested" else f"update public.jobs set status={q('failed' if state == 'v2' else state)},error_code={q(error)} where id={q(x['job'])};"
        if state == "v2":
            mutation += f"update public.generation_steps set input=input||'{{\"commercial_input_version\":2}}'::jsonb where id={q(x['step'])};"
            mutation += f"update public.jobs set checkpoint=checkpoint||'{{\"commercial_input_version\":2}}'::jsonb where id={q(x['job'])};"
        operation = "job.action" if state == "nested" else "generation.retry"
        body = {"id": x["job"], "expected_revision": original_job["revision"], "action": "retry", "reason": "Retry synthetic job."} if state == "nested" else payload(x)
        command = f.command_sql(operation, body).replace("begin;", "begin;" + mutation, 1)
        check = f"""reset role;select jsonb_build_object(
          'jobs',(select count(*) from public.jobs where entity_id={q(x['plan']['id'])}),
          'step_status',(select status from public.generation_steps where id={q(x['step'])}),
          'lineage',(select count(*) from app_private.commercial_successor_lineage where plan_id={q(x['plan']['id'])}));rollback;"""
        result = f.sql(command.rsplit("commit;", 1)[0] + check)
        rows = [json.loads(line) for line in result.stdout.splitlines() if line.startswith("{")]
        assert rows[-1] == {"jobs": len(before["jobs"]), "step_status": "queued", "lineage": 0}
        assert snapshot(f, x) == before
        cases.append({"case": state + "-" + error.lower() + "-retains-ordinary-retry-without-successor", "passed": True})


def revocation_race(f, x, cases):
    before = snapshot(f, x)
    commands = [f.command_sql("generation.retry", payload(x)) for _ in range(2)]
    raced = f.race(commands, f"update public.identity_allowlist set status='inactive' where user_id={q(OWNER)};")
    try:
        assert all(result.returncode and ("ACCESS_PENDING" in result.stderr or "ROLE_FORBIDDEN" in result.stderr)
                   for result in raced), [result.stderr for result in raced]
        assert snapshot(f, x) == before
    finally:
        f.sql(f"update public.identity_allowlist set status='active' where user_id={q(OWNER)}")
    cases.append({"case": "actual-lock-wait-rechecks-owner-revocation-before-any-successor-write", "passed": True})


def retained_work(f, x, before):
    after = snapshot(f, x)
    for field in ("graph", "results", "budgets", "usage"):
        assert after[field] == before[field], "Changed retained " + field
    completed = [row for row in before["steps"] if row["status"] == "completed"]
    assert [row for row in after["steps"] if row["status"] == "completed"] == completed
    assert sum(row["task"] == "draft_section" for row in completed) == 17
    assert sum(row["task"] == "analyze_chunk" for row in completed) == 12
    assert len(after["jobs"]) == len(before["jobs"]) + 1
    assert len(after["steps"]) == len(before["steps"]) + 1
    old_step = next(row for row in after["steps"] if row["id"] == x["step"])
    assert old_step["status"] == "split" and old_step["job_id"] == x["job"]
    assert old_step["input"] == next(row for row in before["steps"] if row["id"] == x["step"])["input"]
    child = next(row for row in after["steps"] if row["id"] not in {old["id"] for old in before["steps"]})
    assert child["task"] == "plan_commercial" and child["status"] == "queued"
    assert child["input"]["commercial_input_version"] == 2
    assert child["input"]["requirement_ids"] == old_step["input"]["requirement_ids"]
    assert child["depth"] == old_step["depth"]
    job = next(row for row in after["jobs"] if row["id"] == child["job_id"])
    assert job["checkpoint"]["minimum_worker_executor"] == 6
    assert "graph_thread" not in job["checkpoint"]
    assert job["input_hash"] == before["plan"]["input_hash"]
    assert after["plan"]["frozen_context"] == before["plan"]["frozen_context"]
    assert after["plan"]["revision"] == before["plan"]["revision"] + 1
    assert job["checkpoint"]["issuance_request_id"] == after["plan"]["issuance_request_id"]
    old_job = next(row for row in after["jobs"] if row["id"] == x["job"])
    assert old_job["checkpoint"] == next(row for row in before["jobs"] if row["id"] == x["job"])["checkpoint"]
    assert old_job["status"] == "canceled" and old_job["error_code"] == "COMMERCIAL_CONTEXT_SUPERSEDED"
    observed_jobs = f.value(f"select jsonb_agg(id order by id) from public.jobs where checkpoint->>'issuance_request_id'={q(after['plan']['issuance_request_id'])}")
    assert job["id"] in observed_jobs and x["job"] not in observed_jobs
    issuance = next(row for row in after["issuance"] if row["id"] == after["plan"]["issuance_request_id"])
    assert issuance["plan_id"] == x["plan"]["id"] and issuance["requested_by"] == OWNER and issuance["operation"] == "generation.retry"
    assert not f.value(f"select to_jsonb(exists(select 1 from app_private.model_graph_threads where job_id={q(job['id'])}))")
    clock = f.scalar(f"select extract(epoch from deadline_at-accepted_at) from public.proposal_issuance_requests where id={q(after['plan']['issuance_request_id'])}")
    assert float(clock) == 600
    assert all(old in after["issuance"] for old in before["issuance"])
    assert after["dispatches"] == before["dispatches"] + 1
    assert len(after["lineage"]) == 1
    lineage = after["lineage"][0]
    assert lineage["predecessor_job_id"] == x["job"] and lineage["successor_job_id"] == job["id"]
    assert lineage["predecessor_step_id"] == x["step"] and lineage["successor_step_id"] == child["id"]
    assert lineage["authorized_by"] == OWNER and lineage["issuance_request_id"] == issuance["id"]
    return after, child, job


def success_and_replay(f, x, cases):
    before = snapshot(f, x)
    key = str(uuid.uuid4())
    command = f.command_sql("generation.retry", payload(x), key)
    raced = f.race([command, command])
    assert all(result.returncode == 0 for result in raced), [result.stderr for result in raced]
    results = [json.loads(result.stdout) for result in raced]
    assert results[0] == results[1]
    after, child, job = retained_work(f, x, before)
    assert results[0]["revision"] == after["plan"]["revision"]
    assert f.command("generation.retry", payload(x), key) == results[0]
    assert snapshot(f, x) == after
    cases.append({"case": "real-lock-race-same-idempotency-creates-one-successor-and-one-600-second-issuance", "passed": True})
    cases.append({"case": "completed-drafts-old-graph-results-budgets-paid-usage-and-issuance-unchanged", "passed": True})
    different = f.sql(f.command_sql("generation.retry", payload(x)), check=False)
    assert different.returncode and "REVISION_CONFLICT" in different.stderr
    assert snapshot(f, x) == after
    cases.append({"case": "different-idempotency-key-with-old-revision-cannot-create-another-successor", "passed": True})
    conflict = f.sql(f.command_sql("generation.retry", {**payload(x), "reason": "Changed request body"}, key), check=False)
    assert conflict.returncode and "IDEMPOTENCY_CONFLICT" in conflict.stderr
    assert snapshot(f, x) == after
    cases.append({"case": "replay-body-conflict-rejected-without-mutation", "passed": True})
    return after, child, job


def worker_fence(f, x, after, child, job, cases):
    five = f.value("begin;set local role service_role;select coalesce(public.claim_backend_job_v5(),'null'::jsonb);rollback;")
    assert five is None
    assert snapshot(f, x) == after
    cases.append({"case": "old-worker-five-cannot-claim-only-version-two-commercial-job", "passed": True})
    # Use a separate canonical assessment: advance_plan is deliberately blocked
    # while the same proposal's commercial step remains incomplete.
    opportunity_revision = int(f.scalar(f"select revision from public.opportunities where id={q(x['plan']['opportunity_id'])}"))
    assessment = f.command_sql("opportunity.assess", {"id": x["plan"]["opportunity_id"], "expected_revision": opportunity_revision})
    assessment = assessment.rsplit("commit;", 1)[0] + f"""reset role;set local role service_role;
      select jsonb_build_object('expected',(select s.job_id from public.generation_steps s join public.generation_plans p on p.id=s.plan_id
        where p.opportunity_id={q(x['plan']['opportunity_id'])} and p.kind='assessment' order by s.created_at desc limit 1),
        'claimed',public.claim_backend_job_v5());rollback;"""
    legacy = json.loads(f.sql(assessment).stdout.strip().splitlines()[-1])
    assert legacy["claimed"]["id"] == legacy["expected"]
    assert legacy["claimed"]["checkpoint"]["minimum_worker_executor"] == 5
    cases.append({"case": "old-worker-five-still-claims-eligible-historical-work", "passed": True})
    floor = f.value(f"begin;update public.jobs set checkpoint=jsonb_set(checkpoint,'{{minimum_worker_executor}}','5') where id={q(job['id'])};"
                    f"select checkpoint->'minimum_worker_executor' from public.jobs where id={q(job['id'])};rollback;")
    assert floor == 6
    cases.append({"case": "successor-worker-floor-cannot-be-downgraded-by-later-job-update", "passed": True})
    done = next(row for row in after["jobs"] if row["status"] == "succeeded")
    lease = str(uuid.uuid4())
    wake = f.value(f"begin;set local role service_role;select public.wake_backend_queue_status_v5({q(done['id'])},{q(lease)});rollback;")
    assert wake == {"dispatched": False}
    wake = f.value(f"begin;set local role service_role;select public.wake_backend_queue_status_v6({q(done['id'])},{q(lease)});rollback;")
    assert wake == {"dispatched": True}
    cases.append({"case": "worker-six-wake-reaches-version-two-only-queue-without-provider-call", "passed": True})
    claimed = f.value("begin;set local role service_role;select public.claim_backend_job_v6();commit;")
    assert claimed["id"] == job["id"] and claimed["checkpoint"]["minimum_worker_executor"] == 6
    cases.append({"case": "actual-service-role-worker-six-claim-selects-successor", "passed": True})
    # A new graph receives the existing version2 budget. This fixture initializes
    # that graph without requesting or synthesizing a provider response.
    new_thread = digest(str(uuid.uuid4()))
    f.sql(f"update public.jobs set checkpoint=checkpoint||'{{\"model_executor\":2}}'::jsonb where id={q(job['id'])}")
    initialized = f.value(f"begin;set local role service_role;select public.model_graph_store({q(job['id'])},{q(claimed['lease_token'])},{q(new_thread)},'init',"
                          f"'{json.dumps({'input_hash': 'c' * 64, 'task': 'plan_commercial', 'graph_version': 1, 'budget_version': 2})}'::jsonb);commit;")
    assert initialized["candidate_count"] == 0 and initialized["budget_version"] == 2
    for unit in ("writer", "writer-repair"):
        budget = f.value(f"begin;set local role service_role;select public.model_graph_store({q(job['id'])},{q(claimed['lease_token'])},{q(new_thread)},'candidate_budget',{q({'unit':unit})}::jsonb);commit;")
        assert budget == {"count": 0}
    retained = snapshot(f, x)
    for field in ("graph", "results", "budgets", "usage"):
        assert retained[field] == after[field]
    cases.append({"case": "new-graph-uses-normal-budget-with-old-exhausted-budget-unchanged", "passed": True})


def bounded_lineage(f, x, after, cases):
    refusal(f, x, "COMMERCIAL_SUCCESSOR_NOT_SAFE",
            f"select app_private.fail_proposal_issuance({q(after['plan']['issuance_request_id'])},'MODEL_CORRECTION_EXHAUSTED');",
            body={**payload(x), "expected_revision": after["plan"]["revision"] + 1})
    cases.append({"case": "fresh-revision-retry-after-successor-exhaustion-cannot-create-second-budget", "passed": True})
    for operation in ("update app_private.commercial_successor_lineage set recovery_version=1", "delete from app_private.commercial_successor_lineage"):
        result = f.sql(operation + " where plan_id=" + q(x["plan"]["id"]), check=False)
        assert result.returncode and "COMMERCIAL_SUCCESSOR_LINEAGE_IMMUTABLE" in result.stderr
        assert snapshot(f, x) == after
    cases.append({"case": "lineage-cannot-be-updated-or-deleted-even-by-local-fixture-admin", "passed": True})
    assert "recovery_commercial_successor_lineage" in f.value("select to_jsonb(app_private.backup_tables())")
    cases.append({"case": "spent-lineage-is-in-existing-backup-registry", "passed": True})


def distinct_key_race(f, cases):
    x = setup(f)
    before = snapshot(f, x)
    raced = f.race([f.command_sql("generation.retry", payload(x)) for _ in range(2)])
    assert sum(result.returncode == 0 for result in raced) == 1, [result.stderr for result in raced]
    assert all(result.returncode == 0 or "REVISION_CONFLICT" in result.stderr for result in raced)
    retained_work(f, x, before)
    cases.append({"case": "different-key-actual-lock-race-uses-plan-revision-and-once-only-lineage", "passed": True})


def archive_roundtrip(f, cases):
    before = f.value("select jsonb_agg(to_jsonb(l) order by id) from app_private.commercial_successor_lineage l")
    manifest = rpc(f, "workspace_backup_manifest")
    archive = []
    for start in range(0, len(manifest["rows"]), 15):
        archive += rpc(f, "workspace_backup_rows", ([row["key"] for row in manifest["rows"][start:start + 15]],))
    assert sum(row["key"].startswith("recovery_commercial_successor_lineage/") for row in archive) == len(before)
    target = PostgresFixture(container=f.container).start()
    try:
        restore = rpc(target, "begin_workspace_restore", (manifest, True))
        for start in range(0, len(archive), 10):
            rpc(target, "stage_restore_rows", (restore["id"], archive[start:start + 10]))
        for item in restore["files"]:
            rpc(target, "complete_restore_file", (item["id"], OWNER, item["content_hash"], item["expected_size"]), service=True)
        result = rpc(target, "commit_workspace_restore", (restore["id"],))
        assert result["state"] == "committed"
        after = target.value("select jsonb_agg(to_jsonb(l) order by id) from app_private.commercial_successor_lineage l")
        assert after == [{**row, "workspace_id": target.workspace} for row in before]
        assert rpc(target, "commit_workspace_restore", (restore["id"],))["state"] == "committed"
        assert target.value("select jsonb_agg(to_jsonb(l) order by id) from app_private.commercial_successor_lineage l") == after
        denied = target.sql(f"begin;set local role authenticated;set local request.jwt.claim.sub={q(OWNER)};"
                            f"select public.begin_workspace_restore({q(manifest)}::jsonb,true);commit;", check=False)
        assert denied.returncode and "RESTORE_TARGET_NOT_EMPTY" in denied.stderr
        cases.append({"case": "canonical-archive-roundtrip-retains-spent-lineage-proof-and-refuses-nonempty-restore", "passed": True,
                      "storage_bytes_exercised": False})
    finally:
        target.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    f = PostgresFixture()
    cases = []
    try:
        f.start()
        fingerprints = schema_fingerprints(f)
        dispatcher_fixture(f)
        x = setup(f)
        print(json.dumps({"fixture_ready": True, "completed_drafts": 17}), flush=True)
        authority_cases(f, x, cases)
        print(json.dumps({"authority_cases": len(cases)}), flush=True)
        proof_cases(f, x, cases)
        ordinary_retry(f, x, cases)
        partial_rollback(f, x, cases)
        revocation_race(f, x, cases)
        after, child, job = success_and_replay(f, x, cases)
        bounded_lineage(f, x, after, cases)
        worker_fence(f, x, after, child, job, cases)
        distinct_key_race(f, cases)
        archive_roundtrip(f, cases)
        receipt = f.receipt(cases)
        receipt.update({"passed": True, "production_calls": 0, "provider_calls": 0, "cleanup_confirmed": False,
                        "schema_fingerprints": fingerprints,
                        "limitations": ["Isolated schema fingerprints include fixture OIDs/roles; production readback is independent.",
                                        "Auth and Storage SQL stubs; archive file verification tests the service RPC, not physical Storage bytes.",
                                        "Only external dispatcher side effects are replaced; no HTTP worker/provider generation is exercised."]})
    finally:
        f.close()
    receipt["cleanup_confirmed"] = True
    if args.receipt:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"passed": True, "cases": len(cases), "cleanup_confirmed": True}))


if __name__ == "__main__":
    main()
