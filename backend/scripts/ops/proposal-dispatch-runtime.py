#!/usr/bin/env python3
"""Qualify/publish only the worker+scheduler image against actual native evidence.

The existing API/render qualification remains frozen. No runtime is started by
this tool: /app inspection uses a never-started, network-none container. Native
behavior is proved separately by an image-bound receipt before capture/publish.
"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
RECEIPT = 'backend/docs/evidence/proposal-dispatch-runtime-20261108.json'
PUBLICATION = 'backend/docs/evidence/proposal-dispatch-publication-20261108.json'
# Freeze only after --capture has checked the actual new build/native evidence.
RECEIPT_SHA256 = 'd7a13be2d06e265206c5da8180e91e56f01c28e5a00e8b5f72313cf344930b91'
BASE = 'registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:f573e991e622c982e82a4a3b4e6dc6f144e87586ba0f5dd0b3d05381b30dbd6a'
REGISTRY = BASE.split('@')[0]
RECIPE = 'backend/deploy/Dockerfile.dispatch'
SUPPLEMENTARY = (RECIPE, '.dockerignore', 'backend/package.json', 'backend/package-lock.json',
                 'frontend/package.json', 'frontend/package-lock.json')
CHECKS = ('worker_authentication', 'worker_ready_response_before_maintenance',
          'worker_poll_delay_returned_without_sleep', 'scheduler_maintenance_independent',
          'scheduler_completion_metadata', 'scheduler_failure_retry')
HARNESSES = ('backend/scripts/testing/worker_dispatch_native.py',
             'backend/scripts/testing/worker_dispatch_native.ts')


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


source_guard = load_module('dispatch_source_inventory', 'runtime-qualification.py')


class QualificationError(Exception):
    pass


def require(value, code):
    if not value:
        raise QualificationError('DISPATCH_QUALIFICATION_' + code)


def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def canonical(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def read_bound(root, item):
    name = item.get('path', '')
    relative = PurePosixPath(name)
    require(isinstance(name, str) and not relative.is_absolute() and '..' not in relative.parts
            and name == relative.as_posix(), 'EVIDENCE_PATH')
    path = root / name
    require(path.is_file() and not any(p.is_symlink() for p in (path, *path.parents))
            and sha(path) == item.get('sha256'), 'EVIDENCE_BYTES')
    return json.loads(path.read_text())


def snapshot(root=ROOT):
    actual = source_guard.source_inventory(root)
    modes = source_guard.git_modes(root, [*source_guard.COPY_ROOTS, *SUPPLEMENTARY])
    files = {name: row for name, row in actual.items() if row['type'] == 'file'}
    require(set(modes) == set(files) | set(SUPPLEMENTARY), 'SOURCE_INDEX')
    require(not (root / (RECIPE + '.dockerignore')).exists()
            and not (root / 'backend/deploy/Dockerfile.dockerignore').exists(), 'IGNORE_OVERRIDE')
    entries = {}
    for name, row in actual.items():
        if row['type'] == 'directory':
            entries[name] = {'type': 'directory'}
        else:
            path = row['path']
            require(bool(path.stat().st_mode & 0o111) == (modes[name] == '100755'), 'SOURCE_MODE')
            entries[name] = {'type': 'file', 'git_mode': modes[name],
                             'size': path.stat().st_size, 'sha256': sha(path)}
    inputs = {}
    for name in SUPPLEMENTARY:
        path = root / name
        require(path.is_file() and not path.is_symlink(), 'INPUT_TYPE')
        inputs[name] = {'sha256': sha(path), 'git_mode': modes[name]}
    return {'source_entries': entries, 'supplementary_inputs': inputs}


def docker(*args, timeout=45, binary=False, env=None):
    environment = dict(os.environ if env is None else env)
    for key in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'):
        environment.pop(key, None)
    try:
        result = subprocess.run(['docker', '--host=unix:///var/run/docker.sock', *args],
                                env=environment, capture_output=True, text=not binary, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise QualificationError('DISPATCH_QUALIFICATION_DOCKER_TIMEOUT') from None
    require(result.returncode == 0, 'DOCKER_FAILED')
    return result.stdout


def image_metadata(reference):
    value = json.loads(docker('image', 'inspect', reference, '--format', '{{json .}}'))
    require(isinstance(value, dict), 'IMAGE_METADATA')
    return value


def image_identity(value):
    result = {key: value.get(key) for key in ('Id', 'Os', 'Architecture', 'RootFS', 'Config')}
    result['Variant'] = value.get('Variant', '')
    return result


def app_files(reference):
    name = 'td-dispatch-inspect-' + uuid.uuid4().hex[:16]
    created = False
    try:
        docker('create', '--name', name, '--network', 'none', '--read-only', reference)
        created = True
        state = json.loads(docker('inspect', '--format', '{{json .State}}', name))
        require(state.get('Status') == 'created' and state.get('Running') is False, 'INSPECTION_STARTED')
        stream = io.BytesIO(docker('cp', name + ':/app/.', '-', binary=True))
        result, seen = {}, set()
        with tarfile.open(fileobj=stream, mode='r|') as archive:
            for member in archive:
                name_in_tar = member.name
                while name_in_tar.startswith('./'):
                    name_in_tar = name_in_tar[2:]
                name_in_tar = name_in_tar.rstrip('/') or '.'
                path = PurePosixPath(name_in_tar)
                require(not path.is_absolute() and '..' not in path.parts and name_in_tar == path.as_posix()
                        and name_in_tar not in seen and (member.isdir() or member.isreg()), 'APP_TAR')
                seen.add(name_in_tar)
                if member.isreg():
                    with archive.extractfile(member) as content:
                        result[name_in_tar] = hashlib.file_digest(content, 'sha256').hexdigest()
        return result
    finally:
        if created:
            docker('rm', name, timeout=10)


def source_hashes(value):
    return {name: item['sha256'] for name, item in value['source_entries'].items() if item['type'] == 'file'}


def validate_native(value, receipt):
    require(value.get('version') == 1 and value.get('kind') == 'proposal_dispatch_native'
            and value.get('image_id') == receipt['image']['Id'] and value.get('passed') is True
            and value.get('actual_image_entrypoint') is True and value.get('network') == 'none'
            and value.get('external_calls') == 0 and value.get('cleanup_verified') is True, 'NATIVE_IDENTITY')
    require(value.get('source_sha256') == source_hashes(receipt['source']), 'NATIVE_SOURCE')
    require(all(value.get('checks', {}).get(name) is True for name in CHECKS), 'NATIVE_BEHAVIOR')
    require(set(value.get('harness_sha256', {})) == set(HARNESSES), 'NATIVE_HARNESS')
    for name, expected in value['harness_sha256'].items():
        path = ROOT / name
        require(path.is_file() and not path.is_symlink() and sha(path) == expected, 'NATIVE_HARNESS_CHANGED')


def validate_build(value, receipt):
    require(value.get('version') == 1 and value.get('image_id') == receipt['image']['Id']
            and value.get('source_revision') == receipt['source_revision'] and value.get('build_exit_code') == 0
            and value.get('source_before') == receipt['source'] == value.get('source_after')
            and value.get('recipe') == RECIPE and value.get('base') == BASE, 'BUILD_BINDING')


def validate_receipt(root, receipt):
    require(receipt.get('version') == 1 and receipt.get('scope') == ['worker', 'scheduler']
            and receipt.get('base') == BASE and re.fullmatch(r'[a-f0-9]{40}', receipt.get('source_revision', '')),
            'RECEIPT_IDENTITY')
    require(receipt['source'] == snapshot(root), 'SOURCE_CHANGED')
    image = receipt['image']
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', image.get('Id', '')) and image.get('Os') == 'linux'
            and image.get('Architecture') == 'amd64' and image.get('Variant') in (None, ''), 'PLATFORM')
    require(image['Config']['Labels'].get('org.opencontainers.image.revision') == receipt['source_revision'], 'REVISION_LABEL')
    base = receipt['base_image']
    # Reuse only the identity guard for the unchanged published base. Its old
    # API/render native evidence is not attributed to the new candidate.
    historical = source_guard.load(root)
    source_guard.verify_image(base, historical)
    require(base['Id'] == 'sha256:9566a11c502ad99c2df271bc090ca4b46678688545e95c70ddd3ccca9ac539a2'
            and image['RootFS']['Type'] == base['RootFS']['Type'] == 'layers'
            and image['RootFS']['Layers'][:len(base['RootFS']['Layers'])] == base['RootFS']['Layers'], 'BASE_LAYERS')
    require({k: v for k, v in image['Config'].items() if k != 'Labels'} ==
            {k: v for k, v in base['Config'].items() if k != 'Labels'}, 'RUNTIME_CONFIGURATION')
    require(receipt.get('app_sha256') == source_hashes(receipt['source']), 'IMAGE_SOURCE')
    validate_build(read_bound(root, receipt['build']), receipt)
    validate_native(read_bound(root, receipt['native']), receipt)
    return receipt


def load(root=ROOT):
    require(re.fullmatch('[a-f0-9]{64}', RECEIPT_SHA256) is not None, 'NOT_FROZEN')
    return validate_receipt(root, read_bound(root, {'path': RECEIPT, 'sha256': RECEIPT_SHA256}))


def verify_image(value, receipt, reference=None):
    require(image_identity(value) == receipt['image'], 'IMAGE_CHANGED')
    if reference is not None:
        require(re.fullmatch(re.escape(REGISTRY) + r'@sha256:[a-f0-9]{64}', reference) is not None
                and reference in value.get('RepoDigests', []), 'PUBLISHED_DIGEST')


def registry_identity(reference, receipt, *, fetch=None):
    """Bind the immutable remote manifest to the locally qualified config ID.

    Publication already pulled this exact digest and rechecked its full /app
    source, config and layers. The rollout verifies the SHA-256 of raw registry
    manifest bytes, then its config descriptor against that same native-tested
    image ID. That digest binds all config and uncompressed layer hashes; no
    second full layer download or new source qualification is implied here.
    Docker's existing private registry credentials/auth/TLS handling is retained.
    """
    require(re.fullmatch(re.escape(REGISTRY) + r'@sha256:[a-f0-9]{64}', reference) is not None,
            'REGISTRY_REFERENCE')
    image = receipt['image']
    manifests = ('application/vnd.oci.image.manifest.v1+json',
                 'application/vnd.docker.distribution.manifest.v2+json')
    indexes = ('application/vnd.oci.image.index.v1+json',
               'application/vnd.docker.distribution.manifest.list.v2+json')
    configs = ('application/vnd.oci.image.config.v1+json',
               'application/vnd.docker.container.image.v1+json')
    layers = ('application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip',
              'application/vnd.oci.image.layer.v1.tar+zstd', 'application/vnd.docker.image.rootfs.diff.tar.gzip')
    if fetch is None:
        def fetch(selected):
            try:
                return docker('buildx', 'imagetools', 'inspect', '--raw', selected, timeout=12, binary=True)
            except QualificationError as error:
                if str(error) == 'DISPATCH_QUALIFICATION_DOCKER_TIMEOUT':
                    raise QualificationError('DISPATCH_QUALIFICATION_REGISTRY_TIMEOUT') from None
                raise

    def descriptor(value, media_types, max_size):
        require(isinstance(value, dict) and value.get('mediaType') in media_types
                and re.fullmatch(r'sha256:[a-f0-9]{64}', str(value.get('digest', ''))) is not None
                and type(value.get('size')) is int and 0 < value['size'] <= max_size
                and not value.get('urls') and not value.get('data'), 'REGISTRY_DESCRIPTOR')

    def document(digest, size=None):
        raw = fetch(REGISTRY + '@' + digest)
        # Imagetools returns the exact server bytes. Do not reserialize JSON or
        # strip whitespace: even an appended newline changes the identity.
        require(isinstance(raw, bytes) and 0 < len(raw) <= 1048576
                and (size is None or len(raw) == size), 'REGISTRY_DOCUMENT_SIZE')
        require('sha256:' + hashlib.sha256(raw).hexdigest() == digest, 'REGISTRY_DOCUMENT_DIGEST')
        try:
            value = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise QualificationError('DISPATCH_QUALIFICATION_REGISTRY_DOCUMENT_JSON') from None
        require(isinstance(value, dict) and value.get('schemaVersion') == 2, 'REGISTRY_DOCUMENT_SCHEMA')
        return value, len(raw)

    root_digest = reference.split('@', 1)[1]
    selected_digest = root_digest
    manifest, root_size = document(root_digest)
    manifest_size = root_size
    if manifest.get('mediaType') in indexes:
        choices = manifest.get('manifests')
        require(isinstance(choices, list) and 1 <= len(choices) <= 16, 'REGISTRY_INDEX')
        matches = [entry for entry in choices if isinstance(entry, dict) and isinstance(entry.get('platform'), dict)
                   and entry['platform'].get('os') == image['Os']
                   and entry['platform'].get('architecture') == image['Architecture']
                   and entry['platform'].get('variant', '') == image['Variant']]
        require(len(matches) == 1, 'REGISTRY_PLATFORM_SELECTION')
        selected = matches[0]
        descriptor(selected, manifests, 1048576)
        selected_digest = selected['digest']
        manifest, manifest_size = document(selected_digest, selected['size'])
        require(manifest.get('mediaType') == selected['mediaType'], 'REGISTRY_MEDIA_TYPE')
    require(manifest.get('mediaType') in manifests and 'manifests' not in manifest, 'REGISTRY_MANIFEST')
    config = manifest.get('config')
    descriptor(config, configs, 1048576)
    require(config['digest'] == image['Id'], 'REGISTRY_QUALIFIED_CONFIG')
    actual_layers = manifest.get('layers')
    require(isinstance(actual_layers, list) and 1 <= len(actual_layers) <= 128
            and len(actual_layers) == len(image['RootFS']['Layers']), 'REGISTRY_LAYER_COUNT')
    for layer in actual_layers:
        descriptor(layer, layers, 2**31)
    return {'verification': 'immutable_manifest_and_qualified_config_digest', 'metadata_only': True,
            'reference': reference, 'root_manifest_bytes': root_size, 'selected_manifest_bytes': manifest_size,
            'selected_manifest_digest': selected_digest, 'config_digest': config['digest'], 'config_bytes': config['size'],
            'layer_count': len(actual_layers), 'compressed_layer_bytes': sum(layer['size'] for layer in actual_layers),
            'image_layers_downloaded': False}


def publication(root=ROOT):
    receipt = load(root)
    path = root / PUBLICATION
    require(path.is_file() and not path.is_symlink(), 'PUBLICATION_MISSING')
    value = json.loads(path.read_text())
    require(value.get('version') == 1 and value.get('image_id') == receipt['image']['Id']
            and value.get('qualification_sha256') == RECEIPT_SHA256
            and value.get('source_revision') == receipt['source_revision'], 'PUBLICATION_BINDING')
    reference = value.get('reference', '')
    require(re.fullmatch(re.escape(REGISTRY) + r'@sha256:[a-f0-9]{64}', reference) is not None, 'PUBLICATION_REFERENCE')
    return receipt, reference


def write_new(path, value):
    with path.open('x') as output:
        json.dump(value, output, indent=2, sort_keys=True)
        output.write('\n')


def capture(args):
    revision = args.source_revision
    require(re.fullmatch('[a-f0-9]{40}', revision or '') is not None, 'SOURCE_REVISION')
    require(subprocess.run(['git', '-C', str(ROOT), 'merge-base', '--is-ancestor', revision, 'HEAD'],
                           capture_output=True).returncode == 0, 'SOURCE_ANCESTRY')
    image, base = image_metadata(args.image), image_metadata(BASE)
    require(BASE in base.get('RepoDigests', []), 'BASE_DIGEST')
    result = {'version': 1, 'scope': ['worker', 'scheduler'], 'source_revision': revision, 'base': BASE,
              'image': image_identity(image), 'base_image': image_identity(base), 'source': snapshot(),
              'app_sha256': app_files(image['Id'])}
    for field in ('build', 'native'):
        path = Path(getattr(args, field)).resolve()
        result[field] = {'path': path.relative_to(ROOT).as_posix(), 'sha256': sha(path)}
    validate_receipt(ROOT, result)
    write_new(ROOT / RECEIPT, result)
    print(json.dumps({'qualification': 'captured', 'sha256': sha(ROOT / RECEIPT),
                      'image_id': image['Id'], 'scope': result['scope']}))


def publish():
    receipt = load()
    image_id = receipt['image']['Id']
    verify_image(image_metadata(image_id), receipt)
    require(app_files(image_id) == receipt['app_sha256'], 'PUBLISH_SOURCE')
    runner = load_module('dispatch_registry_credentials', 'digitalocean-runner.py')
    tag = REGISTRY + ':proposal-dispatch-' + receipt['source_revision']
    with tempfile.TemporaryDirectory(prefix='td-dispatch-publish-') as directory:
        path = Path(directory)
        path.chmod(0o700)
        runner.write(path / 'config.json', runner.docker_credentials(write_access=True))
        environment = {**os.environ, 'DOCKER_CONFIG': str(path)}
        docker('tag', image_id, tag, env=environment)
        docker('push', tag, timeout=120, env=environment)
        observed = image_metadata(tag)
        references = [r for r in observed.get('RepoDigests', [])
                      if re.fullmatch(re.escape(REGISTRY) + r'@sha256:[a-f0-9]{64}', r)]
        require(len(set(references)) == 1, 'PUBLISHED_IDENTITY')
        reference = references[0]
        verify_image(observed, receipt, reference)
        docker('pull', reference, timeout=60, env=environment)
        verify_image(image_metadata(reference), receipt, reference)
        require(app_files(reference) == receipt['app_sha256'], 'PUBLISHED_SOURCE')
    write_new(ROOT / PUBLICATION, {'version': 1, 'reference': reference, 'image_id': image_id,
              'qualification_sha256': RECEIPT_SHA256, 'source_revision': receipt['source_revision'],
              'scope': ['worker', 'scheduler'], 'temporary_credentials_removed': True})
    print(json.dumps({'publication': 'passed', 'reference': reference, 'image_id': image_id}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('snapshot', 'capture', 'verify', 'publish'))
    parser.add_argument('--image')
    parser.add_argument('--source-revision')
    parser.add_argument('--native')
    parser.add_argument('--build')
    args = parser.parse_args()
    try:
        if args.mode == 'snapshot':
            print(json.dumps(snapshot(), sort_keys=True))
        elif args.mode == 'capture':
            capture(args)
        elif args.mode == 'publish':
            publish()
        else:
            receipt = load()
            print(json.dumps({'qualification': 'passed', 'scope': receipt['scope'], 'image_id': receipt['image']['Id']}))
        return 0
    except Exception as error:
        code = str(error) if re.fullmatch('[A-Z][A-Z0-9_]{0,99}', str(error)) else 'DISPATCH_QUALIFICATION_FAILED'
        print(json.dumps({'qualification': 'blocked', 'code': code}), flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
