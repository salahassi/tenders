#!/usr/bin/env python3
"""Synthetic W07 concurrency checks using the shared isolated PostgreSQL harness."""
import argparse
import hashlib
import json
from pathlib import Path
import uuid
from postgres_races import PostgresFixture, OWNER, literal


def prepare(f, name, active=False):
    # Separate synthetic workflows in this one disposable database.
    f.sql("update public.jobs set status='canceled',lease_token=null,lease_until=null where status not in ('succeeded','canceled')")
    opportunity = f.opportunity()
    doc = f.upload(opportunity)
    f.command("document.confirm", {"id": doc["id"], "expected_revision": doc["revision"]})
    f.command("proposal.generate", {"id": opportunity["id"], "expected_revision": opportunity["revision"]})
    job = f.value("select public.claim_backend_job()")
    f.sql(f"select public.fail_generation({literal(job['id'])},{literal(job['lease_token'])},'MODEL_CORRECTION_EXHAUSTED',null,null)")
    routing = {"model_routing": {"mode": "round_robin"}}
    f.sql(f"update public.jobs set checkpoint=checkpoint||{literal(routing)}::jsonb where id={literal(job['id'])}")
    current = f.value(f"select to_jsonb(j) from public.jobs j where id={literal(job['id'])}")
    deadline = "now()+interval '20 minutes'" if active else "now()-interval '1 second'"
    receipt = f.value(f"""insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,
 application_day,settings_revision,reserved_input,reserved_output,state,error_code,remote_request_id,remote_deadline,remote_project_ref,created_by,created_at)
 values({literal(f.workspace)},{literal(job['id'])},{literal(job['lease_token'])},{literal('synthetic:'+name)},'openai','synthetic-model',
 {literal('a'*64)},current_date,1,100,100,'unknown','MODEL_NETWORK_UNCERTAIN','synthetic-remote',{deadline},'synthetic-project',{literal(OWNER)},now()-interval '20 minutes') returning to_jsonb(provider_usage)""")
    thread = hashlib.sha256(name.encode()).hexdigest()
    f.sql(f"insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task) values({literal(thread)},{literal(f.workspace)},{literal(job['id'])},{literal('b'*64)},'analyze_chunk');"
          f"insert into app_private.model_graph_budgets(thread_id,unit,candidates) values({literal(thread)},'writer',3)")
    body = {"id": job["id"], "expected_revision": current["revision"], "action": "retry", "reason": "Synthetic guarded recovery race"}
    return current, receipt, thread, body


def invariant(f, receipt, thread):
    assert f.value(f"select to_jsonb(u) from public.provider_usage u where id={literal(receipt['id'])}") == receipt
    assert f.scalar(f"select candidates from app_private.model_graph_budgets where thread_id={literal(thread)} and unit='writer'") == "3"


def count(f, job, action):
    return int(f.scalar(f"select count(*) from public.audit_events where entity_id={literal(job['id'])} and action={literal(action)}"))


def run(f):
    cases = []
    for name, same_key in [("same-idempotency-key", True), ("different-keys-same-revision", False)]:
        job, receipt, thread, body = prepare(f, name)
        first_key = str(uuid.uuid4())
        statements = [f.command_sql("job.action", body, first_key),
                      f.command_sql("job.action", body, first_key if same_key else str(uuid.uuid4()))]
        results = f.race(statements)
        successes = [r for r in results if r.returncode == 0]
        assert len(successes) == (2 if same_key else 1), [r.stderr for r in results]
        if same_key:
            assert json.loads(successes[0].stdout) == json.loads(successes[1].stdout)
            assert f.command("job.action", body, first_key) == json.loads(successes[0].stdout)
        else:
            assert all("REVISION_CONFLICT" in r.stderr for r in results if r.returncode)
        assert count(f, job, "model.usage_recovery") == 1
        assert count(f, job, "job.action") == 1
        current = f.value(f"select to_jsonb(j) from public.jobs j where id={literal(job['id'])}")
        assert current["status"] == "queued" and current["revision"] == job["revision"] + 1
        assert current["checkpoint"] == job["checkpoint"]
        invariant(f, receipt, thread)
        cases.append({"case": name, "passed": True, "contenders_observed_waiting": 2,
                      "recovery_audit_events": 1, "job_action_events": 1, "unknown_usage_unchanged": True,
                      "exhausted_writer_allowance_unchanged": True})
    job, receipt, thread, body = prepare(f, "active-remote", active=True)
    results = f.race([f.command_sql("job.action", body), f.command_sql("job.action", body)])
    assert all(r.returncode and "USAGE_REVIEW_REQUIRED" in r.stderr for r in results)
    assert count(f, job, "model.usage_recovery") == 0 and count(f, job, "job.action") == 0
    assert f.value(f"select to_jsonb(j) from public.jobs j where id={literal(job['id'])}") == job
    invariant(f, receipt, thread)
    cases.append({"case": "active-remote-refuses-both", "passed": True, "contenders_observed_waiting": 2,
                  "recovery_audit_events": 0, "job_action_events": 0, "unknown_usage_unchanged": True})
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path)
    parser.add_argument("--container")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    f = PostgresFixture(repository=args.repository, container=args.container).start()
    try:
        result = f.receipt(run(f))
        if args.output:
            args.output.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps({"passed": len(result["cases"]), "level": result["level"], "database": f.database}))
    finally:
        f.close()

if __name__ == "__main__":
    main()
