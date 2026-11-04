#!/usr/bin/env python3
"""Real PostgreSQL package allowance races; synthetic structural fixtures only."""
import argparse,json,uuid
from pathlib import Path
from postgres_races import PostgresFixture,literal
from generated_delivery_fixture import setup
CAP=262144000
PACKAGE=20971520

def scalar_int(f,query):return int(f.scalar(query))
def used(f):return scalar_int(f,f"select app_private.storage_reserved_bytes({literal(f.workspace)})")
def state(f,r):return f.value(f"select to_jsonb(r) from public.proposal_issuance_requests r where id={literal(r)}")
def request(f,p):return f.scalar(f"select issuance_request_id from public.generation_plans where id={literal(p)}")
def job(f,p):return f.value(f"select to_jsonb(j) from public.jobs j where entity_id={literal(p)} and type='prepare_generated_delivery' and status='running'")
def hold(j):return f"select app_private.ensure_issuance_file_capacity({literal(j['id'])},{literal(j['lease_token'])})"
def reset_pending(f):f.sql("update public.jobs set status='canceled',lease_token=null,lease_until=null where status in ('queued','running','blocked','retry_wait')")
def fill(f,free):
    delta=CAP-used(f)-free
    if delta>0:f.sql(f"insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values({literal(f.workspace)},{literal('synthetic-capacity-'+str(uuid.uuid4()))},{delta},'Synthetic ambiguous storage reservation')")

def run(f):
    cases=[]
    o,p,publish=setup(f);j=job(f,p);r=request(f,p);baseline=used(f);fill(f,PACKAGE)
    results=f.race([hold(j),hold(j)])
    assert all(x.returncode==0 for x in results),[x.stderr for x in results]
    assert state(f,r)['reserved_file_bytes']==PACKAGE and used(f)==CAP
    cases.append({'case':'two concurrent model allowance acquisitions reserve one20MiB envelope','passed':True,'contenders_observed_waiting':2})
    f.sql(f"select app_private.fail_proposal_issuance({literal(r)},'AI_AGENTS_UNAVAILABLE')")
    assert state(f,r)['reserved_file_bytes']==0 and used(f)==CAP-PACKAGE
    reset_pending(f);o,p,publish=setup(f);j=job(f,p);r=request(f,p)
    upload=f.command_sql('document.prepare',{'eligibility_attested':True,'kind':'rfp','opportunity_id':o['id'],'original_name':'synthetic-capacity.txt','mime_type':'text/plain','size':10485760,'hash':'a'*64})
    results=f.race([hold(j),upload])
    assert sum(x.returncode==0 for x in results)==1,[x.stderr for x in results]
    assert any('STORAGE_CAP_REACHED' in x.stderr for x in results)
    assert used(f)<=CAP
    cases.append({'case':'competing input reservation and future complete package serialize without overcommit','passed':True,'contenders_observed_waiting':2,'model_allowance_won':results[0].returncode==0})
    f.sql(f"select app_private.fail_proposal_issuance({literal(r)},'AI_AGENTS_UNAVAILABLE');delete from public.storage_cleanup_queue where storage_key like 'synthetic-capacity-%';")
    reset_pending(f);o,p,publish=setup(f);j=job(f,p);r=request(f,p);baseline=used(f);f.sql(hold(j));s=f.value(publish);render=f.value('select public.claim_backend_local_job_v4()')
    assert render['entity_id']==s['id'],render
    c=f.value(f"select public.delivery_export_context({literal(render['id'])},{literal(render['lease_token'])})")
    assert len(c['artifacts'])==1 and c['artifacts'][0]['reserved_bytes']==10485760
    assert state(f,r)['reserved_file_bytes']==10485760 and used(f)==baseline+PACKAGE
    f.value(f"select public.delivery_export_context({literal(render['id'])},{literal(render['lease_token'])})")
    assert state(f,r)['reserved_file_bytes']==10485760 and used(f)==baseline+PACKAGE
    a=c['artifacts'][0]
    f.value(f"select public.complete_delivery_artifact({literal(render['id'])},{literal(render['lease_token'])},{literal(a['id'])},repeat('a',64),321)")
    f.value(f"select public.finish_delivery_export({literal(render['id'])},{literal(render['lease_token'])})")
    assert state(f,r)['outcome']=='issued' and state(f,r)['reserved_file_bytes']==0 and used(f)==baseline+321
    cases.append({'case':'required artifact atomically receives held capacity once; issuance releases unused allowance only','passed':True,'ready_bytes_retained':321})
    reset_pending(f);o,p,publish=setup(f);j=job(f,p);r=request(f,p);f.sql(hold(j));s=f.value(publish);render=f.value('select public.claim_backend_local_job_v4()')
    f.sql(f"update public.opportunities set description='Synthetic changed source' where id={literal(o['id'])}")
    result=f.sql(f"select public.delivery_export_context({literal(render['id'])},{literal(render['lease_token'])})",False)
    assert result.returncode and ('STALE_INPUT' in result.stderr or 'DELIVERY_SOURCE_UNAVAILABLE' in result.stderr),result.stderr
    assert state(f,r)['reserved_file_bytes']==PACKAGE
    assert scalar_int(f,f"select coalesce(sum(reserved_bytes),0) from public.proposal_delivery_artifacts where snapshot_id={literal(s['id'])}")==0
    cases.append({'case':'source rejection leaves held allowance and unreserved artifact slots unchanged','passed':True})
    return cases

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--repository');parser.add_argument('--container');parser.add_argument('--output',required=True);a=parser.parse_args()
    f=PostgresFixture(repository=a.repository,container=a.container).start()
    try:
        cases=run(f);Path(a.output).write_text(json.dumps(f.receipt(cases),indent=2)+'\n');print(json.dumps({'passed':len(cases),'receipt':a.output}))
    finally:f.close()
if __name__=='__main__':main()
