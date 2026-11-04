#!/usr/bin/env python3
"""Synthetic real PostgreSQL ordinary-export authorization/capacity races.

No provider calls or hosted storage. DOCX/API bytes are covered separately by
ordinaryExportPipeline.integration.test.ts; these are multi-session DB guards.
"""
import argparse
import json
from pathlib import Path
import uuid
from postgres_races import PostgresFixture, OWNER, literal


def setup(f, separate=False):
    source = f.command('source.create', {'name': 'Synthetic export race', 'kind': 'manual'})
    o = f.command('opportunity.create', {'source_id': source['id'], 'title': 'Synthetic export scope', 'reference': 'R1', 'decision': 'shortlisted'})
    p, g, v = [str(uuid.uuid4()) for _ in range(3)]
    w = literal(f.workspace)
    f.sql(f"""
    insert into public.proposals(id,workspace_id,opportunity_id,title,created_by) values({literal(p)},{w},{literal(o['id'])},'Synthetic proposal',{literal(OWNER)});
    insert into public.generation_plans(id,workspace_id,opportunity_id,proposal_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by)
      select {literal(g)},{w},{literal(o['id'])},{literal(p)},'proposal','completed','completed',evidence_revision,repeat('a',64),app_private.delivery_input({w},{literal(o['id'])}),{literal(OWNER)} from public.workspaces where id={w};
    insert into public.proposal_versions(id,workspace_id,proposal_id,ordinal,content_hash,package_hash,plan_id,evidence_revision,separate_volumes,created_by)
      select {literal(v)},{w},{literal(p)},1,repeat('a',64),repeat('b',64),{literal(g)},evidence_revision,{str(separate).lower()},{literal(OWNER)} from public.workspaces where id={w};
    update public.proposals set active_version_id={literal(v)} where id={literal(p)};
    insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,created_by)
      values({w},{literal(v)},'approach','Workflow delivery','Configure the approval queue, test exception routing, and demonstrate the acceptance trace.',0,{literal(OWNER)});
    """)
    return o, v, {'proposal_version_id': v, 'expected_revision': 1, 'mode': 'draft'}


def run(f):
    cases = []
    o, v, payload = setup(f)
    results = f.race([f.command_sql('export.package.prepare', payload), f.command_sql('export.package.prepare', payload)])
    assert all(r.returncode == 0 for r in results), [r.stderr for r in results]
    values = [json.loads(r.stdout) for r in results]
    assert values[0]['id'] == values[1]['id'] and values[0]['deadline_at'] == values[1]['deadline_at']
    package = values[0]['id']
    assert f.scalar(f"select count(*) from public.jobs where type='render_export' and entity_id={literal(package)}") == '1'
    assert f.scalar(f"select count(*) from public.export_package_volumes where package_id={literal(package)}") == '1'
    cases.append({'case': 'fresh-key-concurrent-reentry', 'passed': True, 'contenders_observed_waiting': 2, 'packages': 1, 'jobs': 1, 'deadline_preserved': True})
    o, v, payload = setup(f)
    key = str(uuid.uuid4()); sql = f.command_sql('export.package.prepare', payload, key)
    results = f.race([sql, sql])
    assert all(r.returncode == 0 for r in results), [r.stderr for r in results]
    assert json.loads(results[0].stdout) == json.loads(results[1].stdout)
    cases.append({'case': 'same-key-concurrent-replay', 'passed': True, 'contenders_observed_waiting': 2, 'identical_response': True})
    o, v, payload = setup(f)
    results = f.race([f.command_sql('export.package.prepare', payload), f.command_sql('export.package.prepare', payload)], before_release=f"update public.opportunities set title='Changed source scope' where id={literal(o['id'])};")
    assert all(r.returncode and 'STALE_INPUT' in r.stderr for r in results), [r.stderr for r in results]
    assert f.scalar(f"select count(*) from public.export_packages where proposal_version_id={literal(v)}") == '0'
    cases.append({'case': 'source-edit-while-waiting', 'passed': True, 'contenders_observed_waiting': 2, 'packages': 0})
    o, v, payload = setup(f)
    results = f.race([f.command_sql('export.package.prepare', payload), f.command_sql('export.package.prepare', payload)], before_release=f"update public.memberships set active=false where workspace_id={literal(f.workspace)} and user_id={literal(OWNER)};")
    assert all(r.returncode and 'ROLE_FORBIDDEN' in r.stderr for r in results), [r.stderr for r in results]
    assert f.scalar(f"select count(*) from public.export_packages where proposal_version_id={literal(v)}") == '0'
    f.sql(f"update public.memberships set active=true where workspace_id={literal(f.workspace)} and user_id={literal(OWNER)};")
    cases.append({'case': 'membership-revocation-while-waiting', 'passed': True, 'contenders_observed_waiting': 2, 'packages': 0})
    # Storage bytes themselves are tested by the API/DOCX suite. This synthetic
    # verified receipt isolates the final download authorization transaction.
    f.sql("update public.jobs set status='canceled' where type='render_export' and status='queued';")
    o, v, payload = setup(f)
    package = f.command('export.package.prepare', payload)
    job = f.value('select public.claim_backend_job_v4()')
    slot = f.value(f"select to_jsonb(s) from public.export_package_volumes s where package_id={literal(package['id'])}")
    artifact = f.value(f"select public.complete_export_package_volume({literal(job['id'])},{literal(job['lease_token'])},{literal(slot['id'])},{literal('a'*64)},100)")
    f.sql(f"select public.finish_export_package({literal(job['id'])},{literal(job['lease_token'])})")
    download = f"select public.authorize_artifact_download({literal(artifact['id'])},{literal(OWNER)},{literal('a'*64)})"
    assert f.sql(download, False).returncode == 0
    results = f.race([download], before_release=f"update public.opportunities set title='Changed during final download authorization wait' where id={literal(o['id'])};")
    assert results[0].returncode and 'STALE_INPUT' in results[0].stderr, results[0].stderr
    cases.append({'case': 'download-source-edit-while-waiting', 'passed': True, 'contenders_observed_waiting': 1, 'authorization_granted': False})
    _, v1, p1 = setup(f, True); _, v2, p2 = setup(f, True)
    f.sql(f"insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) select {literal(f.workspace)},'synthetic/export-race-capacity',262144000-app_private.storage_reserved_bytes({literal(f.workspace)})-22000000,'Synthetic boundary';")
    results = f.race([f.command_sql('export.package.prepare', p1), f.command_sql('export.package.prepare', p2)])
    assert len([r for r in results if r.returncode == 0]) == 1, [r.stderr for r in results]
    assert all('STORAGE_CAP_REACHED' in r.stderr for r in results if r.returncode)
    assert f.scalar(f"select count(*) from public.export_package_volumes s join public.export_packages p on p.id=s.package_id where p.proposal_version_id in ({literal(v1)},{literal(v2)})") == '2'
    assert int(f.scalar(f"select app_private.storage_reserved_bytes({literal(f.workspace)})")) <= 262144000
    cases.append({'case': 'two-volume-atomic-capacity', 'passed': True, 'contenders_observed_waiting': 2, 'complete_packages': 1, 'reserved_volumes': 2})
    assert f.scalar('select count(*) from public.provider_usage') == '0'
    return cases


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[3])
    parser.add_argument('--container', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    f = PostgresFixture(repository=args.repository, container=args.container).start()
    try:
        receipt = f.receipt(run(f))
        receipt['qualification'] = 'Synthetic multi-session SQL guards only; no hosted-storage or live-model qualification.'
        args.output.write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps({'passed': len(receipt['cases']), 'level': receipt['level']}))
    finally:
        f.close()
