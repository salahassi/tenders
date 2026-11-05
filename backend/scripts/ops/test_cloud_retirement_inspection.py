"""Fixed-origin read-only inspection and redaction, without cluster access."""
import base64
import copy
import json
import unittest
from unittest.mock import patch
import test_cloud_retirement as fixture

c=fixture.c;r=fixture.r
m=c.load('retirement_blocked_inspection',c.HERE/'inspect_blocked.py')

class Inspection(unittest.TestCase):
 def setUp(self):
  self.name='td-bootstrap-'+m.ORIGIN_RUN+'-1-abcdef12'
  self.labels={'app.kubernetes.io/managed-by':'tenderdesk-bootstrap','tenderdesk.io/run':self.name[len('td-bootstrap-'): ]}
  self.ns={'metadata':{'name':self.name,'uid':fixture.UUIDS[0],'labels':self.labels}}
  self.state={'source_revision':m.ORIGIN_SHA,'manifest_sha256':'a'*64,'bootstrap':{'namespace':self.name,'uid':fixture.UUIDS[0],'labels':self.labels},'resource_uids':{'secret/'+c.STATE_NAME:fixture.UUIDS[1],'deployment/storage':fixture.UUIDS[2]}}
  self.secret={'metadata':{'name':c.STATE_NAME,'namespace':self.name,'uid':fixture.UUIDS[1],'labels':{**self.labels,'tenderdesk.io/qualification':'storage-retirement'}}}
  self.manifest=patch.object(c,'manifest_contract',return_value='a'*64);self.manifest.start();self.addCleanup(self.manifest.stop)
 def secret_for(self,state):
  return {**self.secret,'data':{'state':base64.b64encode(json.dumps(state).encode()).decode()}}
 def test_exact_origin_namespace_and_durable_state_required(self):
  self.assertEqual(m.select_namespace([self.ns]),self.ns)
  self.assertEqual(m.bind_state(self.ns,self.secret_for(self.state)),self.state)
  for name in ('tenderdesk-dev',self.name.replace(m.ORIGIN_RUN,'41999178688'),self.name.replace('-1-','-2-')):
   other=copy.deepcopy(self.ns);other['metadata']['name']=name
   with self.assertRaises(c.FixtureError):m.select_namespace([other])
  with self.assertRaises(c.FixtureError):m.select_namespace([self.ns,self.ns])
 def test_changed_namespace_uid_source_manifest_and_journal_identity_fail_closed(self):
  for change in (lambda s:s.update(source_revision='b'*40),lambda s:s.update(manifest_sha256='b'*64),
   lambda s:s['bootstrap'].update(uid=fixture.UUIDS[3]),lambda s:s['resource_uids'].update({'secret/'+c.STATE_NAME:fixture.UUIDS[3]})):
   state=copy.deepcopy(self.state);change(state)
   with self.assertRaises(c.FixtureError):m.bind_state(self.ns,self.secret_for(state))
 def test_only_fixed_status_categories_and_sqlstates_leave_private_logs(self):
  status={'phase':'Running','containerStatuses':[{'ready':False,'state':{'waiting':{'reason':'CrashLoopBackOff','message':'private'}},'lastState':{'terminated':{'reason':'Error','exitCode':1,'message':'private'}}}]}
  events=[{'reason':'FailedMount','message':'private-volume permission denied'}]
  logs=json.dumps({'private_token':'secret','err':{'code':'42501','message':'private-role permission denied while migration'}})
  value=m.summarize(status,events,logs)
  self.assertEqual(value['sqlstates'],['42501']);self.assertEqual(value['log_categories'],['migration','permission_denied'])
  self.assertEqual(value['event_categories'],['permission_denied'])
  self.assertNotIn('private',json.dumps(value));self.assertNotIn('secret',json.dumps(value))
  self.assertEqual(m.summarize({'phase':'private'},[{'reason':'private','message':'private'}],'private')['phase'],'other')
 def test_observer_uses_only_get_and_logs_and_checks_controller_lineage(self):
  labels=self.secret['metadata']['labels']
  dep={'metadata':{'name':'storage','namespace':self.name,'uid':fixture.UUIDS[2],'labels':labels},'spec':{'selector':{'matchLabels':labels}}}
  rs={'metadata':{'namespace':self.name,'uid':fixture.UUIDS[3],'labels':labels,'ownerReferences':[{'uid':fixture.UUIDS[2],'controller':True}]}}
  pod={'metadata':{'name':'storage-pod','namespace':self.name,'uid':fixture.UUIDS[4],'labels':labels,'ownerReferences':[{'uid':fixture.UUIDS[3],'controller':True}]},'status':{'phase':'Pending'}}
  commands=[]
  def command(args,**kwargs):
   commands.append(args)
   if args[0]=='logs':return '{}'
   self.assertEqual(args[0],'get')
   value={'namespaces':{'items':[self.ns]},'namespace':self.ns,'secret':self.secret_for(self.state),'deployment':dep,'replicasets':{'items':[rs]},'pods':{'items':[pod]},'pod':pod,'events':{'items':[]}}[args[1]]
   return json.dumps(value)
  with patch.object(r,'command',side_effect=command):value=m.inspect()
  self.assertEqual((value['mutations'],value['pod_count']),(0,1))
  self.assertEqual({x[0] for x in commands},{'get','logs'})
  pod['metadata']['ownerReferences'][0]['uid']=fixture.UUIDS[5]
  with patch.object(r,'command',side_effect=command),self.assertRaises(c.FixtureError):m.inspect()

if __name__=='__main__':unittest.main()
