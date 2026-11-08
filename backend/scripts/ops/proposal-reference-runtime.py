#!/usr/bin/env python3
"""Separate immutable image qualification for exact reference boundaries.

Existing dispatch, prompt and polling controls remain mandatory. Only the
grounding validator source may differ from the currently deployed image; SQL,
all other runtime inputs and historical receipts remain unchanged.
"""
import argparse
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


previous = module('reference_poll_primitives', 'proposal-poll-runtime.py')
latency, dispatch = previous.latency, previous.dispatch
BASE, REGISTRY, RECIPE = dispatch.BASE, dispatch.REGISTRY, dispatch.RECIPE
SUPPLEMENTARY, source_guard = dispatch.SUPPLEMENTARY, dispatch.source_guard
snapshot, image_metadata, image_identity = dispatch.snapshot, dispatch.image_metadata, dispatch.image_identity
source_hashes, app_files, registry_identity = dispatch.source_hashes, dispatch.app_files, dispatch.registry_identity
verify_image, docker, sha = dispatch.verify_image, dispatch.docker, dispatch.sha
RECEIPT = 'backend/docs/evidence/proposal-reference-runtime-20261108.json'
PUBLICATION = 'backend/docs/evidence/proposal-reference-publication-20261108.json'
PENDING_POLL_MIGRATION = 'backend/supabase/migrations/20261108194639_prepare_accepted_model_poll.sql'
RECEIPT_SHA256 = None  # Freeze only after actual candidate native evidence is captured.
BASELINE_REFERENCE = REGISTRY + '@sha256:b5e14c0e78a3625448bfa7c1a86d27749bfd9649f48859aa0628c0f26c935619'
BASELINE_IMAGE = 'sha256:492d0716ec1a9aa8a301fadd84201e60367da675d69cb3228e5cf2b501abe83d'
BASELINE_PUBLICATION_SHA256 = '56d2d337827a0b34095b442a491a65851d430678c837b80cf973b1d9987646ef'
CHANGED_SOURCE = 'backend/supabase/functions/_shared/modelGrounding.ts'
BOUNDARY_HARNESSES = ('backend/scripts/testing/boundary_native.py', 'backend/scripts/testing/boundary_native.ts')
BOUNDARY_CHECKS = ('default_worker_startup', 'known_identifier_colon_punctuation',
    'unknown_or_extended_identifiers_rejected', 'unsupported_factual_numbers_rejected',
    'existing_reference_behavior_retained', 'inputs_unchanged', 'baseline_regression_reproduced', 'shutdown_drained')
COLON_CASES = {f'known_{kind}_colon_{delimiter}' for kind in ('plain', 'namespaced', 'requirement')
    for delimiter in ('space', 'double_quote', 'single_quote', 'left_double', 'right_double',
        'left_single', 'right_single', 'end')}
UNKNOWN_CASES = {'unknown_uuid', 'unknown_namespace', 'wrapped_namespace', 'colon_suffix', 'colon_version',
    'double_colon', 'embedded_prefix', 'underscore_suffix', 'namespaced_suffix', 'unscoped_requirement'}
NUMBER_CASES = {'adjacent_quantity', 'quoted_quantity', 'preceding_price', 'arabic_quantity',
    'namespaced_quantity', 'requirement_quantity'}
RETAINED_CASES = {'plain_parentheses', 'namespaced_period', 'requirement_parentheses', 'supported_quantity'}
BOUNDARY_CASES = COLON_CASES | UNKNOWN_CASES | NUMBER_CASES | RETAINED_CASES


class QualificationError(Exception):
    pass


def require(value, code):
    if not value:
        raise QualificationError('REFERENCE_QUALIFICATION_' + code)


assert_source_revision = previous.assert_source_revision


def policy_migrations(root=ROOT):
    values = previous.policy_migrations(root)
    baseline = historical(root)
    require(all(value == baseline.get(key) for key, value in values.items()), 'SQL_POLICY_CHANGED')
    return values


def validate_source_scope(source, baseline):
    require(isinstance(source, dict) and isinstance(baseline, dict)
        and set(source) == set(baseline) == {'source_entries', 'supplementary_inputs'}
        and source['supplementary_inputs'] == baseline['supplementary_inputs'], 'SUPPLEMENTARY_CHANGED')
    current, prior = source['source_entries'], baseline['source_entries']
    require(isinstance(current, dict) and isinstance(prior, dict) and set(current) == set(prior)
        and {key for key in current if current[key] != prior[key]} == {CHANGED_SOURCE}, 'SOURCE_SCOPE_CHANGED')
    require(current[CHANGED_SOURCE].get('type') == prior[CHANGED_SOURCE].get('type') == 'file'
        and current[CHANGED_SOURCE].get('git_mode') == prior[CHANGED_SOURCE].get('git_mode')
        and current[CHANGED_SOURCE].get('sha256') != prior[CHANGED_SOURCE].get('sha256'), 'GROUNDING_SOURCE_UNCHANGED')


def historical(root=ROOT):
    receipt = dispatch.read_bound(root, {'path': previous.RECEIPT, 'sha256': previous.RECEIPT_SHA256})
    require(receipt.get('image', {}).get('Id') == BASELINE_IMAGE and receipt.get('scope') == ['worker', 'scheduler'],
            'HISTORICAL_IDENTITY')
    publication = dispatch.read_bound(root, {'path': previous.PUBLICATION, 'sha256': BASELINE_PUBLICATION_SHA256})
    require(publication.get('image_id') == BASELINE_IMAGE and publication.get('reference') == BASELINE_REFERENCE
            and publication.get('qualification_sha256') == previous.RECEIPT_SHA256
            and publication.get('source_revision') == receipt['source_revision'], 'HISTORICAL_PUBLICATION')
    return receipt


def validate_boundary_native(value, receipt, root=ROOT):
    baseline = historical(root)
    require(value.get('version') == 1 and value.get('kind') == 'proposal_reference_boundary_native'
        and value.get('image_id') == receipt['image']['Id'] and value.get('passed') is True
        and value.get('actual_image_entrypoint') is True and value.get('network') == 'none'
        and value.get('external_calls') == 0 and value.get('provider_calls') == 0
        and value.get('cleanup_verified') is True, 'BOUNDARY_NATIVE_IDENTITY')
    require(value.get('source_sha256') == source_hashes(receipt['source'])
        and value.get('baseline_image_id') == BASELINE_IMAGE
        and value.get('baseline_source_sha256') == source_hashes(baseline['source'])
        and value.get('baseline_qualification_sha256') == previous.RECEIPT_SHA256, 'BOUNDARY_NATIVE_SOURCE')
    require(all(value.get('checks', {}).get(name) is True for name in BOUNDARY_CHECKS), 'BOUNDARY_NATIVE_CHECKS')
    for observed, is_baseline in ((value, False), (value.get('baseline', {}), True)):
        cases, hashes = observed.get('case_results'), observed.get('case_input_sha256')
        require(isinstance(cases, dict) and set(cases) == BOUNDARY_CASES
            and isinstance(hashes, dict) and set(hashes) == BOUNDARY_CASES
            and all(isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) for v in hashes.values()), 'BOUNDARY_NATIVE_CASES')
        for name, result in cases.items():
            accepted = name in RETAINED_CASES or name in COLON_CASES and not is_baseline
            expected = {'accepted': accepted, 'error_code': None if accepted else 'EVIDENCE_REFERENCE_INVALID',
                'diagnostic_reasons': [] if accepted else ['numeric_evidence_mismatch']}
            require(isinstance(result, dict) and type(result.get('accepted')) is bool and result == expected,
                'BOUNDARY_NATIVE_OUTCOME')
    require(value['case_input_sha256'] == value['baseline']['case_input_sha256'], 'BOUNDARY_NATIVE_INPUT_CHANGED')
    require(set(value.get('harness_sha256', {})) == set(BOUNDARY_HARNESSES), 'BOUNDARY_NATIVE_HARNESS')
    for name, expected in value['harness_sha256'].items():
        path = root / name
        require(path.is_file() and not path.is_symlink() and sha(path) == expected, 'BOUNDARY_NATIVE_HARNESS_CHANGED')


def validate_receipt(root, receipt):
    require(receipt.get('kind') == 'proposal_reference_runtime'
            and receipt.get('image', {}).get('Id') != BASELINE_IMAGE, 'RECEIPT_IDENTITY')
    dispatch.validate_receipt(root, receipt)
    validate_source_scope(receipt['source'], historical(root)['source'])
    native = dispatch.read_bound(root, receipt['native'])
    require(all(native.get('checks', {}).get(name) is True for name in latency.DISPATCH_CHECKS), 'DISPATCH_NATIVE_CHECKS')
    require(receipt.get('baseline') == {'reference': BASELINE_REFERENCE, 'image_id': BASELINE_IMAGE,
            'qualification_sha256': previous.RECEIPT_SHA256}, 'BASELINE_BINDING')
    require(receipt.get('poll_sql_qualified') is False, 'SQL_SCOPE')
    policies = policy_migrations(root)
    build_receipt = dispatch.read_bound(root, receipt['build'])
    require(all(receipt.get(k) == v == build_receipt.get(k) for k, v in policies.items()), 'POLL_SQL_BINDING')
    latency.validate_prompt_native(dispatch.read_bound(root, receipt['prompt_native']), receipt, root)
    previous.validate_poll_native(dispatch.read_bound(root, receipt['poll_native']), receipt, root)
    validate_boundary_native(dispatch.read_bound(root, receipt['boundary_native']), receipt, root)
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
    value = {'version': 1, 'kind': 'proposal_reference_runtime', 'scope': ['worker', 'scheduler'],
        'source_revision': revision, 'base': BASE, 'image': image_identity(image), 'base_image': image_identity(base),
        'source': snapshot(), 'app_sha256': app_files(image['Id']), 'poll_sql_qualified': False,
        'baseline': {'reference': BASELINE_REFERENCE, 'image_id': BASELINE_IMAGE,
                     'qualification_sha256': previous.RECEIPT_SHA256}, **policy_migrations()}
    for field in ('build', 'native', 'prompt_native', 'poll_native', 'boundary_native'):
        path = Path(getattr(args, field)).resolve()
        value[field] = {'path': path.relative_to(ROOT).as_posix(), 'sha256': sha(path)}
    validate_receipt(ROOT, value)
    assert_source_revision(revision)
    require(value['source'] == snapshot(), 'CAPTURE_SOURCE_CHANGED')
    require(all(value[k] == v for k, v in policy_migrations().items()), 'CAPTURE_POLL_CHANGED')
    dispatch.write_new(ROOT / RECEIPT, value)
    print(json.dumps({'qualification': 'captured', 'sha256': sha(ROOT / RECEIPT), 'image_id': image['Id'], 'scope': value['scope']}))


def build(args):
    """Explicit local build; never invoked by qualification or deployment checks."""
    revision = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    require(args.source_revision == revision, 'BUILD_REVISION')
    assert_source_revision(revision)
    inputs = [*source_guard.COPY_ROOTS, *SUPPLEMENTARY]
    before = snapshot()
    validate_source_scope(before, historical()['source'])
    policy_before = policy_migrations()
    base = image_metadata(BASE)
    require(BASE in base.get('RepoDigests', []), 'BUILD_BASE_MISSING')
    source_guard.verify_image(base, source_guard.load(ROOT))
    output = Path(args.build).resolve()
    require(output.is_relative_to(ROOT) and not output.exists(), 'BUILD_RECEIPT_PATH')
    log = output.with_suffix('.log')
    require(not log.exists(), 'BUILD_LOG_EXISTS')
    tag = 'tenderdesk-reference:' + revision
    environment = dict(os.environ)
    for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'):
        environment.pop(key, None)
    with tempfile.TemporaryDirectory(prefix='td-reference-build-') as directory:
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
    require(policy_before == policy_migrations(), 'BUILD_POLL_CHANGED')
    assert_source_revision(revision)
    image = image_metadata(tag)['Id']
    value = {'version': 1, 'image_id': image, 'source_revision': revision, 'build_exit_code': 0,
             'source_before': before, 'source_after': after, 'recipe': RECIPE, 'base': BASE,
             'build_log_sha256': sha(log), 'network': 'none',
             **policy_before,
             'context': 'Exact copied roots and supplementary inputs only; no scratch or private files.'}
    dispatch.write_new(output, value)
    print(json.dumps({'build': 'passed', 'image_id': image, 'source_revision': revision}))


def publish():
    require(not (ROOT / PUBLICATION).exists(), 'PUBLICATION_EXISTS')
    receipt = load()
    image_id = receipt['image']['Id']
    verify_image(image_metadata(image_id), receipt)
    require(app_files(image_id) == receipt['app_sha256'], 'PUBLISH_SOURCE')
    runner = module('reference_registry_credentials', 'digitalocean-runner.py')
    tag = REGISTRY + ':proposal-reference-' + receipt['source_revision']
    with tempfile.TemporaryDirectory(prefix='td-reference-publish-') as directory:
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
    for name in ('image', 'source-revision', 'native', 'prompt-native', 'poll-native', 'boundary-native', 'build'):
        parser.add_argument('--' + name)
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
        code = str(error) if re.fullmatch('[A-Z][A-Z0-9_]{0,99}', str(error)) else 'REFERENCE_QUALIFICATION_FAILED'
        print(json.dumps({'qualification': 'blocked', 'code': code}), flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
