import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('boundary_native_test_target', HERE.parent / 'testing/boundary_native.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
CANDIDATE = 'sha256:' + 'd' * 64
CONTAINER_ID = 'e' * 64
SOURCES = {'backend/supabase/functions/_shared/model.ts': 'a' * 64}


def native(baseline=False):
    return {'version': 1, 'baseline': baseline, 'passed': True, 'provider_calls': 0,
            'source_sha256': SOURCES, 'case_results': {name: m.expected_case(name, baseline) for name in m.CASES},
            'case_input_sha256': dict.fromkeys(m.CASES, 'b' * 64),
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

    def test_probe_requires_exact_cases_input_hashes_and_expected_outcomes(self):
        m.validate_probe(native(), False, SOURCES)
        m.validate_probe(native(True), True, SOURCES)
        self.assertEqual(len(m.CASES), 44)
        self.assertEqual(len(m.COLON_CASES), 24)
        for field in ('case_results', 'case_input_sha256'):
            bad = native(); bad[field]['arbitrary'] = bad[field].pop(next(iter(m.CASES)))
            with self.assertRaisesRegex(m.NativeError, 'CASES_MISSING'): m.validate_probe(bad, False, SOURCES)
        bad = native(); bad['case_input_sha256'][next(iter(m.CASES))] = 'bad'
        with self.assertRaisesRegex(m.NativeError, 'CASES_MISSING'): m.validate_probe(bad, False, SOURCES)
        for name in m.CASES:
            bad = native(); bad['case_results'][name]['accepted'] = not bad['case_results'][name]['accepted']
            with self.assertRaisesRegex(m.NativeError, 'CASE_OUTCOME_CHANGED'): m.validate_probe(bad, False, SOURCES)
        bad = native(); bad['case_results']['unknown_uuid']['diagnostic_reasons'] = ['candidate_quote_mismatch']
        with self.assertRaisesRegex(m.NativeError, 'CASE_OUTCOME_CHANGED'): m.validate_probe(bad, False, SOURCES)

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

    def test_both_images_use_identical_inputs_and_only_the_intended_outcomes_change(self):
        before, after = native(True), native()
        m.compare_cases(after, before)
        after['case_input_sha256']['unknown_uuid'] = 'd' * 64
        with self.assertRaisesRegex(m.NativeError, 'CASE_INPUT_CHANGED'): m.compare_cases(after, before)
        after = native(); after['case_results']['unknown_uuid'] = m.expected_case('plain_parentheses', False)
        with self.assertRaisesRegex(m.NativeError, 'RETAINED_BEHAVIOR_CHANGED'): m.compare_cases(after, before)
        for name in m.COLON_CASES:
            changed = native(True); changed['case_results'][name] = m.expected_case(name, False)
            with self.assertRaisesRegex(m.NativeError, 'BASELINE_REGRESSION_MISSING'): m.compare_cases(native(), changed)

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
                    'tenderdesk.io/reference-boundary-native': 'foreign-nonce' if foreign else name}},
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
        self.assertEqual(receipt['kind'], 'proposal_reference_boundary_native')
        self.assertEqual(receipt['baseline_image_id'], m.BASELINE_IMAGE)
        self.assertEqual(receipt['baseline_source_sha256'], SOURCES)
        self.assertEqual(receipt['baseline_qualification_sha256'], m.BASELINE_SHA256)
        self.assertEqual(set(receipt['case_results']), m.CASES)
        self.assertEqual(receipt['case_input_sha256'], receipt['baseline']['case_input_sha256'])
        self.assertEqual(receipt['baseline']['case_results'], native(True)['case_results'])
        self.assertTrue(all(receipt['checks'][name] for name in m.CHECKS))
        self.assertEqual(set(receipt['harness_sha256']), set(m.HARNESSES))

    def test_baseline_cannot_be_qualified_as_candidate(self):
        with self.assertRaisesRegex(m.NativeError, 'CANDIDATE_IS_BASELINE'): m.run(m.BASELINE_IMAGE)


if __name__ == '__main__':
    unittest.main()
