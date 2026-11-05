"""Fixture authority and crash-recovery guards; these are not hosted PVC proof."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE/'cloud-retirement'))
import contract as c
import resources as r
import fixture_adapter as a

ENV={'GITHUB_SHA':'a'*40,'GITHUB_RUN_ID':'12345678','GITHUB_RUN_ATTEMPT':'1'}
UUIDS=['00000000-0000-4000-8000-'+str(n).zfill(12) for n in range(1,40)]
CID='containerd://'+'a'*64

class Guards(unittest.TestCase):
 def setUp(self):
  self.env=patch.dict(os.environ,ENV);self.env.start();self.addCleanup(self.env.stop)
  base=c.bootstrap.identity();base['uid']=UUIDS[0]
  self.state=c.initial_state(base,'b'*64)
  self.state['fixture']={'actor_id':UUIDS[1],'workspace_id':UUIDS[2],
   'selection':[{'id':UUIDS[3],'storage_key':UUIDS[2]+'/exports/test.docx','retirement_nonce':UUIDS[4],'revision':2}],
   'expected_hash':'d'*64,'expected_size':16384}
 def resource(self,kind,name,spec):
  uid=UUIDS[len(self.state['resource_uids'])+5];self.state['resource_uids'][kind+'/'+name]=uid
  return {'metadata':{'name':name,'namespace':c.namespace(self.state),'uid':uid,'resourceVersion':'10','labels':c.labels(self.state)},'spec':spec}
 def test_scope_rejects_production_namespace_and_database(self):
  for key,value in [('namespace','tenderdesk-dev'),('database','tenderdesk_app')]:
   with self.subTest(key=key):
    state=copy.deepcopy(self.state);state['bootstrap'][key]=value
    with self.assertRaises(Exception):c.validate_state(state)
 def test_rejects_foreign_run_and_revision_on_resume(self):
  for updates in ({'GITHUB_RUN_ID':'12345679'},{'GITHUB_SHA':'c'*40}):
   with patch.dict(os.environ,updates),self.assertRaises(Exception):c.validate_state(self.state)
 def test_owned_cannot_adopt_replacement_or_foreign_label(self):
  actual=self.resource('pod','client',{})
  for mutation in ('uid','label','namespace'):
   wrong=copy.deepcopy(actual)
   if mutation=='uid':wrong['metadata']['uid']=UUIDS[30]
   elif mutation=='label':wrong['metadata']['labels']['tenderdesk.io/qualification']='foreign'
   else:wrong['metadata']['namespace']='tenderdesk-dev'
   with self.subTest(mutation=mutation),self.assertRaises(c.FixtureError):c.owned(self.state,'pod','client',wrong)
 def test_mutation_binds_uid_and_resource_version(self):
  actual=self.resource('deployment','worker',{'replicas':1})
  with patch.object(r,'namespace_guard'),patch.object(r,'command') as command:
   r.patch(self.state,'deployment','worker',actual,[{'op':'replace','path':'/spec/replicas','value':0}])
  args=command.call_args.args[0];body=json.loads(args[-1])
  self.assertEqual(body[:2],[{'op':'test','path':'/metadata/uid','value':actual['metadata']['uid']},{'op':'test','path':'/metadata/resourceVersion','value':'10'}])
  self.assertIn(c.namespace(self.state),args)
 def test_sql_uses_database_comment_before_nonce_owner(self):
  with patch.object(r,'get'),patch.object(r,'command',return_value='{}') as command:r.sql(self.state,'select 1')
  sql=command.call_args.kwargs['payload']
  self.assertTrue(sql.startswith('BEGIN ISOLATION LEVEL REPEATABLE READ;'))
  self.assertIn(c.database_comment(self.state),sql)
  self.assertLess(sql.index('RETIREMENT_FIXTURE_DATABASE_MISMATCH'),sql.index('SET LOCAL ROLE'))
  self.assertNotIn('tdp_app_owner',sql)
 def test_nonce_loader_rejects_raw_target_inputs(self):
  for nonce in ('tenderdesk-dev','../../secret','abc12345;drop','A'*8,'0'*9):
   with self.subTest(nonce=nonce),patch.object(r,'command') as command,self.assertRaises(c.FixtureError):r.load(nonce)
   command.assert_not_called()
 def test_public_receipt_rejects_private_values_or_fabricated_target(self):
  with self.assertRaises(c.FixtureError):c.public_receipt(self.state,{'key':self.state['fixture']['selection'][0]['storage_key']},{},cleaned=True)
  receipt=c.public_receipt(self.state,{'proved':True},{'resume_seconds':1.2},cleaned=True)
  self.assertFalse(receipt['production_fixed_target_adapter_exercised'])
  self.assertFalse(receipt['whole_cluster_restore_qualified'])
  self.assertFalse(receipt['rto_rpo_target_defined'])
  self.assertFalse(c.public_receipt(self.state,{'proved':True},{},cleaned=False)['passed'])

class Journals(unittest.TestCase):
 setUp=Guards.setUp
 resource=Guards.resource
 def setup_capture(self):
  dep=self.resource('deployment','worker',{'replicas':1})
  pod={'metadata':{'name':'worker-original','namespace':c.namespace(self.state),'uid':UUIDS[27],'resourceVersion':'20','labels':c.labels(self.state),'annotations':{c.proof.ANNOTATION:self.state['operation_nonce']},'finalizers':[c.proof.FINALIZER],'deletionTimestamp':'2026-11-05T00:00:02Z'},
   'spec':{'containers':[{'name':'worker','image':r.containers.PROBE_IMAGE}]},
   'status':{'phase':'Failed','containerStatuses':[{'name':'worker','containerID':CID,'state':{'terminated':{'containerID':CID,'exitCode':143,'reason':'Error','startedAt':'2026-11-05T00:00:00Z','finishedAt':'2026-11-05T00:00:03Z'}}}]}}
  old=copy.deepcopy(pod);old['metadata'].pop('deletionTimestamp');old['status']['containerStatuses'][0]['state']={'running':{'startedAt':'2026-11-05T00:00:00Z'}}
  identity=c.proof.pod_identity(old);journal={'nonce':self.state['operation_nonce'],'pods':[identity],'termination':{}}
  dep['metadata']['annotations']={a.UNCERTAIN:c.canonical(journal)}
  capture={'workloads':{'worker':dep},'pods':{'worker':[old]}}
  return a.FixtureAdapter(self.state),capture,dep,pod
 def test_missing_original_pod_never_becomes_exit_proof(self):
  adapter,capture,dep,pod=self.setup_capture()
  with patch.object(r,'get',return_value=dep),patch.object(adapter,'pod',return_value=None),patch.object(r,'patch') as mutate,patch.object(adapter,'patch_pod') as release:
   self.assertFalse(adapter.save_terminations(capture,'worker',adapter.nonce))
  mutate.assert_not_called();release.assert_not_called()
 def test_restarted_container_cannot_replace_captured_identity(self):
  adapter,capture,dep,pod=self.setup_capture();pod['status']['containerStatuses'][0]['containerID']='containerd://'+'b'*64
  with patch.object(r,'get',return_value=dep),patch.object(adapter,'pod',return_value=pod),patch.object(adapter,'patch_pod') as release,self.assertRaises(c.proof.RetirementError):adapter.save_terminations(capture,'worker',adapter.nonce)
  release.assert_not_called()
 def test_node_lost_is_not_real_exit(self):
  adapter,capture,dep,pod=self.setup_capture();pod['status']['reason']='NodeLost'
  with patch.object(r,'get',return_value=dep),patch.object(adapter,'pod',return_value=pod),patch.object(adapter,'patch_pod') as release,self.assertRaises(c.proof.RetirementError):adapter.save_terminations(capture,'worker',adapter.nonce)
  release.assert_not_called()
 def test_exact_exit_durably_read_back_before_finalizer_removal(self):
  adapter,capture,dep,pod=self.setup_capture();events=[]
  def get(*args,**kwargs):events.append('read');return copy.deepcopy(dep)
  def mutate(state,kind,name,old,ops):
   events.append('journal');dep['metadata']['annotations'][a.UNCERTAIN]=ops[-1]['value']
  def release(*args):
   events.append('release');journal=json.loads(dep['metadata']['annotations'][a.UNCERTAIN]);self.assertEqual(journal['termination'][pod['metadata']['uid']]['containers'][0]['container_id'],CID)
  with patch.object(r,'get',side_effect=get),patch.object(r,'patch',side_effect=mutate),patch.object(adapter,'pod',return_value=pod),patch.object(adapter,'patch_pod',side_effect=release):
   self.assertTrue(adapter.save_terminations(capture,'worker',adapter.nonce))
  self.assertEqual(events,['read','journal','read','release'])
 def test_lost_journal_ack_cannot_release_finalizer(self):
  adapter,capture,dep,pod=self.setup_capture()
  with patch.object(r,'get',return_value=copy.deepcopy(dep)),patch.object(r,'patch'),patch.object(adapter,'pod',return_value=pod),patch.object(adapter,'patch_pod') as release,self.assertRaises(c.FixtureError):adapter.save_terminations(capture,'worker',adapter.nonce)
  release.assert_not_called()
 def test_durable_saved_exit_allows_already_garbage_collected_original(self):
  adapter,capture,dep,pod=self.setup_capture();journal=json.loads(dep['metadata']['annotations'][a.UNCERTAIN])
  journal['termination'][pod['metadata']['uid']]=c.proof.terminated_pod(capture['pods']['worker'][0],pod,adapter.nonce)
  dep['metadata']['annotations'][a.UNCERTAIN]=c.canonical(journal)
  with patch.object(r,'get',return_value=dep),patch.object(adapter,'pod',return_value=None),patch.object(adapter,'patch_pod') as release:
   self.assertTrue(adapter.save_terminations(capture,'worker',adapter.nonce))
  release.assert_not_called()

class Network(unittest.TestCase):
 def fixture(self):
  egress=[{'to':[{'podSelector':{}}]},{'to':[{'namespaceSelector':{'matchLabels':{'kubernetes.io/metadata.name':'kube-system'}}}],'ports':[{'protocol':'UDP','port':53},{'protocol':'TCP','port':53}]},{'to':[{'ipBlock':{'cidr':'10.10.0.1/32'}}],'ports':[{'protocol':'TCP','port':25060}]}]
  return [{'metadata':{'name':'private-fixture'},'spec':{'podSelector':{'matchExpressions':[{'key':'tenderdesk.io/fixture-workload','operator':'NotIn','values':['storage']}]},'policyTypes':['Ingress','Egress'],'ingress':[{'from':[{'podSelector':{}}]}],'egress':egress}}, {'metadata':{'name':'storage-gateway-only'},'spec':{'podSelector':{'matchLabels':{'tenderdesk.io/fixture-workload':'storage'}},'policyTypes':['Ingress','Egress'],'ingress':[{'from':[{'podSelector':{'matchLabels':{'tenderdesk.io/fixture-workload':'gateway'}}}],'ports':[{'protocol':'TCP','port':5000}]}],'egress':copy.deepcopy(egress)}}]
 def test_exact_internal_boundary(self):a.validate_network(self.fixture())
 def test_broader_storage_ingress_or_database_egress_rejected(self):
  for mutate in (lambda p:p[1]['spec']['ingress'][0].update({'from':[{'podSelector':{}}]}),lambda p:p[0]['spec']['egress'][2]['to'][0]['ipBlock'].update(cidr='0.0.0.0/0'),lambda p:p.append(copy.deepcopy(p[0]))):
   policies=self.fixture();mutate(policies)
   with self.assertRaises(c.FixtureError):a.validate_network(policies)

class Resume(unittest.TestCase):
 setUp=Guards.setUp
 resource=Guards.resource
 def fixture(self):
  adapter=a.FixtureAdapter(self.state);adapter.validate_binary(c.proof.digest(a.BINARY.read_bytes()))
  capture={'selection':None,'workloads':{},'pods':{},'pvc':self.resource('persistentvolumeclaim',c.PVC_NAME,{}),
   'gateway':self.resource('configmap','gateway-config',{}),'policies':[],'storage_configuration':{}}
  capture['gateway']['data']=adapter.gateway_data
  expected={}
  for name,image in [('worker',r.containers.PROBE_IMAGE),('gateway',r.renderer.NGINX_IMAGE),('storage',c.proof.STORAGE_IMAGE)]:
   containers=[{'name':name,'image':image}];dep=self.resource('deployment',name,{'replicas':1,'template':{'spec':{'containers':containers}},'selector':{'matchLabels':{'workload':name}}})
   capture['workloads'][name]=dep
   capture['pods'][name]=[{'metadata':{'name':name+'-old','namespace':c.namespace(self.state),'uid':UUIDS[26+len(expected)],'labels':c.labels(self.state)},'spec':{'containers':copy.deepcopy(containers)},'status':{'containerStatuses':[{'name':name,'containerID':CID}]}}]
   expected[name]={'uid':dep['metadata']['uid'],'image':image,'replicas':1}
  for policy in Network().fixture():
   owned=self.resource('networkpolicy',policy['metadata']['name'],policy['spec']);capture['policies'].append(owned)
  selection={'version':1,'operation_nonce':self.state['operation_nonce'],'actor_id':self.state['fixture']['actor_id'],'selection':self.state['fixture']['selection'],'namespace_uid':self.state['bootstrap']['uid'],'expected_workloads':expected,'binary_receipt_sha256':c.proof.digest(a.BINARY.read_bytes())}
  capture['selection']=selection;self.state['process_capture']=capture;self.state['phase']='interrupted';adapter.capture_value=capture
  return adapter,capture,selection
 def test_fresh_adapter_uses_durable_original_not_current_replacement(self):
  adapter,capture,selection=self.fixture();fresh=a.FixtureAdapter(copy.deepcopy(self.state));fresh.validate_binary(selection['binary_receipt_sha256'])
  with patch.object(r,'namespace_guard'),patch.object(fresh,'items',side_effect=AssertionError('must not recapture current containers')):
   result=fresh.capture(selection)
  self.assertEqual(result,capture)
  self.assertEqual(c.proof.container_identities(result['pods']['worker'][0])[0]['container_id'],CID)
 def test_new_pod_while_scaled_down_rejected(self):
  adapter,capture,selection=self.fixture();current=copy.deepcopy(capture['workloads']['worker']);current['spec']['replicas']=0
  current['metadata']['annotations']={c.proof.ANNOTATION:a.marker(capture['workloads']['worker'],adapter.nonce)}
  replacement={'metadata':{'uid':UUIDS[35],'labels':{'workload':'worker'}}}
  with patch.object(r,'get',return_value=current),patch.object(adapter,'items',return_value=[replacement]),self.assertRaises(c.FixtureError):adapter.assert_stopped(capture,'worker',adapter.nonce)
 def test_interruption_only_after_all_scale_zero_and_durable_readback(self):
  adapter,capture,selection=self.fixture();adapter.interrupt=True;self.state['completion']={'before':{'pending':10485760}}
  deps=copy.deepcopy(capture['workloads']);events=[]
  def get(state,kind,name):return copy.deepcopy(deps[name])
  def mutate(state,kind,name,current,ops):
   for op in ops:
    if op['path']=='/spec/replicas':deps[name]['spec']['replicas']=op['value']
    elif op['path'].endswith(r.pointer(c.proof.ANNOTATION)):deps[name]['metadata'].setdefault('annotations',{})[c.proof.ANNOTATION]=op['value']
   events.append('stop:'+name)
  def save(state):
   self.assertTrue(all(dep['spec']['replicas']==0 for dep in deps.values()));events.append('durable:'+state['phase'])
  def terminate(code):events.append('exit:'+str(code));raise SystemExit(code)
  with patch.object(r,'get',side_effect=get),patch.object(r,'patch',side_effect=mutate),patch.object(r,'save',side_effect=save),patch.object(adapter,'assert_boundary'),patch.object(adapter,'items',return_value=[]),patch.object(adapter,'assert_uncertain',return_value={'pending':10485760}),patch.object(a.os,'_exit',side_effect=terminate),self.assertRaises(SystemExit) as ended:adapter.stop(capture,adapter.nonce)
  self.assertEqual(ended.exception.code,86)
  self.assertEqual(events,['stop:worker','stop:gateway','stop:storage','durable:interrupted','exit:86'])
 def test_only_trusted_prior_attempt_can_select_existing_fixture(self):
  with patch.dict(os.environ,{'GITHUB_RUN_ATTEMPT':'2','RETIREMENT_FIXTURE_ORIGIN_ATTEMPT':'1'}):
   self.assertIs(c.validate_state(self.state),self.state)
   self.assertEqual(os.environ['GITHUB_RUN_ATTEMPT'],'2')
  for origin in ('3','0','01','-1','1;drop'):
   with patch.dict(os.environ,{'GITHUB_RUN_ATTEMPT':'2','RETIREMENT_FIXTURE_ORIGIN_ATTEMPT':origin}),self.assertRaises(c.FixtureError):c.validate_state(self.state)

class PhysicalProcess(unittest.TestCase):
 setUp=Guards.setUp
 resource=Guards.resource
 def fixture(self):
  security={'runAsNonRoot':True,'runAsUser':1000};container_security={'allowPrivilegeEscalation':False}
  source={'spec':{'nodeName':'fixture-node','securityContext':security,'containers':[{'securityContext':container_security}]}}
  self.state['process_capture']={'pods':{'storage':[source]}}
  pod=self.resource('pod',r.PHYSICAL,{'nodeName':'fixture-node','restartPolicy':'Never','automountServiceAccountToken':False,'securityContext':security,
   'containers':[{'name':'physical','image':c.proof.STORAGE_IMAGE,'command':['node','-e','setTimeout(()=>{},1100000)'],'securityContext':container_security,
    'volumeMounts':[{'name':'objects','mountPath':'/var/lib/storage'},{'name':'work','mountPath':'/run/storage-retirement'}]}],
   'volumes':[{'name':'objects','persistentVolumeClaim':{'claimName':c.PVC_NAME}},{'name':'work','emptyDir':{'sizeLimit':'2Mi'}}]})
  pod['status']={'containerStatuses':[{'name':'physical','containerID':CID}]}
  return a.FixtureAdapter(self.state),pod
 def test_exact_helper_process_and_mount(self):
  adapter,pod=self.fixture();adapter.validate_physical_pod(pod)
 def test_same_uid_extra_process_or_changed_mount_rejected(self):
  for mutate in (lambda p:p['spec'].update(ephemeralContainers=[{'name':'debug'}]),lambda p:p['spec']['containers'][0].update(command=['sh']),lambda p:p['spec']['volumes'][0]['persistentVolumeClaim'].update(claimName='private-objects')):
   adapter,pod=self.fixture();mutate(pod)
   with self.assertRaises(c.FixtureError):adapter.validate_physical_pod(pod)
 def test_already_removed_helper_does_not_fail_owned_cleanup(self):
  adapter,pod=self.fixture();capture={'pods':{},'workloads':{}}
  for name in c.proof.NAMES:capture['workloads'][name]=self.resource('deployment',name,{'replicas':1})
  def get(state,kind,name,**kwargs):return None if kind=='pod' else capture['workloads'][name]
  with patch.object(r,'get',side_effect=get),patch.object(r,'patch'),patch.object(r,'command') as command,patch.object(r,'wait_deployment'),patch.object(adapter,'assert_boundary'),patch.object(adapter,'save_terminations',return_value=True):adapter.restore(capture,adapter.nonce)
  command.assert_not_called()

if __name__=='__main__':unittest.main()
