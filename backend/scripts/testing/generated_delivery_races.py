#!/usr/bin/env python3
"""Synthetic SQL publication boundary races, not model/semantic qualification."""
import json,uuid,hashlib,argparse
from pathlib import Path
from postgres_races import PostgresFixture,OWNER,literal

from generated_delivery_fixture import setup

def run(f):
 cases=[]
 o,p,sql=setup(f);r=f.race([sql,sql]);ok=[x for x in r if x.returncode==0]
 assert len(ok)==1 and all('STALE_LEASE' in x.stderr for x in r if x.returncode),[x.stderr for x in r]
 s=json.loads(ok[0].stdout)
 assert f.scalar(f"select count(*) from public.proposal_delivery_snapshots where plan_id={literal(p)} and payload->>'version'='3'")=='1'
 assert f.scalar(f"select count(*) from public.audit_events where action='delivery.generated_projected' and entity_id={literal(s['id'])}")=='1'
 assert f.scalar(f"select count(*) from public.jobs where type='render_delivery' and entity_id={literal(s['id'])}")=='1'
 cases.append({'case':'duplicate-publication-cas','passed':True,'contenders_observed_waiting':2,'snapshots':1,'audit_events':1,'render_jobs':1})
 o,p,sql=setup(f);r=f.race([sql,sql],before_release=f"update public.opportunities set description=description||' Buyer changed the scope.' where id={literal(o['id'])};")
 assert all(x.returncode and 'STALE_INPUT' in x.stderr for x in r),[x.stderr for x in r]
 assert f.scalar(f"select count(*) from public.proposal_delivery_snapshots where plan_id={literal(p)} and payload->>'version'='3'")=='0'
 cases.append({'case':'source-edited-while-waiting','passed':True,'contenders_observed_waiting':2,'snapshots':0})
 f.sql(f"update public.jobs set status='canceled',lease_token=null,lease_until=null where entity_id={literal(p)} and type='prepare_generated_delivery';")
 o,p,sql=setup(f);r=f.race([sql,sql],before_release=f"update public.memberships set active=false where workspace_id={literal(f.workspace)} and user_id={literal(OWNER)};")
 assert all(x.returncode and 'ROLE_FORBIDDEN' in x.stderr for x in r),[x.stderr for x in r]
 assert f.scalar(f"select count(*) from public.proposal_delivery_snapshots where plan_id={literal(p)} and payload->>'version'='3'")=='0'
 cases.append({'case':'actor-revoked-while-waiting','passed':True,'contenders_observed_waiting':2,'snapshots':0})
 return cases

if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--repository',type=Path,default=Path(__file__).resolve().parents[3]);parser.add_argument('--container',required=True);parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
 f=PostgresFixture(repository=args.repository,container=args.container).start()
 try:
  result=f.receipt(run(f));result['qualification']='Synthetic SQL structural publication boundaries only; accepted model/verifier records are fixture data, not live model qualification.';args.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'passed':len(result['cases']),'level':result['level'],'qualification':result['qualification']}))
 finally:f.close()
