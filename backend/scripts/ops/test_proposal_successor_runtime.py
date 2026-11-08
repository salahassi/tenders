import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('successor_runtime_tests', HERE / 'proposal-successor-runtime.py')
m = importlib.util.module_from_spec(SPEC); sys.modules[SPEC.name] = m; SPEC.loader.exec_module(m)


class SuccessorQualificationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.harnesses = (*m.worker.HARNESSES, *m.commercial.HARNESSES)
        for name in self.harnesses:
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('synthetic harness')
        entries = {name: {'type': 'file', 'git_mode': '100644', 'sha256': '1' * 64, 'size': 10}
                   for name in m.CHANGED_SOURCES | {'backend/supabase/functions/_shared/modelGrounding.ts'}}
        self.baseline = {'source': {'source_entries': entries, 'supplementary_inputs': {'recipe': {'sha256': '2' * 64}}},
                         'image': {'Id': m.commercial.BASELINE_IMAGE}}
        source = copy.deepcopy(self.baseline['source'])
        for name in m.CHANGED_SOURCES: source['source_entries'][name]['sha256'] = '3' * 64
        config = {'Entrypoint': ['/tini', '--', 'docker-entrypoint.sh'], 'Cmd': m.worker.IMAGE_CMD,
                  'User': 'deno', 'WorkingDir': '/app/backend', 'Labels': {'org.opencontainers.image.revision': 'a' * 40}}
        self.receipt = {'image': {'Id': 'sha256:' + '4' * 64, 'Os': 'linux', 'Architecture': 'amd64',
            'Variant': '', 'Config': config}, 'source': source}
        identity = {'version': 1, 'image_id': self.receipt['image']['Id'], 'passed': True,
            'actual_image_entrypoint': True, 'network': 'none', 'external_calls': 0, 'provider_calls': 0,
            'cleanup_verified': True, 'hosted_acceptance': False, 'source_sha256': m.source_hashes(source)}
        self.worker = {**identity, 'kind': 'proposal_dispatch_v6_native', 'checks': dict.fromkeys(m.worker.CHECKS, True),
            'rpc_names': sorted(m.worker.WORKER_RPCS), 'worker_rpc_names': list(m.worker.WORKER_RPCS),
            'unexpected_rpc_count': 0, 'rpc_count': 3, 'scheduler_image_cmd': m.worker.IMAGE_CMD,
            'image_entrypoint': config['Entrypoint'], 'image_cmd': config['Cmd'], 'image_user': config['User'],
            'resources': {'memory_mib': 1280, 'cpus': 2, 'pids_limit': 128, 'tmpfs_mib': 64, 'readonly_rootfs': True},
            'harness_sha256': {name: m.sha(self.root / name) for name in m.worker.HARNESSES}}
        renders = {language: {'model_sha256': '5' * 64, 'text_sha256': '6' * 64, 'docx_sha256': '7' * 64,
            'bytes': 2048, 'verified': True, 'missing_tax_label': True} for language in m.commercial.LANGUAGES}
        prior = {'fixture_input_sha256': '8' * 64, 'legacy_context_sha256': dict.fromkeys(m.commercial.LEGACY_CONTEXTS, '9' * 64),
            'legacy_wire_sha256': dict.fromkeys(m.commercial.LEGACY_WIRES, 'a' * 64), 'renders': renders}
        self.commercial = {**identity, **copy.deepcopy(prior), 'kind': 'proposal_commercial_v2_native',
            'checks': dict.fromkeys(m.commercial.CHECKS, True), 'modern_wire_sha256': dict.fromkeys(m.commercial.MODERN_WIRES, 'b' * 64),
            'baseline': copy.deepcopy(prior), 'baseline_image_id': self.baseline['image']['Id'],
            'baseline_source_sha256': m.source_hashes(self.baseline['source']),
            'baseline_qualification_sha256': m.reference.RECEIPT_SHA256,
            'harness_sha256': {name: m.sha(self.root / name) for name in m.commercial.HARNESSES}}

    def commercial_validate(self, value=None):
        with patch.object(m, 'historical', return_value=(self.baseline, {})):
            m.validate_commercial_native(self.commercial if value is None else value, self.receipt, self.root)

    def test_exact_five_file_delta_and_fixed_grounding_baseline(self):
        m.validate_source_scope(self.receipt['source'], self.baseline['source'])
        for kind in ('absent_delta', 'missing_delta', 'grounding', 'new_file', 'removed_file', 'mode', 'supplementary'):
            source = copy.deepcopy(self.receipt['source'])
            if kind == 'absent_delta': source = copy.deepcopy(self.baseline['source'])
            elif kind == 'missing_delta':
                name = next(iter(m.CHANGED_SOURCES)); source['source_entries'][name] = self.baseline['source']['source_entries'][name]
            elif kind == 'grounding': source['source_entries']['backend/supabase/functions/_shared/modelGrounding.ts']['sha256'] = 'c' * 64
            elif kind == 'new_file': source['source_entries']['new.ts'] = {'type': 'file'}
            elif kind == 'removed_file': source['source_entries'].pop(next(iter(m.CHANGED_SOURCES)))
            elif kind == 'mode': source['source_entries'][next(iter(m.CHANGED_SOURCES))]['git_mode'] = '100755'
            else: source['supplementary_inputs'] = {}
            with self.subTest(kind=kind), self.assertRaises(m.QualificationError):
                m.validate_source_scope(source, self.baseline['source'])

    def test_actual_deployed_baseline_and_source_scope(self):
        baseline, publication = m.historical(m.ROOT)
        self.assertEqual(baseline['image']['Id'], m.commercial.BASELINE_IMAGE)
        self.assertTrue(publication['reference'].endswith('2097a0798d2f0e3fd908c45db669cc767f32d8ef279adb95b8dff07453e23769'))
        self.assertEqual(m.reference.RECEIPT_SHA256, '7e351bc3b4b884d09af77f3dcc193307de28be55bb9474ed5950e72ba9410aa5')
        m.validate_source_scope(m.snapshot(), baseline['source'])
        self.assertNotIn(m.RECEIPT, (m.reference.RECEIPT, m.previous.RECEIPT, m.latency.RECEIPT, m.dispatch.RECEIPT))

    def test_worker_six_exact_rpc_paths_and_all_ten_controls(self):
        m.validate_worker_native(self.worker, self.receipt, self.root)
        self.assertEqual(len(m.worker.CHECKS), 10)
        for check in m.worker.CHECKS:
            value = copy.deepcopy(self.worker); value['checks'][check] = False
            with self.subTest(check=check), self.assertRaises(m.worker.NativeError):
                m.validate_worker_native(value, self.receipt, self.root)
        for bad in ('claim_backend_job_v5', 'claim_backend_job', 'wake_backend_queue_status_v5'):
            value = copy.deepcopy(self.worker); value['rpc_names'].append(bad); value['rpc_names'].sort()
            with self.subTest(rpc=bad), self.assertRaises(m.worker.NativeError):
                m.validate_worker_native(value, self.receipt, self.root)
        value = copy.deepcopy(self.worker); value['worker_rpc_names'].pop()
        with self.assertRaises(m.worker.NativeError): m.validate_worker_native(value, self.receipt, self.root)

    def test_native_identity_offline_cleanup_and_resources_are_required(self):
        for name, value in [('kind', 'proposal_dispatch_native'), ('image_id', self.baseline['image']['Id']),
            ('source_sha256', {}), ('passed', False), ('actual_image_entrypoint', False), ('network', 'bridge'),
            ('provider_calls', 1), ('external_calls', 1), ('cleanup_verified', False), ('hosted_acceptance', True),
            ('image_cmd', []), ('resources', {})]:
            with self.subTest(name=name), self.assertRaises(m.QualificationError):
                m.validate_worker_native(self.worker | {name: value}, self.receipt, self.root)
        for name, value in [('image_id', self.baseline['image']['Id']), ('provider_calls', 1), ('external_calls', 1),
                            ('cleanup_verified', False), ('hosted_acceptance', True), ('source_sha256', {})]:
            with self.subTest(commercial=name), self.assertRaises(m.QualificationError): self.commercial_validate(self.commercial | {name: value})

    def test_commercial_all_eleven_controls_and_baseline_source_binding(self):
        self.commercial_validate()
        self.assertEqual(len(m.commercial.CHECKS), 11)
        for check in m.commercial.CHECKS:
            value = copy.deepcopy(self.commercial); value['checks'][check] = False
            with self.subTest(check=check), self.assertRaisesRegex(m.QualificationError, 'CHECKS'): self.commercial_validate(value)
        for name in ('baseline_image_id', 'baseline_source_sha256', 'baseline_qualification_sha256'):
            with self.subTest(name=name), self.assertRaisesRegex(m.QualificationError, 'BASELINE'):
                self.commercial_validate(self.commercial | {name: None})

    def test_commercial_full_case_maps_and_unchanged_legacy_bytes(self):
        self.assertEqual((len(m.commercial.LEGACY_CONTEXTS), len(m.commercial.LEGACY_WIRES), len(m.commercial.MODERN_WIRES)), (4, 24, 12))
        for baseline in (False, True):
            for field in ('legacy_context_sha256', 'legacy_wire_sha256'):
                value = copy.deepcopy(self.commercial); subject = value['baseline'] if baseline else value
                subject[field].pop(next(iter(subject[field])))
                with self.subTest(baseline=baseline, field=field), self.assertRaises(m.commercial.NativeError): self.commercial_validate(value)
        value = copy.deepcopy(self.commercial); value['baseline']['fixture_input_sha256'] = 'c' * 64
        with self.assertRaisesRegex(m.commercial.NativeError, 'CASE_INPUT_CHANGED'): self.commercial_validate(value)
        value = copy.deepcopy(self.commercial); value['baseline']['legacy_wire_sha256'][next(iter(m.commercial.LEGACY_WIRES))] = 'c' * 64
        with self.assertRaisesRegex(m.commercial.NativeError, 'LEGACY_BYTES_CHANGED'): self.commercial_validate(value)
        value = copy.deepcopy(self.commercial); value['modern_wire_sha256'][next(iter(m.commercial.MODERN_WIRES))] = 'a' * 64
        with self.assertRaisesRegex(m.commercial.NativeError, 'MODERN_WIRE_NOT_BOUND'): self.commercial_validate(value)

    def test_actual_docx_render_content_and_localized_missing_tax_are_bound(self):
        for language in ('en', 'ar'):
            for field, bad in [('model_sha256', 'c' * 64), ('text_sha256', 'c' * 64), ('missing_tax_label', False),
                               ('verified', False), ('bytes', 1), ('docx_sha256', 'invalid')]:
                value = copy.deepcopy(self.commercial); value['renders'][language][field] = bad
                with self.subTest(language=language, field=field), self.assertRaises(m.commercial.NativeError): self.commercial_validate(value)
        # ZIP timestamps need not match: semantic model and verified text must.
        value = copy.deepcopy(self.commercial); value['renders']['ar']['docx_sha256'] = 'c' * 64
        self.commercial_validate(value)

    def test_exact_harness_bytes_for_both_new_receipts(self):
        for fixture, validate in ((self.worker, lambda v: m.validate_worker_native(v, self.receipt, self.root)),
                                  (self.commercial, self.commercial_validate)):
            value = copy.deepcopy(fixture); value['harness_sha256']['extra.ts'] = 'c' * 64
            with self.assertRaisesRegex(m.QualificationError, 'HARNESS'): validate(value)
            name = next(iter(fixture['harness_sha256'])); path = self.root / name; path.write_text('modified')
            with self.assertRaisesRegex(m.QualificationError, 'HARNESS_CHANGED'): validate(fixture)
            path.write_text('synthetic harness')

    def test_all_parent_sql_and_successor_sql_bytes_are_bound(self):
        policies = {'poll_migration': {'path': 'old.sql', 'sha256': '1' * 64},
                    'pending_poll_migration': {'path': 'poll.sql', 'sha256': '2' * 64}}
        path = self.root / m.SUCCESSOR_MIGRATION; path.parent.mkdir(parents=True); path.write_text('synthetic migration')
        with patch.object(m.reference, 'policy_migrations', return_value=policies), \
             patch.object(m, 'historical', return_value=(policies, {})):
            actual = m.policy_migrations(self.root)
            self.assertEqual(actual, policies | {'successor_migration': {'path': m.SUCCESSOR_MIGRATION, 'sha256': m.sha(path)}})
            baseline = copy.deepcopy(policies); baseline['poll_migration']['sha256'] = 'c' * 64
            with patch.object(m, 'historical', return_value=(baseline, {})), self.assertRaisesRegex(m.QualificationError, 'PARENT_SQL_CHANGED'):
                m.policy_migrations(self.root)
            path.unlink(); path.symlink_to(self.root / 'missing')
            with self.assertRaisesRegex(m.QualificationError, 'SUCCESSOR_SQL_MISSING'): m.policy_migrations(self.root)

    def test_all_five_native_receipts_and_three_sql_bindings_are_mandatory(self):
        policies = {name: {'path': name + '.sql', 'sha256': '1' * 64}
                    for name in ('poll_migration', 'pending_poll_migration', 'successor_migration')}
        binding = {'reference': 'synthetic', 'image_id': self.baseline['image']['Id'], 'qualification_sha256': m.reference.RECEIPT_SHA256}
        value = self.receipt | {'kind': 'proposal_successor_runtime', 'baseline': binding,
            'build': {'path': 'build'}, 'successor_sql_qualified': False, **policies,
            **{name: {'path': name} for name in m.NATIVE_FIELDS}}
        contents = {name: {'kind': name} for name in m.NATIVE_FIELDS}; contents['build'] = copy.deepcopy(policies)
        with patch.object(m, 'historical', return_value=(self.baseline, {})), patch.object(m, 'baseline_binding', return_value=binding), \
             patch.object(m, 'validate_image_source'), patch.object(m, 'policy_migrations', return_value=policies), \
             patch.object(m.dispatch, 'read_bound', side_effect=lambda root, item: contents[item['path']]), \
             patch.object(m, 'validate_worker_native') as worker, patch.object(m.latency, 'validate_prompt_native') as prompt, \
             patch.object(m.previous, 'validate_poll_native') as poll, patch.object(m.reference, 'validate_boundary_native') as boundary, \
             patch.object(m, 'validate_commercial_native') as commercial, patch.object(m.dispatch, 'validate_native') as old:
            m.validate_receipt(self.root, value)
            for name, validator in zip(m.NATIVE_FIELDS, (worker, prompt, poll, boundary, commercial)):
                validator.assert_called_once_with(contents[name], value, self.root)
            old.assert_not_called()
            for key in policies:
                with self.subTest(policy=key), self.assertRaisesRegex(m.QualificationError, 'SQL_BINDING'):
                    m.validate_receipt(self.root, value | {key: {'path': 'wrong.sql', 'sha256': '0' * 64}})
                contents['build'][key] = {'path': 'wrong.sql', 'sha256': '0' * 64}
                with self.assertRaisesRegex(m.QualificationError, 'SQL_BINDING'): m.validate_receipt(self.root, value)
                contents['build'][key] = policies[key]
            with self.assertRaisesRegex(m.QualificationError, 'SQL_SCOPE'): m.validate_receipt(self.root, value | {'successor_sql_qualified': True})

    def test_common_image_build_and_source_identity_cannot_be_bypassed(self):
        base = {'Id': 'sha256:' + 'c' * 64, 'RootFS': {'Type': 'layers', 'Layers': ['original']},
                'Config': copy.deepcopy(self.receipt['image']['Config'])}
        value = copy.deepcopy(self.receipt)
        value.update(version=1, scope=['worker', 'scheduler'], base=m.BASE, source_revision='a' * 40,
                     base_image=base, app_sha256=m.source_hashes(value['source']), build={'path': 'build'})
        value['image']['RootFS'] = {'Type': 'layers', 'Layers': ['original', 'candidate']}
        with patch.object(m, 'snapshot', return_value=value['source']), patch.object(m.source_guard, 'load', return_value={}), \
             patch.object(m.source_guard, 'verify_image') as verify, patch.object(m.dispatch, 'read_bound', return_value={'build': 'bound'}), \
             patch.object(m.dispatch, 'validate_build') as build, patch.object(m.dispatch, 'validate_native') as old:
            m.validate_image_source(self.root, value)
            verify.assert_called_once_with(base, {})
            build.assert_called_once_with({'build': 'bound'}, value)
            old.assert_not_called()
            for kind in ('revision', 'platform', 'configuration', 'layers', 'source', 'app'):
                changed = copy.deepcopy(value)
                if kind == 'revision': changed['image']['Config']['Labels']['org.opencontainers.image.revision'] = 'b' * 40
                elif kind == 'platform': changed['image']['Architecture'] = 'arm64'
                elif kind == 'configuration': changed['image']['Config']['User'] = 'root'
                elif kind == 'layers': changed['image']['RootFS']['Layers'][0] = 'foreign'
                elif kind == 'source': changed['source']['source_entries'] = {}
                else: changed['app_sha256'] = {}
                with self.subTest(kind=kind), self.assertRaises(m.QualificationError): m.validate_image_source(self.root, changed)

    def test_unfrozen_or_existing_publication_cannot_reach_registry(self):
        with patch.object(m, 'ROOT', self.root), patch.object(m, 'RECEIPT_SHA256', None), patch.object(m, 'docker') as docker:
            with self.assertRaisesRegex(m.QualificationError, 'NOT_FROZEN'): m.publish()
            docker.assert_not_called()
        path = self.root / m.PUBLICATION; path.parent.mkdir(parents=True); path.write_text('{}')
        with patch.object(m, 'ROOT', self.root), patch.object(m, 'load') as load:
            with self.assertRaisesRegex(m.QualificationError, 'PUBLICATION_EXISTS'): m.publish()
            load.assert_not_called()

    def test_broad_source_change_blocks_build_before_docker_access(self):
        source = copy.deepcopy(self.receipt['source']); source['source_entries']['unreviewed.ts'] = {'type': 'file'}
        with patch.object(m.subprocess, 'check_output', return_value='a' * 40), patch.object(m, 'assert_source_revision'), \
             patch.object(m, 'snapshot', return_value=source), patch.object(m, 'historical', return_value=(self.baseline, {})), \
             patch.object(m, 'image_metadata') as image:
            with self.assertRaisesRegex(m.QualificationError, 'SOURCE_SCOPE_CHANGED'): m.build(SimpleNamespace(source_revision='a' * 40))
            image.assert_not_called()


if __name__ == '__main__': unittest.main()
