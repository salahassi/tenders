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
    def session_value(self,refresh='abcdefgh2345',actor='00000000-0000-4000-8000-000000000001'):
        return {'user':{'id':actor,'role':self.config.prefix+'_authenticated'},
          'access_token':'synthetic-access-token','refresh_token':refresh}
    def test_pinned_gotrue_twelve_character_token_keeps_session_identity_checks(self):
        client,transport=self.client();value=self.session_value()
        actor,token=client.session(value)
        self.assertEqual((actor,token),(value['user']['id'],value['access_token']))
        self.assertEqual(client.refresh_tokens,{actor:value['refresh_token']})
        for user in ({'id':'invalid','role':self.config.prefix+'_authenticated'},
          {'id':actor,'role':'wrong_authenticated_role'}):
            with self.subTest(user=user),self.assertRaises(base.ProbeFailure):client.session({**value,'user':user})
        self.assertEqual(transport.calls,[])
    def test_refresh_value_is_nonempty_bounded_string_without_token_logging(self):
        client,_=self.client()
        for refresh in (None,'',0,[],{},'x'*4097):
            with self.subTest(kind=type(refresh).__name__),self.assertRaises(base.ProbeFailure) as failure:
                client.session(self.session_value(refresh))
            self.assertEqual(failure.exception.code,'RETIREMENT_FIXTURE_REFRESH_MISSING')
        self.assertEqual(client.refresh_tokens,{})
    def test_refresh_rotation_requires_success_and_the_same_actor_before_state_write(self):
        actor=self.session_value()['user']['id']
        state={'actor_id':actor,'refresh_token':'abcdefgh2345'}
        value=self.session_value('ijklmnop2345')
        client,transport=self.client(body=json.dumps(value).encode())
        with patch.object(writer,'load_private',return_value=state),patch.object(writer,'save_private') as saved:
            loaded,token=client.loaded()
            self.assertIs(loaded,state);self.assertEqual(token,value['access_token'])
            self.assertEqual(state['refresh_token'],value['refresh_token']);saved.assert_called_once_with(state)
        self.assertEqual(transport.calls[0][0],(self.config.auth_url,'/token?grant_type=refresh_token'))
        self.assertEqual(transport.calls[0][1]['data'],{'refresh_token':'abcdefgh2345'})
        for status,response,code in ((400,{},'RETIREMENT_FIXTURE_SESSION_REFRESH_FAILED'),
          (200,self.session_value(actor='00000000-0000-4000-8000-000000000002'),'RETIREMENT_FIXTURE_OWNER_CHANGED')):
            client,_=self.client(status,json.dumps(response).encode())
            with patch.object(writer,'load_private',return_value=dict(state)),patch.object(writer,'save_private') as saved:
                with self.assertRaises(base.ProbeFailure) as failure:client.loaded()
                self.assertEqual(failure.exception.code,code);saved.assert_not_called()
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
          'refresh_token':'abcdefgh2345','fixture':fixture}
        with tempfile.TemporaryDirectory() as temporary,patch.object(writer,'STATE',Path(temporary)/'state.json'):
            writer.save_private(state,initial=True)
            self.assertEqual(writer.load_private(self.config),state)
            for refresh in ('',None,'x'*4097):
                writer.save_private({**state,'refresh_token':refresh})
                with self.assertRaises(base.ProbeFailure):writer.load_private(self.config)
            state['database']='production_database';writer.save_private(state)
            with self.assertRaises(base.ProbeFailure):writer.load_private(self.config)
            state['database']=self.config.database;writer.save_private(state)
            writer.STATE.chmod(0o644)
            with self.assertRaises(base.ProbeFailure):writer.load_private(self.config)
            writer.STATE.chmod(0o600)
            target=writer.STATE.with_name('target.json');writer.STATE.rename(target);writer.STATE.symlink_to(target)
            with self.assertRaises(OSError):writer.load_private(self.config)

if __name__=='__main__':unittest.main()
