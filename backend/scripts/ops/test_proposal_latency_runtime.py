import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('proposal_latency_runtime_test', HERE / 'proposal-latency-runtime.py')
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)


class RuntimeGuards(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in m.PROMPT_HARNESSES:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('synthetic immutable harness')
        self.receipt = {'image': {'Id': 'sha256:' + '1' * 64}, 'source': {'source_entries': {
            'backend/supabase/functions/_shared/model.ts': {'type': 'file', 'sha256': '2' * 64}}}}
        self.baseline = {'source': {'source_entries': {
            'backend/supabase/functions/_shared/model.ts': {'type': 'file', 'sha256': '3' * 64}}}}
        self.native = {'version': 1, 'kind': 'proposal_latency_prompt_native',
            'image_id': self.receipt['image']['Id'], 'passed': True, 'actual_image_entrypoint': True,
            'network': 'none', 'external_calls': 0, 'provider_calls': 0, 'cleanup_verified': True,
            'source_sha256': m.source_hashes(self.receipt['source']), 'baseline_image_id': m.BASELINE_IMAGE,
            'baseline_source_sha256': m.source_hashes(self.baseline['source']),
            'baseline_qualification_sha256': m.dispatch.RECEIPT_SHA256,
            'checks': dict.fromkeys(m.PROMPT_CHECKS, True),
            'harness_sha256': {name: m.sha(self.root / name) for name in m.PROMPT_HARNESSES},
            'semantic_revisions': list(range(6)), 'verification_revisions': list(range(1, 6)),
            'new_semantic_revision': 6, 'new_verification_revision': 6, 'legacy_case_count': 84, 'legacy_pin_count': 11}
        self.native.update(legacy_prompt_sha256=dict.fromkeys(m.LEGACY_CASES, '4' * 64), legacy_pins_sha256='5' * 64)
        self.native['baseline'] = {'image_id': m.BASELINE_IMAGE, 'receipt_sha256': m.dispatch.RECEIPT_SHA256,
            'source_sha256': self.native['baseline_source_sha256'],
            'legacy_prompt_sha256': self.native['legacy_prompt_sha256'].copy(), 'legacy_pins_sha256': '5' * 64}

    def validate(self, value=None):
        with patch.object(m, 'historical', return_value=self.baseline):
            m.validate_prompt_native(value or self.native, self.receipt, self.root)

    def test_exact_actual_images_and_offline_cleanup_required(self):
        self.validate()
        for key, value in [('image_id', m.BASELINE_IMAGE), ('baseline_image_id', 'sha256:' + '0' * 64),
                           ('source_sha256', {}), ('baseline_source_sha256', {}), ('passed', False),
                           ('actual_image_entrypoint', False), ('network', 'bridge'), ('external_calls', 1),
                           ('provider_calls', 1), ('cleanup_verified', False),
                           ('baseline_qualification_sha256', '0' * 64)]:
            with self.subTest(key=key), self.assertRaises(m.QualificationError):
                self.validate({**self.native, key: value})

    def test_every_legacy_and_new_policy_case_is_required(self):
        for key, value in [('semantic_revisions', [5]), ('verification_revisions', [5]),
                           ('new_semantic_revision', 5), ('new_verification_revision', 5),
                           ('legacy_case_count', 0), ('legacy_case_count', True), ('legacy_pin_count', 10)]:
            with self.subTest(key=key), self.assertRaisesRegex(m.QualificationError, 'COVERAGE'):
                self.validate({**self.native, key: value})
        for check in m.PROMPT_CHECKS:
            value = copy.deepcopy(self.native)
            value['checks'][check] = False
            with self.subTest(check=check), self.assertRaisesRegex(m.QualificationError, 'CHECKS'):
                self.validate(value)

    def test_harness_content_or_scope_change_invalidates_receipt(self):
        value = copy.deepcopy(self.native)
        value['harness_sha256']['extra.py'] = '0' * 64
        with self.assertRaisesRegex(m.QualificationError, 'HARNESS'): self.validate(value)
        (self.root / m.PROMPT_HARNESSES[0]).write_text('changed')
        with self.assertRaisesRegex(m.QualificationError, 'HARNESS_CHANGED'): self.validate()

    def test_legacy_payload_maps_and_pin_hashes_are_compared_not_only_reported_counts(self):
        for mutation in ('removed', 'substituted', 'invalid', 'pins'):
            value = copy.deepcopy(self.native)
            key = next(iter(value['legacy_prompt_sha256']))
            if mutation == 'removed': value['legacy_prompt_sha256'].pop(key)
            elif mutation == 'substituted': value['legacy_prompt_sha256'][key] = '9' * 64
            elif mutation == 'invalid': value['legacy_prompt_sha256'][key] = 'invalid'
            else: value['legacy_pins_sha256'] = '9' * 64
            with self.subTest(mutation=mutation), self.assertRaisesRegex(m.QualificationError, 'LEGACY_BYTES'):
                self.validate(value)

    def test_historical_receipts_and_helper_constants_are_not_rewritten(self):
        old = m.historical(m.ROOT)
        self.assertEqual(old['image']['Id'], m.BASELINE_IMAGE)
        self.assertNotEqual(m.RECEIPT, m.dispatch.RECEIPT)
        self.assertNotEqual(m.PUBLICATION, m.dispatch.PUBLICATION)
        self.assertEqual(m.dispatch.RECEIPT_SHA256, 'd7a13be2d06e265206c5da8180e91e56f01c28e5a00e8b5f72313cf344930b91')
        self.assertEqual(m.sha(m.ROOT / m.dispatch.PUBLICATION), m.BASELINE_PUBLICATION_SHA256)

    def test_unfrozen_preparation_cannot_verify_or_publish(self):
        with patch.object(m, 'RECEIPT_SHA256', None), patch.object(m, 'docker') as docker:
            with self.assertRaisesRegex(m.QualificationError, 'NOT_FROZEN'): m.load()
            with self.assertRaisesRegex(m.QualificationError, 'NOT_FROZEN'): m.publish()
            docker.assert_not_called()

    def test_existing_publication_blocks_before_credentials_or_registry_work(self):
        path = self.root / m.PUBLICATION
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{}')
        with patch.object(m, 'ROOT', self.root), patch.object(m, 'load') as load, \
                patch.object(m, 'module') as module, patch.object(m, 'docker') as docker:
            with self.assertRaisesRegex(m.QualificationError, 'PUBLICATION_EXISTS'): m.publish()
            load.assert_not_called(); module.assert_not_called(); docker.assert_not_called()

    def test_both_native_receipts_required_and_sql_not_falsely_qualified(self):
        policy = {'path': m.POLL_MIGRATION, 'sha256': 'd' * 64}
        value = {**self.receipt, 'kind': 'proposal_latency_runtime', 'native': {'path': 'dispatch'}, 'build': {'path': 'build'},
            'prompt_native': {'path': 'prompt'}, 'poll_sql_qualified': False,
            'poll_migration': policy,
            'baseline': {'reference': m.BASELINE_REFERENCE, 'image_id': m.BASELINE_IMAGE,
                         'qualification_sha256': m.dispatch.RECEIPT_SHA256}}
        dispatch_native = {'checks': dict.fromkeys(m.DISPATCH_CHECKS, True)}
        def read(root, item):
            if item['path'] == 'dispatch': return dispatch_native
            if item['path'] == 'build': return {'poll_migration': policy}
            return self.native
        with patch.object(m.dispatch, 'validate_receipt'), patch.object(m.dispatch, 'read_bound', side_effect=read), \
                patch.object(m, 'poll_migration', return_value=policy), patch.object(m, 'validate_prompt_native') as prompt:
            self.assertEqual(m.validate_receipt(self.root, value), value)
            prompt.assert_called_once_with(self.native, value, self.root)
            with self.assertRaisesRegex(m.QualificationError, 'SQL_SCOPE'):
                m.validate_receipt(self.root, {**value, 'poll_sql_qualified': True})
            with self.assertRaisesRegex(m.QualificationError, 'CANDIDATE_UNCHANGED'):
                m.validate_receipt(self.root, {**value, 'image': {'Id': m.BASELINE_IMAGE}})
            with self.assertRaisesRegex(m.QualificationError, 'POLL_MIGRATION_CHANGED'):
                m.validate_receipt(self.root, {**value, 'poll_migration': {**policy, 'sha256': 'e' * 64}})
            with patch.object(m.dispatch, 'read_bound', side_effect=lambda root, item:
                    {'poll_migration': {**policy, 'sha256': 'e' * 64}} if item['path'] == 'build' else read(root, item)):
                with self.assertRaisesRegex(m.QualificationError, 'BUILD_POLL_BINDING'):
                    m.validate_receipt(self.root, value)
            dispatch_native['checks']['shutdown_drained'] = False
            with self.assertRaisesRegex(m.QualificationError, 'DISPATCH_NATIVE_CHECKS'):
                m.validate_receipt(self.root, value)

    def test_new_publication_cannot_reuse_another_source_or_qualification(self):
        path = self.root / m.PUBLICATION
        path.parent.mkdir(parents=True, exist_ok=True)
        receipt = {**self.receipt, 'source_revision': 'a' * 40}
        value = {'version': 1, 'reference': m.REGISTRY + '@sha256:' + 'b' * 64,
            'image_id': receipt['image']['Id'], 'qualification_sha256': 'c' * 64,
            'source_revision': receipt['source_revision'], 'scope': ['worker', 'scheduler']}
        with patch.object(m, 'load', return_value=receipt), patch.object(m, 'RECEIPT_SHA256', 'c' * 64):
            path.write_text(json.dumps(value))
            self.assertEqual(m.publication(self.root), (receipt, value['reference']))
            for key, wrong in [('source_revision', 'd' * 40), ('image_id', m.BASELINE_IMAGE),
                               ('qualification_sha256', m.dispatch.RECEIPT_SHA256), ('scope', ['api'])]:
                path.write_text(json.dumps({**value, key: wrong}))
                with self.subTest(key=key), self.assertRaises(m.QualificationError): m.publication(self.root)

    def test_build_rejects_dirty_source_before_any_docker_build(self):
        class Args: source_revision = 'a' * 40
        with patch.object(m.subprocess, 'check_output', side_effect=[Args.source_revision, Args.source_revision, b'dirty']), \
                patch.object(m.subprocess, 'run') as run, patch.object(m, 'image_metadata') as image:
            with self.assertRaisesRegex(m.QualificationError, 'BUILD_SOURCE_DIRTY'): m.build(Args())
            run.assert_not_called(); image.assert_not_called()

    def test_source_revision_must_remain_exact_and_clean(self):
        with patch.object(m.subprocess, 'check_output', side_effect=['a' * 40, b'', m.POLL_MIGRATION]):
            m.assert_source_revision('a' * 40)
        with patch.object(m.subprocess, 'check_output', return_value='b' * 40), \
                self.assertRaisesRegex(m.QualificationError, 'SOURCE_HEAD_CHANGED'):
            m.assert_source_revision('a' * 40)
        with patch.object(m.subprocess, 'check_output', side_effect=['a' * 40, b'concurrent edit']), \
                self.assertRaisesRegex(m.QualificationError, 'BUILD_SOURCE_DIRTY'):
            m.assert_source_revision('a' * 40)
        with patch.object(m.subprocess, 'check_output', side_effect=['a' * 40, b'', '']), \
                self.assertRaisesRegex(m.QualificationError, 'POLL_MIGRATION_UNTRACKED'):
            m.assert_source_revision('a' * 40)


if __name__ == '__main__': unittest.main()
