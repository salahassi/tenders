#!/usr/bin/env python3
"""Stage exact 2026-11-05 requalification evidence without changing release guards.

Run only after the four sequential native receipts exist. This creates one
never-started inspection container, removes it, and refuses existing output.
It does not publish, deploy, refreeze, or infer a registry digest.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import tarfile
import uuid

REVISION = '19498666b511a29c251923baa75bf42c88a0c6f0'
IMAGE = 'sha256:176bcf738676421ebc58d26cd7bc2a29910d0242635de6084129a06701a9e4f8'
SUFFIX = '176bcf-20261105'
SOURCES = (
    ('native-owned-warm2.json', 'native-api-owned-snapshot-steady', 'source_and_input', 2),
    ('native-owned-fresh1.json', 'native-api-owned-snapshot-fresh', 'source_and_input', 1),
    ('native-reviewed-docx.json', 'native-reviewed-docx-handler', 'source_and_input', 1),
    ('native-api100/receipt.json', 'native-api-batch-capacity', 'batch', None),
)


def require(value, code):
    if not value:
        raise RuntimeError('CAPTURE_' + code)


def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def read(path):
    require(path.is_file() and not path.is_symlink(), 'INPUT_TYPE')
    return json.loads(path.read_text())


def write(path, value):
    with path.open('x') as out:
        json.dump(value, out, indent=2)
        out.write('\n')
    path.chmod(0o600)


def docker(*args, binary=False):
    env = {k: v for k, v in os.environ.items() if k not in (
        'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
    return subprocess.run(['docker', '--host=unix:///var/run/docker.sock', *args],
                          env=env, capture_output=True, text=not binary, timeout=120, check=True)


def inventory(stream):
    result = {}
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for member in archive:
            name = member.name
            while name.startswith('./'):
                name = name[2:]
            name = name.rstrip('/') or '.'
            path = PurePosixPath(name)
            require(not path.is_absolute() and '..' not in path.parts and
                    name == path.as_posix() and name not in result, 'TAR_PATH')
            require(member.isdir() or member.isreg(), 'TAR_TYPE')
            row = {'type': 'directory' if member.isdir() else 'file',
                   'mode': f'{member.mode:04o}', 'uid': member.uid, 'gid': member.gid}
            if member.isreg():
                with archive.extractfile(member) as content:
                    row.update(size=member.size, sha256=hashlib.file_digest(content, 'sha256').hexdigest())
            result[name] = row
    return dict(sorted(result.items()))


def validate_native(value, fmt, count):
    if fmt == 'source_and_input':
        require(value['image_id'] == IMAGE and value['actual_image_entrypoint'] is True and
                value['parent_old_space_limit_mebibytes'] is None and value['application_graph_loaded'] is True,
                'NATIVE_IMAGE')
        require(value['container_limits'] == {'memory_bytes': 402653184, 'cpus': 0.7, 'pids': 128,
                'network': 'none', 'read_only_root': True, 'tmpfs_bytes': 67108864}, 'NATIVE_LIMITS')
        require(value['cgroup_memory_limit_bytes'] == 402653184 and
                0 < value['cgroup_memory_peak_bytes'] <= 402653184 and
                value['cgroup_memory_events']['oom'] == value['cgroup_memory_events']['oom_kill'] == 0 and
                value['cgroup_memory_swap_current'] == value['cgroup_memory_swap_peak'] == 0, 'NATIVE_MEMORY')
        require(len(value['cases']) == count and all(c['outcome'] == 'verified' for c in value['cases']), 'NATIVE_CASES')
        owned = 'accepted_requests' in value
        expected_hash = ('5ab87f63de975b692a87431050991708f9d783518473ad5c49c3dc1e72e9f9d5' if owned else
                         '1bee8e23cf2198c637555d448aad64fd8e57b64f8f1d902274b8ef55c547d25d')
        expected_size = 8166765 if owned else 3177596
        require(all(c['artifact_hash'] == expected_hash and c['artifact_bytes'] == expected_size for c in value['cases']), 'NATIVE_ARTIFACT')
        if owned:
            require(value['accepted_requests'] == count and value['forced_gc'] is False and
                    value['parent_restarted_between_requests'] is False, 'OWNED_REQUESTS')
        else:
            require(value['cases'][0]['status'] == 200 and value['cases'][0]['completion_calls'] == 1, 'REVIEWED_COMPLETION')
    else:
        require(value['images']['api'] == IMAGE and value['passed'] is True and value['cleanup_verified'] is True and
                value['source_unchanged'] is True and value['image_entrypoint_retained'] is True and
                value['product_code_overrides'] is False and value['source_revision'] == REVISION, 'BATCH_OUTCOME')
        require(value['limits']['api_memory_bytes'] == 402653184 and value['limits']['api_cpus'] == 0.7 and
                value['limits']['swap'] is False and value['limits']['published_ports'] == [], 'BATCH_LIMITS')
        require(value['database']['ordered_exact_snapshots'] is True and value['database']['result_count'] == 100 and
                value['api']['complete']['result_count'] == 100 and value['api']['complete']['wire_bytes'] == 412758765 and
                value['api']['complete']['result_hashes'] == value['database']['result_hashes'], 'BATCH_RESULTS')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--run', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    root, run, output = args.root.resolve(), args.run.resolve(), args.output.resolve()
    require(not output.exists(), 'OUTPUT_EXISTS')
    spec = importlib.util.spec_from_file_location('old_guard', root / 'backend/scripts/ops/runtime-qualification.py')
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    old = guard.load(root)
    guard.verify_native_receipts(root, old)
    historical_image = json.loads(docker('image', 'inspect', old['qualified_image']['id'], '--format', '{{json .}}').stdout)
    guard.verify_image(historical_image, old)
    build = read(run / 'build-receipt.json')
    require(build['image_id'] == IMAGE and build['source_revision'] == REVISION and
            build['source_unchanged'] is True and build['build_exit_code'] == 0 and
            sha(run / 'source-before.json') == build['source_before_sha256'] and
            sha(run / 'source-after.json') == build['source_after_sha256'] and
            sha(run / 'candidate-image-inspect.json') == build['image_inspect_sha256'] and
            sha(run / 'build.log') == build['build_log_sha256'], 'BUILD_BINDING')
    frozen = read(run / 'source-before.json')
    require(frozen == read(run / 'source-after.json'), 'BUILD_SOURCE_CHANGED')
    orchestration = read(run / 'native-orchestration.json')
    require(orchestration['image_id'] == IMAGE and orchestration['passed'] is True and
            orchestration['source_unchanged'] is True and orchestration['containers_restored'] is True and
            len(orchestration['suites']) == 4, 'NATIVE_SEQUENCE')
    native_before, native_after = read(run / 'native-source-before.json'), read(run / 'native-source-after.json')
    require(native_before == native_after and native_before['revision'] == REVISION and
            native_before['tracked_status'] == '', 'NATIVE_SOURCE_CHANGED')
    preflight = read(run / 'native-preflight.json')
    require(preflight['host_swap']['SwapTotal'] == '0 kB', 'HOST_SWAP_SCOPE')
    activity = read(run / 'native-orchestration-activity-scope.json')
    require(subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == REVISION and
            not subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain=v1', '--untracked-files=no'], text=True),
            'CURRENT_REVISION')
    actual = guard.source_inventory(root)
    require(set(actual) == set(frozen['copy_entries']) == set(old['source_entries']), 'SOURCE_PATHS')
    source = {}
    for name, row in actual.items():
        expected = frozen['copy_entries'][name]
        require(row['type'] == expected['type'], 'SOURCE_TYPE')
        source[name] = {**expected, 'observed_checkout_mode': f'{stat.S_IMODE((root/name).stat().st_mode):04o}'}
        if row['type'] == 'file':
            require(sha(row['path']) == expected['sha256'] and row['path'].stat().st_size == expected['size'], 'SOURCE_BYTES')
    require(sum(row['type'] == 'file' for row in source.values()) == 130, 'COPY_COUNT')
    for name, row in frozen['supplementary_inputs'].items():
        require(sha(root/name) == row['sha256'], 'BUILD_INPUT_CHANGED')
    native = [(read(run/path), path, name, fmt, count) for path, name, fmt, count in SOURCES]
    for value, path, name, fmt, count in native:
        validate_native(value, fmt, count)
        require(any(item['receipt_sha256'] == sha(run/path) and item['passed'] is True for item in orchestration['suites']), 'NATIVE_SEQUENCE_BINDING')
    observed = json.loads(docker('image', 'inspect', IMAGE, '--format', '{{json .}}').stdout)
    require(observed['Config'] == read(run/'candidate-image-inspect.json')['Config'] and
            observed['RootFS'] == read(run/'candidate-image-inspect.json')['RootFS'], 'BUILD_IMAGE_CHANGED')
    base = json.loads(docker('image', 'inspect', old['base']['reference'], '--format', '{{json .}}').stdout)
    require(base['Id'] == old['base']['id'] and base['RootFS'] == old['base']['rootfs'] and
            observed['RootFS']['Layers'][:len(base['RootFS']['Layers'])] == base['RootFS']['Layers'], 'BASE_CHANGED')
    require(len(observed['RootFS']['Layers']) == 17, 'LAYER_COUNT')
    output.mkdir(parents=True, exist_ok=False)
    output.chmod(0o700)
    evidence = output/'backend/docs/evidence'
    evidence.mkdir(parents=True)
    name = 'td-runtime-capture-' + uuid.uuid4().hex[:16]
    created = False
    try:
        docker('create', '--name', name, '--network', 'none', '--read-only', IMAGE)
        created = True
        state = json.loads(docker('inspect', '--format', '{{json .State}}', name).stdout)
        require(state['Status'] == 'created' and state['Running'] is False, 'CONTAINER_STARTED')
        import io
        app = inventory(io.BytesIO(docker('cp', name + ':/app/.', '-', binary=True).stdout))
    finally:
        if created:
            docker('rm', name)
    require(name not in docker('ps', '-a', '--format', '{{.Names}}').stdout.splitlines(), 'CAPTURE_CLEANUP')
    file_map = {name: row['sha256'] for name, row in app.items() if row['type'] == 'file'}
    require(file_map == {name: row['sha256'] for name, row in source.items() if row['type'] == 'file'} and
            set(app) == set(old['image_app_tar_inventory']) and len(app) == 146, 'APP_INVENTORY')
    receipt = copy.deepcopy(old)
    receipt.update(observed_checkout_revision=REVISION,
        observation='Observed candidate build and four new sequential native receipts; read-only image inspect/history and complete /app tar inventory from a never-started network-none container. No publication or production operation.',
        qualified_image={'id': IMAGE, 'os': observed['Os'], 'architecture': observed['Architecture'], 'variant': observed.get('Variant',''),
            'rootfs': observed['RootFS'], 'config_without_labels': {k:v for k,v in observed['Config'].items() if k != 'Labels'}, 'labels': observed['Config']['Labels']},
        source_entries=dict(sorted(source.items())), image_app_tar_inventory=app, native_evidence=[],
        image_history_newest_first=[{k:row[k] for k in ('CreatedAt','CreatedBy','Comment')}
            for row in map(json.loads, docker('history', '--no-trunc', '--format', '{{json .}}', IMAGE).stdout.splitlines())])
    receipt['supplementary_inputs']['backend/deploy/Dockerfile']['role'] = 'observed_build_recipe'
    receipt['base']['observed_repo_digests'] = base['RepoDigests']
    for value, path, name, fmt, count in native:
        target = evidence/f'{name}-{SUFFIX}.json'
        with target.open('xb') as destination:
            destination.write((run/path).read_bytes())
        receipt['native_evidence'].append({'path':target.relative_to(output).as_posix(), 'sha256':sha(target), 'format':fmt, 'scope':value['scope']})
    build_target = evidence/f'runtime-build-{SUFFIX}.json'
    write(build_target, build)
    activity_target = evidence/f'native-orchestration-activity-scope-{SUFFIX}.json'
    write(activity_target, activity)
    receipt['observed_build'] = {'path':build_target.relative_to(output).as_posix(), 'sha256':sha(build_target),
        'native_orchestration_sha256':sha(run/'native-orchestration.json'),
        'native_preflight_sha256':sha(run/'native-preflight.json'),
        'tracked_source_before_sha256':sha(run/'native-source-before.json'),
        'tracked_source_after_sha256':sha(run/'native-source-after.json')}
    receipt['orchestration_activity_scope'] = {'path':activity_target.relative_to(output).as_posix(), 'sha256':sha(activity_target)}
    receipt['limits'] = [
        'Build command, recipe, COPY sources and supplementary inputs were captured before and after this build; build log SHA256 and exact local image identity are bound. Historical 89af evidence remains unchanged.',
        'Exact image modes/owners are recorded separately from portable Git executable modes; no image permission normalization occurs.',
        'Owned-snapshot warm 2 and fresh 1 plus reviewed DOCX retain actual image entrypoint and immutable product bytes, with synthetic Auth/RPC/Storage and no production gateway. API 100 uses real local PostgreSQL/PostgREST with synthetic Auth and a loopback prefix adapter.',
        'API fixtures run at 384 MiB/700m. Renderer harness records zero actual swap on a host with SwapTotal 0; it does not set an explicit no-swap limit. API 100 explicitly disables swap. Local database limits do not prove managed database capacity.',
        'The native suites were sequential in a reserved window. Normal metadata orchestration, four metadata unit tests reporting a 0.002-second body near the warm run end, and an isolated git commit overlapped the sequence. Total helper-process time was not measured; this is not a claim of zero other CPU activity.',
        'This receipt qualifies these frozen native fixtures only, not hosted acceptance, production SLO, arbitrary document capacity, model quality, or desktop Word layout.',
        'Registry publication/promotion remains pending; no registry digest is inferred from the local image ID.',
    ]
    # Apply the candidate identity only to this isolated in-memory validation.
    # The checked-in release guard and all old receipt bytes remain untouched.
    guard.QUALIFIED_ID = IMAGE
    guard.verify_image(observed, receipt)
    guard.verify_native_receipts(output, receipt)
    target = evidence/f'runtime-qualification-{SUFFIX}.json'
    write(target, receipt)
    write(output/'capture-summary.json', {'image_id':IMAGE, 'receipt':str(target), 'receipt_sha256':sha(target),
        'copied_files':len(file_map), 'app_tar_entries':len(app), 'layers':len(observed['RootFS']['Layers']),
        'native_receipts':len(native), 'historical_image_and_receipts_retained':True,
        'inspection_container_removed':True, 'production_helpers_edited':False, 'published':False,
        'actual_file_modes':sorted({row['mode'] for row in app.values() if row['type']=='file'})})
    print((output/'capture-summary.json').read_text())


if __name__ == '__main__':
    main()
