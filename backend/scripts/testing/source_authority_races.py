#!/usr/bin/env python3
"""Synthetic W05 review CAS/idempotency/currentness under real PostgreSQL locks."""
import argparse
import json
from pathlib import Path
import uuid
from postgres_races import PostgresFixture, OWNER, literal

def context(f, opportunity):
    return f.value(f"begin;set local request.jwt.claim.sub={literal(OWNER)};select public.source_review_context({literal(opportunity['id'])});commit;")

def run(f):
    cases=[]
    for same_key in (True,False):
        opportunity=f.opportunity()
        source=context(f,opportunity)['sources'][0]
        payload={'opportunity_id':opportunity['id'],**source['reference'],'expected_revision':0,'role':'buyer_rfp','status':'confirmed','supersedes':None,'precedence':0,'reason':'Synthetic buyer identity review'}
        key=str(uuid.uuid4())
        results=f.race([f.command_sql('source.authority.review',payload,key),f.command_sql('source.authority.review',payload,key if same_key else str(uuid.uuid4()))])
        succeeded=[r for r in results if r.returncode==0]
        assert len(succeeded)==(2 if same_key else 1), [r.stderr for r in results]
        if same_key: assert json.loads(succeeded[0].stdout)==json.loads(succeeded[1].stdout)
        else: assert all('REVISION_CONFLICT' in r.stderr for r in results if r.returncode)
        assert f.scalar(f"select count(*) from public.source_authority_decisions where opportunity_id={literal(opportunity['id'])}")=='1'
        cases.append({'case':'same-key-replay' if same_key else 'same-revision-different-keys','passed':True,'contenders_observed_waiting':2,'appended_revisions':1})
    opportunity=f.opportunity()
    span=context(f,opportunity)['source_evidence']['spans'][0]
    tuple={'modality':'required','actor':'supplier','negated':False,'conditions':['after acceptance'],'exceptions':[],'consequences':[],'quantities':[],'dates':[]}
    payload={'opportunity_id':opportunity['id'],'review_id':None,'expected_revision':0,'spans':[span],'semantics':tuple,'status':'confirmed','reason':'Synthetic exact source review'}
    results=f.race([f.command_sql('source.obligation.review',payload),f.command_sql('source.obligation.review',payload)],before_release=f"update public.opportunities set description=description||' Changed condition.' where id={literal(opportunity['id'])};")
    assert all(r.returncode and 'SOURCE_SPAN_STALE' in r.stderr for r in results),[r.stderr for r in results]
    assert f.scalar(f"select count(*) from public.source_obligation_reviews where opportunity_id={literal(opportunity['id'])}")=='0'
    cases.append({'case':'source-edited-before-lock-release','passed':True,'contenders_observed_waiting':2,'appended_revisions':0})
    return cases

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository',type=Path)
    parser.add_argument('--container')
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    f=PostgresFixture(repository=args.repository,container=args.container).start()
    try:
        result=f.receipt(run(f))
        if args.output:args.output.write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps({'passed':len(result['cases']),'level':result['level']}))
    finally:f.close()
if __name__=='__main__':main()
