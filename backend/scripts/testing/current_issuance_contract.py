#!/usr/bin/env python3
"""Synthetic legacy-plan successor admission against real PostgreSQL."""
import argparse,json,uuid
from pathlib import Path
from postgres_races import PostgresFixture,literal
from generated_delivery_fixture import setup


def make_legacy(f,p):
    # Test-only pre-call representation of an old immutable request contract.
    f.sql(f"update public.generation_plans set frozen_context=frozen_context-array['generated_delivery_version','proposal_consistency_version'] where id={literal(p)}")
    return f.value(f"select jsonb_build_object('frozen',frozen_context,'hash',input_hash) from public.generation_plans where id={literal(p)}")


def assert_guard(f,p,operation,payload,next_operation):
    before=f.value(f"select to_jsonb(p) from public.generation_plans p where id={literal(p)}")
    count=f.scalar('select count(*) from public.proposal_issuance_requests')
    result=f.sql(f.command_sql(operation,payload),False)
    assert result.returncode and 'PROPOSAL_CURRENT_CONTRACT_REQUIRED' in result.stderr and next_operation in result.stderr,result.stderr
    assert f.value(f"select to_jsonb(p) from public.generation_plans p where id={literal(p)}")==before
    assert f.scalar('select count(*) from public.proposal_issuance_requests')==count


def run(f):
    cases=[]
    o=f.opportunity();f.upload(o)
    payload={'id':o['id'],'expected_revision':o['revision']};key=str(uuid.uuid4())
    p=f.command('proposal.generate',payload,key)
    legacy=make_legacy(f,p['id'])
    assert f.command('proposal.generate',payload,key)==p
    current=f.value(f"select to_jsonb(p) from public.generation_plans p where id={literal(p['id'])}")
    assert_guard(f,p['id'],'generation.retry',{'id':p['id'],'expected_revision':current['revision']},'proposal.generate')
    assert_guard(f,p['id'],'proposal.generate',payload,'proposal.generate')
    job=f.value(f"select to_jsonb(j) from public.jobs j join public.generation_steps s on s.job_id=j.id where s.plan_id={literal(p['id'])} order by s.ordinal limit 1")
    assert_guard(f,p['id'],'job.action',{'id':job['id'],'expected_revision':job['revision'],'action':'retry','reason':'Explicit current-contract successor'},'proposal.generate')
    f.command('generation.cancel',{'id':p['id'],'expected_revision':current['revision'],'reason':'Explicit current-contract successor'})
    new=f.command('proposal.generate',payload)
    successor=f.value(f"select to_jsonb(p) from public.generation_plans p where id={literal(new['id'])}")
    assert new['id']!=p['id'] and successor['frozen_context']['generated_delivery_version']==3 and successor['frozen_context']['proposal_consistency_version']==1
    assert f.value(f"select jsonb_build_object('frozen',frozen_context,'hash',input_hash) from public.generation_plans where id={literal(p['id'])}")==legacy
    cases.append({'case':'legacy no-active-version guard retains replay; explicit cancel and generate creates current successor','passed':True})
    f.sql("update public.jobs set status='canceled',lease_token=null,lease_until=null where status in ('queued','running','blocked','retry_wait')")
    o,p,publish=setup(f)
    f.upload(o)
    legacy=make_legacy(f,p)
    current=f.value(f"select to_jsonb(p) from public.generation_plans p where id={literal(p)}")
    assert_guard(f,p,'generation.retry',{'id':p,'expected_revision':current['revision']},'proposal.regenerate')
    proposal=f.value(f"select to_jsonb(p) from public.proposals p where id={literal(current['proposal_id'])}")
    new=f.command('proposal.regenerate',{'id':proposal['id'],'expected_revision':proposal['revision'],'base_version_id':proposal['active_version_id'],'input_hash':'f'*64})
    successor=f.value(f"select to_jsonb(p) from public.generation_plans p where id={literal(new['id'])}")
    assert new['id']!=p and successor['base_version_id']==proposal['active_version_id'] and successor['frozen_context']['generated_delivery_version']==3
    assert f.value(f"select jsonb_build_object('frozen',frozen_context,'hash',input_hash) from public.generation_plans where id={literal(p)}")==legacy
    cases.append({'case':'legacy accepted-version guard exposes explicit regenerate route without changing historical bytes','passed':True})
    return cases


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--repository');parser.add_argument('--container');parser.add_argument('--output',required=True);a=parser.parse_args()
    f=PostgresFixture(repository=a.repository,container=a.container).start()
    try:
        cases=run(f);receipt=f.receipt(cases);receipt['level']='real-postgresql-command-integration';Path(a.output).write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({'passed':len(cases),'receipt':a.output}))
    finally:f.close()
if __name__=='__main__':main()
