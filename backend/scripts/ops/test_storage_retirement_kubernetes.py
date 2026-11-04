import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid
from test_storage_retirement import selection
s=importlib.util.spec_from_file_location('retirement_kube_test',Path(__file__).parent/'storage-retirement/kubernetes.py');k=importlib.util.module_from_spec(s);s.loader.exec_module(k);c=k.c

class FakeCluster:
 NAMESPACE='tenderdesk-dev'
 def __init__(self,selected):
  self.selected=selected;self.resources={};self.calls=[];self.fail_after_patch=None;self.patched=0;self.immediate_gc=False;self.lose_finalizer_ack=None
  def meta(name,uid=None):return {'name':name,'namespace':self.NAMESPACE,'uid':uid or str(uuid.uuid4()),'resourceVersion':'1','generation':1,'labels':{'app.kubernetes.io/managed-by':'tenderdesk-deployment'}}
  self.resources['namespace',self.NAMESPACE]={'metadata':meta(self.NAMESPACE,selected['namespace_uid'])}
  self.resources['service','storage']={'metadata':meta('storage'),'spec':{'type':'ClusterIP','ports':[{'port':5000}],'selector':{'app.kubernetes.io/name':'storage'}}}
  self.resources['networkpolicy','internal-services']={'metadata':meta('internal-services'),'spec':{'podSelector':{'matchExpressions':[{'key':'app.kubernetes.io/name','operator':'NotIn','values':['https']}]},'policyTypes':['Ingress'],'ingress':[{'from':[{'podSelector':{}}]}]}}
  self.resources['configmap','gateway-config']={'metadata':meta('gateway-config'),'data':{'nginx.conf':'qualified'}}
  self.resources['pvc','private-objects']={'metadata':meta('private-objects'),'spec':{'volumeName':'synthetic-only','accessModes':['ReadWriteOnce']}}
  for name in c.NAMES:
   expected=selected['expected_workloads'][name];container={'name':name,'image':expected['image'],'securityContext':{'runAsUser':1000}}
   spec={'containers':[container],'securityContext':{'runAsUser':1000}}
   if name=='storage':spec.update(volumes=[{'name':'objects','persistentVolumeClaim':{'claimName':'private-objects'}}]);container['volumeMounts']=[{'name':'objects','mountPath':'/var/lib/storage'}]
   dep={'metadata':meta(name,expected['uid']),'spec':{'replicas':1,'selector':{'matchLabels':{'app':name}},'template':{'spec':copy.deepcopy(spec)}},'status':{'observedGeneration':1,'readyReplicas':1,'updatedReplicas':1}}
   rs={'metadata':meta(name+'-rs')};rs['metadata']['ownerReferences']=[{'uid':dep['metadata']['uid'],'controller':True}]
   pod={'metadata':meta(name+'-pod'),'spec':{**copy.deepcopy(spec),'nodeName':'isolated-fixture'},'status':{'containerStatuses':[{'name':name,'ready':True,'state':{'running':{}}}]}}
   pod['metadata']['labels']['app']=name;pod['metadata']['labels']['app.kubernetes.io/name']=name;pod['metadata']['ownerReferences']=[{'uid':rs['metadata']['uid'],'controller':True}]
   self.resources['deployment',name]=dep;self.resources['replicaset',name+'-rs']=rs;self.resources['pod',name+'-pod']=pod
  self.probe=type('Probe',(),{'validate_cluster':lambda _:None})()
 def get(self,kind,name):return copy.deepcopy(self.resources.get((kind,name)))
 def command(self,args,**kwargs):
  self.calls.append(args)
  if args[0]=='get':
   kind={'pods':'pod','replicasets':'replicaset','horizontalpodautoscalers':'hpa','services':'service','networkpolicies':'networkpolicy'}[args[1]]
   return json.dumps({'items':[copy.deepcopy(v) for (t,_),v in self.resources.items() if t==kind]})
  if args[0]=='exec':return json.dumps({'STORAGE_BACKEND':'file','FILE_STORAGE_BACKEND_PATH':'/var/lib/storage','GLOBAL_S3_BUCKET':'tenderdesk','TENANT_ID':'tenderdesk','TUS_USE_FILE_VERSION_SEPARATOR':None,'PG_QUEUE_ENABLE':'false','S3_PROTOCOL_ENABLED':'false'})
  if args[0]=='patch':
   kind,name=args[1:3];value=self.resources[kind,name]
   for op in json.loads(args[-1]):
    keys=[v.replace('~1','/').replace('~0','~') for v in op['path'].strip('/').split('/')];parent=value
    for key in keys[:-1]:parent=parent[key]
    key=keys[-1]
    if op['op']=='test':
     if parent.get(key)!=op['value']:raise RuntimeError('CAS_FAILED')
    elif op['op']=='remove':del parent[key]
    else:parent[key]=copy.deepcopy(op['value'])
   if kind=='deployment' and value['spec']['replicas']==0:
    from datetime import datetime,timezone
    self.resources['pod',name+'-pod']['metadata']['deletionTimestamp']=datetime.now(timezone.utc).isoformat()
    self.resources['pod',name+'-pod']['status']['containerStatuses'][0].update(containerID='containerd://'+'a'*64,state={'terminated':{'exitCode':0,'finishedAt':datetime.now(timezone.utc).isoformat()}})
   self.patched+=1;value['metadata']['resourceVersion']=str(int(value['metadata']['resourceVersion'])+1)
   removed_finalizer=kind=='pod' and any(op['op']=='remove' and op['path']=='/metadata/finalizers' for op in json.loads(args[-1]))
   if removed_finalizer and self.immediate_gc and value['metadata'].get('deletionTimestamp'):self.resources.pop((kind,name),None)
   if removed_finalizer and self.lose_finalizer_ack==name:self.lose_finalizer_ack=None;raise RuntimeError('LOST_FINALIZER_ACK')
   if self.patched==self.fail_after_patch:raise RuntimeError('LOST_ACK')
   return ''
  if args[0]=='rollout':return ''
  if args[0]=='delete' and args[1]=='--raw':
   from datetime import datetime,timezone
   name=args[2].rsplit('/',1)[-1];pod=self.resources['pod',name];options=json.loads(kwargs['payload'])
   assert options['preconditions']=={'uid':pod['metadata']['uid'],'resourceVersion':pod['metadata']['resourceVersion']}
   assert options['gracePeriodSeconds']>=1
   pod['metadata']['deletionTimestamp']=datetime.now(timezone.utc).isoformat()
   pod['status']['containerStatuses'][0].update(containerID='containerd://'+'a'*64,state={'terminated':{'exitCode':143,'finishedAt':datetime.now(timezone.utc).isoformat()}})
   return ''
  if args[0]=='delete':self.resources.pop((args[1],args[2]),None);return ''
  raise AssertionError(args)

class AdapterTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.s=selection();self.cluster=FakeCluster(self.s);self.mock=patch.object(k,'d',self.cluster);self.mock.start()
  client=type('Client',(),dict(base='base',nonce='abcd1234',pod='pg',secret='db',labels={},timeout=1500))()
  self.a=k.KubernetesAdapter(self.temp.name,client,self.s)
  self.gateway=patch.object(k.gateway,'require_installed',return_value={'config':self.cluster.resources['configmap','gateway-config'],'after_data':{'nginx.conf':'qualified'}});self.gateway.start();self.restart=patch.object(k.gateway,'require_restart_guard',return_value={'qualified':True});self.restart.start()
 def tearDown(self):self.restart.stop();self.gateway.stop();self.mock.stop();self.temp.cleanup()
 def test_captures_actual_pvc_and_selected_nonsecret_settings(self):
  v=self.a.capture(self.s);self.assertEqual(v['pvc']['metadata']['uid'],self.cluster.resources['pvc','private-objects']['metadata']['uid'])
  self.assertEqual(set(v['storage_configuration']),{'STORAGE_BACKEND','FILE_STORAGE_BACKEND_PATH','GLOBAL_S3_BUCKET','TENANT_ID','TUS_USE_FILE_VERSION_SEPARATOR','PG_QUEUE_ENABLE','S3_PROTOCOL_ENABLED'})
  self.assertTrue(self.a.journal.exists())
 def test_changed_image_or_autoscaler_blocks_before_mutation(self):
  self.cluster.resources['deployment','storage']['spec']['template']['spec']['containers'][0]['image']='bad'
  with self.assertRaisesRegex(c.RetirementError,'DEPLOYMENT_CHANGED'):self.a.capture(self.s)
  self.assertEqual(self.cluster.patched,0)
 def test_pod_protection_lost_ack_cleanup_removes_owned_finalizer(self):
  v=self.a.capture(self.s);self.cluster.fail_after_patch=1
  with self.assertRaisesRegex(RuntimeError,'LOST_ACK'):self.a.protect_pods(v,self.a.nonce)
  with self.assertRaisesRegex(c.RetirementError,'PROCESS_RECONCILIATION_REQUIRED'):self.a.restore(v,self.a.nonce)
  self.assertNotIn(c.FINALIZER,self.cluster.resources['pod','worker-pod']['metadata'].get('finalizers',[]))
 def test_scale_zero_lost_ack_restores_all_original_replicas(self):
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce);self.cluster.fail_after_patch=self.cluster.patched+1
  with self.assertRaisesRegex(RuntimeError,'LOST_ACK'):self.a.stop(v,self.a.nonce)
  with self.assertRaisesRegex(c.RetirementError,'PROCESS_RECONCILIATION_REQUIRED'):self.a.restore(v,self.a.nonce)
  self.assertTrue(all(self.cluster.resources['deployment',n]['spec']['replicas']==1 for n in c.NAMES))
 def test_foreign_marker_never_overwritten_other_services_restored(self):
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce);self.a.stop(v,self.a.nonce)
  self.cluster.resources['deployment','storage']['metadata']['annotations'][c.ANNOTATION]='foreign'
  with self.assertRaisesRegex(c.RetirementError,'SERVICE_RESTORATION_REQUIRED'):self.a.restore(v,self.a.nonce)
  self.assertEqual(self.cluster.resources['deployment','storage']['spec']['replicas'],0)
  self.assertEqual(self.cluster.resources['deployment','worker']['spec']['replicas'],1)
  self.assertEqual(self.cluster.resources['deployment','gateway']['spec']['replicas'],1)
 def test_new_writer_or_changed_pvc_is_rejected(self):
  v=self.a.capture(self.s)
  foreign=copy.deepcopy(self.cluster.resources['pod','storage-pod']);foreign['metadata'].update(name='foreign',uid=str(uuid.uuid4()));self.cluster.resources['pod','foreign']=foreign
  with self.assertRaisesRegex(c.RetirementError,'OTHER_PVC_WRITER'):self.a.assert_no_other_pvc_writers(v)
  del self.cluster.resources['pod','foreign'];self.cluster.resources['pvc','private-objects']['metadata']['uid']=str(uuid.uuid4())
  with self.assertRaisesRegex(c.RetirementError,'PVC_CHANGED'):self.a.assert_no_other_pvc_writers(v)
 def test_fresh_runner_recovers_only_exact_nonce_spec_markers(self):
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce);self.a.stop(v,self.a.nonce)
  captured=self.a.recovery_capture();self.a.restore(captured,self.a.nonce)
  self.assertTrue(all(self.cluster.resources['deployment',n]['spec']['replicas']==1 for n in c.NAMES))
 def test_changed_source_spec_prevents_recovery_overwrite(self):
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce);self.a.stop(v,self.a.nonce)
  self.cluster.resources['deployment','worker']['spec']['template']['spec']['containers'][0]['resources']={'limits':{'memory':'1Gi'}}
  with self.assertRaisesRegex(c.RetirementError,'RESTORE_SPEC_CHANGED'):self.a.recovery_capture()
  self.assertEqual(self.cluster.resources['deployment','worker']['spec']['replicas'],0)
 def test_new_pod_after_scale_zero_cannot_pass_drain(self):
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce);self.a.stop(v,self.a.nonce)
  p=copy.deepcopy(self.cluster.resources['pod','worker-pod']);p['metadata'].update(uid=str(uuid.uuid4()),name='worker-other');self.cluster.resources['pod','worker-other']=p
  with self.assertRaisesRegex(c.RetirementError,'NEW_PROCESS_APPEARED'):self.a.assert_stopped(v,'worker',self.a.nonce)
 def test_unproven_terminating_pod_record_survives_service_restore(self):
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce);self.a.stop(v,self.a.nonce)
  pod=self.cluster.resources['pod','storage-pod'];pod['metadata']['deletionTimestamp']='2026-11-04T00:00:00Z';pod['status']['containerStatuses'][0]['state']={'running':{}}
  with self.assertRaisesRegex(c.RetirementError,'PROCESS_RECONCILIATION_REQUIRED'):self.a.restore(v,self.a.nonce)
  self.assertIn(c.FINALIZER,pod['metadata']['finalizers'])
  self.assertIn(k.UNCERTAIN,self.cluster.resources['deployment','storage']['metadata']['annotations'])
  self.assertTrue(all(self.cluster.resources['deployment',n]['spec']['replicas']==1 for n in c.NAMES))
  fresh=k.KubernetesAdapter(self.temp.name,self.a.client,self.s)
  with self.assertRaisesRegex(c.RetirementError,'UNRESOLVED_POD_PROOF'):fresh.capture(self.s)
 def test_disappeared_pod_keeps_durable_identity_and_blocks_future_proof(self):
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce);self.a.stop(v,self.a.nonce)
  old=self.cluster.resources.pop(('pod','storage-pod'))
  with self.assertRaisesRegex(c.RetirementError,'PROCESS_RECONCILIATION_REQUIRED'):self.a.restore(v,self.a.nonce)
  marker=json.loads(self.cluster.resources['deployment','storage']['metadata']['annotations'][k.UNCERTAIN])
  self.assertEqual(marker['pods'],[{'name':'storage-pod','uid':old['metadata']['uid']}])
  # Fresh recovery retains the missing identity, never silently forgets it.
  fresh=k.KubernetesAdapter(self.temp.name,self.a.client,self.s)
  with self.assertRaisesRegex(c.RetirementError,'PROCESS_RECONCILIATION_REQUIRED'):fresh.restore(fresh.recovery_capture(),fresh.nonce)
 def test_actual_later_termination_allows_owned_finalizer_retirement(self):
  from datetime import datetime,timezone
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce);self.a.stop(v,self.a.nonce)
  pod=self.cluster.resources['pod','storage-pod'];pod['metadata']['deletionTimestamp']='2026-11-04T00:00:00Z';pod['status']['containerStatuses'][0]['state']={'running':{}}
  with self.assertRaisesRegex(c.RetirementError,'PROCESS_RECONCILIATION_REQUIRED'):self.a.restore(v,self.a.nonce)
  pod['status']['containerStatuses'][0].update(containerID='containerd://'+'a'*64,state={'terminated':{'exitCode':137,'finishedAt':datetime.now(timezone.utc).isoformat()}})
  self.a.restore(v,self.a.nonce)
  self.assertNotIn(c.FINALIZER,pod['metadata'].get('finalizers',[]))
  self.assertNotIn(k.UNCERTAIN,self.cluster.resources['deployment','storage']['metadata']['annotations'])
 def test_gateway_guard_drift_never_restarts_unsafe_public_route(self):
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce);self.a.stop(v,self.a.nonce)
  with patch.object(k.gateway,'require_restart_guard',side_effect=c.RetirementError('GUARD_DRIFT')):
   with self.assertRaisesRegex(c.RetirementError,'SERVICE_RESTORATION_REQUIRED'):self.a.restore(v,self.a.nonce)
  self.assertEqual(self.cluster.resources['deployment','gateway']['spec']['replicas'],0)
  self.assertEqual(self.cluster.resources['deployment','storage']['spec']['replicas'],1)
  self.assertEqual(self.cluster.resources['deployment','worker']['spec']['replicas'],1)
 def test_live_nondeleting_protected_pod_is_not_cleared(self):
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce)
  with self.assertRaisesRegex(c.RetirementError,'PROCESS_RECONCILIATION_REQUIRED'):self.a.restore(v,self.a.nonce)
  for name in c.NAMES:
   self.assertIn(c.FINALIZER,self.cluster.resources['pod',name+'-pod']['metadata']['finalizers'])
   self.assertIn(k.UNCERTAIN,self.cluster.resources['deployment',name]['metadata']['annotations'])
 def test_explicit_process_reconcile_uses_exact_uid_and_normal_grace(self):
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce)
  with self.assertRaisesRegex(c.RetirementError,'PROCESS_RECONCILIATION_REQUIRED'):self.a.restore(v,self.a.nonce)
  self.a.drain_saved_processes()
  deletes=[x for x in self.cluster.calls if x[:2]==['delete','--raw']]
  self.assertEqual(len(deletes),3)
  self.assertTrue(all(x[-1]=='--filename=-' and '--force' not in x for x in deletes))
  self.assertTrue(all(k.UNCERTAIN not in self.cluster.resources['deployment',n]['metadata']['annotations'] for n in c.NAMES))
  self.assertTrue(all(c.FINALIZER not in self.cluster.resources['pod',n+'-pod']['metadata'].get('finalizers',[]) for n in c.NAMES))
 def test_zero_grace_is_not_used_to_manufacture_exit_proof(self):
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce)
  # An unqualified external Pod spec change is refused by final cleanup too.
  self.cluster.resources['pod','worker-pod']['spec']['terminationGracePeriodSeconds']=0
  with self.assertRaises(c.RetirementError):self.a.drain_saved_processes()
  self.assertTrue(any(k.UNCERTAIN in self.cluster.resources['deployment',n]['metadata']['annotations'] for n in c.NAMES))
 def add_second_storage_pod(self):
  self.s['expected_workloads']['storage']['replicas']=2
  dep=self.cluster.resources['deployment','storage'];dep['spec']['replicas']=2;dep['status'].update(readyReplicas=2,updatedReplicas=2)
  second=copy.deepcopy(self.cluster.resources['pod','storage-pod']);second['metadata'].update(name='storage-second',uid=str(uuid.uuid4()));self.cluster.resources['pod','storage-second']=second
  return second
 def terminate(self,pod):
  from datetime import datetime,timezone
  pod['metadata']['deletionTimestamp']=datetime.now(timezone.utc).isoformat()
  pod['status']['containerStatuses'][0].update(containerID='containerd://'+'b'*64,state={'terminated':{'exitCode':143,'finishedAt':datetime.now(timezone.utc).isoformat()}})
 def test_mixed_old_pods_keep_all_records_until_group_has_real_exit_proof(self):
  second=self.add_second_storage_pod();self.cluster.immediate_gc=True
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce);self.a.stop(v,self.a.nonce)
  with self.assertRaisesRegex(c.RetirementError,'PROCESS_RECONCILIATION_REQUIRED'):self.a.restore(v,self.a.nonce)
  self.assertIn(('pod','storage-pod'),self.cluster.resources)
  pending=json.loads(self.cluster.resources['deployment','storage']['metadata']['annotations'][k.UNCERTAIN]);self.assertEqual(len(pending['termination']),1)
  self.terminate(second)
  fresh=k.KubernetesAdapter(self.temp.name,self.a.client,self.s);fresh.restore(fresh.recovery_capture(),fresh.nonce)
  self.assertNotIn(('pod','storage-pod'),self.cluster.resources);self.assertNotIn(('pod','storage-second'),self.cluster.resources)
  self.assertNotIn(k.UNCERTAIN,self.cluster.resources['deployment','storage']['metadata']['annotations'])
 def test_immediate_gc_and_lost_finalizer_ack_recover_from_saved_exit_map(self):
  second=self.add_second_storage_pod();self.cluster.immediate_gc=True
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce);self.a.stop(v,self.a.nonce);self.terminate(second)
  self.cluster.lose_finalizer_ack='storage-pod'
  with self.assertRaisesRegex(c.RetirementError,'SERVICE_RESTORATION_REQUIRED'):self.a.restore(v,self.a.nonce)
  self.assertNotIn(('pod','storage-pod'),self.cluster.resources)
  pending=json.loads(self.cluster.resources['deployment','storage']['metadata']['annotations'][k.UNCERTAIN]);self.assertEqual(len(pending['termination']),2)
  fresh=k.KubernetesAdapter(self.temp.name,self.a.client,self.s);fresh.drain_saved_processes()
  self.assertNotIn(k.UNCERTAIN,self.cluster.resources['deployment','storage']['metadata']['annotations'])
 def test_restartable_container_termination_is_not_process_quiescence(self):
  v=self.a.capture(self.s);self.a.protect_pods(v,self.a.nonce)
  pod=self.cluster.resources['pod','storage-pod'];self.terminate(pod);del pod['metadata']['deletionTimestamp']
  self.assertIsNone(c.terminated_pod(v['pods']['storage'][0],pod,self.a.nonce))
 def test_alternate_public_storage_service_blocks_before_protection(self):
  other=copy.deepcopy(self.cluster.resources['service','storage']);other['metadata'].update(name='unreviewed',uid=str(uuid.uuid4()));other['spec']['type']='NodePort';other['spec']['ports'][0]['nodePort']=30000;self.cluster.resources['service','unreviewed']=other
  with self.assertRaisesRegex(c.RetirementError,'DIRECT_STORAGE_EXPOSURE'):self.a.capture(self.s)
  self.assertEqual(self.cluster.patched,0)
 def test_broadened_storage_network_policy_is_not_assumed_cluster_only(self):
  self.cluster.resources['networkpolicy','internal-services']['spec']['ingress']=[{}]
  with self.assertRaisesRegex(c.RetirementError,'NETWORK_BOUNDARY_CHANGED'):self.a.capture(self.s)
  self.assertEqual(self.cluster.patched,0)
if __name__=='__main__':unittest.main()
