#!/usr/bin/env python3
"""Qualify executor-seven and explicit empty-inventory proposal review.

Only four reviewed runtime files may differ from the deployed successor image.
Migration hashes bind policy bytes; image proof never qualifies or applies SQL.
"""
import argparse
import copy
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


successor = module('review_successor_primitives', 'proposal-successor-runtime.py')
reference, previous, latency, dispatch = successor.reference, successor.previous, successor.latency, successor.dispatch
BASE, REGISTRY, RECIPE = successor.BASE, successor.REGISTRY, successor.RECIPE
SUPPLEMENTARY, source_guard = successor.SUPPLEMENTARY, successor.source_guard
snapshot, image_metadata, image_identity = successor.snapshot, successor.image_metadata, successor.image_identity
source_hashes, app_files, registry_identity = successor.source_hashes, successor.app_files, successor.registry_identity
verify_image, docker, sha = successor.verify_image, successor.docker, successor.sha
validate_image_source = successor.validate_image_source
validate_native_identity, validate_harnesses = successor.validate_native_identity, successor.validate_harnesses
validate_commercial_native = successor.validate_commercial_native
RECEIPT = 'backend/docs/evidence/proposal-review-runtime-20261108.json'
PUBLICATION = 'backend/docs/evidence/proposal-review-publication-20261108.json'
# Set only after actual image/native capture; preparation cannot authorize release.
RECEIPT_SHA256 = None
BASELINE_QUALIFICATION_SHA256 = 'a5e636e87f125c9f02e838a913b0e1ed05a6691681fd132a34d8e70a9b8d7b41'
BASELINE_PUBLICATION_SHA256 = '3d73c1c039fadcf707e09759c102a6b3ac76534b9c9b35a94f38ed9614dcac27'
BASELINE_REFERENCE = REGISTRY + '@sha256:de4312a0bea6170bcd0697bf7e209900295732add424239466bb2cfededc47f1'
BASELINE_IMAGE = 'sha256:3cc6c7cb3a2b63e3dc6187d0411cc9efe176dc0a098fa8aa171cb21aae598cf6'
CHECKPOINT_MIGRATION = 'backend/supabase/migrations/20261108220203_generated_delivery_checkpoint_report_ref.sql'
CHECKPOINT_SHA256 = '6bf6a506c53bf5113a17dfbb9c12ec09fc4ee0090599931776c34ed8e2614e53'
ZERO_INVENTORY_REVIEW_MIGRATION = 'backend/supabase/migrations/20261108223554_legacy_zero_inventory_review_recovery.sql'
CHANGED_SOURCES = frozenset('backend/supabase/functions/' + name for name in (
    '_shared/generation.ts', '_shared/backend.ts', 'worker/handler.ts', 'worker/queueWake.ts'))
NATIVE_FIELDS = ('native', 'prompt_native', 'poll_native', 'boundary_native', 'commercial_native', 'review_native')


class QualificationError(Exception):
    pass


def require(value, code):
    if not value:
        raise QualificationError('REVIEW_QUALIFICATION_' + code)


def historical(root=ROOT):
    require(successor.RECEIPT_SHA256 == BASELINE_QUALIFICATION_SHA256, 'HISTORICAL_QUALIFICATION_CHANGED')
    receipt = dispatch.read_bound(root, {'path': successor.RECEIPT, 'sha256': BASELINE_QUALIFICATION_SHA256})
    publication = dispatch.read_bound(root, {'path': successor.PUBLICATION, 'sha256': BASELINE_PUBLICATION_SHA256})
    require(receipt.get('kind') == 'proposal_successor_runtime' and receipt.get('scope') == ['worker', 'scheduler']
        and receipt.get('image', {}).get('Id') == BASELINE_IMAGE
        and publication.get('version') == 1 and publication.get('scope') == receipt['scope']
        and publication.get('qualification_sha256') == BASELINE_QUALIFICATION_SHA256
        and publication.get('image_id') == BASELINE_IMAGE and publication.get('reference') == BASELINE_REFERENCE
        and publication.get('source_revision') == receipt.get('source_revision'), 'HISTORICAL_BINDING')
    return receipt, publication


def baseline_binding(root=ROOT):
    historical(root)
    return {'reference': BASELINE_REFERENCE, 'image_id': BASELINE_IMAGE,
            'qualification_sha256': BASELINE_QUALIFICATION_SHA256}


def validate_source_scope(source, baseline):
    require(isinstance(source, dict) and isinstance(baseline, dict)
        and set(source) == set(baseline) == {'source_entries', 'supplementary_inputs'}
        and source['supplementary_inputs'] == baseline['supplementary_inputs'], 'SUPPLEMENTARY_CHANGED')
    current, prior = source['source_entries'], baseline['source_entries']
    require(isinstance(current, dict) and isinstance(prior, dict) and set(current) == set(prior)
        and {key for key in current if current[key] != prior[key]} == CHANGED_SOURCES, 'SOURCE_SCOPE_CHANGED')
    require(all(current[key].get('type') == prior[key].get('type') == 'file'
        and current[key].get('git_mode') == prior[key].get('git_mode')
        and current[key].get('sha256') != prior[key].get('sha256') for key in CHANGED_SOURCES), 'SOURCE_FILE_CHANGED')


def policy_migrations(root=ROOT):
    policies = dict(successor.policy_migrations(root))
    baseline, _ = historical(root)
    require(all(value == baseline.get(key) for key, value in policies.items()), 'PARENT_SQL_CHANGED')
    require(isinstance(ZERO_INVENTORY_REVIEW_MIGRATION, str)
        and re.fullmatch(r'backend/supabase/migrations/[0-9]{14}_[a-z0-9_]+\.sql', ZERO_INVENTORY_REVIEW_MIGRATION),
        'REVIEW_SQL_NOT_PREPARED')
    for key, name, expected in (
        ('checkpoint_migration', CHECKPOINT_MIGRATION, CHECKPOINT_SHA256),
        ('zero_inventory_review_migration', ZERO_INVENTORY_REVIEW_MIGRATION, None)):
        path = root / name
        require(path.is_file() and not any(p.is_symlink() for p in (path, *path.parents)), 'POLICY_SQL_MISSING')
        digest = sha(path)
        require(expected is None or digest == expected, 'CHECKPOINT_SQL_CHANGED')
        policies[key] = {'path': name, 'sha256': digest}
    return policies


def assert_source_revision(revision):
    require(isinstance(revision, str) and re.fullmatch('[a-f0-9]{40}', revision), 'SOURCE_REVISION')
    require(subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip() == revision,
            'SOURCE_HEAD_CHANGED')
    policies = policy_migrations()
    inputs = [*source_guard.COPY_ROOTS, *SUPPLEMENTARY, *(value['path'] for value in policies.values())]
    require(not subprocess.check_output(['git', '-C', str(ROOT), 'diff', 'HEAD', '--', *inputs]), 'SOURCE_DIRTY')
    for value in policies.values():
        name = value['path']
        require(subprocess.check_output(['git', '-C', str(ROOT), 'ls-files', '--', name], text=True).strip() == name,
                'SQL_UNTRACKED')


def validate_worker_native(value, receipt, root=ROOT):
    worker = module('review_worker_native_contract', '../testing/worker_dispatch_v7_native.py')
    validate_native_identity(value, receipt, 'proposal_dispatch_v7_native', 'WORKER_NATIVE')
    worker.validate_probe(value, source_hashes(receipt['source']))
    worker.validate_metadata(receipt['image'], receipt['image']['Id'])
    require(value.get('image_entrypoint') == receipt['image']['Config']['Entrypoint']
        and value.get('image_cmd') == receipt['image']['Config']['Cmd']
        and value.get('image_user') == receipt['image']['Config']['User'], 'WORKER_NATIVE_ENTRYPOINT')
    require(value.get('resources') == {'memory_mib': 1280, 'cpus': 2, 'pids_limit': 128,
        'tmpfs_mib': 64, 'readonly_rootfs': True}, 'WORKER_NATIVE_RESOURCES')
    validate_harnesses(value, worker.HARNESSES, root, 'WORKER_NATIVE')


def validate_review_native(value, receipt, root=ROOT):
    review = module('review_legacy_native_contract', '../testing/legacy_review_native.py')
    validate_native_identity(value, receipt, 'proposal_legacy_review_native', 'REVIEW_NATIVE')
    baseline, _ = historical(root)
    require(value.get('baseline_image_id') == BASELINE_IMAGE == review.BASELINE_IMAGE
        and value.get('baseline_source_sha256') == source_hashes(baseline['source'])
        and value.get('baseline_qualification_sha256') == BASELINE_QUALIFICATION_SHA256 == review.BASELINE_SHA256,
        'REVIEW_NATIVE_BASELINE')
    require(isinstance(value.get('checks'), dict) and set(value['checks']) == set(review.CHECKS)
        and all(value['checks'][name] is True for name in review.CHECKS), 'REVIEW_NATIVE_CHECKS')
    candidate = copy.deepcopy(value)
    candidate['baseline'] = False
    candidate['checks'] = {name: value['checks'][name] for name in review.PROBE_CHECKS}
    review.validate_probe(candidate, False, source_hashes(receipt['source']))
    prior = value.get('baseline')
    require(isinstance(prior, dict) and set(prior) == {
        'fixture_input_sha256', 'legacy_context_sha256', 'legacy_wire_sha256', 'transition_review_count'},
        'REVIEW_NATIVE_CASES')
    baseline_probe = {**prior, 'version': 1, 'baseline': True, 'passed': True, 'provider_calls': 0,
        'source_sha256': source_hashes(baseline['source']), 'modern_wire_sha256': {},
        'rejected_scope_cases': {}, 'review_source_sha256': None,
        'checks': dict.fromkeys(review.BASELINE_CHECKS, True)}
    review.validate_probe(baseline_probe, True, source_hashes(baseline['source']))
    review.compare_cases(candidate, baseline_probe)
    validate_harnesses(value, review.HARNESSES, root, 'REVIEW_NATIVE')


def validate_receipt(root, receipt):
    baseline, _ = historical(root)
    require(receipt.get('kind') == 'proposal_review_runtime'
        and receipt.get('image', {}).get('Id') != BASELINE_IMAGE, 'CANDIDATE_IDENTITY')
    validate_image_source(root, receipt)
    validate_source_scope(receipt['source'], baseline['source'])
    require(receipt.get('baseline') == baseline_binding(root), 'BASELINE_BINDING')
    require(receipt.get('review_sql_qualified') is False, 'SQL_SCOPE')
    policies = policy_migrations(root)
    build_receipt = dispatch.read_bound(root, receipt['build'])
    require(all(receipt.get(key) == value == build_receipt.get(key) for key, value in policies.items()), 'SQL_BINDING')
    validate_worker_native(dispatch.read_bound(root, receipt['native']), receipt, root)
    latency.validate_prompt_native(dispatch.read_bound(root, receipt['prompt_native']), receipt, root)
    previous.validate_poll_native(dispatch.read_bound(root, receipt['poll_native']), receipt, root)
    reference.validate_boundary_native(dispatch.read_bound(root, receipt['boundary_native']), receipt, root)
    validate_commercial_native(dispatch.read_bound(root, receipt['commercial_native']), receipt, root)
    validate_review_native(dispatch.read_bound(root, receipt['review_native']), receipt, root)
    return receipt



def load(root=ROOT):
    require(isinstance(RECEIPT_SHA256, str) and re.fullmatch('[a-f0-9]{64}', RECEIPT_SHA256), 'NOT_FROZEN')
    return validate_receipt(root, dispatch.read_bound(root, {'path': RECEIPT, 'sha256': RECEIPT_SHA256}))


def publication(root=ROOT):
    receipt = load(root)
    path = root / PUBLICATION
    require(path.is_file() and not any(p.is_symlink() for p in (path, *path.parents)), 'PUBLICATION_MISSING')
    value = json.loads(path.read_text())
    require(value.get('version') == 1 and value.get('image_id') == receipt['image']['Id']
        and value.get('qualification_sha256') == RECEIPT_SHA256
        and value.get('source_revision') == receipt['source_revision']
        and value.get('scope') == ['worker', 'scheduler'], 'PUBLICATION_BINDING')
    selected = value.get('reference', '')
    require(re.fullmatch(re.escape(REGISTRY) + r'@sha256:[a-f0-9]{64}', selected), 'PUBLICATION_REFERENCE')
    return receipt, selected


def capture(args):
    revision = args.source_revision
    assert_source_revision(revision)
    require(not (ROOT / RECEIPT).exists(), 'RECEIPT_EXISTS')
    image, base = image_metadata(args.image), image_metadata(BASE)
    require(BASE in base.get('RepoDigests', []), 'BASE_DIGEST')
    value = {'version': 1, 'kind': 'proposal_review_runtime', 'scope': ['worker', 'scheduler'],
        'source_revision': revision, 'base': BASE, 'image': image_identity(image), 'base_image': image_identity(base),
        'source': snapshot(), 'app_sha256': app_files(image['Id']), 'review_sql_qualified': False,
        'baseline': baseline_binding(), **policy_migrations()}
    for field in ('build', *NATIVE_FIELDS):
        path = Path(getattr(args, field)).resolve()
        value[field] = {'path': path.relative_to(ROOT).as_posix(), 'sha256': sha(path)}
    validate_receipt(ROOT, value)
    assert_source_revision(revision)
    require(value['source'] == snapshot(), 'CAPTURE_SOURCE_CHANGED')
    require(all(value[key] == item for key, item in policy_migrations().items()), 'CAPTURE_SQL_CHANGED')
    dispatch.write_new(ROOT / RECEIPT, value)
    print(json.dumps({'qualification': 'captured', 'sha256': sha(ROOT / RECEIPT), 'image_id': image['Id'], 'scope': value['scope']}))


def build(args):
    """Explicit offline build; verification never invokes it."""
    revision = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    require(args.source_revision == revision, 'BUILD_REVISION')
    assert_source_revision(revision)
    before = snapshot()
    validate_source_scope(before, historical()[0]['source'])
    policies = policy_migrations()
    base = image_metadata(BASE)
    require(BASE in base.get('RepoDigests', []), 'BUILD_BASE_MISSING')
    source_guard.verify_image(base, source_guard.load(ROOT))
    output = Path(args.build).resolve()
    require(output.is_relative_to(ROOT) and not output.exists(), 'BUILD_RECEIPT_PATH')
    log = output.with_suffix('.log')
    require(not log.exists(), 'BUILD_LOG_EXISTS')
    tag = 'tenderdesk-review:' + revision
    environment = dict(os.environ)
    for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'):
        environment.pop(key, None)
    with tempfile.TemporaryDirectory(prefix='td-review-build-') as directory:
        context = Path(directory)
        for name in (*source_guard.COPY_ROOTS, *SUPPLEMENTARY):
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
    require(policies == policy_migrations(), 'BUILD_SQL_CHANGED')
    assert_source_revision(revision)
    image = image_metadata(tag)['Id']
    value = {'version': 1, 'image_id': image, 'source_revision': revision, 'build_exit_code': 0,
        'source_before': before, 'source_after': after, 'recipe': RECIPE, 'base': BASE,
        'build_log_sha256': sha(log), 'network': 'none', **policies,
        'context': 'Exact copied roots and supplementary inputs only; no scratch or private files.'}
    dispatch.write_new(output, value)
    print(json.dumps({'build': 'passed', 'image_id': image, 'source_revision': revision}))


def publish():
    require(not (ROOT / PUBLICATION).exists(), 'PUBLICATION_EXISTS')
    receipt = load()
    image_id = receipt['image']['Id']
    verify_image(image_metadata(image_id), receipt)
    require(app_files(image_id) == receipt['app_sha256'], 'PUBLISH_SOURCE')
    runner = module('review_registry_credentials', 'digitalocean-runner.py')
    tag = REGISTRY + ':proposal-review-' + receipt['source_revision']
    with tempfile.TemporaryDirectory(prefix='td-review-publish-') as directory:
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
        selected = references[0]
        verify_image(observed, receipt, selected)
        docker('pull', selected, timeout=60, env=environment)
        verify_image(image_metadata(selected), receipt, selected)
        require(app_files(selected) == receipt['app_sha256'], 'PUBLISHED_SOURCE')
    dispatch.write_new(ROOT / PUBLICATION, {'version': 1, 'reference': selected, 'image_id': image_id,
        'qualification_sha256': RECEIPT_SHA256, 'source_revision': receipt['source_revision'],
        'scope': ['worker', 'scheduler'], 'temporary_credentials_removed': True})
    print(json.dumps({'publication': 'passed', 'reference': selected, 'image_id': image_id}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('snapshot', 'build', 'capture', 'verify', 'publish'))
    for name in ('image', 'source-revision', 'native', 'prompt-native', 'poll-native', 'boundary-native', 'commercial-native', 'review-native', 'build'):
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
        code = str(error) if re.fullmatch('[A-Z][A-Z0-9_]{0,119}', str(error)) else 'REVIEW_QUALIFICATION_FAILED'
        print(json.dumps({'qualification': 'blocked', 'code': code}), flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
