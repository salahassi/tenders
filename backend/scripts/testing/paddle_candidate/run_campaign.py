"""External bounded coordinator. Merely importing or --help never runs OCR.

Execution requires an exact binding reviewed by the root coordinator and a new
output directory. The binding is evidence, not a substitute for root approval.
No expected text is read here. Host gold evaluation is a separate later step.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time

HERE = Path(__file__).resolve().parent
DOCKER = ['docker', '--host=unix:///var/run/docker.sock']
FILES = ('experiment-config.json', 'run_parent.mjs', 'run_engine.py')
EXPECTED = {'memory.max': '805306368', 'memory.swap.max': '0',
            'cpu.max': '100000 100000'}
ORDER = ['a06-01-conditional-gate', 'a06-02-decimal-payment',
         'a06-03-incident-deadline', 'a06-04-right-column-first',
         'a06-05-mixed-table', 'a06-06-blank', 'known-arabic-failure',
         'maintenance-obligation', 'records-retention', 'sensor-acceptance',
         'english-existing-control', 'mixed-exact-scan-page', 'mixed-blank-page']
CASE_KEYS = {'id', 'path', 'sha256', 'page', 'total_pages', 'language'}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def dump(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False,
                                    allow_nan=False) + '\n')
    temporary.replace(path)


def left(deadline, cap):
    value = min(cap, deadline - time.monotonic())
    if value <= 0:
        raise TimeoutError('Absolute external deadline expired')
    return value


@contextmanager
def watchdog(deadline):
    """Interrupt synchronous host work as well as bounded subprocess waits."""
    if deadline <= time.monotonic():
        raise TimeoutError('Owned watchdog deadline has already expired')
    previous_handler = signal.getsignal(signal.SIGALRM)
    previous_timer = signal.getitimer(signal.ITIMER_REAL)
    if previous_timer[0] > 0:
        raise RuntimeError('Coordinator refuses to replace another active watchdog')
    def expired(*_):
        raise TimeoutError('Owned absolute POSIX watchdog expired')
    signal.signal(signal.SIGALRM, expired)
    try:
        signal.setitimer(signal.ITIMER_REAL, max(0.000001, deadline - time.monotonic()))
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)


def validate_controls(values):
    if any(values.get(key) != expected for key, expected in EXPECTED.items()):
        raise ValueError('Actual cgroup controls differ from frozen resource limits')


def read_controls(path):
    return {name: (path / name).read_text().strip() for name in
            (*EXPECTED, 'memory.current', 'memory.peak', 'memory.events', 'cgroup.procs')}


def counters(text):
    return {line.split()[0]: int(line.split()[1]) for line in text.splitlines()}


def validate_sources(manifest, source_root):
    if set(manifest) != {'version', 'scope', 'prospective_gold_sha256', 'cold_blank', 'cases'}:
        raise ValueError('Unexpected source manifest fields')
    if manifest['version'] != 1 or [row['id'] for row in manifest['cases']] != ORDER:
        raise ValueError('Frozen 13-case order changed')
    cold = manifest['cold_blank']
    if cold != {**manifest['cases'][5], 'id': 'separate-cold-blank'}:
        raise ValueError('Cold case must be a separate attempt on the frozen blank')
    for row in [cold, *manifest['cases']]:
        if set(row) != CASE_KEYS or not re.fullmatch(r'[a-z0-9-]+', row['id']):
            raise ValueError('Only source identifiers and page request fields are permitted')
        relative = Path(row['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Source escapes repository')
        path = (source_root / relative).resolve()
        path.relative_to(source_root)
        if not re.fullmatch(r'[a-f0-9]{64}', row['sha256']) or sha(path) != row['sha256']:
            raise ValueError('Frozen source hash changed: ' + row['id'])
        if not 5 <= path.stat().st_size <= 10485760 or path.read_bytes()[:5] != b'%PDF-':
            raise ValueError('Source PDF size/header invalid')
        if (type(row['page']) is not int or type(row['total_pages']) is not int or
                not 1 <= row['page'] <= row['total_pages'] <= 200 or
                row['language'] not in ['ar', 'en', 'auto']):
            raise ValueError('Invalid source page request')


def validate_binding(binding, config_path, sources_path):
    required = {'version', 'scope', 'image_id', 'root_window_reference', 'host_files', 'experiment_files'}
    if set(binding) != required or binding['version'] != 1:
        raise ValueError('Binding schema changed')
    if not re.fullmatch(r'sha256:[a-f0-9]{64}', binding['image_id']):
        raise ValueError('An exact local immutable image ID is required')
    if not isinstance(binding['root_window_reference'], str) or not binding['root_window_reference'].strip():
        raise ValueError('Root-approved exclusive window reference required')
    paths = {'run_campaign.py': Path(__file__), 'entry_gate.py': HERE / 'entry_gate.py',
             'evaluate_campaign.py': HERE / 'evaluate_campaign.py',
             'campaign-sources.json': sources_path}
    if set(binding['host_files']) != set(paths) or set(binding['experiment_files']) != set(FILES):
        raise ValueError('Exact host and in-image harness set required')
    for name, path in paths.items():
        if sha(path) != binding['host_files'][name]:
            raise ValueError('Bound coordinator input drift: ' + name)
    if sha(config_path) != binding['experiment_files']['experiment-config.json']:
        raise ValueError('Config hash changed')
    config = json.loads(config_path.read_text())
    exact = {'memory_bytes': 805306368, 'cpu_cores': 1, 'swap_bytes': 0,
             'pids_limit': 128, 'tmpfs_bytes': 268435456, 'page_attempt_seconds': 90,
             'separate_cold_blank_seconds': 90, 'campaign_pages': 13,
             'campaign_attempt_seconds': 1170, 'overall_work_seconds': 1260,
             'outer_cleanup_seconds': 120, 'absolute_work_and_cleanup_seconds': 1380,
             'case_order': ORDER}
    if any(config.get(k) != v for k, v in exact.items()):
        raise ValueError('Frozen campaign/resource settings changed')
    return config


class Runner:
    def __init__(self, output):
        self.output = output
        self.started = time.monotonic()
        self.work_deadline = self.started + 1260
        self.campaign_deadline = None
        self.hard_deadline = self.started + 1380
        self.cleanup_spent = 0.0
        self.owner = hashlib.sha256((str(output) + ':' + str(time.time_ns())).encode()).hexdigest()
        self.env = {key: value for key, value in os.environ.items() if key not in
                    ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']}
        self.commands = []
        self.image_size = None
        self.disk_roots = None

    def disk_preflight(self):
        if type(self.image_size) is not int or self.image_size <= 0 or not self.disk_roots:
            raise ValueError('Actual image size and Docker storage path must be inspected first')
        required = max(4 * 1024**3, 2 * self.image_size + 512 * 1024**2)
        rows = []
        for path in self.disk_roots:
            usage = shutil.disk_usage(path)
            rows.append({'path': str(path), 'free_bytes': usage.free, 'total_bytes': usage.total,
                         'required_free_bytes': required, 'enough': usage.free >= required})
        return {'scope': 'Conservative VFS pre-create headroom after retained ENOSPC preparation failure',
                'image_logical_bytes': self.image_size, 'minimum_free_bytes': required,
                'filesystems': rows, 'passed': all(row['enough'] for row in rows)}

    def docker(self, args, deadline, cap=10, check=True):
        number = len(self.commands)
        prefix = self.output / 'commands' / f'{number:04d}'
        row = {'argv': DOCKER + args, 'started_utc_ns': time.time_ns(),
               'started_elapsed_seconds': time.monotonic() - self.started}
        self.commands.append(row)
        with prefix.with_suffix('.stdout').open('wb') as out, prefix.with_suffix('.stderr').open('wb') as err:
            try:
                result = subprocess.run(DOCKER + args, env=self.env, stdout=out, stderr=err,
                                        timeout=left(deadline, cap), check=False)
                row['returncode'] = result.returncode
            except subprocess.TimeoutExpired:
                row['timeout'] = True
                raise TimeoutError('Docker CLI exceeded absolute bounded command time')
            except TimeoutError:
                row['absolute_watchdog_timeout'] = True
                raise
            finally:
                row['finished_utc_ns'] = time.time_ns()
                dump(self.output / 'commands.json', self.commands)
        if check and result.returncode:
            raise RuntimeError('Docker command failed: ' + ' '.join(args[:2]))
        return result.returncode, prefix.with_suffix('.stdout').read_text()

    def cleanup(self, name, folder, processes, creation_acknowledged=False):
        begun = time.monotonic()
        deadline = min(self.hard_deadline, begun + max(0, 120 - self.cleanup_spent), begun + 20)
        receipt = {'started_utc_ns': time.time_ns(), 'container': name, 'removed': False,
                   'creation_acknowledged': creation_acknowledged, 'cleanup_unknown': True}
        try:
            with watchdog(deadline):
                # --force terminates the entire container/cgroup, including Python descendants.
                code, owner = self.docker(['inspect', '--format',
                                          '{{ index .Config.Labels "a06.campaign.owner" }}', name],
                                         deadline, cap=5, check=False)
                owned_removal_acknowledged = False
                inspect_absent = code != 0
                if code == 0:
                    if owner.strip() != self.owner:
                        raise RuntimeError('Refusing to remove a container not owned by this attempt')
                    code, _ = self.docker(['rm', '--force', name], deadline, check=False)
                    receipt['remove_exit_code'] = code
                    owned_removal_acknowledged = code == 0
                code, listing = self.docker(['ps', '--all', '--no-trunc', '--filter', 'name=^/' + name + '$',
                                             '--format', '{{.Names}}'], deadline, cap=5)
                receipt['observed_absent'] = not listing.strip()
                # A timed-out create can still complete in the daemon after an
                # immediate empty listing. Absence alone is not acknowledgment.
                receipt['removed'] = receipt['observed_absent'] and (
                    owned_removal_acknowledged or (creation_acknowledged and inspect_absent))
                receipt['cleanup_unknown'] = not receipt['removed']
        except Exception as error:
            receipt['error'] = str(error)
        finally:
            for process, handles in processes:
                if process.poll() is None:
                    process.kill()
                try:
                    process.wait(timeout=left(deadline, 1))
                except (subprocess.TimeoutExpired, TimeoutError):
                    receipt['docker_cli_cleanup_failed'] = True
                for handle in handles:
                    handle.close()
            receipt['elapsed_seconds'] = time.monotonic() - begun
            self.cleanup_spent += receipt['elapsed_seconds']
            receipt['cumulative_cleanup_seconds'] = self.cleanup_spent
            dump(folder / 'cleanup.json', receipt)
        return receipt

    def follow(self, args, folder, prefix):
        handles = [(folder / (prefix + suffix)).open('wb') for suffix in ['.stdout', '.stderr']]
        try:
            process = subprocess.Popen(DOCKER + args, env=self.env, stdout=handles[0], stderr=handles[1])
        except BaseException:
            for handle in handles:
                handle.close()
            raise
        dump(folder / (prefix + '-command.json'), {'argv': DOCKER + args,
             'started_utc_ns': time.time_ns(), 'pid': process.pid,
             'deadline_scope': 'Killed by finally cleanup; external attempt and cleanup deadlines apply'})
        return process, handles

    def attempt(self, row, index, binding, source_root):
        begun = time.monotonic()
        deadline = min(self.work_deadline, begun + 90)
        if index > 0:
            if self.campaign_deadline is None:
                raise ValueError('Campaign wall deadline must be set after cold blank')
            deadline = min(deadline, self.campaign_deadline)
        folder = self.output / f'{index:02d}-{row["id"]}'
        name = f'a06-paddle-{self.owner[:16]}-{index:02d}'
        if not re.fullmatch(r'[a-zA-Z0-9_.-]+', name):
            raise ValueError('Output directory name cannot form safe container name')
        receipt = {'id': row['id'], 'source': row, 'container': name,
                   'started_utc_ns': time.time_ns(), 'deadline_seconds': 90,
                   'status': 'failed', 'phase': 'prepare', 'outputs': {}}
        processes = []
        cgroup = None
        baseline = None
        created_or_attempted = False
        creation_acknowledged = False
        try:
            with watchdog(deadline):
                folder.mkdir()
                for part in ['inputs', 'outputs', 'gate']:
                    (folder / part).mkdir(mode=0o755)
                    (folder / part).chmod(0o755)
                (folder / 'outputs').chmod(0o777)
                source = source_root / row['path']
                if sha(source) != row['sha256']:
                    raise ValueError('Source drift immediately before attempt')
                shutil.copyfile(source, folder / 'inputs/source.pdf')
                if sha(folder / 'inputs/source.pdf') != row['sha256']:
                    raise ValueError('Staged source hash changed')
                request = {key: row[key] for key in ['page', 'total_pages', 'language']}
                request['original_hash'] = row['sha256']
                dump(folder / 'inputs/request.json', request)
                shutil.copyfile(HERE / 'entry_gate.py', folder / 'gate/entry_gate.py')
                for mounted in ['inputs/source.pdf', 'inputs/request.json', 'gate/entry_gate.py']:
                    (folder / mounted).chmod(0o644)
                args = ['create', '--name', name, '--label', 'a06.isolated.campaign=true',
                        '--label', 'a06.campaign.owner=' + self.owner,
                        '--network=none', '--read-only', '--cap-drop=ALL',
                        '--security-opt=no-new-privileges', '--memory=805306368',
                        '--memory-swap=805306368', '--cpu-period=100000', '--cpu-quota=100000',
                        '--pids-limit=128', '--user=1000:1000',
                        '--tmpfs=/tmp:rw,nosuid,nodev,size=268435456,mode=1777',
                        '--entrypoint=/usr/local/bin/python3']
                # Docker's configured proxy defaults are not needed by this offline
                # attempt. Do not copy credential-bearing proxy values into evidence.
                for key in ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
                            'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']:
                    args += ['--env', key + '=']
                for part, readonly in [('inputs', True), ('outputs', False), ('gate', True)]:
                    mount = str((folder / part).resolve())
                    if ',' in mount:
                        raise ValueError('Comma in bind mount path')
                    args += ['--mount', f'type=bind,src={mount},dst=/{part}' + (',readonly' if readonly else '')]
                args += [binding['image_id'], '/gate/entry_gate.py']
                receipt['disk_before_create'] = self.disk_preflight()
                if not receipt['disk_before_create']['passed']:
                    raise RuntimeError('Insufficient disk headroom for isolated VFS container creation')
                receipt['phase'] = 'create_start'
                created_or_attempted = True
                self.docker(args, deadline)
                creation_acknowledged = True
                receipt['creation_acknowledged'] = True
                self.docker(['start', name], deadline)
                processes.append(self.follow(['logs', '--follow', '--timestamps', name], folder, 'container-logs'))
                waiter = self.follow(['wait', name], folder, 'container-wait')
                processes.append(waiter)
                _, inspected = self.docker(['inspect', name], deadline)
                info = json.loads(inspected)[0]
                dump(folder / 'container-before.json', info)
                if info['Image'] != binding['image_id']:
                    raise ValueError('Actual container image differs from binding')
                host_pid = info['State']['Pid']
                lines = Path(f'/proc/{host_pid}/cgroup').read_text().splitlines()
                relative = next(line[3:] for line in lines if line.startswith('0::'))
                cgroup = (Path('/sys/fs/cgroup') / relative.lstrip('/')).resolve()
                cgroup.relative_to('/sys/fs/cgroup')
                receipt['host_cgroup_path'] = str(cgroup)
                baseline = read_controls(cgroup)
                validate_controls(baseline)
                receipt['actual_host_controls_before_node'] = baseline
                receipt['phase'] = 'gate'
                with (folder / 'cgroup-samples.jsonl').open('x') as samples:
                    while not (folder / 'outputs/gate-ready.json').exists():
                        left(deadline, 1)
                        if waiter[0].poll() is not None:
                            raise RuntimeError('Container exited before pre-Node gate')
                        self.sample(cgroup, samples, baseline)
                        time.sleep(min(0.05, left(deadline, 0.05)))
                    gate = json.loads((folder / 'outputs/gate-ready.json').read_text())
                    validate_controls(gate['controls'])
                    if gate['experiment_files'] != binding['experiment_files']:
                        raise ValueError('In-image experiment files differ from binding')
                    validate_controls(read_controls(cgroup))
                    left(deadline, 1)
                    (folder / 'gate/start').write_text('root-bound-host-controls-verified\n')
                    receipt['node_released_utc_ns'] = time.time_ns()
                    receipt['phase'] = 'node_parent_and_python_child'
                    while waiter[0].poll() is None:
                        left(deadline, 1)
                        # Docker can remove the cgroup just before its wait CLI
                        # returns. That terminal gap is retained, never called a
                        # complete lifetime memory maximum.
                        self.sample(cgroup, samples, baseline, allow_missing=True)
                        time.sleep(min(0.2, left(deadline, 0.2)))
                    self.sample(cgroup, samples, baseline, allow_missing=True)
                _, inspected = self.docker(['inspect', name], deadline, cap=5)
                after = json.loads(inspected)[0]
                dump(folder / 'container-after.json', after)
                receipt['state'] = after['State']
                if (waiter[0].returncode != 0 or after['State']['Running'] or
                        after['State']['ExitCode'] != 0 or after['State']['OOMKilled']):
                    raise RuntimeError('Container/parent failed or exceeded resources')
                verify_outputs(folder / 'outputs', row, binding, cold=index == 0)
                left(deadline, 1)
                receipt['status'] = 'completed'
                receipt['phase'] = 'captured'
        except BaseException as error:
            receipt['failure'] = {'type': type(error).__name__, 'message': str(error)}
        finally:
            receipt['work_elapsed_seconds'] = time.monotonic() - begun
            receipt['work_finished_utc_ns'] = time.time_ns()
            if created_or_attempted:
                cleanup = self.cleanup(name, folder, processes, creation_acknowledged)
                if not cleanup.get('removed') or cleanup.get('docker_cli_cleanup_failed'):
                    receipt['status'] = 'failed'
                    receipt['cleanup_failure'] = True
            else:
                receipt['cleanup_not_needed'] = True
            metadata_begun = time.monotonic()
            metadata_deadline = min(self.hard_deadline, metadata_begun + max(0, 120 - self.cleanup_spent))
            try:
                with watchdog(metadata_deadline):
                    receipt['outputs'] = {str(p.relative_to(folder)): {'sha256': sha(p), 'bytes': p.stat().st_size}
                                          for p in sorted(folder.rglob('*')) if p.is_file()}
            except BaseException as error:
                receipt['status'] = 'failed'
                receipt['artifact_capture_failure'] = {'type': type(error).__name__, 'message': str(error)}
            self.cleanup_spent += time.monotonic() - metadata_begun
            receipt['finished_utc_ns'] = time.time_ns()
            dump(folder / 'attempt.json', receipt)
        return receipt

    def sample(self, cgroup, output, baseline, allow_missing=False):
        try:
            controls = read_controls(cgroup)
        except FileNotFoundError:
            if allow_missing:
                output.write(json.dumps({'utc_ns': time.time_ns(), 'cgroup_removed_after_exit': True}) + '\n')
                output.flush()
                return
            raise
        output.write(json.dumps({'utc_ns': time.time_ns(), 'elapsed_seconds': time.monotonic() - self.started,
                                 'controls': controls}) + '\n')
        output.flush()
        validate_controls(controls)
        events, prior = counters(controls['memory.events']), counters(baseline['memory.events'])
        if any(events.get(key, 0) > prior.get(key, 0) for key in ['max', 'oom', 'oom_kill', 'oom_group_kill']):
            raise RuntimeError('Cgroup memory limit/OOM event observed')


def verify_outputs(folder, row, binding, cold=False):
    parent = json.loads((folder / 'parent-receipt.json').read_text())
    effective = json.loads((folder / 'effective-config.json').read_text())
    projection = json.loads((folder / 'node-projection.json').read_text())['projection']
    raw = json.loads((folder / 'raw-engine.json').read_text())
    if any((folder / name).exists() for name in ['native-failure.json', 'engine-failure.json']):
        raise ValueError('Retained native/engine failure')
    if (parent.get('actual_processUploadedDocumentOcr_invoked') is not True or
            parent.get('error_code') is not None or parent.get('result_present') is not True or
            parent.get('production_gateway_called') is not False or parent.get('customer_or_provider_calls') != 0 or
            parent.get('result_engine') != 'experimental_paddle_static'):
        raise ValueError('Actual parent completion protocol failed')
    final = parent.get('cgroup_final')
    if not isinstance(final, dict):
        raise ValueError('Final surviving-parent cgroup receipt is required')
    validate_controls(final)
    if not {'max', 'oom', 'oom_kill'} <= counters(final['memory.events']).keys():
        raise ValueError('Final memory event counters are incomplete')
    if (not 0 <= int(final['memory.current']) <= int(final['memory.peak']) <= 805306368 or
            final['memory.swap.current'] != '0' or final['memory.swap.peak'] != '0' or
            any(counters(final['memory.events']).get(key, 0) != 0
                for key in ['max', 'oom', 'oom_kill', 'oom_group_kill'])):
        raise ValueError('Final parent cgroup shows memory/swap pressure or invalid evidence')
    if effective.get('config_sha256') != binding['experiment_files']['experiment-config.json']:
        raise ValueError('Effective configuration hash mismatch')
    gate = json.loads((folder / 'gate-ready.json').read_text())
    if (effective.get('cgroup') != parent.get('cgroup') or parent.get('cgroup') != gate.get('cgroup') or
            gate.get('pid') != parent.get('pid') or
            effective.get('ppid') != parent.get('pid') or not isinstance(parent.get('pid'), int)):
        raise ValueError('Node parent and native child cgroup/process evidence differs')
    if raw.get('paddle_version') != '3.2.0' or raw.get('paddleocr_version') != '3.7.0':
        raise ValueError('Actual candidate package versions differ')
    texts = raw.get('result', {}).get('rec_texts')
    if not isinstance(texts, list) or not all(isinstance(item, str) for item in texts):
        raise ValueError('Malformed raw recognition text')
    text = projection.get('text')
    # Preserve Node's already-written projection. No host rewriting/reordering.
    if (not isinstance(text, str) or projection.get('page') != row['page'] or
            projection.get('text_hash') != hashlib.sha256(text.encode()).hexdigest() or
            projection.get('image_hash') != sha(folder / 'input-raster.png') or
            raw.get('source_image_sha256') != projection['image_hash']):
        raise ValueError('Projection/source protocol mismatch')
    if cold and text != '':
        raise ValueError('Separate cold blank returned non-empty text')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binding', type=Path, required=True)
    parser.add_argument('--expected-binding-sha256', required=True)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--sources', type=Path, default=HERE / 'campaign-sources.json')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if sha(args.binding) != args.expected_binding_sha256:
        parser.error('Run binding differs from root-reviewed hash')
    args.output = args.output.resolve()
    args.output.mkdir(mode=0o755, exist_ok=False)
    (args.output / 'commands').mkdir()
    runner = Runner(args.output)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(InterruptedError('SIGTERM')))
    rows = [{'id': 'separate-cold-blank', 'status': 'not_run', 'reason': 'preflight_or_prior_failure'}]
    rows += [{'id': item, 'status': 'not_run', 'reason': 'preflight_or_prior_failure'} for item in ORDER]
    summary = {'version': 1, 'scope': 'isolated_feasibility_not_production_qualification',
               'binding_sha256': args.expected_binding_sha256,
               'started_utc_ns': time.time_ns(), 'status': 'failed', 'cases': rows,
               'gold_loaded_in_coordinator': False, 'gold_mounted_in_container': False,
               'host_evaluation_pending': True, 'total_campaign_denominator': 13,
               'cold_blank_is_additional_attempt': True,
               'polling_scope': 'External host cgroup polling and Docker orchestration consume host CPU; no claim of zero orchestration overhead.'}
    dump(args.output / 'campaign.json', summary)
    try:
        with watchdog(runner.work_deadline):
            manifest = json.loads(args.sources.read_text())
            binding = json.loads(args.binding.read_text())
            validate_binding(binding, args.config, args.sources)
            validate_sources(manifest, args.source_root.resolve())
            shutil.copyfile(args.binding, args.output / 'run-binding.json')
            shutil.copyfile(args.sources, args.output / 'campaign-sources.json')
            shutil.copyfile(args.config, args.output / 'experiment-config.json')
            _, inspected = runner.docker(['image', 'inspect', binding['image_id']], runner.work_deadline)
            info = json.loads(inspected)[0]
            dump(args.output / 'image-before.json', info)
            if info['Id'] != binding['image_id'] or info.get('Architecture') != 'amd64' or info.get('Os') != 'linux':
                raise ValueError('Exact Linux/amd64 image is unavailable')
            runner.image_size = info['Size']
            _, docker_root = runner.docker(['info', '--format', '{{.DockerRootDir}}'], runner.work_deadline)
            runner.disk_roots = [args.output, Path(docker_root.strip()).resolve(strict=True)]
            summary['disk_preflight'] = runner.disk_preflight()
            if not summary['disk_preflight']['passed']:
                raise RuntimeError('Insufficient disk headroom before cold attempt')
        for index, row in enumerate([manifest['cold_blank'], *manifest['cases']]):
            left(runner.work_deadline, 1)
            if index == 1:
                runner.campaign_deadline = min(runner.work_deadline, time.monotonic() + 1170)
                summary['campaign_started_utc_ns'] = time.time_ns()
                summary['campaign_wall_seconds_limit'] = 1170
            receipt = runner.attempt(row, index, binding, args.source_root.resolve())
            rows[index] = {'id': row['id'], 'status': receipt['status'],
                           'receipt': f'{index:02d}-{row["id"]}/attempt.json',
                           'receipt_sha256': sha(args.output / f'{index:02d}-{row["id"]}/attempt.json')}
            dump(args.output / 'campaign.json', summary)
            if receipt['status'] != 'completed':
                raise RuntimeError('Stop on first failed attempt: ' + row['id'])
            if index > 0:
                left(runner.campaign_deadline, 1)
        with watchdog(min(runner.work_deadline, runner.campaign_deadline)):
            validate_sources(manifest, args.source_root.resolve())
            validate_binding(binding, args.config, args.sources)
        summary['status'] = 'completed_pending_host_evaluation'
    except BaseException as error:
        summary['failure'] = {'type': type(error).__name__, 'message': str(error)}
    finally:
        summary['elapsed_seconds'] = time.monotonic() - runner.started
        summary['cleanup_seconds'] = runner.cleanup_spent
        summary['absolute_1380_seconds_respected'] = summary['elapsed_seconds'] <= 1380
        if not summary['absolute_1380_seconds_respected'] or runner.cleanup_spent > 120:
            summary['status'] = 'failed'
            summary['outer_budget_failed'] = True
        summary['finished_utc_ns'] = time.time_ns()
        dump(args.output / 'campaign.json', summary)
    raise SystemExit(0 if summary['status'] == 'completed_pending_host_evaluation' else 1)


if __name__ == '__main__':
    main()
