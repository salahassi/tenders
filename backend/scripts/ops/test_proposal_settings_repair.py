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
SPEC = importlib.util.spec_from_file_location('settings_repair_tests', HERE / 'proposal-settings-repair.py')
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)
W = m.request.auth.access.WORKSPACE
O, P, A, J, C, M, L, R, D, S = ['00000000-0000-4000-8000-%012d' % n for n in range(101, 111)]
PROFILE = {'revision': 1, 'max_output_tokens': 8192, 'reasoning': 'high', 'require_native_strict': False}


def fixture():
    now = datetime.now(timezone.utc).isoformat()
    def row(id): return {'id': id, 'workspace_id': W, 'revision': 3, 'created_by': A,
                         'created_at': '2026-10-29T00:00:00+00:00', 'updated_at': '2026-10-29T00:00:00+00:00'}
    return {'version': 1, 'kind': 'proposal_settings_repair_proof', 'observed_at': now,
        'selection': {'version': 1, 'workspace_id': W, 'opportunity_id': O}, 'actor_id': A,
        'anchor': {'attempt_id': '21', 'job_id': J, 'plan_id': P, 'model_config_id': M, 'model': m.TARGET_MODEL},
        'plan': {'id': P, 'status': 'failed', 'revision': 8, 'error_code': 'PROPOSAL_ISSUANCE_TIMEOUT'},
        'target': {'id': M, 'connection_id': C, 'model': m.TARGET_MODEL, 'revision': 2, 'enabled': True,
                   'connection_enabled': True, 'connection_revision': 4, 'provider': 'openai', 'capabilities': {}},
        'route': row(R) | {'task': 'verify_grounding', 'model_ids': [L], 'inherit_default': True,
                           'strategy': 'priority', 'profile': PROFILE, 'next_position': 1},
        'default_route': row(D) | {'task': 'default', 'model_ids': [M], 'inherit_default': False,
                           'strategy': 'priority', 'profile': None, 'next_position': 0},
        'settings': row(S) | {'enabled': True, 'max_parallel_requests': 2, 'admitted_after': '2026-10-29T00:00:00+00:00'},
        'protected': dict.fromkeys(m.PROTECTED, 'a' * 64), 'saved_catalog_count': 29,
        'guards': dict.fromkeys(m.GUARDS, True)}


def diagnostic(proof):
    routes = []
    for name in ('route', 'default_route'):
        route = proof[name]
        routes.append({k: route[k] for k in ('task', 'revision', 'inherit_default', 'strategy', 'profile', 'next_position')} | {
            'models': [{'id': id, 'model': m.TARGET_MODEL if id == M else 'fixture-luna', 'enabled': True,
                        'revision': 2, 'connection_enabled': True, 'connection_revision': 4} for id in route['model_ids']]})
    return {'version': 1, 'kind': 'proposal_trial_report', 'mode': 'inspect', 'cleanup_verified': True,
        'selection': proof['selection'], 'proof': {'selection': proof['selection'], 'plan': proof['plan']},
        'admission_diagnostic': {'kind': 'proposal_trial_usage_diagnostic', 'selection': proof['selection'],
            'verifier_diagnostics': {'plan_id': P, 'attempts': [{k: v for k, v in proof['anchor'].items() if k != 'plan_id'} | {'code': 'SUCCEEDED'}]},
            'verifier_routes': routes, 'modern_execution': {k: proof['settings'][k] for k in
                ('enabled', 'revision', 'max_parallel_requests', 'admitted_after')}}}


class SettingsRepairTests(unittest.TestCase):
    def setUp(self):
        m._ATTEMPTED.clear()
        self.proof = fixture()
        self.prepared = m.prepare(self.proof, 'b' * 64)
        self.client = Mock()
        self.client.request.return_value = Mock(status=200, body=b'{}')
        self.session = {'user': {'id': A}, 'access_token': 'synthetic-session'}
        self.persist = lambda value: hashlib.sha256(m.encoded(value)).hexdigest()

    def test_exact_two_commands_preserve_profile_strategy_enabled_and_cutoff(self):
        self.assertEqual(self.prepared['body'], {'commands': [
            {'operation': 'model.task_route.save', 'input': {'expected_revision': 3, 'task': 'verify_grounding',
                'model_ids': [M], 'inherit_default': False, 'strategy': 'priority', 'profile': PROFILE}},
            {'operation': 'model.execution.configure', 'input': {'expected_revision': 3, 'enabled': True, 'max_parallel_requests': 4}}]})
        altered = copy.deepcopy(self.proof); altered['observed_at'] = '2025-01-01T00:00:00+00:00'
        next_plan = m.prepare(altered, 'c' * 64)
        self.assertEqual(next_plan['prepared_object'], self.prepared['prepared_object'])
        self.assertEqual(next_plan['idempotency_key'], self.prepared['idempotency_key'])
        self.assertNotIn('admitted_after', self.prepared['body']['commands'][1]['input'])

    def test_already_fixed_command_is_omitted_and_fully_repaired_is_refused(self):
        proof = copy.deepcopy(self.proof); proof['settings']['max_parallel_requests'] = 4
        self.assertEqual(len(m.prepare(proof, 'b' * 64)['body']['commands']), 1)
        proof['route'].update(model_ids=[M], inherit_default=False)
        with self.assertRaisesRegex(RuntimeError, 'ALREADY_REPAIRED'): m.prepare(proof, 'b' * 64)
        proof['settings']['max_parallel_requests'] = 2
        self.assertEqual(m.prepare(proof, 'b' * 64)['body']['commands'][0]['operation'], 'model.execution.configure')

    def test_disabled_changed_capacity_unproven_target_or_guard_fails_closed(self):
        for guard in m.GUARDS:
            bad = copy.deepcopy(self.proof); bad['guards'][guard] = False
            with self.assertRaises(RuntimeError): m.prepare(bad, 'b' * 64)
        for name, key, value in [('settings', 'enabled', False), ('settings', 'max_parallel_requests', 3),
                                 ('target', 'enabled', False), ('target', 'connection_enabled', False),
                                 ('target', 'model', 'unreviewed-model')]:
            bad = copy.deepcopy(self.proof); bad[name][key] = value
            with self.assertRaises(RuntimeError): m.prepare(bad, 'b' * 64)

    def test_exact_diagnostic_requires_unique_success_and_current_routes(self):
        incoming = diagnostic(self.proof)
        with patch.object(m, 'inspect', return_value=self.proof):
            planned = m.plan(object(), incoming)
            self.assertEqual(planned['proof'], self.proof)
            incoming['admission_diagnostic']['modern_execution']['revision'] += 1
            with self.assertRaisesRegex(RuntimeError, 'DIAGNOSTIC_SETTINGS_CHANGED'): m.plan(object(), incoming)
        incoming = diagnostic(self.proof)
        incoming['admission_diagnostic']['verifier_diagnostics']['attempts'].append(
            incoming['admission_diagnostic']['verifier_diagnostics']['attempts'][0] | {'model_config_id': L})
        with self.assertRaisesRegex(RuntimeError, 'UNIQUE_PROVEN_MODEL_REQUIRED'): m.anchor_from_report(incoming)

    def test_recheck_detects_catalog_connection_revision_allowance_profile_and_target_changes(self):
        for name, key, value in [('target', 'connection_revision', 5), ('target', 'revision', 3),
                                 ('protected', 'model_settings', 'c' * 64), ('route', 'profile', None),
                                 ('settings', 'admitted_after', '2026-11-08T00:00:00+00:00')]:
            fresh = copy.deepcopy(self.proof); fresh[name][key] = value
            with patch.object(m, 'inspect', return_value=fresh):
                with self.assertRaisesRegex(RuntimeError, 'CHANGED_BEFORE_SEND'): m.recheck(object(), self.prepared)

    def test_one_send_follows_durable_readback_then_fresh_proof(self):
        events = []
        def persist(value): events.append('persist'); return self.persist(value)
        def fresh(): events.append('fresh'); return self.proof
        def post(*args, **kwargs): events.append('post'); return Mock(status=200, body=b'{}')
        self.client.request.side_effect = post
        result = m.send(self.client, self.session, self.prepared, persist, fresh)
        self.assertEqual(events, ['persist', 'fresh', 'post'])
        self.assertTrue(result['accepted'])
        self.client.request.assert_called_once_with('/functions/v1/api/v1/commands', token='synthetic-session', method='POST',
            data=self.prepared['body'], headers={'Idempotency-Key': self.prepared['idempotency_key']})

    def test_unknown_send_never_repeats_and_intent_failure_never_sends(self):
        with self.assertRaisesRegex(RuntimeError, 'INTENT_READBACK_FAILED'):
            m.send(self.client, self.session, self.prepared, lambda _: '0' * 64, lambda: self.proof)
        self.client.request.assert_not_called()
        self.client.request.side_effect = OSError('synthetic transport interruption')
        with self.assertRaises(OSError): m.send(self.client, self.session, self.prepared, self.persist, lambda: self.proof)
        with self.assertRaisesRegex(RuntimeError, 'ALREADY_ATTEMPTED'):
            m.send(self.client, self.session, self.prepared, self.persist, lambda: self.proof)
        self.client.request.assert_called_once()

    def test_readback_requires_exact_atomic_receipts_and_preserved_configuration(self):
        after = copy.deepcopy(self.proof)
        after['route'].update(model_ids=[M], inherit_default=False, next_position=0, revision=4)
        after['settings'].update(max_parallel_requests=4, revision=4)
        receipt = {'count': 2, 'batch': True, 'results': [after['route'], after['settings']]}
        with patch.object(m.request, 'read', side_effect=[receipt, after]):
            self.assertTrue(m.verify_result(object(), self.prepared)['accepted'])
        after['settings']['admitted_after'] = 'changed'
        with patch.object(m.request, 'read', side_effect=[receipt, after]):
            with self.assertRaisesRegex(RuntimeError, 'SETTING_READBACK_CHANGED'): m.verify_result(object(), self.prepared)
        with patch.object(m.request, 'read', return_value={'count': 1, 'batch': False, 'results': []}):
            with self.assertRaisesRegex(RuntimeError, 'ACCEPTANCE_UNPROVEN'): m.verify_result(object(), self.prepared)

    def test_queries_are_read_only_and_bind_actual_success_actor_bodies_and_keys(self):
        inspect = m.inspection_sql(self.proof['selection'], self.proof['anchor'])
        accepted = m.acceptance_sql(self.prepared)
        for sql in (inspect, accepted):
            self.assertIn('REPEATABLE READ READ ONLY', sql)
            self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
            self.assertNotRegex(sql, r'(?i)\b(insert|update|delete|truncate|grant|revoke)\b|app_command\(')
        for text in ["a.operation='verify_grounding'", "a.status='succeeded'", "a.result_code='SUCCEEDED'", 't.id=a.model_config_id']:
            self.assertIn(text, inspect)
        for text in self.prepared['command_keys'] + [self.prepared['idempotency_key'], A, "state='ready'", 'body_hash=']:
            self.assertIn(text, accepted)


if __name__ == '__main__':
    unittest.main()
