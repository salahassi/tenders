#!/usr/bin/env python3
"""Synthetic Owner applicability CAS/replay/current-view checks in real PostgreSQL."""
import argparse
import json
from pathlib import Path
import uuid
from postgres_races import PostgresFixture, OWNER, literal

def prepare(f):
    opportunity=f.opportunity('Synthetic buyer requires an optional approval extension.')
    ctx=f.value(f"begin;set local request.jwt.claim.sub={literal(OWNER)};select public.source_review_context({literal(opportunity['id'])});commit;")
    source=ctx['sources'][0]
    f.command('source.authority.review',{'opportunity_id':opportunity['id'],**source['reference'],'expected_revision':0,'role':'buyer_rfp','status':'confirmed','supersedes':None,'precedence':0,'reason':'Synthetic current buyer authority.'})
    ctx=f.value(f"begin;set local request.jwt.claim.sub={literal(OWNER)};select public.source_review_context({literal(opportunity['id'])});commit;")
    span=ctx['source_evidence']['spans'][0]
    review=f.command('source.obligation.review',{'opportunity_id':opportunity['id'],'review_id':None,'expected_revision':0,'spans':[span],'semantics':{'modality':'permitted','actor':'supplier','negated':False,'conditions':[],'exceptions':[],'consequences':[],'quantities':[],'dates':[]},'status':'confirmed','reason':'Synthetic current reviewed original option.'})
    req=f.value(f"select app_private.source_obligation_inventory({literal(f.workspace)},{literal(opportunity['id'])},array[{literal(review['review_id'])}::uuid])->0")
    proposal,plan,version,requirement=(str(uuid.uuid4()) for _ in range(4))
    frozen={'source_contract_version':1,'proposal_consistency_version':1,'source_evidence':{'version':1,'spans':[span],'reviews':[]},'notice':ctx['sources'][0],'blocks':[],'knowledge':[],'reviews':[],'rates':[],'input_materials':{'documents':[]}}
    f.sql(f"insert into public.proposals(id,workspace_id,opportunity_id,title,created_by) values({literal(proposal)},{literal(f.workspace)},{literal(opportunity['id'])},'Synthetic proposal',{literal(OWNER)});")
    f.sql(f"insert into public.generation_plans(id,workspace_id,opportunity_id,proposal_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by) select {literal(plan)},id,{literal(opportunity['id'])},{literal(proposal)},'proposal','completed','completed',evidence_revision,repeat('a',64),{literal(frozen)}::jsonb,{literal(OWNER)} from public.workspaces where id={literal(f.workspace)};")
    f.sql(f"insert into public.proposal_versions(id,workspace_id,proposal_id,ordinal,content_hash,package_hash,plan_id,evidence_revision,created_by) select {literal(version)},id,{literal(proposal)},1,repeat('a',64),repeat('b',64),{literal(plan)},evidence_revision,{literal(OWNER)} from public.workspaces where id={literal(f.workspace)};update public.proposals set active_version_id={literal(version)} where id={literal(proposal)};")
    f.sql(f"insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,created_by) values({literal(f.workspace)},{literal(version)},'approach','Approach','Synthetic base scope.',0,{literal(OWNER)});")
    f.sql(f"insert into public.requirements(id,workspace_id,plan_id,opportunity_id,text,category,mandatory,source_refs,source_semantics,interpretation,acceptance_evidence,created_by) values({literal(requirement)},{literal(f.workspace)},{literal(plan)},{literal(opportunity['id'])},{literal(req['text'])},'functional',false,{literal(req['source_refs'])}::jsonb,{literal(req['source_semantics'])}::jsonb,'Synthetic optional scope.','Review original option.',{literal(OWNER)});")
    binding=f.scalar(f"select app_private.requirement_applicability_binding({literal(f.workspace)},{literal(version)},{literal(requirement)})")
    return version,{'proposal_version_id':version,'requirement_id':requirement,'expected_revision':0,'expected_applicability_binding':binding,'status':'not_applicable_approved','section_keys':[],'evidence_refs':[],'rationale':'Owner explicitly excludes this optional scope from the current exact proposal.'}

def run(f):
    cases=[]
    for same_key in (True,False):
        version,body=prepare(f);key=str(uuid.uuid4())
        results=f.race([f.command_sql('compliance.save',body,key),f.command_sql('compliance.save',body,key if same_key else str(uuid.uuid4()))])
        ok=[r for r in results if not r.returncode]
        assert len(ok)==(2 if same_key else 1),[r.stderr for r in results]
        if same_key:assert json.loads(ok[0].stdout)==json.loads(ok[1].stdout)
        else:assert all('REVISION_CONFLICT' in r.stderr for r in results if r.returncode)
        approved=f.value(f"select app_private.approved_requirement_exclusions({literal(f.workspace)},{literal(version)})")
        assert len(approved)==1 and approved[0]['binding_hash']==body['expected_applicability_binding']
        assert f.scalar(f"select count(*) from public.audit_events where action='compliance.save' and entity_id={literal(approved[0]['approval_id'])}")=="1"
        cases.append({'case':'same-key-replay' if same_key else 'same-revision-different-keys','passed':True,'contenders_observed_waiting':2,'approved_exclusions':1})
    version,body=prepare(f)
    results=f.race([f.command_sql('compliance.save',body),f.command_sql('compliance.save',body)],before_release=f"update public.proposal_sections set body=body||' Late content change.' where proposal_version_id={literal(version)};")
    assert all(r.returncode and 'STALE_SOURCE_APPLICABILITY' in r.stderr for r in results),[r.stderr for r in results]
    assert f.value(f"select app_private.approved_requirement_exclusions({literal(f.workspace)},{literal(version)})")==[]
    cases.append({'case':'unreviewed-late-edit-before-lock-release','passed':True,'contenders_observed_waiting':2,'approved_exclusions':0})
    version,body=prepare(f)
    results=f.race([f.command_sql('compliance.save',body),f.command_sql('compliance.save',body)],before_release=f"update public.memberships set active=false where workspace_id={literal(f.workspace)} and user_id={literal(OWNER)};")
    assert all(r.returncode and ('ROLE_FORBIDDEN' in r.stderr or 'ACCESS_PENDING' in r.stderr) for r in results),[r.stderr for r in results]
    assert f.value(f"select app_private.approved_requirement_exclusions({literal(f.workspace)},{literal(version)})")==[]
    cases.append({'case':'owner-revoked-before-lock-release','passed':True,'contenders_observed_waiting':2,'approved_exclusions':0})
    return cases

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--repository',type=Path);parser.add_argument('--container');parser.add_argument('--output',type=Path);args=parser.parse_args()
    f=PostgresFixture(repository=args.repository,container=args.container).start()
    try:
        result=f.receipt(run(f))
        if args.output:args.output.write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps({'passed':len(result['cases']),'level':result['level']}))
    finally:f.close()
if __name__=='__main__':main()
