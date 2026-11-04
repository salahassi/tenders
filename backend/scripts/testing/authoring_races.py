#!/usr/bin/env python3
"""Real PostgreSQL authoring serialization, synthetic sources only; no models."""
import argparse,json,uuid
from pathlib import Path
from postgres_races import PostgresFixture,OWNER,literal


def run(f):
    cases=[]
    def call(op,payload,key=None):
        return f"select public.proposal_authoring_command({literal(OWNER)},{literal(op)},{literal(payload)}::jsonb,{literal(key or str(uuid.uuid4()))})"
    def setup():
        o=f.opportunity('Provide a synthetic operating manual and demonstrate its exception procedure.')
        s=f.command('delivery.snapshot.prepare',{'opportunity_id':o['id'],'expected_revision':o['revision']})
        rev=int(f.scalar(f"select delivery_revision from public.proposals where id={literal(s['proposal_id'])}"))
        a=f.value(call('open',{'snapshot_id':s['id'],'expected_delivery_revision':rev}))
        body=a['revision']['body']
        body['sections']=[{'key':'approach','title':'Operating manual approach','volume':'technical','content_blocks':[{'type':'paragraph','text':'We will walk through the operating procedure and record exception paths in the manual for review.'}],'requirement_ids':[],'evidence_refs':[],'company_claims':[],'assumptions':[],'questions':[]}]
        return o,s,a,body
    o,s,a,body=setup();key=str(uuid.uuid4());query=call('save',{'session_id':a['session']['id'],'expected_revision':1,'body':body},key)
    raced=f.race([query,query]);assert all(r.returncode==0 for r in raced),[r.stderr for r in raced]
    results=[json.loads(r.stdout) for r in raced];assert results[0]==results[1]
    assert f.scalar(f"select count(*) from public.proposal_authoring_revisions where session_id={literal(a['session']['id'])}")=='2'
    assert f.scalar(f"select count(*) from public.audit_events where entity_id={literal(a['session']['id'])} and action='proposal.authoring.save'")=='1'
    cases.append({'case':'same-key concurrent saves persist one revision and audit','passed':True,'contenders_observed_waiting':2})
    current=results[0];payload=dict(s['payload']);payload.update({'version':2,'content_state':'authored_draft','assurance_state':'unreviewed','substantive_complete':False,'authoring':{'session_id':a['session']['id'],'revision_id':current['revision']['id'],'body_hash':current['revision']['body_hash'],'review_id':None,'report':None}})
    key=str(uuid.uuid4());publish=f"select public.publish_authored_delivery({literal(OWNER)},{literal(a['session']['id'])},2,{literal(current['context_hash'])},{literal(payload)}::jsonb,null,{literal(key)})"
    raced=f.race([publish,publish]);assert all(r.returncode==0 for r in raced),[r.stderr for r in raced]
    assert json.loads(raced[0].stdout)==json.loads(raced[1].stdout)
    assert f.scalar(f"select count(*) from public.proposal_delivery_snapshots where proposal_id={literal(s['proposal_id'])} and payload->>'version'='2'")=='1'
    assert f.scalar(f"select count(*) from public.jobs where type='render_delivery' and entity_id={literal(json.loads(raced[0].stdout)['id'])}")=='1'
    cases.append({'case':'same-key publication replays after its own delivery pointer advance','passed':True,'contenders_observed_waiting':2})
    current=f.value(f"select public.proposal_authoring_context({literal(a['session']['id'])},{literal(OWNER)})")
    contenders=[call('save',{'session_id':a['session']['id'],'expected_revision':current['session']['revision'],'body':body}) for _ in range(2)]
    raced=f.race(contenders);assert sorted(r.returncode==0 for r in raced)==[False,True];assert any('REVISION_CONFLICT' in r.stderr for r in raced)
    cases.append({'case':'competing editor revisions allow one winner','passed':True,'contenders_observed_waiting':2})
    for mode,code in [('source','STALE_INPUT'),('membership','ROLE_FORBIDDEN')]:
        o,s,a,body=setup()
        mutation=(f"update public.opportunities set description='Changed synthetic requirement',revision=revision+1 where id={literal(o['id'])};" if mode=='source' else f"update public.memberships set active=false where workspace_id={literal(f.workspace)} and user_id={literal(OWNER)};")
        raced=f.race([call('save',{'session_id':a['session']['id'],'expected_revision':1,'body':body})],before_release=mutation)
        assert raced[0].returncode and code in raced[0].stderr,raced[0].stderr
        assert f.scalar(f"select count(*) from public.proposal_authoring_revisions where session_id={literal(a['session']['id'])}")=='1'
        if mode=='membership':f.sql(f"update public.memberships set active=true where workspace_id={literal(f.workspace)} and user_id={literal(OWNER)}")
        cases.append({'case':mode+' change while waiting rejects the save without content overwrite','passed':True,'contenders_observed_waiting':1})
    assert f.scalar('select count(*) from public.provider_usage')=='0'
    return cases

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--container');parser.add_argument('--output',required=True);args=parser.parse_args()
    fixture=PostgresFixture(repository=Path(__file__).resolve().parents[3],container=args.container)
    try:
        fixture.start();cases=run(fixture);Path(args.output).write_text(json.dumps(fixture.receipt(cases),indent=2)+'\n');print(json.dumps({'passed':len(cases),'receipt':args.output,'container':fixture.container}))
    finally:fixture.close()
