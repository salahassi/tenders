import copy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('trial_observe_test', HERE / 'proposal-trial-observe.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class TrialObserveTests(unittest.TestCase):
    def setUp(self):
        self.target = {key: '00000000-0000-4000-8000-' + str(i).zfill(12)
                       for i, key in enumerate(sorted(m.UUID_KEYS), 1)} | {'operation': 'generation.retry'}
        self.start = datetime(2026, 11, 5, tzinfo=timezone.utc)

    def stamp(self, seconds):
        return (self.start + timedelta(seconds=seconds)).isoformat()

    def value(self, seconds=20):
        return {'version': 1, 'kind': 'current_proposal_issuance_observation', 'target': self.target.copy(),
            'observed_at': self.stamp(seconds), 'guards': dict.fromkeys(m.issuance.GUARDS, True),
            'source_check': 'passed', 'artifact_check': 'not_issued', 'package': None,
            'issuance': {'id': self.target['issuance_request_id'], 'plan_id': self.target['plan_id'],
                'requested_by': self.target['actor_id'], 'operation': self.target['operation'],
                'accepted_at': self.stamp(0), 'deadline_at': self.stamp(600), 'outcome': 'active',
                'completed_at': None, 'error_code': None, 'issued_snapshot_id': None,
                'effective_outcome': 'active', 'effective_error_code': None, 'effective_completed_at': None},
            'plan': {'status': 'running', 'error_code': None, 'updated_at': self.stamp(seconds)}, 'terminal_jobs': [],
            'job_progress': {'total': 3, 'completed': 1, 'groups': [
                {'type': 'analyze_chunk', 'status': 'succeeded', 'count': 1, 'updated_at': self.stamp(5)},
                {'type': 'plan_proposal', 'status': 'retry_wait', 'count': 2, 'updated_at': self.stamp(10)}]},
            'attempt_progress': {'total': 2, 'accepted_waits': 1, 'last_started_at': self.stamp(9), 'last_finished_at': self.stamp(10)}}

    def issued(self):
        value = self.value(102)
        snapshot = '00000000-0000-4000-8000-000000000100'
        value['issuance'].update(outcome='issued', completed_at=self.stamp(100), issued_snapshot_id=snapshot,
            effective_outcome='issued', effective_completed_at=self.stamp(100))
        value['artifact_check'] = 'passed'
        value['package'] = {'snapshot_id': snapshot, 'proposal_version_id': '00000000-0000-4000-8000-000000000200',
            'current_version': True, 'current_snapshot': True, 'validated_generated_draft': True,
            'content_state': 'generated_review_draft', 'approval_state': 'draft',
            'required_volumes': ['technical', 'financial'], 'render_job': {'status': 'succeeded', 'updated_at': self.stamp(99)},
            'artifacts': [{'id': '00000000-0000-4000-8000-' + str(300 + i).zfill(12), 'snapshot_id': snapshot,
                'workspace_id': self.target['workspace_id'], 'volume': volume, 'status': 'ready',
                'renderer_version': '3', 'expected_size': 1000, 'content_hash': 'a' * 64,
                'original_name': 'PRIVATE BUYER ' + volume + '.docx',
                'mime_type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'updated_at': self.stamp(98)} for i, volume in enumerate(['technical', 'financial'])]}
        return value

    def read(self, value, previous=None):
        reader = Mock(return_value=json.dumps(value))
        result = m.sample(object(), self.target, previous, reader=reader)
        reader.assert_called_once()
        return result

    def test_target_and_sql_bind_real_operation_without_renaming(self):
        for operation in m.OPERATIONS:
            sql = m.observation_sql(self.target | {'operation': operation})
            self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', sql)
            self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
            self.assertIn("SET LOCAL statement_timeout='20s'", sql)
            self.assertEqual(sql.count("operation='" + operation + "'"), 2)
            self.assertIn("'operation','" + operation + "'", sql)
            self.assertNotRegex(sql, r'(?i)\b(insert|update|delete|truncate|grant|revoke)\b|for update|app_command\(')
            self.assertIn('public.delivery_artifact_context', sql)
            self.assertIn('app_private.check_source_semantics', sql)
            for field in ('original_name', 'mime_type', 'snapshot_id', 'workspace_id'):
                self.assertIn("'" + field + "'," + field, sql)
        for change in ({'operation': "generation.retry';delete"}, {'plan_id': 'not-a-uuid'}, {'extra': 'field'}):
            with self.assertRaisesRegex(m.TrialObservationError, 'TARGET_INVALID'):
                m.observation_sql(self.target | change)

    def test_one_active_sample_retains_private_target_and_counts(self):
        result = self.read(self.value())
        self.assertEqual(result['outcome'], 'active')
        self.assertEqual(result['target'], self.target)
        self.assertEqual(result['sample']['issuance']['operation'], 'generation.retry')
        receipt = m.public_receipt(result)
        self.assertEqual((receipt['stage'], receipt['completed_jobs'], receipt['total_jobs']), ('planning', 1, 3))
        self.assertEqual(receipt['status_counts']['retry_wait'], 2)
        self.assertFalse(receipt['whole_package_issued'])

    def test_identity_and_original_clock_cannot_change_between_samples(self):
        prior = self.read(self.value())
        for change in ({'operation': 'proposal.generate'}, {'requested_by': self.target['plan_id']},
                       {'accepted_at': self.stamp(5), 'deadline_at': self.stamp(605)}):
            value = self.value(25)
            value['issuance'].update(change)
            with self.assertRaisesRegex(m.TrialObservationError, 'IDENTITY_CHANGED'):
                self.read(value, prior)
        with self.assertRaisesRegex(m.TrialObservationError, 'CLOCK_INVALID'):
            self.read(self.value(19), prior)
        with self.assertRaisesRegex(m.TrialObservationError, 'PREVIOUS_INVALID'):
            self.read(self.value(25), prior | {'target': self.target | {'operation': 'proposal.generate'}})

    def test_effective_deadline_preserves_actual_unpersisted_state(self):
        value = self.value(601)
        value['issuance'].update(effective_outcome='failed', effective_error_code='PROPOSAL_ISSUANCE_TIMEOUT',
                                 effective_completed_at=self.stamp(600))
        result = self.read(value, self.read(self.value(590)))
        self.assertEqual((result['outcome'], result['code']), ('failed', 'PROPOSAL_ISSUANCE_TIMEOUT'))
        self.assertIsNone(result['sample']['issuance']['completed_at'])
        self.assertEqual(result['sample']['issuance']['accepted_at'], self.stamp(0))

    def test_known_terminal_and_currentness_failure_remain_distinct(self):
        value = self.value()
        value['terminal_jobs'] = [{'type': 'plan_proposal', 'status': 'blocked', 'error_code': 'NO_AGENTS_AVAILABLE'}]
        self.assertEqual(self.read(value)['outcome'], 'terminal_pending')
        for guard in m.issuance.GUARDS:
            stale = self.issued()
            stale['guards'][guard] = False
            self.assertEqual(self.read(stale)['outcome'], 'guard_failed')

    def test_invalid_counts_unknown_status_and_future_metadata_rejected(self):
        for change in (
            lambda x: x['job_progress'].update(total=4),
            lambda x: x['job_progress'].update(completed=True),
            lambda x: x['job_progress']['groups'][0].update(status='private-custom-status'),
            lambda x: x['job_progress']['groups'].append(copy.deepcopy(x['job_progress']['groups'][0])),
            lambda x: x['job_progress']['groups'][0].update(updated_at=self.stamp(21)),
            lambda x: x['attempt_progress'].update(accepted_waits=3),
        ):
            value = self.value()
            change(value)
            with self.assertRaises((m.TrialObservationError, m.issuance.IssuanceObservationError)):
                self.read(value)

    def test_issued_envelope_keeps_all_artifact_identity_private(self):
        value = self.issued()
        value['unselected_private_metadata'] = 'PRIVATE CUSTOMER CONTENT'
        result = self.read(value)
        self.assertTrue(result['whole_package_issued'])
        self.assertEqual(len(result['sample']['package']['artifacts']), 2)
        receipt = m.public_receipt(result)
        self.assertEqual(receipt['stage'], 'package_ready')
        self.assertFalse(receipt['authenticated_download_verified'])
        text = json.dumps(receipt)
        self.assertNotIn('PRIVATE', text)
        self.assertNotIn('00000000-', text)
        self.assertNotIn('a' * 64, text)
        with self.assertRaisesRegex(m.TrialObservationError, 'EVIDENCE_INVALID'):
            m.public_receipt(result | {'outcome': 'active'})

    def test_partial_stale_or_foreign_package_never_claims_success(self):
        for change in (
            lambda x: x['package']['artifacts'].pop(),
            lambda x: x['package'].update(current_version=False),
            lambda x: x['package'].update(current_snapshot=False),
            lambda x: x['package']['artifacts'][0].update(status='pending'),
            lambda x: x['package']['artifacts'][0].update(workspace_id=self.target['plan_id']),
            lambda x: x['package']['artifacts'][0].update(snapshot_id=self.target['plan_id']),
        ):
            value = self.issued()
            change(value)
            with self.assertRaises((m.TrialObservationError, m.issuance.IssuanceObservationError)):
                self.read(value)

    def test_reader_is_not_replayed_on_failure_or_oversize(self):
        reader = Mock(side_effect=OSError('transport stopped'))
        with self.assertRaises(OSError):
            m.sample(object(), self.target, reader=reader)
        reader.assert_called_once()
        with self.assertRaisesRegex(m.TrialObservationError, 'SAMPLE_TOO_LARGE'):
            m.sample(object(), self.target, reader=lambda *_: ' ' * (m.MAX_BYTES + 1))

    def test_real_database_sql_is_scoped_and_read_only(self):
        # Executes the actual augmented SQL against every real migration.
        # Synthetic rows stay in this local in-memory database only.
        script = r'''
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const {target,sql}=JSON.parse(raw),db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
 alter table storage.objects enable row level security;grant usage on schema storage to authenticated;
 grant insert,select on storage.objects to authenticated;`);
for(const name of (await readdir('supabase/migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)).sort())
 await db.exec(await readFile('supabase/migrations/'+name,'utf8'));
await db.query("insert into auth.users values($1,'fixture@example.test',now())",[target.actor_id]);
await db.query("insert into auth.identities values($1,'email',$2::jsonb)",[target.actor_id,JSON.stringify({sub:target.actor_id})]);
const w=(await db.query("select public.bootstrap_workspace($1,'Synthetic observation') id",[target.actor_id])).rows[0].id;
const source=(await db.query("insert into public.sources(workspace_id,name,kind,created_by) values($1,'Synthetic source','manual',$2) returning id",[w,target.actor_id])).rows[0].id;
await db.query("insert into public.opportunities(id,workspace_id,source_id,title,created_by) values($1,$2,$3,'PRIVATE BUYER',$4)",[target.opportunity_id,w,source,target.actor_id]);
await db.query("insert into public.proposals(id,workspace_id,opportunity_id,title,created_by) values($1,$2,$3,'PRIVATE PROPOSAL',$4)",[target.proposal_id,w,target.opportunity_id,target.actor_id]);
await db.query(`insert into public.generation_plans(id,workspace_id,opportunity_id,proposal_id,kind,status,evidence_revision,input_hash,frozen_context,created_by)
 values($1,$2,$3,$4,'proposal','running',1,repeat('a',64),'{"generated_delivery_version":3,"proposal_consistency_version":1}', $5)`,
 [target.plan_id,w,target.opportunity_id,target.proposal_id,target.actor_id]);
await db.query(`insert into public.proposal_issuance_requests(id,workspace_id,plan_id,requested_by,operation,idempotency_key,accepted_at,deadline_at)
 select $1,$2,$3,$4,'generation.retry','synthetic-observe',t,t+interval '600 seconds' from (select clock_timestamp() t) x`,
 [target.issuance_request_id,w,target.plan_id,target.actor_id]);
const job=(await db.query(`insert into public.jobs(workspace_id,type,entity_id,status,input_hash,checkpoint,created_by)
 values($1,'analyze_chunk',$2,'retry_wait',repeat('a',64),$3,$4) returning id`,
 [w,target.plan_id,JSON.stringify({issuance_request_id:target.issuance_request_id,private:'PRIVATE CHECKPOINT'}),target.actor_id])).rows[0].id;
await db.query(`insert into public.jobs(workspace_id,type,entity_id,status,input_hash,created_by)
 values($1,'draft_section',$2,'succeeded',repeat('b',64),$3)`,[w,target.plan_id,target.actor_id]);
await db.query('update public.generation_plans set issuance_request_id=$1 where id=$2',[target.issuance_request_id,target.plan_id]);
await db.query(`insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,operation,round_number,worker_attempt,status,sent,result_code,http_status,request_phase,execution_metadata,response_id)
 values($1,$2,gen_random_uuid(),'qwen_free','synthetic','analyze_chunk',1,1,'waiting',true,'MODEL_IN_PROGRESS',200,'generation','{"secret":"PRIVATE RESPONSE"}','PRIVATE REMOTE ID'),
 ($1,$2,gen_random_uuid(),'qwen_free','synthetic','analyze_chunk',1,2,'waiting',true,'MODEL_IN_PROGRESS',200,'poll',null,null),
 ($1,$2,gen_random_uuid(),'qwen_free','synthetic','analyze_chunk',1,3,'skipped',false,'MODEL_COOLDOWN',null,null,null,null)`,[w,job]);
await db.query(`insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,operation,round_number,worker_attempt,status,sent,result_code,http_status,started_at)
 values($1,$2,gen_random_uuid(),'qwen_free','historical','analyze_chunk',1,1,'failed',true,'MODEL_NETWORK_UNCERTAIN',503,clock_timestamp()-interval '1 day')`,[w,job]);
const state=async()=>{
 const out={};for(const table of ['public.jobs','public.generation_plans','public.proposal_issuance_requests','public.model_attempts','public.provider_usage'])
 out[table]=(await db.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows;
 return out;
};
const before=await state();
const actualSql=sql.replaceAll(target.workspace_id,w).replace("current_database()='tenderdesk_app'","current_database()='postgres'").replace('SET LOCAL ROLE tdp_app_owner','SET LOCAL ROLE postgres');
const report=(await db.exec(actualSql)).flatMap(r=>r.rows||[]).find(r=>r.jsonb_build_object).jsonb_build_object;
assert.equal(report.target.operation,'generation.retry'); assert.equal(report.issuance.operation,'generation.retry');
assert.equal(report.guards.actor,true);assert.equal(report.guards.selected_target,true);
assert.equal(report.job_progress.total,1);assert.equal(report.job_progress.completed,0);
assert.equal(report.job_progress.groups[0].status,'retry_wait');assert.equal(report.attempt_progress.total,3);
assert.equal(report.attempt_progress.accepted_waits,2);assert.equal(report.package,null);
assert.equal(report.attempt_progress.accepted_http_attempts,1);assert.equal(report.attempt_progress.poll_attempts,1);
assert.equal(report.attempt_progress.skipped_attempts,1);
assert.equal(report.attempt_timeline.total,3);assert.equal(report.attempt_timeline.truncated,false);
assert.deepEqual(report.attempt_timeline.attempts.map(a=>a.request_phase),['generation','poll',null]);
assert.ok(report.attempt_timeline.attempts.every(a=>a.job_id===job && a.type==='analyze_chunk' && a.model==='synthetic'));
assert.doesNotMatch(JSON.stringify(report),/PRIVATE/);assert.deepEqual(await state(),before);
await db.query(`insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,operation,round_number,worker_attempt,status,sent,result_code)
 select $1,$2,gen_random_uuid(),'qwen_free','synthetic','analyze_chunk',1,4,'skipped',false,'MODEL_COOLDOWN' from generate_series(1,201)`,[w,job]);
const extendedBefore=await state();
const bounded=(await db.exec(actualSql)).flatMap(r=>r.rows||[]).find(r=>r.jsonb_build_object).jsonb_build_object;
assert.equal(bounded.attempt_timeline.total,204);assert.equal(bounded.attempt_timeline.truncated,true);
assert.equal(bounded.attempt_timeline.attempts.length,200);assert.equal(bounded.attempt_progress.skipped_attempts,202);
assert.ok(bounded.attempt_timeline.attempts.every(a=>a.status==='skipped'));
assert.deepEqual(await state(),extendedBefore);
bounded.target.workspace_id=target.workspace_id;console.log(JSON.stringify(bounded));await db.close();
'''
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=HERE.parent.parent,
            input=json.dumps({'target': self.target, 'sql': m.observation_sql(self.target)}),
            text=True, capture_output=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr[-3000:])
        value = json.loads(result.stdout)
        m.validate_sample(value, self.target)


if __name__ == '__main__':
    unittest.main()
