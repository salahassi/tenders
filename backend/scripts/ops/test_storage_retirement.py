import copy
from datetime import datetime,timezone,timedelta
import importlib.util
from pathlib import Path
import unittest
import uuid
p=Path(__file__).parent/'storage-retirement/coordinator.py';s=importlib.util.spec_from_file_location('retirement_coordinator',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)

def selection():
 return {'version':1,'operation_nonce':str(uuid.uuid4()),'actor_id':str(uuid.uuid4()),'namespace_uid':str(uuid.uuid4()),'binary_receipt_sha256':'a'*64,
  'selection':[{'id':str(uuid.uuid4()),'retirement_nonce':str(uuid.uuid4()),'storage_key':'workspace/key','revision':1}],
  'expected_workloads':{name:{'uid':str(uuid.uuid4()),'image':m.STORAGE_IMAGE if name=='storage' else 'example.invalid/app@sha256:'+'a'*64,'replicas':1} for name in m.NAMES}}

def terminal(status,code=0,reason='Completed'):
 now=datetime.now(timezone.utc)
 return {'containerID':status['containerID'],'exitCode':code,'reason':reason,'startedAt':(now-timedelta(seconds=1)).isoformat(),'finishedAt':now.isoformat()}

class Adapter:
 def __init__(self,s,fail=None):
  self.s=s;self.fail=fail;self.events=[];self.finished=False;self.saved={};self.absent=False
  self.capture_value={'workloads':{},'pods':{}}
  for name in m.NAMES:
   x=s['expected_workloads'][name]
   spec={'containers':[{'name':name,'image':x['image']}],'nodeName':'isolated-fixture'}
   self.capture_value['workloads'][name]={'metadata':{'uid':x['uid']},'spec':{'replicas':1,'template':{'spec':spec}}}
   pod={'metadata':{'uid':str(uuid.uuid4()),'name':name+'-pod'},'spec':copy.deepcopy(spec),'status':{'containerStatuses':[{'name':name,'containerID':'containerd://'+'a'*64,'state':{'running':{}}}]}}
   self.capture_value['pods'][name]=[pod];self.saved[pod['metadata']['name']]=copy.deepcopy(pod)
 def step(self,name):
  self.events.append(name)
  if self.fail==name:raise m.RetirementError('INJECTED_'+name.upper())
 def validate_binary(self,*_):self.step('validate_binary')
 def capture(self,*_):self.step('capture');return copy.deepcopy(self.capture_value)
 def install_fence(self,*_):self.step('install_fence')
 def prepare(self,*_):
  self.step('prepare');return {'state':'prepared','operation_nonce':self.s['operation_nonce'],'scope_sha256':'a'*64,'scope':copy.deepcopy(self.s['selection'])}
 def census(self):self.step('census');return ['workspace/key','workspace/unrelated']
 def protect_pods(self,capture,nonce):
  self.step('protect_pods')
  for p in self.saved.values():p['metadata'].update({'annotations':{m.ANNOTATION:nonce},'finalizers':[m.FINALIZER]})
 def stop(self,*_):
  self.step('stop')
  for p in self.saved.values():
   p['metadata']['deletionTimestamp']=datetime.now(timezone.utc).isoformat()
   for s in p['status']['containerStatuses']:s['state']={'terminated':terminal(s,137,'OOMKilled')}
 def assert_stopped(self,*_):self.step('assert_stopped')
 def pod(self,name):self.step('pod');return copy.deepcopy(self.saved[name])
 def assert_no_other_pvc_writers(self,*_):self.step('pvc')
 def assert_no_multipart(self,*_):self.step('multipart')
 def inspect_physical(self,*_):
  self.step('inspect');return {'absent':self.absent,'files':[] if self.absent else [{'relativePath':'opaque','size':4,'sha256':'b'*64}],'manifestSha256':'d'*64 if self.absent else 'c'*64}
 def remove_physical(self,*_):
  self.step('remove');self.absent=True;return {'absent':True,'remainingCount':0,'beforeManifestSha256':'c'*64,'afterManifestSha256':'d'*64,'removedCount':1,'removedBytes':4}
 def delete_metadata(self,*_):self.step('delete_metadata')
 def metadata_remaining(self,*_):self.step('metadata_remaining');return 0
 def identity(self):return {'source_revision':'b'*40}
 def finish(self,*_):self.step('finish');self.finished=True;return {'state':'complete'}
 def restore(self,*_):self.step('restore')

class RetirementTests(unittest.TestCase):
 def test_success_real_order_contract(self):
  s=selection();a=Adapter(s);self.assertEqual(m.retire(a,s),{'state':'complete'})
  self.assertLess(a.events.index('stop'),a.events.index('remove'));self.assertLess(a.events.index('metadata_remaining'),a.events.index('finish'));self.assertEqual(a.events[-1],'restore')
 def test_each_boundary_failure_restores_without_false_completion(self):
  for stage in ('install_fence','prepare','census','protect_pods','stop','assert_stopped','pod','pvc','multipart','inspect','remove','delete_metadata','metadata_remaining','finish'):
   with self.subTest(stage=stage):
    s=selection();a=Adapter(s,stage)
    with self.assertRaises(m.RetirementError):m.retire(a,s)
    self.assertEqual(a.events[-1],'restore');self.assertFalse(a.finished)
 def test_unproven_process_disappearance_never_releases(self):
  s=selection();a=Adapter(s);a.pod=lambda _:None
  with self.assertRaisesRegex(m.RetirementError,'DISAPPEARED'):m.retire(a,s)
  self.assertNotIn('remove',a.events);self.assertEqual(a.events[-1],'restore')
 def test_replica_zero_with_running_process_is_not_quiescence(self):
  s=selection();a=Adapter(s);a.stop=lambda *_:None;clock=iter([0,1,2,3,4])
  with self.assertRaisesRegex(m.RetirementError,'DRAIN_NOT_PROVEN'):m.retire(a,s,clock=lambda:next(clock),pause=lambda _:None,timeout=1)
  self.assertNotIn('remove',a.events);self.assertEqual(a.events[-1],'restore')
 def test_mismatched_container_identity_is_rejected(self):
  s=selection();a=Adapter(s);old=a.stop
  def stop(*args):old(*args);a.saved['storage-pod']['status']['containerStatuses'][0]['containerID']=''
  a.stop=stop
  with self.assertRaisesRegex(m.RetirementError,'PROCESS_PROOF_INVALID'):m.retire(a,s)
  self.assertFalse(a.finished)
 def test_foreign_finalizer_nonce_and_recreated_pod_rejected(self):
  for mutate in (lambda p:p['metadata']['annotations'].update({m.ANNOTATION:str(uuid.uuid4())}),lambda p:p['metadata'].update(uid=str(uuid.uuid4()))):
   s=selection();a=Adapter(s);old=a.stop
   def stop(*args):old(*args);mutate(a.saved['storage-pod'])
   a.stop=stop
   with self.assertRaisesRegex(m.RetirementError,'OWNERSHIP_CHANGED'):m.retire(a,s)
   self.assertFalse(a.finished)
 def test_physical_aliases_include_uncertain_missing_metadata_keys(self):
  for key in ('workspace/key.info','workspace/key/00000000-0000-4000-8000-000000000001','workspace/key-$v-00000000-0000-4000-8000-000000000001','workspace'):
   with self.subTest(key=key),self.assertRaisesRegex(m.RetirementError,'COLLISION'):m.check_collisions(['workspace/key'],[key])
 def test_selected_overlap_is_not_silently_joint_retired(self):
  with self.assertRaisesRegex(m.RetirementError,'COLLISION'):m.check_collisions(['workspace/key','workspace/key.info'],[])
 def test_remaining_metadata_or_late_physical_change_blocks_finish(self):
  s=selection();a=Adapter(s);a.metadata_remaining=lambda *_:1
  with self.assertRaisesRegex(m.RetirementError,'METADATA_REMAINS'):m.retire(a,s)
  self.assertFalse(a.finished)
  a=Adapter(s);old=a.inspect_physical
  def inspect(*args):v=old(*args);v['manifestSha256']='f'*64;return v
  a.inspect_physical=inspect
  with self.assertRaisesRegex(m.RetirementError,'PHYSICAL_CHANGED'):m.retire(a,s)
  self.assertFalse(a.finished)
 def test_restore_failure_never_claims_operational_success(self):
  s=selection();a=Adapter(s,'restore')
  with self.assertRaisesRegex(m.RetirementError,'INJECTED_RESTORE'):m.retire(a,s)
  self.assertTrue(a.finished)
 def test_invalid_or_unqualified_selection_stops_before_capture(self):
  for field,value in [('version',True),('operation_nonce','bad')]:
   s=selection();s[field]=value;a=Adapter(s)
   with self.assertRaises(m.RetirementError):m.retire(a,s)
   self.assertEqual(a.events,[])
  s=selection();s['expected_workloads']['storage']['image']='example.invalid/unreviewed@sha256:'+'a'*64;a=Adapter(s)
  with self.assertRaisesRegex(m.RetirementError,'UNQUALIFIED_BINARY'):m.retire(a,s)
  self.assertEqual(a.events,[])
if __name__=='__main__':unittest.main()

class PreFenceTests(unittest.TestCase):
 def test_known_alias_rejected_before_permanent_prepare(self):
  s=selection();a=Adapter(s);a.census=lambda:['workspace/key.info']
  with self.assertRaisesRegex(m.RetirementError,'NAMESPACE_COLLISION'):m.retire(a,s)
  self.assertNotIn('prepare',a.events);self.assertNotIn('protect_pods',a.events);self.assertEqual(a.events[-1],'restore')

class ProcessProofTests(unittest.TestCase):
 def pair(self):
  s=selection();a=Adapter(s);original=a.capture_value['pods']['storage'][0]
  a.protect_pods(a.capture_value,s['operation_nonce']);a.stop()
  return s,original,a.saved['storage-pod']
 def check_rejected(self,mutate):
  s,original,current=self.pair();mutate(current)
  with self.assertRaisesRegex(m.RetirementError,'PROCESS_PROOF_INVALID'):m.terminated_pod(original,current,s['operation_nonce'])
 def test_both_current_and_inner_ids_must_equal_captured_container(self):
  changed='containerd://'+'b'*64
  def both(p):
   status=p['status']['containerStatuses'][0];status['containerID']=changed;status['state']['terminated']['containerID']=changed
  for mutate in (both,lambda p:p['status']['containerStatuses'][0]['state']['terminated'].update(containerID=changed),
                 lambda p:p['status']['containerStatuses'][0]['state']['terminated'].pop('containerID')):
   with self.subTest(mutate=mutate.__name__):self.check_rejected(mutate)
 def test_unknown_termination_or_pod_reason_never_proves_exit(self):
  for reason in ('NodeLost','ContainerStatusUnknown','Unknown',''):
   with self.subTest(reason=reason):self.check_rejected(lambda p:p['status']['containerStatuses'][0]['state']['terminated'].update(reason=reason))
  for reason in ('NodeLost','ContainerStatusUnknown'):
   with self.subTest(pod_reason=reason):self.check_rejected(lambda p:p['status'].update(reason=reason))
 def test_exit_code_requires_bounded_integer_not_boolean(self):
  for code in (True,False,-1,256,None,'0'):
   with self.subTest(code=code):self.check_rejected(lambda p:p['status']['containerStatuses'][0]['state']['terminated'].update(exitCode=code))
 def test_both_times_must_be_real_ordered_non_epoch_and_not_future(self):
  for key in ('startedAt','finishedAt'):
   for value in (None,'','1970-01-01T00:00:00Z','0001-01-01T00:00:00Z','2026-13-01T00:00:00Z',
                 '2026-01-01T00:00:00',(datetime.now(timezone.utc)+timedelta(days=1)).isoformat()):
    with self.subTest(key=key,value=value):self.check_rejected(lambda p:p['status']['containerStatuses'][0]['state']['terminated'].update({key:value}))
  def reverse(p):
   term=p['status']['containerStatuses'][0]['state']['terminated'];term['startedAt'],term['finishedAt']=term['finishedAt'],term['startedAt']
  self.check_rejected(reverse)
 def test_all_reviewed_termination_reasons_retain_exact_identity(self):
  for reason,code in (('Completed',0),('Error',143),('OOMKilled',137)):
   s,old,p=self.pair();status=p['status']['containerStatuses'][0];status['state']['terminated']=terminal(status,code,reason)
   proof=m.terminated_pod(old,p,s['operation_nonce'])
   self.assertEqual(proof['containers'][0]['reason'],reason)
   self.assertEqual(proof['containers'][0]['container_id'],old['status']['containerStatuses'][0]['containerID'])
 def test_live_restartable_pod_with_terminated_status_is_not_settled(self):
  s,old,p=self.pair();del p['metadata']['deletionTimestamp'];p['status']['phase']='Running'
  self.assertIsNone(m.terminated_pod(old,p,s['operation_nonce']))
 def test_missing_extra_or_duplicate_saved_container_proofs_reject(self):
  s,old,p=self.pair();proof=m.terminated_pod(old,p,s['operation_nonce']);expected=m.container_identities(old)
  for entries in ([],proof['containers']*2,[{**proof['containers'][0],'name':'foreign'}]):
   with self.subTest(entries=entries),self.assertRaisesRegex(m.RetirementError,'JOURNAL_INVALID'):
    m.validate_saved_termination({**proof,'containers':entries},old['metadata']['uid'],expected)
 def test_unknown_exit_blocks_physical_removal_and_quota_completion(self):
  s=selection();a=Adapter(s);stop=a.stop
  def unknown(*args):
   stop(*args);a.saved['storage-pod']['status']['containerStatuses'][0]['state']['terminated']['reason']='ContainerStatusUnknown'
  a.stop=unknown
  with self.assertRaisesRegex(m.RetirementError,'PROCESS_PROOF_INVALID'):m.retire(a,s)
  self.assertNotIn('remove',a.events);self.assertNotIn('finish',a.events);self.assertEqual(a.events[-1],'restore')
 def test_existing_sql_shape_receives_only_validated_projection(self):
  s=selection();a=Adapter(s);received=[];finish=a.finish
  def capture(*args):received.append(args[-1]);return finish(*args)
  a.finish=capture;m.retire(a,s)
  for workload in received[0]['quiescence']:
   for pod in workload['pods']:
    for item in pod['containers']:self.assertEqual(set(item),{'name','container_id','finished_at','exit_code'})
