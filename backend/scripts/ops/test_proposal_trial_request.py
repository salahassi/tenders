import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('trial_request_test_target', HERE / 'proposal-trial-request.py')
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)
W = m.auth.access.WORKSPACE
O, P, G, A, I, J = ['00000000-0000-4000-8000-%012d' % n for n in range(101, 107)]


def fixture():
    return {'version': 1, 'kind': 'proposal_trial_request_proof', 'observed_at': datetime.now(timezone.utc).isoformat(),
        'selection': {'version': 1, 'workspace_id': W, 'opportunity_id': O}, 'actor_id': A,
        'opportunity': {'id': O, 'revision': 12}, 'proposal': {'id': P, 'revision': 4, 'active_version_id': None},
        'workspace_evidence_revision': 8,
        'plan': {'id': G, 'proposal_id': P, 'revision': 287, 'status': 'failed', 'stage': 'analysis',
                 'input_hash': 'a' * 64, 'evidence_revision': 8, 'base_version_id': None,
                 'issuance_request_id': I, 'current_contract': True},
        'latest_issuance': {'id': I, 'plan_id': G, 'requested_by': A, 'operation': 'proposal.generate',
                            'outcome': 'failed', 'accepted_at': '2026-01-01T00:00:00+00:00', 'deadline_at': '2026-01-01T00:10:00+00:00'},
        'guards': dict.fromkeys(m.GUARDS, True)}


class RequestTests(unittest.TestCase):
    def setUp(self):
        m._ATTEMPTED.clear()
        self.proof = fixture()
        self.prepared = m.prepare(self.proof)
        self.client = Mock()
        self.client.request.return_value = Mock(status=200, body=b'{"data":{"results":[]}}')
        self.session = {'user': {'id': A}, 'access_token': 'private-test-session'}
        self.persist = Mock(side_effect=lambda value: hashlib.sha256(m.encoded(value)).hexdigest())

    def test_retry_is_exact_ui_single_command_and_stable_identity(self):
        self.assertEqual(self.prepared['body'], {'commands': [{'operation': 'generation.retry', 'input': {
            'id': G, 'expected_revision': 287, 'reason': 'User requested continuation of the saved work.'}}]})
        changed = copy.deepcopy(self.proof)
        changed['observed_at'] = '2025-01-01T00:00:00+00:00'
        self.assertEqual(m.prepare(changed)['prepared_object'], self.prepared['prepared_object'])
        self.assertEqual(m.prepare(changed)['idempotency_key'], self.prepared['idempotency_key'])
        key = self.prepared['idempotency_key']
        self.assertEqual(self.prepared['command_key'], hashlib.sha256(('batch:' + key + ':1').encode()).hexdigest())

    def test_failed_noncurrent_or_evidence_changed_uses_fresh_generate(self):
        for field, value in [('current_contract', False), ('evidence_revision', 7)]:
            proof = copy.deepcopy(self.proof); proof['plan'][field] = value
            prepared = m.prepare(proof)
            self.assertEqual(prepared['body'], {'commands': [{'operation': 'proposal.generate', 'input': {'id': O, 'expected_revision': 12}}]})
            proof['plan']['status'] = 'blocked'
            with self.assertRaisesRegex(m.TrialRequestError, 'CURRENT_RETRY_REQUIRED'):
                m.prepare(proof)

    def test_legacy_usage_admission_falls_back_to_exact_fresh_generate(self):
        for status in ('failed', 'canceled'):
            proof = copy.deepcopy(self.proof)
            proof['plan']['status'] = status
            proof['guards']['usage_ready'] = False
            prepared = m.prepare(proof)
            self.assertEqual(prepared['operation'], 'proposal.generate')
            self.assertEqual(prepared['body'], {'commands': [{'operation': 'proposal.generate',
                'input': {'id': O, 'expected_revision': 12}}]})
            self.assertEqual(proof['plan']['id'], G)
            self.assertEqual(proof['plan']['input_hash'], 'a' * 64)

    def test_fresh_usage_fallback_preserves_active_version_and_work_guards(self):
        base = copy.deepcopy(self.proof); base['guards']['usage_ready'] = False
        changed = copy.deepcopy(base); changed['proposal']['active_version_id'] = J
        with self.assertRaisesRegex(m.TrialRequestError, 'EXISTING_VERSION_REQUIRES_REVIEW'):
            m.prepare(changed)
        changed = copy.deepcopy(base); changed['plan']['status'] = 'blocked'
        with self.assertRaisesRegex(m.TrialRequestError, 'CURRENT_RETRY_REQUIRED'):
            m.prepare(changed)
        for guard in ('no_selected_leases', 'no_other_active_plan'):
            changed = copy.deepcopy(base); changed['guards'][guard] = False
            with self.assertRaisesRegex(m.TrialRequestError, guard.upper()):
                m.prepare(changed)
        changed = copy.deepcopy(base); changed['guards']['usage_ready'] = None
        with self.assertRaisesRegex(m.TrialRequestError, 'PROOF_INVALID'):
            m.prepare(changed)

    def test_initial_generate_without_any_saved_plan(self):
        proof = copy.deepcopy(self.proof)
        proof.update(plan=None, proposal=None, latest_issuance=None)
        self.assertEqual(m.prepare(proof)['operation'], 'proposal.generate')

    def test_existing_active_work_is_observation_only(self):
        proof = copy.deepcopy(self.proof)
        proof['plan']['status'] = 'running'; proof['latest_issuance']['outcome'] = 'active'
        proof['guards']['no_selected_leases'] = False; proof['guards']['usage_ready'] = False
        prepared = m.prepare(proof)
        self.assertEqual(prepared['mode'], 'observe_existing')
        self.assertEqual(prepared['target']['operation'], 'proposal.generate')
        with self.assertRaisesRegex(m.TrialRequestError, 'OBSERVE_ONLY'):
            m.send(self.client, self.session, prepared, self.persist)
        self.persist.assert_not_called(); self.client.request.assert_not_called()

    def test_each_authority_and_ambiguity_guard_stops_new_request(self):
        for guard in m.GUARDS - {'usage_ready'}:
            with self.subTest(guard=guard):
                proof = copy.deepcopy(self.proof); proof['guards'][guard] = False
                with self.assertRaisesRegex(m.TrialRequestError, guard.upper()): m.prepare(proof)
        for changes in [{'version': True}, {'opportunity_id': "';DELETE"}, {'workspace_id': O}, {'plan_id': G}]:
            with self.assertRaises(m.TrialRequestError): m.validate_selection(self.proof['selection'] | changes)

    def test_completed_stage_requires_local_render_and_existing_version_prevents_fresh(self):
        proof = copy.deepcopy(self.proof); proof['plan']['stage'] = 'completed'
        with self.assertRaisesRegex(m.TrialRequestError, 'PROPOSAL_RENDER_RETRY_REQUIRED'): m.prepare(proof)
        proof = copy.deepcopy(self.proof); proof['plan']['current_contract'] = False; proof['proposal']['active_version_id'] = J
        with self.assertRaisesRegex(m.TrialRequestError, 'EXISTING_VERSION'): m.prepare(proof)

    def test_durable_readback_and_identity_are_required_before_post(self):
        for persist in [lambda _: '0' * 64, Mock(side_effect=RuntimeError('persistence unavailable'))]:
            with self.assertRaises((m.TrialRequestError, RuntimeError)):
                m.send(self.client, self.session, self.prepared, persist)
            self.client.request.assert_not_called()
        with self.assertRaisesRegex(m.TrialRequestError, 'SESSION_MISMATCH'):
            m.send(self.client, {'user': {'id': O}, 'access_token': 'token'}, self.prepared, self.persist)
        self.persist.assert_not_called()

    def test_one_post_follows_persistence_and_fresh_check(self):
        order = []
        def persist(value):
            order.append('persist'); return hashlib.sha256(m.encoded(value)).hexdigest()
        def request(*args, **kwargs):
            order.append('post'); return Mock(status=200, body=b'{}')
        self.client.request.side_effect = request
        receipt = m.send(self.client, self.session, self.prepared, persist, lambda: order.append('fresh'))
        self.assertEqual(order, ['persist', 'fresh', 'post'])
        self.assertTrue(receipt['accepted'])
        self.client.request.assert_called_once_with('/functions/v1/api/v1/commands', token='private-test-session', method='POST',
            data=self.prepared['body'], headers={'Idempotency-Key': self.prepared['idempotency_key']})

    def test_unknown_is_receipted_and_same_attempt_can_never_post_again(self):
        self.client.request.return_value = Mock(status=0, body=b'')
        receipt = m.send(self.client, self.session, self.prepared, self.persist)
        self.assertTrue(receipt['unknown']); self.assertFalse(receipt['accepted'])
        with self.assertRaisesRegex(m.TrialRequestError, 'ALREADY_ATTEMPTED'):
            m.send(self.client, self.session, self.prepared, self.persist)
        self.client.request.assert_called_once(); self.persist.assert_called_once()

    def test_rejection_returns_only_fixed_code_not_response_details(self):
        self.client.request.return_value = Mock(status=409, body=b'{"error":{"code":"STALE_INPUT","message":"private customer content"}}')
        result = m.send(self.client, self.session, self.prepared, self.persist)
        self.assertEqual(result['api_error_code'], 'STALE_INPUT')
        self.assertNotIn('private customer', json.dumps(result))

    def test_tampering_and_post_persistence_change_never_send(self):
        bad = copy.deepcopy(self.prepared); bad['body']['commands'].append({'operation': 'generation.cancel', 'input': {'id': G}})
        with self.assertRaises(m.TrialRequestError): m.send(self.client, self.session, bad, self.persist)
        with self.assertRaisesRegex(m.TrialRequestError, 'PREPARED_CHANGED'):
            m.send(self.client, self.session, self.prepared, self.persist,
                   lambda: self.prepared['body']['commands'][0]['input'].update(id=O))
        self.client.request.assert_not_called()

    def test_recheck_binds_revision_input_hash_actor_and_authority(self):
        for field, value in [('revision', 288), ('input_hash', 'b' * 64)]:
            fresh = copy.deepcopy(self.proof); fresh['plan'][field] = value
            with patch.object(m, 'inspect', return_value=fresh):
                with self.assertRaisesRegex(m.TrialRequestError, 'CHANGED_BEFORE_SEND'):
                    m.recheck(object(), self.proof['selection'], self.prepared)

    def test_actual_acceptance_uses_per_command_key_and_actor_operation(self):
        sql = m.acceptance_sql(self.prepared)
        for text in [self.prepared['command_key'], "r.operation='generation.retry'", "r.requested_by='" + A, "p.input_hash='" + 'a' * 64]:
            self.assertIn(text, sql)
        target = m.existing_target(self.proof) | {'operation': 'generation.retry'}
        with patch.object(m, 'read', return_value={'count': 1, 'bound': True, 'target': target}):
            self.assertEqual(m.verify_result(object(), self.prepared), target)
        with patch.object(m, 'read', return_value={'count': 0, 'bound': False, 'target': None}):
            with self.assertRaisesRegex(m.TrialRequestError, 'ACCEPTANCE_UNPROVEN'): m.verify_result(object(), self.prepared)

    def test_sql_is_read_only_and_every_selection_is_scoped(self):
        for sql in [m.inspection_sql(self.proof['selection']), m.acceptance_sql(self.prepared)]:
            self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', sql)
            self.assertIn("statement_timeout='20s'", sql); self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
            self.assertNotRegex(sql, r'(?i)\b(insert|update|delete|truncate|grant|revoke)\b|app_command\(|auth\.users|for update')

    def test_read_transport_is_short_and_returns_only_json(self):
        db = Mock(pod='selected-client')
        with patch.object(m.d, 'command', return_value=json.dumps(self.proof)) as command:
            self.assertEqual(m.inspect(db, self.proof['selection']), self.proof)
        self.assertEqual(command.call_args.kwargs['timeout'], 35)


class SQLFixtureTests(unittest.TestCase):
    def test_actual_queries_owner_ambiguity_usage_and_committed_retry(self):
        proof = fixture(); prepared = m.prepare(proof)
        diagnostic_value = json.dumps({'code': 'EVIDENCE_REFERENCE_INVALID',
            'producer': {'model': 'gpt-6-luna', 'project': 'private-project'},
            'result': {'quote': 'private-customer-content'}, 'validation_diagnostics': [{
                'code': 'EVIDENCE_REFERENCE_INVALID', 'reason': 'source_quote_mismatch',
                'paths': ['$.claims[0].source_refs[0].quote'], 'numeric_literals': ['99999']}]})
        schema = f"""
CREATE ROLE tdp_app_owner; GRANT ALL ON SCHEMA public TO tdp_app_owner;
CREATE SCHEMA app_private AUTHORIZATION tdp_app_owner;
SET ROLE tdp_app_owner;
CREATE TABLE workspaces(id uuid,evidence_revision bigint);
CREATE TABLE memberships(workspace_id uuid,user_id uuid,active boolean,role text);
CREATE TABLE identity_allowlist(workspace_id uuid,user_id uuid,status text,role text);
CREATE TABLE opportunities(id uuid,workspace_id uuid,revision int,archived boolean,decision text);
CREATE TABLE proposals(id uuid,workspace_id uuid,opportunity_id uuid,revision int,active_version_id uuid);
CREATE TABLE generation_plans(id uuid,workspace_id uuid,opportunity_id uuid,proposal_id uuid,revision int,status text,stage text,input_hash text,evidence_revision bigint,base_version_id uuid,issuance_request_id uuid,frozen_context jsonb,kind text,created_at timestamptz);
CREATE TABLE proposal_issuance_requests(id uuid,workspace_id uuid,plan_id uuid,requested_by uuid,operation text,idempotency_key text,outcome text,accepted_at timestamptz,deadline_at timestamptz);
CREATE TABLE jobs(id uuid,workspace_id uuid,entity_id uuid,status text,lease_token uuid,lease_until timestamptz,checkpoint jsonb,type text,error_code text,cancel_requested boolean,next_attempt_at timestamptz,attempts int NOT NULL DEFAULT 0,updated_at timestamptz DEFAULT now());
CREATE TABLE provider_usage(workspace_id uuid,state text,id uuid DEFAULT gen_random_uuid(),job_id uuid,error_code text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),remote_deadline timestamptz,reconciliation_after timestamptz,remote_request_id text,provider text,model text,connection_id uuid,model_config_id uuid);
CREATE TABLE generation_steps(workspace_id uuid,job_id uuid,plan_id uuid,status text);
CREATE TABLE model_attempts(id bigserial,operation text,workspace_id uuid,job_id uuid,usage_id uuid,provider text,model text,connection_id uuid,model_config_id uuid,status text,result_code text,response_id text,finish_reason text);
CREATE TABLE model_routing(workspace_id uuid,enabled boolean);
CREATE TABLE model_execution_settings(workspace_id uuid,enabled boolean,admitted_after timestamptz,revision int DEFAULT 1,max_parallel_requests int DEFAULT 1);
CREATE TABLE model_connections(id uuid,workspace_id uuid,enabled boolean,revision int DEFAULT 1);
CREATE TABLE model_configurations(id uuid,workspace_id uuid,connection_id uuid,enabled boolean,revision int DEFAULT 1,model text);
CREATE TABLE model_task_routes(workspace_id uuid,task text,revision int DEFAULT 1,inherit_default boolean DEFAULT false,strategy text DEFAULT 'priority',next_position int DEFAULT 0,model_ids uuid[] DEFAULT '{{}}',profile jsonb);
CREATE TABLE restore_sessions(workspace_id uuid,state text);
CREATE TABLE app_private.model_graph_threads(id uuid,workspace_id uuid,job_id uuid);
CREATE TABLE app_private.model_graph_results(id uuid,workspace_id uuid,thread_id uuid,result_key text,value jsonb,created_at timestamptz DEFAULT now());
CREATE TABLE app_private.model_graph_checkpoints(thread_id uuid,created_at timestamptz DEFAULT now(),checkpoint jsonb);
CREATE TABLE app_private.k8s_dispatch_queue(singleton boolean,generation bigint,acknowledged_generation bigint,
 lease_generation bigint,lease_until timestamptz,next_attempt_at timestamptz,last_periodic_at timestamptz,failures int);
CREATE TABLE app_private.k8s_dispatch_timers(due_at timestamptz);
INSERT INTO app_private.k8s_dispatch_queue VALUES(true,7,6,null,null,'-infinity',now(),0);
INSERT INTO app_private.k8s_dispatch_timers VALUES(now()-interval '1 second'),(now()+interval '5 seconds');
INSERT INTO app_private.model_graph_checkpoints VALUES('00000000-0000-4000-8000-000000000901',now(),'{{"body":"private-checkpoint-payload"}}');

INSERT INTO workspaces VALUES('{W}',8);
INSERT INTO memberships VALUES('{W}','{A}',true,'Owner');
INSERT INTO identity_allowlist VALUES('{W}','{A}','active','Owner');
INSERT INTO opportunities VALUES('{O}','{W}',12,false,'shortlisted');
INSERT INTO proposals VALUES('{P}','{W}','{O}',4,null);
INSERT INTO generation_plans VALUES('{G}','{W}','{O}','{P}',287,'failed','analysis','{'a' * 64}',8,null,'{I}','{{"generated_delivery_version":3,"proposal_consistency_version":1}}','proposal',now());
INSERT INTO proposal_issuance_requests VALUES('{I}','{W}','{G}','{A}','generation.retry','{prepared['command_key']}','failed','2026-01-01 00:00:00+00','2026-01-01 00:10:00+00');
INSERT INTO jobs(id,workspace_id,entity_id,status,type) VALUES('00000000-0000-4000-8000-000000000900','{W}','{G}','succeeded','analyze_chunk');
INSERT INTO app_private.model_graph_threads VALUES('00000000-0000-4000-8000-000000000901','{W}','00000000-0000-4000-8000-000000000900');
INSERT INTO app_private.model_graph_results(id,workspace_id,thread_id,result_key,value) VALUES
 ('00000000-0000-4000-8000-000000000902','{W}','00000000-0000-4000-8000-000000000901','invalid-report-fixture','{diagnostic_value}');
INSERT INTO model_attempts(workspace_id,job_id,operation,model,result_code,model_config_id) VALUES
 ('{W}','00000000-0000-4000-8000-000000000900','verify_grounding','gpt-6-luna','EVIDENCE_REFERENCE_INVALID','00000000-0000-4000-8000-000000000903');
INSERT INTO model_connections(id,workspace_id,enabled,revision) VALUES('00000000-0000-4000-8000-000000000904','{W}',true,3);
INSERT INTO model_configurations(id,workspace_id,connection_id,enabled,revision,model) VALUES
 ('00000000-0000-4000-8000-000000000903','{W}','00000000-0000-4000-8000-000000000904',true,5,'gpt-6-luna');
INSERT INTO model_task_routes(workspace_id,task,revision,model_ids) VALUES
 ('{W}','verify_grounding',7,ARRAY['00000000-0000-4000-8000-000000000903'::uuid]);
RESET ROLE;
"""
        inspect_sql = m.inspection_sql(proof['selection']).replace("current_database()='tenderdesk_app'", "current_database()='postgres'")
        migrations = HERE.parent.parent / 'supabase' / 'migrations'
        def function_source(filename, declaration):
            source = (migrations / filename).read_text()
            start = source.index(declaration)
            return source[start:source.index('$$;', start) + 3]
        helpers = function_source('20261021220730_fair_generation_queue.sql',
            'create function app_private.queue_work_class') + '\n' + function_source(
            '20261104121443_automatic_usage_recovery.sql', 'create function app_private.model_usage_blocks_recovery')
        child = function_source('20261108175251_generation_retry_modern_usage_scope.sql',
            'create function app_private.assert_generation_retry_usage')
        script = """
import {PGlite} from '@electric-sql/pglite';
let input=''; for await(const chunk of process.stdin) input+=chunk;
const x=JSON.parse(input), db=new PGlite(); await db.exec(x.schema); await db.exec(x.helpers);
async function read(sql){const r=await db.exec(sql);return r.flatMap(v=>v.rows??[]).find(v=>v.jsonb_build_object)?.jsonb_build_object;}
const normal=await read(x.inspect), accepted=await read(x.acceptance);
await db.exec(`UPDATE identity_allowlist SET status='disabled'`); const disabled=await read(x.inspect);
await db.exec(`UPDATE identity_allowlist SET status='active'; INSERT INTO provider_usage(workspace_id,state) VALUES('${x.w}','reserved')`); const reserved=await read(x.inspect);
await db.exec(`UPDATE provider_usage SET state='unknown'`); const unknown=await read(x.inspect);
await db.exec(`INSERT INTO model_routing VALUES('${x.w}',true)`); const routed=await read(x.inspect);
await db.exec(`UPDATE proposal_issuance_requests SET idempotency_key='different'`); const mismatch=await read(x.acceptance);
const diagnostic=await read(x.diagnostic);
await db.exec(`INSERT INTO provider_usage(workspace_id,state,remote_request_id) SELECT '${x.w}','reserved','private-remote-id' FROM generate_series(1,101)`);
const bounded=await read(x.diagnostic);
await db.exec(`UPDATE model_routing SET enabled=false;
 UPDATE provider_usage SET state='unknown',remote_request_id=null,created_at=now()-interval '20 minutes',remote_deadline=null;
 INSERT INTO model_execution_settings(workspace_id,enabled,admitted_after) VALUES('${x.w}',true,now()-interval '1 day');
 INSERT INTO jobs(id,workspace_id,entity_id,status,checkpoint,type) VALUES('${x.j}','${x.w}','${x.g}','failed','{}','analyze_chunk');
 INSERT INTO generation_steps VALUES('${x.w}','${x.j}','${x.g}','queued')`);
const parentModern=await read(x.inspect);
await db.exec(x.child); const childUntouched=await read(x.inspect);
await db.exec(`UPDATE jobs SET checkpoint='{"model_executor":2,"model_routing":{"mode":"round_robin"}}';
 UPDATE model_execution_settings SET enabled=false,admitted_after=now()+interval '1 day'`);
const childFrozen=await read(x.inspect);
await db.exec(`INSERT INTO provider_usage(workspace_id,state,job_id) VALUES('${x.w}','unknown','${x.j}')`);
const childRecent=await read(x.inspect);
await db.exec(`UPDATE provider_usage SET created_at=now()-interval '20 minutes' WHERE job_id='${x.j}'`);
const childAged=await read(x.inspect);
await db.exec(`UPDATE jobs SET checkpoint='{"model_routing":{"mode":"manual"}}'`);
const childManual=await read(x.inspect);
await db.exec(`UPDATE jobs SET type='advance_plan'`);
const childLocalDenied=await read(x.inspect);
await db.exec(`UPDATE model_execution_settings SET enabled=true,admitted_after=now()-interval '1 day'`);
const childLocalAllowed=await read(x.inspect);
await db.exec(`UPDATE provider_usage SET state='reserved' WHERE id=(SELECT id FROM provider_usage LIMIT 1)`);
const childReserved=await read(x.inspect);
await db.exec(`INSERT INTO jobs(id,workspace_id,entity_id,status,type,next_attempt_at) SELECT gen_random_uuid(),'${x.w}','${x.g}','queued','draft_section',now()+interval '1 hour' FROM generate_series(1,101)`);
const queueBounded=await read(x.diagnostic);
console.log(JSON.stringify({normal,accepted,disabled,reserved,unknown,routed,mismatch,diagnostic,bounded,
 parentModern,childUntouched,childFrozen,childRecent,childAged,childManual,childLocalDenied,childLocalAllowed,childReserved,queueBounded})); await db.close();
"""
        result = subprocess.run(['node', '--input-type=module', '-e', script], input=json.dumps({
            'schema': schema, 'inspect': inspect_sql, 'acceptance': m.acceptance_sql(prepared), 'diagnostic': m.diagnostic_sql(proof['selection']), 'w': W, 'j': J, 'g': G, 'helpers': helpers, 'child': child}),
            text=True, capture_output=True, cwd=HERE.parent.parent, timeout=35)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(m.prepare(data['normal'])['operation'], 'generation.retry')
        self.assertFalse(data['disabled']['guards']['unique_active_owner'])
        self.assertFalse(data['reserved']['guards']['usage_ready'])
        self.assertFalse(data['unknown']['guards']['usage_ready'])
        self.assertTrue(data['routed']['guards']['usage_ready'])
        self.assertEqual(data['accepted']['count'], 1); self.assertTrue(data['accepted']['bound'])
        self.assertEqual(data['accepted']['target']['operation'], 'generation.retry')
        self.assertEqual(data['mismatch']['count'], 0)
        self.assertEqual(data['diagnostic']['unknown_count'], 1)
        self.assertTrue(data['diagnostic']['routing_enabled'])
        m.validate_verifier_diagnostic(data['diagnostic'])
        m.validate_queue_diagnostic(data['diagnostic'])
        queue = data['diagnostic']['queue_diagnostics']
        self.assertEqual(queue['job_count'], 1)
        self.assertEqual(queue['jobs'][0]['graph']['checkpoints']['count'], 1)
        self.assertEqual(queue['jobs'][0]['graph']['results']['count'], 1)
        self.assertEqual(queue['dispatch']['generation'], 7)
        self.assertEqual(queue['timers']['count'], 2)
        self.assertEqual(queue['timers']['due_count'], 1)
        m.validate_queue_diagnostic(data['queueBounded'])
        self.assertEqual(data['queueBounded']['queue_diagnostics']['job_count'], 103)
        self.assertEqual(len(data['queueBounded']['queue_diagnostics']['jobs']), 100)
        self.assertTrue(data['queueBounded']['queue_diagnostics']['jobs_truncated'])
        for mutation in ('payload', 'timestamp', 'count'):
            changed = copy.deepcopy(data['diagnostic'])
            if mutation == 'payload': changed['queue_diagnostics']['jobs'][0]['checkpoint'] = {'private': True}
            elif mutation == 'timestamp': changed['queue_diagnostics']['dispatch']['last_periodic_at'] = 'customer text'
            else: changed['queue_diagnostics']['reserved_workspace'] += 1
            with self.subTest(mutation=mutation), self.assertRaises(m.TrialRequestError):
                m.validate_queue_diagnostic(changed)

        projected = data['diagnostic']['verifier_diagnostics']
        self.assertEqual(projected['plan_id'], G)
        self.assertEqual(projected['report_count'], 1)
        self.assertEqual(projected['reports'][0]['diagnostics'], [{
            'code': 'EVIDENCE_REFERENCE_INVALID', 'reason': 'source_quote_mismatch',
            'paths': ['$.claims[0].source_refs[0].quote']}])
        self.assertEqual(projected['attempts'][0]['model_config_id'], '00000000-0000-4000-8000-000000000903')
        route = data['diagnostic']['verifier_routes'][0]
        self.assertEqual((route['revision'], route['models'][0]['revision'], route['models'][0]['connection_revision']), (7, 5, 3))
        for private in ['private-project', 'private-customer-content', 'private-checkpoint-payload', '99999', 'numeric_literals']:
            self.assertNotIn(private, json.dumps(data['diagnostic']))
        self.assertEqual(data['bounded']['total'], 102)
        self.assertTrue(data['bounded']['truncated'])
        self.assertEqual(len(data['bounded']['rows']), 100)
        self.assertTrue(all(row['state'] == 'reserved' and row['has_remote_request'] for row in data['bounded']['rows']))
        self.assertNotIn('private-remote-id', json.dumps(data['bounded']))
        self.assertNotIn('remote_request_id', json.dumps(data['bounded']))
        self.assertFalse(data['parentModern']['retry_usage']['modern_guard_installed'])
        self.assertTrue(data['parentModern']['retry_usage']['modern_admission'])
        self.assertFalse(data['parentModern']['guards']['usage_ready'])
        for name in ('childUntouched', 'childFrozen', 'childAged', 'childLocalAllowed'):
            self.assertTrue(data[name]['retry_usage']['modern_guard_installed'], name)
            self.assertTrue(data[name]['guards']['usage_ready'], name)
            self.assertEqual(m.prepare(data[name])['operation'], 'generation.retry', name)
        for name in ('childRecent', 'childManual', 'childLocalDenied', 'childReserved'):
            self.assertFalse(data[name]['guards']['usage_ready'], name)
        self.assertEqual(data['childRecent']['retry_usage']['blocked_model_jobs'], 1)
        self.assertEqual(data['childAged']['retry_usage']['blocked_model_jobs'], 0)
        self.assertEqual(data['childLocalDenied']['retry_usage']['queued_model_jobs'], 0)


if __name__ == '__main__':
    unittest.main()
