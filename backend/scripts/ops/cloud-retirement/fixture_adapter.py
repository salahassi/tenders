"""Isolated adapter for the unchanged strict retirement coordinator.

Targets come only from the nonce bootstrap identity. No production adapter is
imported, patched or executed. The durable Secret preserves the original Pod
manifests and process identities across two independent GitHub runners.
"""
from __future__ import annotations
import copy
import ipaddress
import json
import os
import time
import uuid
from types import SimpleNamespace

import contract as f
import resources as r

c=f.proof
UNCERTAIN='tenderdesk.io/storage-retirement-processes'
RESTORED='tenderdesk.io/storage-retirement-restored'
HELPER=f.OPS/'storage-retirement/physical.mjs'
BINARY=f.OPS.parent.parent/'docs/evidence/storage-retirement-binary-20261104.json'
gateway=f.load('retirement_fixture_gateway_contract',f.OPS/'storage-gateway-update.py')
literal=f.restore.builder.literal

def value_sql(value):return literal(c.canonical(value))+'::jsonb'
def guard_source():
 text=(f.OPS.parent.parent/'supabase/migrations/20261104172700_storage_write_retirement_proofs.sql').read_text()
 start=text.index('create function public.guard_retired_storage_write()');return text[start:text.index('end$$;',start)+len('end$$;')]
def marker(old,nonce):return c.canonical({'nonce':nonce,'replicas':old['spec']['replicas'],'spec_sha256':c.digest(c.canonical(old['spec']))})
def annotation_ops(current,key,value):
 ops=[]
 if current['metadata'].get('annotations') is None:ops.append({'op':'add','path':'/metadata/annotations','value':{}})
 return ops+[{'op':'add','path':'/metadata/annotations/'+r.pointer(key),'value':value}]

def validate_network(policies):
 by_name={p['metadata']['name']:p['spec'] for p in policies}
 f.need(set(by_name)=={'private-fixture','storage-gateway-only'} and len(policies)==2,'RETIREMENT_FIXTURE_NETWORK_BOUNDARY_INVALID')
 expected={
  'private-fixture':({'matchExpressions':[{'key':'tenderdesk.io/fixture-workload','operator':'NotIn','values':['storage']}]},[{'from':[{'podSelector':{}}]}]),
  'storage-gateway-only':({'matchLabels':{'tenderdesk.io/fixture-workload':'storage'}},[{'from':[{'podSelector':{'matchLabels':{'tenderdesk.io/fixture-workload':'gateway'}}}],'ports':[{'protocol':'TCP','port':5000}]}])}
 for name,spec in by_name.items():
  selector,ingress=expected[name]
  f.need(set(spec)=={'podSelector','policyTypes','ingress','egress'} and spec['podSelector']==selector and spec['policyTypes']==['Ingress','Egress'] and spec['ingress']==ingress,'RETIREMENT_FIXTURE_NETWORK_BOUNDARY_INVALID')
  out=spec['egress']
  f.need(isinstance(out,list) and len(out)==3 and out[0]=={'to':[{'podSelector':{}}]} and out[1]=={'to':[{'namespaceSelector':{'matchLabels':{'kubernetes.io/metadata.name':'kube-system'}}}],'ports':[{'protocol':'UDP','port':53},{'protocol':'TCP','port':53}]},'RETIREMENT_FIXTURE_NETWORK_BOUNDARY_INVALID')
  db=out[2];f.need(set(db)=={'to','ports'} and 1<=len(db['to'])<=8 and len(db['ports'])==1 and set(db['ports'][0])=={'protocol','port'} and db['ports'][0]['protocol']=='TCP' and type(db['ports'][0]['port']) is int and 1<=db['ports'][0]['port']<=65535,'RETIREMENT_FIXTURE_NETWORK_BOUNDARY_INVALID')
  for address in db['to']:
   f.need(set(address)=={'ipBlock'} and set(address['ipBlock'])=={'cidr'},'RETIREMENT_FIXTURE_NETWORK_BOUNDARY_INVALID')
   try:network=ipaddress.ip_network(address['ipBlock']['cidr'])
   except ValueError:raise f.FixtureError('RETIREMENT_FIXTURE_NETWORK_BOUNDARY_INVALID') from None
   f.need(network.version==4 and network.prefixlen==32 and network.network_address.is_private and not network.network_address.is_loopback,'RETIREMENT_FIXTURE_NETWORK_BOUNDARY_INVALID')
 f.need(by_name['private-fixture']['egress']==by_name['storage-gateway-only']['egress'],'RETIREMENT_FIXTURE_NETWORK_BOUNDARY_INVALID')

class FixtureAdapter:
 def __init__(self,state,interrupt_after_stop=False):
  self.state=f.validate_state(state);self.nonce=state['operation_nonce'];self.interrupt=interrupt_after_stop
  self.capture_value=state['process_capture'];self.physical_uid=state['resource_uids'].get('pod/'+r.PHYSICAL)
  self.fence_sha=None
 def sql(self,statement,role='owner'):return r.sql(self.state,statement,role=role)
 def query(self,statement,role='owner'):return r.query(self.state,statement,role=role)
 def storage_query(self,statement):return self.query(statement,'storageadmin')
 def items(self,kind):return r.items(self.state,kind)
 def selection(self):
  f.validate_fixture(self.state['fixture'])
  if self.capture_value is not None:return c.validate_selection(self.capture_value['selection'])
  expected={}
  for name in c.NAMES:
   dep=r.get(self.state,'deployment',name);containers=dep['spec']['template']['spec']['containers']
   f.need(len(containers)==1,'RETIREMENT_FIXTURE_PROCESS_COUNT_INVALID')
   expected[name]={'uid':dep['metadata']['uid'],'image':containers[0]['image'],'replicas':dep['spec']['replicas']}
  return c.validate_selection({'version':1,'operation_nonce':self.nonce,'actor_id':self.state['fixture']['actor_id'],
   'selection':self.state['fixture']['selection'],'namespace_uid':self.state['bootstrap']['uid'],
   'expected_workloads':expected,'binary_receipt_sha256':c.digest(BINARY.read_bytes())})
 def validate_binary(self,expected):
  raw=BINARY.read_bytes();f.need(c.digest(raw)==expected,'RETIREMENT_FIXTURE_BINARY_RECEIPT_CHANGED');self.binary=json.loads(raw)
  f.need(all(self.binary.get(k) is True for k in ('passed','actual_binary_exercised')) and all(self.binary.get(k)==0 for k in ('production_calls','customer_calls')),'RETIREMENT_FIXTURE_BINARY_UNQUALIFIED')
  f.need(self.binary.get('storage_image')==c.STORAGE_IMAGE and self.binary.get('physical_module_sha256')==c.digest(HELPER.read_bytes()) and self.binary.get('guard_function_source_sha256')==c.digest(guard_source()),'RETIREMENT_FIXTURE_BINARY_BINDING_CHANGED')
  contract,_,self.gateway_data=gateway.source_contract(SimpleNamespace(renderer=r.renderer,NAMESPACE=f.namespace(self.state)))
  f.need(contract['storage_qualification_sha256']==expected,'RETIREMENT_FIXTURE_GATEWAY_PROOF_CHANGED')
 def pod(self,name):
  r.namespace_guard(self.state)
  found=[p for p in self.items('pods') if p['metadata']['name']==name]
  f.need(len(found)<=1,'RETIREMENT_FIXTURE_POD_CENSUS_INVALID')
  if not found:return None
  return f.owned(self.state,'pod',name,found[0],known=False)
 def validate_capture(self,capture,selection):
  f.need(isinstance(capture,dict) and set(capture)=={'selection','workloads','pods','pvc','gateway','policies','storage_configuration'},'RETIREMENT_FIXTURE_CAPTURE_INVALID')
  f.need(capture['selection']==selection and selection['namespace_uid']==self.state['bootstrap']['uid'] and selection['operation_nonce']==self.nonce and selection['selection']==self.state['fixture']['selection'],'RETIREMENT_FIXTURE_CAPTURE_INVALID')
  f.need(set(capture['workloads'])==set(c.NAMES) and set(capture['pods'])==set(c.NAMES),'RETIREMENT_FIXTURE_CAPTURE_INVALID')
  for name in c.NAMES:
   dep=f.owned(self.state,'deployment',name,capture['workloads'][name]);expected=selection['expected_workloads'][name]
   containers=dep['spec']['template']['spec']['containers'];pods=capture['pods'][name]
   f.need(dep['metadata']['uid']==expected['uid'] and dep['spec']['replicas']==expected['replicas']==1 and len(containers)==1 and containers[0]['name']==name and containers[0]['image']==expected['image'] and len(pods)==1,'RETIREMENT_FIXTURE_CAPTURE_INVALID')
   for pod in pods:
    f.owned(self.state,'pod',pod['metadata']['name'],pod,known=False);c.pod_identity(pod)
    f.need(pod['spec']['containers']==containers and not pod['spec'].get('initContainers') and not pod['spec'].get('ephemeralContainers'),'RETIREMENT_FIXTURE_CAPTURE_INVALID')
  f.owned(self.state,'persistentvolumeclaim',f.PVC_NAME,capture['pvc'])
  f.owned(self.state,'configmap','gateway-config',capture['gateway'])
  f.need(capture['gateway'].get('data')==self.gateway_data,'RETIREMENT_FIXTURE_GATEWAY_CHANGED')
  validate_network(capture['policies'])
  for policy in capture['policies']:f.owned(self.state,'networkpolicy',policy['metadata']['name'],policy)
  return capture
 def capture(self,selection):
  r.namespace_guard(self.state)
  if self.capture_value is not None:
   self.validate_capture(self.capture_value,selection)
   f.need(self.state['phase'] in ('interrupted','recovered','retired','verified','cleaning'),'RETIREMENT_FIXTURE_RESUME_PHASE_INVALID')
   return self.capture_value
  f.need(self.state['phase']=='fixture_ready','RETIREMENT_FIXTURE_PHASE_INVALID')
  pods=self.items('pods');sets=self.items('replicasets');workloads={};selected={}
  f.need(not self.items('horizontalpodautoscalers'),'RETIREMENT_FIXTURE_AUTOSCALER_PRESENT')
  for name in c.NAMES:
   dep=r.get(self.state,'deployment',name);spec=dep['spec'];meta=dep['metadata'];expected=selection['expected_workloads'][name]
   cs=spec['template']['spec']['containers'];status=dep.get('status',{})
   f.need(meta['uid']==expected['uid'] and spec['replicas']==expected['replicas']==1 and len(cs)==1 and cs[0]['name']==name and cs[0]['image']==expected['image'],'RETIREMENT_FIXTURE_DEPLOYMENT_CHANGED')
   f.need(not spec['template']['spec'].get('initContainers') and not spec['template']['spec'].get('ephemeralContainers') and not meta.get('annotations',{}).get(c.ANNOTATION) and not meta.get('annotations',{}).get(UNCERTAIN),'RETIREMENT_FIXTURE_EXTRA_PROCESS_UNQUALIFIED')
   f.need(status.get('observedGeneration',0)>=meta.get('generation',0) and status.get('readyReplicas')==1 and status.get('updatedReplicas')==1 and status.get('unavailableReplicas',0)==0,'RETIREMENT_FIXTURE_DEPLOYMENT_NOT_READY')
   if name=='storage':f.need(not cs[0].get('command') and not cs[0].get('args'),'RETIREMENT_FIXTURE_STORAGE_ENTRYPOINT_CHANGED')
   if name=='gateway':gateway.require_runtime(spec['template']['spec'],r.renderer.NGINX_IMAGE)
   selector=spec['selector']['matchLabels'];matching=[p for p in pods if all(p['metadata'].get('labels',{}).get(k)==v for k,v in selector.items())]
   parents={x['metadata']['uid'] for x in sets if any(o.get('uid')==meta['uid'] and o.get('controller') is True for o in x['metadata'].get('ownerReferences',[]))}
   f.need(len(matching)==1,'RETIREMENT_FIXTURE_POD_CENSUS_CHANGED')
   for pod in matching:
    pm=pod['metadata'];ps=pod['spec'];statuses=pod.get('status',{}).get('containerStatuses',[])
    f.owned(self.state,'pod',pm['name'],pod,known=False)
    f.need(not pm.get('deletionTimestamp') and not pm.get('finalizers') and not pm.get('annotations',{}).get(c.ANNOTATION) and any(o.get('uid') in parents and o.get('controller') is True for o in pm.get('ownerReferences',[])),'RETIREMENT_FIXTURE_POD_LINEAGE_CHANGED')
    f.need(ps['containers']==cs and not ps.get('initContainers') and not ps.get('ephemeralContainers') and len(statuses)==1 and statuses[0].get('ready') is True and 'running' in statuses[0].get('state',{}),'RETIREMENT_FIXTURE_POD_NOT_RUNNING');c.pod_identity(pod)
   workloads[name]=dep;selected[name]=matching
  pvc=r.get(self.state,'persistentvolumeclaim',f.PVC_NAME);storage=workloads['storage']['spec']['template']['spec']
  mounts=storage['containers'][0].get('volumeMounts',[]);vols=[v for v in storage.get('volumes',[]) if v.get('persistentVolumeClaim',{}).get('claimName')==f.PVC_NAME]
  f.need(len(vols)==1 and any(m.get('name')==vols[0]['name'] and m.get('mountPath')=='/var/lib/storage' and not m.get('subPath') and not m.get('readOnly') for m in mounts),'RETIREMENT_FIXTURE_PVC_CHANGED')
  names=['STORAGE_BACKEND','FILE_STORAGE_BACKEND_PATH','GLOBAL_S3_BUCKET','TENANT_ID','TUS_USE_FILE_VERSION_SEPARATOR','PG_QUEUE_ENABLE','S3_PROTOCOL_ENABLED']
  observed=json.loads(r.command(['exec',selected['storage'][0]['metadata']['name'],'-n',f.namespace(self.state),'--','node','-e','process.stdout.write(JSON.stringify(Object.fromEntries('+json.dumps(names)+'.map(k=>[k,process.env[k]??null]))))']))
  f.need(observed==dict(zip(names,['file','/var/lib/storage','bootstrap','bootstrap','false','false','false'])),'RETIREMENT_FIXTURE_STORAGE_CONFIGURATION_CHANGED')
  policies=self.items('networkpolicies');f.need(bool(policies),'RETIREMENT_FIXTURE_NETWORK_BOUNDARY_MISSING')
  for policy in policies:f.owned(self.state,'networkpolicy',policy['metadata']['name'],policy)
  capture={'selection':selection,'workloads':workloads,'pods':selected,'pvc':pvc,'gateway':r.get(self.state,'configmap','gateway-config'),'policies':policies,'storage_configuration':observed}
  self.capture_value=self.validate_capture(capture,selection);self.state['process_capture']=capture;r.save(self.state)
  self.assert_boundary();return capture
 def assert_boundary(self):
  capture=self.capture_value;config=r.get(self.state,'configmap','gateway-config')
  f.need(config['metadata']['uid']==capture['gateway']['metadata']['uid'] and config.get('data')==self.gateway_data and not config.get('binaryData'),'RETIREMENT_FIXTURE_GATEWAY_CHANGED')
  policies=self.items('networkpolicies');old={p['metadata']['uid']:p for p in capture['policies']}
  f.need(len(policies)==len(old) and all(p['metadata']['uid'] in old and p.get('spec')==old[p['metadata']['uid']].get('spec') for p in policies),'RETIREMENT_FIXTURE_NETWORK_BOUNDARY_CHANGED')
  for service in self.items('services'):
   spec=service.get('spec',{})
   f.need(spec.get('type','ClusterIP')=='ClusterIP' and not any(spec.get(x) for x in ('externalIPs','externalName','loadBalancerIP')) and all(not p.get('nodePort') for p in spec.get('ports',[])),'RETIREMENT_FIXTURE_PUBLIC_EXPOSURE')
 def install_fence(self,capture):
  r.phase('retirement_fence_inspect')
  owner=self.state['bootstrap']['role_prefix']+'_owner'
  observed=self.query("select jsonb_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'config',p.proconfig,'body_sha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='guard_retired_storage_write' and p.pronargs=0 and p.prokind='f'",None)
  f.need(observed=={'owner':owner,'security_definer':True,'config':['search_path=""'],'body_sha256':self.binary['guard_body_sha256']},'RETIREMENT_FIXTURE_GUARD_CHANGED')
  r.phase('retirement_fence_install')
  self.sql("""do $fence$ declare so name;fo name;sid oid;fid oid;caller name:=current_user;had boolean;begin
   select r.oid,pg_get_userbyid(r.relowner) into sid,so from pg_class r join pg_namespace n on n.oid=r.relnamespace where n.nspname='storage' and r.relname='objects';
   select p.oid,pg_get_userbyid(p.proowner) into fid,fo from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='guard_retired_storage_write' and p.pronargs=0 and p.prokind='f';
   if so is null or fo is null or fo<>"""+literal(owner)+""" or so<>"""+literal(self.state['bootstrap']['role_prefix']+'_storageadmin')+""" or not pg_has_role(session_user,so,'SET') or not pg_has_role(session_user,fo,'SET') then raise exception 'RETIREMENT_FIXTURE_OWNER_CHANGED';end if;
   if exists(select 1 from pg_trigger where tgrelid=sid and tgname='tenderdesk_retired_storage_write') then
    if not exists(select 1 from pg_trigger where tgrelid=sid and tgname='tenderdesk_retired_storage_write' and tgenabled='O' and tgtype=23 and tgfoid=fid) then raise exception 'RETIREMENT_FIXTURE_TRIGGER_CHANGED';end if;
   else
    had:=has_function_privilege(so,fid,'EXECUTE');execute format('set local role %I',fo);
    if not had then execute format('grant execute on function public.guard_retired_storage_write() to %I',so);end if;
    execute format('set local role %I',so);execute 'create trigger tenderdesk_retired_storage_write before insert or update on storage.objects for each row execute function public.guard_retired_storage_write()';
    execute format('set local role %I',fo);if not had then execute format('revoke execute on function public.guard_retired_storage_write() from %I',so);end if;execute format('set local role %I',caller);
   end if;end $fence$""",None)
  r.phase('retirement_fence_hash')
  self.fence_sha=self.query("select to_jsonb(encode(sha256(convert_to(pg_get_functiondef(p.oid)||pg_get_triggerdef(t.oid),'UTF8')),'hex')) from pg_trigger t join pg_class r on r.oid=t.tgrelid join pg_namespace rn on rn.oid=r.relnamespace join pg_proc p on p.oid=t.tgfoid where rn.nspname='storage' and r.relname='objects' and t.tgname='tenderdesk_retired_storage_write'",None)
 def accounting(self):
  r.phase('retirement_accounting')
  fixture=self.state['fixture'];key=literal(fixture['selection'][0]['storage_key']);workspace=literal(fixture['workspace_id']);intent=literal(fixture['selection'][0]['id']);nonce=literal(self.nonce)
  return self.query("select jsonb_build_object('reserved',app_private.storage_reserved_bytes("+workspace+"::uuid),'pending',coalesce((select sum(estimated_size) from public.storage_cleanup_queue where workspace_id="+workspace+"::uuid and storage_key="+key+" and status<>'done'),0),'intent',(select jsonb_build_object('state',state,'revision',revision,'expected_hash',expected_hash,'expected_size',expected_size,'closed',send_closed_at is not null,'receipt',retirement_receipt is not null) from public.storage_write_intents where id="+intent+"::uuid),'completed_audits',(select count(*) from public.audit_events where action='storage.retirement.completed' and entity_id="+nonce+"::uuid))")
 def assert_uncertain(self):
  now=self.accounting();fixture=self.state['fixture'];intent=now['intent']
  f.need(intent and intent['state']=='unknown' and intent['expected_hash']==fixture['expected_hash'] and intent['expected_size']==fixture['expected_size'] and now['pending']>0 and now['reserved']>=now['pending'] and now['completed_audits']==0,'RETIREMENT_FIXTURE_ALLOWANCE_RELEASED_EARLY')
  return now
 def prepare(self,selection):
  if self.state['completion'] is None:
   self.state['completion']={'before':self.assert_uncertain(),'evidence':None,'receipt':None,'after':None};r.save(self.state)
  r.phase('retirement_prepare')
  batch=self.query('select app_private.prepare_storage_write_retirement('+literal(selection['actor_id'])+','+literal(self.nonce)+','+value_sql(selection['selection'])+')')
  if batch['state']!='complete':f.need(self.assert_uncertain()==self.state['completion']['before'],'RETIREMENT_FIXTURE_ALLOWANCE_CHANGED')
  return batch
 def census(self):
  r.phase('retirement_census')
  # All owners are read in one repeatable snapshot; only this synthetic DB exists.
  role=f.restore.builder.identifier(self.state['bootstrap']['role_prefix']+'_storageadmin');owner=f.restore.builder.identifier(self.state['bootstrap']['role_prefix']+'_owner')
  return self.query('SET LOCAL ROLE '+role+";DO $census$ BEGIN perform set_config('tenderdesk.retirement_census',(select coalesce(jsonb_agg(k),'[]')::text from(select name k from storage.objects where bucket_id='tenderdesk-private' union select key from storage.s3_multipart_uploads where bucket_id='tenderdesk-private' union select key from storage.s3_multipart_uploads_parts where bucket_id='tenderdesk-private')x),true);END $census$;SET LOCAL ROLE "+owner+";select coalesce(jsonb_agg(k),'[]') from(select jsonb_array_elements_text(current_setting('tenderdesk.retirement_census')::jsonb) k union select storage_key from public.storage_write_intents union select storage_key from public.storage_cleanup_queue union select storage_key from public.documents union select storage_key from public.export_artifacts union select storage_key from public.proposal_delivery_artifacts union select storage_key from public.export_package_volumes union select storage_key from public.restore_files)x",None)
 def protect_pods(self,capture,nonce):
  for name in c.NAMES:
   current=r.get(self.state,'deployment',name);old=capture['workloads'][name]
   expected=copy.deepcopy(old['spec']);expected['replicas']=0
   f.need(current['spec'] in (old['spec'],expected),'RETIREMENT_FIXTURE_DEPLOYMENT_CHANGED')
   raw=current['metadata'].get('annotations',{}).get(UNCERTAIN)
   identities=[c.pod_identity(p) for p in capture['pods'][name]]
   if raw is None:
    f.need(current['spec']==old['spec'],'RETIREMENT_FIXTURE_JOURNAL_MISSING')
    raw=c.canonical({'nonce':nonce,'pods':identities,'termination':{}})
    r.patch(self.state,'deployment',name,current,annotation_ops(current,UNCERTAIN,raw))
   journal=c.validate_process_journal(json.loads(raw),nonce)
   f.need(journal['pods']==identities,'RETIREMENT_FIXTURE_ORIGINAL_PROCESS_CHANGED')
   f.need(r.get(self.state,'deployment',name)['metadata'].get('annotations',{}).get(UNCERTAIN)==raw,'RETIREMENT_FIXTURE_JOURNAL_READBACK_FAILED')
  for pods in capture['pods'].values():
   for old in pods:
    current=self.pod(old['metadata']['name']);f.need(current is not None and current['metadata']['uid']==old['metadata']['uid'] and current['spec']==old['spec'],'RETIREMENT_FIXTURE_ORIGINAL_PROCESS_CHANGED')
    meta=current['metadata'];existing=meta.get('annotations',{}).get(c.ANNOTATION)
    if existing is not None:
     f.need(existing==nonce and meta.get('finalizers')==[c.FINALIZER],'RETIREMENT_FIXTURE_POD_PROTECTION_CHANGED');continue
    f.need(not meta.get('finalizers'),'RETIREMENT_FIXTURE_FOREIGN_FINALIZER')
    ops=annotation_ops(current,c.ANNOTATION,nonce)+[{'op':'add','path':'/metadata/finalizers','value':[c.FINALIZER]}]
    self.patch_pod(current,ops)
    confirmed=self.pod(meta['name']);f.need(confirmed['metadata'].get('annotations',{}).get(c.ANNOTATION)==nonce and confirmed['metadata'].get('finalizers')==[c.FINALIZER],'RETIREMENT_FIXTURE_JOURNAL_READBACK_FAILED')
  self.state['phase']='protected' if self.interrupt else 'recovered';r.save(self.state)
 def patch_pod(self,current,operations):
  # Captured Pods are controller-owned and cannot be replaced/adopted by name.
  matches=[p for values in self.capture_value['pods'].values() for p in values if p['metadata']['name']==current['metadata']['name']]
  f.need(len(matches)==1 and matches[0]['metadata']['uid']==current['metadata']['uid'],'RETIREMENT_FIXTURE_ORIGINAL_PROCESS_CHANGED')
  f.owned(self.state,'pod',current['metadata']['name'],current,known=False);r.namespace_guard(self.state)
  r.command(['patch','pod',current['metadata']['name'],'-n',f.namespace(self.state),'--type=json','--patch',c.canonical([
   {'op':'test','path':'/metadata/uid','value':current['metadata']['uid']},
   {'op':'test','path':'/metadata/resourceVersion','value':current['metadata']['resourceVersion']},*operations])])
 def stop(self,capture,nonce):
  for name in c.NAMES:
   current=r.get(self.state,'deployment',name);old=capture['workloads'][name]
   if current['metadata'].get('annotations',{}).get(c.ANNOTATION) is not None:self.assert_stopped(capture,name,nonce);continue
   f.need(current['spec']==old['spec'],'RETIREMENT_FIXTURE_DEPLOYMENT_CHANGED')
   ops=annotation_ops(current,c.ANNOTATION,marker(old,nonce))+[{'op':'replace','path':'/spec/replicas','value':0}]
   r.patch(self.state,'deployment',name,current,ops);self.assert_stopped(capture,name,nonce)
  f.need(self.assert_uncertain()==self.state['completion']['before'],'RETIREMENT_FIXTURE_ALLOWANCE_RELEASED_EARLY')
  if self.interrupt:
   self.state['phase']='interrupted';r.save(self.state)
   # Abrupt termination deliberately bypasses coordinator.finally. The next job
   # has a new runner filesystem and must recover captured identities from Kube.
   os._exit(86)
 def assert_stopped(self,capture,name,nonce):
  current=r.get(self.state,'deployment',name);old=capture['workloads'][name];expected=copy.deepcopy(old['spec']);expected['replicas']=0
  f.need(current['spec']==expected and current['metadata'].get('annotations',{}).get(c.ANNOTATION)==marker(old,nonce),'RETIREMENT_FIXTURE_QUIESCENCE_CHANGED')
  allowed={p['metadata']['uid'] for p in capture['pods'][name]};selector=old['spec']['selector']['matchLabels']
  f.need(not any(all(p['metadata'].get('labels',{}).get(k)==v for k,v in selector.items()) and p['metadata']['uid'] not in allowed for p in self.items('pods')),'RETIREMENT_FIXTURE_NEW_PROCESS_APPEARED')
  self.assert_boundary()
 def assert_no_other_pvc_writers(self,capture):
  current=r.get(self.state,'persistentvolumeclaim',f.PVC_NAME);old=capture['pvc']
  f.need(current['metadata']['uid']==old['metadata']['uid'] and current['spec']==old['spec'],'RETIREMENT_FIXTURE_PVC_CHANGED')
  allowed={p['metadata']['uid'] for p in capture['pods']['storage']}
  if self.physical_uid:allowed.add(self.physical_uid)
  for pod in self.items('pods'):
   if any(v.get('persistentVolumeClaim',{}).get('claimName')==f.PVC_NAME for v in pod.get('spec',{}).get('volumes',[])):
    f.need(pod['metadata']['uid'] in allowed,'RETIREMENT_FIXTURE_OTHER_PVC_WRITER')
    if pod['metadata']['uid']==self.physical_uid:self.validate_physical_pod(pod)
    else:
     original=next(p for p in capture['pods']['storage'] if p['metadata']['uid']==pod['metadata']['uid'])
     f.need(pod['spec']==original['spec'],'RETIREMENT_FIXTURE_STORAGE_PROCESS_CHANGED')
 def assert_no_multipart(self,key):
  count=self.storage_query("select to_jsonb((select count(*) from storage.s3_multipart_uploads where bucket_id='tenderdesk-private' and key="+literal(key)+")+(select count(*) from storage.s3_multipart_uploads_parts where bucket_id='tenderdesk-private' and key="+literal(key)+'))')
  f.need(count==0,'RETIREMENT_FIXTURE_MULTIPART_PRESENT')
 def ensure_physical_pod(self):
  if self.physical_uid:
   current=r.get(self.state,'pod',r.PHYSICAL);self.validate_physical_pod(current);return
  source=self.capture_value['pods']['storage'][0]
  pod={'apiVersion':'v1','kind':'Pod','metadata':r.meta(self.state,r.PHYSICAL),'spec':{
   'restartPolicy':'Never','activeDeadlineSeconds':1200,'automountServiceAccountToken':False,'nodeName':source['spec']['nodeName'],
   'securityContext':copy.deepcopy(source['spec']['securityContext']),
   'containers':[{'name':'physical','image':c.STORAGE_IMAGE,'command':['node','-e','setTimeout(()=>{},1100000)'],
    'securityContext':copy.deepcopy(source['spec']['containers'][0]['securityContext']),
    'resources':{'requests':{'cpu':'25m','memory':'32Mi'},'limits':{'cpu':'250m','memory':'128Mi'}},
    'volumeMounts':[{'name':'objects','mountPath':'/var/lib/storage'},{'name':'work','mountPath':'/run/storage-retirement'}]}],
   'volumes':[{'name':'objects','persistentVolumeClaim':{'claimName':f.PVC_NAME}},{'name':'work','emptyDir':{'sizeLimit':'2Mi'}}]}}
  current=r.create(self.state,'pod',pod);self.physical_uid=current['metadata']['uid']
  r.command(['wait','pod/'+r.PHYSICAL,'-n',f.namespace(self.state),'--for=condition=Ready','--timeout=90s'],timeout=100)
  self.write_physical('physical.mjs',HELPER.read_text())
 def validate_physical_pod(self,pod):
  f.owned(self.state,'pod',r.PHYSICAL,pod)
  spec=pod.get('spec',{});source=self.capture_value['pods']['storage'][0];cs=spec.get('containers',[])
  f.need(pod['metadata']['uid']==self.physical_uid and spec.get('restartPolicy')=='Never' and spec.get('automountServiceAccountToken') is False and spec.get('nodeName')==source['spec']['nodeName'] and spec.get('securityContext')==source['spec']['securityContext'] and not any(spec.get(k) for k in ('initContainers','ephemeralContainers','hostNetwork','hostPID','hostIPC')) and len(cs)==1,'RETIREMENT_FIXTURE_PHYSICAL_PROCESS_CHANGED')
  container=cs[0]
  f.need(set(container)<=set(('name','image','command','securityContext','resources','volumeMounts','imagePullPolicy','terminationMessagePath','terminationMessagePolicy')) and container.get('name')=='physical' and container.get('image')==c.STORAGE_IMAGE and container.get('command')==['node','-e','setTimeout(()=>{},1100000)'] and container.get('securityContext')==source['spec']['containers'][0]['securityContext'],'RETIREMENT_FIXTURE_PHYSICAL_PROCESS_CHANGED')
  f.need(container.get('volumeMounts')==[{'name':'objects','mountPath':'/var/lib/storage'},{'name':'work','mountPath':'/run/storage-retirement'}],'RETIREMENT_FIXTURE_PHYSICAL_MOUNT_CHANGED')
  volumes=spec.get('volumes',[]);f.need(len(volumes)==2,'RETIREMENT_FIXTURE_PHYSICAL_MOUNT_CHANGED')
  by_name={v['name']:v for v in volumes}
  f.need(set(by_name)=={'objects','work'} and by_name['objects']=={'name':'objects','persistentVolumeClaim':{'claimName':f.PVC_NAME}} and by_name['work']=={'name':'work','emptyDir':{'sizeLimit':'2Mi'}},'RETIREMENT_FIXTURE_PHYSICAL_MOUNT_CHANGED')
  c.pod_identity(pod)
 def write_physical(self,name,text):
  f.need(name in ('physical.mjs','scope.json','expected-manifest.json'),'RETIREMENT_FIXTURE_FILE_INVALID')
  self.validate_physical_pod(r.get(self.state,'pod',r.PHYSICAL))
  r.command(['exec','-i',r.PHYSICAL,'-n',f.namespace(self.state),'--','node','-e',"let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>require('fs').writeFileSync('/run/storage-retirement/"+name+"',s,{mode:0o600}));"],payload=text)
 def scope(self,item,nonce):return {'version':1,'operationNonce':nonce,'globalBucket':'bootstrap','tenantId':'bootstrap','bucketId':'tenderdesk-private','storageKey':item['storage_key'],'versionSeparator':'/'}
 def validate_manifest(self,value,scope):
  f.need(value.get('version')==1 and value.get('operationNonce')==self.nonce and value.get('scopeSha256')==c.digest(c.canonical(scope)) and isinstance(value.get('files'),list),'RETIREMENT_FIXTURE_PHYSICAL_PROOF_INVALID')
  unsigned={k:value[k] for k in ('version','operationNonce','scopeSha256','files','absent')}
  f.need(value.get('manifestSha256')==c.digest(c.canonical(unsigned)),'RETIREMENT_FIXTURE_PHYSICAL_PROOF_INVALID');return value
 def physical(self,item,nonce,mode,expected=None):
  self.ensure_physical_pod();self.assert_no_other_pvc_writers(self.capture_value)
  scope=self.scope(item,nonce);self.write_physical('scope.json',c.canonical(scope))
  if expected is not None:self.write_physical('expected-manifest.json',c.canonical(expected))
  result=json.loads(r.command(['exec',r.PHYSICAL,'-n',f.namespace(self.state),'--','node','/run/storage-retirement/physical.mjs',mode],timeout=90))
  return self.validate_manifest(result,scope)
 def inspect_physical(self,item,nonce):return self.physical(item,nonce,'inspect')
 def remove_physical(self,item,nonce,expected):
  f.need(self.assert_uncertain()==self.state['completion']['before'],'RETIREMENT_FIXTURE_ALLOWANCE_RELEASED_EARLY')
  f.need(expected.get('absent') is False and any(x.get('size')==self.state['fixture']['expected_size'] and x.get('sha256')==self.state['fixture']['expected_hash'] for x in expected.get('files',[])),'RETIREMENT_FIXTURE_REAL_UPLOAD_NOT_FOUND')
  return self.physical(item,nonce,'remove',expected)
 def delete_metadata(self,key):self.sql("SET LOCAL storage.allow_delete_query='true';delete from storage.objects where bucket_id='tenderdesk-private' and name="+literal(key),'storageadmin')
 def metadata_remaining(self,key):return self.storage_query("select to_jsonb(count(*)) from storage.objects where bucket_id='tenderdesk-private' and name="+literal(key))
 def identity(self):
  return {'source_revision':f.revision(),'run_id':os.environ['GITHUB_RUN_ID'],'run_attempt':os.environ['GITHUB_RUN_ATTEMPT'],'namespace_uid':self.state['bootstrap']['uid'],
   'cluster_id':'a6093a76-a2d6-47fd-8697-579d41ed316f','physical_helper_sha256':c.digest(HELPER.read_bytes()),'fence_sha256':self.fence_sha}
 def finish(self,selection,batch,evidence):
  f.need(self.assert_uncertain()==self.state['completion']['before'],'RETIREMENT_FIXTURE_ALLOWANCE_RELEASED_EARLY')
  self.state['completion']['evidence']=evidence;r.save(self.state)
  receipt=self.finish_sql(evidence);self.state['completion']['receipt']=receipt;self.state['completion']['after']=self.accounting();self.state['phase']='retired';r.save(self.state)
  return receipt
 def finish_sql(self,evidence):return self.query('select app_private.finish_storage_write_retirement('+literal(self.state['fixture']['actor_id'])+','+literal(self.nonce)+','+value_sql(evidence)+')')
 def save_terminations(self,capture,name,nonce):
  dep=r.get(self.state,'deployment',name);raw=dep['metadata'].get('annotations',{}).get(UNCERTAIN)
  if raw is None:
   f.need(not any((self.pod(p['metadata']['name']) or {}).get('metadata',{}).get('annotations',{}).get(c.ANNOTATION)==nonce for p in capture['pods'][name]),'RETIREMENT_FIXTURE_JOURNAL_MISSING');return True
  journal=c.validate_process_journal(json.loads(raw),nonce);identities=[c.pod_identity(p) for p in capture['pods'][name]]
  f.need(journal['pods']==identities,'RETIREMENT_FIXTURE_ORIGINAL_PROCESS_CHANGED')
  proofs=copy.deepcopy(journal['termination']);complete=True
  for old in capture['pods'][name]:
   uid=old['metadata']['uid']
   if uid in proofs:c.validate_saved_termination(proofs[uid],uid,c.container_identities(old));continue
   current=self.pod(old['metadata']['name'])
   if current is None:complete=False;continue
   result=c.terminated_pod(old,current,nonce)
   if result is None:complete=False
   else:proofs[uid]=result
  if proofs!=journal['termination']:
   updated={**journal,'termination':proofs}
   r.patch(self.state,'deployment',name,dep,[{'op':'test','path':'/metadata/annotations/'+r.pointer(UNCERTAIN),'value':raw},{'op':'replace','path':'/metadata/annotations/'+r.pointer(UNCERTAIN),'value':c.canonical(updated)}]);raw=c.canonical(updated)
  if not complete:return False
  confirmed=r.get(self.state,'deployment',name)
  f.need(confirmed['metadata'].get('annotations',{}).get(UNCERTAIN)==raw,'RETIREMENT_FIXTURE_JOURNAL_READBACK_FAILED');c.validate_process_journal(json.loads(raw),nonce)
  # Keep full journals for drill evidence and resumable cleanup, even once Pods
  # disappear. No missing Pod is ever promoted to a process termination proof.
  for old in capture['pods'][name]:
   uid=old['metadata']['uid'];c.validate_saved_termination(proofs[uid],uid,c.container_identities(old))
   current=self.pod(old['metadata']['name'])
   if current is None:continue
   meta=current['metadata'];annotation=meta.get('annotations',{}).get(c.ANNOTATION);finalizers=meta.get('finalizers',[])
   f.need(meta['uid']==uid,'RETIREMENT_FIXTURE_ORIGINAL_PROCESS_CHANGED')
   if annotation is None and c.FINALIZER not in finalizers:continue
   f.need(annotation==nonce and finalizers==[c.FINALIZER] and c.terminated_pod(old,current,nonce) is not None,'RETIREMENT_FIXTURE_PROCESS_RECONCILIATION_REQUIRED')
   self.patch_pod(current,[{'op':'test','path':'/metadata/annotations/'+r.pointer(c.ANNOTATION),'value':nonce},{'op':'test','path':'/metadata/finalizers','value':[c.FINALIZER]},{'op':'remove','path':'/metadata/finalizers'},{'op':'remove','path':'/metadata/annotations/'+r.pointer(c.ANNOTATION)}])
  return True
 def restore(self,capture,nonce):
  failed=False;unproven=False
  try:
   if self.physical_uid:
    current=r.get(self.state,'pod',r.PHYSICAL,missing=True)
    if current is not None:
     self.validate_physical_pod(current);r.delete(self.state,'pod',r.PHYSICAL)
     r.command(['wait','pod/'+r.PHYSICAL,'-n',f.namespace(self.state),'--for=delete','--timeout=90s'],timeout=100)
    # Missing helper is only a cleanup fact. Original writer exit proof still
    # comes exclusively from the separately retained full process journals.
    self.physical_uid=None
  except Exception:failed=True
  for name in reversed(c.NAMES):
   try:
    current=r.get(self.state,'deployment',name);old=capture['workloads'][name];raw=current['metadata'].get('annotations',{}).get(c.ANNOTATION)
    self.assert_boundary();ops=annotation_ops(current,RESTORED,nonce+':'+str(uuid.uuid4()))
    if raw is None:f.need(current['spec']==old['spec'],'RETIREMENT_FIXTURE_RESTORE_SPEC_CHANGED')
    else:
     expected=copy.deepcopy(old['spec']);expected['replicas']=0
     f.need(raw==marker(old,nonce) and current['spec']==expected,'RETIREMENT_FIXTURE_RESTORE_SPEC_CHANGED')
     ops.extend([{'op':'test','path':'/metadata/annotations/'+r.pointer(c.ANNOTATION),'value':raw},{'op':'test','path':'/spec/replicas','value':0},{'op':'replace','path':'/spec/replicas','value':old['spec']['replicas']},{'op':'remove','path':'/metadata/annotations/'+r.pointer(c.ANNOTATION)}])
    r.patch(self.state,'deployment',name,current,ops)
    if not self.save_terminations(capture,name,nonce):unproven=True
   except Exception:failed=True
  for name in reversed(c.NAMES):
   try:r.wait_deployment(self.state,name,180)
   except Exception:failed=True
  f.need(not failed,'RETIREMENT_FIXTURE_SERVICE_RESTORATION_REQUIRED')
  f.need(not unproven,'RETIREMENT_FIXTURE_PROCESS_RECONCILIATION_REQUIRED')
 def verify_retirement(self):
  completion=self.state['completion'];f.need(completion and completion['receipt'] and completion['evidence'],'RETIREMENT_FIXTURE_COMPLETION_MISSING')
  before=completion['before'];after=self.accounting();expected=copy.deepcopy(after)
  f.need(after==completion['after'] and before['reserved']-after['reserved']==before['pending'] and after['pending']==0 and after['intent']['state']=='quiesced' and after['intent']['revision']==before['intent']['revision']+1 and after['intent']['closed'] and after['intent']['receipt'] and after['completed_audits']==1,'RETIREMENT_FIXTURE_ALLOWANCE_RELEASE_INVALID')
  f.need(self.finish_sql(completion['evidence'])==completion['receipt'] and self.accounting()==expected,'RETIREMENT_FIXTURE_REPLAY_CHANGED_ALLOWANCE')
  all_exits=True
  for name in c.NAMES:
   dep=r.get(self.state,'deployment',name);old=self.capture_value['workloads'][name]
   f.need(dep['spec']==old['spec'] and dep['status'].get('readyReplicas')==old['spec']['replicas'],'RETIREMENT_FIXTURE_REPLICA_RESTORATION_FAILED')
   journal=c.validate_process_journal(json.loads(dep['metadata']['annotations'][UNCERTAIN]),self.nonce)
   f.need(journal['pods']==[c.pod_identity(p) for p in self.capture_value['pods'][name]] and set(journal['termination'])=={x['uid'] for x in journal['pods']},'RETIREMENT_FIXTURE_PROCESS_PROOF_MISSING')
   all_exits=all_exits and bool(journal['termination'])
  return {'original_process_exits_observed':all_exits,'physical_and_metadata_absent_before_finish':all(k['remaining_count']==0 and k['metadata_remaining']==0 and k['removed_count']>0 and k['removed_bytes']>=16384 for k in completion['evidence']['keys']),
   'unknown_allowance_retained_until_proof':True,'allowance_released_exactly_once':True,'same_proof_replay_no_release':True,'replicas_restored':True}
 def post_restart_absence(self,new_storage_key):
  c.validate_key(new_storage_key)
  f.need(new_storage_key.startswith(self.state['fixture']['workspace_id']+'/') and new_storage_key!=self.state['fixture']['selection'][0]['storage_key'],'RETIREMENT_FIXTURE_NEW_KEY_INVALID')
  self.assert_boundary();dep=r.get(self.state,'deployment','storage');selector=dep['spec']['selector']['matchLabels']
  pods=[p for p in self.items('pods') if all(p['metadata'].get('labels',{}).get(k)==v for k,v in selector.items()) and not p['metadata'].get('deletionTimestamp')]
  f.need(len(pods)==1 and pods[0]['spec']['containers']==dep['spec']['template']['spec']['containers'],'RETIREMENT_FIXTURE_STORAGE_PROCESS_CHANGED')
  pod=pods[0];identity=c.pod_identity(pod);path='/tmp/retirement-physical-'+self.nonce+'.mjs'
  r.command(['exec','-i',pod['metadata']['name'],'-n',f.namespace(self.state),'--','node','-e',"let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>require('fs').writeFileSync("+json.dumps(path)+",s,{mode:0o600}));"],payload=HELPER.read_text())
  scope=self.scope(self.state['fixture']['selection'][0],self.nonce)
  program="import {inspectScope} from "+json.dumps('file://'+path)+";let s='';for await(const x of process.stdin)s+=x;process.stdout.write(JSON.stringify(await inspectScope('/var/lib/storage',JSON.parse(s))));"
  value=json.loads(r.command(['exec','-i',pod['metadata']['name'],'-n',f.namespace(self.state),'--','node','--input-type=module','-e',program],payload=c.canonical(scope)))
  self.validate_manifest(value,scope)
  f.need(c.pod_identity(self.pod(pod['metadata']['name']))==identity and value['absent'] is True and value['files']==[] and self.metadata_remaining(scope['storageKey'])==0,'RETIREMENT_FIXTURE_RETIRED_BYTES_RECREATED')
  fresh_scope=self.scope({'storage_key':new_storage_key},self.nonce)
  fresh=json.loads(r.command(['exec','-i',pod['metadata']['name'],'-n',f.namespace(self.state),'--','node','--input-type=module','-e',program],payload=c.canonical(fresh_scope)))
  self.validate_manifest(fresh,fresh_scope)
  f.need(c.pod_identity(self.pod(pod['metadata']['name']))==identity and fresh['absent'] is False and any(x.get('size')==self.state['fixture']['expected_size'] and x.get('sha256')==self.state['fixture']['expected_hash'] for x in fresh['files']) and self.metadata_remaining(new_storage_key)==1,'RETIREMENT_FIXTURE_NEW_KEY_NOT_PHYSICAL')
  return True
 def validate_cleanup_checkpoint(self):
  if self.capture_value is not None:
   self.validate_binary(self.capture_value['selection']['binary_receipt_sha256'])
   self.validate_capture(self.capture_value,self.capture_value['selection'])
  return f.validate_cleanup_proof(self.state,self.state['cleanup_proof'])
 def cleanup_preconditions(self):
  if self.capture_value is not None:
   self.validate_binary(self.capture_value['selection']['binary_receipt_sha256']);self.validate_capture(self.capture_value,self.capture_value['selection'])
   if self.state['phase']=='fixture_ready':
    deployments={name:r.get(self.state,'deployment',name) for name in c.NAMES}
    if all(UNCERTAIN not in dep['metadata'].get('annotations',{}) and c.ANNOTATION not in dep['metadata'].get('annotations',{}) for dep in deployments.values()):
     # A failed fence/census/prepare can precede all protection writes. Preserve
     # a distinct live-original witness; it is never a process-exit/quota proof.
     unprotected={'version':1,'operation_nonce':self.nonce,'namespace_uid':self.state['bootstrap']['uid'],'mode':'unprotected_originals',
      'workloads':{name:{'deployment_uid':dep['metadata']['uid'],'deployment':dep,'pods':[self.pod(p['metadata']['name']) for p in self.capture_value['pods'][name]]} for name,dep in deployments.items()}}
     f.need(all(p is not None for item in unprotected['workloads'].values() for p in item['pods']),'RETIREMENT_FIXTURE_UNPROTECTED_PROOF_INVALID')
     return f.validate_cleanup_proof(self.state,unprotected)
   self.restore(self.capture_value,self.nonce)
  for pod in self.items('pods'):
   f.need(c.FINALIZER not in pod.get('metadata',{}).get('finalizers',[]) and not pod.get('metadata',{}).get('annotations',{}).get(c.ANNOTATION),'RETIREMENT_FIXTURE_UNRESOLVED_PROCESS_PROOF')
  proof={'version':1,'operation_nonce':self.nonce,'namespace_uid':self.state['bootstrap']['uid'],'mode':'terminated_originals' if self.capture_value else 'uncaptured','workloads':{}}
  if self.capture_value is not None:
   for name in c.NAMES:
    dep=r.get(self.state,'deployment',name);old=self.capture_value['workloads'][name]
    f.need(dep['spec']==old['spec'] and dep['metadata'].get('annotations',{}).get(c.ANNOTATION) is None,'RETIREMENT_FIXTURE_PROTECTION_RELEASE_NOT_CONFIRMED')
    raw=dep['metadata'].get('annotations',{}).get(UNCERTAIN)
    f.need(isinstance(raw,str),'RETIREMENT_FIXTURE_CLEANUP_EXIT_PROOF_MISSING')
    journal=c.validate_process_journal(json.loads(raw),self.nonce)
    # Retain these complete proofs outside the Deployments before ordinary
    # cleanup removes their journals. A later runner can validate the originals.
    proof['workloads'][name]={'deployment_uid':dep['metadata']['uid'],'journal':journal,'protection_released':True}
  return f.validate_cleanup_proof(self.state,proof)
