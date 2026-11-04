"""Offline restore bucket contract. Actual pinned HTTP has its own opt-in probe."""
import importlib.util
import json
from pathlib import Path
import re
import sys
import types
import unittest
from unittest.mock import Mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('bucket_cloud_restore', HERE / 'proposal-cloud-restore.py')
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


class RestoreBucketTests(unittest.TestCase):
    def setUp(self):
        self.module = types.ModuleType('restore_bucket_acceptance_test')
        sys.modules[self.module.__name__] = self.module
        self.addCleanup(sys.modules.pop, self.module.__name__, None)
        source, _ = restore.acceptance_source((HERE / 'bootstrap/acceptance.py').read_text())
        exec(source, self.module.__dict__)
        self.client = Mock()
        self.probe = self.module.RestoreAcceptance(types.SimpleNamespace(storage_url='http://127.0.0.1:5000', service_key='synthetic-only'), self.client)
        self.metadata = {'id': 'tenderdesk-private', 'name': 'tenderdesk-private', 'public': False, 'file_size_limit': 1048576}

    def response(self, status, value):
        return self.module.Response(status, json.dumps(value).encode())

    def test_fresh_private_bucket_matches_isolated_bootstrap_limit_and_is_read_back(self):
        configured = re.findall(r'_literal\("FILE_SIZE_LIMIT", "(\d+)"\)', (HERE / 'bootstrap/buildcontainers.py').read_text())
        self.assertEqual(configured, ['1048576'])
        self.client.request.side_effect = [self.response(200, {'name': 'tenderdesk-private'}), self.response(200, self.metadata)]
        self.probe.create_private_fixture_bucket()
        calls = self.client.request.call_args_list
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0].args, ('http://127.0.0.1:5000', '/bucket'))
        self.assertEqual(calls[0].kwargs, {'method': 'POST', 'token': 'synthetic-only', 'data': self.metadata})
        self.assertEqual(calls[1].args, ('http://127.0.0.1:5000', '/bucket/tenderdesk-private'))
        self.assertEqual(calls[1].kwargs, {'token': 'synthetic-only'})

    def test_public_missing_wrong_or_unbounded_metadata_fails_closed(self):
        for change in ({'public': True}, {'public': 0}, {'id': 'other'}, {'name': 'other'}, {'file_size_limit': None},
                       {'file_size_limit': 10485760}, {'file_size_limit': '1048576'}):
            with self.subTest(change=change):
                self.client.request.side_effect = [self.response(201, {'name': 'tenderdesk-private'}), self.response(200, self.metadata | change)]
                with self.assertRaises(self.module.ProbeFailure) as caught:
                    self.probe.create_private_fixture_bucket()
                self.assertEqual(caught.exception.code, 'RESTORE_PRIVATE_BUCKET_METADATA_MISMATCH')
        for value in (None, [], {}, {'public': False}):
            self.client.request.side_effect = [self.response(200, {'name': 'tenderdesk-private'}), self.response(200, value)]
            with self.assertRaises(self.module.ProbeFailure): self.probe.create_private_fixture_bucket()

    def test_existing_bucket_is_rejected_without_update_or_unproved_acceptance(self):
        self.client.request.return_value = self.response(409, {'code': 'BucketAlreadyExists', 'message': 'PRIVATE bucket data'})
        with self.assertRaises(self.module.ProbeFailure) as caught: self.probe.create_private_fixture_bucket()
        self.assertEqual(caught.exception.code, 'RESTORE_PRIVATE_BUCKET_CREATE_FAILED_HTTP_409_BucketAlreadyExists')
        self.assertEqual(self.client.request.call_count, 1)

    def test_bucket_error_diagnostics_do_not_disclose_private_strings_or_sql(self):
        for body, expected in (({'code': 'EntityTooLarge', 'message': 'PRIVATE SQL'}, 'EntityTooLarge'),
                               ({'code': 'AccessDenied', 'details': 'PRIVATE'}, 'AccessDenied'),
                               ({'code': 'PRIVATE_CUSTOMER_ID', 'error': 'PRIVATE'}, 'UNCLASSIFIED'),
                               ({'code': ['EntityTooLarge']}, 'UNCLASSIFIED'), ('PRIVATE', 'UNCLASSIFIED')):
            with self.subTest(expected=expected):
                self.client.request.return_value = self.response(400, body)
                with self.assertRaises(self.module.ProbeFailure) as caught: self.probe.create_private_fixture_bucket()
                self.assertEqual(caught.exception.code, 'RESTORE_PRIVATE_BUCKET_CREATE_FAILED_HTTP_400_' + expected)
                self.assertNotIn('PRIVATE', caught.exception.code.replace('RESTORE_PRIVATE_BUCKET', ''))
        self.client.request.return_value = self.module.Response(502, b'<html>PRIVATE</html>')
        with self.assertRaises(self.module.ProbeFailure) as caught: self.probe.create_private_fixture_bucket()
        self.assertEqual(caught.exception.code, 'RESTORE_PRIVATE_BUCKET_CREATE_FAILED_HTTP_502_UNCLASSIFIED')

    def test_lookup_failure_keeps_status_and_safe_error_class(self):
        self.client.request.side_effect = [self.response(200, {'name': 'tenderdesk-private'}), self.response(403, {'code': 'AccessDenied', 'message': 'PRIVATE'})]
        with self.assertRaises(self.module.ProbeFailure) as caught: self.probe.create_private_fixture_bucket()
        self.assertEqual(caught.exception.code, 'RESTORE_PRIVATE_BUCKET_LOOKUP_FAILED_HTTP_403_AccessDenied')

    def test_malformed_success_cannot_skip_metadata_or_prove_private(self):
        for value in (None, [], {}, {'name': 'other'}):
            self.client.request.reset_mock()
            self.client.request.return_value = self.response(200, value)
            with self.assertRaises(self.module.ProbeFailure) as caught: self.probe.create_private_fixture_bucket()
            self.assertEqual(caught.exception.code, 'RESTORE_PRIVATE_BUCKET_RESPONSE_INVALID')
            self.assertEqual(self.client.request.call_count, 1)


if __name__ == '__main__': unittest.main()
