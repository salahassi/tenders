import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('proposal_dispatch_release_test', HERE / 'proposal-dispatch-release.py')
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)
q = m.qualification


def workload(image):
    return {'spec': {'template': {'spec': {'containers': [{'image': image}]}}}}


class ReleaseGuards(unittest.TestCase):
    def setUp(self):
        m.STATE.update(rolled_back=[], rollback_failed=[], schema_applied=True)

    def test_only_worker_and_scheduler_image_changes_are_allowed(self):
        before = {name: workload('old-' + name) for name in m.BASELINES}
        current = copy.deepcopy(before)
        for name in m.TARGETS:
            current[name]['spec']['template']['spec']['containers'][0]['image'] = 'candidate'
        with patch.object(m.runtime, 'workload_snapshot', side_effect=lambda: copy.deepcopy(current)), \
                patch.object(m.runtime, 'retained_configuration', return_value={'private': 'unchanged'}):
            m.verify_unchanged(before, {'private': 'unchanged'}, 'candidate', final=True)
            for name in ('api', 'source-browser', 'frontend'):
                altered = copy.deepcopy(current)
                current[name]['spec']['template']['spec']['containers'][0]['image'] = 'candidate'
                with self.assertRaises(m.ReleaseError):
                    m.verify_unchanged(before, {'private': 'unchanged'}, 'candidate')
                current = altered
            current['worker']['spec']['replicas'] = 3
            with self.assertRaises(m.ReleaseError):
                m.verify_unchanged(before, {'private': 'unchanged'}, 'candidate')

    def test_private_configuration_change_blocks_acceptance(self):
        before = {name: workload('old') for name in m.BASELINES}
        with patch.object(m.runtime, 'workload_snapshot', return_value=copy.deepcopy(before)), \
                patch.object(m.runtime, 'retained_configuration', return_value={'secret': 'changed'}):
            with self.assertRaises(m.ReleaseError):
                m.verify_unchanged(before, {'secret': 'old'}, 'candidate')

    def test_rollback_restores_scheduler_before_worker_and_retains_compatible_sql(self):
        original = {name: workload('prior') for name in m.TARGETS}
        calls = []
        with patch.object(m.u, 'deployment', return_value=workload('candidate')), \
                patch.object(m.runtime, 'patch_runtime', side_effect=lambda name, *args: calls.append(name)), \
                patch.object(m.d, 'wait_deployments'), patch.object(m.base, 'wait_drain'), \
                patch.object(m, 'verify_unchanged'):
            m.rollback(['worker', 'scheduler'], original, 'candidate', {}, {})
        self.assertEqual(calls, ['scheduler', 'worker'])
        self.assertTrue(m.STATE['schema_retained_on_rollback'])

    def test_concurrent_scheduler_change_prevents_worker_rollback(self):
        original = {name: workload('prior') for name in m.TARGETS}
        with patch.object(m.u, 'deployment', return_value=workload('operator-image')), \
                patch.object(m.runtime, 'patch_runtime') as mutation:
            with self.assertRaises(m.ReleaseError):
                m.rollback(['worker', 'scheduler'], original, 'candidate', {}, {})
            mutation.assert_not_called()
        self.assertEqual(m.STATE['rollback_failed'], ['scheduler'])

    def test_ambiguous_patch_already_at_previous_image_needs_no_mutation(self):
        original = {'worker': workload('prior')}
        with patch.object(m.u, 'deployment', return_value=workload('prior')), \
                patch.object(m.runtime, 'patch_runtime') as mutation, patch.object(m, 'verify_unchanged') as verify, \
                patch.object(m.d, 'wait_deployments') as ready, patch.object(m.base, 'wait_drain') as drain:
            m.rollback(['worker'], original, 'candidate', {}, {})
            mutation.assert_not_called()
            ready.assert_called_once_with(['worker'], seconds=10)
            drain.assert_called_once_with('worker', 'prior', timeout=10)
            verify.assert_called_once_with({}, {}, 'candidate', restored=True)

    def test_prior_scheduler_template_with_candidate_pod_blocks_worker_rollback(self):
        original = {name: workload('prior') for name in m.TARGETS}
        with patch.object(m.u, 'deployment', return_value=workload('prior')), \
                patch.object(m.runtime, 'patch_runtime') as mutation, \
                patch.object(m.d, 'wait_deployments') as ready, \
                patch.object(m.base, 'wait_drain', side_effect=m.ReleaseError('CANDIDATE_POD_STILL_RUNNING')) as drain:
            with self.assertRaises(m.ReleaseError):
                m.rollback(['worker', 'scheduler'], original, 'candidate', {}, {})
            mutation.assert_not_called()
            ready.assert_called_once_with(['scheduler'], seconds=10)
            drain.assert_called_once_with('scheduler', 'prior', timeout=10)
        self.assertEqual(m.STATE['rolled_back'], [])
        self.assertEqual(m.STATE['rollback_failed'], ['scheduler'])

    def test_rollback_readback_rejects_candidate_image_after_concurrent_recutover(self):
        before = {name: workload('prior') for name in m.BASELINES}
        current = copy.deepcopy(before)
        current['scheduler']['spec']['template']['spec']['containers'][0]['image'] = 'candidate'
        with patch.object(m.runtime, 'workload_snapshot', return_value=current), \
                patch.object(m.runtime, 'retained_configuration', return_value={}):
            with self.assertRaises(m.ReleaseError):
                m.verify_unchanged(before, {}, 'candidate', restored=True)

    def test_hosted_probe_calls_real_unauthenticated_maintenance_path_only(self):
        value = {'component': 'worker', 'ready': True, 'unauthorized_maintenance_status': 401}
        with patch.object(m.d, 'command', return_value=json.dumps(value)) as command:
            self.assertEqual(m.acceptance('worker'), value)
        source = command.call_args.args[0][-1]
        self.assertIn('/functions/v1/worker/maintenance', source)
        self.assertNotIn('authorization', source.lower())
        self.assertNotIn('k8s_claim', source)

    def test_wall_clock_cannot_be_swallowed_by_dependency_exception_retries(self):
        retried = []
        def broad_dependency_retry():
            try:
                m.deadline(None, None)
            except Exception:
                retried.append(True)
        with self.assertRaises(m.DeadlineExceeded):
            broad_dependency_retry()
        self.assertEqual(retried, [])

    def test_queue_and_setup_time_reduce_work_budget_and_preserve_cleanup(self):
        created = 1800000000
        with patch.dict(os.environ, {'TENDERDESK_RUN_DEADLINE_EPOCH': str(created + 170)}):
            self.assertEqual(m.work_budget(created + 10), 110)
            self.assertEqual(m.work_budget(created + 45), 85)
            self.assertEqual(m.work_budget(created + 85), 45)
            with self.assertRaises(m.ReleaseError):
                m.work_budget(created + 86)
            with self.assertRaises(m.ReleaseError):
                m.work_budget(created - 10)
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(m.ReleaseError):
            m.work_budget(created)

    def test_cleanup_retry_cannot_reset_the_absolute_deadline(self):
        created = 1800000000
        with patch.dict(os.environ, {'TENDERDESK_RUN_DEADLINE_EPOCH': str(created + 170)}), \
                patch.object(m.time, 'time', return_value=created + 166), \
                patch.object(m.base, 'journal_path') as journal, patch.object(m, 'cleanup_owned_client') as clean, \
                patch.object(m.signal, 'alarm') as alarm:
            journal.return_value.exists.return_value = True
            m.cleanup()
            clean.assert_called_once()
            self.assertEqual([call.args for call in alarm.call_args_list], [(4,), (0,)])

    def test_paused_or_misrouted_scheduler_is_rejected_without_activating_it(self):
        original = {name: workload('old') for name in m.TARGETS}
        for name in m.TARGETS:
            container = original[name]['spec']['template']['spec']['containers'][0]
            container.update(name=name, env=[{'name': 'APP_RUNTIME_SERVICE', 'value': name}])
        environment = original['scheduler']['spec']['template']['spec']['containers'][0]['env']
        environment.extend([{'name': 'APP_SCHEDULER_ENABLED', 'value': 'true'},
                            {'name': 'APP_WORKER_URL', 'value': 'http://worker:8080/functions/v1/worker'}])
        m.verify_runtime_contract(original)
        for index, value in ((1, 'false'), (2, 'https://other.example/worker')):
            changed = copy.deepcopy(original)
            changed['scheduler']['spec']['template']['spec']['containers'][0]['env'][index]['value'] = value
            with self.assertRaises(m.ReleaseError):
                m.verify_runtime_contract(changed)
        self.assertEqual(environment[1]['value'], 'true')

    def cleanup_fixture(self, directory):
        nonce = 'a1b2c3d4'
        name = 'assess-observer-123-1-' + nonce
        value = {'base': name, 'nonce': nonce, 'pod': name + '-pg', 'secret': name + '-db',
                 'labels': {'app.kubernetes.io/managed-by': m.base.OWNER, 'tenderdesk.io/observation': nonce},
                 'timeout': 1800}
        path = Path(directory) / 'delivery-client.json'
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        resources = {(kind, value[kind]): {'metadata': {'name': value[kind], 'namespace': m.d.NAMESPACE,
                      'labels': value['labels'].copy(), 'uid': 'owned-' + kind, 'resourceVersion': '42'}}
                     for kind in ('pod', 'secret')}
        return path, resources

    def test_cleanup_uses_owned_uid_preconditions_and_short_grace_without_force(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}):
            path, resources = self.cleanup_fixture(directory)
            calls = []
            def command(arguments, **kwargs):
                calls.append((arguments, json.loads(kwargs['payload'])))
                resource_name = arguments[2].rsplit('/', 1)[1]
                kind = 'pod' if resource_name.endswith('-pg') else 'secret'
                resources.pop((kind, resource_name))
            with patch.object(m.base, 'journal_path', return_value=path), \
                    patch.object(m.d, 'get', side_effect=lambda kind, name: copy.deepcopy(resources.get((kind, name)))), \
                    patch.object(m.d, 'command', side_effect=command):
                m.cleanup_owned_client()
            self.assertFalse(path.exists())
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0][1]['gracePeriodSeconds'], 1)
            self.assertNotIn('gracePeriodSeconds', calls[1][1])
            self.assertEqual(calls[0][1]['preconditions'], {'uid': 'owned-pod', 'resourceVersion': '42'})
            self.assertTrue(all('--force' not in args for args, _ in calls))
            self.assertFalse(resources)

    def test_cleanup_refuses_foreign_resource_before_any_delete(self):
        with tempfile.TemporaryDirectory() as directory, \
                patch.dict(os.environ, {'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1'}):
            path, resources = self.cleanup_fixture(directory)
            secret = next(resource for (kind, _), resource in resources.items() if kind == 'secret')
            secret['metadata']['labels']['tenderdesk.io/observation'] = 'foreign'
            with patch.object(m.base, 'journal_path', return_value=path), \
                    patch.object(m.d, 'get', side_effect=lambda kind, name: copy.deepcopy(resources.get((kind, name)))), \
                    patch.object(m.d, 'command') as delete:
                with self.assertRaises(m.ReleaseError):
                    m.cleanup_owned_client()
                delete.assert_not_called()
            self.assertTrue(path.exists())


class QualificationGuards(unittest.TestCase):
    def native(self):
        receipt = {'image': {'Id': 'sha256:' + '1' * 64},
                   'source': {'source_entries': {'backend/scripts/runtime/main.ts': {'type': 'file', 'sha256': '2' * 64}}}}
        native = {'version': 1, 'kind': 'proposal_dispatch_native', 'image_id': receipt['image']['Id'],
                  'passed': True, 'actual_image_entrypoint': True, 'network': 'none', 'external_calls': 0,
                  'cleanup_verified': True, 'source_sha256': q.source_hashes(receipt['source']),
                  'checks': dict.fromkeys(q.CHECKS, True),
                  'harness_sha256': {name: q.sha(q.ROOT / name) for name in q.HARNESSES}}
        return receipt, native

    def test_native_gate_rejects_old_image_source_stub_entrypoint_and_external_network(self):
        receipt, native = self.native()
        q.validate_native(native, receipt)
        for key, value in [('image_id', 'sha256:' + '0' * 64), ('source_sha256', {}),
                           ('actual_image_entrypoint', False), ('network', 'bridge'),
                           ('external_calls', 1), ('cleanup_verified', False), ('checks', {})]:
            with self.subTest(key=key), self.assertRaises(q.QualificationError):
                q.validate_native({**native, key: value}, receipt)

    def test_native_harness_changes_invalidate_qualification(self):
        receipt, native = self.native()
        native['harness_sha256'][q.HARNESSES[0]] = '0' * 64
        with self.assertRaises(q.QualificationError):
            q.validate_native(native, receipt)

    def test_exact_image_configuration_layers_and_digest_are_mandatory(self):
        image = {'Id': 'sha256:' + '1' * 64, 'Os': 'linux', 'Architecture': 'amd64', 'Variant': '',
                 'RootFS': {'Type': 'layers', 'Layers': ['fixed']}, 'Config': {'Cmd': ['actual-entrypoint']}}
        receipt = {'image': image}
        reference = q.REGISTRY + '@sha256:' + '2' * 64
        observed = {**copy.deepcopy(image), 'RepoDigests': [reference]}
        q.verify_image(observed, receipt, reference)
        for key, value in [('Id', 'other'), ('Config', {'Cmd': ['different']}),
                           ('RootFS', {'Type': 'layers', 'Layers': ['different']}), ('RepoDigests', [])]:
            with self.subTest(key=key), self.assertRaises(q.QualificationError):
                q.verify_image({**observed, key: value}, receipt, reference)

    def test_build_source_changes_invalidate_exact_image_receipt(self):
        receipt = {'image': {'Id': 'sha256:' + '1' * 64}, 'source_revision': '3' * 40, 'source': {'files': 'frozen'}}
        build = {'version': 1, 'image_id': receipt['image']['Id'], 'source_revision': receipt['source_revision'],
                 'build_exit_code': 0, 'source_before': receipt['source'], 'source_after': receipt['source'],
                 'recipe': q.RECIPE, 'base': q.BASE}
        q.validate_build(build, receipt)
        with self.assertRaises(q.QualificationError):
            q.validate_build({**build, 'source_after': {'files': 'edited'}}, receipt)


if __name__ == '__main__':
    unittest.main()
