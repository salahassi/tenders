"""Fault injection at actual release boundaries; never contacts Kubernetes."""
import copy
from contextlib import ExitStack,contextmanager,redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('tested_delivery_update',Path(__file__).with_name('proposal-delivery-update.py'))
p=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=p;SPEC.loader.exec_module(p)
REGISTRY=p.u.REGISTRY
BASE=REGISTRY+'runtime@sha256:'+'a'*64
SELECTED={name:REGISTRY+name+'@sha256:'+'b'*64 for name in ('runtime','frontend','ocr')}

def cron(name):
 return {'metadata':{'name':'native-'+name,'namespace':p.d.NAMESPACE,'uid':'native-'+name,'resourceVersion':'1','generation':1,'labels':{'app.kubernetes.io/managed-by':'tenderdesk-deployment'}},
  'spec':{'schedule':'*/10 * * * *','concurrencyPolicy':'Forbid','suspend':False,'jobTemplate':{'spec':{'activeDeadlineSeconds':600,'backoffLimit':0,
  'template':{'spec':{'containers':[{'name':name,'image':REGISTRY+name+'@sha256:'+'a'*64,'resources':{'requests':{'cpu':'100m','memory':'256Mi'},'limits':{'cpu':'1000m','memory':'768Mi'}}}]}}}}}}

class DeliveryUpdateTests(unittest.TestCase):
 @contextmanager
 def fixture(self,fail=None,on_public=None):
  events=[];deployments={}
  for name in p.inventory.NAMES:
   deployments[name]={'metadata':{'uid':name+'-uid','name':name,'resourceVersion':'1','annotations':{}},'spec':{'replicas':1,'strategy':copy.deepcopy(p.code.WORKER_STRATEGY),
    'template':{'spec':{'terminationGracePeriodSeconds':240,'containers':[{'name':name,'image':REGISTRY+'frontend@sha256:'+'a'*64 if name=='frontend' else BASE}]}}}}
  natives={name:cron(name.removeprefix('native-')) for name in ('native-browser','native-ocr')}
  manifest={'executor_max':4,'baseline_images':{name:p.image_of(v) for name,v in deployments.items()},'baseline_native_schedules':p.inventory.public_schedules(list(natives.values()))}
  def stage(name):
   events.append(name)
   if name==fail:raise RuntimeError('PRIVATE_FAILURE_PAYLOAD')
  def snapshot():return {name:{'uid':v['metadata']['uid'],'spec':copy.deepcopy(v['spec'])} for name,v in deployments.items()}
  def retained():return {'configuration':{'fixed':True},'secrets':{'private':'not printed'},'schedules':{name:copy.deepcopy(v['spec']) for name,v in natives.items()}}
  def command(args,**kwargs):
   self.assertEqual(args[0],'patch');kind,name=args[1:3];value=natives[name] if kind=='cronjob' else deployments[name]
   operations=json.loads(args[-1]);stage(name+'-patch')
   for operation in operations:
    parts=[part.replace('~1','/').replace('~0','~') for part in operation['path'].strip('/').split('/')];current=value
    for key in parts[:-1]:current=current[int(key)] if isinstance(current,list) else current[key]
    key=int(parts[-1]) if isinstance(current,list) else parts[-1]
    if operation['op']=='test':self.assertEqual(current[key],operation['value'])
    elif operation['op']=='remove':current.pop(key)
    else:current[key]=operation['value']
   value['metadata']['resourceVersion']=str(int(value['metadata']['resourceVersion'])+1)
  def public(_):
   stage('public')
   if on_public:on_public(deployments,natives)
  receipt={'release':p.release.RELEASE,'manifest_sha256':p.release.digest(p.release.canonical(manifest).encode()),'catalog_sha256':'c'*64,'replayed':False}
  calls=0
  def sql(*_args):
   nonlocal calls
   stage('schema' if calls==0 else 'schema-recheck');calls+=1
   return json.dumps({**receipt,'replayed':calls>1})
  with tempfile.TemporaryDirectory() as directory,ExitStack() as stack:
   path=Path(directory)/'manifest.json';path.write_text(json.dumps(manifest))
   stack.enter_context(patch.dict(os.environ,{'GITHUB_SHA':'e'*40,'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','RUNNER_TEMP':directory,'DOKS_WORKDIR':directory+'/td-deploy-123-1',**{'TENDERDESK_'+n.upper()+'_IMAGE':v for n,v in SELECTED.items()}}))
   Path(os.environ['DOKS_WORKDIR']).mkdir(mode=0o700)
   stack.enter_context(patch.object(p.release,'MANIFEST',path));stack.enter_context(patch.object(p.release,'verify_source'));stack.enter_context(patch.object(p.release,'migration_script',return_value='reviewed fixture SQL'))
   stack.enter_context(patch.object(p.images,'verify_checkout'));stack.enter_context(patch.object(p.images,'inspect',side_effect=lambda ref,_revision,_name:ref));stack.enter_context(patch.object(p.d.probe,'validate_cluster'))
   stack.enter_context(patch.object(p.u,'deployment',side_effect=lambda name,**_:copy.deepcopy(deployments[name])))
   stack.enter_context(patch.object(p.runtime,'workload_snapshot',side_effect=snapshot));stack.enter_context(patch.object(p.runtime,'retained_configuration',side_effect=retained))
   stack.enter_context(patch.object(p.u,'owned',side_effect=lambda kind,name:copy.deepcopy(natives[name]) if kind=='cronjob' else {'data':{}}))
   stack.enter_context(patch.object(p.d,'command',side_effect=command));stack.enter_context(patch.object(p.d,'wait_deployments',side_effect=lambda names:stage(names[0]+'-ready')))
   stack.enter_context(patch.object(p,'wait_drain',side_effect=lambda name,_image:stage(name+'-drained')))
   stack.enter_context(patch.object(p.code,'public_check',side_effect=public));stack.enter_context(patch.object(p.d,'sql',side_effect=sql))
   client=stack.enter_context(patch.object(p.inventory.observer,'Client'));client.return_value.labels={};client.return_value.prepare.side_effect=lambda:stage('client');client.return_value.cleanup.side_effect=lambda:stage('cleanup')
   stack.enter_context(patch.object(p,'save_client'));emitted=stack.enter_context(patch.object(p,'emit'))
   yield deployments,natives,events,emitted

 def test_atomic_schema_then_old_worker_drain_then_api_gateway_native_frontend(self):
  with self.fixture() as (state,native,events,emit):
   p.update()
   self.assertLess(events.index('schema'),events.index('worker-patch'))
   self.assertLess(events.index('worker-drained'),events.index('api-patch'))
   self.assertLess(events.index('source-browser-drained'),events.index('native-ocr-patch'))
   self.assertLess(events.index('native-ocr-patch'),events.index('frontend-patch'))
   self.assertEqual(events[-1],'cleanup');self.assertEqual(emit.call_args.args[0],'passed')
   self.assertEqual(state['worker']['spec']['strategy'],p.code.WORKER_STRATEGY)
   self.assertNotIn(p.MARKER,state['worker']['metadata']['annotations'])
   self.assertFalse(emit.call_args.kwargs['processing_retried']);self.assertFalse(emit.call_args.kwargs['hosted_artifact_acceptance'])

 def test_each_failure_cleans_and_never_rolls_images_back_or_claims_success(self):
  for failure in ('client','schema','worker-patch','worker-drained','api-patch','source-browser-patch','native-ocr-patch','frontend-patch','public','schema-recheck','cleanup'):
   with self.subTest(failure=failure),self.fixture(failure) as (state,natives,events,emit):
    with self.assertRaises(Exception):p.update()
    self.assertEqual(events[-1],'cleanup')
    self.assertFalse(any(c.args[0]=='passed' for c in emit.call_args_list))
    if 'api-patch' in events and failure!='api-patch':self.assertEqual(p.image_of(state['api']),SELECTED['runtime'])
    if 'worker-drained' in events and failure!='worker-patch':self.assertEqual(p.image_of(state['worker']),SELECTED['runtime'])

 def test_catalog_or_role_changes_cannot_be_hidden_by_public_success(self):
  for mutate in (lambda state,native:state['api']['spec'].update(replicas=2),lambda state,native:state['auth']['spec'].update(replicas=2),lambda state,native:native['native-ocr']['spec'].update(schedule='*/5 * * * *')):
   with self.fixture(on_public=mutate) as (_,_,events,emit):
    with self.assertRaises(Exception):p.update()
    self.assertFalse(any(c.args[0]=='passed' for c in emit.call_args_list));self.assertEqual(events[-1],'cleanup')

 def test_wrong_image_source_rejected_before_any_cluster_mutation(self):
  with self.fixture() as (_,_,events,_),patch.object(p.images,'inspect',side_effect=p.images.ImageError('DELIVERY_IMAGE_SOURCE_MISMATCH')):
   with self.assertRaises(p.images.ImageError):p.update()
   self.assertEqual(events,[])

 def test_owned_journal_cleanup_rejects_foreign_names_timeout_and_permissions(self):
  with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','RUNNER_TEMP':directory,'DOKS_WORKDIR':directory+'/td-deploy-123-1'}):
   Path(os.environ['DOKS_WORKDIR']).mkdir(mode=0o700)
   client=p.inventory.observer.Client(1800);client.labels['app.kubernetes.io/managed-by']=p.OWNER;p.save_client(client)
   with patch.object(p.inventory.observer.Client,'cleanup') as cleanup:p.cleanup_saved_client();cleanup.assert_called_once()
   for mutation in (lambda s:s.update(pod='foreign'),lambda s:s.update(timeout=60),lambda s:s['labels'].update({'app.kubernetes.io/managed-by':'foreign'})):
    p.save_client(client);value=json.loads(p.journal_path().read_text());mutation(value);p.journal_path().write_text(json.dumps(value))
    with patch.object(p.inventory.observer.Client,'cleanup') as cleanup,self.assertRaises(p.UpdateError):p.cleanup_saved_client()
    cleanup.assert_not_called();p.journal_path().unlink()

 def test_public_error_contains_no_private_response(self):
  output=io.StringIO()
  with patch.object(p,'update',side_effect=RuntimeError('PRIVATE_SQL_CUSTOMER_SECRET')),redirect_stdout(output):self.assertEqual(p.main(),1)
  self.assertNotIn('PRIVATE',output.getvalue());self.assertIn('DELIVERY_UPDATE_FAILED',output.getvalue())

 def test_workflow_is_manual_guarded_and_never_bootstraps_or_activates_business_work(self):
  source=(p.HERE.parents[2]/'.github/workflows/deploy-proposal-delivery.yml').read_text()
  self.assertIn('workflow_dispatch:',source);self.assertNotIn('\n  push:',source)
  self.assertIn('group: tenderdesk-digitalocean-production',source);self.assertIn('proposal-delivery-update.py --cleanup',source)
  for value in ('--activate','digitalocean-bootstrap','resume-requested-processing','upload-artifact'):self.assertNotIn(value,source)

if __name__=='__main__':unittest.main()
