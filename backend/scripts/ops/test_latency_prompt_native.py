import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('latency_prompt_native_test_target', HERE.parent / 'testing/latency_prompt_native.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
CANDIDATE = 'sha256:' + 'd' * 64
SOURCES = {'backend/supabase/functions/_shared/model.ts': 'a' * 64}


def native(baseline=False):
    return {'version': 1, 'baseline': baseline, 'passed': True, 'provider_calls': 0,
            'source_sha256': SOURCES, 'legacy_prompt_sha256': dict.fromkeys(m.LEGACY_CASES, 'b' * 64),
            'legacy_prompt_count': 84, 'legacy_pins_sha256': 'c' * 64, 'legacy_pin_count': 11,
            'compact_saved_characters': 0 if baseline else 1200,
            'checks': dict.fromkeys(m.PROBE_CHECKS, True)}


def metadata(image=CANDIDATE):
    return {'Id': image, 'Os': 'linux', 'Architecture': 'amd64', 'RootFS': {'Type': 'layers', 'Layers': ['a']},
            'Config': {'Entrypoint': ['/tini', '--', 'docker-entrypoint.sh'], 'Cmd': ['run', 'scripts/runtime/main.ts'],
                       'User': 'deno', 'WorkingDir': '/app/backend'}}


class NativeGuards(unittest.TestCase):
    def test_original_worker_entrypoint_and_baseline_metadata_are_mandatory(self):
        historical = {'image': metadata(m.BASELINE_IMAGE)}
        m.validate_metadata(metadata(), CANDIDATE, historical)
        m.validate_metadata(historical['image'], m.BASELINE_IMAGE, historical)
        for field, value in [('Id', m.BASELINE_IMAGE), ('Os', 'windows'), ('Architecture', 'arm64')]:
            changed = metadata(); changed[field] = value
            with self.assertRaises(m.NativeError): m.validate_metadata(changed, CANDIDATE, historical)
        for field, value in [('Entrypoint', ['sh']), ('Cmd', ['eval', '0']), ('User', 'root'), ('WorkingDir', '/')]:
            changed = metadata(); changed['Config'][field] = value
            with self.assertRaises(m.NativeError): m.validate_metadata(changed, CANDIDATE, historical)

    def test_probe_requires_all_named_legacy_cases_not_just_the_count(self):
        m.validate_probe(native(), False, SOURCES)
        bad = native(); bad['legacy_prompt_sha256']['arbitrary'] = bad['legacy_prompt_sha256'].pop(next(iter(m.LEGACY_CASES)))
        with self.assertRaisesRegex(m.NativeError, 'LEGACY_CASES'): m.validate_probe(bad, False, SOURCES)
        for key, value in [('legacy_prompt_count', 1), ('legacy_pin_count', 10), ('legacy_pins_sha256', 'bad')]:
            bad = native(); bad[key] = value
            with self.assertRaises(m.NativeError): m.validate_probe(bad, False, SOURCES)

    def test_changed_source_policy_or_zero_reduction_blocks_native_evidence(self):
        for key, value in [('source_sha256', {}), ('baseline', True), ('provider_calls', 1),
                           ('compact_saved_characters', 0), ('passed', False)]:
            bad = native(); bad[key] = value
            with self.assertRaises(m.NativeError): m.validate_probe(bad, False, SOURCES)
        for check in m.PROBE_CHECKS:
            bad = native(); bad['checks'][check] = False
            with self.assertRaises(m.NativeError): m.validate_probe(bad, False, SOURCES)

    def test_legacy_bytes_and_pins_are_compared_to_separately_executed_baseline(self):
        before, after = native(True), native()
        m.compare_legacy(after, before)
        after['legacy_prompt_sha256'][next(iter(m.LEGACY_CASES))] = 'd' * 64
        with self.assertRaisesRegex(m.NativeError, 'LEGACY_PROMPT_CHANGED'): m.compare_legacy(after, before)
        after = native(); after['legacy_pins_sha256'] = 'd' * 64
        with self.assertRaisesRegex(m.NativeError, 'LEGACY_PINS_CHANGED'): m.compare_legacy(after, before)

    def fake_docker(self, *, reject_probe=False, overlay=False):
        calls = []
        removed = False
        stopped = False
        def call(*args, **kwargs):
            nonlocal removed, stopped
            calls.append((args, kwargs))
            def result(value='', code=0): return SimpleNamespace(returncode=code, stdout=value if isinstance(value, str) else json.dumps(value))
            if args[:2] == ('image', 'inspect'): return result([metadata()])
            if args[0] == 'run': return result('container-id')
            if args[0] == 'exec' and '/bin/busybox' in args: return result({'status': 'ready', 'component': 'worker'})
            if args[0] == 'exec': return result(native(), 1 if reject_probe else 0)
            if args[0] == 'stop': stopped = True; return result('container-id')
            if args[0] == 'rm': removed = True; return result('container-id')
            if args[0] == 'inspect':
                if removed: return result('', 1)
                mounts = [{'Type': 'bind', 'Source': str(m.SCRIPT), 'Destination': '/native-fixture.ts', 'RW': False}]
                if overlay: mounts.append({'Type': 'bind', 'Source': '/checkout', 'Destination': '/app', 'RW': False})
                return result([{'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True}, 'Mounts': mounts,
                                'State': {'Running': not stopped, 'ExitCode': 0, 'OOMKilled': False}}])
            raise AssertionError(args)
        return calls, call

    def test_probe_starts_default_image_with_only_harness_mount_and_no_probe_network(self):
        calls, docker = self.fake_docker()
        with patch.object(m, 'docker', side_effect=docker):
            value = m.probe(CANDIDATE, False, SOURCES, {'image': metadata(m.BASELINE_IMAGE)})
        run = next(args for args, _ in calls if args[0] == 'run')
        self.assertEqual(run[-1], CANDIDATE)
        self.assertNotIn('--entrypoint', run)
        self.assertIn('--read-only', run)
        self.assertEqual(run[run.index('--network') + 1], 'none')
        command = next(args for args, _ in calls if args[0] == 'exec' and '/bin/deno' in args)
        self.assertNotIn('--allow-net', command)
        self.assertIn('--cached-only', command)
        self.assertIn('--frozen', command)
        self.assertTrue(value['checks']['shutdown_drained'])
        self.assertTrue(any(args[0] == 'rm' for args, _ in calls))

    def test_failed_probe_and_product_overlay_always_remove_owned_container(self):
        for kwargs in ({'reject_probe': True}, {'overlay': True}):
            calls, docker = self.fake_docker(**kwargs)
            with patch.object(m, 'docker', side_effect=docker), self.assertRaises(m.NativeError):
                m.probe(CANDIDATE, False, SOURCES, {'image': metadata(m.BASELINE_IMAGE)})
            self.assertTrue(any(args[0] == 'rm' for args, _ in calls))

    def test_receipt_binds_both_image_sources_harnesses_and_full_scope(self):
        historical = {'image': metadata(m.BASELINE_IMAGE), 'source': {'source_entries': {
            name: {'type': 'file', 'sha256': value} for name, value in SOURCES.items()}}}
        calls = []
        def probe(image, baseline, sources, receipt):
            calls.append((image, baseline))
            value = native(baseline); value['checks'].update(default_worker_startup=True, shutdown_drained=True)
            return value
        with patch.object(m, 'baseline_receipt', return_value=historical), patch.object(m, 'copied_sources', return_value=SOURCES), \
                patch.object(m, 'digest', return_value='f' * 64), patch.object(m, 'probe', side_effect=probe):
            receipt = m.run(CANDIDATE)
        self.assertEqual(calls, [(m.BASELINE_IMAGE, True), (CANDIDATE, False)])
        self.assertEqual(receipt['kind'], 'proposal_latency_prompt_native')
        self.assertEqual(receipt['baseline_image_id'], m.BASELINE_IMAGE)
        self.assertEqual(receipt['baseline_source_sha256'], SOURCES)
        self.assertEqual(receipt['baseline_qualification_sha256'], m.BASELINE_SHA256)
        self.assertEqual(receipt['semantic_revisions'], list(range(6)))
        self.assertEqual(receipt['verification_revisions'], list(range(1, 6)))
        self.assertEqual(receipt['legacy_case_count'], 84)
        self.assertTrue(all(receipt['checks'][name] for name in m.CHECKS))
        self.assertEqual(set(receipt['harness_sha256']), set(m.HARNESSES))

    def test_baseline_cannot_be_qualified_as_candidate(self):
        with self.assertRaisesRegex(m.NativeError, 'CANDIDATE_IS_BASELINE'): m.run(m.BASELINE_IMAGE)


if __name__ == '__main__':
    unittest.main()
