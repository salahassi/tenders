#!/usr/bin/env python3
"""Offline proof of actual executor-6 worker/scheduler entrypoints.

Only the synthetic loopback gateway harness is mounted. Product source is read
from the immutable image. SQL authority/durability and hosted issuance are
separate gates; the frozen executor-5 fixture remains historical evidence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[3]
DRIVER = Path(__file__).resolve()
SCRIPT = DRIVER.with_suffix('.ts')
HARNESSES = ('backend/scripts/testing/worker_dispatch_v6_native.py',
             'backend/scripts/testing/worker_dispatch_v6_native.ts')
CHECKS = ('worker_authentication', 'worker_foreground_maintenance_auth_no_rpc',
          'worker_idle_prompt', 'worker_ready_response_before_maintenance',
          'worker_poll_delay_returned_without_sleep', 'scheduler_maintenance_independent',
          'scheduler_completion_metadata', 'scheduler_failure_retry', 'shutdown_drained',
          'worker_executor6_rpc_paths')
WORKER_RPCS = ('claim_backend_job_v6', 'claim_backend_local_job_v6', 'wake_backend_queue_status_v6')
RPC_NAMES = set(WORKER_RPCS) | {'finish_backend_job', 'maintenance_tick', 'schedule_assessment_refresh',
    'automation_notification_tick', 'claim_notification_delivery', 'claim_abandoned_model_request',
    'claim_storage_cleanup', 'k8s_claim_dispatch', 'k8s_finish_dispatch_v2', 'k8s_claim_maintenance',
    'k8s_finish_maintenance'}
IMAGE_CMD = ['run', '--cached-only', '--frozen', '--config=supabase/functions/deno.json',
    '--allow-env', '--allow-net', '--allow-sys', '--allow-run=/bin/deno',
    '--allow-read=/app,/deno-dir,/tmp', '--allow-write=/tmp', 'scripts/runtime/main.ts']


class NativeError(Exception):
    pass


def require(value, code):
    if not value:
        raise NativeError('DISPATCH_V6_NATIVE_' + code)


def digest(path):
    require(path.is_file() and not path.is_symlink(), 'EVIDENCE_TYPE')
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def docker(*args, timeout=40):
    env = dict(os.environ)
    for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'):
        env.pop(key, None)
    try:
        return subprocess.run(['docker', '--host=unix:///var/run/docker.sock', *args],
            capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise NativeError('DISPATCH_V6_NATIVE_DOCKER_TIMEOUT') from None


def must(result, code):
    require(result.returncode == 0, code)
    return result.stdout


def copied_sources():
    result = {}
    for relative in ('backend/supabase/functions', 'backend/scripts/runtime', 'frontend/public/fonts'):
        folder = ROOT / relative
        require(folder.is_dir() and not folder.is_symlink(), 'SOURCE_ROOT')
        for path in sorted(folder.rglob('*')):
            require(not path.is_symlink(), 'SOURCE_SYMLINK')
            if path.is_file():
                result[path.relative_to(ROOT).as_posix()] = digest(path)
            else:
                require(path.is_dir(), 'SOURCE_TYPE')
    for name in ('renderDocx.ts', 'docxTableStream.ts'):
        relative = 'frontend/src/lib/' + name
        result[relative] = digest(ROOT / relative)
    return result


def validate_metadata(metadata, image):
    require(metadata.get('Id') == image and metadata.get('Os') == 'linux'
            and metadata.get('Architecture') == 'amd64' and metadata.get('Variant') in (None, ''), 'IMAGE_IDENTITY')
    config = metadata.get('Config', {})
    require(config.get('Entrypoint') == ['/tini', '--', 'docker-entrypoint.sh']
            and config.get('Cmd') == IMAGE_CMD and config.get('User') == 'deno'
            and config.get('WorkingDir') == '/app/backend', 'ORIGINAL_ENTRYPOINT')


def validate_probe(value, expected_sources):
    require(isinstance(value, dict) and value.get('version') == 1 and value.get('passed') is True
            and type(value.get('provider_calls')) is int and value['provider_calls'] == 0
            and type(value.get('unexpected_rpc_count')) is int and value['unexpected_rpc_count'] == 0, 'PROBE_IDENTITY')
    require(value.get('source_sha256') == expected_sources, 'IMAGE_SOURCE_CHANGED')
    require(set(value.get('checks', {})) == set(CHECKS)
            and all(value['checks'][name] is True for name in CHECKS), 'PROBE_CHECK_MISSING')
    names = value.get('rpc_names')
    require(isinstance(names, list) and all(isinstance(name, str) for name in names)
            and names == sorted(set(names)) and set(names) <= RPC_NAMES
            and set(WORKER_RPCS) <= set(names) and value.get('worker_rpc_names') == list(WORKER_RPCS), 'EXECUTOR6_RPC_PATHS')
    require(type(value.get('rpc_count')) is int and value['rpc_count'] >= len(names), 'RPC_COUNT')
    require(value.get('scheduler_image_cmd') == IMAGE_CMD, 'SCHEDULER_CMD_CHANGED')


def owned_container(value, name, image):
    require(value.get('Name') == '/' + name and value.get('Image') == image
            and value.get('Config', {}).get('Labels', {}).get('tenderdesk.io/dispatch-v6-native') == name,
            'FOREIGN_CONTAINER')
    container_id = value.get('Id')
    require(isinstance(container_id, str) and re.fullmatch('[a-f0-9]{64}', container_id), 'CONTAINER_ID')
    return container_id


def absent(result, identifier):
    return result.returncode != 0 and getattr(result, 'stderr', '').strip() in (
        'Error: No such object: ' + identifier,
        'Error: No such container: ' + identifier,
        'Error response from daemon: No such container: ' + identifier)


def probe(image, sources):
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', image) is not None, 'IMAGE_REFERENCE')
    metadata = json.loads(must(docker('image', 'inspect', image), 'IMAGE_INSPECTION'))[0]
    validate_metadata(metadata, image)
    command = metadata['Config']['Cmd']
    name = 'tdp-dispatch-v6-native-' + os.urandom(6).hex()
    container_id = None
    value = None
    try:
        must(docker('run', '-d', '--name', name, '--network', 'none', '--read-only',
            '--label', 'tenderdesk.io/dispatch-v6-native=' + name,
            '--memory', '1280m', '--cpus', '2', '--pids-limit', '128', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
            '--mount', f'type=bind,src={SCRIPT},dst=/native-fixture.ts,readonly',
            '-e', 'APP_RUNTIME_SERVICE=worker', '-e', 'SUPABASE_URL=http://127.0.0.1:8081',
            '-e', 'APP_SUPABASE_PUBLISHABLE_KEY=native-fixture-public',
            '-e', 'SUPABASE_SERVICE_ROLE_KEY=native-fixture-service', '-e', 'APP_WORKER_SECRET=native-fixture-worker',
            '-e', 'NO_PROXY=127.0.0.1,localhost', '-e', 'no_proxy=127.0.0.1,localhost', image), 'CONTAINER_START')
        container = json.loads(must(docker('inspect', name), 'CONTAINER_INSPECTION'))[0]
        container_id = owned_container(container, name, image)
        require(container['HostConfig']['NetworkMode'] == 'none' and container['HostConfig']['ReadonlyRootfs'], 'ISOLATION')
        mounts = container.get('Mounts', [])
        binds = [mount for mount in mounts if mount.get('Type') == 'bind']
        require(len(binds) == 1 and binds[0].get('Source') == str(SCRIPT)
                and binds[0].get('Destination') == '/native-fixture.ts' and binds[0].get('RW') is False
                and all(mount in binds or mount.get('Type') == 'tmpfs' and mount.get('Destination') == '/tmp'
                        for mount in mounts), 'PRODUCT_OVERLAY')
        health = None
        for _ in range(50):
            response = docker('exec', container_id, '/bin/busybox', 'wget', '-Y', 'off', '-qO-', 'http://127.0.0.1:8080/healthz')
            if response.returncode == 0:
                health = json.loads(response.stdout)
                break
            time.sleep(0.1)
        require(health == {'status': 'ready', 'component': 'worker'}, 'DEFAULT_WORKER_STARTUP')
        raw = must(docker('exec', '-e', 'NATIVE_IMAGE_CMD=' + json.dumps(command), container_id,
            '/bin/deno', 'run', '--cached-only', '--frozen', '--config=/app/backend/supabase/functions/deno.json',
            '--allow-env', '--allow-net=127.0.0.1:8080,127.0.0.1:8081', '--allow-sys', '--allow-run=/bin/deno',
            '--allow-read=/app,/deno-dir,/native-fixture.ts', '--allow-write=/tmp', '/native-fixture.ts', timeout=35), 'DISPATCH_PROBE')
        value = json.loads(raw)
        validate_probe(value, sources)
        must(docker('stop', '--time', '5', container_id), 'SHUTDOWN')
        state = json.loads(must(docker('inspect', container_id), 'STOP_INSPECTION'))[0]['State']
        require(not state['Running'] and state['ExitCode'] == 0 and not state['OOMKilled'], 'SHUTDOWN_NOT_DRAINED')
    finally:
        identifier = container_id or name
        found = docker('inspect', identifier)
        if found.returncode == 0:
            owned_id = owned_container(json.loads(found.stdout)[0], name, image)
            require(container_id is None or owned_id == container_id, 'CONTAINER_ID_CHANGED')
            must(docker('rm', '-f', owned_id, timeout=10), 'CLEANUP')
            require(absent(docker('inspect', owned_id), owned_id), 'CLEANUP_UNCONFIRMED')
        else:
            require(absent(found, identifier), 'CLEANUP_INSPECTION_FAILED')
    return {**value, 'image_entrypoint': metadata['Config']['Entrypoint'], 'image_cmd': command,
            'image_user': metadata['Config']['User']}


def run(image):
    sources = copied_sources()
    harnesses = {name: digest(ROOT / name) for name in HARNESSES}
    started = time.monotonic()
    value = probe(image, sources)
    require(copied_sources() == sources and {name: digest(ROOT / name) for name in HARNESSES} == harnesses,
            'SOURCE_CHANGED_DURING_PROBE')
    return {**value, 'version': 1, 'kind': 'proposal_dispatch_v6_native', 'image_id': image,
        'passed': True, 'harness_sha256': harnesses, 'actual_image_entrypoint': True, 'network': 'none',
        'external_calls': 0, 'provider_calls': 0, 'cleanup_verified': True, 'hosted_acceptance': False,
        'resources': {'memory_mib': 1280, 'cpus': 2, 'pids_limit': 128, 'tmpfs_mib': 64, 'readonly_rootfs': True},
        'duration_seconds': round(time.monotonic() - started, 3)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    require(not args.output.exists(), 'OUTPUT_EXISTS')
    value = run(args.image)
    with args.output.open('x') as stream:
        json.dump(value, stream, sort_keys=True, indent=2)
        stream.write('\n')
    print(json.dumps({'passed': True, 'image_id': value['image_id'], 'checks': len(CHECKS), 'output': str(args.output)}))
