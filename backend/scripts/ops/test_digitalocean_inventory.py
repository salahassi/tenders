import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import unittest
import tempfile
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('inventory_tested',HERE/'digitalocean-inventory.py')
p=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=p;SPEC.loader.exec_module(p)


def schema():
 return {'version':1,'database_identity_verified':True,'releases':[{'release':'analysis-verifier-recheck-v1','migration_sha256':'a'*64,'applied_at':'2026-11-03T03:00:00+00:00'}],
  'canonical_migrations':None,'routine_catalog_sha256':'b'*64,'metrics':{'window_hours':24,'jobs':None,'delivery':None,'capacity':None},'capabilities':{key:False for key in p.CAPABILITIES}}


def workloads():
 values=[];pods=[]
 for name in p.NAMES:
  reference='registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:'+'c'*64
  labels={'app':name}
  values.append({'metadata':{'name':name,'namespace':p.d.NAMESPACE,'generation':2,'labels':{'app.kubernetes.io/managed-by':'tenderdesk-deployment'},'annotations':{'deployment.kubernetes.io/revision':'2','private':'customer-secret'}},
   'spec':{'replicas':1,'selector':{'matchLabels':labels},'template':{'spec':{'containers':[{'name':name,'image':reference,'env':[{'name':'SECRET','value':'credential-secret'}]}]}}},
   'status':{'observedGeneration':2,'readyReplicas':1,'updatedReplicas':1,'unavailableReplicas':0}})
  pods.append({'metadata':{'namespace':p.d.NAMESPACE,'labels':labels},'status':{'containerStatuses':[{'name':name,'imageID':'docker-pullable://'+reference}]}})
 return values,pods


def schedules():
 return [{'metadata':{'name':'native-'+name,'namespace':p.d.NAMESPACE,'generation':1,'labels':{'app.kubernetes.io/managed-by':'tenderdesk-deployment'}},
  'spec':{'schedule':'*/10 * * * *','concurrencyPolicy':'Forbid','suspend':False,'jobTemplate':{'spec':{'activeDeadlineSeconds':600,'backoffLimit':0,
  'template':{'spec':{'containers':[{'name':name,'image':'registry.digitalocean.com/tenderdesk-a6093a76/'+name+'@sha256:'+'e'*64,
  'env':[{'name':'PRIVATE','value':'private-credential'}], 'resources':{'requests':{'cpu':'100m','memory':'256Mi'},'limits':{'cpu':'1000m','memory':'768Mi'}}}]}}}}}} for name in ('browser','ocr')]

def responses(values,pods,after=None):
 return [json.dumps({'items':values}),json.dumps({'items':pods}),json.dumps({'items':schedules()}),json.dumps({'items':after or values}),json.dumps({'items':schedules()})]

class InventoryTests(unittest.TestCase):
 def test_only_allowlisted_fields_leave_private_resource_and_schema_buffers(self):
  output=json.dumps(p.public_workloads(*workloads()))
  self.assertNotIn('customer-secret',output);self.assertNotIn('credential-secret',output);self.assertNotIn('env',output)
  self.assertEqual(len(json.loads(output)),10)
  self.assertTrue(all(x['image_source_revision'] is None for x in json.loads(output)))
  self.assertEqual(p.public_schema(schema())['canonical_migrations'],None)

 def test_metric_labels_and_counts_cannot_carry_private_text(self):
  value={'window_hours':24,'jobs':[{'class':'local','pending':2,'due':1,'running':0,'blocked':0,'expired_leases':0,'oldest_due_age_seconds':5.5,'succeeded_in_window':0,'terminal_row_elapsed_p95_seconds':None}],'delivery':None,'capacity':None}
  self.assertEqual(p.public_metrics(value),value)
  for change in (lambda v:v['jobs'][0].update({'class':'customer-private'}),lambda v:v['jobs'][0].update(pending='secret'),lambda v:v['jobs'][0].update(oldest_due_age_seconds=float('nan')),lambda v:v.update(extra='secret')):
   bad=copy.deepcopy(value);change(bad)
   with self.assertRaises(p.InventoryError):p.public_metrics(bad)

 def test_native_schedule_projection_is_bounded_and_has_no_credentials(self):
  result=p.public_schedules(schedules());self.assertEqual(len(result),2)
  self.assertNotIn('private-credential',json.dumps(result));self.assertNotIn('env',json.dumps(result))
  self.assertEqual(result[1]['active_deadline_seconds'],600)
  for change in (lambda x:x[0]['spec'].update(schedule='private-text'),lambda x:x[0]['spec'].update(concurrencyPolicy='private-invalid'),lambda x:x.pop(),lambda x:x[0]['metadata']['labels'].clear()):
   values=schedules();change(values)
   with self.assertRaises(p.InventoryError):p.public_schedules(values)

 def test_inventory_reports_actual_schedule_and_optional_defaults_without_deployment_assumptions(self):
  values=schedules();spec=values[0]['spec'];spec.update(schedule='*/5 0-23 * * 1,2,3,4,5',concurrencyPolicy='Replace');spec.pop('suspend')
  job=spec['jobTemplate']['spec'];job.pop('backoffLimit');job.pop('activeDeadlineSeconds')
  job['template']['spec']['containers'][0]['resources']={'limits':{'cpu':'0.5','memory':'1Gi'}}
  result=p.public_schedules(values)[0]
  self.assertEqual(result['schedule'],'*/5 0-23 * * 1,2,3,4,5');self.assertEqual(result['concurrency_policy'],'Replace')
  self.assertIsNone(result['active_deadline_seconds']);self.assertIsNone(result['backoff_limit']);self.assertEqual(result['effective_backoff_limit'],6)
  self.assertFalse(result['suspend_explicit']);self.assertFalse(result['suspended']);self.assertIsNone(result['resources']['requests'])
  self.assertIsNone(result['resources']['limits']['ephemeral-storage'])

 def test_unknown_release_name_is_not_public_and_no_tip_is_invented(self):
  value=schema();value['releases'][0]['release']='customer-document-content'
  visible=p.public_schema(value)
  self.assertEqual(visible['release_history'][0]['release'],'UNRECOGNIZED_RELEASE')
  self.assertNotIn('customer-document',json.dumps(visible))

 def test_malformed_schema_receipt_or_diagnostics_cannot_be_echoed(self):
  for change in [lambda v:v.update(extra='private'),lambda v:v['releases'][0].update(migration_sha256='token-secret'),lambda v:v['releases'][0].update(applied_at='private'),lambda v:v['capabilities'].update(delivery_package='private'),lambda v:v.update(canonical_migrations={'count':1,'latest_version':'source-body'})]:
   value=schema();change(value)
   with self.subTest(value=value),self.assertRaises(p.InventoryError):p.public_schema(value)

 def test_rejects_foreign_ownership_unpinned_images_and_missing_workloads(self):
  for change in [lambda v:v[0]['metadata']['labels'].update({'app.kubernetes.io/managed-by':'foreign'}),lambda v:v[0]['spec']['template']['spec']['containers'][0].update(image='registry.invalid/customer-private:latest'),lambda v:v.pop()]:
   values,pods=workloads();change(values)
   with self.subTest(change=change),self.assertRaises(p.InventoryError):p.public_workloads(values,pods)

 def test_pod_image_body_and_revision_are_not_arbitrary_output_channels(self):
  for field,value in [('imageID','customer-private-text'),('imageID','sha256:not-a-hash')]:
   values,pods=workloads();pods[0]['status']['containerStatuses'][0][field]=value
   with self.assertRaises(p.InventoryError):p.public_workloads(values,pods)
  values,pods=workloads();values[0]['metadata']['annotations']['deployment.kubernetes.io/revision']='secret'
  with self.assertRaises(p.InventoryError):p.public_workloads(values,pods)

 def test_ready_counts_require_observed_generation_and_do_not_infer_source_commit(self):
  values,pods=workloads();values[0]['status']['observedGeneration']=1
  result=p.public_workloads(values,pods)[0]
  self.assertLess(result['observed_generation'],result['generation'])
  self.assertEqual(result['image_source_revision_status'],'not_independently_inspected')

 def test_sql_is_read_only_catalog_inventory_without_model_or_business_commands(self):
  sql=(HERE/'digitalocean-inventory.sql').read_text()
  self.assertIn('REPEATABLE READ READ ONLY',sql);self.assertIn("current_database()<>'tenderdesk_app'",sql)
  self.assertIn("SET LOCAL statement_timeout='20s'",sql);self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
  for forbidden in ('INSERT INTO','UPDATE public.','DELETE FROM','CREATE TABLE','app_command(', 'claim_backend_job_v3();'):
   self.assertNotIn(forbidden,sql)

 def test_cleanup_attempted_after_sql_failure_and_cleanup_failure_blocks_success(self):
  values,pods=workloads()
  for fail in ('query','cleanup'):
   with self.subTest(fail=fail),patch.dict(os.environ,{'GITHUB_SHA':'d'*40}),patch.object(p.d,'command',side_effect=responses(values,pods)),patch.object(p.observer,'Client') as client,patch.object(p,'save_client'),patch.object(p,'clear_client'),patch.object(p.d,'sql',side_effect=RuntimeError('private') if fail=='query' else None,return_value=json.dumps(schema())):
    if fail=='cleanup':client.return_value.cleanup.side_effect=RuntimeError('private cleanup credential')
    with self.assertRaises(Exception):p.inventory()
    client.return_value.prepare.assert_called_once();client.return_value.cleanup.assert_called_once()

 def test_complete_inventory_does_not_claim_bootstrap_or_mutations(self):
  values,pods=workloads()
  with patch.dict(os.environ,{'GITHUB_SHA':'d'*40}),patch.object(p.d,'command',side_effect=responses(values,pods)),patch.object(p.observer,'Client') as client,patch.object(p,'save_client'),patch.object(p,'clear_client'),patch.object(p.d,'sql',return_value=json.dumps(schema())):
   client.return_value.labels={}
   result=p.inventory()
   self.assertEqual(result['ready_workloads'],10)
   self.assertEqual(result['business_mutations'],0);self.assertFalse(result['bootstrap_run']);self.assertTrue(result['temporary_client_cleanup_verified'])
   self.assertEqual(client.return_value.labels['app.kubernetes.io/managed-by'],p.OWNER)

 def test_image_change_during_database_read_does_not_produce_mixed_inventory_receipt(self):
  values,pods=workloads();after=copy.deepcopy(values);after[0]['metadata']['generation']=3
  with patch.dict(os.environ,{'GITHUB_SHA':'d'*40}),patch.object(p.d,'command',side_effect=responses(values,pods,after)),patch.object(p.observer,'Client'),patch.object(p,'save_client'),patch.object(p,'clear_client'),patch.object(p.d,'sql',return_value=json.dumps(schema())):
   with self.assertRaisesRegex(p.InventoryError,'INVENTORY_WORKLOAD_CHANGED_DURING_READ'):p.inventory()

 def test_main_suppresses_raw_transport_database_and_cleanup_exception_bodies(self):
  out=io.StringIO();err=io.StringIO()
  with patch.object(p.d.probe,'validate_cluster'),patch.object(p,'inventory',side_effect=RuntimeError('CUSTOMER_CREDENTIAL')) ,contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
   self.assertEqual(p.main(),1)
  self.assertNotIn('CUSTOMER_CREDENTIAL',out.getvalue()+err.getvalue());self.assertEqual(json.loads(out.getvalue())['code'],'INVENTORY_FAILED')

 def test_workflow_inventory_mode_cannot_run_bootstrap_or_preflight_cleanup(self):
  workflow=(HERE.parents[2]/'.github/workflows/doks-access.yml').read_text()
  self.assertIn('default: inventory',workflow)
  self.assertEqual(workflow.count("if: ${{ github.event_name == 'push' || inputs.mode == 'bootstrap' }}"),3)
  self.assertEqual(workflow.count("if: ${{ always() && (github.event_name == 'push' || inputs.mode == 'bootstrap') }}"),2)
  self.assertEqual(workflow.count("if: ${{ github.event_name == 'workflow_dispatch' && inputs.mode == 'inventory' }}"),2)
  self.assertNotIn('upload-artifact',workflow)
  self.assertNotIn('sparse-checkout:',workflow)
  self.assertIn('digitalocean-inventory.py --cleanup',workflow)

 def test_final_cleanup_reuses_only_exact_current_run_nonce_owned_resources(self):
  with tempfile.TemporaryDirectory() as temporary,patch.dict(os.environ,{'RUNNER_TEMP':temporary,'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','DOKS_WORKDIR':temporary+'/doks-access-123-1'}):
   directory=Path(os.environ['DOKS_WORKDIR']);directory.mkdir(mode=0o700)
   client=p.observer.Client(60);client.labels['app.kubernetes.io/managed-by']=p.OWNER
   p.save_client(client)
   with patch.object(p.observer.Client,'cleanup') as cleanup:p.cleanup_saved_client();cleanup.assert_called_once()
   self.assertFalse(p.journal_path().exists())
   p.save_client(client)
   value=json.loads(p.journal_path().read_text());value['pod']='foreign-pod';p.journal_path().write_text(json.dumps(value))
   with patch.object(p.observer.Client,'cleanup') as cleanup,self.assertRaises(p.InventoryError):p.cleanup_saved_client()
   cleanup.assert_not_called()

 def test_cleanup_refuses_other_runs_or_world_readable_journals(self):
  with tempfile.TemporaryDirectory() as temporary,patch.dict(os.environ,{'RUNNER_TEMP':temporary,'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','DOKS_WORKDIR':temporary+'/foreign'}):
   with self.assertRaises(p.InventoryError):p.journal_path()
   os.environ['DOKS_WORKDIR']=temporary+'/doks-access-123-1';Path(os.environ['DOKS_WORKDIR']).mkdir(mode=0o700)
   p.journal_path().write_text('{}');p.journal_path().chmod(0o644)
   with self.assertRaises(p.InventoryError):p.cleanup_saved_client()

if __name__=='__main__':unittest.main()
