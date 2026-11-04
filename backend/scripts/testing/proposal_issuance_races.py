#!/usr/bin/env python3
"""Real PostgreSQL deadline/receipt ordering. Synthetic structural fixtures only.

No provider calls or semantic qualification: accepted receipts are test records.
All contenders must be observed waiting on the workspace lock before release.
"""
import argparse,json,uuid
from pathlib import Path
from postgres_races import PostgresFixture,literal
from generated_delivery_fixture import setup


def rendering(f, remaining=600):
    f.sql("update public.jobs set status='canceled',lease_token=null,lease_until=null where status in ('queued','running','retry_wait','blocked')")
    o,p,publish=setup(f,remaining_seconds=remaining)
    s=f.value(publish);j=f.value('select public.claim_backend_local_job_v4()')
    assert j['entity_id']==s['id'],j
    c=f.value(f"select public.delivery_export_context({literal(j['id'])},{literal(j['lease_token'])})")
    r=f.value(f"select to_jsonb(r) from public.proposal_issuance_requests r join public.generation_plans p on p.issuance_request_id=r.id where p.id={literal(p)}")
    return s,j,c['artifacts'],r


def complete_sql(j,a):
    return f"select public.complete_delivery_artifact({literal(j['id'])},{literal(j['lease_token'])},{literal(a['id'])},repeat('a',64),321)"


def ready(f,j,artifacts):
    for a in artifacts:f.value(complete_sql(j,a))


def state(f,r):
    return f.value(f"select to_jsonb(r) from public.proposal_issuance_requests r where id={literal(r['id'])}")


def finish_sql(j):return f"select public.finish_delivery_export({literal(j['id'])},{literal(j['lease_token'])})"
def expire_sql(f):return f"begin;select 1 from public.workspaces where id={literal(f.workspace)} for update;select app_private.expire_proposal_issuances({literal(f.workspace)});commit;"
def wait_deadline(r):return f"select pg_sleep(greatest(0,extract(epoch from (select deadline_at-clock_timestamp() from public.proposal_issuance_requests where id={literal(r['id'])})))+0.03);"


def run(f):
    cases=[]
    boundaries=f.value("select jsonb_build_array(app_private.issuance_deadline_reached('2026-01-01 00:10:00Z','2026-01-01 00:09:59.999Z'),app_private.issuance_deadline_reached('2026-01-01 00:10:00Z','2026-01-01 00:10:00Z'),app_private.issuance_deadline_reached('2026-01-01 00:10:00Z','2026-01-01 00:10:00.001Z'))")
    assert boundaries==[False,True,True]
    cases.append({'case':'SQL exact599.999/600/600.001 boundary','passed':True,'reached':boundaries})
    s,j,a,r=rendering(f);ready(f,j,a)
    results=f.race([finish_sql(j),expire_sql(f)])
    assert all(x.returncode==0 for x in results),[x.stderr for x in results]
    observed=state(f,r)
    assert observed['outcome']=='issued' and observed['issued_snapshot_id']==s['id'] and observed['completed_at']<observed['deadline_at'],observed
    cases.append({'case':'complete package before deadline wins against concurrent expiry scan','passed':True,'contenders_observed_waiting':2})
    s,j,a,r=rendering(f,8);ready(f,j,a)
    immutable=f.value(f"select jsonb_agg(to_jsonb(a) order by id) from public.proposal_delivery_artifacts a where snapshot_id={literal(s['id'])}")
    results=f.race([finish_sql(j),expire_sql(f)],before_release=wait_deadline(r))
    observed=state(f,r)
    assert observed['outcome']=='failed' and observed['error_code']=='PROPOSAL_ISSUANCE_TIMEOUT' and observed['issued_snapshot_id'] is None,observed
    assert observed['completed_at']==observed['deadline_at']
    assert f.value(f"select jsonb_agg(to_jsonb(a) order by id) from public.proposal_delivery_artifacts a where snapshot_id={literal(s['id'])}")==immutable
    cases.append({'case':'expiry and final completion wait past deadline; no false issuance, ready bytes retained','passed':True,'contenders_observed_waiting':2})
    s,j,a,r=rendering(f,8)
    results=f.race([complete_sql(j,a[-1])],before_release=wait_deadline(r))
    assert results[0].returncode and 'PROPOSAL_ISSUANCE_TIMEOUT' in results[0].stderr,results[0].stderr
    assert f.scalar(f"select status from public.proposal_delivery_artifacts where id={literal(a[-1]['id'])}")=='pending'
    f.sql(f"select public.fail_delivery_export({literal(j['id'])},{literal(j['lease_token'])},'PROPOSAL_ISSUANCE_TIMEOUT')")
    assert state(f,r)['outcome']=='failed'
    cases.append({'case':'final artifact receipt rechecks absolute deadline after workspace lock','passed':True,'contenders_observed_waiting':1})
    s,j,a,r=rendering(f);ready(f,j,a)
    results=f.race([finish_sql(j)],before_release=f"select app_private.fail_proposal_issuance({literal(r['id'])},'AI_AGENTS_UNAVAILABLE');")
    observed=state(f,r)
    assert results[0].returncode and observed['outcome']=='failed' and observed['error_code']=='AI_AGENTS_UNAVAILABLE' and observed['completed_at']<observed['deadline_at'],observed
    cases.append({'case':'known terminal provider failure rejects waiting completion before deadline','passed':True,'contenders_observed_waiting':1})
    # Explicit new authorization uses already accepted version/ready bytes only.
    model_job=f.scalar(f"select job_id from public.generation_steps where plan_id={literal(r['plan_id'])} limit 1")
    usage=str(uuid.uuid4())
    f.sql(f"insert into public.provider_usage(id,workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by) select {literal(usage)},workspace_id,id,gen_random_uuid(),{literal(usage)},'openai','synthetic-model',input_hash,current_date,1,100,1000,'unknown',created_by from public.jobs where id={literal(model_job)}")
    unknown=f.value(f"select to_jsonb(u) from public.provider_usage u where id={literal(usage)}")
    revision=f.scalar(f"select delivery_revision from public.proposals where id={literal(s['proposal_id'])}")
    command={'snapshot_id':s['id'],'expected_delivery_revision':int(revision)};key=str(uuid.uuid4())
    response=f.command('delivery.snapshot.retry',command,key)
    assert f.command('delivery.snapshot.retry',command,key)==response
    newer=f.value(f"select to_jsonb(r) from public.proposal_issuance_requests r join public.generation_plans p on p.issuance_request_id=r.id where p.id={literal(r['plan_id'])}")
    assert newer['id']!=r['id'] and newer['accepted_at']>r['accepted_at'] and state(f,r)==observed
    for worker in (1,2,3):
        assert f.scalar(f"begin;set local app.worker_executor='{worker}';select public.claim_backend_job();commit;")==""
    retry=f.value('select public.claim_backend_local_job_v4()')
    assert retry['entity_id']==s['id'] and retry['checkpoint']['issuance_request_id']==newer['id']
    f.value(f"select public.delivery_export_context({literal(retry['id'])},{literal(retry['lease_token'])})")
    f.value(finish_sql(retry))
    assert state(f,newer)['outcome']=='issued'
    assert f.value(f"select to_jsonb(u) from public.provider_usage u where id={literal(usage)}")==unknown
    cases.append({'case':'explicit local retry creates one new deadline; old workers denied; unknown paid receipt byte-exact','passed':True,'old_worker_versions_denied':[1,2,3]})
    return cases


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--repository');p.add_argument('--container');p.add_argument('--output',required=True);args=p.parse_args()
    f=PostgresFixture(repository=args.repository,container=args.container).start()
    try:
        cases=run(f);Path(args.output).write_text(json.dumps(f.receipt(cases),indent=2)+'\n');print(json.dumps({'passed':len(cases),'receipt':args.output}))
    finally:f.close()
if __name__=='__main__':main()
