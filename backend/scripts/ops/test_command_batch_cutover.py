"""Actual coordinator control flow with immediate Pod GC and lost ACKs.

Synthetic API only; actual PostgreSQL visibility/lock proofs are separate.
"""
import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

def module(name,file):
 s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
c=module('cutover_test','command-batch-cutover.py');g=module('cutover_gateway_test','storage-gateway-update.py')
IMAGE='nginx@sha256:'+'a'*64
MARKER='2026-11-04T22:00:00.123456+00:00'

class Cluster:
 NAMESPACE='tenderdesk-dev'
 def __init__(self,count=2):
  self.values={};self.commands=[];self.lose_proof_ack=False;self.runtime_binding='true'
  def meta(name):return {'name':name,'namespace':self.NAMESPACE,'uid':str(uuid.uuid4()),'resourceVersion':'1','labels':{'app.kubernetes.io/managed-by':'tenderdesk-deployment'}}
  dep={'metadata':meta('gateway'),'spec':{'replicas':count,'selector':{'matchLabels':{'app':'gateway'}},'template':{'metadata':{'annotations':{g.CHECKSUM:'old'}},'spec':{'containers':[{'name':'gateway','image':IMAGE}]}}}}
  self.values['deployment','gateway']=dep
  self.values['configmap','gateway-config']={'metadata':meta('gateway-config'),'data':{'nginx.conf':'baseline'}}
  rs={'metadata':meta('gateway-rs')};rs['metadata']['ownerReferences']=[{'uid':dep['metadata']['uid'],'controller':True}];self.values['replicaset','gateway-rs']=rs
  for i in range(count):
   name='gateway-'+str(i);p={'metadata':meta(name),'spec':{'containers':[{'name':'gateway','image':IMAGE}]},'status':{'phase':'Running','containerStatuses':[{'name':'gateway','containerID':'containerd://'+str(i+1)*64,'ready':True,'state':{'running':{}}}]}}
   p['metadata']['labels']['app']='gateway';p['metadata']['annotations']={g.CHECKSUM:'old'};p['metadata']['ownerReferences']=[{'uid':rs['metadata']['uid'],'controller':True}];self.values['pod',name]=p
  self.state={'deployment':copy.deepcopy(dep),'before_data':{'nginx.conf':'baseline'},'contract':{'after_source_sha256':'b'*64,'before_data_sha256':'old','after_data_sha256':'new','gateway_image':IMAGE}}
 def get(self,kind,name):return copy.deepcopy(self.values.get((kind,name)))
 def command(self,args,**_):
  self.commands.append(args)
  if args[0]=='exec':return self.runtime_binding
  if args[0]=='get':
   kind={'pods':'pod','replicasets':'replicaset'}[args[1]]
   return json.dumps({'items':[v for (k,_),v in self.values.items() if k==kind]})
  assert args[0]=='patch';key=tuple(args[1:3]);value=self.values[key]
  for op in json.loads(args[-1]):
   parts=[x.replace('~1','/').replace('~0','~') for x in op['path'].strip('/').split('/')];parent=value
   for part in parts[:-1]:parent=parent[part]
   name=parts[-1]
   if op['op']=='test':assert parent[name]==op['value']
   elif op['op']=='remove':del parent[name]
   else:parent[name]=copy.deepcopy(op['value'])
  value['metadata']['resourceVersion']=str(int(value['metadata']['resourceVersion'])+1)
  if key[0]=='deployment' and self.lose_proof_ack and self.journal().get('termination'):
   self.lose_proof_ack=False;raise RuntimeError('LOST_PROOF_ACK')
  if key[0]=='pod' and value['metadata'].get('deletionTimestamp') and not value['metadata'].get('finalizers'):del self.values[key]
  return ''
 def journal(self):return json.loads(self.values['deployment','gateway']['metadata']['annotations'][c.JOURNAL])
 def terminate(self,index):
  p=self.values['pod','gateway-'+str(index)];p['metadata']['deletionTimestamp']='2026-11-04T22:00:00Z'
  p['status']['containerStatuses'][0]['state']={'terminated':{'exitCode':0,'finishedAt':'2026-11-04T22:00:01Z'}}

class GatewayDrainTests(unittest.TestCase):
 def setUp(self):self.d=Cluster();self.a=c.GatewayDrain(self.d,g,self.d.state)
 def test_complete_original_set_saved_before_any_finalizer_and_immediate_gc_safe(self):
  self.a.prepare();self.assertEqual(len(self.d.journal()['pods']),2)
  patches=[x for x in self.d.commands if x[0]=='patch'];self.assertEqual(patches[0][1],'deployment')
  self.d.terminate(0);self.d.terminate(1);self.a.after_rollout(timeout=0)
  self.assertEqual(len(self.d.journal()['termination']),2)
  self.assertFalse(any(k=='pod' for k,_ in self.d.values))
  # Forward retry uses durable proofs even though GC removed the Pod objects.
  fresh=c.GatewayDrain(self.d,g,self.d.state);fresh.prepare();fresh.after_rollout(timeout=0)
 def test_partial_exit_is_saved_but_no_identity_released_on_timeout(self):
  self.a.prepare();self.d.terminate(0)
  with self.assertRaisesRegex(c.CutoverError,'DRAIN_TIMEOUT'):self.a.after_rollout(timeout=0)
  self.assertEqual(len(self.d.journal()['termination']),1)
  for i in (0,1):self.assertEqual(self.d.values['pod','gateway-'+str(i)]['metadata']['finalizers'],[c.FINALIZER])
  self.d.terminate(1);c.GatewayDrain(self.d,g,self.d.state).after_rollout(timeout=0)
  self.assertEqual(len(self.d.journal()['termination']),2)
 def test_missing_unproved_process_never_becomes_empty_success(self):
  self.a.prepare();del self.d.values['pod','gateway-0']
  fresh=c.GatewayDrain(self.d,g,self.d.state)
  with self.assertRaisesRegex(c.CutoverError,'PROCESS_UNPROVEN'):fresh.prepare()
  with self.assertRaisesRegex(c.CutoverError,'PROCESS_UNPROVEN'):fresh.after_rollout(timeout=0)
  self.assertEqual(len(self.d.journal()['pods']),2)
 def test_lost_durable_exit_ack_replays_without_erasing_unproved_records(self):
  self.a.prepare();self.d.terminate(0);self.d.terminate(1);self.d.lose_proof_ack=True
  with self.assertRaisesRegex(RuntimeError,'LOST_PROOF_ACK'):self.a.after_rollout(timeout=0)
  self.assertEqual(len(self.d.journal()['termination']),2)
  self.assertTrue(all(self.d.values['pod','gateway-'+str(i)]['metadata'].get('finalizers') for i in (0,1)))
  c.GatewayDrain(self.d,g,self.d.state).after_rollout(timeout=0)
 def test_live_nondeleting_pod_with_previous_termination_cannot_release_identity(self):
  self.a.prepare()
  self.d.values['pod','gateway-0']['status']['containerStatuses'][0]['state']={'terminated':{'exitCode':0,'finishedAt':'2026-11-04T22:00:01Z'}}
  with self.assertRaisesRegex(c.CutoverError,'DRAIN_TIMEOUT'):self.a.after_rollout(timeout=0)
  self.assertEqual(self.d.journal()['termination'],{})
 def test_changed_container_or_foreign_lineage_refused(self):
  self.a.prepare();self.d.values['pod','gateway-0']['status']['containerStatuses'][0]['containerID']='containerd://'+'f'*64
  with self.assertRaisesRegex(c.CutoverError,'PROCESS_CHANGED'):self.a.after_rollout(timeout=0)
  d=Cluster();d.values['pod','gateway-0']['metadata']['ownerReferences'][0]['uid']=str(uuid.uuid4())
  with self.assertRaisesRegex(c.CutoverError,'LINEAGE_INVALID'):c.GatewayDrain(d,g,d.state).prepare()
  self.assertFalse(any(x[0]=='patch' for x in d.commands))
 def test_changed_target_or_corrupt_journal_never_adopts_old_operation(self):
  self.a.prepare();state=copy.deepcopy(self.d.state);state['contract']['after_source_sha256']='f'*64
  with self.assertRaisesRegex(c.CutoverError,'JOURNAL_INVALID'):c.GatewayDrain(self.d,g,state).prepare()
 def test_missing_journal_target_and_partial_target_cannot_infer_old_process_exit(self):
  for config_target,template_target in [(True,False),(True,True),(False,True)]:
   d=Cluster()
   if config_target:d.values['configmap','gateway-config']['data']={'nginx.conf':'target'}
   if template_target:d.values['deployment','gateway']['spec']['template']['metadata']['annotations'][g.CHECKSUM]='new'
   with self.subTest(config_target=config_target,template_target=template_target),self.assertRaisesRegex(c.CutoverError,'ORIGINAL_JOURNAL_REQUIRED'):
    c.GatewayDrain(d,g,d.state).prepare()
   self.assertFalse(any(x[0]=='patch' for x in d.commands))
 def test_concurrent_new_journal_identity_is_never_overwritten_by_exit_proof(self):
  self.a.prepare();self.d.terminate(0);self.d.terminate(1);original_get=self.d.get;changed=False
  def get(kind,name):
   nonlocal changed
   result=original_get(kind,name)
   if kind=='pod' and not changed:
    changed=True;v=self.d.journal();v['pods'].append({'name':'gateway-unobserved','uid':str(uuid.uuid4()),'container_id':'containerd://'+'e'*64})
    self.d.values['deployment','gateway']['metadata']['annotations'][c.JOURNAL]=c.canonical(v)
   return result
  with patch.object(self.d,'get',side_effect=get),self.assertRaisesRegex(c.CutoverError,'JOURNAL_CHANGED'):self.a.after_rollout(timeout=0)
  self.assertEqual(len(self.d.journal()['pods']),3)
  self.assertTrue(all(self.d.values['pod','gateway-'+str(i)]['metadata'].get('finalizers') for i in (0,1)))

class BindingTests(unittest.TestCase):
 def fixture(self):
  d=Cluster(1);dep=d.values.pop(('deployment','gateway'));dep['metadata']['name']='api';dep['spec']['selector']['matchLabels']={'app':'api'}
  env=[{'name':'SUPABASE_URL','value':'http://gateway:8081'},{'name':'APP_RUNTIME_SERVICE','value':'api'}]
  dep['spec']['template']['spec']['containers']=[{'name':'api','env':env}]
  p=d.values['pod','gateway-0'];p['metadata']['labels']['app']='api';p['spec']['containers']=copy.deepcopy(dep['spec']['template']['spec']['containers'])
  return d,dep
 def test_only_exact_live_gateway_binding_is_accepted(self):
  d,dep=self.fixture();self.assertTrue(c.api_gateway_binding(d,dep)['runtime_values_verified'])
  command=next(x for x in d.commands if x[0]=='exec');self.assertEqual(command[5:7],['/bin/sh','-c'])
  self.assertNotIn('printenv',command[-1]);self.assertNotIn('/bin/deno',command)
  d.runtime_binding='false'
  with self.assertRaisesRegex(c.CutoverError,'BINDING_INVALID'):c.api_gateway_binding(d,dep)
 def test_duplicate_dynamic_and_direct_rest_overrides_refused(self):
  for change in ([{'name':'SUPABASE_URL','value':'http://rest:3000'}],
    [{'name':'SUPABASE_URL','valueFrom':{'secretKeyRef':{'name':'private','key':'url'}}}],
    [{'name':'SUPABASE_URL','value':'http://gateway:8081'}]*2):
   d,dep=self.fixture();dep['spec']['template']['spec']['containers'][0]['env']=change
   with self.assertRaisesRegex(c.CutoverError,'BINDING_INVALID'):c.api_gateway_binding(d,dep)

class TransactionDrainTests(unittest.TestCase):
 def test_marker_is_retained_until_old_idle_transaction_settles(self):
  calls=[];remaining=iter([2,1,0])
  def sql(_pod,text):calls.append(text);return json.dumps({'marker':MARKER,'visibility_verified':True,'old_transactions':next(remaining)})
  with patch.object(c.time,'sleep'):
   result=c.drain_transactions(SimpleNamespace(sql=sql),SimpleNamespace(pod='synthetic'))
  self.assertEqual(result['initial_old_transactions'],2);self.assertEqual(result['sessions_terminated'],0)
  self.assertTrue(all(MARKER in text for text in calls[1:]));self.assertFalse(result['direct_namespace_rest_admission_fenced'])
  self.assertNotIn('pg_terminate_backend',''.join(calls));self.assertNotIn('pg_cancel_backend',''.join(calls))
 def test_unknown_or_hidden_visibility_cannot_be_zero_success(self):
  for value in ({'marker':MARKER,'visibility_verified':False,'old_transactions':0},
    {'marker':MARKER,'visibility_verified':True,'old_transactions':None},
    {'marker':MARKER,'visibility_verified':True,'old_transactions':False}):
   d=SimpleNamespace(sql=lambda *_:json.dumps(value))
   with self.assertRaises(c.CutoverError):c.drain_transactions(d,SimpleNamespace(pod='synthetic'))
 def test_unsettled_transaction_times_out_without_termination(self):
  d=SimpleNamespace(sql=lambda *_:json.dumps({'marker':MARKER,'visibility_verified':True,'old_transactions':1}))
  with self.assertRaisesRegex(c.CutoverError,'DRAIN_TIMEOUT'):c.drain_transactions(d,SimpleNamespace(pod='synthetic'),timeout=0)
 def test_marker_drift_and_sql_error_never_report_settlement(self):
  responses=iter([{'marker':MARKER,'visibility_verified':True,'old_transactions':1},{'marker':MARKER.replace('123456','123457'),'visibility_verified':True,'old_transactions':0}])
  with patch.object(c.time,'sleep'),self.assertRaisesRegex(c.CutoverError,'MARKER_CHANGED'):
   c.drain_transactions(SimpleNamespace(sql=lambda *_:json.dumps(next(responses))),SimpleNamespace(pod='synthetic'))
  def broken(*_):raise RuntimeError('SQL unavailable')
  with self.assertRaises(RuntimeError):c.drain_transactions(SimpleNamespace(sql=broken),SimpleNamespace(pod='synthetic'))

if __name__=='__main__':unittest.main()
