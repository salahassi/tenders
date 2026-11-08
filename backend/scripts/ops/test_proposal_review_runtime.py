import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('review_runtime_tests', HERE / 'proposal-review-runtime.py')
m = importlib.util.module_from_spec(SPEC); sys.modules[SPEC.name] = m; SPEC.loader.exec_module(m)


class ReviewQualificationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        fixed = {'backend/supabase/functions/_shared/model.ts', 'backend/supabase/functions/_shared/modelGrounding.ts'}
        entries = {name: {'type': 'file', 'git_mode': '100644', 'sha256': '1' * 64, 'size': 10}
                   for name in m.CHANGED_SOURCES | fixed}
        self.baseline = {'source': {'source_entries': entries, 'supplementary_inputs': {'recipe': {'sha256': '2' * 64}}},
                         'image': {'Id': m.BASELINE_IMAGE}}
        source = copy.deepcopy(self.baseline['source'])
        for name in m.CHANGED_SOURCES: source['source_entries'][name]['sha256'] = '3' * 64
        self.receipt = {'image': {'Id': 'sha256:' + '4' * 64}, 'source': source}

    def test_exact_four_file_scope_keeps_prompt_and_grounding_inputs_fixed(self):
        self.assertEqual(len(m.CHANGED_SOURCES), 4)
        m.validate_source_scope(self.receipt['source'], self.baseline['source'])
        for kind in ('absent_delta', 'missing_delta', 'model', 'grounding', 'new_file', 'removed_file', 'mode', 'supplementary'):
            source = copy.deepcopy(self.receipt['source'])
            if kind == 'absent_delta': source = copy.deepcopy(self.baseline['source'])
            elif kind == 'missing_delta':
                name = next(iter(m.CHANGED_SOURCES)); source['source_entries'][name] = self.baseline['source']['source_entries'][name]
            elif kind in ('model', 'grounding'):
                name = 'model.ts' if kind == 'model' else 'modelGrounding.ts'
                source['source_entries']['backend/supabase/functions/_shared/' + name]['sha256'] = 'c' * 64
            elif kind == 'new_file': source['source_entries']['new.ts'] = {'type': 'file'}
            elif kind == 'removed_file': source['source_entries'].pop(next(iter(m.CHANGED_SOURCES)))
            elif kind == 'mode': source['source_entries'][next(iter(m.CHANGED_SOURCES))]['git_mode'] = '100755'
            else: source['supplementary_inputs'] = {}
            with self.subTest(kind=kind), self.assertRaises(m.QualificationError):
                m.validate_source_scope(source, self.baseline['source'])

    def test_actual_deployed_successor_identity_and_historical_receipts_are_immutable(self):
        baseline, publication = m.historical(m.ROOT)
        self.assertEqual(baseline['image']['Id'], m.BASELINE_IMAGE)
        self.assertEqual(publication['reference'], m.BASELINE_REFERENCE)
        self.assertEqual(m.sha(m.ROOT / m.successor.RECEIPT), m.BASELINE_QUALIFICATION_SHA256)
        self.assertEqual(m.sha(m.ROOT / m.successor.PUBLICATION), m.BASELINE_PUBLICATION_SHA256)
        m.validate_source_scope(m.snapshot(), baseline['source'])
        self.assertNotIn(m.RECEIPT, (m.successor.RECEIPT, m.reference.RECEIPT, m.previous.RECEIPT, m.latency.RECEIPT, m.dispatch.RECEIPT))
        with patch.object(m.successor, 'RECEIPT_SHA256', 'f' * 64), self.assertRaisesRegex(m.QualificationError, 'HISTORICAL_QUALIFICATION_CHANGED'):
            m.historical(m.ROOT)

    def test_five_sql_policies_bind_immutable_parents_and_new_checkpoint_bytes(self):
        policies = {key: {'path': key + '.sql', 'sha256': str(i) * 64}
                    for i, key in enumerate(('poll_migration', 'pending_poll_migration', 'successor_migration'), 1)}
        checkpoint = self.root / m.CHECKPOINT_MIGRATION
        checkpoint.parent.mkdir(parents=True)
        checkpoint.write_bytes((m.ROOT / m.CHECKPOINT_MIGRATION).read_bytes())
        name = 'backend/supabase/migrations/20261109000000_synthetic_review.sql'
        review = self.root / name; review.write_text('synthetic migration')
        with patch.object(m.successor, 'policy_migrations', return_value=policies), \
             patch.object(m, 'historical', return_value=(copy.deepcopy(policies), {})), \
             patch.object(m, 'ZERO_INVENTORY_REVIEW_MIGRATION', name):
            actual = m.policy_migrations(self.root)
            self.assertEqual(actual['checkpoint_migration'], {'path': m.CHECKPOINT_MIGRATION, 'sha256': m.CHECKPOINT_SHA256})
            self.assertEqual(actual['zero_inventory_review_migration'], {'path': name, 'sha256': m.sha(review)})
            self.assertEqual(len(actual), 5)
            # policy_migrations must not mutate its parent's map on read.
            self.assertEqual(len(policies), 3)
            baseline = copy.deepcopy(policies); baseline['successor_migration']['sha256'] = 'c' * 64
            with patch.object(m, 'historical', return_value=(baseline, {})), self.assertRaisesRegex(m.QualificationError, 'PARENT_SQL_CHANGED'):
                m.policy_migrations(self.root)
            checkpoint.write_text('changed even if committed')
            with self.assertRaisesRegex(m.QualificationError, 'CHECKPOINT_SQL_CHANGED'):
                m.policy_migrations(self.root)
            checkpoint.write_bytes((m.ROOT / m.CHECKPOINT_MIGRATION).read_bytes())
            review.unlink(); review.symlink_to(checkpoint)
            with self.assertRaisesRegex(m.QualificationError, 'POLICY_SQL_MISSING'): m.policy_migrations(self.root)

    def test_unprepared_migration_and_unfrozen_image_fail_closed(self):
        policies = {'successor_migration': {'path': 'old.sql', 'sha256': '1' * 64}}
        with patch.object(m.successor, 'policy_migrations', return_value=policies), \
             patch.object(m, 'historical', return_value=(policies, {})), \
             patch.object(m, 'ZERO_INVENTORY_REVIEW_MIGRATION', None), \
             self.assertRaisesRegex(m.QualificationError, 'REVIEW_SQL_NOT_PREPARED'):
            m.policy_migrations(self.root)
        with patch.object(m, 'ROOT', self.root), patch.object(m, 'RECEIPT_SHA256', None), patch.object(m, 'docker') as docker:
            with self.assertRaisesRegex(m.QualificationError, 'NOT_FROZEN'): m.publish()
            docker.assert_not_called()

    def test_existing_publication_cannot_be_replaced(self):
        path = self.root / m.PUBLICATION; path.parent.mkdir(parents=True); path.write_text('{}')
        with patch.object(m, 'ROOT', self.root), patch.object(m, 'load') as load:
            with self.assertRaisesRegex(m.QualificationError, 'PUBLICATION_EXISTS'): m.publish()
            load.assert_not_called()

    def test_all_six_native_proofs_and_five_sql_bindings_are_mandatory(self):
        policies = {name: {'path': name + '.sql', 'sha256': '1' * 64}
                    for name in ('poll_migration', 'pending_poll_migration', 'successor_migration',
                                 'checkpoint_migration', 'zero_inventory_review_migration')}
        binding = {'reference': m.BASELINE_REFERENCE, 'image_id': m.BASELINE_IMAGE,
                   'qualification_sha256': m.BASELINE_QUALIFICATION_SHA256}
        value = self.receipt | {'kind': 'proposal_review_runtime', 'baseline': binding,
            'build': {'path': 'build'}, 'review_sql_qualified': False, **policies,
            **{name: {'path': name} for name in m.NATIVE_FIELDS}}
        contents = {name: {'kind': name} for name in m.NATIVE_FIELDS}; contents['build'] = copy.deepcopy(policies)
        with patch.object(m, 'historical', return_value=(self.baseline, {})), patch.object(m, 'baseline_binding', return_value=binding), \
             patch.object(m, 'validate_image_source'), patch.object(m, 'policy_migrations', return_value=policies), \
             patch.object(m.dispatch, 'read_bound', side_effect=lambda root, item: contents[item['path']]), \
             patch.object(m, 'validate_worker_native') as worker, patch.object(m.latency, 'validate_prompt_native') as prompt, \
             patch.object(m.previous, 'validate_poll_native') as poll, patch.object(m.reference, 'validate_boundary_native') as boundary, \
             patch.object(m, 'validate_commercial_native') as commercial, patch.object(m, 'validate_review_native') as review, \
             patch.object(m.dispatch, 'validate_native') as v5, patch.object(m.successor, 'validate_worker_native') as v6:
            m.validate_receipt(self.root, value)
            for name, validator in zip(m.NATIVE_FIELDS, (worker, prompt, poll, boundary, commercial, review)):
                validator.assert_called_once_with(contents[name], value, self.root)
            v5.assert_not_called(); v6.assert_not_called()
            for key in policies:
                with self.subTest(policy=key), self.assertRaisesRegex(m.QualificationError, 'SQL_BINDING'):
                    m.validate_receipt(self.root, value | {key: {'path': 'wrong.sql', 'sha256': '0' * 64}})
                contents['build'][key] = {'path': 'wrong.sql', 'sha256': '0' * 64}
                with self.assertRaisesRegex(m.QualificationError, 'SQL_BINDING'): m.validate_receipt(self.root, value)
                contents['build'][key] = policies[key]
            with self.assertRaisesRegex(m.QualificationError, 'SQL_SCOPE'):
                m.validate_receipt(self.root, value | {'review_sql_qualified': True})
            for field in m.NATIVE_FIELDS:
                missing = value.copy(); missing.pop(field)
                with self.subTest(native=field), self.assertRaises(KeyError): m.validate_receipt(self.root, missing)

    def test_current_image_is_not_a_candidate_and_scope_drift_blocks_build_before_docker(self):
        with patch.object(m, 'historical', return_value=(self.baseline, {})), patch.object(m, 'validate_image_source') as validate:
            with self.assertRaisesRegex(m.QualificationError, 'CANDIDATE_IDENTITY'):
                m.validate_receipt(self.root, {'kind': 'proposal_review_runtime', 'image': {'Id': m.BASELINE_IMAGE}})
            validate.assert_not_called()
        source = copy.deepcopy(self.receipt['source']); source['source_entries']['unreviewed.ts'] = {'type': 'file'}
        with patch.object(m.subprocess, 'check_output', return_value='a' * 40), patch.object(m, 'assert_source_revision'), \
             patch.object(m, 'snapshot', return_value=source), patch.object(m, 'historical', return_value=(self.baseline, {})), \
             patch.object(m, 'image_metadata') as image:
            with self.assertRaisesRegex(m.QualificationError, 'SOURCE_SCOPE_CHANGED'):
                m.build(SimpleNamespace(source_revision='a' * 40))
            image.assert_not_called()


class ReviewNativeQualificationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.worker_contract = m.module('review_test_worker_contract', '../testing/worker_dispatch_v7_native.py')
        self.review_contract = m.module('review_test_legacy_contract', '../testing/legacy_review_native.py')
        contracts = {'../testing/worker_dispatch_v7_native.py': self.worker_contract,
                     '../testing/legacy_review_native.py': self.review_contract}
        loader = patch.object(m, 'module', side_effect=lambda name, filename: contracts[filename])
        loader.start(); self.addCleanup(loader.stop)
        for name in (*self.worker_contract.HARNESSES, *self.review_contract.HARNESSES):
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('synthetic harness')
        baseline_source = {'source_entries': {'retained.ts': {'type': 'file', 'sha256': '1' * 64}}}
        self.baseline = {'image': {'Id': m.BASELINE_IMAGE}, 'source': baseline_source}
        source = {'source_entries': {'retained.ts': {'type': 'file', 'sha256': '2' * 64}}}
        config = {'Entrypoint': ['/tini', '--', 'docker-entrypoint.sh'], 'Cmd': self.worker_contract.IMAGE_CMD,
                  'User': 'deno', 'WorkingDir': '/app/backend'}
        self.receipt = {'image': {'Id': 'sha256:' + '3' * 64, 'Os': 'linux', 'Architecture': 'amd64',
            'Variant': '', 'Config': config}, 'source': source}
        identity = {'version': 1, 'image_id': self.receipt['image']['Id'], 'passed': True,
            'actual_image_entrypoint': True, 'network': 'none', 'external_calls': 0, 'provider_calls': 0,
            'cleanup_verified': True, 'hosted_acceptance': False, 'source_sha256': m.source_hashes(source)}
        self.worker = {**identity, 'kind': 'proposal_dispatch_v7_native',
            'checks': dict.fromkeys(self.worker_contract.CHECKS, True),
            'rpc_names': sorted(self.worker_contract.WORKER_RPCS), 'worker_rpc_names': list(self.worker_contract.WORKER_RPCS),
            'unexpected_rpc_count': 0, 'rpc_count': 3, 'scheduler_image_cmd': self.worker_contract.IMAGE_CMD,
            'image_entrypoint': config['Entrypoint'], 'image_cmd': config['Cmd'], 'image_user': config['User'],
            'resources': {'memory_mib': 1280, 'cpus': 2, 'pids_limit': 128, 'tmpfs_mib': 64, 'readonly_rootfs': True},
            'harness_sha256': {name: m.sha(self.root / name) for name in self.worker_contract.HARNESSES}}
        prior = {'fixture_input_sha256': '4' * 64,
            'legacy_context_sha256': dict.fromkeys(self.review_contract.LEGACY_CONTEXTS, '5' * 64),
            'legacy_wire_sha256': dict.fromkeys(self.review_contract.LEGACY_WIRES, '6' * 64),
            'transition_review_count': 0}
        self.review = {**identity, **copy.deepcopy(prior), 'kind': 'proposal_legacy_review_native',
            'checks': dict.fromkeys(self.review_contract.CHECKS, True),
            'modern_wire_sha256': dict.fromkeys(self.review_contract.MODERN_WIRES, '7' * 64),
            'rejected_scope_cases': dict.fromkeys(self.review_contract.SCOPE_REJECTIONS, 'INVALID_INPUT'),
            'review_source_sha256': '8' * 64, 'transition_review_count': 1,
            'baseline': copy.deepcopy(prior), 'baseline_image_id': m.BASELINE_IMAGE,
            'baseline_source_sha256': m.source_hashes(baseline_source),
            'baseline_qualification_sha256': m.BASELINE_QUALIFICATION_SHA256,
            'harness_sha256': {name: m.sha(self.root / name) for name in self.review_contract.HARNESSES}}

    def validate_review(self, value=None):
        with patch.object(m, 'historical', return_value=(self.baseline, {})):
            m.validate_review_native(self.review if value is None else value, self.receipt, self.root)

    def test_seven_executor_rpc_contract_is_distinct_from_six_and_requires_all_controls(self):
        self.assertEqual(len(self.worker_contract.CHECKS), 10)
        m.validate_worker_native(self.worker, self.receipt, self.root)
        for name in self.worker_contract.CHECKS:
            value = copy.deepcopy(self.worker); value['checks'][name] = False
            with self.subTest(check=name), self.assertRaisesRegex(self.worker_contract.NativeError, 'PROBE_CHECK_MISSING'):
                m.validate_worker_native(value, self.receipt, self.root)
        for rpc in ('claim_backend_job_v6', 'claim_backend_local_job_v6', 'wake_backend_queue_status_v6', 'claim_backend_job'):
            value = copy.deepcopy(self.worker); value['rpc_names'].append(rpc); value['rpc_names'].sort()
            with self.subTest(rpc=rpc), self.assertRaisesRegex(self.worker_contract.NativeError, 'EXECUTOR7_RPC_PATHS'):
                m.validate_worker_native(value, self.receipt, self.root)
        value = copy.deepcopy(self.worker); value['worker_rpc_names'].pop()
        with self.assertRaisesRegex(self.worker_contract.NativeError, 'EXECUTOR7_RPC_PATHS'):
            m.validate_worker_native(value, self.receipt, self.root)

    def test_identity_source_offline_cleanup_and_entrypoint_cannot_be_relabelled(self):
        for name, value in [('image_id', m.BASELINE_IMAGE), ('source_sha256', {}), ('passed', False),
            ('actual_image_entrypoint', False), ('network', 'bridge'), ('external_calls', 1), ('provider_calls', True),
            ('cleanup_verified', False), ('hosted_acceptance', True)]:
            for fixture, validator in ((self.worker, lambda v: m.validate_worker_native(v, self.receipt, self.root)),
                                       (self.review, self.validate_review)):
                with self.subTest(name=name, kind=fixture['kind']), self.assertRaises(m.successor.QualificationError):
                    validator(fixture | {name: value})
        for name, value in [('kind', 'proposal_dispatch_v6_native'), ('image_cmd', []), ('resources', {})]:
            with self.subTest(name=name), self.assertRaises((m.QualificationError, m.successor.QualificationError)):
                m.validate_worker_native(self.worker | {name: value}, self.receipt, self.root)
        with self.assertRaises(m.successor.QualificationError):
            self.validate_review(self.review | {'kind': 'proposal_commercial_v2_native'})

    def test_all_fourteen_review_controls_and_current_baseline_binding_required(self):
        self.validate_review()
        self.assertEqual(len(self.review_contract.CHECKS), 14)
        for name in self.review_contract.CHECKS:
            value = copy.deepcopy(self.review); value['checks'][name] = False
            with self.subTest(check=name), self.assertRaisesRegex(m.QualificationError, 'REVIEW_NATIVE_CHECKS'):
                self.validate_review(value)
        for name in ('baseline_image_id', 'baseline_source_sha256', 'baseline_qualification_sha256'):
            with self.subTest(name=name), self.assertRaisesRegex(m.QualificationError, 'REVIEW_NATIVE_BASELINE'):
                self.validate_review(self.review | {name: None})

    def test_complete_marker_scope_and_wire_maps_preserve_absent_marker_behavior(self):
        self.assertEqual(tuple(map(len, (self.review_contract.LEGACY_CONTEXTS, self.review_contract.LEGACY_WIRES,
                                        self.review_contract.MODERN_WIRES, self.review_contract.SCOPE_REJECTIONS))), (8, 48, 12, 12))
        for baseline in (False, True):
            for field in ('legacy_context_sha256', 'legacy_wire_sha256'):
                value = copy.deepcopy(self.review); subject = value['baseline'] if baseline else value
                subject[field].pop(next(iter(subject[field])))
                with self.subTest(baseline=baseline, field=field), self.assertRaisesRegex(self.review_contract.NativeError, 'WIRE_CASES_MISSING'):
                    self.validate_review(value)
        for field in ('fixture_input_sha256', 'legacy_wire_sha256'):
            value = copy.deepcopy(self.review)
            if field == 'fixture_input_sha256': value['baseline'][field] = 'c' * 64
            else: value['baseline'][field][next(iter(self.review_contract.LEGACY_WIRES))] = 'c' * 64
            with self.subTest(field=field), self.assertRaisesRegex(self.review_contract.NativeError, 'CASE_INPUT_CHANGED|LEGACY_BYTES_CHANGED'):
                self.validate_review(value)
        value = copy.deepcopy(self.review); value['modern_wire_sha256'][next(iter(self.review_contract.MODERN_WIRES))] = '6' * 64
        with self.assertRaisesRegex(self.review_contract.NativeError, 'MODERN_WIRE_NOT_BOUND'): self.validate_review(value)
        value = copy.deepcopy(self.review); value['rejected_scope_cases'].pop(next(iter(self.review_contract.SCOPE_REJECTIONS)))
        with self.assertRaisesRegex(self.review_contract.NativeError, 'SCOPE_CASES_MISSING'): self.validate_review(value)
        value = copy.deepcopy(self.review); value['rejected_scope_cases'][next(iter(self.review_contract.SCOPE_REJECTIONS))] = 'accepted'
        with self.assertRaisesRegex(self.review_contract.NativeError, 'SCOPE_CASES_MISSING'): self.validate_review(value)

    def test_review_source_and_transition_proof_required_without_claiming_accepted_review(self):
        for name, bad, code in [('review_source_sha256', None, 'REVIEW_SOURCE_MISSING'),
                                ('transition_review_count', 0, 'TRANSITION_COUNT'),
                                ('transition_review_count', True, 'TRANSITION_COUNT')]:
            with self.subTest(name=name, bad=bad), self.assertRaisesRegex(self.review_contract.NativeError, code):
                self.validate_review(self.review | {name: bad})
        value = copy.deepcopy(self.review); value['baseline']['transition_review_count'] = 1
        with self.assertRaisesRegex(self.review_contract.NativeError, 'TRANSITION_COUNT'): self.validate_review(value)
        value = copy.deepcopy(self.review); value['baseline']['unexpected_proof'] = True
        with self.assertRaisesRegex(m.QualificationError, 'REVIEW_NATIVE_CASES'): self.validate_review(value)

    def test_both_new_receipts_bind_exact_harness_bytes(self):
        for fixture, validator in ((self.worker, lambda v: m.validate_worker_native(v, self.receipt, self.root)),
                                   (self.review, self.validate_review)):
            value = copy.deepcopy(fixture); value['harness_sha256']['extra.ts'] = 'c' * 64
            with self.assertRaisesRegex(m.successor.QualificationError, 'HARNESS'): validator(value)
            name = next(iter(fixture['harness_sha256'])); path = self.root / name; path.write_text('modified')
            with self.assertRaisesRegex(m.successor.QualificationError, 'HARNESS_CHANGED'): validator(fixture)
            path.write_text('synthetic harness')


if __name__ == '__main__': unittest.main()
