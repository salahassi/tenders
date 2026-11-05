"""Pure stdlib/mocked checks. These tests never start Docker or native OCR."""
import copy
import hashlib
import json
import shutil
from pathlib import Path
import subprocess
import tempfile
import time
import re
import unicodedata
import sys
import signal
import unittest
from unittest.mock import patch

import run_campaign as campaign
import evaluate_campaign as evaluation


class CampaignGuards(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        source = self.root / 'source.pdf'
        source.write_bytes(b'%PDF-synthetic-bytes-for-validation-only')
        base = {'path': 'source.pdf', 'sha256': campaign.sha(source),
                'page': 1, 'total_pages': 1, 'language': 'auto'}
        self.manifest = {'version': 1, 'scope': 'source_only_mapping_no_expected_text',
                         'prospective_gold_sha256': 'a' * 64,
                         'cases': [{**base, 'id': name} for name in campaign.ORDER]}
        self.manifest['cold_blank'] = {**self.manifest['cases'][5], 'id': 'separate-cold-blank'}

    def test_exact_sources_and_all_thirteen_order(self):
        campaign.validate_sources(self.manifest, self.root)
        self.manifest['cases'][0], self.manifest['cases'][1] = self.manifest['cases'][1], self.manifest['cases'][0]
        with self.assertRaises(ValueError):
            campaign.validate_sources(self.manifest, self.root)

    def test_expected_text_cannot_enter_request(self):
        self.manifest['cases'][0]['expected_text'] = 'oracle leak'
        with self.assertRaises(ValueError):
            campaign.validate_sources(self.manifest, self.root)

    def test_hash_drift_and_path_escape_fail(self):
        changed = copy.deepcopy(self.manifest)
        changed['cases'][0]['sha256'] = '0' * 64
        with self.assertRaises(ValueError):
            campaign.validate_sources(changed, self.root)
        changed = copy.deepcopy(self.manifest)
        changed['cases'][0]['path'] = '../source.pdf'
        with self.assertRaises(ValueError):
            campaign.validate_sources(changed, self.root)

    def test_blank_is_a_separate_unchanged_source(self):
        self.manifest['cold_blank']['page'] = 2
        with self.assertRaises(ValueError):
            campaign.validate_sources(self.manifest, self.root)

    def test_actual_resource_controls_are_exact(self):
        campaign.validate_controls(campaign.EXPECTED)
        for key in campaign.EXPECTED:
            with self.subTest(key=key), self.assertRaises(ValueError):
                campaign.validate_controls({**campaign.EXPECTED, key: 'max'})

    def cgroup_fixture(self, proc_path=None):
        identity, image, owner, pid = 'c' * 64, 'sha256:' + 'd' * 64, 'test-owner', 2468
        cgroups, proc = self.root / 'cgroups', self.root / 'proc'
        target = cgroups / 'docker' / identity
        target.mkdir(parents=True)
        (target / 'cgroup.procs').write_text(str(pid) + '\n')
        (proc / str(pid)).mkdir(parents=True)
        (proc / str(pid) / 'cgroup').write_text('0::' + (proc_path or '/docker/' + identity) + '\n')
        info = {'Id': identity, 'Image': image, 'State': {'Running': True, 'Pid': pid},
                'Config': {'Labels': {'a06.campaign.owner': owner}}}
        return info, image, owner, cgroups, proc, target

    def test_namespace_relative_and_absolute_paths_use_exact_docker_id(self):
        info, image, owner, cgroups, proc, expected = self.cgroup_fixture()
        for observed in ['../docker/', '/../docker/', '/../../docker/', '/docker/']:
            with self.subTest(namespace_path=observed):
                raw = '0::' + observed + info['Id'] + '\n'
                (proc / str(info['State']['Pid']) / 'cgroup').write_text(raw)
                evidence = {}
                actual, receipt = campaign.resolve_container_cgroup(info, image, owner, cgroups, proc, evidence)
                self.assertEqual(actual, expected)
                self.assertEqual(receipt['observed_proc_cgroup'], raw)
                self.assertIs(receipt, evidence)
                self.assertFalse(receipt['observed_proc_path_used_for_filesystem_resolution'])
                self.assertTrue(receipt['host_pid_membership_verified_before_node'])

    def test_proc_id_mismatch_and_unsupported_layouts_preserve_diagnostic(self):
        info, image, owner, cgroups, proc, _ = self.cgroup_fixture()
        for observed in ['/docker/' + 'a' * 64, '/system.slice/docker-' + info['Id'] + '.scope',
                         '/', '/../docker/' + info['Id'] + '/../foreign', '/docker/' + info['Id'] + '\n0::/']:
            with self.subTest(namespace_path=observed):
                raw = '0::' + observed + '\n'
                (proc / str(info['State']['Pid']) / 'cgroup').write_text(raw)
                diagnostic = {}
                with self.assertRaises(ValueError):
                    campaign.resolve_container_cgroup(info, image, owner, cgroups, proc, diagnostic)
                self.assertEqual(diagnostic['observed_proc_cgroup'], raw)
                self.assertFalse(diagnostic['host_pid_membership_verified_before_node'])

    def test_cgroup_membership_missing_foreign_or_malformed_fails(self):
        info, image, owner, cgroups, proc, target = self.cgroup_fixture()
        for members in ['', '9876\n', '2468\nnot-a-pid\n']:
            with self.subTest(members=members):
                (target / 'cgroup.procs').write_text(members)
                with self.assertRaises(ValueError):
                    campaign.resolve_container_cgroup(info, image, owner, cgroups, proc)
        (target / 'cgroup.procs').unlink()
        with self.assertRaises(FileNotFoundError):
            campaign.resolve_container_cgroup(info, image, owner, cgroups, proc)

    def test_cgroup_identity_image_owner_and_liveness_fail_closed(self):
        info, image, owner, cgroups, proc, _ = self.cgroup_fixture()
        invalid = [dict(info, Id='short'), dict(info, Id='../' + info['Id']), dict(info, Image='sha256:' + 'e' * 64),
                   dict(info, Config={'Labels': {'a06.campaign.owner': 'foreign'}}),
                   dict(info, State={'Running': False, 'Pid': 2468}), dict(info, State={'Running': True, 'Pid': True})]
        for changed in invalid:
            with self.subTest(info=changed), self.assertRaises(ValueError):
                campaign.resolve_container_cgroup(changed, image, owner, cgroups, proc)

    def test_cgroup_symlink_redirection_is_rejected(self):
        info, image, owner, cgroups, proc, target = self.cgroup_fixture()
        (target / 'cgroup.procs').unlink()
        target.rmdir()
        foreign = self.root / 'foreign'
        foreign.mkdir()
        (foreign / 'cgroup.procs').write_text('2468\n')
        target.symlink_to(foreign, target_is_directory=True)
        with self.assertRaises(ValueError):
            campaign.resolve_container_cgroup(info, image, owner, cgroups, proc)

    def test_missing_identity_directory_has_no_fallback(self):
        info, image, owner, cgroups, proc, target = self.cgroup_fixture()
        (target / 'cgroup.procs').unlink()
        target.rmdir()
        with self.assertRaises(FileNotFoundError):
            campaign.resolve_container_cgroup(info, image, owner, cgroups, proc)

    def test_disk_headroom_rejects_known_vfs_insufficiency(self):
        runner = campaign.Runner(self.root)
        runner.image_size = 1706755238
        runner.disk_roots = [self.root]
        usage = shutil.disk_usage(self.root)
        with patch.object(campaign.shutil, 'disk_usage', return_value=usage._replace(free=3773000000)):
            self.assertFalse(runner.disk_preflight()['passed'])
        with patch.object(campaign.shutil, 'disk_usage', return_value=usage._replace(free=5 * 1024**3)):
            self.assertTrue(runner.disk_preflight()['passed'])

    def test_absolute_deadline_does_not_reset(self):
        with patch.object(campaign.time, 'monotonic', return_value=80):
            self.assertEqual(campaign.left(90, 20), 10)
        with patch.object(campaign.time, 'monotonic', return_value=90):
            with self.assertRaises(TimeoutError):
                campaign.left(90, 20)

    def test_owned_watchdog_interrupts_synchronous_block(self):
        started = time.monotonic()
        with self.assertRaises(TimeoutError):
            with campaign.watchdog(started + 0.05):
                time.sleep(2)
        self.assertLess(time.monotonic() - started, 1)

    def test_expired_watchdog_never_replaces_signal_handler(self):
        previous = signal.getsignal(signal.SIGALRM)
        with self.assertRaises(TimeoutError):
            with campaign.watchdog(time.monotonic() - 1):
                self.fail('Expired body must not run')
        self.assertEqual(signal.getsignal(signal.SIGALRM), previous)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL), (0.0, 0.0))

    def test_trimmed_projection_cannot_hide_upstream_bom(self):
        normalize = lambda text: re.sub(r'\s+', ' ', unicodedata.normalize('NFC', text)).strip()
        result = evaluation.exact_pair('\ufeffOriginal', 'Original', 'Original', normalize)
        self.assertTrue(result['projected_whole_page_exact'])
        self.assertFalse(result['upstream_whole_page_exact'])
        self.assertFalse(result['whole_page_exact'])

    def test_docker_cli_timeout_is_retained(self):
        (self.root / 'commands').mkdir()
        runner = campaign.Runner(self.root)
        with patch.object(campaign.subprocess, 'run', side_effect=subprocess.TimeoutExpired('docker', 1)) as run:
            with self.assertRaises(TimeoutError):
                runner.docker(['inspect', 'mock'], runner.work_deadline)
        self.assertEqual(run.call_count, 1)
        self.assertTrue(json.loads((self.root / 'commands.json').read_text())[0]['timeout'])

    def test_foreign_container_is_never_removed(self):
        runner = campaign.Runner(self.root)
        with patch.object(runner, 'docker', return_value=(0, 'foreign-owner')) as docker:
            result = runner.cleanup('mock-name', self.root, [])
        self.assertFalse(result['removed'])
        self.assertEqual(docker.call_count, 1)
        self.assertIn('not owned', result['error'])

    def test_unacknowledged_create_absence_is_cleanup_unknown(self):
        runner = campaign.Runner(self.root)
        with patch.object(runner, 'docker', side_effect=[(1, ''), (0, '')]):
            result = runner.cleanup('mock-name', self.root, [], creation_acknowledged=False)
        self.assertTrue(result['observed_absent'])
        self.assertFalse(result['removed'])
        self.assertTrue(result['cleanup_unknown'])

    def test_owned_removal_reconciles_unacknowledged_create(self):
        runner = campaign.Runner(self.root)
        with patch.object(runner, 'docker', side_effect=[(0, runner.owner), (0, 'mock-name'), (0, '')]):
            result = runner.cleanup('mock-name', self.root, [], creation_acknowledged=False)
        self.assertTrue(result['removed'])
        self.assertFalse(result['cleanup_unknown'])

    def test_memory_limit_event_stops_even_without_oom_kill(self):
        runner = campaign.Runner(self.root)
        baseline = {'memory.events': 'max 0\noom 0\noom_kill 0'}
        current = {**campaign.EXPECTED, 'memory.events': 'max 1\noom 0\noom_kill 0'}
        with (self.root / 'samples').open('w') as output, patch.object(campaign, 'read_controls', return_value=current):
            with self.assertRaises(RuntimeError):
                runner.sample(self.root, output, baseline)
        self.assertIn('max 1', (self.root / 'samples').read_text())

    def protocol(self, text=''):
        folder = self.root / 'outputs'
        folder.mkdir()
        campaign.dump(folder / 'parent-receipt.json', {
            'actual_processUploadedDocumentOcr_invoked': True, 'error_code': None,
            'result_present': True, 'production_gateway_called': False, 'customer_or_provider_calls': 0,
            'result_engine': 'experimental_paddle_static', 'pid': 1, 'cgroup': '0::/\n',
            'cgroup_final': {**campaign.EXPECTED, 'memory.current': '10', 'memory.peak': '20',
                'memory.swap.current': '0', 'memory.swap.peak': '0', 'memory.events': 'max 0\noom 0\noom_kill 0'}})
        campaign.dump(folder / 'gate-ready.json', {'cgroup': '0::/\n', 'pid': 1})
        campaign.dump(folder / 'effective-config.json', {'config_sha256': 'a' * 64, 'ppid': 1, 'cgroup': '0::/\n'})
        (folder / 'input-raster.png').write_bytes(b'synthetic-not-decoded')
        image_hash = campaign.sha(folder / 'input-raster.png')
        campaign.dump(folder / 'raw-engine.json', {'result': {'rec_texts': [text]},
            'source_image_sha256': image_hash, 'paddle_version': '3.2.0', 'paddleocr_version': '3.7.0'})
        campaign.dump(folder / 'node-projection.json', {'projection': {'text': text, 'page': 1,
            'text_hash': hashlib.sha256(text.encode()).hexdigest(), 'image_hash': image_hash}})
        return folder, {'page': 1}, {'experiment_files': {'experiment-config.json': 'a' * 64}}

    def test_nonempty_cold_blank_stops_but_page_text_is_not_tuned(self):
        args = self.protocol('unmatched model output remains unchanged')
        campaign.verify_outputs(*args, cold=False)
        with self.assertRaises(ValueError):
            campaign.verify_outputs(*args, cold=True)

    def test_missing_final_peak_cannot_pass_capacity(self):
        folder, row, binding = self.protocol()
        parent = json.loads((folder / 'parent-receipt.json').read_text())
        del parent['cgroup_final']
        campaign.dump(folder / 'parent-receipt.json', parent)
        with self.assertRaises(ValueError):
            campaign.verify_outputs(folder, row, binding)

    def test_cross_cgroup_native_child_is_rejected(self):
        folder, row, binding = self.protocol()
        campaign.dump(folder / 'effective-config.json', {'config_sha256': 'a' * 64, 'ppid': 2, 'cgroup': '0::/other'})
        with self.assertRaises(ValueError):
            campaign.verify_outputs(folder, row, binding)

    def test_cold_failure_keeps_all_thirteen_pages_not_run(self):
        sources, config, binding = [self.root / name for name in ['sources.json', 'config.json', 'binding.json']]
        image = 'sha256:' + 'b' * 64
        campaign.dump(sources, self.manifest)
        campaign.dump(config, {})
        campaign.dump(binding, {'image_id': image})
        output = self.root / 'campaign'
        def docker(runner, args, *_, **__):
            if args[0] == 'image':
                return 0, json.dumps([{'Id': image, 'Architecture': 'amd64', 'Os': 'linux', 'Size': 1706755238}])
            self.assertEqual(args[0], 'info')
            return 0, json.dumps({'DockerRootDir': str(self.root), 'Driver': 'vfs',
                                  'CgroupDriver': 'cgroupfs', 'CgroupVersion': '2'})
        def fail(runner, row, index, *args):
            self.assertEqual(index, 0)
            folder = runner.output / ('00-' + row['id'])
            folder.mkdir()
            receipt = {'id': row['id'], 'status': 'failed', 'failure': {'message': 'mock cold failure'}}
            campaign.dump(folder / 'attempt.json', receipt)
            return receipt
        argv = ['run_campaign.py', '--binding', str(binding), '--expected-binding-sha256', campaign.sha(binding),
                '--source-root', str(self.root), '--config', str(config), '--sources', str(sources), '--output', str(output)]
        previous = signal.getsignal(signal.SIGTERM)
        self.addCleanup(signal.signal, signal.SIGTERM, previous)
        with patch.object(sys, 'argv', argv), patch.object(campaign, 'validate_binding', return_value={}), \
             patch.object(campaign.Runner, 'docker', docker), patch.object(campaign.Runner, 'attempt', fail), \
             patch.object(campaign.Runner, 'disk_preflight', return_value={'passed': True}):
            with self.assertRaises(SystemExit) as exit_status:
                campaign.main()
        self.assertEqual(exit_status.exception.code, 1)
        result = json.loads((output / 'campaign.json').read_text())
        self.assertEqual(result['cases'][0]['status'], 'failed')
        self.assertEqual([row['status'] for row in result['cases'][1:]], ['not_run'] * 13)


if __name__ == '__main__':
    unittest.main()
