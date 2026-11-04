#!/usr/bin/env python3
"""Synthetic-only real PostgreSQL artifact receipts/capacity/currentness races."""
import argparse
import json
import uuid
from pathlib import Path
from postgres_races import PostgresFixture, OWNER, literal


def run(f):
    cases = []
    def setup():
        opportunity = f.opportunity()
        snapshot = f.command('delivery.snapshot.prepare', {'opportunity_id': opportunity['id'], 'expected_revision': opportunity['revision']})
        job = f.value('select public.claim_backend_job_v3()')
        assert job['entity_id'] == snapshot['id']
        return opportunity, snapshot, job
    def context(job):
        return f.value(f"select public.delivery_export_context({literal(job['id'])},{literal(job['lease_token'])})")
    def complete(job, artifact, digest='a'*64):
        return f"select public.complete_delivery_artifact({literal(job['id'])},{literal(job['lease_token'])},{literal(artifact['id'])},{literal(digest)},321)"
    def finish(job):
        f.sql(f"select public.finish_delivery_export({literal(job['id'])},{literal(job['lease_token'])})")
    def block(job, code):
        f.sql(f"select public.fail_delivery_export({literal(job['id'])},{literal(job['lease_token'])},{literal(code)})")

    _, snapshot, job = setup()
    artifact = context(job)['artifacts'][0]
    raced = f.race([complete(job, artifact), complete(job, artifact)])
    assert all(r.returncode == 0 for r in raced), [r.stderr for r in raced]
    assert json.loads(raced[0].stdout) == json.loads(raced[1].stdout)
    assert f.scalar("select count(*) from public.audit_events where action='delivery.artifact.ready'") == '1'
    finish(job)
    cases.append({'case':'duplicate verified receipt commits once', 'passed':True, 'contenders_observed_waiting':2})

    _, _, job = setup()
    artifact = context(job)['artifacts'][0]
    raced = f.race([complete(job, artifact), complete(job, artifact, 'b'*64)])
    assert sorted(r.returncode == 0 for r in raced) == [False, True]
    assert any('IDEMPOTENCY_CONFLICT' in r.stderr for r in raced)
    finish(job)
    cases.append({'case':'competing immutable hashes cannot replace accepted bytes','passed':True,'contenders_observed_waiting':2})

    for mode, code in [('source','STALE_INPUT'),('membership','ROLE_FORBIDDEN'),('cancel','STALE_LEASE')]:
        opportunity, _, job = setup()
        artifact = context(job)['artifacts'][0]
        if mode == 'source':
            edit=f"update public.opportunities set description='Changed synthetic scope',revision=revision+1 where id={literal(opportunity['id'])};"
        elif mode == 'membership':
            edit=f"update public.memberships set active=false where workspace_id={literal(f.workspace)} and user_id={literal(OWNER)};"
        else:
            edit=f"update public.jobs set cancel_requested=true,status='canceled',lease_token=null,lease_until=null where id={literal(job['id'])};"
        raced=f.race([complete(job,artifact)],before_release=edit)
        assert raced[0].returncode and code in raced[0].stderr, raced[0].stderr
        assert f.scalar(f"select status from public.proposal_delivery_artifacts where id={literal(artifact['id'])}") == 'pending'
        if mode == 'membership': f.sql(f"update public.memberships set active=true where workspace_id={literal(f.workspace)} and user_id={literal(OWNER)}")
        if mode != 'cancel': block(job, code)
        cases.append({'case':mode+' change committed before receipt is rejected','passed':True,'contenders_observed_waiting':1})

    # Existing ambiguous reservations remain accounted. Fill only the remaining
    # capacity so one additional 10 MiB reservation fits, but two cannot.
    opportunity, _, job=setup()
    used=int(f.scalar(f"select app_private.storage_reserved_bytes({literal(f.workspace)})"))
    fill=262144000-used-15728640
    f.sql(f"insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values({literal(f.workspace)},'synthetic-capacity-race',{fill},'synthetic ambiguous bytes')")
    document={'eligibility_attested':True,'client_id':str(uuid.uuid4()),'kind':'rfp','opportunity_id':opportunity['id'],'original_name':'synthetic.txt','mime_type':'text/plain','size':10485760,'hash':'c'*64}
    raced=f.race([f"select public.delivery_export_context({literal(job['id'])},{literal(job['lease_token'])})",f.command_sql('document.prepare',document)])
    assert sorted(r.returncode==0 for r in raced)==[False,True],[(r.returncode,r.stderr) for r in raced]
    assert any('STORAGE_CAP_REACHED' in r.stderr for r in raced)
    final=int(f.scalar(f"select app_private.storage_reserved_bytes({literal(f.workspace)})"))
    assert final<=262144000
    cases.append({'case':'competing document and artifact capacity stays atomic','passed':True,'contenders_observed_waiting':2,'reserved_bytes':final,'cap_bytes':262144000})
    # Simulate the durable state left by a snapshot saved before the artifact
    # trigger existed. The separate PGlite case applies the actual two migrations.
    opportunity=f.opportunity()
    f.sql('alter table public.proposal_delivery_snapshots disable trigger enqueue_delivery_export')
    try:
        snapshot=f.command('delivery.snapshot.prepare', {'opportunity_id':opportunity['id'],'expected_revision':opportunity['revision']})
    finally:
        f.sql('alter table public.proposal_delivery_snapshots enable trigger enqueue_delivery_export')
    package=f.value(f"begin;set local request.jwt.claim.sub={literal(OWNER)};select public.delivery_package({literal(snapshot['id'])});commit;")
    assert package['status']=='blocked' and package['artifacts']==[] and package['job']['error_code']=='DELIVERY_NOT_QUEUED'
    retry={'snapshot_id':snapshot['id'],'expected_delivery_revision':package['snapshot']['delivery_revision']}
    raced=f.race([f.command_sql('delivery.snapshot.retry',retry),f.command_sql('delivery.snapshot.retry',retry)])
    assert sorted(r.returncode==0 for r in raced)==[False,True],[(r.returncode,r.stderr) for r in raced]
    assert any('REVISION_CONFLICT' in r.stderr for r in raced)
    assert f.scalar(f"select count(*) from public.jobs where type='render_delivery' and entity_id={literal(snapshot['id'])}")=='1'
    assert f.scalar(f"select count(*) from public.proposal_delivery_artifacts where snapshot_id={literal(snapshot['id'])} and reserved_bytes=0")=='1'
    assert f.scalar(f"select count(*) from public.audit_events where action='delivery.render.initialized' and entity_id={literal(snapshot['id'])}")=='1'
    cases.append({'case':'concurrent explicit initialization creates one missing queue bundle','passed':True,'contenders_observed_waiting':2})
    opportunity=f.opportunity()
    f.sql('alter table public.proposal_delivery_snapshots disable trigger enqueue_delivery_export')
    try:
        snapshot=f.command('delivery.snapshot.prepare', {'opportunity_id':opportunity['id'],'expected_revision':opportunity['revision']})
    finally:
        f.sql('alter table public.proposal_delivery_snapshots enable trigger enqueue_delivery_export')
    revision=int(f.scalar(f"select delivery_revision from public.proposals where id={literal(snapshot['proposal_id'])}"))
    demote=f"update public.memberships set role='Reviewer' where workspace_id={literal(f.workspace)} and user_id={literal(OWNER)};"
    raced=f.race([f.command_sql('delivery.snapshot.retry',{'snapshot_id':snapshot['id'],'expected_delivery_revision':revision})],before_release=demote)
    assert raced[0].returncode and 'ROLE_FORBIDDEN' in raced[0].stderr, raced[0].stderr
    assert f.scalar(f"select count(*) from public.jobs where type='render_delivery' and entity_id={literal(snapshot['id'])}")=='0'
    assert f.scalar(f"select count(*) from public.proposal_delivery_artifacts where snapshot_id={literal(snapshot['id'])}")=='0'
    f.sql(f"update public.memberships set role='Owner' where workspace_id={literal(f.workspace)} and user_id={literal(OWNER)}")
    cases.append({'case':'write-role demotion while waiting blocks missing queue initialization','passed':True,'contenders_observed_waiting':1})
    return cases

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--container');parser.add_argument('--output',required=True);args=parser.parse_args()
    f=PostgresFixture(container=args.container)
    try:
        f.start();cases=run(f);Path(args.output).write_text(json.dumps(f.receipt(cases),indent=2)+'\n');print(json.dumps({'passed':len(cases),'database':f.database,'output':args.output}))
    finally:f.close()
