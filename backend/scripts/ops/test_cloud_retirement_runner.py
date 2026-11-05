"""Offline runner boundary tests; no claim of real Kubernetes/PVC execution."""
import base64
import copy
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE/'cloud-retirement'))
spec=importlib.util.spec_from_file_location('tested_retirement_runner',HERE/'cloud-retirement/runner.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
c=m.c;r=m.r
UID='00000000-0000-4000-8000-000000000001'
OTHER='00000000-0000-4000-8000-000000000002'

class RunnerBoundaries(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
  self.env=patch.dict(os.environ,{'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'12345678','GITHUB_RUN_ATTEMPT':'2','RUNNER_TEMP':self.temp.name},clear=True)
  self.env.start();self.addCleanup(self.env.stop)
  self.base=m.b.identity();self.base['uid']=UID
  self.state=c.initial_state(self.base,'b'*64)
 def resource(self,name,uid=UID):
  return {'metadata':{'name':name,'namespace':c.namespace(self.state),'uid':uid,'resourceVersion':'43','labels':c.labels(self.state)}}
 def test_origin_attempt_is_explicit_bounded_and_does_not_change_execution_attempt(self):
  with patch.object(m,'prepare_access'),patch.object(m,'already_cleaned',return_value=True),redirect_stdout(io.StringIO()) as out:
   self.assertEqual(m.main(['cleanup','--nonce','1234abcd','--origin-attempt','1']),0)
  self.assertEqual(os.environ['GITHUB_RUN_ATTEMPT'],'2')
  self.assertEqual(os.environ['RETIREMENT_FIXTURE_ORIGIN_ATTEMPT'],'1')
  self.assertEqual(json.loads(out.getvalue())['cleanup_verified'],True)
 def test_future_malformed_or_prepare_origin_never_reaches_cluster(self):
  for args in (['cleanup','--nonce','1234abcd','--origin-attempt','3'],
    ['cleanup','--nonce','1234abcd','--origin-attempt','0'],
    ['cleanup','--nonce','1234abcd','--origin-attempt','../1'],
    ['prepare','--origin-attempt','1']):
   with self.subTest(args=args),patch.object(m,'prepare_access') as cluster,patch.object(c.restore.inventory,'cleanup_saved_client'),redirect_stdout(io.StringIO()):
    self.assertEqual(m.main(args),1);cluster.assert_not_called()
 def test_first_job_publishes_only_nonce_and_actual_origin_before_allocation(self):
  path=Path(self.temp.name)/'outputs';os.environ['GITHUB_OUTPUT']=str(path)
  nonce=m.output_nonce(self.base)
  self.assertEqual(path.read_text(),'nonce='+nonce+'\norigin_attempt=2\n')
  self.assertNotIn(c.namespace(self.state),path.read_text())
 def test_namespace_delete_is_preconditioned_by_original_uid_and_version(self):
  actual=self.resource(c.namespace(self.state));actual['metadata'].pop('namespace')
  with patch.object(m.b,'assert_namespace'),patch.object(r,'command',side_effect=[json.dumps(actual),'{}','']) as command:
   m.delete_namespace(self.base)
  delete=command.call_args_list[1]
  self.assertEqual(delete.args[0],['delete','--raw','/api/v1/namespaces/'+c.namespace(self.state),'--filename=-'])
  self.assertEqual(json.loads(delete.kwargs['payload'])['preconditions'],{'uid':UID,'resourceVersion':'43'})
 def test_namespace_replacement_between_read_and_delete_is_not_adopted(self):
  actual=self.resource(c.namespace(self.state),OTHER)
  with patch.object(m.b,'assert_namespace'),patch.object(r,'command',return_value=json.dumps(actual)) as command:
   with self.assertRaisesRegex(c.FixtureError,'NAMESPACE_IDENTITY_CHANGED'):m.delete_namespace(self.base)
  self.assertEqual(command.call_count,1)
 def test_fresh_runner_cannot_adopt_an_unjournaled_namespace_by_nonce(self):
  directory=m.private_directory();directory.mkdir(mode=0o700);os.environ['DOKS_WORKDIR']=str(directory)
  with patch.object(r,'command') as command:
   self.assertFalse(m.cleanup_unjournaled_namespace('1234abcd'))
  command.assert_not_called()
 def test_prejournal_local_cleanup_refuses_a_database_setup_or_started_job(self):
  directory=m.private_directory();directory.mkdir(mode=0o700);os.environ['DOKS_WORKDIR']=str(directory)
  for change in ({'setup_started':True},{'job_uid':OTHER}):
   base={**self.base,**change};m.b.save(base)
   with self.subTest(change=change),patch.object(r,'command') as command:
    self.assertFalse(m.cleanup_unjournaled_namespace(base['labels']['tenderdesk.io/run'].rsplit('-',1)[1]))
   command.assert_not_called()
 def test_protected_original_process_blocks_all_resource_deletes(self):
  pod={'metadata':{'finalizers':[c.proof.FINALIZER]}}
  with patch.object(r,'namespace_guard'),patch.object(r,'save'),patch.object(r,'items',return_value=[pod]),patch.object(r,'delete') as delete:
   with self.assertRaisesRegex(c.FixtureError,'PROTECTED_PROCESS'):m.cleanup(self.state)
  delete.assert_not_called()
 def test_unproven_adapter_recovery_blocks_cleanup_before_phase_mutation(self):
  import fixture_adapter
  self.state['process_capture']={'private':'capture'}
  with patch.object(r,'namespace_guard'),patch.object(fixture_adapter,'FixtureAdapter') as adapter,patch.object(r,'save') as save,patch.object(r,'delete') as delete:
   adapter.return_value.cleanup_preconditions.side_effect=c.FixtureError('RETIREMENT_FIXTURE_PROCESS_RECONCILIATION_REQUIRED')
   with self.assertRaises(c.FixtureError):m.cleanup(self.state)
  save.assert_not_called();delete.assert_not_called()
 def test_sql_job_receipt_survives_ttl_and_binds_owned_job_uid(self):
  job=m.b.sql_job(self.base,'database-cleanup','cleanup.sql','defaultdb')
  with patch.object(r,'create') as create,patch.object(m,'wait_sql_job') as wait:
   m.create_sql_job(self.state,job)
  self.assertNotIn('ttlSecondsAfterFinished',job['spec'])
  self.assertEqual(create.call_args.args[:2],(self.state,'job'))
  self.assertEqual(job['metadata']['labels'],c.labels(self.state))
  wait.assert_called_once_with(self.state,'database-cleanup')
 def test_sql_failure_is_not_accepted_as_a_cleanup_receipt(self):
  with patch.object(r,'get',return_value={'status':{'failed':1}}):
   with self.assertRaisesRegex(c.FixtureError,'SQL_JOB_FAILED'):m.wait_sql_job(self.state,'database-cleanup')
 def test_catalog_source_keeps_exact_migrations_but_replaces_only_broad_fixture_suffix(self):
  broad='-- original broad restore helpers\n';prefix=b'-- exact reviewed reconstructed schema\n'
  created=[]
  with (patch.object(c.restore,'schema_source',return_value=(prefix+broad.encode(),[])) as reconstruct,
    patch.object(c.restore,'fixture_source',return_value=broad),patch.object(r,'create',side_effect=lambda state,kind,value:created.append(value))):
   job=m.schema_job(self.state,{'source_stage':'released'},{'migrations':'reviewed'})
  reconstruct.assert_called_once_with({'source_stage':'released'},self.base,{'migrations':'reviewed'})
  raw=b''.join(base64.b64decode(value['data']['schema']) for value in created)
  self.assertEqual(raw,prefix+m.fixture_source(self.base).encode())
  self.assertNotIn(broad.encode(),raw)
  self.assertNotIn(b'cloud_restore_reset_source',raw)
  command=job['spec']['template']['spec']['containers'][0]['command'][-1]
  self.assertIn(c.sha(raw),command);self.assertIn('sha256sum -c -',command)
  self.assertTrue(all(value['kind']=='Secret' and value['metadata']['namespace']==c.namespace(self.state) for value in created))
 def test_changed_schema_suffix_prevents_any_asset_or_sql_allocation(self):
  with patch.object(c.restore,'schema_source',return_value=(b'changed schema',[])),patch.object(c.restore,'fixture_source',return_value='expected suffix'),patch.object(r,'create') as create:
   with self.assertRaisesRegex(c.FixtureError,'SCHEMA_SOURCE_CHANGED'):m.schema_job(self.state,{}, {})
  create.assert_not_called()
 def test_manifest_is_current_and_verified_without_frozen_hash_assumption(self):
  path=Path(self.temp.name)/'manifest.json'
  for revision in ('first','second'):
   manifest={'migrations':[{'name':str(i)} for i in range(24)],'storage_retirement_version':1,'reviewed_change':revision}
   path.write_text(json.dumps(manifest))
   with patch.object(c.restore.release,'MANIFEST',path),patch.object(c.restore.release,'verify_source') as verify:
    self.assertEqual(c.manifest_contract(),c.restore.release.digest(c.restore.release.canonical(manifest).encode()))
   verify.assert_called_once_with(manifest)
  manifest['migrations'].pop();path.write_text(json.dumps(manifest))
  with patch.object(c.restore.release,'MANIFEST',path),patch.object(c.restore.release,'verify_source'):
   with self.assertRaisesRegex(c.FixtureError,'SCHEMA_UNQUALIFIED'):c.manifest_contract()
 def test_network_egress_uses_exact_private_database_addresses(self):
  with patch.object(m.socket,'getaddrinfo',return_value=[(2,1,6,'',('10.20.0.10',25060))]):
   policies=m.network_policies(self.state,{'PGHOST':'private.invalid','PGPORT':'25060'})
  self.assertEqual(policies[0]['spec']['egress'][2],{'to':[{'ipBlock':{'cidr':'10.20.0.10/32'}}],'ports':[{'protocol':'TCP','port':25060}]})
  self.assertEqual(policies[1]['spec']['ingress'][0]['from'],[{'podSelector':{'matchLabels':{'tenderdesk.io/fixture-workload':'gateway'}}}])
  for address in ('8.8.8.8','127.0.0.1'):
   with patch.object(m.socket,'getaddrinfo',return_value=[(2,1,6,'',(address,25060))]):
    with self.assertRaisesRegex(c.FixtureError,'PRIVATE_DATABASE_REQUIRED'):m.network_policies(self.state,{'PGHOST':'private.invalid','PGPORT':'25060'})
 def test_pvc_cleanup_rejects_foreign_claim_and_retained_volume(self):
  pvc=self.resource(c.PVC_NAME);pvc['spec']={'volumeName':'pvc-fixture'}
  valid={'metadata':{'uid':OTHER},'spec':{'claimRef':{'uid':UID,'namespace':c.namespace(self.state),'name':c.PVC_NAME},
    'persistentVolumeReclaimPolicy':'Delete','csi':{'driver':'dobs.csi.digitalocean.com'}}}
  for change in ('claim','policy'):
   value=copy.deepcopy(valid)
   if change=='claim':value['spec']['claimRef']['namespace']='tenderdesk-dev'
   else:value['spec']['persistentVolumeReclaimPolicy']='Retain'
   with self.subTest(change=change),patch.object(r,'get',return_value=pvc),patch.object(r,'command',return_value=json.dumps(value)),patch.object(r,'create') as create:
    with self.assertRaisesRegex(c.FixtureError,'VOLUME_IDENTITY_CHANGED'):m.cleanup_journal(self.state)
   create.assert_not_called()
 def test_workflow_separates_real_runners_and_never_treats_any_error_as_interruption(self):
  workflow=(HERE.parents[2]/'.github/workflows/qualify-storage-retirement.yml').read_text()
  self.assertEqual(workflow.count('runs-on: ubuntu-latest'),2)
  self.assertIn('group: tenderdesk-digitalocean-production',workflow)
  self.assertIn('cancel-in-progress: false',workflow)
  self.assertIn('if [ "$result" -ne 86 ]',workflow)
  self.assertIn("needs.interrupt.outputs.interrupted == 'true'",workflow)
  self.assertIn('FIXTURE_ORIGIN_ATTEMPT: ${{ needs.interrupt.outputs.origin_attempt }}',workflow)
  self.assertNotIn('inputs:',workflow)
  self.assertNotIn('upload-artifact',workflow)

if __name__=='__main__':unittest.main()
