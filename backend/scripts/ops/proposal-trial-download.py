#!/usr/bin/env python3
"""Read an already issued proposal package through its authenticated API.

The coordinator supplies an independently verified, isolated Owner session and
an exact current observation. This helper sends GETs only, never creates an
export, and returns private document bytes in memory. The caller owns its
absolute run deadline, encrypted transport, session logout and file cleanup.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
import zlib

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('trial_download_observer', HERE / 'proposal-trial-observe.py')
observer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = observer
SPEC.loader.exec_module(observer)

DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
MAIN_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_ENVELOPE_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
MAX_XML_BYTES = 16 * 1024 * 1024
MAX_METADATA_BYTES = 2 * 1024 * 1024
TIMEOUT_SECONDS = 8
TOTAL_SECONDS = 35
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
T = '{http://schemas.openxmlformats.org/package/2006/content-types}'
R = '{http://schemas.openxmlformats.org/package/2006/relationships}'
OFFICE_DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'


class TrialDownloadError(Exception):
    """Only a fixed, non-sensitive code escapes this helper."""


def require(value, code='PROPOSAL_TRIAL_DOWNLOAD_INVALID'):
    if not value:
        raise TrialDownloadError(code)


def _origin(value):
    try:
        parsed = urllib.parse.urlsplit(value)
        require(parsed.scheme == 'https' and parsed.hostname and not parsed.username and not parsed.password
                and parsed.port in (None, 443) and not parsed.path and not parsed.query and not parsed.fragment
                and re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?', parsed.hostname)
                and '..' not in parsed.hostname and value == 'https://' + parsed.hostname,
                'PROPOSAL_TRIAL_DOWNLOAD_ORIGIN_INVALID')
    except (ValueError, TypeError, AttributeError):
        raise TrialDownloadError('PROPOSAL_TRIAL_DOWNLOAD_ORIGIN_INVALID') from None
    return value


def _safe_name(value):
    return (isinstance(value, str) and 1 <= len(value.encode('utf-8')) <= 255
            and value not in {'.', '..'} and value.lower().endswith('.docx')
            and not re.search(r'[\\/\x00-\x1f\x7f]', value))


def _artifact(value, target, snapshot_id):
    require(isinstance(value, dict) and observer.uuid_value(value.get('id'))
            and value.get('snapshot_id') == snapshot_id and value.get('workspace_id') == target['workspace_id']
            and value.get('status') == 'ready' and value.get('renderer_version') == '3'
            and value.get('volume') in {'technical', 'financial', 'combined'}
            and type(value.get('expected_size')) is int and 0 < value['expected_size'] <= MAX_FILE_BYTES
            and isinstance(value.get('content_hash'), str) and re.fullmatch(r'[a-f0-9]{64}', value['content_hash'])
            and _safe_name(value.get('original_name')) and value.get('mime_type') == DOCX_MIME,
            'PROPOSAL_TRIAL_DOWNLOAD_ARTIFACT_INVALID')
    return {key: value[key] for key in ('id', 'volume', 'status', 'expected_size', 'content_hash', 'original_name', 'mime_type')}


def _get(client, config, token, path, limit, deadline, *, mime):
    remaining = deadline - time.monotonic()
    require(remaining > 0, 'PROPOSAL_TRIAL_DOWNLOAD_DEADLINE')
    url = config.origin + path
    request = urllib.request.Request(url, headers={'Accept': mime, 'Cache-Control': 'no-store',
        'Authorization': 'Bearer ' + token, 'apikey': config.anon_key}, method='GET')
    try:
        with client.opener.open(request, timeout=min(TIMEOUT_SECONDS, remaining)) as response:
            require(response.status == 200, 'PROPOSAL_TRIAL_DOWNLOAD_HTTP_FAILED')
            require(response.geturl() == url, 'PROPOSAL_TRIAL_DOWNLOAD_REDIRECT_REJECTED')
            headers = {key.lower(): value for key, value in response.headers.items()}
            require(headers.get('content-type', '').split(';')[0].strip().lower() == mime,
                    'PROPOSAL_TRIAL_DOWNLOAD_CONTENT_TYPE_INVALID')
            length = headers.get('content-length')
            if length is not None:
                require(re.fullmatch(r'[0-9]{1,12}', length) and int(length) <= limit,
                        'PROPOSAL_TRIAL_DOWNLOAD_SIZE_REJECTED')
            chunks, size = [], 0
            # read1 does not wait to fill a large buffer while a peer trickles data.
            read = getattr(response, 'read1', response.read)
            while True:
                require(time.monotonic() < deadline, 'PROPOSAL_TRIAL_DOWNLOAD_DEADLINE')
                part = read(min(65536, limit + 1 - size))
                if not part:
                    break
                size += len(part)
                require(size <= limit, 'PROPOSAL_TRIAL_DOWNLOAD_SIZE_REJECTED')
                chunks.append(part)
            require(length is None or size == int(length), 'PROPOSAL_TRIAL_DOWNLOAD_SIZE_MISMATCH')
            return b''.join(chunks)
    except urllib.error.HTTPError as error:
        error.close()
        raise TrialDownloadError('PROPOSAL_TRIAL_DOWNLOAD_HTTP_FAILED') from None
    except (OSError, urllib.error.URLError, TimeoutError):
        raise TrialDownloadError('PROPOSAL_TRIAL_DOWNLOAD_TRANSPORT_FAILED') from None


def _package(client, config, token, target, snapshot_id, expected, deadline):
    raw = _get(client, config, token, '/functions/v1/api/v1/delivery-snapshots/' + snapshot_id + '/package',
               MAX_METADATA_BYTES, deadline, mime='application/json')
    try:
        envelope = json.loads(raw)
        value = envelope.get('data') if isinstance(envelope, dict) else None
        snapshot = value.get('snapshot') if isinstance(value, dict) else None
        require(isinstance(snapshot, dict) and snapshot.get('id') == snapshot_id
                and snapshot.get('proposal_id') == target['proposal_id']
                and snapshot.get('content_state') == 'generated_review_draft'
                and value.get('status') == 'ready' and isinstance(value.get('job'), dict)
                and value['job'].get('status') == 'succeeded' and isinstance(value.get('artifacts'), list)
                and len(value['artifacts']) == len(expected), 'PROPOSAL_TRIAL_DOWNLOAD_PACKAGE_CHANGED')
        actual = []
        for artifact in value['artifacts']:
            require(isinstance(artifact, dict), 'PROPOSAL_TRIAL_DOWNLOAD_PACKAGE_CHANGED')
            actual.append({key: artifact.get(key) for key in expected[0]})
        require(sorted(actual, key=lambda artifact: str(artifact['id'])) == sorted(expected, key=lambda artifact: artifact['id']),
                'PROPOSAL_TRIAL_DOWNLOAD_PACKAGE_CHANGED')
    except (ValueError, UnicodeDecodeError, TypeError):
        raise TrialDownloadError('PROPOSAL_TRIAL_DOWNLOAD_PACKAGE_INVALID') from None


def _xml(archive, name):
    info = archive.getinfo(name)
    require(info.file_size <= MAX_XML_BYTES, 'PROPOSAL_TRIAL_DOCX_XML_TOO_LARGE')
    # The application renderer emits UTF-8 XML. Decode before checking DTDs so
    # a UTF-16/32 byte encoding cannot hide entity declarations from the check.
    raw = archive.read(info).decode('utf-8-sig')
    require('\x00' not in raw and '<!DOCTYPE' not in raw.upper() and '<!ENTITY' not in raw.upper(),
            'PROPOSAL_TRIAL_DOCX_XML_UNSAFE')
    return ET.fromstring(raw)


def inspect_docx(raw):
    """Validate bounded OPC/Word structure; this is not a visual layout review."""
    require(isinstance(raw, bytes) and 0 < len(raw) <= MAX_FILE_BYTES, 'PROPOSAL_TRIAL_DOCX_SIZE_INVALID')
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            require(3 <= len(entries) <= 4096 and len(set(names)) == len(names)
                    and sum(entry.file_size for entry in entries) <= MAX_EXPANDED_BYTES,
                    'PROPOSAL_TRIAL_DOCX_ARCHIVE_INVALID')
            for entry in entries:
                path = PurePosixPath(entry.filename)
                require(entry.filename and not entry.flag_bits & 1 and not path.is_absolute()
                        and '..' not in path.parts and '\\' not in entry.filename
                        and not re.search(r'[\x00-\x1f\x7f]', entry.filename)
                        and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                        'PROPOSAL_TRIAL_DOCX_ARCHIVE_INVALID')
            require({'[Content_Types].xml', '_rels/.rels', 'word/document.xml'}.issubset(names),
                    'PROPOSAL_TRIAL_DOCX_PART_MISSING')
            types = _xml(archive, '[Content_Types].xml')
            require(types.tag == T + 'Types' and any(node.tag == T + 'Override'
                    and node.get('PartName') == '/word/document.xml' and node.get('ContentType') == MAIN_MIME
                    for node in types), 'PROPOSAL_TRIAL_DOCX_CONTENT_TYPES_INVALID')
            relationships = _xml(archive, '_rels/.rels')
            main = [node for node in relationships if node.get('Type') == OFFICE_DOCUMENT]
            require(relationships.tag == R + 'Relationships' and len(main) == 1
                    and main[0].tag == R + 'Relationship' and main[0].get('Target') in ('word/document.xml', '/word/document.xml')
                    and main[0].get('TargetMode', 'Internal') == 'Internal', 'PROPOSAL_TRIAL_DOCX_RELATIONSHIPS_INVALID')
            document = _xml(archive, 'word/document.xml')
            body = document.find(W + 'body')
            require(document.tag == W + 'document' and body is not None
                    and any((node.text or '').strip() for node in body.iter(W + 't')), 'PROPOSAL_TRIAL_DOCX_BODY_INVALID')
            # Check every member's CRC without extracting or executing anything.
            require(archive.testzip() is None, 'PROPOSAL_TRIAL_DOCX_ARCHIVE_INVALID')
            return {'passed': True, 'zip_members': len(entries), 'paragraphs': sum(1 for _ in body.iter(W + 'p')),
                    'tables': sum(1 for _ in body.iter(W + 'tbl')), 'visual_layout_reviewed': False}
    except (zipfile.BadZipFile, KeyError, ET.ParseError, RuntimeError, NotImplementedError, EOFError, ValueError, zlib.error):
        raise TrialDownloadError('PROPOSAL_TRIAL_DOCX_INVALID') from None


def download(client, config, session, observation):
    """Return up to two authenticated DOCX artifacts in a PRIVATE envelope."""
    try:
        receipt = observer.public_receipt(observation)
        require(receipt.get('outcome') == 'issued' and receipt.get('whole_package_issued') is True,
                'PROPOSAL_TRIAL_DOWNLOAD_NOT_ISSUED')
    except (observer.TrialObservationError, observer.issuance.IssuanceObservationError):
        raise TrialDownloadError('PROPOSAL_TRIAL_DOWNLOAD_OBSERVATION_INVALID') from None
    target = observation['target']
    _origin(config.origin)
    require(getattr(client, 'config', None) is config and isinstance(config.anon_key, str) and config.anon_key
            and not re.search(r'[\r\n]', config.anon_key), 'PROPOSAL_TRIAL_DOWNLOAD_CLIENT_INVALID')
    # The existing smoke client builds this handler with the verified TLS context.
    # Refuse the standard redirect follower before transmitting credentials.
    redirects = [handler for handler in getattr(client.opener, 'handlers', [])
                 if isinstance(handler, urllib.request.HTTPRedirectHandler)]
    require(len(redirects) == 1 and type(redirects[0]).__name__ == 'NoRedirect'
            and type(redirects[0]).redirect_request is not urllib.request.HTTPRedirectHandler.redirect_request,
            'PROPOSAL_TRIAL_DOWNLOAD_REDIRECT_HANDLER_INVALID')
    require(isinstance(session, dict) and isinstance(session.get('user'), dict)
            and session['user'].get('id') == target['actor_id'] and isinstance(session.get('access_token'), str)
            and session['access_token'] and not re.search(r'[\r\n]', session['access_token']),
            'PROPOSAL_TRIAL_DOWNLOAD_SESSION_INVALID')
    package = observation['sample']['package']
    snapshot_id = package['snapshot_id']
    require(1 <= len(package['artifacts']) <= 2, 'PROPOSAL_TRIAL_DOWNLOAD_ARTIFACT_INVALID')
    expected = [_artifact(value, target, snapshot_id) for value in package['artifacts']]
    require(len({value['id'] for value in expected}) == len(expected)
            and len({value['original_name'] for value in expected}) == len(expected),
            'PROPOSAL_TRIAL_DOWNLOAD_ARTIFACT_INVALID')
    deadline = time.monotonic() + TOTAL_SECONDS
    token = session['access_token']
    _package(client, config, token, target, snapshot_id, expected, deadline)
    artifacts = []
    for artifact in expected:
        raw = _get(client, config, token, '/functions/v1/api/v1/delivery-artifacts/' + artifact['id'] + '/download',
                   artifact['expected_size'], deadline, mime=DOCX_MIME)
        require(len(raw) == artifact['expected_size'] and hashlib.sha256(raw).hexdigest() == artifact['content_hash'],
                'PROPOSAL_TRIAL_DOWNLOAD_HASH_MISMATCH')
        structure = inspect_docx(raw)
        artifacts.append(artifact | {'bytes_base64': base64.b64encode(raw).decode('ascii'), 'docx_structure': structure})
    _package(client, config, token, target, snapshot_id, expected, deadline)
    require(time.monotonic() < deadline, 'PROPOSAL_TRIAL_DOWNLOAD_DEADLINE')
    result = {'version': 1, 'kind': 'proposal_trial_download', 'target': dict(target), 'snapshot_id': snapshot_id,
              'passed': True, 'authenticated_download_verified': True, 'metadata_only': False,
              'artifacts': artifacts, 'provider_calls': 0, 'business_mutations': 0,
              'human_approval_verified': False, 'visual_layout_reviewed': False}
    require(len(json.dumps(result, ensure_ascii=True).encode('utf-8')) < MAX_ENVELOPE_BYTES,
            'PROPOSAL_TRIAL_DOWNLOAD_ENVELOPE_TOO_LARGE')
    return result
