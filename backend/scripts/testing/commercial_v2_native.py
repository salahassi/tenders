#!/usr/bin/env python3
"""Offline commercial V2 context, legacy wire and DOCX proof in actual images.

Both images start their original worker entrypoint. Only this harness is mounted;
the Deno function probe has no network permission and imports product files from
/app. Calls actual context, prompt, renderer and verifier exports; hosted issuance is separate.
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
BASELINE_IMAGE = 'sha256:c74fd450df9f7d37b2146088b0f4ffd35adb4f9c84267b8b364ad32caf853603'
BASELINE_RECEIPT = 'backend/docs/evidence/proposal-reference-runtime-20261108.json'
BASELINE_SHA256 = '7e351bc3b4b884d09af77f3dcc193307de28be55bb9474ed5950e72ba9410aa5'
CHECKS = ('default_worker_startup', 'legacy_context_bytes_retained', 'legacy_prompt_bytes_retained',
          'version2_context_bound', 'version2_business_guidance', 'history_excluded_from_prompt',
          'version2_scope_is_exact', 'commercial_schema_retained', 'localized_docx_verified',
          'inputs_unchanged', 'shutdown_drained')
PROBE_CHECKS = tuple(name for name in CHECKS if name not in ('default_worker_startup', 'shutdown_drained'))
BASELINE_CHECKS = ('legacy_context_bytes_retained', 'legacy_prompt_bytes_retained',
                   'commercial_schema_retained', 'localized_docx_verified', 'inputs_unchanged')
HARNESSES = ('backend/scripts/testing/commercial_v2_native.py', 'backend/scripts/testing/commercial_v2_native.ts')
LEGACY_CONTEXTS = {f'{version}:{kind}' for version in ('absent', '1') for kind in ('context', 'task_input')}
LEGACY_WIRES = {f'{language}:{phase}:{version}:{policy}' for language in ('en', 'ar')
                for phase in ('plan_commercial', 'repair_result', 'verify_grounding')
                for version in ('absent', '1') for policy in ('legacy', 'pinned')}
MODERN_WIRES = {f'{language}:{phase}:{policy}' for language in ('en', 'ar')
                for phase in ('plan_commercial', 'repair_result', 'verify_grounding')
                for policy in ('legacy', 'pinned')}
LANGUAGES = {'en', 'ar'}


def valid_hash(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


class NativeError(Exception):
    pass


def require(value, code):
    if not value:
        raise NativeError('COMMERCIAL_V2_NATIVE_' + code)


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
        raise NativeError('COMMERCIAL_V2_NATIVE_DOCKER_TIMEOUT') from None


def must(result, code):
    require(result.returncode == 0, code)
    return result.stdout


def baseline_receipt():
    path = ROOT / BASELINE_RECEIPT
    require(digest(path) == BASELINE_SHA256, 'BASELINE_RECEIPT_CHANGED')
    value = json.loads(path.read_text())
    require(value.get('image', {}).get('Id') == BASELINE_IMAGE, 'BASELINE_IMAGE_CHANGED')
    return value


def source_hashes(value):
    return {name: row['sha256'] for name, row in value['source']['source_entries'].items()
            if row['type'] == 'file'}


def copied_sources():
    result = {}
    roots = ('backend/supabase/functions', 'backend/scripts/runtime', 'frontend/public/fonts')
    for relative in roots:
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


def validate_metadata(metadata, image, historical):
    require(metadata.get('Id') == image and metadata.get('Os') == 'linux'
            and metadata.get('Architecture') == 'amd64', 'IMAGE_IDENTITY')
    config = metadata.get('Config', {})
    old = historical['image']['Config']
    require(config.get('Entrypoint') == old['Entrypoint'] == ['/tini', '--', 'docker-entrypoint.sh']
            and config.get('Cmd') == old['Cmd'] and config.get('User') == 'deno'
            and config.get('WorkingDir') == '/app/backend', 'ORIGINAL_ENTRYPOINT')
    if image == BASELINE_IMAGE:
        def identity(value):
            # Docker's array and formatted inspection serialize these absent
            # optional fields differently. Preserve every meaningful config
            # value rather than comparing their serialization shape.
            config = dict(value.get('Config', {}))
            for name in ('OnBuild', 'Volumes'):
                if config.get(name) is None:
                    config.pop(name, None)
            return {**{name: value.get(name) for name in ('Id', 'Os', 'Architecture', 'RootFS')},
                    'Variant': '' if value.get('Variant') is None else value['Variant'], 'Config': config}
        require(identity(metadata) == identity(historical['image']), 'BASELINE_METADATA_CHANGED')


def validate_probe(value, baseline, expected_sources):
    require(isinstance(value, dict) and value.get('version') == 1 and value.get('baseline') is baseline
            and value.get('passed') is True and value.get('provider_calls') == 0, 'PROBE_IDENTITY')
    require(value.get('source_sha256') == expected_sources, 'IMAGE_SOURCE_CHANGED')
    require(valid_hash(value.get('fixture_input_sha256')), 'INPUT_HASH_MISSING')
    for field, keys in (('legacy_context_sha256', LEGACY_CONTEXTS), ('legacy_wire_sha256', LEGACY_WIRES),
                        ('modern_wire_sha256', set() if baseline else MODERN_WIRES)):
        hashes = value.get(field)
        require(isinstance(hashes, dict) and set(hashes) == keys and
                all(valid_hash(h) for h in hashes.values()), 'WIRE_CASES_MISSING')
    renders = value.get('renders')
    require(isinstance(renders, dict) and set(renders) == LANGUAGES, 'RENDER_CASES_MISSING')
    for render in renders.values():
        require(isinstance(render, dict) and set(render) ==
                {'model_sha256', 'text_sha256', 'docx_sha256', 'bytes', 'verified', 'missing_tax_label'} and
                all(valid_hash(render.get(key)) for key in ('model_sha256', 'text_sha256', 'docx_sha256')) and
                type(render.get('bytes')) is int and 1000 < render['bytes'] < 5 * 1024 * 1024 and
                render.get('verified') is True and render.get('missing_tax_label') is True, 'RENDER_PROOF_INVALID')
    expected_checks = BASELINE_CHECKS if baseline else PROBE_CHECKS
    require(set(value.get('checks', {})) == set(expected_checks) and
            all(value['checks'][name] is True for name in expected_checks), 'PROBE_CHECK_MISSING')


def compare_cases(candidate, historical):
    require(candidate['fixture_input_sha256'] == historical['fixture_input_sha256'], 'CASE_INPUT_CHANGED')
    require(candidate['legacy_context_sha256'] == historical['legacy_context_sha256'] and
            candidate['legacy_wire_sha256'] == historical['legacy_wire_sha256'], 'LEGACY_BYTES_CHANGED')
    for language in LANGUAGES:
        require(all(candidate['renders'][language][key] == historical['renders'][language][key]
                    for key in ('model_sha256', 'text_sha256')), 'RENDER_CONTENT_CHANGED')
    for key, wire_hash in candidate['modern_wire_sha256'].items():
        language, phase, policy = key.split(':')
        require(wire_hash != historical['legacy_wire_sha256'][f'{language}:{phase}:absent:{policy}'], 'MODERN_WIRE_NOT_BOUND')


def owned_container(value, name, image):
    require(value.get('Name') == '/' + name and value.get('Image') == image
            and value.get('Config', {}).get('Labels', {}).get('tenderdesk.io/commercial-v2-native') == name,
            'FOREIGN_CONTAINER')
    container_id = value.get('Id')
    require(isinstance(container_id, str) and re.fullmatch('[a-f0-9]{64}', container_id), 'CONTAINER_ID')
    return container_id


def absent(result, identifier):
    stderr = getattr(result, 'stderr', '')
    return result.returncode != 0 and stderr.strip() in (
        'Error: No such object: ' + identifier,
        'Error: No such container: ' + identifier,
        'Error response from daemon: No such container: ' + identifier)


def probe(image, baseline, expected_sources, historical):
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', image) is not None, 'IMAGE_REFERENCE')
    metadata = json.loads(must(docker('image', 'inspect', image), 'IMAGE_INSPECTION'))[0]
    validate_metadata(metadata, image, historical)
    name = 'tdp-commercial-v2-native-' + os.urandom(6).hex()
    container_id = None
    value = None
    try:
        must(docker('run', '-d', '--name', name, '--network', 'none', '--read-only',
            '--label', 'tenderdesk.io/commercial-v2-native=' + name,
            '--memory', '1280m', '--cpus', '2', '--pids-limit', '128', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
            '--mount', f'type=bind,src={SCRIPT},dst=/native-fixture.ts,readonly',
            '-e', 'APP_RUNTIME_SERVICE=worker', '-e', 'SUPABASE_URL=http://127.0.0.1:9',
            '-e', 'APP_SUPABASE_PUBLISHABLE_KEY=synthetic-public', '-e', 'SUPABASE_SERVICE_ROLE_KEY=synthetic-service',
            '-e', 'APP_WORKER_SECRET=synthetic-worker', '-e', 'NO_PROXY=127.0.0.1,localhost',
            '-e', 'no_proxy=127.0.0.1,localhost', image), 'CONTAINER_START')
        container = json.loads(must(docker('inspect', name), 'CONTAINER_INSPECTION'))[0]
        container_id = owned_container(container, name, image)
        health = None
        for _ in range(50):
            response = docker('exec', container_id, '/bin/busybox', 'wget', '-Y', 'off', '-qO-', 'http://127.0.0.1:8080/healthz')
            if response.returncode == 0:
                health = json.loads(response.stdout)
                break
            time.sleep(0.1)
        require(health == {'status': 'ready', 'component': 'worker'}, 'DEFAULT_WORKER_STARTUP')
        require(container['HostConfig']['NetworkMode'] == 'none' and container['HostConfig']['ReadonlyRootfs'], 'ISOLATION')
        mounts = container.get('Mounts', [])
        binds = [mount for mount in mounts if mount.get('Type') == 'bind']
        require(len(binds) == 1 and binds[0].get('Source') == str(SCRIPT)
                and binds[0].get('Destination') == '/native-fixture.ts' and binds[0].get('RW') is False
                and all(mount in binds or mount.get('Type') == 'tmpfs' and mount.get('Destination') == '/tmp'
                        for mount in mounts),
                'PRODUCT_OVERLAY')
        raw = must(docker('exec', '-e', 'NATIVE_BASELINE_MODE=' + ('true' if baseline else 'false'), container_id,
            '/bin/deno', 'run', '--cached-only', '--frozen', '--config=/app/backend/supabase/functions/deno.json',
            '--allow-env=NATIVE_BASELINE_MODE', '--allow-read=/app,/deno-dir,/native-fixture.ts', '/native-fixture.ts'),
            'COMMERCIAL_PROBE')
        value = json.loads(raw)
        validate_probe(value, baseline, expected_sources)
        must(docker('stop', '--time', '5', container_id), 'SHUTDOWN')
        state = json.loads(must(docker('inspect', container_id), 'STOP_INSPECTION'))[0]['State']
        require(not state['Running'] and state['ExitCode'] == 0 and not state['OOMKilled'], 'SHUTDOWN_NOT_DRAINED')
        value['checks'].update(default_worker_startup=True, shutdown_drained=True)
    finally:
        # A failed/ambiguous docker run may still have created the owned name.
        identifier = container_id or name
        found = docker('inspect', identifier)
        if found.returncode == 0:
            owned_id = owned_container(json.loads(found.stdout)[0], name, image)
            require(container_id is None or owned_id == container_id, 'CONTAINER_ID_CHANGED')
            must(docker('rm', '-f', owned_id, timeout=10), 'CLEANUP')
            require(absent(docker('inspect', owned_id), owned_id), 'CLEANUP_UNCONFIRMED')
        else:
            require(absent(found, identifier), 'CLEANUP_INSPECTION_FAILED')
    return value


def run(image):
    require(image != BASELINE_IMAGE, 'CANDIDATE_IS_BASELINE')
    historical = baseline_receipt()
    sources = copied_sources()
    harnesses = {name: digest(ROOT / name) for name in HARNESSES}
    start = time.monotonic()
    baseline = probe(BASELINE_IMAGE, True, source_hashes(historical), historical)
    candidate = probe(image, False, sources, historical)
    compare_cases(candidate, baseline)
    require(copied_sources() == sources and {name: digest(ROOT / name) for name in HARNESSES} == harnesses, 'SOURCE_CHANGED_DURING_PROBE')
    checks = candidate['checks']
    require(all(checks.get(name) is True for name in CHECKS), 'FINAL_CHECK_MISSING')
    return {**candidate, 'version': 1, 'kind': 'proposal_commercial_v2_native', 'image_id': image,
        'passed': True, 'checks': checks,
        'baseline': {key: baseline[key] for key in ('fixture_input_sha256', 'legacy_context_sha256', 'legacy_wire_sha256', 'renders')},
        'baseline_image_id': BASELINE_IMAGE, 'baseline_source_sha256': baseline['source_sha256'],
        'baseline_qualification_sha256': BASELINE_SHA256,
        'harness_sha256': harnesses, 'actual_image_entrypoint': True, 'network': 'none', 'external_calls': 0,
        'provider_calls': 0, 'cleanup_verified': True, 'hosted_acceptance': False,
        'duration_seconds': round(time.monotonic() - start, 3),
        'limits': ['Actual immutable-image context/prompt/render/verify functions with synthetic data; no database or external provider.',
                   'DOCX proof checks generated archive content, not visual layout or customer issuance; dispatch/prompt/poll controls are separate.']}


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
