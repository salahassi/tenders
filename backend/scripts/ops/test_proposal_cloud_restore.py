"""Offline boundaries; live Auth/Storage restore is a separate runner gate."""
import base64
import copy
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import sys
import types
import unittest
from unittest.mock import Mock,patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('tested_cloud_restore',HERE/'proposal-cloud-restore.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class CloudRestoreTests(unittest.TestCase):
 def setUp(self):
  self.env=patch.dict(os.environ,{'GITHUB_RUN_ID':'40232030191','GITHUB_RUN_ATTEMPT':'2'});self.env.start();self.addCleanup(self.env.stop)
  self.state=m.bootstrap.identity();self.state.update(uid='namespace-uid',job_uid='parent-job-uid')
  self.original=m.bootstrap.sql_job;self.addCleanup(setattr,m.bootstrap,'sql_job',self.original)
  self.assets={name:(m.bootstrap.ASSETS/name).read_text() for name in ('setup.sql','post-migrations.sql','cleanup.sql','acceptance.py')}
 def test_acceptance_extends_real_http_client_without_legacy_fixture_flow(self):
  source,checks=m.acceptance_source(self.assets['acceptance.py'])
  self.assertEqual(len(checks),13);self.assertIn('self.auth()',source);self.assertIn('complete_restore_file',source)
  self.assertIn("Acceptance=RestoreAcceptance",source)
  self.assertIn("'actual_application_renderer_exercised':False",source)
  with self.assertRaises(m.RestoreError):m.acceptance_source('foreign script')
 def test_rpc_errors_expose_only_status_and_allowlisted_error_class(self):
  module=types.ModuleType('isolated_restore_acceptance_test');sys.modules[module.__name__]=module
  self.addCleanup(sys.modules.pop,module.__name__,None)
  exec(m.acceptance_source(self.assets['acceptance.py'])[0],module.__dict__)
  cfg=types.SimpleNamespace(rest_url='http://127.0.0.1:3000',service_key='synthetic-only')
  for body,expected in (({'code':'P0001','message':'SECRET SQL AND ROW','details':'SECRET'},'P0001'),
    ({'code':'42501','hint':'SECRET'},'42501'),({'code':'SECRET_CUSTOMER_VALUE'},'UNCLASSIFIED'),
    ({'code':['P0001']},'UNCLASSIFIED'),('PRIVATE NONJSON','UNCLASSIFIED')):
   raw=json.dumps(body).encode() if isinstance(body,dict) else body.encode()
   client=Mock();client.request.return_value=module.Response(400,raw)
   with self.assertRaises(module.ProbeFailure) as caught:
    module.RestoreAcceptance(cfg,client).rpc('cloud_restore_fixture_users')
   self.assertEqual(caught.exception.code,'RESTORE_RPC_CLOUD_RESTORE_FIXTURE_USERS_HTTP_400_'+expected)
   self.assertNotIn('SECRET',caught.exception.code)
  client.request.return_value=module.Response(200,b'{"source_workspace":"synthetic"}')
  self.assertEqual(module.RestoreAcceptance(cfg,client).rpc('cloud_restore_fixture_users'),{'source_workspace':'synthetic'})
 def test_synthetic_artifact_obeys_one_send_then_readback_then_completion(self):
  module=types.ModuleType('isolated_restore_write_test');sys.modules[module.__name__]=module
  self.addCleanup(sys.modules.pop,module.__name__,None)
  exec(m.acceptance_source(self.assets['acceptance.py'])[0],module.__dict__)
  probe=module.RestoreAcceptance(types.SimpleNamespace(service_key='synthetic-only'),Mock())
  trace=Mock();probe.rpc=trace.rpc;probe.storage_put=trace.put;probe.storage_get=trace.get
  probe.rpc.side_effect=[{'send':True,'state':'unknown'},{}];probe.storage_get.return_value=b'fixture'
  job={'id':'job','lease_token':'lease'};artifact={'id':'artifact','storage_key':'fixture-key'}
  probe.publish_fixture_artifact(job,artifact,b'fixture','a'*64)
  self.assertEqual([c[0] for c in trace.mock_calls],['rpc','put','get','rpc'])
  self.assertEqual(trace.mock_calls[0].args[0],'begin_render_storage_write')
  self.assertEqual(trace.mock_calls[0].args[1]['expected_size'],7)
  self.assertEqual(trace.mock_calls[-1].args[0],'complete_delivery_artifact')
  trace.reset_mock();probe.rpc.side_effect=None;probe.rpc.return_value={'send':False,'state':'unknown'}
  with self.assertRaises(module.ProbeFailure) as caught:probe.publish_fixture_artifact(job,artifact,b'fixture','a'*64)
  self.assertEqual(caught.exception.code,'RESTORE_FIXTURE_STORAGE_SEND_NOT_AUTHORIZED')
  self.assertEqual([c[0] for c in trace.mock_calls],['rpc'])
  trace.reset_mock();probe.rpc.return_value={'send':True,'state':'unknown'};probe.storage_get.return_value=b'changed'
  with self.assertRaises(module.ProbeFailure):probe.publish_fixture_artifact(job,artifact,b'fixture','a'*64)
  self.assertEqual([c[0] for c in trace.mock_calls],['rpc','put','get'])
 def test_private_schema_chunks_exact_bytes_hash_and_cleanup_parent(self):
  raw=('synthetic private DDL العربية\n'*10000).encode();created=[]
  parent=[{'uid':'parent-job-uid'}]
  with patch.object(m,'schema_source',return_value=(raw,[])),patch.object(m.bootstrap,'create',side_effect=created.append):
   assets=m.assets_factory({}, {}, self.original)(self.state,parent,self.assets)
  self.assertGreater(len(created),1)
  self.assertEqual(b''.join(base64.b64decode(x['data']['schema']) for x in created),raw)
  self.assertTrue(all(x['kind']=='Secret' and x['metadata']['namespace']==self.state['namespace'] and x['metadata']['ownerReferences']==parent for x in created))
  self.assertNotIn('synthetic private DDL',json.dumps(assets))
  job=m.bootstrap.sql_job(self.state,'post-migrations','post-migrations.sql',self.state['database'])
  pod=job['spec']['template']['spec'];container=pod['containers'][0]
  self.assertIn(m.hashlib.sha256(raw).hexdigest(),container['command'][-1])
  self.assertIn('sha256sum -c',container['command'][-1]);self.assertIn('&& exec psql',container['command'][-1])
  self.assertFalse(pod['automountServiceAccountToken']);self.assertTrue(container['securityContext']['readOnlyRootFilesystem'])
  self.assertIn({'name':'PGSSLMODE','value':'verify-full'},container['env'])
  self.assertEqual(m.bootstrap.sql_job(self.state,'database-cleanup','cleanup.sql','defaultdb'),self.original(self.state,'database-cleanup','cleanup.sql','defaultdb'))
  with self.assertRaises(m.RestoreError):m.bootstrap.sql_job(self.state,'post-migrations','post-migrations.sql','tenderdesk_app')
 def test_additive_source_hash_and_managed_role_family_is_rebound_only_in_isolated_copy(self):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);folder=root/'supabase/migrations';folder.mkdir(parents=True)
   data="do $$begin perform 'tdp_app_authenticated';perform 'authenticated';perform 'service_role';end$$;\n"
   file=folder/'20261104120000_synthetic.sql';file.write_text(data)
   manifest={'migrations':[{'name':file.name,'sha256':m.release.digest(data.encode())}]}
   with patch.object(m.release,'ROOT',root):
    result,receipts=m.isolated_migrations(manifest,self.state)
    self.assertNotIn('tdp_app_',result);self.assertIn("'authenticated'",result)
    self.assertIn('RESTORE_LEGACY_ROLE_COLLISION',result)
    self.assertIn(self.state['role_prefix']+'_authenticated',result)
    self.assertEqual(file.read_text(),data);self.assertEqual(receipts[0]['source_sha256'],manifest['migrations'][0]['sha256'])
    self.assertNotEqual(receipts[0]['source_sha256'],receipts[0]['isolated_role_mapping_sha256'])
    file.write_text(data+'-- changed')
    with self.assertRaises(m.RestoreError):m.isolated_migrations(manifest,self.state)
 def test_fixture_has_no_caller_supplied_reset_selectors_and_keeps_exact_trigger_state(self):
  value=m.fixture_source(self.state)
  self.assertIn('function public.cloud_restore_reset_source()',value)
  self.assertIn(self.state['database'],value);self.assertIn('shobj_description',value)
  self.assertIn('app_private.backup_tables() is distinct from allowed',value)
  self.assertIn('triggers_after is distinct from triggers_before',value)
  self.assertIn('CLOUD_RESTORE_NONFIXTURE_ROWS',value)
  self.assertNotIn('session_replication_role',value);self.assertNotIn('disable trigger all',value)
 def test_upstream_identity_rls_access_is_isolated_owner_select_only(self):
  value=m.upstream_access_source(self.state)
  self.assertIn(self.state['database'],value);self.assertIn('shobj_description',value)
  self.assertIn('RESTORE_AUTH_RLS_PREREQUISITE',value)
  self.assertNotIn('CREATE POLICY',value)
  policy=m.builder.auth_read.render(self.state['database'],self.state['role_prefix'],
    marker='tenderdesk-isolated-bootstrap:'+self.state['database']+':'+self.state['role_prefix'])
  self.assertIn('tenderdesk_application_identity_read',policy)
  self.assertNotIn('cloud_restore_application_identity_read',policy)
  self.assertNotIn('DISABLE ROW LEVEL SECURITY',value)
  self.assertNotIn('BYPASSRLS',value)
  self.assertNotIn('FOR ALL',value)
 def test_capture_failure_always_cleans_exact_observer_and_does_not_copy_rows(self):
  client=Mock();client.labels={}
  manifest={'baseline_catalog_sha256':'a'*64,'baseline_releases':{}}
  with patch.object(m.inventory.observer,'Client',return_value=client),patch.object(m.inventory,'save_client') as saved,patch.object(m.inventory,'clear_client') as cleared,patch.object(m.inventory.d,'sql',side_effect=RuntimeError('private SQL body')):
   with self.assertRaises(RuntimeError):m.capture(manifest)
   saved.assert_called_once_with(client);client.cleanup.assert_called_once();cleared.assert_called_once()
 def test_cleanup_runs_both_ownership_checks_when_first_fails(self):
  with patch.object(m.bootstrap,'cleanup_from_state',return_value=1),patch.object(m.inventory,'cleanup_saved_client') as observer:
   with self.assertRaises(m.RestoreError):m.cleanup()
   observer.assert_called_once()
 def test_main_suppresses_private_catalog_and_unknown_error_text(self):
  def failure():print('SECRET CUSTOMER SQL');raise ValueError('private password')
  output=io.StringIO()
  with patch.object(m,'run',side_effect=failure),redirect_stdout(output):self.assertEqual(m.main(),1)
  value=json.loads(output.getvalue());self.assertEqual(value,{'cloud_restore':'blocked','code':'RESTORE_DRILL_FAILED'})
 def test_auth_metadata_is_allowlisted_without_rows_policy_text_or_unproved_visibility(self):
  metadata={'application_owner':'tdp_app_owner','application_owner_superuser':False,'application_owner_bypassrls':False,
   'bootstrap_function_owner':'tdp_app_owner','tables':[{'table':table,'owner':'tdp_app_authadmin','rls_enabled':True,'force_rls':False,
    'app_owner_select':True,'app_owner_effective_owner':False,'applicable_policies':[]} for table in ('identities','users')]}
  self.assertEqual(m.validate_auth_authority(metadata),metadata)
  for key in ('rows','predicate','sql','visible_users'):
   bad=copy.deepcopy(metadata);bad['tables'][0][key]='PRIVATE'
   with self.assertRaises(m.RestoreError):m.validate_auth_authority(bad)
  conditional=copy.deepcopy(metadata);conditional['tables'][0]['applicable_policies']=[{'command':'r','permissive':True,'count':1,'unconditional_count':0}]
  self.assertEqual(m.validate_auth_authority(conditional),conditional)
  def failure():m.emit('source_auth_metadata',source_auth_read_authority=metadata);raise RuntimeError('PRIVATE')
  output=io.StringIO()
  with patch.object(m,'run',side_effect=failure),redirect_stdout(output):self.assertEqual(m.main(),1)
  self.assertEqual(json.loads(output.getvalue())['source_auth_read_authority'],metadata)
 def test_https_manifest_required_before_cloud_capture_or_fixture_creation(self):
  manifest=json.loads(m.release.MANIFEST.read_text());manifest.pop('https_configuration',None)
  with tempfile.TemporaryDirectory() as folder:
   path=Path(folder)/'manifest.json';path.write_text(json.dumps(manifest))
   with patch.object(m.release,'MANIFEST',path),patch.object(m.images,'verify_checkout'),patch.object(m,'capture') as capture,patch.object(m.bootstrap,'run') as create:
    with self.assertRaisesRegex(m.release.ReleaseError,'MANIFEST_INVALID'):m.run()
    capture.assert_not_called();create.assert_not_called()
 def test_runtime_qualification_manifest_required_before_cloud_capture(self):
  manifest=json.loads(m.release.MANIFEST.read_text());manifest['https_configuration']={};manifest.pop('runtime_qualification',None)
  with tempfile.TemporaryDirectory() as folder:
   path=Path(folder)/'manifest.json';path.write_text(json.dumps(manifest))
   with patch.object(m.release,'MANIFEST',path),patch.object(m.images,'verify_checkout'),patch.object(m,'capture') as capture,patch.object(m.bootstrap,'run') as create:
    with self.assertRaisesRegex(m.release.ReleaseError,'MANIFEST_INVALID'):m.run()
    capture.assert_not_called();create.assert_not_called()
 def test_workflow_restore_is_explicit_and_other_modes_keep_existing_scope(self):
  workflow=(HERE.parents[2]/'.github/workflows/doks-access.yml').read_text()
  self.assertIn('default: inventory',workflow);self.assertIn('options: [inventory, bootstrap, restore, models]',workflow)
  self.assertIn("always() && github.event_name == 'workflow_dispatch' && inputs.mode == 'restore'",workflow)
  self.assertIn("github.event_name == 'push' || inputs.mode == 'bootstrap'",workflow)
  self.assertIn('proposal-cloud-restore.py --cleanup',workflow)
  release=(HERE.parents[2]/'.github/workflows/deploy-proposal-delivery.yml').read_text()
  self.assertIn('-s backend/scripts/ops/production-schema',release)

if __name__=='__main__':unittest.main()
