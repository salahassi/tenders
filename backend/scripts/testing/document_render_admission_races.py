#!/usr/bin/env python3
"""Synthetic PostgreSQL document-render admission, lease and queue-clock proof.

The primary cases use the unmodified public v4 claimer and singleton workspace.
The cross-workspace defense case explicitly relaxes only singleton uniqueness in
this disposable database, and calls the production next_fair_job under the same
workspace row lock/canonical lease transition. It is not multiworkspace product
support. Synthetic verified storage receipts isolate scheduling; real DOCX bytes,
physical process reap and hosted throughput have separate tests.
"""
import argparse
import json
from pathlib import Path
import subprocess
import uuid
from postgres_races import PostgresFixture, OWNER, literal
from ordinary_export_races import setup as export_setup


def enqueue(f, kind, workspace=None):
    return f.value(f"""insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint)
    values({literal(workspace or f.workspace)},{literal(kind)},gen_random_uuid(),'synthetic-admission','queued',{literal(OWNER)},
      '{{"model_executor":4,"minimum_worker_executor":4}}') returning to_jsonb(jobs)""")


def finish(f, job):
    f.sql(f"update public.jobs set status='succeeded',lease_token=null,lease_until=null,revision=revision+1 where id={literal(job['id'])}")


def run(f):
    cases = []
    claim = "select coalesce(public.claim_backend_job_v4(),'null'::jsonb)"
    one = enqueue(f, 'render_delivery'); two = enqueue(f, 'render_export')
    results = f.race([claim, claim])
    assert all(r.returncode == 0 for r in results), [r.stderr for r in results]
    values = [json.loads(r.stdout) for r in results]
    active = next(v for v in values if v)
    assert sum(v is not None for v in values) == 1
    waiting = two if active['id'] == one['id'] else one
    assert f.value(f"select to_jsonb(j) from public.jobs j where id={literal(waiting['id'])}") == waiting
    cases.append({'case': 'public-claim-concurrent-mixed-render-single-lease', 'passed': True,
                  'contenders_observed_waiting': 2, 'running_render_leases': 1, 'waiting_row_unchanged': True})

    model = enqueue(f, 'model_probe'); projection = enqueue(f, 'prepare_generated_delivery')
    results = f.race([claim, claim])
    assert all(r.returncode == 0 for r in results), [r.stderr for r in results]
    values = [json.loads(r.stdout) for r in results]
    nonrender = next(v for v in values if v)
    assert sum(v is not None for v in values) == 1
    assert nonrender['id'] in (model['id'], projection['id'])
    assert f.scalar("select count(*) from public.jobs where status='running'") == '2'
    unclaimed = projection if nonrender['id'] == model['id'] else model
    assert f.value(f"select to_jsonb(j) from public.jobs j where id={literal(unclaimed['id'])}") == unclaimed
    cases.append({'case': 'public-concurrent-nonrender-claim-during-render', 'passed': True,
                  'contenders_observed_waiting': 2, 'render_leases': 1, 'nonrender_leases': 1,
                  'additional_nonrender_unchanged': True})
    finish(f, nonrender)
    finish(f, f.value(claim))
    f.sql(f"update public.jobs set lease_until=now()-interval '1 second' where id={literal(active['id'])}")
    results = f.race([claim, claim])
    assert all(r.returncode == 0 for r in results), [r.stderr for r in results]
    values = [json.loads(r.stdout) for r in results]
    assert sum(v is not None for v in values) == 1
    assert f.scalar("select count(*) from public.jobs where status='running' and lease_until>clock_timestamp()") == '1'
    cases.append({'case': 'public-expired-lease-recovery-concurrent-single-replacement', 'passed': True,
                  'contenders_observed_waiting': 2, 'valid_render_leases': 1})
    f.sql("update public.jobs set status='canceled',lease_token=null,lease_until=null where status in ('running','queued','retry_wait')")

    # Twelve actual accepted export requests: no model calls, no native renderer
    # throughput claim. Each service storage receipt is explicitly synthetic.
    for _ in range(12):
        _, _, payload = export_setup(f)
        f.command('export.package.prepare', payload)
    clocks_sql = "select coalesce(jsonb_agg(jsonb_build_object('id',id,'accepted_at',accepted_at,'deadline_at',deadline_at) order by id),'[]') from public.export_packages"
    clocks = f.value(clocks_sql)
    assert f.scalar("select count(*) from public.export_packages where deadline_at-accepted_at=interval '600 seconds'") == '12'
    jobs = set()
    for i in range(12):
        job = f.value(claim)
        assert job and job['type'] == 'render_export' and job['attempts'] == 1
        assert job['id'] not in jobs
        jobs.add(job['id'])
        queued_sql = "select coalesce(jsonb_agg(to_jsonb(j) order by id),'[]') from public.jobs j where type='render_export' and status='queued'"
        queued = f.value(queued_sql)
        assert len(queued) == 11-i
        for _ in range(3):
            assert f.value(claim) is None
        assert f.value(queued_sql) == queued
        assert all(j['attempts'] == 0 and j['failure_count'] == 0 and j['lease_token'] is None for j in queued)
        f.sql(f"select public.export_render_context({literal(job['id'])},{literal(job['lease_token'])})")
        slot = f.scalar(f"select id from public.export_package_volumes where package_id={literal(job['entity_id'])}")
        f.sql(f"select public.complete_export_package_volume({literal(job['id'])},{literal(job['lease_token'])},{literal(slot)},{literal('a'*64)},100);")
        f.sql(f"select public.finish_export_package({literal(job['id'])},{literal(job['lease_token'])})")
    assert f.value(claim) is None and f.value(clocks_sql) == clocks
    assert f.scalar("select count(*) from public.export_packages where status='ready'") == '12'
    cases.append({'case': 'public-twelve-package-burst-queue-simulation', 'passed': True,
                  'accepted_packages': 12, 'unique_leases': 12, 'original_600_second_clocks_unchanged': True,
                  'unclaimed_attempts': 0, 'storage_receipts': 'synthetic', 'native_throughput_measured': False})

    _, _, payload = export_setup(f)
    package = f.command('export.package.prepare', payload)
    old = f.value(claim)
    f.sql(f"update public.jobs set lease_until=now()-interval '1 second' where id={literal(old['id'])}")
    new = f.value(claim)
    assert new['id'] == old['id'] and new['lease_token'] != old['lease_token']
    fenced = f.sql(f"select public.export_render_context({literal(old['id'])},{literal(old['lease_token'])})", False)
    assert fenced.returncode and 'STALE_LEASE' in fenced.stderr, fenced.stderr
    f.sql(f"select public.export_render_context({literal(new['id'])},{literal(new['lease_token'])})")
    cases.append({'case': 'actual-package-recovered-lease-fences-old-renderer', 'passed': True,
                  'old_context_rejected': 'STALE_LEASE', 'new_context_allowed': True,
                  'physical_child_reap_proven_here': False})
    finish(f, new)

    # Global invariant defense, beyond today's singleton public deployment.
    f.sql("alter table public.workspaces drop constraint workspaces_singleton_key")
    other = f.scalar(f"insert into public.workspaces(name,created_by) values('Synthetic second workspace',{literal(OWNER)}) returning id")
    f.sql(f"insert into public.memberships(workspace_id,user_id,role,created_by) values({literal(other)},{literal(OWNER)},'Owner',{literal(OWNER)});")
    f.sql("""create function app_private.test_claim_workspace(w uuid) returns jsonb
    language plpgsql as $$declare j public.jobs;begin
      perform set_config('app.worker_executor','4',true);
      perform 1 from public.workspaces where id=w for update;
      j.id:=app_private.next_fair_job(w,false);
      select * into j from public.jobs where id=j.id;
      if j.id is null then return null;end if;
      update public.jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '180 seconds',revision=revision+1,updated_at=now() where id=j.id returning * into j;
      return to_jsonb(j);
    end$$;""")
    render_a = enqueue(f, 'render_delivery'); render_b = enqueue(f, 'render_export', other)
    holder = subprocess.Popen(f.psql_args(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, bufsize=1)
    try:
        holder.stdin.write(f"begin;select app_private.test_claim_workspace({literal(f.workspace)});\n\\echo HELD\n")
        holder.stdin.flush()
        while holder.stdout.readline().strip() != 'HELD':
            if holder.poll() is not None:
                raise RuntimeError('Uncommitted render holder exited: '+holder.stderr.read())
        # Other session cannot see the uncommitted running row. The transaction
        # advisory lock, not visible lease count or per-workspace index, blocks it.
        assert f.scalar('select app_private.document_render_slot_available()') == 't'
        assert f.value(f"select coalesce(app_private.test_claim_workspace({literal(other)}),'null'::jsonb)") is None
        assert f.value(f"select to_jsonb(j) from public.jobs j where id={literal(render_b['id'])}") == render_b
        model = enqueue(f, 'model_probe', other)
        work = f.value(f"select coalesce(app_private.test_claim_workspace({literal(other)}),'null'::jsonb)")
        assert work['id'] == model['id']
        projection = enqueue(f, 'prepare_generated_delivery', other)
        assert f.value(f"select coalesce(app_private.test_claim_workspace({literal(other)}),'null'::jsonb)") is None
        assert f.value(f"select to_jsonb(j) from public.jobs j where id={literal(projection['id'])}") == projection
        holder.stdin.write('commit;\n\\q\n'); holder.stdin.flush(); holder.wait(timeout=10)
    finally:
        if holder.poll() is None:
            holder.communicate('rollback;\n\\q\n', timeout=10)
    assert f.scalar('select app_private.document_render_slot_available()') == 'f'
    assert f.scalar("select count(*) from public.jobs where type in ('render_delivery','render_export') and status='running'") == '1'
    finish(f, render_a)
    assert f.value(f"select coalesce(app_private.test_claim_workspace({literal(other)}),'null'::jsonb)")['id'] == render_b['id']
    cases.append({'case': 'cross-workspace-uncommitted-render-global-mutex-with-independent-model-progress',
                  'passed': True, 'simultaneous_transactions': 2, 'uncommitted_render_invisible_to_contender': True,
                  'global_render_leases': 1, 'nonrender_progress_while_mutex_held': True,
                  'extra_nonrender_unchanged': True, 'singleton_unique_constraint_relaxed_only_in_fixture': True,
                  'production_selector_unchanged': True, 'lease_transition': 'canonical SQL in explicit-workspace test wrapper'})
    assert f.scalar('select count(*) from public.provider_usage') == '0'
    return cases


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument('--container', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    f = PostgresFixture(args.repository, args.container).start()
    try:
        cases = run(f)
        receipt = f.receipt(cases)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(receipt, indent=2)+'\n')
        print(json.dumps({'passed': len(cases), 'receipt': str(args.output)}))
    finally:
        f.close()
