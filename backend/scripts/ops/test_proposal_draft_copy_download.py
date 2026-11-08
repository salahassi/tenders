"""Real ordinary-copy download boundaries with synthetic HTTP and DOCX bytes."""
import base64
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, HERE / path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value

m = load('draft_copy_download_tested', 'proposal-draft-copy.py')
f = load('draft_copy_download_fixtures', 'test_proposal_trial_download.py')


class DraftCopyDownloadTests(unittest.TestCase):
    def setUp(self):
        ids = ('workspace_id', 'opportunity_id', 'proposal_id', 'plan_id', 'proposal_version_id',
               'actor_id', 'failed_issuance_request_id', 'package_id', 'job_id')
        self.target = {key: f.uuid(index + 1) for index, key in enumerate(ids)}
        self.target.update(version_revision=2, version_content_hash='a' * 64, review_hash='b' * 64,
            review_finding_count=8, blocking_finding_count=6, accepted_at=self.stamp(0),
            deadline_at=self.stamp(600), required_volumes=['technical', 'financial'],
            preserved=dict.fromkeys(m.PRESERVED, 'c' * 64))
        self.findings = [{'severity': 'blocking' if index < 6 else 'advisory',
            'detail': 'Synthetic review finding ' + str(index + 1) + ' remains unresolved.'} for index in range(8)]
        self.raw = self.document()
        self.config = SimpleNamespace(origin='https://example.test', anon_key='synthetic-public-key')
        self.session = {'user': {'id': self.target['actor_id']}, 'access_token': 'synthetic-owner-token'}
        self.observation = self.evidence()

    @staticmethod
    def stamp(seconds):
        return (datetime(2026, 11, 8, tzinfo=timezone.utc) + timedelta(seconds=seconds)).isoformat()

    def document(self, *, label=True, findings=None):
        paragraphs = (['DRAFT — Review before external use'] if label else [])
        paragraphs += ['Synthetic technical and financial review copy']
        paragraphs += [item['detail'] for item in self.findings if findings is None or item in findings]
        xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
        xml += ''.join('<w:p><w:r><w:t>' + escape(text) + '</w:t></w:r></w:p>' for text in paragraphs)
        return f.docx(changes={'word/document.xml': xml + '</w:body></w:document>'})

    def evidence(self):
        artifacts = [{'id': f.uuid(30 + index), 'export_id': f.uuid(40 + index), 'volume': volume,
            'status': 'ready', 'content_hash': hashlib.sha256(self.raw).hexdigest(), 'expected_size': len(self.raw),
            'original_name': volume + '.docx', 'mime_type': m.files.DOCX_MIME}
            for index, volume in enumerate(self.target['required_volumes'])]
        sample = {'observed_at': self.stamp(25), 'preserved': self.target['preserved'].copy(),
            'package': {'id': self.target['package_id'], 'proposal_version_id': self.target['proposal_version_id'],
                'version_revision': 2, 'mode': 'draft', 'renderer_version': 'ordinary-2', 'status': 'ready',
                'error_code': None, 'current_job_id': self.target['job_id'], 'accepted_at': self.stamp(0),
                'deadline_at': self.stamp(600), 'required_volumes': self.target['required_volumes'].copy(),
                'updated_at': self.stamp(20)},
            'job': {'id': self.target['job_id'], 'type': 'render_export', 'entity_id': self.target['package_id'],
                'status': 'succeeded', 'error_code': None}, 'findings': copy.deepcopy(self.findings), 'artifacts': artifacts,
            'guards': dict.fromkeys(('source', 'owner', 'version', 'latest_plan', 'failed_issuance', 'no_restore', 'snapshot_reviews'), True)}
        return m._observation(sample, self.target)

    def bootstrap(self):
        return {'data': {'workspace': {'id': self.target['workspace_id']}, 'membership': {
            'workspace_id': self.target['workspace_id'], 'user_id': self.target['actor_id'], 'role': 'Owner'}}}

    def package(self):
        value = copy.deepcopy(self.observation['sample']['package'])
        value['job'] = copy.deepcopy(self.observation['sample']['job'])
        value['artifacts'] = copy.deepcopy(self.observation['sample']['artifacts'])
        return {'data': value}

    def response(self, route, value):
        return f.Response(self.config.origin + '/functions/v1/api/v1/' + route,
                          json.dumps(value).encode(), 'application/json')

    def client(self, raw_by_volume=None):
        package_route = 'export-packages/' + self.target['package_id']
        responses = [self.response('bootstrap', self.bootstrap()), self.response(package_route, self.package())]
        for artifact in sorted(self.observation['sample']['artifacts'], key=lambda item: item['volume']):
            raw = (raw_by_volume or {}).get(artifact['volume'], self.raw)
            responses.append(f.Response(self.config.origin + '/functions/v1/api/v1/export-artifacts/'
                + artifact['id'] + '/download', raw, m.files.DOCX_MIME))
        responses += [self.response('bootstrap', self.bootstrap()), self.response(package_route, self.package())]
        return SimpleNamespace(config=self.config, opener=f.Opener(responses))

    def download(self, client=None):
        return m.download(client or self.client(), self.config, self.session, self.observation)

    def replace_file(self, raw, volumes=('technical', 'financial')):
        for artifact in self.observation['sample']['artifacts']:
            if artifact['volume'] in volumes:
                artifact.update(expected_size=len(raw), content_hash=hashlib.sha256(raw).hexdigest())
        return self.client(dict.fromkeys(volumes, raw))

    def test_two_files_use_only_owner_authenticated_canonical_gets(self):
        client = self.client(); result = self.download(client)
        self.assertEqual(result['kind'], 'proposal_draft_copy_download')
        self.assertEqual(result['target'], self.target)
        self.assertTrue(result['draft_copy_only']); self.assertFalse(result['generated_issuance_passed'])
        self.assertFalse(result['final_approval_changed']); self.assertTrue(result['all_review_findings_preserved'])
        self.assertEqual((result['provider_calls'], result['model_calls'], result['business_commands']), (0, 0, 0))
        self.assertEqual(len(client.opener.requests), 6)
        for artifact in result['artifacts']:
            self.assertEqual(base64.b64decode(artifact['bytes_base64']), self.raw)
            self.assertTrue(artifact['docx_structure']['passed'])
        for request, timeout in client.opener.requests:
            self.assertEqual(request.get_method(), 'GET'); self.assertIsNone(request.data)
            self.assertEqual(request.get_header('Authorization'), 'Bearer ' + self.session['access_token'])
            self.assertEqual(request.get_header('Apikey'), self.config.anon_key); self.assertLessEqual(timeout, 8)
            self.assertRegex(request.full_url, r'^https://example\.test/functions/v1/api/v1/(bootstrap|export-packages/[a-f0-9-]+|export-artifacts/[a-f0-9-]+/download)$')
            self.assertNotIn('/commands', request.full_url)

    def test_ready_only_and_failed_issuance_currentness_before_http(self):
        for change, code in ((lambda sample: sample['package'].update(status='blocked', error_code='EXPORT_RENDER_TERMINATED'), 'NOT_READY'),
                (lambda sample: sample['guards'].update(failed_issuance=False), 'CURRENTNESS_FAILED')):
            self.setUp(); client = self.client(); change(self.observation['sample'])
            if code == 'NOT_READY':
                self.observation = m._observation(self.observation['sample'], self.target)
            with self.assertRaisesRegex(m.DraftCopyError, code): self.download(client)
            self.assertEqual(client.opener.requests, [])

    def test_exact_session_and_current_owner_are_required_before_and_after_reads(self):
        client = self.client(); self.session['user']['id'] = f.uuid(999)
        with self.assertRaises(m.DraftCopyError): self.download(client)
        self.assertEqual(client.opener.requests, [])
        for position in (0, -2):
            self.setUp(); client = self.client(); value = self.bootstrap(); value['data']['membership']['role'] = 'Editor'
            client.opener.responses[position] = self.response('bootstrap', value)
            with self.assertRaisesRegex(m.DraftCopyError, 'OWNER_CHANGED'): self.download(client)

    def test_package_identity_mode_job_and_artifacts_are_rechecked(self):
        for position in (1, -1):
            for key, value in (('id', f.uuid(999)), ('proposal_version_id', f.uuid(999)), ('mode', 'final'),
                    ('renderer_version', '3'), ('status', 'preparing'), ('deadline_at', self.stamp(601))):
                self.setUp(); client = self.client(); data = self.package(); data['data'][key] = value
                client.opener.responses[position] = self.response('export-packages/' + self.target['package_id'], data)
                with self.subTest(position=position, key=key), self.assertRaisesRegex(m.DraftCopyError, 'PACKAGE_CHANGED'):
                    self.download(client)
        for mutate in (lambda p: p['data']['job'].update(id=f.uuid(999)),
                lambda p: p['data']['artifacts'][0].update(content_hash='f' * 64)):
            self.setUp(); client = self.client(); data = self.package(); mutate(data)
            client.opener.responses[1] = self.response('export-packages/' + self.target['package_id'], data)
            with self.assertRaisesRegex(m.DraftCopyError, 'PACKAGE_CHANGED'): self.download(client)

    def test_extra_partial_duplicate_or_malformed_artifacts_fail_before_http(self):
        changes = (
            lambda items: items.append(copy.deepcopy(items[0])),
            lambda items: items.pop(),
            lambda items: items[1].update(id=items[0]['id']),
            lambda items: items[0].update(original_name='../unsafe.docx'),
            lambda items: items[0].update(content_hash='invalid'),
            lambda items: items[0].update(mime_type='text/html'),
        )
        for change in changes:
            self.setUp(); client = self.client(); change(self.observation['sample']['artifacts'])
            with self.assertRaises(m.DraftCopyError): self.download(client)
            self.assertEqual(client.opener.requests, [])

    def test_redirects_following_opener_and_html_are_rejected(self):
        client = self.client(); client.opener.handlers = [urllib.request.HTTPRedirectHandler()]
        with self.assertRaises(m.DraftCopyError): self.download(client)
        self.assertEqual(client.opener.requests, [])
        for alteration, code in ((lambda r: setattr(r, 'url', 'https://foreign.test/file'), 'REDIRECT_REJECTED'),
                (lambda r: r.headers.update({'Content-Type': 'text/html'}), 'CONTENT_TYPE_INVALID')):
            self.setUp(); client = self.client(); alteration(client.opener.responses[2])
            with self.assertRaisesRegex(m.files.TrialDownloadError, code): self.download(client)
        self.setUp(); client = self.client()
        client.opener.responses[2] = urllib.error.HTTPError('https://example.test', 302, 'redirect', {}, None)
        with self.assertRaisesRegex(m.files.TrialDownloadError, 'HTTP_FAILED'): self.download(client)

    def test_size_hash_and_http_body_bound_are_enforced(self):
        for raw in (b'x' * len(self.raw), self.raw + b'x'):
            client = self.client(); response = client.opener.responses[2]
            client.opener.responses[2] = f.Response(response.url, raw, m.files.DOCX_MIME)
            with self.assertRaisesRegex(m.DraftCopyError, 'BYTES_CHANGED'): self.download(client)
        client = self.client()
        with patch.object(m.files, 'MAX_FILE_BYTES', len(self.raw) - 1), self.assertRaisesRegex(m.DraftCopyError, 'ARTIFACT_INVALID'):
            self.download(client)
        client = self.client(); response = client.opener.responses[2]
        response.headers['Content-Length'] = str(m.files.MAX_FILE_BYTES + 1)
        with self.assertRaisesRegex(m.files.TrialDownloadError, 'SIZE_REJECTED'): self.download(client)

    def test_matched_hash_cannot_authorize_invalid_or_unsafe_docx(self):
        for raw in (b'not an OPC document', f.docx(extra=[('../escape', 'bad')]),
                f.docx(changes={'word/document.xml': '<!DOCTYPE x [<!ENTITY e "bad">]><x>&e;</x>'})):
            self.setUp(); client = self.replace_file(raw)
            with self.assertRaises(m.files.TrialDownloadError): self.download(client)

    def test_each_artifact_retains_draft_label(self):
        for volumes in (('technical', 'financial'), ('technical',)):
            self.setUp(); client = self.replace_file(self.document(label=False), volumes)
            with self.subTest(volumes=volumes), self.assertRaisesRegex(m.DraftCopyError, 'LABEL_MISSING'):
                self.download(client)

    def test_all_six_blocking_and_two_advisory_findings_are_visible(self):
        for missing in range(8):
            self.setUp(); retained = [item for index, item in enumerate(self.findings) if index != missing]
            client = self.replace_file(self.document(findings=retained))
            with self.subTest(missing=missing), self.assertRaisesRegex(m.DraftCopyError, 'FINDING_MISSING'):
                self.download(client)

    def test_total_deadline_is_shared_across_all_gets(self):
        client = self.client()
        with patch.object(m.time, 'monotonic', side_effect=[0, 36]), self.assertRaisesRegex(m.files.TrialDownloadError, 'DEADLINE'):
            self.download(client)
        self.assertEqual(client.opener.requests, [])


if __name__ == '__main__': unittest.main()
