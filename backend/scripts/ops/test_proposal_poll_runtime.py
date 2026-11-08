import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('poll_runtime_tests', HERE / 'proposal-poll-runtime.py')
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)


class PollQualificationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        for name in m.POLL_HARNESSES:
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('synthetic harness')
        self.receipt = {'image': {'Id': 'sha256:' + '1' * 64}, 'source': {'source_entries': {
            'backend/supabase/functions/_shared/modelAcceptedPoll.ts': {'type': 'file', 'sha256': '2' * 64}}}}
        self.baseline = {'source': {'source_entries': {
            'backend/supabase/functions/_shared/model.ts': {'type': 'file', 'sha256': '3' * 64}}}}
        self.native = {'version': 1, 'kind': 'proposal_pending_poll_native', 'image_id': self.receipt['image']['Id'],
            'passed': True, 'actual_image_entrypoint': True, 'network': 'none', 'external_calls': 0, 'provider_calls': 0,
            'cleanup_verified': True, 'source_sha256': m.source_hashes(self.receipt['source']),
            'baseline_image_id': m.BASELINE_IMAGE, 'baseline_source_sha256': m.source_hashes(self.baseline['source']),
            'baseline_qualification_sha256': m.latency.RECEIPT_SHA256, 'generation_posts': 0, 'new_reservations': 0,
            'checks': dict.fromkeys(m.POLL_CHECKS, True),
            'revision6_prompt_sha256': dict.fromkeys(m.REVISION6_CASES, '4' * 64),
            'revision6_pins_sha256': dict.fromkeys(m.REVISION6_PINS, '5' * 64),
            'harness_sha256': {name: m.sha(self.root / name) for name in m.POLL_HARNESSES}}
        self.native['baseline'] = {key: self.native[key].copy() for key in ('revision6_prompt_sha256', 'revision6_pins_sha256')}

    def validate(self, value=None):
        with patch.object(m, 'historical', return_value=self.baseline):
            m.validate_poll_native(self.native if value is None else value, self.receipt, self.root)

    def test_actual_candidate_baseline_sources_and_offline_cleanup_are_bound(self):
        self.validate()
        for key, value in [('image_id', m.BASELINE_IMAGE), ('baseline_image_id', 'sha256:' + '0' * 64),
                           ('source_sha256', {}), ('baseline_source_sha256', {}), ('passed', False),
                           ('actual_image_entrypoint', False), ('network', 'bridge'), ('provider_calls', 1),
                           ('external_calls', 1), ('cleanup_verified', False), ('baseline_qualification_sha256', '0' * 64)]:
            with self.subTest(key=key), self.assertRaises(m.QualificationError): self.validate(self.native | {key: value})

    def test_every_pending_ready_and_compatibility_case_is_required(self):
        for check in m.POLL_CHECKS:
            value = copy.deepcopy(self.native); value['checks'][check] = False
            with self.subTest(check=check), self.assertRaisesRegex(m.QualificationError, 'CHECKS'): self.validate(value)
        for key in ('generation_posts', 'new_reservations'):
            with self.assertRaisesRegex(m.QualificationError, 'DUPLICATE_GENERATION'):
                self.validate(self.native | {key: 1})

    def test_all_28_revision6_wires_and_two_pins_must_match_actual_baseline(self):
        self.assertEqual(len(m.REVISION6_CASES), 28)
        for key in ('revision6_prompt_sha256', 'revision6_pins_sha256'):
            for kind in ('missing', 'renamed', 'changed', 'malformed', 'baseline'):
                value = copy.deepcopy(self.native); first = next(iter(value[key]))
                if kind == 'missing': value[key].pop(first)
                elif kind == 'renamed': value[key]['invented'] = value[key].pop(first)
                elif kind == 'changed': value[key][first] = '6' * 64
                elif kind == 'malformed': value[key][first] = 'invalid'
                else: value['baseline'][key][first] = '6' * 64
                with self.subTest(key=key, kind=kind), self.assertRaisesRegex(m.QualificationError, 'PHASE_IDENTITY'):
                    self.validate(value)

    def test_exact_harness_scope_and_bytes_are_bound(self):
        value = copy.deepcopy(self.native); value['harness_sha256']['unreviewed.ts'] = '7' * 64
        with self.assertRaisesRegex(m.QualificationError, 'HARNESS'): self.validate(value)
        (self.root / m.POLL_HARNESSES[0]).write_text('changed')
        with self.assertRaisesRegex(m.QualificationError, 'HARNESS_CHANGED'): self.validate()

    def test_historical_latency_and_dispatch_proofs_remain_immutable(self):
        value = m.historical(m.ROOT)
        self.assertEqual(value['image']['Id'], m.BASELINE_IMAGE)
        self.assertEqual(m.latency.RECEIPT_SHA256, '12e8e13ce4f1c3e05f0a4554036a7cc5ae7ac11ddd259d192cf510b4c150e19e')
        self.assertEqual(m.dispatch.RECEIPT_SHA256, 'd7a13be2d06e265206c5da8180e91e56f01c28e5a00e8b5f72313cf344930b91')
        self.assertNotIn(m.RECEIPT, (m.latency.RECEIPT, m.dispatch.RECEIPT))
        self.assertNotIn(m.PUBLICATION, (m.latency.PUBLICATION, m.dispatch.PUBLICATION))

    def test_unfrozen_and_existing_publication_stop_before_registry_access(self):
        with patch.object(m, 'ROOT', self.root), patch.object(m, 'docker') as docker:
            with self.assertRaisesRegex(m.QualificationError, 'NOT_FROZEN'): m.publish()
            docker.assert_not_called()
        path = self.root / m.PUBLICATION; path.parent.mkdir(parents=True); path.write_text('{}')
        with patch.object(m, 'ROOT', self.root), patch.object(m, 'load') as load:
            with self.assertRaisesRegex(m.QualificationError, 'PUBLICATION_EXISTS'): m.publish()
            load.assert_not_called()

    def test_source_guard_requires_new_sql_committed_unchanged(self):
        with patch.object(m.latency, 'assert_source_revision') as prior, patch.object(m.subprocess, 'check_output',
                side_effect=[b'', m.PENDING_POLL_MIGRATION]):
            m.assert_source_revision('a' * 40)
            prior.assert_called_once_with('a' * 40)
        for results, code in (([b'dirty'], 'DIRTY'), ([b'', ''], 'UNTRACKED')):
            with patch.object(m.latency, 'assert_source_revision'), patch.object(m.subprocess, 'check_output', side_effect=results):
                with self.assertRaisesRegex(m.QualificationError, code): m.assert_source_revision('a' * 40)

    def test_qualification_requires_three_native_receipts_and_both_sql_hashes(self):
        policies = {'poll_migration': {'path': 'old.sql', 'sha256': '1' * 64},
                    'pending_poll_migration': {'path': 'new.sql', 'sha256': '2' * 64}}
        value = self.receipt | {'kind': 'proposal_pending_poll_runtime', 'native': {'path': 'dispatch'},
            'prompt_native': {'path': 'prompt'}, 'poll_native': {'path': 'poll'}, 'build': {'path': 'build'},
            'poll_sql_qualified': False, **policies,
            'baseline': {'reference': m.BASELINE_REFERENCE, 'image_id': m.BASELINE_IMAGE,
                         'qualification_sha256': m.latency.RECEIPT_SHA256}}
        contents = {'dispatch': {'checks': dict.fromkeys(m.latency.DISPATCH_CHECKS, True)},
                    'prompt': {'kind': 'prompt'}, 'poll': self.native, 'build': dict(policies)}
        with patch.object(m.dispatch, 'validate_receipt'), patch.object(m.dispatch, 'read_bound',
                side_effect=lambda root, item: contents[item['path']]), patch.object(m, 'policy_migrations', return_value=policies), \
                patch.object(m.latency, 'validate_prompt_native') as prompt, patch.object(m, 'validate_poll_native') as poll:
            m.validate_receipt(self.root, value)
            prompt.assert_called_once_with(contents['prompt'], value, self.root)
            poll.assert_called_once_with(self.native, value, self.root)
            for key in policies:
                with self.assertRaisesRegex(m.QualificationError, 'SQL_BINDING'):
                    m.validate_receipt(self.root, value | {key: {'path': 'changed.sql', 'sha256': '3' * 64}})
            contents['build']['pending_poll_migration'] = {'path': 'other.sql', 'sha256': '4' * 64}
            with self.assertRaisesRegex(m.QualificationError, 'SQL_BINDING'): m.validate_receipt(self.root, value)
            with self.assertRaisesRegex(m.QualificationError, 'SQL_SCOPE'):
                m.validate_receipt(self.root, value | {'poll_sql_qualified': True})


if __name__ == '__main__': unittest.main()
