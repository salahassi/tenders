from contextlib import ExitStack
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('admission_release_test_target', HERE / 'proposal-admission-release.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class AdmissionReleaseTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {'GITHUB_RUN_ATTEMPT': '1'}))
        self.alarm = self.stack.enter_context(patch.object(m.signal, 'alarm'))
        self.remaining = self.stack.enter_context(patch.object(m.dispatch, 'remaining_run_seconds', return_value=150))
        self.checkout = self.stack.enter_context(patch.object(m.dispatch, 'verify_checkout', return_value='a' * 40))
        self.candidate = m.CURRENT_IMAGE
        self.artifact = {'source_revision': 'b' * 40, 'poll_migration': {
            'path': str(m.schema.parent.SOURCE.relative_to(m.schema.ROOT)), 'sha256': m.schema.PARENT_SQL},
            'source': {'source_entries': {'backend/scripts/runtime/dispatcher.sql': {'sha256': m.schema.retry.PARENT_SQL}}}}
        self.publication = self.stack.enter_context(patch.object(m.qualification, 'publication', return_value=(self.artifact, self.candidate)))
        self.cluster = self.stack.enter_context(patch.object(m.dispatch.d.probe, 'validate_cluster'))
        self.expected = {**m.dispatch.BASELINES, 'worker': self.candidate, 'scheduler': self.candidate}
        self.deployments = {name: {'image': image} for name, image in self.expected.items()}
        self.deployment = self.stack.enter_context(patch.object(m.dispatch.u, 'deployment',
            side_effect=lambda name: copy.deepcopy(self.deployments[name])))
        self.stack.enter_context(patch.object(m.dispatch.base, 'image_of', side_effect=lambda value: value['image']))
        self.contract = self.stack.enter_context(patch.object(m.dispatch, 'verify_runtime_contract'))
        self.snapshot = self.stack.enter_context(patch.object(m.dispatch.runtime, 'workload_snapshot', return_value={'fixture': 'unchanged'}))
        self.configuration = self.stack.enter_context(patch.object(m.dispatch.runtime, 'retained_configuration', return_value={'synthetic-secret': 'retained'}))
        self.database = SimpleNamespace(labels={}, prepare=Mock())
        self.factory = self.stack.enter_context(patch.object(m.dispatch.base.inventory.observer, 'Client', return_value=self.database))
        self.save = self.stack.enter_context(patch.object(m.dispatch.base, 'save_client'))
        self.cleanup = self.stack.enter_context(patch.object(m.dispatch, 'cleanup'))
        self.receipt = {'release': 'synthetic-admission', 'read_only': False}
        self.readback = {'release': 'synthetic-admission', 'read_only': True, 'applied': True}
        self.apply = self.stack.enter_context(patch.object(m.schema, 'apply', return_value=self.receipt))
        self.verify = self.stack.enter_context(patch.object(m.schema, 'verify', return_value=self.readback))
        self.patch_runtime = self.stack.enter_context(patch.object(m.dispatch.runtime, 'patch_runtime'))
        self.rollback = self.stack.enter_context(patch.object(m.dispatch, 'rollback'))

    def test_one_atomic_apply_and_readback_preserve_all_images_and_configuration(self):
        result = m.release()
        self.apply.assert_called_once_with(self.database)
        self.verify.assert_called_once_with(self.database)
        self.save.assert_called_once_with(self.database)
        self.database.prepare.assert_called_once_with()
        self.assertEqual(self.database.labels['app.kubernetes.io/managed-by'], m.dispatch.base.OWNER)
        self.assertEqual(result['retained_images'], self.expected)
        self.assertTrue(result['apply_acknowledged'])
        self.assertFalse(result['reconciled_after_unknown'])
        self.assertTrue(result['cleanup_verified'])
        self.assertEqual(result['business_commands_sent'], 0)
        self.assertNotIn('synthetic-secret', json.dumps(result))
        self.patch_runtime.assert_not_called()
        self.rollback.assert_not_called()
        self.cleanup.assert_called_once_with()

    def test_unknown_apply_is_read_only_reconciled_without_resubmission(self):
        self.apply.side_effect = RuntimeError('private transport response')
        result = m.release()
        self.apply.assert_called_once_with(self.database)
        self.verify.assert_called_once_with(self.database, allow_parent=True)
        self.assertFalse(result['apply_acknowledged'])
        self.assertTrue(result['reconciled_after_unknown'])
        self.assertTrue(result['cleanup_verified'])
        self.assertEqual(m.STATE['apply_error'], 'PROPOSAL_ADMISSION_RELEASE_FAILED')
        self.assertNotIn('private transport response', json.dumps(m.STATE))
        self.patch_runtime.assert_not_called()
        self.rollback.assert_not_called()

    def test_inspect_only_verifies_exact_parent_or_child_without_apply(self):
        self.readback['applied'] = False
        result = m.release(inspect_only=True)
        self.apply.assert_not_called()
        self.verify.assert_called_once_with(self.database, allow_parent=True)
        self.assertEqual(result['mode'], 'inspect')
        self.assertFalse(result['apply_attempted'])
        self.assertFalse(result['schema']['applied'])
        self.assertTrue(result['cleanup_verified'])
        self.assertTrue(m.STATE['schema_confirmed'])
        self.patch_runtime.assert_not_called()
        self.rollback.assert_not_called()

    def test_unknown_apply_proves_parent_without_reapplying_or_success(self):
        self.apply.side_effect = RuntimeError('ADMISSION_SCHEMA_SQL_TRANSPORT_TIMEOUT')
        self.readback['applied'] = False
        with self.assertRaisesRegex(RuntimeError, 'SQL_TRANSPORT_TIMEOUT'):
            m.release()
        self.apply.assert_called_once()
        self.verify.assert_called_once_with(self.database, allow_parent=True)
        self.assertFalse(m.STATE['uncertain_commit_readback']['applied'])
        self.assertFalse(m.STATE['schema_confirmed'])
        self.patch_runtime.assert_not_called();self.cleanup.assert_called_once()

    def test_qualification_requires_current_image_poll_sql_and_outbox_source(self):
        for field, code in [('image','QUALIFIED_IMAGE_CHANGED'),('poll','POLL_QUALIFICATION_CHANGED'),('outbox','OUTBOX_SOURCE_CHANGED')]:
            with self.subTest(field=field):
                artifact = copy.deepcopy(self.artifact)
                candidate = self.candidate
                if field == 'image':candidate = 'registry.invalid/changed@sha256:'+'f'*64
                elif field == 'poll':artifact['poll_migration']['sha256'] = 'f'*64
                else:artifact['source']['source_entries']['backend/scripts/runtime/dispatcher.sql']['sha256'] = 'f'*64
                self.publication.return_value = (artifact,candidate)
                with self.assertRaisesRegex(RuntimeError, code):m.release()
        self.factory.assert_not_called();self.apply.assert_not_called();self.patch_runtime.assert_not_called()

    def test_cli_requires_explicit_apply_or_inspect_mode(self):
        with patch.object(m.sys, 'argv', ['proposal-admission-release.py']), patch.object(m, 'release') as action, \
             patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(m.main(), 1)
        action.assert_not_called()
        self.assertIn('EXPLICIT_MODE_REQUIRED', output.getvalue())

    def test_unproven_commit_stops_and_retains_original_failure(self):
        self.apply.side_effect = RuntimeError('PROPOSAL_ADMISSION_SCHEMA_APPLY_UNCERTAIN')
        self.verify.side_effect = RuntimeError('PROPOSAL_ADMISSION_SCHEMA_RELEASE_MISSING')
        with self.assertRaisesRegex(RuntimeError, 'APPLY_UNCERTAIN'):
            m.release()
        self.apply.assert_called_once()
        self.verify.assert_called_once()
        self.assertFalse(m.STATE['schema_confirmed'])
        self.assertEqual(m.STATE['reconciliation_error'], 'PROPOSAL_ADMISSION_SCHEMA_RELEASE_MISSING')
        self.rollback.assert_not_called()
        self.cleanup.assert_called_once()

    def test_deadline_reconciliation_requires_cleanup_reserve(self):
        self.apply.side_effect = m.dispatch.DeadlineExceeded('DISPATCH_RELEASE_DEADLINE')
        self.remaining.return_value = 39
        with self.assertRaises(m.dispatch.DeadlineExceeded):
            m.release()
        self.verify.assert_not_called()
        self.apply.assert_called_once()
        self.cleanup.assert_called_once()
        self.remaining.return_value = 40
        self.cleanup.reset_mock()
        result = m.release()
        self.assertTrue(result['reconciled_after_unknown'])
        self.alarm.assert_any_call(20)
        self.cleanup.assert_called_once()

    def test_runtime_drift_and_replayed_workflow_stop_before_apply(self):
        self.deployments['api']['image'] = self.candidate
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_CHANGED'):
            m.release()
        self.apply.assert_not_called()
        self.factory.assert_not_called()
        self.cleanup.assert_called_once()
        self.cleanup.reset_mock()
        with patch.dict(os.environ, {'GITHUB_RUN_ATTEMPT': '2'}), self.assertRaisesRegex(RuntimeError, 'WORKFLOW_REPLAY_REFUSED'):
            m.release()
        self.apply.assert_not_called()
        self.cleanup.assert_called_once()

    def test_configuration_drift_prevents_success_and_never_rolls_back_ddl(self):
        self.configuration.side_effect = [{'retained': 1}, {'retained': 1}, {'retained': 2}]
        with self.assertRaisesRegex(RuntimeError, 'PRIVATE_CONFIGURATION_CHANGED'):
            m.release()
        self.apply.assert_called_once()
        self.verify.assert_called_once()
        self.assertTrue(m.STATE['schema_confirmed'])
        self.assertEqual(m.STATE['failure_stage'], 'retained_runtime_verification')
        self.rollback.assert_not_called()
        self.cleanup.assert_called_once()

    def test_work_budget_includes_elapsed_queue_and_setup(self):
        for remaining, expected in [(170, 110), (120, 75), (90, 45)]:
            self.remaining.return_value = remaining
            self.assertEqual(m.work_budget(), expected)
        self.remaining.return_value = 89
        with self.assertRaisesRegex(RuntimeError, 'WORK_BUDGET_EXHAUSTED'):
            m.work_budget()

    def test_cleanup_failure_cannot_report_success(self):
        self.cleanup.side_effect = RuntimeError('OWNED_CLEANUP_UNCONFIRMED')
        with self.assertRaisesRegex(RuntimeError, 'OWNED_CLEANUP_UNCONFIRMED'):
            m.release()
        self.assertFalse(m.STATE['cleanup_verified'])
        self.assertEqual(m.STATE['cleanup_failure'], 'OWNED_CLEANUP_UNCONFIRMED')


if __name__ == '__main__':
    unittest.main()
