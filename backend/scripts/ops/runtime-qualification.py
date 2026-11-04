#!/usr/bin/env python3
"""Exact runtime identity for promotion of an already qualified image.

This is a release guard, not a source rebuild or a new native qualification.
The original Dockerfile was not embedded; its binding is retrospective.
"""
import hashlib
import json
from pathlib import Path
import re
import stat
import subprocess

QUALIFIED_ID = 'sha256:89afc8a31d76e1616ad17e5896e0fc54f0acdc41cd7da389af456386f3e998fe'
REGISTRY = 'registry.digitalocean.com/tenderdesk-a6093a76/runtime'
REVISION_LABEL = 'org.opencontainers.image.revision'
RECEIPT = 'backend/docs/evidence/runtime-qualification-89af-20261104.json'
PUBLICATION = 'backend/docs/evidence/runtime-qualified-publication-20261104.json'
RECEIPT_SHA256 = '6e031a746917c8183f59264e6482df0b97e4b2515f9b45f2cfd9378cce80b0ac'
COPY_ROOTS = (
    'backend/supabase/functions', 'backend/scripts/runtime',
    'frontend/src/lib/renderDocx.ts', 'frontend/src/lib/docxTableStream.ts',
    'frontend/public/fonts',
)


class QualificationError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise QualificationError('RUNTIME_QUALIFICATION_' + code)


def sha256(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def load(root):
    path = root / RECEIPT
    require(path.is_file() and not path.is_symlink(), 'RECEIPT_MISSING')
    require(sha256(path) == RECEIPT_SHA256, 'RECEIPT_CHANGED')
    value = json.loads(path.read_text())
    require(value['version'] == 1 and value['qualified_image']['id'] == QUALIFIED_ID, 'IDENTITY')
    require(value['copy_roots'] == list(COPY_ROOTS), 'COPY_ROOTS')
    require(value['base']['reference'].split('@')[1] in
            [ref.split('@')[1] for ref in value['base']['observed_repo_digests']], 'BASE_DIGEST')
    base = value['base']['rootfs']
    layers = value['qualified_image']['rootfs']
    require(base['Type'] == layers['Type'] == 'layers' and
            layers['Layers'][:len(base['Layers'])] == base['Layers'], 'BASE_LAYERS')
    return value


def publication(root):
    path = root / PUBLICATION
    require(path.is_file() and not path.is_symlink(), 'PUBLICATION_MISSING')
    value = json.loads(path.read_text())
    reference = value.get('reference')
    require(value.get('version') == 1 and value.get('qualified_image_id') == QUALIFIED_ID,
            'PUBLICATION_IDENTITY')
    require(isinstance(reference, str) and
            re.fullmatch(re.escape(REGISTRY) + r'@sha256:[a-f0-9]{64}', reference),
            'PUBLICATION_PENDING')
    return reference


def source_inventory(root):
    """Inspect all COPY paths, including untracked/ignored names, without following links.

    An extra ignored file is refused, not opened; no secret is read. Frozen COPY
    roots contain no ignored entries. Git's executable bit is portable across
    checkout umasks; exact image mode/uid/gid is bound separately by its layers.
    """
    entries = {}

    def visit(path):
        relative = path.relative_to(root).as_posix()
        mode = path.lstat().st_mode
        require(not stat.S_ISLNK(mode), 'SOURCE_LINK')
        if stat.S_ISDIR(mode):
            entries[relative] = {'type': 'directory'}
            for child in sorted(path.iterdir()):
                visit(child)
        else:
            require(stat.S_ISREG(mode), 'SOURCE_SPECIAL')
            entries[relative] = {'type': 'file', 'path': path, 'mode': mode}

    try:
        for relative in COPY_ROOTS:
            path = root / relative
            # Also reject a link in an ancestor outside the copied subtree.
            for parent in path.parents:
                if parent == root:
                    break
                require(not parent.is_symlink(), 'SOURCE_LINK')
            visit(path)
    except FileNotFoundError:
        raise QualificationError('RUNTIME_QUALIFICATION_SOURCE_MISSING') from None
    return entries


def git_modes(root, paths):
    result = subprocess.run(['git', '-C', str(root), 'ls-files', '--stage', '-z', '--', *paths],
                            capture_output=True, timeout=30, check=False)
    require(result.returncode == 0, 'GIT_INDEX')
    modes = {}
    for item in result.stdout.split(b'\0'):
        if not item:
            continue
        metadata, path = item.decode('utf-8').split('\t', 1)
        mode, _object, stage = metadata.split(' ')
        require(stage == '0' and mode in ('100644', '100755'), 'GIT_TYPE')
        modes[path] = mode
    return modes


def verify_checkout(root, receipt):
    require(not (root / 'backend/deploy/Dockerfile.dockerignore').exists() and
            not (root / 'backend/deploy/Dockerfile.dockerignore').is_symlink(), 'IGNORE_OVERRIDE')
    expected = receipt['source_entries']
    actual = source_inventory(root)
    require(set(actual) == set(expected), 'SOURCE_PATH_SET')
    # Check names/types before opening any file; unexpected .env is never read.
    require(all(actual[p]['type'] == expected[p]['type'] for p in expected), 'SOURCE_TYPE')
    files = {p: v for p, v in actual.items() if v['type'] == 'file'}
    supplementary = receipt['supplementary_inputs']
    modes = git_modes(root, [*COPY_ROOTS, *supplementary])
    require(set(modes) == set(files) | set(supplementary), 'GIT_PATH_SET')
    for name, value in files.items():
        frozen = expected[name]
        require(modes[name] == frozen['git_mode'] and
                bool(value['mode'] & 0o111) == (frozen['git_mode'] == '100755'), 'SOURCE_MODE')
        require(value['path'].stat().st_size == frozen['size'] and
                sha256(value['path']) == frozen['sha256'], 'SOURCE_BYTES')
    for name, value in supplementary.items():
        path = root / name
        require(path.is_file() and not path.is_symlink() and modes[name] == value['git_mode']
                and bool(path.stat().st_mode & 0o111) == (value['git_mode'] == '100755'), 'INPUT_TYPE')
        require(sha256(path) == value['sha256'], 'INPUT_BYTES')
    verify_native_receipts(root, receipt)


def verify_native_receipts(root, receipt):
    copied = {p: v['sha256'] for p, v in receipt['source_entries'].items() if v['type'] == 'file'}
    for item in receipt['native_evidence']:
        path = root / item['path']
        require(path.is_file() and not path.is_symlink() and sha256(path) == item['sha256'], 'NATIVE_RECEIPT')
        evidence = json.loads(path.read_text())
        if item['format'] == 'source_and_input':
            require(evidence.get('image_id') == QUALIFIED_ID, 'NATIVE_IMAGE')
            hashes = evidence['source_and_input_sha256']
            require(all(hashes.get('app/' + p) == h for p, h in copied.items()), 'NATIVE_SOURCE')
            for p, value in receipt['supplementary_inputs'].items():
                if value['role'] == 'native_harness_dependency':
                    require(hashes.get('app/' + p) == value['sha256'], 'NATIVE_DEPENDENCY')
            require(evidence['cases'] and all(c.get('outcome') == 'verified' for c in evidence['cases']),
                    'NATIVE_OUTCOME')
        elif item['format'] == 'batch':
            require(evidence.get('images', {}).get('api') == QUALIFIED_ID and evidence.get('passed') is True,
                    'NATIVE_IMAGE')
            hashes = {'backend/supabase/functions/' + p: h
                      for p, h in evidence['actual_image_function_hashes'].items()}
            hashes.update(evidence['actual_image_additional_source_hashes'])
            expected = {p: h for p, h in copied.items() if not p.startswith('frontend/public/fonts/')}
            require(hashes == expected, 'NATIVE_SOURCE')
        else:
            raise QualificationError('RUNTIME_QUALIFICATION_NATIVE_FORMAT')


def verify_image(value, receipt, revision=None):
    qualified = receipt['qualified_image']
    require(value.get('Os') == qualified['os'] and value.get('Architecture') == qualified['architecture']
            and value.get('Variant', '') == qualified['variant'], 'PLATFORM')
    require(value.get('RootFS') == qualified['rootfs'], 'ROOTFS')
    config = value.get('Config')
    require(isinstance(config, dict), 'CONFIG')
    require({k: v for k, v in config.items() if k != 'Labels'} == qualified['config_without_labels'], 'CONFIG')
    labels = dict(qualified['labels'])
    if revision is None:
        require(value.get('Id') == QUALIFIED_ID, 'IMAGE_ID')
    else:
        require(re.fullmatch('[a-f0-9]{40}', revision) is not None, 'REVISION')
        labels[REVISION_LABEL] = revision
    require(config.get('Labels') == labels, 'LABELS')


def verify_published(value, reference, receipt):
    require(re.fullmatch(re.escape(REGISTRY) + r'@sha256:[a-f0-9]{64}', reference) is not None,
            'PUBLISHED_REFERENCE')
    require(reference in value.get('RepoDigests', []), 'PUBLISHED_DIGEST')
    verify_image(value, receipt)


def promotion_dockerfile(reference, revision):
    require(re.fullmatch(re.escape(REGISTRY) + r'@sha256:[a-f0-9]{64}', reference) is not None,
            'PUBLISHED_REFERENCE')
    require(re.fullmatch('[a-f0-9]{40}', revision) is not None, 'REVISION')
    return f'FROM {reference}\nLABEL {REVISION_LABEL}={revision}\n'
