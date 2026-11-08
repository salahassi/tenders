from contextlib import ExitStack, redirect_stdout
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import textwrap
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('settings_runner_test', HERE / 'proposal-trial-runner.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class SettingsRunnerTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {
            'GITHUB_SHA': 'a' * 40, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
            'RUN_PROPOSAL_TRIAL': 'true', 'DOKS_WORKDIR': '/private/fixture',
            'DIGITALOCEAN_ACCESS_TOKEN': 'synthetic-management-token'}))
        self.stack.enter_context(patch.object(m.signal, 'alarm'))
        self.stack.enter_context(patch.object(m.release, 'remaining_run_seconds', return_value=170))
        self.stack.enter_context(patch.object(m, 'PRIVATE_VALUES', set()))
        self.runtime = self.stack.enter_context(patch.object(m, 'verify_runtime'))
        self.database = SimpleNamespace(labels={}, prepare=Mock())
        self.factory = self.stack.enter_context(patch.object(m.release.base.inventory.observer,
            'Client', return_value=self.database))
        self.stack.enter_context(patch.object(m.release.base, 'save_client'))
        self.cleanup = self.stack.enter_context(patch.object(m, 'cleanup'))
        self.selection = {'version': 1, 'workspace_id': 'synthetic-workspace',
                          'opportunity_id': 'synthetic-opportunity'}
        self.prepared = {'version': 1, 'proof': {'actor_id': 'synthetic-actor', 'selection': self.selection},
            'prepared_object': 'diagnostics/synthetic-settings.prepared.bundle',
            'body': {'commands': [{'operation': 'workspace.update_settings', 'input': {}}]},
            'idempotency_key': 'synthetic-key'}
        self.incoming = {'version': 1, 'kind': 'proposal_trial_report', 'mode': 'settings-plan',
            'selection': self.selection, 'prepared': self.prepared, 'intent_persisted': False}
        self.input = self.stack.enter_context(patch.object(m, 'private_input', return_value=self.incoming))
        self.plan = self.stack.enter_context(patch.object(m.settings_repair, 'plan', return_value=self.prepared))
        self.validate = self.stack.enter_context(patch.object(m.settings_repair, 'validate_prepared'))
        self.fresh = {'fresh': 'synthetic-proof'}
        self.recheck = self.stack.enter_context(patch.object(m.settings_repair, 'recheck', return_value=self.fresh))
        self.readback = {'verified': True, 'operation': 'workspace.update_settings'}
        self.verify = self.stack.enter_context(patch.object(m.settings_repair, 'verify_result', return_value=self.readback))
        self.session = self.stack.enter_context(patch.object(m, 'open_session', return_value=(object(), object(), {})))
        self.persist = self.stack.enter_context(patch.object(m.history, 'upload_once', return_value='b' * 64))
        self.send = self.stack.enter_context(patch.object(m.settings_repair, 'send', side_effect=self.accept))
        self.proposal_send = self.stack.enter_context(patch.object(m.request, 'send'))
        self.proposal_prepare = self.stack.enter_context(patch.object(m.request, 'prepare'))
        self.sample = self.stack.enter_context(patch.object(m.observe, 'sample'))
        self.download = self.stack.enter_context(patch.object(m.download, 'download'))
        self.reports = []
        self.stack.enter_context(patch.object(m.transfer, 'write_private',
            side_effect=lambda path, raw: self.reports.append(json.loads(raw))))
        self.upload = self.stack.enter_context(patch.object(m.transfer, 'upload', return_value='c' * 64))

    def accept(self, _client, _session, prepared, persist, before_send):
        persist(prepared)
        self.assertIs(before_send(), self.fresh)
        return {'sent': True, 'accepted': True, 'http_status': 200, 'unknown': False}

    @staticmethod
    def args(mode='settings-apply', activate=True, expected='any'):
        return SimpleNamespace(mode=mode, activate=activate, expected_operation=expected,
            input_object='diagnostics/synthetic.bundle', input_sha256='d' * 64)

    def assert_no_proposal(self):
        self.proposal_send.assert_not_called()
        self.proposal_prepare.assert_not_called()
        self.sample.assert_not_called()
        self.download.assert_not_called()

    def test_plan_prepares_private_intent_without_authentication_or_transmission(self):
        result = m.run(self.args('settings-plan', activate=False))
        self.plan.assert_called_once_with(self.database, self.incoming)
        self.validate.assert_called_once_with(self.prepared)
        self.assertEqual(self.reports[-1]['selection'], self.selection)
        self.assertEqual(self.reports[-1]['prepared'], self.prepared)
        for name in ('intent_persisted', 'send_attempted', 'request_sent'):
            self.assertIs(result[name], False)
        self.session.assert_not_called()
        self.persist.assert_not_called()
        self.send.assert_not_called()
        self.verify.assert_not_called()
        self.recheck.assert_not_called()
        self.assert_no_proposal()

    def test_activation_and_expected_operation_fail_before_access(self):
        for environment, args, code in (
            ({'RUN_PROPOSAL_TRIAL': 'false'}, self.args(), 'ACTIVATION_REQUIRED'),
            ({}, self.args(activate=False), 'ACTIVATION_REQUIRED'),
            ({'GITHUB_RUN_ATTEMPT': '2'}, self.args(), 'WORKFLOW_REPLAY_REFUSED'),
            *[({}, self.args(mode, expected='generation.retry'), 'EXPECTED_OPERATION_INVALID')
              for mode in ('settings-plan', 'settings-apply', 'settings-observe')],
        ):
            with patch.dict(os.environ, environment), self.assertRaisesRegex(RuntimeError, code):
                m.run(args)
        self.runtime.assert_not_called()
        self.input.assert_not_called()
        self.factory.assert_not_called()
        self.session.assert_not_called()
        self.send.assert_not_called()

    def test_apply_requires_exact_plan_report_selection_and_valid_prepared(self):
        for field, value in (('version', 2), ('kind', 'other'), ('mode', 'settings-apply'),
                             ('selection', {'workspace_id': 'another-workspace'})):
            self.input.return_value = self.incoming | {field: value}
            result = m.run(self.args())
            self.assertIn(result['failure_code'], ('PROPOSAL_TRIAL_SETTINGS_REPORT_INPUT',
                                                   'PROPOSAL_TRIAL_SETTINGS_SELECTION_CHANGED'))
        self.input.return_value = self.incoming
        self.validate.side_effect = RuntimeError('SETTINGS_PREPARED_MISMATCH')
        result = m.run(self.args())
        self.assertEqual(result['failure_code'], 'SETTINGS_PREPARED_MISMATCH')
        self.session.assert_not_called()
        self.persist.assert_not_called()
        self.send.assert_not_called()
        self.assert_no_proposal()

    def test_apply_rechecks_before_auth_persistence_and_exactly_one_send_then_verifies(self):
        events = []
        def recheck(database, prepared):
            self.assertIs(database, self.database)
            self.assertIs(prepared, self.prepared)
            events.append('recheck')
            return self.fresh
        self.recheck.side_effect = recheck
        self.session.side_effect = lambda *_args: (events.append('auth') or object(), object(), {})
        self.persist.side_effect = lambda *_args: events.append('persist') or 'b' * 64
        self.verify.side_effect = lambda *_args: events.append('verify') or self.readback
        result = m.run(self.args())
        self.assertEqual(events, ['recheck', 'auth', 'recheck', 'persist', 'recheck', 'verify'])
        self.session.assert_called_once_with('synthetic-actor', 'synthetic-workspace')
        self.persist.assert_called_once_with('synthetic-management-token', self.prepared['prepared_object'],
                                             m.encoded(self.prepared))
        self.send.assert_called_once()
        self.verify.assert_called_once_with(self.database, self.prepared)
        self.assertEqual(self.reports[-1]['settings_readback'], self.readback)
        self.assertTrue(all(result[field] for field in ('intent_persisted', 'send_attempted', 'request_sent', 'cleanup_verified')))
        self.assert_no_proposal()

    def test_stale_settings_fail_at_each_guard_before_transmission(self):
        for failure_index in range(3):
            with self.subTest(failure_index=failure_index):
                self.session.reset_mock()
                self.persist.reset_mock()
                self.send.reset_mock()
                self.verify.reset_mock()
                self.recheck.side_effect = [self.fresh] * failure_index + [RuntimeError('SETTINGS_CHANGED')]
                result = m.run(self.args())
                self.assertEqual(result['failure_code'], 'SETTINGS_CHANGED')
                self.assertFalse(result['send_attempted'])
                self.assertIs(result['request_sent'], False)
                self.assertEqual(result['intent_persisted'], failure_index == 2)
                self.verify.assert_not_called()
                if failure_index == 0:
                    self.session.assert_not_called()
                    self.send.assert_not_called()
                if failure_index < 2:
                    self.persist.assert_not_called()

    def test_failed_durable_intent_never_reaches_before_send(self):
        self.persist.side_effect = RuntimeError('CURRENT_REQUEST_PREPARED_ALREADY_EXISTS')
        result = m.run(self.args())
        self.assertFalse(result['intent_persisted'])
        self.assertFalse(result['send_attempted'])
        self.assertEqual(self.recheck.call_count, 2)
        self.verify.assert_not_called()
        self.assertEqual(result['failure_code'], 'CURRENT_REQUEST_PREPARED_ALREADY_EXISTS')

    def test_unknown_transport_is_read_back_without_a_second_send(self):
        def uncertain(_client, _session, prepared, persist, before_send):
            persist(prepared)
            self.assertIs(before_send(), self.fresh)
            raise OSError('private transport details')
        self.send.side_effect = uncertain
        result = m.run(self.args())
        self.send.assert_called_once()
        self.verify.assert_called_once_with(self.database, self.prepared)
        self.assertTrue(result['intent_persisted'])
        self.assertTrue(result['send_attempted'])
        self.assertIsNone(result['request_sent'])
        self.assertNotIn('failure_code', result)
        self.assertEqual(self.reports[-1]['acknowledgement'],
            {'sent': None, 'unknown': True, 'error_code': 'PROPOSAL_TRIAL_FAILED'})
        self.assertNotIn('private transport', json.dumps(self.reports))
        self.assert_no_proposal()

    def test_send_deadline_preserves_intent_then_observe_reconciles_without_auth_or_send(self):
        def interrupted(_client, _session, prepared, persist, before_send):
            persist(prepared)
            before_send()
            raise m.release.DeadlineExceeded('DISPATCH_RELEASE_DEADLINE')
        self.send.side_effect = interrupted
        result = m.run(self.args())
        self.assertEqual(result['failure_stage'], 'single_authenticated_settings_send')
        self.assertTrue(result['intent_persisted'])
        self.assertTrue(result['send_attempted'])
        self.assertIsNone(result['request_sent'])
        self.verify.assert_not_called()
        self.input.return_value = copy.deepcopy(self.reports[-1])
        for mock in (self.send, self.session, self.persist, self.recheck):
            mock.reset_mock()
        result = m.run(self.args('settings-observe', activate=False))
        self.verify.assert_called_once_with(self.database, self.prepared)
        self.assertEqual(self.reports[-1]['settings_readback'], self.readback)
        self.assertFalse(result['send_attempted'])
        self.send.assert_not_called()
        self.session.assert_not_called()
        self.persist.assert_not_called()
        self.recheck.assert_not_called()
        self.assert_no_proposal()

    def test_observe_requires_persisted_apply_report_without_accepting_truthy_values(self):
        for change in ({'mode': 'settings-plan', 'intent_persisted': True},
                       {'mode': 'settings-apply'}, {'mode': 'settings-apply', 'intent_persisted': 1},
                       {'mode': 'settings-apply', 'intent_persisted': 'true'}):
            self.input.return_value = self.incoming | change
            result = m.run(self.args('settings-observe', activate=False))
            self.assertIn(result['failure_code'], ('PROPOSAL_TRIAL_SETTINGS_REPORT_INPUT',
                                                   'PROPOSAL_TRIAL_SETTINGS_INTENT_MISSING'))
        self.verify.assert_not_called()
        self.session.assert_not_called()
        self.send.assert_not_called()
        self.assert_no_proposal()

    def test_readback_failure_retains_sent_intent_for_read_only_reconciliation(self):
        self.verify.side_effect = RuntimeError('SETTINGS_ACCEPTANCE_UNPROVEN')
        result = m.run(self.args())
        self.assertEqual(result['failure_code'], 'SETTINGS_ACCEPTANCE_UNPROVEN')
        self.assertEqual(result['failure_stage'], 'authoritative_settings_readback')
        self.assertTrue(result['intent_persisted'])
        self.assertTrue(result['request_sent'])
        self.assertTrue(result['cleanup_verified'])
        self.assertEqual(self.reports[-1]['prepared'], self.prepared)
        self.assertNotIn('settings_readback', self.reports[-1])
        self.send.assert_called_once()
        self.assert_no_proposal()


class SettingsWorkflowTests(unittest.TestCase):
    def test_workflow_guard_distinguishes_read_only_modes_and_explicit_mutations(self):
        workflow = (HERE.parents[2] / '.github/workflows/proposal-trial.yml').read_text()
        step = workflow.split('- name: Validate mode and explicit activation before access preparation', 1)[1]
        code = textwrap.dedent(re.search("python3 - <<'PY'\\n(.*?)\\n          PY", step, re.S).group(1))
        base = {'TRIAL_INPUT_OBJECT': 'diagnostics/synthetic.bundle', 'TRIAL_INPUT_SHA256': 'd' * 64,
                'GITHUB_RUN_ATTEMPT': '1', 'TRIAL_EXPECTED_OPERATION': 'any', 'RUN_PROPOSAL_TRIAL': 'false'}
        for mode in ('settings-plan', 'settings-observe', 'observe'):
            with patch.dict(os.environ, base | {'TRIAL_MODE': mode}), redirect_stdout(io.StringIO()):
                exec(compile(code, '<workflow-guard>', 'exec'), {})
        for mode in ('start', 'settings-apply'):
            with patch.dict(os.environ, base | {'TRIAL_MODE': mode}), self.assertRaises(SystemExit):
                exec(compile(code, '<workflow-guard>', 'exec'), {})
            with patch.dict(os.environ, base | {'TRIAL_MODE': mode, 'RUN_PROPOSAL_TRIAL': 'true'}), redirect_stdout(io.StringIO()):
                exec(compile(code, '<workflow-guard>', 'exec'), {})
        for mode in ('settings-plan', 'settings-apply', 'settings-observe'):
            with patch.dict(os.environ, base | {'TRIAL_MODE': mode, 'RUN_PROPOSAL_TRIAL': 'true',
                                               'TRIAL_EXPECTED_OPERATION': 'generation.retry'}), self.assertRaises(SystemExit):
                exec(compile(code, '<workflow-guard>', 'exec'), {})
        self.assertIn("RUN_PROPOSAL_TRIAL: ${{ (inputs.mode == 'start' || inputs.mode == 'settings-apply') && inputs.activation_confirmed && 'true' || 'false' }}", workflow)
        self.assertIn('default: observe', workflow)
        self.assertIn('timeout-minutes: 3', workflow)
        self.assertIn('cancel-in-progress: false', workflow)


if __name__ == '__main__':
    unittest.main()
