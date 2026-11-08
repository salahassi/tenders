from contextlib import ExitStack
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('trial_runner_test', HERE / 'proposal-trial-runner.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class TrialRunnerTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {
            'GITHUB_SHA': 'a' * 40, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
            'RUN_PROPOSAL_TRIAL': 'true', 'DOKS_WORKDIR': '/private/fixture',
            'DIGITALOCEAN_ACCESS_TOKEN': 'synthetic-management-token'}))
        self.alarm = self.stack.enter_context(patch.object(m.signal, 'alarm'))
        self.stack.enter_context(patch.object(m.release, 'remaining_run_seconds', return_value=170))
        self.runtime = self.stack.enter_context(patch.object(m, 'verify_runtime'))
        self.incoming = {'version': 1, 'workspace_id': 'synthetic-workspace', 'opportunity_id': 'synthetic-opportunity'}
        self.target = {'workspace_id': self.incoming['workspace_id'], 'opportunity_id': self.incoming['opportunity_id'],
            'proposal_id': 'synthetic-proposal', 'plan_id': 'synthetic-plan',
            'issuance_request_id': 'synthetic-issuance', 'actor_id': 'synthetic-actor', 'operation': 'generation.retry'}
        self.input = self.stack.enter_context(patch.object(m, 'private_input', return_value=self.incoming))
        self.database = SimpleNamespace(labels={}, prepare=Mock())
        self.factory = self.stack.enter_context(patch.object(m.release.base.inventory.observer, 'Client', return_value=self.database))
        self.save = self.stack.enter_context(patch.object(m.release.base, 'save_client'))
        self.cleanup = self.stack.enter_context(patch.object(m, 'cleanup'))
        self.inspect = self.stack.enter_context(patch.object(m.request, 'inspect', return_value={'actor_id': 'synthetic-actor'}))
        self.prepared = {'mode': 'send', 'prepared_object': 'diagnostics/synthetic.prepared.bundle'}
        self.prepare = self.stack.enter_context(patch.object(m.request, 'prepare', return_value=self.prepared))
        self.recheck = self.stack.enter_context(patch.object(m.request, 'recheck'))
        self.verify = self.stack.enter_context(patch.object(m.request, 'verify_result', return_value=self.target))
        self.selection = self.stack.enter_context(patch.object(m.request, 'validate_selection'))
        self.session = self.stack.enter_context(patch.object(m, 'open_session', return_value=(object(), object(), {})))
        self.persist = self.stack.enter_context(patch.object(m.history, 'upload_once', return_value='b' * 64))
        self.sample = self.stack.enter_context(patch.object(m.observe, 'sample', return_value={
            'outcome': 'failed', 'whole_package_issued': False, 'target': self.target}))
        self.public = self.stack.enter_context(patch.object(m.observe, 'public_receipt', return_value={'outcome': 'failed'}))
        self.reports = []
        self.write = self.stack.enter_context(patch.object(m.transfer, 'write_private',
            side_effect=lambda path, raw: self.reports.append(json.loads(raw))))
        self.upload = self.stack.enter_context(patch.object(m.transfer, 'upload', return_value='c' * 64))
        self.send = self.stack.enter_context(patch.object(m.request, 'send'))
        self.download = self.stack.enter_context(patch.object(m.download, 'download'))
        self.stack.enter_context(patch.object(m, 'PRIVATE_VALUES', set()))

    @staticmethod
    def args(mode='start', activate=True):
        return SimpleNamespace(mode=mode, activate=activate, input_object='requests/synthetic.bundle', input_sha256='d' * 64)

    def test_activation_and_workflow_replay_fail_before_any_access(self):
        for environment, args, code in (
            ({'RUN_PROPOSAL_TRIAL': 'false'}, self.args(), 'ACTIVATION_REQUIRED'),
            ({}, self.args(activate=False), 'ACTIVATION_REQUIRED'),
            ({'GITHUB_RUN_ATTEMPT': '2'}, self.args(), 'WORKFLOW_REPLAY_REFUSED'),
        ):
            with patch.dict(os.environ, environment), self.assertRaisesRegex(RuntimeError, code):
                m.run(args)
        self.runtime.assert_not_called()
        self.input.assert_not_called()
        self.factory.assert_not_called()
        self.send.assert_not_called()

    def test_interrupted_send_retains_unknown_and_observe_only_reconciles(self):
        events = []
        def uncertain(_client, _session, prepared, persist, before_send):
            persist(prepared)
            events.append('persisted')
            before_send()
            events.append('send_attempted')
            raise m.release.DeadlineExceeded('DISPATCH_RELEASE_DEADLINE')
        self.send.side_effect = uncertain
        result = m.run(self.args())
        self.assertEqual(events, ['persisted', 'send_attempted'])
        self.assertTrue(result['intent_persisted'])
        self.assertTrue(result['send_attempted'])
        self.assertIsNone(result['request_sent'])
        self.assertEqual(result['failure_stage'], 'single_authenticated_send')
        self.assertTrue(result['cleanup_verified'])
        self.verify.assert_not_called()
        saved = self.reports[-1]
        self.assertNotIn('target', saved)
        self.input.return_value = saved
        self.send.reset_mock()
        self.session.reset_mock()
        reconciled = m.run(self.args('observe', activate=False))
        self.verify.assert_called_once_with(self.database, self.prepared)
        self.sample.assert_called_once_with(self.database, self.target, None)
        self.send.assert_not_called()
        self.session.assert_not_called()
        self.assertFalse(reconciled['send_attempted'])
        self.assertEqual(self.reports[-1]['target'], self.target)

    def test_start_observes_existing_work_without_session_or_command(self):
        self.prepare.return_value = {'mode': 'observe_existing', 'target': self.target}
        result = m.run(self.args())
        self.assertFalse(result['request_sent'])
        self.assertFalse(result['send_attempted'])
        self.send.assert_not_called()
        self.session.assert_not_called()
        self.persist.assert_not_called()
        self.sample.assert_called_once_with(self.database, self.target, None)

    def test_expected_retry_blocks_fresh_generation_before_session_or_intent(self):
        args = self.args()
        args.expected_operation = 'generation.retry'
        self.prepared['operation'] = 'proposal.generate'
        result = m.run(args)
        self.assertEqual(result['failure_code'], 'PROPOSAL_TRIAL_EXPECTED_OPERATION_MISMATCH')
        self.assertFalse(result['send_attempted'])
        self.assertFalse(result['intent_persisted'])
        self.assertNotIn('prepared', self.reports[-1])
        self.session.assert_not_called()
        self.persist.assert_not_called()
        self.send.assert_not_called()

    def test_expected_retry_allows_exact_retry_and_observe_existing_only(self):
        args = self.args()
        args.expected_operation = 'generation.retry'
        self.prepared['operation'] = 'generation.retry'
        def send(_client, _session, prepared, persist, before_send):
            persist(prepared)
            before_send()
            return {'sent': True, 'accepted': True, 'http_status': 200, 'unknown': False}
        self.send.side_effect = send
        result = m.run(args)
        self.assertTrue(result['request_sent'])
        self.send.assert_called_once()
        self.send.reset_mock()
        self.session.reset_mock()
        self.prepare.return_value = {'mode': 'observe_existing', 'target': self.target}
        result = m.run(args)
        self.assertFalse(result['send_attempted'])
        self.send.assert_not_called()
        self.session.assert_not_called()

    def test_expected_command_restriction_is_validated_before_access(self):
        for mode, expected in (('start', 'generation.cancel'), ('observe', 'generation.retry')):
            args = self.args(mode)
            args.expected_operation = expected
            with self.assertRaisesRegex(RuntimeError, 'EXPECTED_OPERATION_INVALID'):
                m.run(args)
        self.runtime.assert_not_called()
        self.input.assert_not_called()

    def test_transport_exception_after_send_reconciles_without_second_send(self):
        def uncertain(_client, _session, prepared, persist, before_send):
            persist(prepared)
            before_send()
            raise OSError('private network diagnostic')
        self.send.side_effect = uncertain
        result = m.run(self.args())
        self.send.assert_called_once()
        self.verify.assert_called_once_with(self.database, self.prepared)
        self.sample.assert_called_once_with(self.database, self.target, None)
        self.assertTrue(result['send_attempted'])
        self.assertIsNone(result['request_sent'])
        self.assertNotIn('failure_code', result)
        self.assertEqual(self.reports[-1]['acknowledgement'],
            {'sent': None, 'unknown': True, 'error_code': 'PROPOSAL_TRIAL_FAILED'})
        self.assertNotIn('private network', json.dumps(self.reports))

    def test_observe_keeps_previous_binding_and_stops_at_first_terminal_sample(self):
        previous = {'outcome': 'active', 'target': self.target}
        current = {'outcome': 'active', 'target': self.target, 'whole_package_issued': False}
        terminal = {'outcome': 'issued', 'target': self.target, 'whole_package_issued': True}
        self.input.return_value = {'version': 1, 'kind': 'proposal_trial_report',
            'selection': self.incoming, 'target': self.target, 'observation': previous}
        self.sample.side_effect = [current, terminal]
        with patch.object(m.time, 'sleep') as sleep:
            m.run(self.args('observe', activate=False))
        self.assertEqual(self.sample.call_count, 2)
        self.assertIs(self.sample.call_args_list[0].args[2], previous)
        self.assertIs(self.sample.call_args_list[1].args[2], current)
        sleep.assert_called_once_with(15)
        self.send.assert_not_called()
        self.inspect.assert_not_called()

    def test_download_refuses_unissued_package_without_session(self):
        self.input.return_value = {'version': 1, 'kind': 'proposal_trial_report',
            'selection': self.incoming, 'target': self.target}
        result = m.run(self.args('download', activate=False))
        self.assertEqual(result['failure_code'], 'PROPOSAL_TRIAL_PACKAGE_NOT_ISSUED')
        self.session.assert_not_called()
        self.download.assert_not_called()
        self.send.assert_not_called()

    def test_inspect_retains_private_admission_evidence_without_command_or_session(self):
        with patch.object(m.request, 'diagnostic', return_value={'reserved': 0, 'unknown': 2}, create=True) as diagnostic:
            result = m.run(self.args('inspect', activate=False))
        self.assertTrue(result['cleanup_verified'])
        self.assertFalse(result['send_attempted'])
        self.assertEqual(self.reports[-1]['admission_diagnostic'], {'reserved': 0, 'unknown': 2})
        diagnostic.assert_called_once_with(self.database, self.incoming)
        self.prepare.assert_not_called()
        self.send.assert_not_called()
        self.session.assert_not_called()
        self.sample.assert_not_called()

    def test_work_budget_reserves_cleanup_and_report_with_queue_time(self):
        for remaining, expected in ((170, 100), (115, 45), (110, 40)):
            with patch.object(m.release, 'remaining_run_seconds', return_value=remaining):
                self.assertEqual(m.work_budget(), expected)
        with patch.object(m.release, 'remaining_run_seconds', return_value=104):
            with self.assertRaisesRegex(RuntimeError, 'WORK_BUDGET_EXHAUSTED'):
                m.work_budget()

    def test_secret_scan_prevents_report_persistence(self):
        self.prepare.return_value = {'mode': 'observe_existing', 'target': self.target, 'unexpected': 'fixture-secret'}
        with patch.object(m, 'PRIVATE_VALUES', {'fixture-secret'}):
            with self.assertRaisesRegex(RuntimeError, 'REPORT_CREDENTIAL_REJECTED'):
                m.run(self.args())
        self.cleanup.assert_called_once()
        self.write.assert_not_called()
        self.upload.assert_not_called()


class TrialRunnerBoundaryTests(unittest.TestCase):
    def test_runtime_verification_requires_qualified_worker_but_preserves_other_baselines(self):
        candidate = 'registry/synthetic-runtime@sha256:' + 'b' * 64
        expected = m.release.BASELINES | {'worker': candidate, 'scheduler': candidate}
        schema = Mock(ROOT=Path('/synthetic'))
        schema.parent.SOURCE = Path('/synthetic/backend/supabase/migrations/poll.sql')
        schema.parent.source_sha256.return_value = 'c' * 64
        schema.retry.PARENT_SQL = 'e' * 64
        receipt = {'poll_migration': {'path': 'backend/supabase/migrations/poll.sql', 'sha256': 'c' * 64},
            'source': {'source_entries': {'backend/scripts/runtime/dispatcher.sql': {'sha256': 'e' * 64}}}}
        qualification = Mock()
        qualification.publication.return_value = (receipt, candidate)
        with patch.object(m.release, 'verify_checkout'), patch.object(m.d.probe, 'validate_cluster'), \
             patch.object(m.release.u, 'deployment', side_effect=lambda name: {'image': expected[name]}), \
             patch.object(m.release.base, 'image_of', side_effect=lambda value: value['image']), \
             patch.object(m.release, 'verify_runtime_contract'), patch.object(m, 'module',
                side_effect=lambda name, filename: qualification if filename == 'proposal-latency-runtime.py' else schema):
            database = object()
            m.verify_runtime(database)
            schema.verify.assert_called_once_with(database, allow_parent=True)
            schema.parent.source_sha256.return_value = 'd' * 64
            with self.assertRaisesRegex(RuntimeError, 'POLL_SOURCE_CHANGED'):
                m.verify_runtime(database)
            schema.parent.source_sha256.return_value = 'c' * 64
            expected['api'] = candidate
            with self.assertRaisesRegex(RuntimeError, 'RUNTIME_CHANGED'):
                m.verify_runtime()

    def test_cleanup_attempts_database_removal_even_after_session_timeout(self):
        with patch.object(m, 'session_path', return_value=SimpleNamespace(exists=lambda: True)), \
             patch.object(m, 'close_session', side_effect=m.release.DeadlineExceeded('DISPATCH_RELEASE_DEADLINE')), \
             patch.object(m.release, 'remaining_run_seconds', return_value=45), \
             patch.object(m.release, 'cleanup') as database_cleanup, patch.object(m.signal, 'alarm'):
            with self.assertRaisesRegex(RuntimeError, 'CLEANUP_NOT_CONFIRMED'):
                m.cleanup()
            database_cleanup.assert_called_once()

    def test_deadline_is_bound_to_run_creation_not_step_start(self):
        now = 1794096000
        created = datetime.datetime.fromtimestamp(now - 20, datetime.timezone.utc).isoformat()
        metadata = {'id': 123, 'repository': {'full_name': 'synthetic/repo'}, 'head_sha': 'a' * 40, 'created_at': created}
        with tempfile.TemporaryDirectory() as folder:
            env_file = Path(folder) / 'env'
            with patch.dict(os.environ, {'GITHUB_REPOSITORY': 'synthetic/repo', 'GITHUB_RUN_ID': '123',
                    'GITHUB_SHA': 'a' * 40, 'GH_TOKEN': 'synthetic-token', 'GITHUB_ENV': str(env_file)}), \
                 patch.object(m.time, 'time', return_value=now), \
                 patch.object(m.urllib.request, 'build_opener') as opener:
                opener.return_value.open.return_value = io.BytesIO(json.dumps(metadata).encode())
                m.bind_deadline()
                self.assertEqual(env_file.read_text(), 'TENDERDESK_RUN_DEADLINE_EPOCH=' + str(now + 150) + '\n')
                metadata['created_at'] = datetime.datetime.fromtimestamp(now - 100, datetime.timezone.utc).isoformat()
                opener.return_value.open.return_value = io.BytesIO(json.dumps(metadata).encode())
                with self.assertRaisesRegex(RuntimeError, 'RUN_BUDGET'):
                    m.bind_deadline()


if __name__ == '__main__':
    unittest.main()
