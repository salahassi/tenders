import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('legacy_review_native_test_target', HERE.parent / 'testing/legacy_review_native.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
CANDIDATE = 'sha256:' + 'd' * 64
CONTAINER_ID = 'e' * 64
SOURCES = {'backend/supabase/functions/_shared/model.ts': 'a' * 64}


def native(baseline=False):
    return {'version': 1, 'baseline': baseline, 'passed': True, 'provider_calls': 0,
            'source_sha256': SOURCES, 'fixture_input_sha256': 'a' * 64,
            'legacy_context_sha256': dict.fromkeys(m.LEGACY_CONTEXTS, 'b' * 64),
            'legacy_wire_sha256': dict.fromkeys(m.LEGACY_WIRES, 'b' * 64),
            'modern_wire_sha256': {} if baseline else dict.fromkeys(m.MODERN_WIRES, 'c' * 64),
            'rejected_scope_cases': {} if baseline else dict.fromkeys(m.SCOPE_REJECTIONS, 'INVALID_INPUT'),
            'review_source_sha256': None if baseline else 'd' * 64,
            'transition_review_count': 0 if baseline else 1,
            'checks': dict.fromkeys(m.BASELINE_CHECKS if baseline else m.PROBE_CHECKS, True)}


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

    def test_probe_requires_every_legacy_modern_wire_and_scope_rejection(self):
        m.validate_probe(native(), False, SOURCES)
        m.validate_probe(native(True), True, SOURCES)
        self.assertEqual(len(m.LEGACY_WIRES), 48)
        self.assertEqual(len(m.MODERN_WIRES), 12)
        for field in ('legacy_context_sha256', 'legacy_wire_sha256', 'modern_wire_sha256'):
            bad = native(); bad[field]['arbitrary'] = bad[field].pop(next(iter(bad[field])))
            with self.assertRaisesRegex(m.NativeError, 'WIRE_CASES_MISSING'): m.validate_probe(bad, False, SOURCES)
        for field in ('fixture_input_sha256', 'source_sha256', 'review_source_sha256'):
            bad = native(); bad[field] = 'invalid'
            with self.assertRaises(m.NativeError): m.validate_probe(bad, False, SOURCES)
        for change in ('missing', 'unknown', 'wrong_error'):
            bad = native()
            if change == 'missing': bad['rejected_scope_cases'].pop(next(iter(m.SCOPE_REJECTIONS)))
            elif change == 'unknown': bad['rejected_scope_cases']['not-a-case'] = 'INVALID_INPUT'
            else: bad['rejected_scope_cases'][next(iter(m.SCOPE_REJECTIONS))] = 'STALE_INPUT'
            with self.assertRaisesRegex(m.NativeError, 'SCOPE_CASES_MISSING'): m.validate_probe(bad, False, SOURCES)
        for value in (0, 2, True):
            bad = native(); bad['transition_review_count'] = value
            with self.assertRaisesRegex(m.NativeError, 'TRANSITION_COUNT'): m.validate_probe(bad, False, SOURCES)

    def test_baseline_normalizes_only_absent_optional_inspection_fields(self):
        historical = {'image': metadata(m.BASELINE_IMAGE)}
        historical['image']['Variant'] = ''
        historical['image']['Config']['Env'] = ['DENO_DIR=/deno-dir']
        inspected = copy.deepcopy(historical['image'])
        inspected.pop('Variant')
        inspected['Config'].update(OnBuild=None, Volumes=None)
        m.validate_metadata(inspected, m.BASELINE_IMAGE, historical)
        inspected['Variant'] = None
        m.validate_metadata(inspected, m.BASELINE_IMAGE, historical)
        for field, value in [('OnBuild', ['RUN false']), ('Volumes', {'/app': {}}),
                             ('Env', ['DENO_DIR=/tmp']), ('UnknownConfigField', None)]:
            changed = copy.deepcopy(inspected); changed['Config'][field] = value
            with self.assertRaisesRegex(m.NativeError, 'BASELINE_METADATA_CHANGED'):
                m.validate_metadata(changed, m.BASELINE_IMAGE, historical)
        for field, value in [('RootFS', {'Type': 'layers', 'Layers': ['changed']}), ('Variant', 'v8'),
                             ('Variant', False)]:
            changed = copy.deepcopy(inspected); changed[field] = value
            with self.assertRaisesRegex(m.NativeError, 'BASELINE_METADATA_CHANGED'):
                m.validate_metadata(changed, m.BASELINE_IMAGE, historical)

    def test_changed_source_policy_or_generation_blocks_native_evidence(self):
        for key, value in [('source_sha256', {}), ('baseline', True), ('provider_calls', 1),
                           ('passed', False)]:
            bad = native(); bad[key] = value
            with self.assertRaises(m.NativeError): m.validate_probe(bad, False, SOURCES)
        for check in m.PROBE_CHECKS:
            bad = native(); bad['checks'][check] = False
            with self.assertRaises(m.NativeError): m.validate_probe(bad, False, SOURCES)

    def test_legacy_bytes_and_only_modern_wire_identity_are_compared(self):
        before, after = native(True), native()
        m.compare_cases(after, before)
        after['fixture_input_sha256'] = 'd' * 64
        with self.assertRaisesRegex(m.NativeError, 'CASE_INPUT_CHANGED'): m.compare_cases(after, before)
        for field in ('legacy_context_sha256', 'legacy_wire_sha256'):
            after = native(); after[field][next(iter(after[field]))] = 'd' * 64
            with self.assertRaisesRegex(m.NativeError, 'LEGACY_BYTES_CHANGED'): m.compare_cases(after, before)
        after = native(); after['modern_wire_sha256'][next(iter(m.MODERN_WIRES))] = 'b' * 64
        with self.assertRaisesRegex(m.NativeError, 'MODERN_WIRE_NOT_BOUND'): m.compare_cases(after, before)

    def fake_docker(self, *, reject_probe=False, overlay=False, foreign=False, daemon_after_remove=False,
                    replaced_name=False):
        calls = []
        removed = False
        stopped = False
        name = None
        inspected_name = False
        def call(*args, **kwargs):
            nonlocal removed, stopped, name, inspected_name
            calls.append((args, kwargs))
            def result(value='', code=0, stderr=''): return SimpleNamespace(returncode=code, stdout=value if isinstance(value, str) else json.dumps(value), stderr=stderr)
            if args[:2] == ('image', 'inspect'): return result([metadata()])
            if args[0] == 'run':
                name = args[args.index('--name') + 1]
                return result(CONTAINER_ID, 1 if foreign else 0)
            if args[0] == 'exec' and '/bin/busybox' in args: return result({'status': 'ready', 'component': 'worker'})
            if args[0] == 'exec': return result(native(), 1 if reject_probe else 0)
            if args[0] == 'stop': stopped = True; return result(CONTAINER_ID)
            if args[0] == 'rm': removed = True; return result(CONTAINER_ID)
            if args[0] == 'inspect':
                if removed: return result('', 1, 'daemon disconnected' if daemon_after_remove else 'Error: No such object: ' + args[-1])
                if args[-1] == name:
                    if inspected_name and replaced_name:
                        raise AssertionError('mutable name used after ownership inspection')
                    inspected_name = True
                mounts = [{'Type': 'bind', 'Source': str(m.SCRIPT), 'Destination': '/native-fixture.ts', 'RW': False}]
                if overlay: mounts.append({'Type': 'bind', 'Source': '/checkout', 'Destination': '/app', 'RW': False})
                return result([{'Id': CONTAINER_ID, 'Name': '/' + name, 'Image': CANDIDATE, 'Config': {'Labels': {
                    'tenderdesk.io/legacy-review-native': 'foreign-nonce' if foreign else name}},
                                'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True}, 'Mounts': mounts,
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

    def test_ambiguous_run_never_removes_a_foreign_named_container(self):
        calls, docker = self.fake_docker(foreign=True)
        with patch.object(m, 'docker', side_effect=docker), self.assertRaisesRegex(m.NativeError, 'FOREIGN_CONTAINER'):
            m.probe(CANDIDATE, False, SOURCES, {'image': metadata(m.BASELINE_IMAGE)})
        self.assertFalse(any(args[0] == 'rm' for args, _ in calls))

    def test_daemon_failure_cannot_be_claimed_as_cleanup_confirmation(self):
        calls, docker = self.fake_docker(daemon_after_remove=True)
        with patch.object(m, 'docker', side_effect=docker), self.assertRaisesRegex(m.NativeError, 'CLEANUP_UNCONFIRMED'):
            m.probe(CANDIDATE, False, SOURCES, {'image': metadata(m.BASELINE_IMAGE)})
        self.assertTrue(any(args[0] == 'rm' for args, _ in calls))

    def test_owned_full_id_is_used_after_name_can_be_replaced(self):
        calls, docker = self.fake_docker(replaced_name=True)
        with patch.object(m, 'docker', side_effect=docker):
            m.probe(CANDIDATE, False, SOURCES, {'image': metadata(m.BASELINE_IMAGE)})
        for args, _ in calls:
            if args[0] in ('exec', 'stop', 'rm'):
                self.assertIn(CONTAINER_ID, args)
        self.assertEqual(next(args for args, _ in calls if args[0] == 'rm'), ('rm', '-f', CONTAINER_ID))

    def test_absence_requires_exact_identifier_and_no_other_error(self):
        prefix = 'Error: No such object: ' + CONTAINER_ID
        self.assertTrue(m.absent(SimpleNamespace(returncode=1, stderr=prefix + '\n'), CONTAINER_ID))
        for stderr in (prefix + '-other', prefix + '\nError: daemon disconnected',
                       'daemon disconnected\n' + prefix, 'Error: No such object: unrelated'):
            self.assertFalse(m.absent(SimpleNamespace(returncode=1, stderr=stderr), CONTAINER_ID))

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
        self.assertEqual(receipt['kind'], 'proposal_legacy_review_native')
        self.assertEqual(receipt['baseline_image_id'], m.BASELINE_IMAGE)
        self.assertEqual(receipt['baseline_source_sha256'], SOURCES)
        self.assertEqual(receipt['baseline_qualification_sha256'], m.BASELINE_SHA256)
        self.assertEqual(set(receipt['legacy_wire_sha256']), m.LEGACY_WIRES)
        self.assertEqual(receipt['legacy_context_sha256'], receipt['baseline']['legacy_context_sha256'])
        self.assertEqual(receipt['fixture_input_sha256'], receipt['baseline']['fixture_input_sha256'])
        self.assertEqual(receipt['transition_review_count'], 1)
        self.assertEqual(receipt['baseline']['transition_review_count'], 0)
        self.assertTrue(all(receipt['checks'][name] for name in m.CHECKS))
        self.assertEqual(set(receipt['harness_sha256']), set(m.HARNESSES))

    def test_baseline_cannot_be_qualified_as_candidate(self):
        with self.assertRaisesRegex(m.NativeError, 'CANDIDATE_IS_BASELINE'): m.run(m.BASELINE_IMAGE)


if __name__ == '__main__':
    unittest.main()
