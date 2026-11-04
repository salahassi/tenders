#!/usr/bin/env python3
"""Real PostgreSQL single-PUT authorization/cleanup races, synthetic fixtures.

No Storage server/provider is called. Delayed remote object completion and real
DOCX bytes are covered by delayedUploadCleanup.integration.test.ts. These cases
prove transactional send permissions and accounting under actual concurrent locks.
"""
import argparse
import hashlib
import json
from pathlib import Path
from postgres_races import PostgresFixture, OWNER, literal
from ordinary_export_races import setup


def prepared(f):
    opportunity, _, payload = setup(f)
    package = f.command('export.package.prepare', payload)
    job = f.value("select public.claim_backend_job_v4()")
    context = f.value(f"select public.export_render_context({literal(job['id'])},{literal(job['lease_token'])})")
    key = context['volumes'][0]['storage_key']
    command = f"select public.begin_render_storage_write({literal(job['id'])},{literal(job['lease_token'])},{literal(key)},{literal('a'*64)},100)"
    return opportunity, package, job, key, command


def run(f):
    cases = []
    _, package, job, key, command = prepared(f)
    results = f.race([command, command])
    assert all(r.returncode == 0 for r in results), [r.stderr for r in results]
    outcomes = [json.loads(r.stdout) for r in results]
    assert sum(r['send'] is True for r in outcomes) == 1
    intent = f.value(f"select to_jsonb(i) from public.storage_write_intents i where storage_key={literal(key)}")
    assert intent['state'] == 'unknown' and intent['revision'] == 2
    assert f.scalar("select count(*) from public.audit_events where action='storage.write.authorized'") == '1'
    assert f.value(command)['send'] is False
    assert f.value(f"select to_jsonb(i) from public.storage_write_intents i where storage_key={literal(key)}") == intent
    cases.append({'case':'one-send-per-key-under-concurrent-authorization-and-replay','passed':True,'contenders_observed_waiting':2,'send_permissions':1,'authorization_audits':1})
    f.sql(f"select public.fail_export_package({literal(job['id'])},{literal(job['lease_token'])},'EXPORT_PACKAGE_INVALID')")
    f.sql("update public.storage_cleanup_queue set eligible_at=clock_timestamp()-interval '1 second'")
    cleanup = f.value("select public.claim_storage_cleanup()")[0]
    completion = f"select public.complete_storage_cleanup({literal(cleanup['id'])},{literal(cleanup['lease_token'])},true)"
    results = f.race([completion, completion])
    assert all(r.returncode and 'STORAGE_WRITE_RECONCILIATION_REQUIRED' in r.stderr for r in results), [r.stderr for r in results]
    assert f.scalar(f"select app_private.storage_reserved_bytes({literal(f.workspace)})") == '10485760'
    f.sql(f"select public.defer_storage_cleanup({literal(cleanup['id'])},{literal(cleanup['lease_token'])})")
    assert f.scalar(f"select attempts from public.storage_cleanup_queue where id={literal(cleanup['id'])}") == '0'
    cases.append({'case':'concurrent-bare-delete-receipts-cannot-release-unknown-write','passed':True,'contenders_observed_waiting':2,'retained_bytes':10485760,'waiting_delete_attempts':0})

    opportunity, _, job, key, command = prepared(f)
    results = f.race([command,command], before_release=f"update public.opportunities set title='Source edited before send' where id={literal(opportunity['id'])};")
    assert all(r.returncode and 'STALE_INPUT' in r.stderr for r in results), [r.stderr for r in results]
    assert f.scalar(f"select state from public.storage_write_intents where storage_key={literal(key)}") == 'unstarted'
    f.sql(f"update public.jobs set status='canceled',lease_token=null,lease_until=null where id={literal(job['id'])}")
    cases.append({'case':'source-changes-during-send-authorization-lock-wait','passed':True,'contenders_observed_waiting':2,'send_permissions':0})

    _, _, job, key, command = prepared(f)
    results = f.race([command,command], before_release=f"update public.memberships set active=false where workspace_id={literal(f.workspace)} and user_id={literal(OWNER)};")
    assert all(r.returncode and 'ROLE_FORBIDDEN' in r.stderr for r in results), [r.stderr for r in results]
    assert f.scalar(f"select state from public.storage_write_intents where storage_key={literal(key)}") == 'unstarted'
    f.sql(f"update public.memberships set active=true where workspace_id={literal(f.workspace)} and user_id={literal(OWNER)};update public.jobs set status='canceled',lease_token=null,lease_until=null where id={literal(job['id'])}")
    cases.append({'case':'actor-revocation-during-send-authorization-lock-wait','passed':True,'contenders_observed_waiting':2,'send_permissions':0})

    _, package, job, key, command = prepared(f)
    stop = f"select public.fail_export_package({literal(job['id'])},{literal(job['lease_token'])},'EXPORT_PACKAGE_INVALID');"
    results = f.race([command,command], before_release=stop)
    assert all(r.returncode and 'STALE_LEASE' in r.stderr for r in results), [r.stderr for r in results]
    assert f.scalar(f"select state from public.storage_write_intents where storage_key={literal(key)}") == 'unstarted'
    f.sql(f"update public.storage_cleanup_queue set eligible_at=clock_timestamp()-interval '1 second' where storage_key={literal(key)}")
    cleanup = next(c for c in f.value('select public.claim_storage_cleanup()') if c['storage_key'] == key)
    context = f.value(f"select public.storage_cleanup_context({literal(cleanup['id'])},{literal(cleanup['lease_token'])})")
    assert context['can_delete'] is True
    f.sql(f"select public.complete_storage_cleanup({literal(cleanup['id'])},{literal(cleanup['lease_token'])},true)")
    cases.append({'case':'terminal-request-wins-lock-before-send-so-unused-key-is-safe-to-release','passed':True,'contenders_observed_waiting':2,'send_permissions':0,'unused_key_cleanup_allowed':True})
    assert f.scalar('select count(*) from public.provider_usage') == '0'
    return cases


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository',type=Path,default=Path(__file__).resolve().parents[3])
    parser.add_argument('--container',required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    f=PostgresFixture(args.repository,args.container).start()
    try:
        cases=run(f)
        args.output.parent.mkdir(parents=True,exist_ok=True)
        receipt=f.receipt(cases)
        paths=['backend/supabase/functions/_shared/backend.ts','backend/supabase/functions/_shared/storageWrites.ts',
               'backend/supabase/functions/_shared/deliveryWorker.ts','backend/supabase/functions/_shared/ordinaryExportWorker.ts',
               'backend/supabase/functions/worker/maintenance.ts','backend/scripts/testing/storage_write_intent_races.py']
        receipt['scoped_source_hashes']=[{'path':p,'sha256':hashlib.sha256((f.repository/p).read_bytes()).hexdigest()} for p in paths]
        args.output.write_text(json.dumps(receipt,indent=2)+'\n')
        print(json.dumps({'passed':len(cases),'receipt':str(args.output)}))
    finally:
        f.close()
