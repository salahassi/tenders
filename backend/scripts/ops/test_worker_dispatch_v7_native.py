import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('dispatch_v7_native_test_target',
    HERE.parent / 'testing/worker_dispatch_v7_native.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
CANDIDATE = 'sha256:' + 'd' * 64
CONTAINER_ID = 'e' * 64
SOURCES = {'backend/supabase/functions/worker/handler.ts': 'a' * 64}


def native():
    return {'version': 1, 'passed': True, 'provider_calls': 0, 'source_sha256': SOURCES,
        'checks': dict.fromkeys(m.CHECKS, True), 'rpc_names': sorted(m.RPC_NAMES),
        'worker_rpc_names': list(m.WORKER_RPCS), 'rpc_count': 40, 'unexpected_rpc_count': 0,
        'scheduler_image_cmd': list(m.IMAGE_CMD)}


def metadata():
    return {'Id': CANDIDATE, 'Os': 'linux', 'Architecture': 'amd64',
        'Config': {'Entrypoint': ['/tini', '--', 'docker-entrypoint.sh'], 'Cmd': list(m.IMAGE_CMD),
                   'User': 'deno', 'WorkingDir': '/app/backend'}}


class DispatchV6NativeTests(unittest.TestCase):
    def test_mutable_or_incomplete_image_references_fail_before_docker_access(self):
        with patch.object(m, 'docker') as docker:
            for image in ('runtime:latest', 'sha256:short', 'registry/runtime@sha256:' + 'd' * 64):
                with self.assertRaisesRegex(m.NativeError, 'IMAGE_REFERENCE'):
                    m.probe(image, SOURCES)
            docker.assert_not_called()

    def test_requires_exact_original_worker_and_scheduler_command(self):
        m.validate_metadata(metadata(), CANDIDATE)
        for field, value in [('Id', 'sha256:' + 'f' * 64), ('Os', 'windows'),
                             ('Architecture', 'arm64'), ('Variant', 'v8')]:
            changed = metadata(); changed[field] = value
            with self.assertRaisesRegex(m.NativeError, 'IMAGE_IDENTITY'):
                m.validate_metadata(changed, CANDIDATE)
        for field, value in [('Entrypoint', ['sh']), ('Cmd', ['run', 'scripts/runtime/main.ts']),
                             ('Cmd', m.IMAGE_CMD[:-1] + ['altered.ts']), ('User', 'root'), ('WorkingDir', '/')]:
            changed = metadata(); changed['Config'][field] = value
            with self.assertRaisesRegex(m.NativeError, 'ORIGINAL_ENTRYPOINT'):
                m.validate_metadata(changed, CANDIDATE)
        bad = native(); bad['scheduler_image_cmd'] = ['run', 'scripts/runtime/main.ts']
        with self.assertRaisesRegex(m.NativeError, 'SCHEDULER_CMD_CHANGED'):
            m.validate_probe(bad, SOURCES)

    def test_requires_all_ten_controls_and_exact_source(self):
        m.validate_probe(native(), SOURCES)
        self.assertEqual(len(m.CHECKS), 10)
        for check in m.CHECKS:
            bad = native(); bad['checks'][check] = False
            with self.assertRaisesRegex(m.NativeError, 'PROBE_CHECK_MISSING'):
                m.validate_probe(bad, SOURCES)
        for field, value in [('source_sha256', {}), ('passed', False), ('provider_calls', 1),
                             ('provider_calls', False), ('unexpected_rpc_count', 1), ('rpc_count', 0)]:
            bad = native(); bad[field] = value
            with self.assertRaises(m.NativeError): m.validate_probe(bad, SOURCES)

    def test_missing_v7_call_is_rejected_even_if_check_claims_success(self):
        for name in m.WORKER_RPCS:
            bad = native(); bad['rpc_names'].remove(name)
            with self.assertRaisesRegex(m.NativeError, 'EXECUTOR7_RPC_PATHS'):
                m.validate_probe(bad, SOURCES)
            bad = native(); bad['worker_rpc_names'].remove(name)
            with self.assertRaisesRegex(m.NativeError, 'EXECUTOR7_RPC_PATHS'):
                m.validate_probe(bad, SOURCES)

    def test_v5_generic_and_unknown_paths_are_rejected_even_alongside_all_v7_calls(self):
        for name in ('claim_backend_job_v5', 'claim_backend_local_job_v5', 'wake_backend_queue_status_v5',
                     'claim_backend_job', 'claim_backend_local_job', 'wake_backend_queue',
                     'wake_backend_queue_revision_v7', 'arbitrary_rpc'):
            bad = native(); bad['rpc_names'] = sorted(bad['rpc_names'] + [name])
            with self.assertRaisesRegex(m.NativeError, 'EXECUTOR7_RPC_PATHS'):
                m.validate_probe(bad, SOURCES)
        bad = native(); bad['worker_rpc_names'] = ['claim_backend_job_v5']
        with self.assertRaisesRegex(m.NativeError, 'EXECUTOR7_RPC_PATHS'):
            m.validate_probe(bad, SOURCES)

    def fake_docker(self, *, reject_probe=False, overlay=False, foreign=False, daemon_after_remove=False,
                    replaced_name=False, undrained=False, legacy_receipt=False):
        calls = []
        removed = stopped = inspected_name = False
        name = None
        def call(*args, **kwargs):
            nonlocal removed, stopped, inspected_name, name
            calls.append((args, kwargs))
            def result(value='', code=0, stderr=''):
                return SimpleNamespace(returncode=code,
                    stdout=value if isinstance(value, str) else json.dumps(value), stderr=stderr)
            if args[:2] == ('image', 'inspect'): return result([metadata()])
            if args[0] == 'run':
                name = args[args.index('--name') + 1]
                return result(CONTAINER_ID, 1 if foreign else 0)
            if args[0] == 'exec' and '/bin/busybox' in args:
                return result({'status': 'ready', 'component': 'worker'})
            if args[0] == 'exec':
                value = native()
                if legacy_receipt:
                    value['rpc_names'] = sorted(value['rpc_names'] + ['claim_backend_job_v5'])
                return result(value, 1 if reject_probe else 0)
            if args[0] == 'stop': stopped = True; return result(CONTAINER_ID)
            if args[0] == 'rm': removed = True; return result(CONTAINER_ID)
            if args[0] == 'inspect':
                if removed:
                    return result('', 1, 'daemon disconnected' if daemon_after_remove else 'Error: No such object: ' + args[-1])
                if args[-1] == name:
                    if inspected_name and replaced_name:
                        raise AssertionError('Mutable name used after ownership inspection')
                    inspected_name = True
                mounts = [{'Type': 'bind', 'Source': str(m.SCRIPT), 'Destination': '/native-fixture.ts', 'RW': False}]
                if overlay:
                    mounts.append({'Type': 'bind', 'Source': '/checkout', 'Destination': '/app', 'RW': False})
                return result([{'Id': CONTAINER_ID, 'Name': '/' + name, 'Image': CANDIDATE,
                    'Config': {'Labels': {'tenderdesk.io/dispatch-v7-native': 'foreign-nonce' if foreign else name}},
                    'HostConfig': {'NetworkMode': 'none', 'ReadonlyRootfs': True}, 'Mounts': mounts,
                    'State': {'Running': not stopped, 'ExitCode': 137 if undrained else 0, 'OOMKilled': undrained}}])
            raise AssertionError(args)
        return calls, call

    def test_real_entrypoint_one_harness_loopback_only_and_exact_scheduler_cmd(self):
        calls, docker = self.fake_docker()
        with patch.object(m, 'docker', side_effect=docker): value = m.probe(CANDIDATE, SOURCES)
        run = next(args for args, _ in calls if args[0] == 'run')
        self.assertEqual(run[-1], CANDIDATE)
        self.assertNotIn('--entrypoint', run)
        self.assertIn('--read-only', run)
        self.assertEqual(run[run.index('--network') + 1], 'none')
        self.assertEqual(run.count('--mount'), 1)
        command = next(args for args, _ in calls if args[0] == 'exec' and '/bin/deno' in args)
        self.assertNotIn('--allow-net', command)
        self.assertIn('--allow-net=127.0.0.1:8080,127.0.0.1:8081', command)
        self.assertIn('--cached-only', command)
        self.assertIn('--frozen', command)
        self.assertEqual(json.loads(next(arg.split('=', 1)[1] for arg in command if arg.startswith('NATIVE_IMAGE_CMD='))), m.IMAGE_CMD)
        self.assertEqual(value['image_cmd'], m.IMAGE_CMD)
        self.assertTrue(any(args == ('rm', '-f', CONTAINER_ID) for args, _ in calls))

    def test_rejected_probe_overlay_legacy_receipt_or_shutdown_still_remove_owned_container(self):
        for kwargs in ({'reject_probe': True}, {'overlay': True}, {'legacy_receipt': True}, {'undrained': True}):
            calls, docker = self.fake_docker(**kwargs)
            with patch.object(m, 'docker', side_effect=docker), self.assertRaises(m.NativeError):
                m.probe(CANDIDATE, SOURCES)
            self.assertTrue(any(args == ('rm', '-f', CONTAINER_ID) for args, _ in calls))

    def test_foreign_name_is_never_removed_after_ambiguous_run(self):
        calls, docker = self.fake_docker(foreign=True)
        with patch.object(m, 'docker', side_effect=docker), self.assertRaisesRegex(m.NativeError, 'FOREIGN_CONTAINER'):
            m.probe(CANDIDATE, SOURCES)
        self.assertFalse(any(args[0] == 'rm' for args, _ in calls))

    def test_owned_full_id_is_used_when_name_can_be_replaced(self):
        calls, docker = self.fake_docker(replaced_name=True)
        with patch.object(m, 'docker', side_effect=docker): m.probe(CANDIDATE, SOURCES)
        for args, _ in calls:
            if args[0] in ('exec', 'stop', 'rm'): self.assertIn(CONTAINER_ID, args)

    def test_daemon_failure_or_inexact_error_cannot_prove_cleanup(self):
        calls, docker = self.fake_docker(daemon_after_remove=True)
        with patch.object(m, 'docker', side_effect=docker), self.assertRaisesRegex(m.NativeError, 'CLEANUP_UNCONFIRMED'):
            m.probe(CANDIDATE, SOURCES)
        prefix = 'Error: No such object: ' + CONTAINER_ID
        self.assertTrue(m.absent(SimpleNamespace(returncode=1, stderr=prefix + '\n'), CONTAINER_ID))
        for error in (prefix + '-other', prefix + '\nError: daemon disconnected',
                      'daemon disconnected\n' + prefix, 'Error: No such object: unrelated'):
            self.assertFalse(m.absent(SimpleNamespace(returncode=1, stderr=error), CONTAINER_ID))

    def test_receipt_binds_exact_source_harness_image_and_cleanup(self):
        with patch.object(m, 'copied_sources', return_value=SOURCES), patch.object(m, 'digest', return_value='f' * 64), \
                patch.object(m, 'probe', return_value=native()) as probe:
            receipt = m.run(CANDIDATE)
        probe.assert_called_once_with(CANDIDATE, SOURCES)
        self.assertEqual(receipt['kind'], 'proposal_dispatch_v7_native')
        self.assertEqual(receipt['image_id'], CANDIDATE)
        self.assertEqual(set(receipt['harness_sha256']), set(m.HARNESSES))
        self.assertEqual(receipt['source_sha256'], SOURCES)
        self.assertEqual(receipt['network'], 'none')
        self.assertTrue(receipt['actual_image_entrypoint'])
        self.assertTrue(receipt['cleanup_verified'])
        self.assertEqual(receipt['external_calls'], 0)
        self.assertEqual(receipt['provider_calls'], 0)
        self.assertFalse(receipt['hosted_acceptance'])

    def test_source_or_harness_drift_during_execution_is_rejected(self):
        with patch.object(m, 'copied_sources', side_effect=[SOURCES, {}]), patch.object(m, 'digest', return_value='f' * 64), \
                patch.object(m, 'probe', return_value=native()), self.assertRaisesRegex(m.NativeError, 'SOURCE_CHANGED_DURING_PROBE'):
            m.run(CANDIDATE)
        with patch.object(m, 'copied_sources', return_value=SOURCES), \
                patch.object(m, 'digest', side_effect=['f' * 64, 'f' * 64, 'e' * 64, 'f' * 64]), \
                patch.object(m, 'probe', return_value=native()), self.assertRaisesRegex(m.NativeError, 'SOURCE_CHANGED_DURING_PROBE'):
            m.run(CANDIDATE)


if __name__ == '__main__':
    unittest.main()
