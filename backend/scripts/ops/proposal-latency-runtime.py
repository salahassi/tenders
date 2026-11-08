#!/usr/bin/env python3
"""Separate worker/scheduler qualification for versioned proposal latency changes.

Historical dispatch evidence stays immutable. The candidate requires its own
offline native dispatch and prompt-compatibility receipts before publication.
Adaptive-poll SQL is qualified and released separately against its own ledger.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


# Reuse pure source/image/registry controls through a separate module instance.
# No historical constants, receipt bytes or validation functions are overridden.
dispatch = module('latency_dispatch_primitives', 'proposal-dispatch-runtime.py')
BASE, REGISTRY, RECIPE = dispatch.BASE, dispatch.REGISTRY, dispatch.RECIPE
SUPPLEMENTARY, source_guard = dispatch.SUPPLEMENTARY, dispatch.source_guard
snapshot, image_metadata, image_identity = dispatch.snapshot, dispatch.image_metadata, dispatch.image_identity
source_hashes, app_files, registry_identity = dispatch.source_hashes, dispatch.app_files, dispatch.registry_identity
verify_image, docker, sha = dispatch.verify_image, dispatch.docker, dispatch.sha
RECEIPT = 'backend/docs/evidence/proposal-latency-runtime-20261108.json'
PUBLICATION = 'backend/docs/evidence/proposal-latency-publication-20261108.json'
POLL_MIGRATION = 'backend/supabase/migrations/20261108180821_healthy_model_poll_backoff.sql'
# Freeze only after actual native evidence is captured. Preparation is not proof.
RECEIPT_SHA256 = '12e8e13ce4f1c3e05f0a4554036a7cc5ae7ac11ddd259d192cf510b4c150e19e'
BASELINE_REFERENCE = REGISTRY + '@sha256:c6f7cce500dbec1b6028668ca7677d3026dc41a927f2972fb84dc0330e94a606'
BASELINE_IMAGE = 'sha256:4b04acaa20d627581cdeb9669d603653633ae5b6d435e673232ff943f983b431'
BASELINE_PUBLICATION_SHA256 = '6f08994d80d1e052c5ce33be24172fa02e823a49e9b73f55e296c3f3d70fb59c'
PROMPT_HARNESSES = ('backend/scripts/testing/latency_prompt_native.py',
                    'backend/scripts/testing/latency_prompt_native.ts')
DISPATCH_CHECKS = ('worker_authentication', 'worker_foreground_maintenance_auth_no_rpc',
                   'worker_idle_prompt', 'worker_ready_response_before_maintenance',
                   'worker_poll_delay_returned_without_sleep', 'scheduler_maintenance_independent',
                   'scheduler_completion_metadata', 'scheduler_failure_retry', 'shutdown_drained')
PROMPT_CHECKS = ('default_worker_startup', 'legacy_prompt_bytes_match_baseline', 'legacy_phase_pins_retained',
                'started_phase_uses_legacy', 'new_phase_revision6_pinned', 'compact_evidence_lossless',
                'literal_coverage_exact', 'forged_literal_rejected', 'changed_pin_rejected',
                'new_pins_replay_exact', 'flexible_input_contract_preserved', 'shutdown_drained')
LEGACY_CASES = {f'{task}:{language}:s{semantic}:v1' for language in ('en', 'ar')
                for semantic in range(6) for task in ('analyze_chunk', 'repair_result')} | {
                f'verify_grounding:{language}:s{semantic}:v{verification}' for language in ('en', 'ar')
                for semantic in range(6) for verification in range(1, 6)}


class QualificationError(Exception):
    pass


def require(value, code):
    if not value:
        raise QualificationError('LATENCY_QUALIFICATION_' + code)


def assert_source_revision(revision):
    require(isinstance(revision, str) and re.fullmatch('[a-f0-9]{40}', revision), 'SOURCE_REVISION')
    observed = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    require(observed == revision, 'SOURCE_HEAD_CHANGED')
    inputs = [*source_guard.COPY_ROOTS, *SUPPLEMENTARY, POLL_MIGRATION]
    require(not subprocess.check_output(['git', '-C', str(ROOT), 'diff', 'HEAD', '--', *inputs]), 'BUILD_SOURCE_DIRTY')
    tracked = subprocess.check_output(['git', '-C', str(ROOT), 'ls-files', '--', POLL_MIGRATION], text=True).strip()
    require(tracked == POLL_MIGRATION, 'POLL_MIGRATION_UNTRACKED')


def poll_migration(root=ROOT):
    path = root / POLL_MIGRATION
    require(path.is_file() and not any(parent.is_symlink() for parent in (path, *path.parents)), 'POLL_MIGRATION_MISSING')
    return {'path': POLL_MIGRATION, 'sha256': sha(path)}


def historical(root=ROOT):
    receipt = dispatch.read_bound(root, {'path': dispatch.RECEIPT, 'sha256': dispatch.RECEIPT_SHA256})
    require(receipt.get('image', {}).get('Id') == BASELINE_IMAGE
            and receipt.get('scope') == ['worker', 'scheduler'], 'HISTORICAL_IDENTITY')
    publication = dispatch.read_bound(root, {'path': dispatch.PUBLICATION, 'sha256': BASELINE_PUBLICATION_SHA256})
    require(publication.get('qualification_sha256') == dispatch.RECEIPT_SHA256
            and publication.get('image_id') == BASELINE_IMAGE
            and publication.get('reference') == BASELINE_REFERENCE
            and publication.get('source_revision') == receipt['source_revision'], 'HISTORICAL_PUBLICATION')
    return receipt


def validate_prompt_native(value, receipt, root=ROOT):
    baseline = historical(root)
    require(value.get('version') == 1 and value.get('kind') == 'proposal_latency_prompt_native'
            and value.get('image_id') == receipt['image']['Id'] and value.get('passed') is True
            and value.get('actual_image_entrypoint') is True and value.get('network') == 'none'
            and value.get('external_calls') == 0 and value.get('provider_calls') == 0
            and value.get('cleanup_verified') is True, 'PROMPT_NATIVE_IDENTITY')
    require(value.get('source_sha256') == source_hashes(receipt['source'])
            and value.get('baseline_image_id') == BASELINE_IMAGE
            and value.get('baseline_source_sha256') == source_hashes(baseline['source'])
            and value.get('baseline_qualification_sha256') == dispatch.RECEIPT_SHA256,
            'PROMPT_NATIVE_SOURCE')
    require(all(value.get('checks', {}).get(name) is True for name in PROMPT_CHECKS), 'PROMPT_NATIVE_CHECKS')
    require(value.get('semantic_revisions') == list(range(6))
            and value.get('verification_revisions') == list(range(1, 6))
            and value.get('new_semantic_revision') == 6 and value.get('new_verification_revision') == 6
            and type(value.get('legacy_case_count')) is int and value['legacy_case_count'] == 84
            and value.get('legacy_pin_count') == 11,
            'PROMPT_NATIVE_COVERAGE')
    legacy = value.get('legacy_prompt_sha256', {})
    prior = value.get('baseline', {})
    require(isinstance(legacy, dict) and set(legacy) == LEGACY_CASES
            and all(isinstance(digest, str) and re.fullmatch('[a-f0-9]{64}', digest) for digest in legacy.values())
            and isinstance(prior, dict) and prior.get('image_id') == BASELINE_IMAGE
            and prior.get('receipt_sha256') == dispatch.RECEIPT_SHA256
            and prior.get('source_sha256') == value['baseline_source_sha256']
            and legacy == prior.get('legacy_prompt_sha256')
            and isinstance(value.get('legacy_pins_sha256'), str)
            and re.fullmatch('[a-f0-9]{64}', value['legacy_pins_sha256'])
            and value['legacy_pins_sha256'] == prior.get('legacy_pins_sha256'), 'PROMPT_NATIVE_LEGACY_BYTES')
    require(set(value.get('harness_sha256', {})) == set(PROMPT_HARNESSES), 'PROMPT_NATIVE_HARNESS')
    for name, expected in value['harness_sha256'].items():
        path = root / name
        require(path.is_file() and not path.is_symlink() and sha(path) == expected, 'PROMPT_NATIVE_HARNESS_CHANGED')


def validate_receipt(root, receipt):
    require(receipt.get('kind') == 'proposal_latency_runtime', 'RECEIPT_KIND')
    require(receipt.get('image', {}).get('Id') != BASELINE_IMAGE, 'CANDIDATE_UNCHANGED')
    dispatch.validate_receipt(root, receipt)
    native = dispatch.read_bound(root, receipt['native'])
    require(all(native.get('checks', {}).get(name) is True for name in DISPATCH_CHECKS), 'DISPATCH_NATIVE_CHECKS')
    require(receipt.get('baseline') == {'reference': BASELINE_REFERENCE, 'image_id': BASELINE_IMAGE,
            'qualification_sha256': dispatch.RECEIPT_SHA256}, 'BASELINE_BINDING')
    require(receipt.get('poll_sql_qualified') is False, 'SQL_SCOPE')
    require(receipt.get('poll_migration') == poll_migration(root), 'POLL_MIGRATION_CHANGED')
    require(dispatch.read_bound(root, receipt['build']).get('poll_migration') == receipt['poll_migration'],
            'BUILD_POLL_BINDING')
    validate_prompt_native(dispatch.read_bound(root, receipt['prompt_native']), receipt, root)
    return receipt


def load(root=ROOT):
    require(isinstance(RECEIPT_SHA256, str) and re.fullmatch('[a-f0-9]{64}', RECEIPT_SHA256), 'NOT_FROZEN')
    return validate_receipt(root, dispatch.read_bound(root, {'path': RECEIPT, 'sha256': RECEIPT_SHA256}))


def publication(root=ROOT):
    receipt = load(root)
    path = root / PUBLICATION
    require(path.is_file() and not path.is_symlink(), 'PUBLICATION_MISSING')
    value = json.loads(path.read_text())
    require(value.get('version') == 1 and value.get('image_id') == receipt['image']['Id']
            and value.get('qualification_sha256') == RECEIPT_SHA256
            and value.get('source_revision') == receipt['source_revision']
            and value.get('scope') == ['worker', 'scheduler'], 'PUBLICATION_BINDING')
    reference = value.get('reference', '')
    require(re.fullmatch(re.escape(REGISTRY) + r'@sha256:[a-f0-9]{64}', reference), 'PUBLICATION_REFERENCE')
    return receipt, reference


def capture(args):
    revision = args.source_revision
    assert_source_revision(revision)
    require(not (ROOT / RECEIPT).exists(), 'RECEIPT_EXISTS')
    image, base = image_metadata(args.image), image_metadata(BASE)
    require(BASE in base.get('RepoDigests', []), 'BASE_DIGEST')
    value = {'version': 1, 'kind': 'proposal_latency_runtime', 'scope': ['worker', 'scheduler'],
             'source_revision': revision, 'base': BASE, 'image': image_identity(image),
             'base_image': image_identity(base), 'source': snapshot(), 'app_sha256': app_files(image['Id']),
             'baseline': {'reference': BASELINE_REFERENCE, 'image_id': BASELINE_IMAGE,
                          'qualification_sha256': dispatch.RECEIPT_SHA256}, 'poll_sql_qualified': False,
             'poll_migration': poll_migration()}
    for field in ('build', 'native', 'prompt_native'):
        path = Path(getattr(args, field)).resolve()
        value[field] = {'path': path.relative_to(ROOT).as_posix(), 'sha256': sha(path)}
    validate_receipt(ROOT, value)
    assert_source_revision(revision)
    require(value['source'] == snapshot(), 'CAPTURE_SOURCE_CHANGED')
    require(value['poll_migration'] == poll_migration(), 'CAPTURE_POLL_CHANGED')
    dispatch.write_new(ROOT / RECEIPT, value)
    print(json.dumps({'qualification': 'captured', 'sha256': sha(ROOT / RECEIPT), 'image_id': image['Id'],
                      'scope': value['scope']}))


def build(args):
    """Explicit local build; never invoked by qualification or deployment checks."""
    revision = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    require(args.source_revision == revision, 'BUILD_REVISION')
    assert_source_revision(revision)
    inputs = [*source_guard.COPY_ROOTS, *SUPPLEMENTARY]
    before = snapshot()
    policy_before = poll_migration()
    base = image_metadata(BASE)
    require(BASE in base.get('RepoDigests', []), 'BUILD_BASE_MISSING')
    source_guard.verify_image(base, source_guard.load(ROOT))
    output = Path(args.build).resolve()
    require(output.is_relative_to(ROOT) and not output.exists(), 'BUILD_RECEIPT_PATH')
    log = output.with_suffix('.log')
    require(not log.exists(), 'BUILD_LOG_EXISTS')
    tag = 'tenderdesk-latency:' + revision
    environment = dict(os.environ)
    for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'):
        environment.pop(key, None)
    with tempfile.TemporaryDirectory(prefix='td-latency-build-') as directory:
        context = Path(directory)
        for name in inputs:
            destination = context / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            if (ROOT / name).is_dir():
                shutil.copytree(ROOT / name, destination)
            else:
                shutil.copy2(ROOT / name, destination)
        with log.open('x') as stream:
            result = subprocess.run(['docker', '--host=unix:///var/run/docker.sock', 'build', '--platform=linux/amd64',
                '--pull=false', '--network=none', '--progress=plain', '--file', RECIPE, '--label',
                'org.opencontainers.image.revision=' + revision, '--tag', tag, str(context)],
                cwd=context, env=environment, stdout=stream, stderr=subprocess.STDOUT, timeout=150)
    require(result.returncode == 0, 'BUILD_FAILED')
    after = snapshot()
    require(before == after, 'BUILD_SOURCE_CHANGED')
    require(policy_before == poll_migration(), 'BUILD_POLL_CHANGED')
    assert_source_revision(revision)
    image = image_metadata(tag)['Id']
    value = {'version': 1, 'image_id': image, 'source_revision': revision, 'build_exit_code': 0,
             'source_before': before, 'source_after': after, 'recipe': RECIPE, 'base': BASE,
             'build_log_sha256': sha(log), 'network': 'none',
             'poll_migration': policy_before,
             'context': 'Exact copied roots and supplementary inputs only; no scratch or private files.'}
    dispatch.write_new(output, value)
    print(json.dumps({'build': 'passed', 'image_id': image, 'source_revision': revision}))


def publish():
    require(not (ROOT / PUBLICATION).exists(), 'PUBLICATION_EXISTS')
    receipt = load()
    image_id = receipt['image']['Id']
    verify_image(image_metadata(image_id), receipt)
    require(app_files(image_id) == receipt['app_sha256'], 'PUBLISH_SOURCE')
    runner = module('latency_registry_credentials', 'digitalocean-runner.py')
    tag = REGISTRY + ':proposal-latency-' + receipt['source_revision']
    with tempfile.TemporaryDirectory(prefix='td-latency-publish-') as directory:
        path = Path(directory)
        path.chmod(0o700)
        runner.write(path / 'config.json', runner.docker_credentials(write_access=True))
        environment = {**os.environ, 'DOCKER_CONFIG': str(path)}
        docker('tag', image_id, tag, env=environment)
        docker('push', tag, timeout=120, env=environment)
        observed = image_metadata(tag)
        references = [ref for ref in observed.get('RepoDigests', [])
                      if re.fullmatch(re.escape(REGISTRY) + r'@sha256:[a-f0-9]{64}', ref)]
        require(len(set(references)) == 1, 'PUBLISHED_IDENTITY')
        reference = references[0]
        verify_image(observed, receipt, reference)
        docker('pull', reference, timeout=60, env=environment)
        verify_image(image_metadata(reference), receipt, reference)
        require(app_files(reference) == receipt['app_sha256'], 'PUBLISHED_SOURCE')
    dispatch.write_new(ROOT / PUBLICATION, {'version': 1, 'reference': reference, 'image_id': image_id,
        'qualification_sha256': RECEIPT_SHA256, 'source_revision': receipt['source_revision'],
        'scope': ['worker', 'scheduler'], 'temporary_credentials_removed': True})
    print(json.dumps({'publication': 'passed', 'reference': reference, 'image_id': image_id}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('snapshot', 'build', 'capture', 'verify', 'publish'))
    parser.add_argument('--image')
    parser.add_argument('--source-revision')
    parser.add_argument('--native')
    parser.add_argument('--prompt-native')
    parser.add_argument('--build')
    args = parser.parse_args()
    try:
        if args.mode == 'snapshot': print(json.dumps(snapshot(), sort_keys=True))
        elif args.mode == 'build': build(args)
        elif args.mode == 'capture': capture(args)
        elif args.mode == 'publish': publish()
        else:
            receipt = load()
            print(json.dumps({'qualification': 'passed', 'scope': receipt['scope'], 'image_id': receipt['image']['Id']}))
        return 0
    except Exception as error:
        code = str(error) if re.fullmatch('[A-Z][A-Z0-9_]{0,99}', str(error)) else 'LATENCY_QUALIFICATION_FAILED'
        print(json.dumps({'qualification': 'blocked', 'code': code}), flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
