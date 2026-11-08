import base64
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import warnings
import zipfile

SPEC = importlib.util.spec_from_file_location('trial_download_test', Path(__file__).with_name('proposal-trial-download.py'))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def uuid(number):
    return '00000000-0000-4000-8000-' + str(number).zfill(12)


def docx(*, changes=None, extra=None):
    parts = {
        '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Override PartName="/word/document.xml" ContentType="' + m.MAIN_MIME + '"/></Types>',
        '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="' + m.OFFICE_DOCUMENT + '" Target="word/document.xml"/></Relationships>',
        'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:body><w:p><w:r><w:t>Automated fixture proposal</w:t></w:r></w:p></w:body></w:document>',
    }
    parts.update(changes or {})
    buffer = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', UserWarning)
        with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name, body in parts.items():
                if body is not None:
                    archive.writestr(name, body)
            for name, body in (extra or []):
                archive.writestr(name, body)
    return buffer.getvalue()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class Response(io.BytesIO):
    def __init__(self, url, raw, mime, *, status=200, headers=None):
        super().__init__(raw)
        self.url, self.status = url, status
        self.headers = {'Content-Type': mime, 'Content-Length': str(len(raw))} | (headers or {})

    def geturl(self):
        return self.url


class Opener:
    def __init__(self, responses):
        self.responses = responses
        self.handlers = [NoRedirect()]
        self.requests = []

    def open(self, request, *, timeout):
        self.requests.append((request, timeout))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class TrialDownloadTests(unittest.TestCase):
    def setUp(self):
        self.target = {key: uuid(i) for i, key in enumerate(sorted(m.observer.UUID_KEYS), 1)}
        self.target['operation'] = 'generation.retry'
        self.config = SimpleNamespace(origin='https://example.test', anon_key='fixture-public-key')
        self.session = {'user': {'id': self.target['actor_id']}, 'access_token': 'fixture-isolated-user-token'}
        self.snapshot_id = uuid(20)
        self.raw = docx()
        self.observation = self.evidence()

    def stamp(self, seconds):
        return (datetime(2026, 11, 8, tzinfo=timezone.utc) + timedelta(seconds=seconds)).isoformat()

    def evidence(self, volumes=('technical', 'financial')):
        artifacts = [{'id': uuid(30 + index), 'snapshot_id': self.snapshot_id,
            'workspace_id': self.target['workspace_id'], 'volume': volume, 'status': 'ready',
            'expected_size': len(self.raw), 'content_hash': hashlib.sha256(self.raw).hexdigest(),
            'original_name': volume + '.docx', 'mime_type': m.DOCX_MIME, 'renderer_version': '3',
            'created_at': self.stamp(97), 'updated_at': self.stamp(98)} for index, volume in enumerate(volumes)]
        sample = {'version': 1, 'kind': 'current_proposal_issuance_observation', 'target': self.target.copy(),
            'observed_at': self.stamp(102), 'guards': dict.fromkeys(m.observer.issuance.GUARDS, True),
            'artifact_check': 'passed', 'source_check': 'passed', 'terminal_jobs': [],
            'job_progress': {'total': 1, 'completed': 1, 'groups': [{'type': 'render_delivery', 'status': 'succeeded',
                'count': 1, 'updated_at': self.stamp(99)}]},
            'attempt_progress': {'total': 0, 'accepted_waits': 0, 'last_started_at': None, 'last_finished_at': None},
            'issuance': {'id': self.target['issuance_request_id'], 'plan_id': self.target['plan_id'],
                'requested_by': self.target['actor_id'], 'operation': self.target['operation'],
                'accepted_at': self.stamp(0), 'deadline_at': self.stamp(600), 'outcome': 'issued',
                'completed_at': self.stamp(100), 'error_code': None, 'issued_snapshot_id': self.snapshot_id,
                'effective_outcome': 'issued', 'effective_error_code': None, 'effective_completed_at': self.stamp(100)},
            'package': {'snapshot_id': self.snapshot_id, 'proposal_version_id': uuid(21), 'current_version': True,
                'current_snapshot': True, 'validated_generated_draft': True, 'content_state': 'generated_review_draft',
                'approval_state': 'draft', 'required_volumes': list(volumes),
                'render_job': {'status': 'succeeded', 'updated_at': self.stamp(99)}, 'artifacts': artifacts}}
        return {'version': 1, 'kind': 'proposal_trial_observation', 'target': self.target.copy(),
            'outcome': 'issued', 'code': None, 'whole_package_issued': True, 'sample': sample}

    def package(self):
        return {'data': {'snapshot': {'id': self.snapshot_id, 'proposal_id': self.target['proposal_id'],
            'content_state': 'generated_review_draft'}, 'status': 'ready', 'job': {'status': 'succeeded'},
            'artifacts': [{key: artifact[key] for key in ('id', 'volume', 'status', 'content_hash',
                'expected_size', 'original_name', 'mime_type')} for artifact in self.observation['sample']['package']['artifacts']]}}

    def package_response(self, value=None):
        url = self.config.origin + '/functions/v1/api/v1/delivery-snapshots/' + self.snapshot_id + '/package'
        return Response(url, json.dumps(value or self.package()).encode(), 'application/json')

    def client(self):
        responses = [self.package_response()]
        for artifact in self.observation['sample']['package']['artifacts']:
            url = self.config.origin + '/functions/v1/api/v1/delivery-artifacts/' + artifact['id'] + '/download'
            responses.append(Response(url, self.raw, m.DOCX_MIME))
        responses.append(self.package_response())
        return SimpleNamespace(config=self.config, opener=Opener(responses))

    def run_download(self, client=None):
        return m.download(client or self.client(), self.config, self.session, self.observation)

    def test_two_volumes_verify_bytes_and_only_use_authenticated_canonical_gets(self):
        client = self.client()
        report = self.run_download(client)
        self.assertEqual(report['target'], self.target)
        self.assertEqual(report['target']['operation'], 'generation.retry')
        self.assertEqual(report['snapshot_id'], self.snapshot_id)
        self.assertTrue(report['authenticated_download_verified'])
        self.assertEqual((report['provider_calls'], report['business_mutations']), (0, 0))
        self.assertFalse(report['human_approval_verified'])
        self.assertFalse(report['visual_layout_reviewed'])
        self.assertEqual(len(client.opener.requests), 4)
        for artifact in report['artifacts']:
            self.assertEqual(base64.b64decode(artifact['bytes_base64']), self.raw)
            self.assertTrue(artifact['docx_structure']['passed'])
            self.assertEqual(artifact['docx_structure']['paragraphs'], 1)
        for request, timeout in client.opener.requests:
            self.assertEqual(request.get_method(), 'GET')
            self.assertIsNone(request.data)
            self.assertEqual(request.get_header('Authorization'), 'Bearer ' + self.session['access_token'])
            self.assertEqual(request.get_header('Apikey'), self.config.anon_key)
            self.assertLessEqual(timeout, 8)
            self.assertRegex(request.full_url, r'^https://example\.test/functions/v1/api/v1/delivery-(snapshots|artifacts)/[a-f0-9-]+/(package|download)$')

    def test_combined_package_uses_one_file(self):
        self.observation = self.evidence(('combined',))
        report = self.run_download()
        self.assertEqual([artifact['volume'] for artifact in report['artifacts']], ['combined'])

    def test_every_target_identity_and_operation_is_bound_before_http(self):
        for key in self.target:
            with self.subTest(key=key):
                client = self.client()
                original = copy.deepcopy(self.observation)
                self.observation['target'][key] = 'proposal.generate' if key == 'operation' else uuid(999)
                with self.assertRaisesRegex(m.TrialDownloadError, 'OBSERVATION_INVALID'):
                    self.run_download(client)
                self.assertEqual(client.opener.requests, [])
                self.observation = original

    def test_stale_guard_partial_volume_wrong_actor_and_foreign_artifact_are_rejected(self):
        changes = (
            lambda: self.observation['sample']['guards'].update(sources=False),
            lambda: self.observation['sample']['package']['artifacts'].pop(),
            lambda: self.session['user'].update(id=uuid(999)),
            lambda: self.observation['sample']['package']['artifacts'][0].update(workspace_id=uuid(999)),
            lambda: self.observation['sample']['package'].update(current_snapshot=False),
        )
        for change in changes:
            self.setUp()
            client = self.client()
            change()
            with self.assertRaises(m.TrialDownloadError):
                self.run_download(client)
            self.assertEqual(client.opener.requests, [])

    def test_package_metadata_drift_before_download_and_after_download_fails(self):
        for index in (0, -1):
            client = self.client()
            changed = self.package()
            changed['data']['artifacts'][0]['content_hash'] = 'a' * 64
            client.opener.responses[index] = self.package_response(changed)
            with self.assertRaisesRegex(m.TrialDownloadError, 'PACKAGE_CHANGED'):
                self.run_download(client)
            self.assertEqual(len(client.opener.requests), 1 if index == 0 else 4)

    def test_wrong_hash_and_bounded_excess_body_are_rejected(self):
        client = self.client()
        body = client.opener.responses[1]
        client.opener.responses[1] = Response(body.url, b'x' * len(self.raw), m.DOCX_MIME)
        with self.assertRaisesRegex(m.TrialDownloadError, 'HASH_MISMATCH'):
            self.run_download(client)
        client = self.client()
        body = client.opener.responses[1]
        excess = Response(body.url, self.raw + b'x', m.DOCX_MIME)
        excess.headers.pop('Content-Length')
        client.opener.responses[1] = excess
        with self.assertRaisesRegex(m.TrialDownloadError, 'SIZE_REJECTED'):
            self.run_download(client)

    def test_html_error_redirect_and_following_opener_are_rejected(self):
        client = self.client()
        client.opener.responses[1].headers['Content-Type'] = 'text/html'
        with self.assertRaisesRegex(m.TrialDownloadError, 'CONTENT_TYPE_INVALID'):
            self.run_download(client)
        client = self.client()
        client.opener.responses[1] = urllib.error.HTTPError('https://example.test', 302, 'redirect', {}, None)
        with self.assertRaisesRegex(m.TrialDownloadError, 'HTTP_FAILED'):
            self.run_download(client)
        client = self.client()
        client.opener.handlers = [urllib.request.HTTPRedirectHandler()]
        with self.assertRaisesRegex(m.TrialDownloadError, 'REDIRECT_HANDLER_INVALID'):
            self.run_download(client)
        self.assertEqual(client.opener.requests, [])

    def test_foreign_origin_and_response_url_are_rejected(self):
        self.config.origin = 'http://example.test'
        with self.assertRaisesRegex(m.TrialDownloadError, 'ORIGIN_INVALID'):
            self.run_download()
        self.setUp()
        client = self.client()
        client.opener.responses[1].url = 'https://foreign.test/document'
        with self.assertRaisesRegex(m.TrialDownloadError, 'REDIRECT_REJECTED'):
            self.run_download(client)

    def test_bad_filenames_duplicate_ids_and_oversize_metadata_reject_before_http(self):
        for name in ('../proposal.docx', 'folder\\proposal.docx', 'secret\n.docx', 'wrong.pdf'):
            self.setUp()
            self.observation['sample']['package']['artifacts'][0]['original_name'] = name
            client = self.client()
            with self.assertRaisesRegex(m.TrialDownloadError, 'ARTIFACT_INVALID'):
                self.run_download(client)
            self.assertEqual(client.opener.requests, [])
        self.setUp()
        artifacts = self.observation['sample']['package']['artifacts']
        artifacts[1]['id'] = artifacts[0]['id']
        with self.assertRaisesRegex(m.TrialDownloadError, 'ARTIFACT_INVALID'):
            self.run_download()
        self.setUp()
        self.observation['sample']['package']['artifacts'][0]['expected_size'] = m.MAX_FILE_BYTES + 1
        with self.assertRaisesRegex(m.TrialDownloadError, 'ARTIFACT_INVALID'):
            self.run_download()

    def test_docx_rejects_non_zip_duplicate_traversal_missing_part_and_unsafe_xml(self):
        cases = [b'not a document', docx(extra=[('word/document.xml', 'duplicate')]),
            docx(extra=[('../outside', 'traversal')]), docx(changes={'word/document.xml': None}),
            docx(changes={'word/document.xml': '<!DOCTYPE x [<!ENTITY x "expansion">]><x>&x;</x>'}),
            docx(changes={'word/document.xml': ('<?xml version="1.0" encoding="UTF-16"?>'
                '<!DOCTYPE x [<!ENTITY x "expansion">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                '<w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>').encode('utf-16')}),
            docx(changes={'word/document.xml': '<html>not Word</html>'})]
        for raw in cases:
            with self.subTest(size=len(raw)), self.assertRaises(m.TrialDownloadError):
                m.inspect_docx(raw)

    def test_docx_bomb_and_external_main_relationship_are_rejected(self):
        raw = docx(extra=[('large.txt', b'0' * 1024)])
        with patch.object(m, 'MAX_EXPANDED_BYTES', 512), self.assertRaisesRegex(m.TrialDownloadError, 'ARCHIVE_INVALID'):
            m.inspect_docx(raw)
        raw = docx(changes={'_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="' + m.OFFICE_DOCUMENT + '" Target="word/document.xml" TargetMode="External"/></Relationships>'})
        with self.assertRaisesRegex(m.TrialDownloadError, 'RELATIONSHIPS_INVALID'):
            m.inspect_docx(raw)

    def test_total_deadline_is_not_reset_between_reads(self):
        client = self.client()
        with patch.object(m.time, 'monotonic', side_effect=[0, 36]), self.assertRaisesRegex(m.TrialDownloadError, 'DEADLINE'):
            self.run_download(client)
        self.assertEqual(client.opener.requests, [])


if __name__ == '__main__':
    unittest.main()
