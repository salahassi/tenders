"""Private client protocol guards; no Auth/Storage/cluster requests occur here."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parent
def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec);sys.modules[name]=value;spec.loader.exec_module(value)
    return value
base=module('retirement_writer_test_base',ROOT/'bootstrap/acceptance.py')
with patch.dict(sys.modules,{'acceptance':base}):
    writer=module('retirement_writer_test_client',ROOT/'cloud-retirement/writer.py')

class Transport:
    def __init__(self,status=200,body=b'null'):self.response=base.Response(status,body);self.calls=[]
    def request(self,*args,**kwargs):self.calls.append((args,kwargs));return self.response

class WriterGuards(unittest.TestCase):
    def setUp(self):
        self.config=base.Config('td_bootstrap_123_1_aabbccdd','tdb_123_aabbccdd',
          'http://127.0.0.1:9999','http://127.0.0.1:3000','http://gateway:8081/storage/v1','anon','service')
    def client(self,status=200,body=b'null'):
        transport=Transport(status,body)
        return writer.RetirementClient(self.config,transport),transport
    def test_versioned_canonical_rpc_is_allowed(self):
        client,transport=self.client()
        self.assertIsNone(client.rpc('claim_backend_job_v4'))
        self.assertEqual(transport.calls[0][0],(self.config.rest_url,'/rpc/claim_backend_job_v4'))
    def test_rpc_path_injection_is_rejected_before_request(self):
        client,transport=self.client()
        for operation in ('../rpc/private','x?value=1','x/y','public.function','1claim'):
            with self.subTest(operation=operation),self.assertRaises(base.ProbeFailure):client.rpc(operation)
        self.assertEqual(transport.calls,[])
    def test_only_canonical_void_failure_rpc_accepts_204(self):
        client,_=self.client(204,b'')
        self.assertIsNone(client.rpc('fail_delivery_export'))
        with self.assertRaises(base.ProbeFailure):client.rpc('begin_render_storage_write')
    def test_actual_pinned_database_error_class_is_required_for_denial(self):
        client,transport=self.client(500,b'{"code":"P0001","message":"synthetic fence"}')
        client.upload('workspace/retired-key',denied=True)
        self.assertEqual(transport.calls[0][1]['raw'],writer.DATA)
        for status,body in ((0,b''),(503,b''),(500,b'{"code":"DatabaseUnavailable"}'),(403,b'{"code":"P0001"}')):
            with self.subTest(status=status,body=body),self.assertRaises(base.ProbeFailure):
                self.client(status,body)[0].upload('workspace/retired-key',denied=True)
    def test_private_state_scope_permissions_and_no_symlinks(self):
        actor='00000000-0000-4000-8000-000000000001'
        workspace='00000000-0000-4000-8000-000000000002'
        fixture={'actor_id':actor,'workspace_id':workspace,'expected_hash':writer.CHECKSUM,'expected_size':16384,
          'selection':[{'id':'00000000-0000-4000-8000-000000000003','retirement_nonce':'00000000-0000-4000-8000-000000000004',
            'storage_key':workspace+'/delivery/file.docx','revision':2}]}
        state={'version':1,'database':self.config.database,'prefix':self.config.prefix,'actor_id':actor,
          'refresh_token':'synthetic-refresh-token-private-value','fixture':fixture}
        with tempfile.TemporaryDirectory() as temporary,patch.object(writer,'STATE',Path(temporary)/'state.json'):
            writer.save_private(state,initial=True)
            self.assertEqual(writer.load_private(self.config),state)
            state['database']='production_database';writer.save_private(state)
            with self.assertRaises(base.ProbeFailure):writer.load_private(self.config)
            state['database']=self.config.database;writer.save_private(state)
            writer.STATE.chmod(0o644)
            with self.assertRaises(base.ProbeFailure):writer.load_private(self.config)
            writer.STATE.chmod(0o600)
            target=writer.STATE.with_name('target.json');writer.STATE.rename(target);writer.STATE.symlink_to(target)
            with self.assertRaises(OSError):writer.load_private(self.config)

if __name__=='__main__':unittest.main()
