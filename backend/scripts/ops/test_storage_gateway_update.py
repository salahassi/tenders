import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
s=importlib.util.spec_from_file_location('tested_storage_gateway',Path(__file__).with_name('storage-gateway-update.py'));g=importlib.util.module_from_spec(s);s.loader.exec_module(g)
IMAGE='nginx@sha256:'+'a'*64

class Fake:
 NAMESPACE='tenderdesk-dev'
 renderer=type('Renderer',(),{'NGINX_IMAGE':IMAGE})()
 def __init__(self,before,after):
  self.before=before;self.after=after;self.calls=[];self.lose_ack=None
  def meta(name):return {'name':name,'namespace':self.NAMESPACE,'uid':name+'-synthetic','resourceVersion':'1','labels':{'app.kubernetes.io/managed-by':'tenderdesk-deployment'}}
  self.values={('configmap','gateway-config'):{'metadata':meta('gateway-config'),'data':before},('deployment','gateway'):{'metadata':meta('gateway'),'spec':{'replicas':1,'selector':{'matchLabels':{'app':'gateway'}},'template':{'metadata':{'annotations':{g.CHECKSUM:g.checksum(before)}},'spec':{'containers':[{'name':'gateway','image':IMAGE,'command':['nginx','-g','daemon off;'],'volumeMounts':[{'name':'config','mountPath':'/etc/nginx/nginx.conf','subPath':'nginx.conf','readOnly':True}]}],'volumes':[{'name':'config','configMap':{'name':'gateway-config'}}]}}}}}
 def get(self,kind,name):return copy.deepcopy(self.values[kind,name])
 def command(self,args,**_):
  self.calls.append(args)
  if args[0]=='patch':
   value=self.values[args[1],args[2]]
   for op in json.loads(args[-1]):
    keys=[x.replace('~1','/').replace('~0','~') for x in op['path'].strip('/').split('/')];parent=value
    for key in keys[:-1]:parent=parent[key]
    key=keys[-1]
    if op['op']=='test':assert parent[key]==op['value']
    else:parent[key]=copy.deepcopy(op['value'])
   value['metadata']['resourceVersion']=str(int(value['metadata']['resourceVersion'])+1)
   if self.lose_ack==args[1]:self.lose_ack=None;raise RuntimeError('LOST_ACK')
  elif args[0]=='get':
   dep=self.values['deployment','gateway'];return json.dumps({'items':[{'metadata':{'name':'gateway-test','labels':{'app':'gateway'},'annotations':copy.deepcopy(dep['spec']['template']['metadata']['annotations'])},'spec':dep['spec']['template']['spec'],'status':{'containerStatuses':[{'ready':True}]}}]})
  elif args[0]=='exec':return self.values['configmap','gateway-config']['data']['nginx.conf']
  elif args[0]!='rollout':raise AssertionError(args)
  return ''

class GatewayTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();root=Path(self.tmp.name)
  self.before=root/'before';self.after=root/'after';self.receipt=root/'receipt'
  # Deliberately synthetic strings. These test binding/rollout only, never claim
  # real Nginx routing qualification or commit a fake production receipt.
  self.before.write_text('synthetic old __NAMESPACE__');self.after.write_text('synthetic guarded __NAMESPACE__')
  self.r={'passed':True,'actual_binary_exercised':True,'signed_tus_bypass_confirmed':True,'gateway_resumable_denial_qualified':True,'gateway_image':IMAGE,'gateway_config_source_sha256':g.sha(self.after.read_bytes())};self.receipt.write_text(json.dumps(self.r))
  self.patches=[patch.object(g,'BASELINE',self.before),patch.object(g,'TARGET',self.after),patch.object(g,'QUALIFICATION',self.receipt),patch.object(g,'BASELINE_SHA256',g.sha(self.before.read_bytes()))]
  for p in self.patches:p.start()
  self.d=Fake({'nginx.conf':'synthetic old tenderdesk-dev'},{'nginx.conf':'synthetic guarded tenderdesk-dev'});self.contract,_,_=g.source_contract(self.d)
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.tmp.cleanup()
 def test_only_exact_config_and_checksum_change(self):
  original=copy.deepcopy(self.d.values);state=g.preflight(self.d,self.contract);g.apply(self.d,state)
  self.assertEqual(self.d.values['configmap','gateway-config']['data'],self.d.after)
  desired=copy.deepcopy(original['deployment','gateway']['spec']);desired['template']['metadata']['annotations'][g.CHECKSUM]=g.checksum(self.d.after)
  self.assertEqual(self.d.values['deployment','gateway']['spec'],desired)
  g.require_installed(self.d);g.require_restart_guard(self.d)
 def test_lost_config_or_deployment_ack_can_complete_forward(self):
  for boundary in ('configmap','deployment'):
   with self.subTest(boundary=boundary):
    self.d=Fake(self.d.before,self.d.after);state=g.preflight(self.d,self.contract);self.d.lose_ack=boundary
    with self.assertRaisesRegex(RuntimeError,'LOST_ACK'):g.apply(self.d,state)
    state=g.preflight(self.d,self.contract);g.apply(self.d,state);g.require_installed(self.d)
 def test_foreign_config_never_overwritten(self):
  self.d.values['configmap','gateway-config']['data']['private']='unexpected'
  with self.assertRaisesRegex(g.GatewayError,'CONFIG_CHANGED'):g.preflight(self.d,self.contract)
  self.assertEqual(self.d.calls,[])
 def test_source_and_receipt_drift_fail_before_mutation(self):
  self.after.write_text('different')
  with self.assertRaisesRegex(g.GatewayError,'QUALIFICATION_CHANGED'):g.preflight(self.d,self.contract)
  self.assertEqual(self.d.calls,[])
 def test_qualification_flags_must_be_true(self):
  for flag in ('passed','actual_binary_exercised','signed_tus_bypass_confirmed','gateway_resumable_denial_qualified'):
   r=copy.deepcopy(self.r);r[flag]=1;self.receipt.write_text(json.dumps(r))
   with self.subTest(flag=flag),self.assertRaisesRegex(g.GatewayError,'QUALIFICATION_REQUIRED'):g.source_contract(self.d)
 def test_changed_uid_or_spec_between_capture_and_patch_rejected(self):
  state=g.preflight(self.d,self.contract);self.d.values['deployment','gateway']['spec']['replicas']=2
  with self.assertRaisesRegex(g.GatewayError,'WORKLOAD_CHANGED'):g.apply(self.d,state)
  self.assertEqual(self.d.values['deployment','gateway']['spec']['replicas'],2)
 def test_current_pod_must_read_exact_guarded_bytes(self):
  state=g.preflight(self.d,self.contract);g.apply(self.d,state);original=self.d.command
  def command(args,**kw):return 'old pod mount' if args[0]=='exec' else original(args,**kw)
  self.d.command=command
  with self.assertRaisesRegex(g.GatewayError,'RUNNING_CONFIG_CHANGED'):g.verify(self.d,state,check_pods=True)
 def test_config_rollback_with_new_checksum_is_rejected(self):
  self.d.values['deployment','gateway']['spec']['template']['metadata']['annotations'][g.CHECKSUM]=g.checksum(self.d.after)
  with self.assertRaisesRegex(g.GatewayError,'TEMPLATE_CHANGED'):g.preflight(self.d,self.contract)
 def test_unqualified_route_cannot_be_restarted(self):
  with self.assertRaisesRegex(g.GatewayError,'RESTART_GUARD_REQUIRED'):g.require_restart_guard(self.d)
 def test_alternate_entrypoint_or_config_mount_is_rejected(self):
  for change in ({'command':['nginx','-c','/tmp/unreviewed']},{'args':['-c','/tmp/unreviewed']},{'volumeMounts':[]}):
   self.d=Fake(self.d.before,self.d.after);self.d.values['deployment','gateway']['spec']['template']['spec']['containers'][0].update(change)
   with self.subTest(change=change),self.assertRaises(g.GatewayError):g.preflight(self.d,self.contract)
   self.assertEqual(self.d.calls,[])
if __name__=='__main__':unittest.main()
