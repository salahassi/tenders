#!/usr/bin/env python3
"""Offline UUID boundary proof in actual candidate and frozen accepted-poll images.

Both images start their original worker entrypoint. Only this harness is mounted;
the Deno function probe has no network permission and imports product files from
/app. Calls the actual exported grounding validator; hosted generation is a separate gate.
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
BASELINE_IMAGE = 'sha256:492d0716ec1a9aa8a301fadd84201e60367da675d69cb3228e5cf2b501abe83d'
BASELINE_RECEIPT = 'backend/docs/evidence/proposal-poll-runtime-20261108.json'
BASELINE_SHA256 = '1557117fc44b44ff3c5f9beb5244edf3bdb3a0fa67cbff83193a18790dd40c5f'
CHECKS = ('default_worker_startup', 'known_identifier_colon_punctuation',
          'unknown_or_extended_identifiers_rejected', 'unsupported_factual_numbers_rejected',
          'existing_reference_behavior_retained', 'inputs_unchanged',
          'baseline_regression_reproduced', 'shutdown_drained')
PROBE_CHECKS = tuple(name for name in CHECKS if name not in
                    ('default_worker_startup', 'baseline_regression_reproduced', 'shutdown_drained'))
HARNESSES = ('backend/scripts/testing/boundary_native.py', 'backend/scripts/testing/boundary_native.ts')
COLON_CASES = {f'known_{kind}_colon_{delimiter}' for kind in ('plain', 'namespaced', 'requirement')
               for delimiter in ('space', 'double_quote', 'single_quote', 'left_double', 'right_double',
                                 'left_single', 'right_single', 'end')}
UNKNOWN_CASES = {'unknown_uuid', 'unknown_namespace', 'wrapped_namespace', 'colon_suffix', 'colon_version',
                 'double_colon', 'embedded_prefix', 'underscore_suffix', 'namespaced_suffix', 'unscoped_requirement'}
NUMBER_CASES = {'adjacent_quantity', 'quoted_quantity', 'preceding_price', 'arabic_quantity',
                'namespaced_quantity', 'requirement_quantity'}
RETAINED_CASES = {'plain_parentheses', 'namespaced_period', 'requirement_parentheses', 'supported_quantity'}
CASES = COLON_CASES | UNKNOWN_CASES | NUMBER_CASES | RETAINED_CASES


def expected_case(name, baseline):
    accepted = name in RETAINED_CASES or name in COLON_CASES and not baseline
    return {'accepted': accepted, 'error_code': None if accepted else 'EVIDENCE_REFERENCE_INVALID',
            'diagnostic_reasons': [] if accepted else ['numeric_evidence_mismatch']}


class NativeError(Exception):
    pass


def require(value, code):
    if not value:
        raise NativeError('REFERENCE_BOUNDARY_NATIVE_' + code)


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
        raise NativeError('REFERENCE_BOUNDARY_NATIVE_DOCKER_TIMEOUT') from None


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
    results, hashes = value.get('case_results'), value.get('case_input_sha256')
    require(isinstance(results, dict) and set(results) == CASES and
            isinstance(hashes, dict) and set(hashes) == CASES and
            all(isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) for v in hashes.values()), 'CASES_MISSING')
    require(all(results[name] == expected_case(name, baseline) for name in CASES), 'CASE_OUTCOME_CHANGED')
    require(set(value.get('checks', {})) == set(PROBE_CHECKS) and
            all(value['checks'][name] is True for name in PROBE_CHECKS), 'PROBE_CHECK_MISSING')


def compare_cases(candidate, historical):
    require(candidate['case_input_sha256'] == historical['case_input_sha256'], 'CASE_INPUT_CHANGED')
    require(all(candidate['case_results'][name] == historical['case_results'][name]
                for name in UNKNOWN_CASES | NUMBER_CASES | RETAINED_CASES), 'RETAINED_BEHAVIOR_CHANGED')
    require(all(candidate['case_results'][name] == expected_case(name, False) and
                historical['case_results'][name] == expected_case(name, True)
                for name in COLON_CASES), 'BASELINE_REGRESSION_MISSING')


def owned_container(value, name, image):
    require(value.get('Name') == '/' + name and value.get('Image') == image
            and value.get('Config', {}).get('Labels', {}).get('tenderdesk.io/reference-boundary-native') == name,
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
    name = 'tdp-reference-boundary-native-' + os.urandom(6).hex()
    container_id = None
    value = None
    try:
        must(docker('run', '-d', '--name', name, '--network', 'none', '--read-only',
            '--label', 'tenderdesk.io/reference-boundary-native=' + name,
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
            'BOUNDARY_PROBE')
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
    checks = {**candidate['checks'], 'baseline_regression_reproduced': True}
    require(all(checks.get(name) is True for name in CHECKS), 'FINAL_CHECK_MISSING')
    return {**candidate, 'version': 1, 'kind': 'proposal_reference_boundary_native', 'image_id': image,
        'passed': True, 'checks': checks,
        'baseline': {key: baseline[key] for key in ('case_results', 'case_input_sha256')},
        'baseline_image_id': BASELINE_IMAGE, 'baseline_source_sha256': baseline['source_sha256'],
        'baseline_qualification_sha256': BASELINE_SHA256,
        'harness_sha256': harnesses, 'actual_image_entrypoint': True, 'network': 'none', 'external_calls': 0,
        'provider_calls': 0, 'cleanup_verified': True, 'hosted_acceptance': False,
        'duration_seconds': round(time.monotonic() - start, 3),
        'limits': ['Actual immutable-image validateGroundingReport with synthetic evidence and candidates; no database or external provider.',
                   'Dispatch, prompt, accepted-poll behavior and hosted issuance require their separate receipts.']}


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
