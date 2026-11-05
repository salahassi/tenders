"""Durable cleanup replay after real-controller-shaped fixture deletion."""
import base64
import copy
import json
import unittest
from unittest.mock import patch

import test_cloud_retirement as fixtures
import test_cloud_retirement_runner as runner_tests

a=fixtures.a;c=fixtures.c;r=fixtures.r;m=runner_tests.m

class CleanupCheckpoint(unittest.TestCase):
 setUp=fixtures.Resume.setUp
 resource=fixtures.Resume.resource
 fixture=fixtures.Resume.fixture
 def prepared(self):
  adapter,capture,selection=self.fixture();self.state['phase']='verified'
  proof={'version':1,'operation_nonce':adapter.nonce,'namespace_uid':self.state['bootstrap']['uid'],'mode':'terminated_originals','workloads':{}}
  for name in c.proof.NAMES:
   identities=[c.proof.pod_identity(p) for p in capture['pods'][name]]
   termination={p['uid']:{'uid':p['uid'],'containers':[{**x,'started_at':'2026-11-05T00:00:00Z','finished_at':'2026-11-05T00:00:03Z','exit_code':143,'reason':'Error'} for x in p['containers']]} for p in identities}
   journal={'nonce':adapter.nonce,'pods':identities,'termination':termination}
   capture['workloads'][name]['metadata']['annotations']={a.UNCERTAIN:c.canonical(journal)}
   proof['workloads'][name]={'deployment_uid':capture['workloads'][name]['metadata']['uid'],'journal':journal,'protection_released':True}
  return adapter,capture,c.validate_cleanup_proof(self.state,proof)
 def test_cleanup_preconditions_returns_complete_original_exit_proof(self):
  adapter,capture,proof=self.prepared()
  with patch.object(adapter,'restore'),patch.object(adapter,'items',return_value=[]),patch.object(r,'get',side_effect=lambda state,kind,name:capture['workloads'][name]):
   self.assertEqual(adapter.cleanup_preconditions(),proof)
 def test_missing_journal_cannot_be_replaced_by_cleaning_phase_or_absence(self):
  adapter,capture,proof=self.prepared();capture['workloads']['worker']['metadata']['annotations']={}
  with patch.object(adapter,'restore'),patch.object(adapter,'items',return_value=[]),patch.object(r,'get',side_effect=lambda state,kind,name:capture['workloads'][name]):
   with self.assertRaisesRegex(c.FixtureError,'EXIT_PROOF_MISSING'):adapter.cleanup_preconditions()
 def test_failed_checkpoint_readback_blocks_every_delete(self):
  adapter,capture,proof=self.prepared()
  with patch.object(r,'namespace_guard'),patch.object(a.FixtureAdapter,'cleanup_preconditions',return_value=proof),patch.object(r,'items',return_value=[]),patch.object(r,'save',side_effect=c.FixtureError('RETIREMENT_FIXTURE_JOURNAL_READBACK_FAILED')),patch.object(r,'delete') as delete,patch.object(m,'create_sql_job') as drop:
   with self.assertRaisesRegex(c.FixtureError,'READBACK_FAILED'):m.cleanup(self.state)
  delete.assert_not_called();drop.assert_not_called()
 def test_fresh_runner_resumes_after_controllers_deleted_and_pvc_wait_failed(self):
  adapter,capture,proof=self.prepared();events=[];durable={};deleted=set()
  self.state['bootstrap']['setup_started']=True
  capture['pvc']['spec']['volumeName']='pvc-owned'
  pv={'metadata':{'name':'pvc-owned','uid':fixtures.UUIDS[30]},'spec':{'claimRef':{'uid':capture['pvc']['metadata']['uid'],'namespace':c.namespace(self.state),'name':c.PVC_NAME},'persistentVolumeReclaimPolicy':'Delete','csi':{'driver':'dobs.csi.digitalocean.com'}}}
  cleanup_journal={'pvc_uid':capture['pvc']['metadata']['uid'],'pv_name':'pvc-owned','pv_uid':pv['metadata']['uid'],'storage_absence_confirmed':False}
  def save(state):
   c.validate_state(state);durable['state']=json.loads(c.canonical(state));events.append('checkpoint_readback')
  def delete(state,kind,name):
   self.assertIsNotNone(durable['state']['cleanup_proof']);deleted.add((kind,name));events.append('delete:'+kind+'/'+name)
  def waiting(state,kind,name,seconds=180):
   if kind=='persistentvolumeclaim':raise c.FixtureError('RETIREMENT_FIXTURE_RESOURCE_CLEANUP_PENDING')
  with patch.object(r,'namespace_guard'),patch.object(a.FixtureAdapter,'cleanup_preconditions',return_value=proof) as restore,patch.object(r,'items',return_value=[]),patch.object(r,'save',side_effect=save),patch.object(r,'delete',side_effect=delete),patch.object(r,'get',return_value=capture['pvc']),patch.object(r,'command',return_value=json.dumps(pv)),patch.object(r,'delete_observed',side_effect=lambda state,kind,name,pvc:delete(state,kind,name)),patch.object(m,'cleanup_journal',return_value=cleanup_journal),patch.object(m,'await_gone',side_effect=waiting):
   with self.assertRaisesRegex(c.FixtureError,'CLEANUP_PENDING'):m.cleanup(self.state)
  self.assertEqual(events[0],'checkpoint_readback')
  self.assertTrue(all(('deployment',name) in deleted for name in c.proof.NAMES))
  self.assertIn(('persistentvolumeclaim',c.PVC_NAME),deleted)
  restored=c.validate_state(json.loads(c.canonical(durable['state'])))
  self.assertEqual(restored['phase'],'cleaning')
  def remaining(state,kind,name,**kwargs):
   if kind=='deployment':raise AssertionError('deleted Deployment must not be restored or reread')
   if kind=='persistentvolumeclaim':return None
   return {'metadata':{'uid':fixtures.UUIDS[36]}}
  with patch.object(r,'namespace_guard'),patch.object(a.FixtureAdapter,'cleanup_preconditions',side_effect=AssertionError('must use durable full proof')),patch.object(r,'items',return_value=[]),patch.object(r,'save',side_effect=save),patch.object(r,'delete',side_effect=delete),patch.object(m,'cleanup_journal',return_value=cleanup_journal),patch.object(m,'await_gone'),patch.object(r,'get',side_effect=remaining),patch.object(r,'command',return_value=''),patch.object(m,'save_cleanup_journal'),patch.object(m,'patch_parent'),patch.object(m.b,'wait_clients_stopped'),patch.object(m,'create_sql_job') as cleanup_sql,patch.object(m.b,'save'),patch.object(m,'record_cleaned'),patch.object(m,'delete_namespace') as namespace,patch.object(m.b,'private_state_path'):
   m.cleanup(restored)
  cleanup_sql.assert_called_once();namespace.assert_called_once()
  self.assertTrue(restored['bootstrap']['database_cleanup_confirmed'])
 def test_swapped_missing_or_incomplete_original_proof_prevents_delete(self):
  mutations=[lambda p:p['workloads'].pop('worker'),
   lambda p:p['workloads']['worker']['journal']['termination'].clear(),
   lambda p:p.update(operation_nonce=fixtures.UUIDS[35]),
   lambda p:p['workloads']['worker'].update(deployment_uid=fixtures.UUIDS[35]),
   lambda p:p['workloads']['worker'].update(protection_released=False),
   lambda p:p['workloads']['worker']['journal']['termination'][next(iter(p['workloads']['worker']['journal']['termination']))]['containers'][0].update(container_id='containerd://'+'f'*64)]
  for mutate in mutations:
   self.state['cleanup_proof']=None
   adapter,capture,proof=self.prepared();mutate(proof);self.state['cleanup_proof']=proof;self.state['phase']='cleaning'
   with self.subTest(mutation=mutate),patch.object(r,'namespace_guard'),patch.object(r,'delete') as delete,patch.object(m,'create_sql_job') as drop:
    with self.assertRaises((c.FixtureError,c.proof.RetirementError)):m.cleanup(self.state)
   delete.assert_not_called();drop.assert_not_called()
 def test_fresh_protection_marker_still_blocks_checkpoint_replay(self):
  adapter,capture,proof=self.prepared();self.state['cleanup_proof']=proof;self.state['phase']='cleaning'
  pod={'metadata':{'annotations':{c.proof.ANNOTATION:self.state['operation_nonce']}}}
  with patch.object(r,'namespace_guard'),patch.object(r,'items',return_value=[pod]),patch.object(r,'delete') as delete:
   with self.assertRaisesRegex(c.FixtureError,'PROTECTED_PROCESS'):m.cleanup(self.state)
  delete.assert_not_called()
 def test_before_protection_cleanup_retains_distinct_live_original_witness(self):
  adapter,capture,selection=self.fixture();self.state['phase']='fixture_ready'
  by_name={p['metadata']['name']:p for values in capture['pods'].values() for p in values}
  for pod in by_name.values():
   for status in pod['status']['containerStatuses']:status.update(ready=True,state={'running':{'startedAt':'2026-11-05T00:00:00Z'}})
  with patch.object(r,'get',side_effect=lambda state,kind,name:capture['workloads'][name]),patch.object(adapter,'pod',side_effect=lambda name:by_name[name]),patch.object(adapter,'restore') as restore:
   proof=adapter.cleanup_preconditions()
  restore.assert_not_called();self.assertEqual(proof['mode'],'unprotected_originals')
  self.assertNotIn('journal',proof['workloads']['worker'])
  self.state['phase']='cleaning';self.state['cleanup_proof']=proof;c.validate_state(self.state)
  for change in ('container','marker','replacement','termination'):
   bad=copy.deepcopy(proof);pod=bad['workloads']['worker']['pods'][0]
   if change=='container':pod['status']['containerStatuses'][0]['containerID']='containerd://'+'f'*64
   elif change=='marker':pod['metadata']['annotations']={c.proof.ANNOTATION:''}
   elif change=='replacement':pod['metadata']['uid']=fixtures.UUIDS[35]
   else:pod['status']['containerStatuses'][0]['state']={'terminated':{}}
   with self.subTest(change=change),self.assertRaises((c.FixtureError,c.proof.RetirementError)):c.validate_cleanup_proof(self.state,bad)
  bad=copy.deepcopy(proof);bad['mode']='terminated_originals'
  with self.assertRaises(c.FixtureError):c.validate_cleanup_proof(self.state,bad)

class VolumeBinding(unittest.TestCase):
 setUp=fixtures.Guards.setUp
 resource=fixtures.Guards.resource
 def fixture(self,bound=False):
  pvc=self.resource('persistentvolumeclaim',c.PVC_NAME,{'volumeName':'pvc-owned'} if bound else {})
  pv={'metadata':{'name':'pvc-owned','uid':fixtures.UUIDS[30]},'spec':{'claimRef':{'uid':pvc['metadata']['uid'],'namespace':c.namespace(self.state),'name':c.PVC_NAME},'persistentVolumeReclaimPolicy':'Delete','csi':{'driver':'dobs.csi.digitalocean.com'}}}
  journal={'pvc_uid':pvc['metadata']['uid'],'pv_name':None,'pv_uid':None,'storage_absence_confirmed':False}
  return pvc,pv,journal
 def test_new_binding_is_journaled_before_same_observation_delete(self):
  pvc,pv,journal=self.fixture(bound=True);events=[]
  with patch.object(r,'get',return_value=pvc),patch.object(r,'command',return_value=json.dumps(pv)),patch.object(m,'save_cleanup_journal',side_effect=lambda state,j:events.append(('saved',copy.deepcopy(j)))),patch.object(r,'delete_observed',side_effect=lambda state,kind,name,actual:events.append(('delete',actual))),patch.object(m,'await_gone'):
   result=m.delete_fixture_pvc(self.state,journal)
  self.assertEqual([x[0] for x in events],['saved','delete']);self.assertIs(events[1][1],pvc)
  self.assertEqual(result['pv_uid'],pv['metadata']['uid'])
 def test_binding_change_or_lost_delete_ack_never_skips_remaining_cleanup(self):
  pvc,pv,journal=self.fixture(bound=True);journal.update(pv_name=pv['metadata']['name'],pv_uid=pv['metadata']['uid'])
  def command(args,**kwargs):
   if args[0]=='get':return json.dumps(pv)
   self.assertEqual(json.loads(kwargs['payload'])['preconditions'],{'uid':pvc['metadata']['uid'],'resourceVersion':'10'})
   raise c.FixtureError('RETIREMENT_FIXTURE_COMMAND_FAILED')
  with patch.object(r,'get',return_value=pvc),patch.object(r,'namespace_guard'),patch.object(r,'command',side_effect=command),patch.object(m,'await_gone') as wait:
   with self.assertRaises(c.FixtureError):m.delete_fixture_pvc(self.state,journal)
  wait.assert_not_called();self.assertFalse(journal['storage_absence_confirmed'])
 def test_missing_pvc_after_lost_ack_still_finds_claim_uid_volume(self):
  pvc,pv,journal=self.fixture()
  with patch.object(r,'get',return_value=None),patch.object(m,'await_gone'),patch.object(r,'command',return_value=json.dumps({'items':[pv]})),patch.object(m,'save_cleanup_journal') as save,patch.object(r,'delete_observed') as delete:
   result=m.delete_fixture_pvc(self.state,journal)
  delete.assert_not_called();save.assert_called_once();self.assertEqual(result['pv_uid'],pv['metadata']['uid'])
 def test_foreign_bound_volume_is_rejected_before_pvc_delete(self):
  pvc,pv,journal=self.fixture(bound=True);pv['spec']['claimRef']['uid']=fixtures.UUIDS[31]
  with patch.object(r,'get',return_value=pvc),patch.object(r,'command',return_value=json.dumps(pv)),patch.object(r,'delete_observed') as delete:
   with self.assertRaisesRegex(c.FixtureError,'VOLUME_IDENTITY_CHANGED'):m.delete_fixture_pvc(self.state,journal)
  delete.assert_not_called()
 def test_empty_unbound_census_retains_state_without_database_or_namespace_cleanup(self):
  pvc,pv,journal=self.fixture();self.state['bootstrap']['setup_started']=True
  with patch.object(r,'namespace_guard'),patch.object(r,'items',return_value=[]),patch.object(r,'save'),patch.object(r,'get',return_value=None),patch.object(r,'command',return_value='{"items":[]}'),patch.object(m,'cleanup_journal',return_value=journal),patch.object(m,'await_gone'),patch.object(m,'save_cleanup_journal') as certify,patch.object(m,'create_sql_job') as database,patch.object(m,'delete_namespace') as namespace:
   with self.assertRaisesRegex(c.FixtureError,'VOLUME_ALLOCATION_RECONCILIATION_REQUIRED'):m.cleanup(self.state)
  certify.assert_not_called();database.assert_not_called();namespace.assert_not_called()
  self.assertFalse(journal['storage_absence_confirmed']);self.assertEqual(self.state['phase'],'cleaning')

if __name__=='__main__':unittest.main()
