#!/usr/bin/env python3
"""Opt-in actual pinned Storage bucket regression; synthetic isolated network only."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'backend/scripts/testing'))
import storage_retirement_container as storage


class FixtureReady(Exception):
    pass


class BucketProbe(storage.Probe):
    def attest(self):
        info = json.loads(self.docker('image', 'inspect', storage.STORAGE).stdout)[0]
        assert storage.STORAGE.split('@')[1] in ' '.join(info['RepoDigests'])
        self.receipt['storage_image_id'] = info['Id']

    def start_storage(self):
        # Match the actual disposable bootstrap deployment, without touching it.
        original = self.env.read_text()
        assert original.count('FILE_SIZE_LIMIT=10485760\n') == 1
        self.env.write_text(original.replace('FILE_SIZE_LIMIT=10485760\n', 'FILE_SIZE_LIMIT=1048576\n'))
        super().start_storage()
        # Stop setup before its unrelated retirement bucket/guard installation.
        raise FixtureReady()


def load_acceptance():
    path = ROOT / 'backend/scripts/ops/proposal-cloud-restore.py'
    spec = importlib.util.spec_from_file_location('bucket_restore_harness', path)
    restore = importlib.util.module_from_spec(spec);spec.loader.exec_module(restore)
    source, _ = restore.acceptance_source((ROOT / 'backend/scripts/ops/bootstrap/acceptance.py').read_text())
    module = types.ModuleType('pinned_bucket_acceptance');sys.modules[module.__name__] = module
    exec(source, module.__dict__)
    return module


def qualify(output):
    output.mkdir(parents=True, exist_ok=True)
    probe = BucketProbe(output)
    try:
        try: probe.setup()
        except FixtureReady: pass
        else: raise AssertionError('ISOLATED_SETUP_BOUNDARY_CHANGED')
        source_files = ['dist/storage/storage.js', 'dist/storage/limits.js', 'dist/http/routes/bucket/createBucket.js']
        values = json.loads(probe.node("const fs=require('fs'),c=require('crypto');console.log(JSON.stringify("+json.dumps(source_files)+".map(path=>({path,sha256:c.createHash('sha256').update(fs.readFileSync(path)).digest('hex')}))));"))
        assert probe.sql("SELECT count(*) FROM storage.buckets WHERE id='tenderdesk-private'") == '0'
        prior = probe.request('POST', '/bucket', json.dumps({'id': 'tenderdesk-private', 'name': 'tenderdesk-private', 'public': False, 'file_size_limit': 10485760}), {'content-type': 'application/json'})
        body = json.loads(prior['body'])
        assert prior['status'] == 400 and body.get('code') == 'EntityTooLarge', (prior['status'], sorted(body))
        assert probe.sql("SELECT count(*) FROM storage.buckets WHERE id='tenderdesk-private'") == '0'
        module = load_acceptance()
        class Client:
            def request(self, base, path, *, token=None, method='GET', data=None, raw=None, headers=None):
                assert base == 'http://127.0.0.1:5000' and token == 'synthetic-container-service'
                headers = dict(headers or {})
                if data is not None:
                    payload = json.dumps(data);headers['content-type'] = 'application/json'
                else:
                    payload = raw.decode() if raw is not None else ''
                response = probe.request(method, path, payload, headers)
                return module.Response(response['status'], response['body'].encode())
        actual = module.RestoreAcceptance(types.SimpleNamespace(storage_url='http://127.0.0.1:5000', service_key='synthetic-container-service'), Client())
        actual.create_private_fixture_bucket()
        payload = b'synthetic tiny restore artifact\n'
        actual.storage_put('synthetic/restored.docx', payload, actual.config.service_key)
        assert actual.storage_get('synthetic/restored.docx', actual.config.service_key) == payload
        public = probe.request('GET', '/object/public/tenderdesk-private/synthetic/restored.docx', headers={'authorization': ''})
        assert public['status'] in (400,401,403,404) and public['body'].encode() != payload
        try: actual.create_private_fixture_bucket()
        except module.ProbeFailure as error:
            assert error.code.startswith('RESTORE_PRIVATE_BUCKET_CREATE_FAILED_HTTP_')
            duplicate_status = error.http_status
        else: raise AssertionError('UNEXPECTED_EXISTING_BUCKET_ACCEPTED')
        paths = ['backend/scripts/ops/cloud-restore/acceptance.py','backend/scripts/ops/bootstrap/buildcontainers.py',
                 'backend/scripts/testing/cloud_restore_bucket_container.py','backend/scripts/testing/storage_retirement_container.py']
        receipt = {'version':1,'passed':True,'actual_pinned_storage_http_exercised':True,'synthetic_only':True,
          'production_calls':0,'customer_calls':0,'storage_image':storage.STORAGE,'storage_image_id':probe.receipt['storage_image_id'],
          'postgres_image':storage.POSTGRES,'global_file_size_limit_bytes':1048576,'fixture_bucket_file_size_limit_bytes':1048576,
          'original_failure':{'http_status':prior['status'],'code':body['code'],'requested_bucket_file_size_limit_bytes':10485760,'bucket_rows_after_failure':0},
          'checks':{'matching_limit_bucket_creation_and_exact_private_readback':True,'tiny_synthetic_upload_download_exact_bytes':True,
            'public_object_read_denied':True,'duplicate_bucket_rejected_without_update':True},
          'public_denial_status':public['status'],'duplicate_rejection_status':duplicate_status,'compiled_binary_files':values,
          'source_sha256':{p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in paths},
          'limitations':['Local pinned HTTP and isolated PostgreSQL only; hosted restore retry remains separate.',
            'Tiny synthetic fixture proves neither the product 10 MiB object limit nor full application DOCX rendering.',
            'Service token is synthetic and used only inside an isolated network namespace; no hosted credentials.']}
        (output/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
        print(json.dumps({'passed':True,'checks':len(receipt['checks']),'original_http_status':prior['status'],'original_code':body['code']}))
    finally:
        probe.cleanup()


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True)
    qualify(parser.parse_args().output)
