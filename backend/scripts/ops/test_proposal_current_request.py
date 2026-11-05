import copy
from contextlib import contextmanager, redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('proposal_current_request_test_target', Path(__file__).with_name('proposal-current-request.py'))
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)


@contextmanager
def key(*args):
    yield 'private-key'


class CurrentRequestTests(unittest.TestCase):
    def setUp(self):
        self.selection = {'version': 1, 'workspace_id': m.access.WORKSPACE,
            'opportunity_id': '00000000-0000-4000-8000-000000000101', 'plan_id': '00000000-0000-4000-8000-000000000102'}
        self.before = {'version': 1, 'kind': 'current_proposal_read_only_proof', 'selection': self.selection,
            'actor_id': '00000000-0000-4000-8000-000000000103', 'proposal_id': '00000000-0000-4000-8000-000000000104',
            'expected_plan_revision': 287, 'expected_opportunity_revision': 12, 'expected_proposal_revision': 3,
            'preserved_input_hash': 'a' * 64, 'plan_status': 'blocked', 'proposal_plan_count': 2,
            'source_manifest_sha256': 'b' * 64, 'prospective_snapshot_sha256': 'c' * 64, 'guards': dict.fromkeys(m.GUARDS, True),
            'protected_history': {name: {'count': 1, 'sha256': 'c' * 64} for name in m.HISTORY}}
        details = {'plan_id': self.selection['plan_id'], 'expected_plan_revision': 287,
            'preserved_input_hash': 'a' * 64, 'cancel_required': True, 'opportunity_id': self.selection['opportunity_id'],
            'expected_opportunity_revision': 12, 'proposal_id': self.before['proposal_id'],
            'expected_proposal_revision': 3, 'base_version_id': None, 'next_operation': 'proposal.generate'}
        body = {'commands': [{'operation': 'generation.cancel', 'input': {'id': self.selection['plan_id'],
            'expected_revision': 287, 'reason': m.REASON}}, {'operation': 'proposal.generate',
            'input': {'id': self.selection['opportunity_id'], 'expected_revision': 12}}]}
        self.prepared = {'idempotency_key': '00000000-0000-4000-8000-000000000105', 'body': body,
            'server_owned_details': details, 'body_sha256': hashlib.sha256(m.encoded(body)).hexdigest()}
        self.child_report = {'version': 1, 'kind': 'actual_current_proposal_request', 'outcome': 'started',
            'successor_plan_id': '00000000-0000-4000-8000-000000000106',
            'issuance_request_id': '00000000-0000-4000-8000-000000000107',
            'browser_commands': {'resume': 1, 'batch': 1, 'unexpected_mutations': 0}, 'checks': ['actual_ui'],
            'request_body_sha256': self.prepared['body_sha256'], 'prepared_request_sha256': 'd' * 64,
            'browser_cleanup_confirmed': True, 'browser_api_reads': 1900}
        self.env = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': 'salahassi/tenders', 'GITHUB_RUN_ATTEMPT': '1',
            'GITHUB_RUN_ID': '123', 'GITHUB_SHA': 'e' * 40, 'RUN_CURRENT_PROPOSAL_REQUEST': 'true',
            'GITHUB_JOB': 'request', 'GITHUB_WORKFLOW_REF': 'salahassi/tenders/.github/workflows/request-current-proposal.yml@refs/heads/main',
            'DIGITALOCEAN_ACCESS_TOKEN': 'private-deployment-token'}
        self.image = 'registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:' + 'f' * 64
        self.args = ['--activate', '--selection-object', 'requests/fixture.bundle', '--selection-sha256', 'a' * 64,
                     '--expected-runtime-image', self.image]

    def test_both_explicit_activation_gates_precede_all_access(self):
        for args, env in [(self.args, {'RUN_CURRENT_PROPOSAL_REQUEST': 'false'}), ([], self.env)]:
            with patch.dict(os.environ, env), patch.object(m.access, 'prepare_cluster') as cluster, redirect_stdout(io.StringIO()) as out:
                self.assertEqual(m.main(args), 0)
                self.assertEqual(json.loads(out.getvalue())['actual_current_proposal_request'], 'not_activated')
                cluster.assert_not_called()

    def test_actions_original_attempt_is_required(self):
        for changes in ({'GITHUB_ACTIONS': 'false'}, {'GITHUB_RUN_ATTEMPT': '2'}, {'GITHUB_REPOSITORY': 'other/repo'},
                        {'GITHUB_JOB': 'verify'}, {'GITHUB_WORKFLOW_REF': ''},
                        {'GITHUB_WORKFLOW_REF': 'salahassi/tenders/.github/workflows/other.yml@refs/heads/main'}):
            with patch.dict(os.environ, self.env | changes), patch.object(m.access, 'prepare_cluster') as cluster, redirect_stdout(io.StringIO()) as out:
                self.assertEqual(m.main(self.args), 1)
                self.assertEqual(json.loads(out.getvalue())['code'], 'CURRENT_REQUEST_FIRST_ACTIONS_ATTEMPT_REQUIRED')
                cluster.assert_not_called()

    def test_four_field_selection_has_no_mutable_controls(self):
        self.assertEqual(m.validate_selection(self.selection), self.selection)
        for changes in ({'version': True}, {'plan_id': "';DELETE"}, {'workspace_id': self.before['actor_id']},
                        {'expected_revision': 280}, {'mode': 'restart'}):
            with self.assertRaises(m.CurrentRequestError):
                m.validate_selection(self.selection | changes)

    def test_read_only_sql_scope_and_protected_history(self):
        sql = m.inspection_sql(self.selection)
        self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', sql)
        self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
        self.assertIn("statement_timeout='30s'", sql)
        self.assertIn("m.active AND m.role='Owner'", sql)
        self.assertIn("a.status='active' AND a.role='Owner'", sql)
        self.assertIn("p.id='" + self.selection['plan_id'] + "'", sql)
        self.assertIn("s.status='completed'", sql)
        self.assertIn("u.state='unknown'", sql)
        self.assertIn("frozen=current AND jsonb_array_length(frozen)>0", sql)
        for name in m.HISTORY:
            self.assertIn("'" + name + "'", sql)
        self.assertNotRegex(sql, r'(?i)\b(insert|update|delete|truncate|grant|revoke)\b|app_command\(|auth\.users|for update|set_config\(')

    def test_every_fresh_guard_is_required_without_fixed_revision(self):
        self.assertIs(m.validate_proof(self.before, self.selection, before=True), self.before)
        for guard in m.GUARDS:
            changed = copy.deepcopy(self.before)
            changed['guards'][guard] = False
            with self.assertRaisesRegex(m.CurrentRequestError, 'PRECONDITION_' + guard.upper()):
                m.validate_proof(changed, self.selection, before=True)

    def test_prepared_is_exact_server_owned_cancel_generate(self):
        self.assertIs(m.validate_prepared(self.prepared, self.selection, self.before), self.prepared)
        for field, value in [('cancel_required', False), ('preserved_input_hash', '9' * 64), ('expected_plan_revision', 280),
                             ('next_operation', 'proposal.regenerate'), ('base_version_id', self.before['actor_id'])]:
            request = copy.deepcopy(self.prepared)
            request['server_owned_details'][field] = value
            with self.assertRaises(m.CurrentRequestError):
                m.validate_prepared(request, self.selection, self.before)
        request = copy.deepcopy(self.prepared)
        request['body']['commands'].reverse()
        request['body_sha256'] = hashlib.sha256(m.encoded(request['body'])).hexdigest()
        with self.assertRaises(m.CurrentRequestError):
            m.validate_prepared(request, self.selection, self.before)

    def test_persistence_object_binds_only_immutable_predecessor_identity(self):
        name = m.prepared_object(self.selection)
        reordered = dict(reversed(list(self.selection.items())))
        self.assertEqual(name, m.prepared_object(reordered))
        self.assertNotEqual(name, m.prepared_object(self.selection | {'plan_id': self.before['proposal_id']}))
        # Neither runtime image nor raw encrypted-selection hash participates:
        # the same predecessor always resolves the same no-resend marker.
        self.assertEqual(m.prepared_object(self.selection), name)
        m.transfer.identity(m.BUCKET, name)
        self.assertLess(len(name), 200)

    def test_every_pre_send_revision_source_and_history_change_stops_before_ack(self):
        keys = ('actor_id', 'proposal_id', 'expected_plan_revision', 'expected_opportunity_revision',
                'expected_proposal_revision', 'preserved_input_hash', 'proposal_plan_count',
                'source_manifest_sha256', 'prospective_snapshot_sha256', 'protected_history')
        for key in keys:
            changed = copy.deepcopy(self.before)
            if key == 'protected_history': changed[key]['unknown_usage']['sha256'] = 'f' * 64
            elif key.endswith('revision') or key == 'proposal_plan_count': changed[key] += 1
            elif key.endswith('_id'): changed[key] = self.selection['plan_id']
            else: changed[key] = 'f' * 64
            with patch.object(m, 'inspect', return_value=changed), patch.object(m.runtime, 'verify_runtime') as runtime:
                with self.assertRaisesRegex(m.CurrentRequestError, 'CHANGED_BEFORE_SEND'):
                    m.recheck_before_send(object(), self.selection, self.before, self.image)
                runtime.assert_not_called()

    def test_fresh_checks_surround_durable_persistence(self):
        order = []
        with patch.object(m, 'recheck_before_send', side_effect=lambda *args: order.append('check')), \
             patch.object(m, 'persist_request', side_effect=lambda *args: order.append('persist') or 'd' * 64):
            self.assertEqual(m.prepare_and_recheck(self.prepared, self.selection, self.before,
                {'expected_runtime_image': self.image}, [], object()), 'd' * 64)
        self.assertEqual(order, ['check', 'persist', 'check'])
        with patch.object(m, 'recheck_before_send', side_effect=[self.before, m.CurrentRequestError('CURRENT_REQUEST_CHANGED_BEFORE_SEND')]), \
             patch.object(m, 'persist_request', return_value='d' * 64) as persist:
            with self.assertRaisesRegex(m.CurrentRequestError, 'CHANGED_BEFORE_SEND'):
                m.prepare_and_recheck(self.prepared, self.selection, self.before,
                    {'expected_runtime_image': self.image}, [], object())
            persist.assert_called_once()

    def test_existing_prepared_object_is_never_overwritten(self):
        with (patch.object(m.transfer, 'temporary_key', key), patch.object(m.transfer, 'spaces', return_value=b'') as spaces,
                patch.object(m.transfer, 'database_password', return_value='private'), patch.object(m.transfer, 'encrypt', return_value=b'ciphertext')):
            with self.assertRaisesRegex(m.CurrentRequestError, 'PREPARED_ALREADY_EXISTS'):
                m.upload_once('token', 'diagnostics/existing.bundle', b'private-json')
            self.assertEqual([c.args[3] for c in spaces.call_args_list], ['HEAD'])

    def test_upload_once_requires_absence_then_exact_ciphertext_readback(self):
        for result, expected in [(b'ciphertext', None), (b'wrong', 'PERSISTENCE_READBACK_FAILED')]:
            with (patch.object(m.transfer, 'temporary_key', key), patch.object(m.transfer, 'database_password', return_value='private'),
                    patch.object(m.transfer, 'encrypt', return_value=b'ciphertext'), patch.object(m.transfer, 'spaces',
                    side_effect=[m.transfer.TransferError('SPACES_HTTP_404'), b'', result]) as spaces):
                if expected:
                    with self.assertRaisesRegex(m.CurrentRequestError, expected):
                        m.upload_once('token', 'diagnostics/new.bundle', b'private-json')
                else:
                    self.assertEqual(m.upload_once('token', 'diagnostics/new.bundle', b'private-json'), hashlib.sha256(b'private-json').hexdigest())
                self.assertEqual([c.args[3] for c in spaces.call_args_list], ['HEAD', 'PUT', 'GET'])

    def protocol(self, events, persist=None, capture=True):
        child = Mock()
        child.poll.return_value = None
        child.returncode = 0
        output = []
        child.stdin.write.side_effect = lambda raw: output.append(json.loads(raw)) if json.loads(raw).get('event') != 'browser_captured' else None
        selector = Mock()
        selector.__enter__ = Mock(return_value=selector)
        selector.__exit__ = Mock(return_value=False)
        selector.select.return_value = [(None, None)]
        events = ([{'event': 'browser_started', 'pid': 12345}] if capture else []) + events
        reads = [m.encoded(event) + b'\n' if isinstance(event, dict) else event for event in events] + [b'']
        state = {}
        with (patch.object(m.subprocess, 'Popen', return_value=child), patch.object(m.selectors, 'DefaultSelector', return_value=selector),
                patch.object(m.os, 'read', side_effect=reads), patch.object(m, 'terminate_child') as terminate,
                patch.object(m, 'capture_browser', return_value={'pid': 12345, 'group': 12345, 'start': 'synthetic'}),
                patch.object(m, 'terminate_browser')):
            try:
                report = m.run_child({'initial': 'session'}, persist or (lambda request: 'd' * 64), state)
                return report, state, output
            finally:
                terminate.assert_called_once_with(child)
                self.last_protocol = state, output

    def test_preparation_requires_browser_process_capture(self):
        with self.assertRaisesRegex(m.CurrentRequestError, 'PROTOCOL_INVALID'):
            self.protocol([{'event': 'prepared', 'request': self.prepared}], capture=False)
        self.assertNotIn('acknowledged', self.last_protocol[0])

    def test_browser_capture_requires_live_detached_direct_child(self):
        child = Mock(pid=1234)
        valid = {'pid': 5678, 'parent': 1234, 'group': 5678, 'start': '123', 'state': 'S'}
        with patch.object(m, 'process_identity', return_value=valid):
            self.assertEqual(m.capture_browser(5678, child), valid)
        for changed in (None, valid | {'parent': 4321}, valid | {'group': 1234}, valid | {'state': 'Z'}):
            with patch.object(m, 'process_identity', return_value=changed), self.assertRaises(m.CurrentRequestError):
                m.capture_browser(5678, child)

    def test_parent_persists_before_ack_then_accepts_one_result(self):
        def persist(request):
            self.assertEqual(request, self.prepared)
            self.assertFalse(self.last_ack)
            self.last_ack = True
            return 'd' * 64
        self.last_ack = False
        report, state, messages = self.protocol([{'event': 'prepared', 'request': self.prepared},
            {'event': 'result', 'report': self.child_report}], persist)
        self.assertEqual(report['outcome'], 'started')
        self.assertTrue(state['acknowledged'])
        self.assertEqual(messages, [{'initial': 'session'}, {'event': 'persisted', 'body_sha256': self.prepared['body_sha256'], 'report_sha256': 'd' * 64}])

    def test_persistence_failure_never_sends_ack(self):
        def fail(request):
            raise m.CurrentRequestError('CURRENT_REQUEST_PERSISTENCE_READBACK_FAILED')
        with self.assertRaisesRegex(m.CurrentRequestError, 'READBACK_FAILED'):
            self.protocol([{'event': 'prepared', 'request': self.prepared}], fail)
        state, messages = self.last_protocol
        self.assertNotIn('acknowledged', state)
        self.assertEqual(len(messages), 1)
        self.assertTrue(state['child_termination_confirmed'])

    def test_lost_response_preserves_acknowledged_unknown_boundary(self):
        with self.assertRaisesRegex(m.CurrentRequestError, 'INCOMPLETE'):
            self.protocol([{'event': 'prepared', 'request': self.prepared}])
        state, messages = self.last_protocol
        self.assertTrue(state['acknowledged'])
        self.assertEqual(state['prepared_request_sha256'], 'd' * 64)
        self.assertEqual(len(messages), 2)

    def test_duplicate_prepare_extra_event_and_oversize_fail_closed(self):
        for events in [
            [{'event': 'prepared', 'request': self.prepared}, {'event': 'prepared', 'request': self.prepared}],
            [{'event': 'result', 'report': self.child_report}],
            [b'X' * (m.MAX_LINE + 1)],
            [b'private-unparseable-content\n'],
        ]:
            with self.assertRaises(m.CurrentRequestError):
                self.protocol(events)

    def test_child_report_hash_mismatch_never_confirms_success(self):
        report = self.child_report | {'prepared_request_sha256': '0' * 64}
        with self.assertRaisesRegex(m.CurrentRequestError, 'HASH_MISMATCH'):
            self.protocol([{'event': 'prepared', 'request': self.prepared}, {'event': 'result', 'report': report}])

    def test_report_blocks_content_secrets_unexpected_mutations_and_approval(self):
        for changes in [{'html': 'private-document'}, {'code': 'private secret'}, {'checks': ['customer paragraph']},
                        {'browser_commands': {'resume': 1, 'batch': 2, 'unexpected_mutations': 0}}]:
            with self.assertRaises(m.CurrentRequestError):
                m.validate_report(self.child_report | changes)
        with self.assertRaisesRegex(m.CurrentRequestError, 'SECRET_IN_REPORT'):
            m.no_secrets({'checks': ['private_secret']}, ['private_secret'])
        public = m.public_receipt(self.child_report, 'a' * 64)
        self.assertNotIn(self.child_report['successor_plan_id'], json.dumps(public))
        self.assertEqual(set(public), {'actual_current_proposal_request', 'resume_commands', 'batch_commands', 'report_sha256', 'send_authorized'})

    def test_child_environment_drops_all_cloud_credentials(self):
        with patch.dict(os.environ, {'DIGITALOCEAN_ACCESS_TOKEN': 'secret', 'AWS_SECRET_ACCESS_KEY': 'secret',
                'GITHUB_TOKEN': 'secret', 'KUBECONFIG': '/private', 'NODE_EXTRA_CA_CERTS': '/configured/ca', 'PATH': '/bin'}):
            env = m.child_environment()
        self.assertEqual(env['NODE_EXTRA_CA_CERTS'], '/configured/ca')
        self.assertTrue({'DIGITALOCEAN_ACCESS_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'KUBECONFIG'}.isdisjoint(env))

    def test_postconditions_protect_every_historical_digest_even_unknown(self):
        for name in m.HISTORY:
            after = copy.deepcopy(self.before)
            after['protected_history'][name]['sha256'] = 'f' * 64
            with self.assertRaisesRegex(m.CurrentRequestError, 'POSTCONDITION_HISTORY_CHANGED'):
                m.postconditions(self.before, after, {'outcome': 'unknown'})
        after = copy.deepcopy(self.before)
        after.update(plan_status='canceled', expected_plan_revision=288, proposal_plan_count=3,
            latest_plan={'id': self.child_report['successor_plan_id'], 'proposal_id': self.before['proposal_id'],
                         'current_contract': True, 'issuance_request_id': self.child_report['issuance_request_id']})
        after['latest_issuance'] = {'id': self.child_report['issuance_request_id'], 'plan_id': self.child_report['successor_plan_id'],
            'requested_by': self.before['actor_id'], 'operation': 'proposal.generate',
            'accepted_at': '2026-11-05T00:00:00+00:00', 'deadline_at': '2026-11-05T00:10:00+00:00'}
        m.postconditions(self.before, after, self.child_report)
        without_id = {k: v for k, v in self.child_report.items() if k != 'issuance_request_id'}
        m.validate_report(without_id)
        self.assertEqual(m.bind_issuance(self.before, after, without_id), self.child_report)
        self.assertNotIn('issuance_request_id', without_id)
        for changed in [dict(self.child_report, issuance_request_id=self.selection['plan_id']),
                        dict(without_id, successor_plan_id=self.selection['plan_id']),
                        dict(without_id, outcome='unknown')]:
            with self.assertRaises(m.CurrentRequestError):
                m.bind_issuance(self.before, after, changed)
        for field in ['latest_issuance', 'latest_plan']:
            missing = copy.deepcopy(after)
            missing[field] = {}
            with self.assertRaises(m.CurrentRequestError):
                m.bind_issuance(self.before, missing, without_id)

        for key, value in [('deadline_at', '2026-11-05T00:11:00+00:00'), ('requested_by', self.selection['plan_id']),
                           ('accepted_at', '2026-11-05T00:00:00'), ('plan_id', self.selection['plan_id'])]:
            invalid = copy.deepcopy(after)
            invalid['latest_issuance'][key] = value
            with self.assertRaisesRegex(m.CurrentRequestError, 'ISSUANCE_MISMATCH'):
                m.postconditions(self.before, invalid, self.child_report)
        after['latest_plan']['current_contract'] = False
        with self.assertRaisesRegex(m.CurrentRequestError, 'POSTCONDITION_SUCCESSOR_MISMATCH'):
            m.postconditions(self.before, after, self.child_report)

    def test_existing_prepared_marker_stops_before_auth_and_browser(self):
        database = Mock()
        database.labels = {}
        with tempfile.TemporaryDirectory() as outer:
            directory = Path(outer) / 'private'
            directory.mkdir(mode=0o700)
            with (patch.dict(os.environ, self.env), patch.object(m.access, 'prepare_cluster', return_value=directory),
                    patch.object(m.runtime, 'verify_runtime'), patch.object(m.transfer, 'download'),
                    patch.object(m.transfer, 'read_private', return_value=m.encoded(self.selection)),
                    patch.object(m.observer, 'Client', return_value=database), patch.object(m, 'inspect', return_value=self.before),
                    patch.object(m, 'require_absent', side_effect=m.CurrentRequestError('CURRENT_REQUEST_PREPARED_ALREADY_EXISTS')),
                    patch.object(m.auth, 'genuine_session') as auth, patch.object(m, 'run_child') as browser,
                    patch.object(m.transfer, 'write_private'), patch.object(m.transfer, 'upload', return_value='a' * 64),
                    redirect_stdout(io.StringIO()) as out):
                self.assertEqual(m.main(self.args), 1)
            auth.assert_not_called()
            browser.assert_not_called()
            database.cleanup.assert_called_once()
            self.assertFalse(directory.exists())
        self.assertEqual(json.loads(out.getvalue())['code'], 'CURRENT_REQUEST_PREPARED_ALREADY_EXISTS')
        self.assertIs(json.loads(out.getvalue())['send_authorized'], False)

    def test_main_child_failure_still_inspects_logs_out_cleans_and_archives(self):
        config = {'ANON_KEY': 'private-anon', 'SERVICE_KEY': 'private-service', 'JWT_SECRET': 'private-jwt'}
        public = {'apiUrl': 'https://example.invalid', 'appOrigin': 'https://example.invalid', 'publishableKey': config['ANON_KEY']}
        session = {'access_token': 'private-access', 'refresh_token': 'private-refresh', 'user': {'id': self.before['actor_id']}}
        database, client = Mock(), Mock()
        database.labels = {}
        client.request.return_value = m.smoke.Response(204, b'')
        archives = []
        def broken_child(payload, persist, state, **kwargs):
            state.update(child_started=True, acknowledged=True, prepared_request_sha256='d' * 64)
            raise RuntimeError('private-customer-error')
        with tempfile.TemporaryDirectory() as outer:
            directory = Path(outer) / 'private'
            directory.mkdir(mode=0o700)
            with (patch.dict(os.environ, self.env), patch.object(m.access, 'prepare_cluster', return_value=directory),
                    patch.object(m.runtime, 'verify_runtime'), patch.object(m.transfer, 'download'),
                    patch.object(m.transfer, 'read_private', return_value=m.encoded(self.selection)),
                    patch.object(m.observer, 'Client', return_value=database), patch.object(m, 'inspect', return_value=self.before) as inspect,
                    patch.object(m, 'require_absent'), patch.object(m.access.d, 'decode_secret', return_value=config),
                    patch.object(m.access.d, 'get', return_value={'data': {'runtime-config.js': 'window.__TENDERDESK_CONFIG__=' + json.dumps(public) + ';'}}),
                    patch.object(m.smoke, 'Client', return_value=client), patch.object(m.auth, 'genuine_session', return_value=session),
                    patch.object(m.auth, 'verify_session'), patch.object(m, 'run_child', side_effect=broken_child),
                    patch.object(m.transfer, 'write_private', side_effect=lambda path, raw: archives.append(json.loads(raw))),
                    patch.object(m.transfer, 'upload', return_value='a' * 64), redirect_stdout(io.StringIO()) as out):
                self.assertEqual(m.main(self.args), 1)
            self.assertEqual(inspect.call_count, 2)
            database.cleanup.assert_called_once()
            self.assertEqual(client.request.call_args.args[0], '/auth/v1/logout?scope=local')
            self.assertEqual(client.request.call_args.kwargs['token'], 'private-access')
            self.assertFalse(directory.exists())
        result = json.loads(out.getvalue())
        self.assertEqual(result['actual_current_proposal_request'], 'unknown')
        self.assertIs(result['send_authorized'], True)
        self.assertEqual(result['code'], 'CURRENT_REQUEST_FAILED')
        self.assertNotIn('private-', out.getvalue())
        self.assertEqual(archives[0]['selection'], self.selection)
        self.assertIsNotNone(archives[0]['after'])
        self.assertTrue(archives[0]['cleanup']['auth_logout_confirmed'])


if __name__ == '__main__':
    unittest.main()
