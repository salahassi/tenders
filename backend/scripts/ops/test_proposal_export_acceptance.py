import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock,patch
from contextlib import redirect_stdout
spec=importlib.util.spec_from_file_location('proposal_export_acceptance',Path(__file__).with_name('proposal-export-acceptance.py'))
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)

class ExportAcceptanceGuards(unittest.TestCase):
    def selection(self):
        return dict(version=1,workspace_id=m.access.WORKSPACE,opportunity_id='00000000-0000-4000-8000-000000000101',plan_id='00000000-0000-4000-8000-000000000102',proposal_version_id='00000000-0000-4000-8000-000000000103',expected_revision=1)
    def test_unactivated_never_accesses_cluster(self):
        with patch.dict(os.environ,{'RUN_ACTUAL_PROPOSAL_EXPORT_ACCEPTANCE':'false'}),patch.object(m.access,'prepare_cluster') as cluster,redirect_stdout(io.StringIO()):
            self.assertEqual(m.main([]),0);cluster.assert_not_called()
    def test_selection_is_exact_current_workspace_and_fixed_fields(self):
        self.assertEqual(m.validate_selection(self.selection()),self.selection())
        for changes in [dict(workspace_id='00000000-0000-4000-8000-000000000999'),dict(plan_id="';SELECT secret"),dict(expected_revision=True),dict(expected_revision=0),dict(mode='final')]:
            with self.assertRaises(m.AcceptanceError):m.validate_selection(self.selection()|changes)
    def test_child_environment_excludes_cluster_and_deployment_credentials(self):
        private={'DIGITALOCEAN_ACCESS_TOKEN','GH_TOKEN','GITHUB_TOKEN','KUBECONFIG','KUBECTL','DOKS_WORKDIR','DOCKER_CONFIG'}
        with patch.dict(os.environ,{**{k:'private-value' for k in private},'NODE_EXTRA_CA_CERTS':'/configured/ca.pem','PATH':'/runtime/bin'}):
            child=m.child_environment()
        self.assertTrue(private.isdisjoint(child))
        self.assertEqual(child['NODE_EXTRA_CA_CERTS'],'/configured/ca.pem')
        self.assertEqual(child['PATH'],'/runtime/bin')
    def test_selection_query_has_no_business_mutation(self):
        sql=m.selection_sql(self.selection())
        self.assertIn('BEGIN READ ONLY',sql);self.assertIn("g.status='completed'",sql)
        self.assertIn('p.active_version_id=v.id',sql);self.assertIn("a.status='active'",sql)
        self.assertNotIn('app_command',sql);self.assertNotIn('auth.users',sql)
    def test_genuine_session_uses_selected_real_user_without_invite_or_email(self):
        actor=self.selection()['opportunity_id'];config=m.smoke.Config('https://example.invalid','anon-secret','service-secret','jwt-secret')
        client=Mock()
        def response(body):return m.smoke.Response(200,json.dumps(body).encode())
        session={'access_token':'private-access','refresh_token':'private-refresh','user':{'id':actor}}
        client.request.side_effect=[response({'id':actor,'role':'tdp_app_authenticated','email':'selected@example.invalid','email_confirmed_at':'2026-01-01'}),response({'hashed_token':'private-hash'}),response(session)]
        self.assertEqual(m.genuine_session(client,config,actor,m.access.WORKSPACE),session)
        paths=[c.args[0] for c in client.request.call_args_list]
        self.assertEqual(paths,['/auth/v1/admin/users/'+actor,'/auth/v1/admin/generate_link','/auth/v1/verify'])
        self.assertEqual(client.request.call_args_list[1].kwargs['data']['type'],'magiclink')
        self.assertEqual(client.request.call_args_list[2].kwargs['token'],'anon-secret')
    def test_public_receipt_omits_private_report_content(self):
        report={'passed':True,'artifacts':[{'docx_base64':'private-document','id':'private-id'}],'readiness':{'blockers':['private-question']},'mode':'browser'}
        receipt=m.public_receipt(report,'a'*64)
        self.assertNotIn('private',json.dumps(receipt));self.assertEqual(receipt['model_calls'],0)
        self.assertFalse(receipt['final_approval_changed'])
    def test_real_session_cleanup_on_child_failure_without_echoing_private_errors(self):
        actor=self.selection()['opportunity_id']
        config={'ANON_KEY':'private-anon','SERVICE_KEY':'private-service','JWT_SECRET':'private-jwt'}
        public={'apiUrl':'https://example.invalid','appOrigin':'https://example.invalid','publishableKey':config['ANON_KEY']}
        session={'access_token':'private-access-token','refresh_token':'private-refresh-token','user':{'id':actor}}
        with tempfile.TemporaryDirectory() as parent:
            directory=Path(parent)/'private';directory.mkdir()
            client=Mock();client.request.return_value=m.smoke.Response(204,b'')
            with patch.dict(os.environ,{'RUN_ACTUAL_PROPOSAL_EXPORT_ACCEPTANCE':'true','DIGITALOCEAN_ACCESS_TOKEN':'private-do','GITHUB_RUN_ID':'123'}), patch.object(m.access,'prepare_cluster',return_value=directory), patch.object(m.resume,'verify_runtime'), patch.object(m.transfer,'identity'), patch.object(m.transfer,'download'), patch.object(m.transfer,'read_private',return_value=json.dumps(self.selection()).encode()), patch.object(m.observer,'Client'), patch.object(m.access.d,'sql',return_value=json.dumps({'actor_id':actor,'proposal_id':actor})), patch.object(m.access.d,'decode_secret',return_value=config), patch.object(m.access.d,'get',return_value={'data':{'runtime-config.js':'window.__TENDERDESK_CONFIG__='+json.dumps(public)+';'}}), patch.object(m.smoke,'Client',return_value=client), patch.object(m,'genuine_session',return_value=session), patch.object(m,'verify_session'), patch.object(m.subprocess,'run',side_effect=RuntimeError('private-customer-details')), redirect_stdout(io.StringIO()) as output:
                self.assertEqual(m.main(['--selection-object','requests/fixture.bundle','--selection-sha256','a'*64,'--expected-runtime-image','fixture']),1)
            self.assertEqual(client.request.call_count,1)
            self.assertEqual(client.request.call_args.args[0],'/auth/v1/logout?scope=local')
            self.assertEqual(client.request.call_args.kwargs['token'],session['access_token'])
            self.assertFalse(directory.exists())
            self.assertNotIn('private-',output.getvalue())
    def test_workflow_never_activates_export_on_push(self):
        workflow=(m.HERE.parents[2]/'.github/workflows/accept-actual-proposal-export.yml').read_text()
        self.assertIn('branches: [codex/ai-reliability-resume]',workflow)
        self.assertIn("github.event_name == 'workflow_dispatch' && inputs.run_acceptance",workflow)
        self.assertIn('default: false',workflow)
        self.assertNotIn('upload-artifact',workflow)

if __name__=='__main__':unittest.main()
