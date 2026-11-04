"""Original-CA runner adapter. Never import credentials into public receipts."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid

HERE=Path(__file__).resolve().parent

def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m
c=load('storage_retirement_contract',HERE/'coordinator.py')
base=load('storage_retirement_private_transport',HERE.parent/'proposal-recovery.py')
gateway=load('storage_retirement_gateway_admission',HERE.parent/'storage-gateway-update.py')
d=base.access.d
MARKER='tenderdesk-storage-retirement'
UNCERTAIN='tenderdesk.io/storage-retirement-processes'
RESTORED='tenderdesk.io/storage-retirement-restored'

def literal(value):
 if isinstance(value,(dict,list)):value=c.canonical(value)
 return "'"+str(value).replace("'","''")+"'"
def pointer(value):return value.replace('~','~0').replace('/','~1')
def private_replace(path,data):
 c.require(not path.parent.is_symlink() and not path.parent.stat().st_mode&0o077 and not path.is_symlink(),'STORAGE_RETIREMENT_JOURNAL_INVALID')
 if path.exists():c.require(path.is_file() and not path.stat().st_mode&0o077,'STORAGE_RETIREMENT_JOURNAL_INVALID')
 temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
 try:
  descriptor=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(descriptor,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
  os.replace(temporary,path)
  directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try:os.fsync(directory)
  finally:os.close(directory)
 finally:temporary.unlink(missing_ok=True)
def patch(kind,name,current,operations):
 d.command(['patch',kind,name,'-n',d.NAMESPACE,'--type=json','--patch',json.dumps([
  {'op':'test','path':'/metadata/uid','value':current['metadata']['uid']},
  {'op':'test','path':'/metadata/resourceVersion','value':current['metadata']['resourceVersion']},*operations])])
def owned(value):
 c.require(value is not None and value.get('metadata',{}).get('namespace')==d.NAMESPACE and value['metadata'].get('labels',{}).get('app.kubernetes.io/managed-by')=='tenderdesk-deployment','STORAGE_RETIREMENT_OWNERSHIP_REQUIRED')
 return value

def guard_source():
 path=HERE.parents[2]/'supabase/migrations/20261104172700_storage_write_retirement_proofs.sql'
 text=path.read_text();start=text.index('create function public.guard_retired_storage_write()');end=text.index('end$$;',start)+len('end$$;')
 return text[start:end]

class KubernetesAdapter:
 def __init__(self,directory,client,selection):
  self.directory=Path(directory);self.client=client;self.selection=selection;self.nonce=selection['operation_nonce'];self.capture_value=None
  self.physical_pod='storage-retire-'+self.nonce;self.labels={'app.kubernetes.io/managed-by':MARKER,'tenderdesk.io/retirement':self.nonce}
  self.journal=self.directory/'storage-retirement-journal.json';self.helper=HERE/'physical.mjs';self.physical_uid=None
 def save(self):
  # Contains private keys/scope and observed manifests; never a public artifact.
  value={'version':1,'nonce':self.nonce,'selection':self.selection,'capture':self.capture_value,'client':{k:getattr(self.client,k) for k in ('base','nonce','pod','secret','labels','timeout')},'physical_pod':self.physical_pod,'physical_uid':self.physical_uid}
  private_replace(self.journal,c.canonical(value).encode())
 def sql(self,statement,role='tdp_app_owner'):
  c.require(role in ('tdp_app_owner',None),'STORAGE_RETIREMENT_ROLE_INVALID')
  pre="begin;set local statement_timeout='30s';set local lock_timeout='10s';set local search_path='';"
  if role:pre+='set local role '+role+';'
  return d.sql(self.client.pod,pre+statement+';commit;')
 def query(self,statement,role='tdp_app_owner'):return json.loads(self.sql(statement,role))
 def items(self,kind):
  result=json.loads(d.command(['get',kind,'-n',d.NAMESPACE,'-o','json']))
  c.require(isinstance(result.get('items'),list) and len(result['items'])<=1000,'STORAGE_RETIREMENT_RESOURCE_CENSUS_INVALID');return result['items']
 def validate_binary(self,expected):
  path=HERE.parents[2]/'docs/evidence/storage-retirement-binary-20261104.json'
  raw=path.read_bytes();c.require(c.digest(raw)==expected,'STORAGE_RETIREMENT_BINARY_RECEIPT_CHANGED')
  self.binary=json.loads(raw)
  # The exact schema is checked against the independently executed container
  # receipt, not a supplied assertion that the tag's public source matches it.
  c.require(self.binary.get('passed') is True and self.binary.get('actual_binary_exercised') is True and self.binary.get('production_calls')==0 and self.binary.get('customer_calls')==0,'STORAGE_RETIREMENT_BINARY_UNQUALIFIED')
  c.require(self.binary.get('storage_image')==c.STORAGE_IMAGE and self.binary.get('physical_module_sha256')==c.digest(self.helper.read_bytes()) and self.binary.get('guard_function_source_sha256')==c.digest(guard_source()),'STORAGE_RETIREMENT_BINARY_BINDING_CHANGED')
 def capture(self,selection):
  d.probe.validate_cluster();namespace=d.get('namespace',d.NAMESPACE)
  c.require(namespace and namespace['metadata']['uid']==selection['namespace_uid'] and namespace['metadata'].get('labels',{}).get('app.kubernetes.io/managed-by')=='tenderdesk-deployment','STORAGE_RETIREMENT_NAMESPACE_CHANGED')
  c.require(self.capture_value is None,'STORAGE_RETIREMENT_RESUME_REQUIRED')
  self.gateway_state=gateway.require_installed(d)
  service=owned(d.get('service','storage'));service_spec=service.get('spec',{})
  c.require(service_spec.get('type','ClusterIP')=='ClusterIP' and not any(service_spec.get(x) for x in ('externalIPs','externalName','loadBalancerIP')) and all(not p.get('nodePort') for p in service_spec.get('ports',[])),'STORAGE_RETIREMENT_DIRECT_STORAGE_EXPOSURE')
  hp=self.items('horizontalpodautoscalers')
  c.require(not any(x.get('spec',{}).get('scaleTargetRef',{}).get('name') in c.NAMES for x in hp),'STORAGE_RETIREMENT_AUTOSCALER_PRESENT')
  pods=self.items('pods');sets=self.items('replicasets');workloads={};selected_pods={}
  c.require(not any(p['metadata'].get('annotations',{}).get(c.ANNOTATION) or c.FINALIZER in p['metadata'].get('finalizers',[]) for p in pods),'STORAGE_RETIREMENT_UNRESOLVED_POD_PROOF')
  for name in c.NAMES:
   dep=owned(d.get('deployment',name));spec=dep['spec'];meta=dep['metadata'];expected=selection['expected_workloads'][name]
   containers=spec.get('template',{}).get('spec',{}).get('containers',[])
   c.require(meta['uid']==expected['uid'] and len(containers)==1 and containers[0].get('name')==name and containers[0].get('image')==expected['image'] and spec.get('replicas')==expected['replicas'],'STORAGE_RETIREMENT_DEPLOYMENT_CHANGED')
   if name=='storage':c.require(not containers[0].get('command') and not containers[0].get('args'),'STORAGE_RETIREMENT_STORAGE_ENTRYPOINT_CHANGED')
   c.require(not spec['template']['spec'].get('initContainers') and not spec['template']['spec'].get('ephemeralContainers'),'STORAGE_RETIREMENT_EXTRA_PROCESS_UNQUALIFIED')
   c.require(meta.get('annotations',{}).get(c.ANNOTATION) is None,'STORAGE_RETIREMENT_OTHER_OPERATION_PRESENT')
   c.require(meta.get('annotations',{}).get(UNCERTAIN) is None,'STORAGE_RETIREMENT_UNRESOLVED_POD_PROOF')
   status=dep.get('status',{});c.require(status.get('observedGeneration',0)>=meta.get('generation',0) and status.get('readyReplicas',0)==spec['replicas'] and status.get('updatedReplicas',0)==spec['replicas'] and status.get('unavailableReplicas',0)==0,'STORAGE_RETIREMENT_DEPLOYMENT_NOT_STABLE')
   selector=spec['selector']['matchLabels'];matching=[p for p in pods if all(p['metadata'].get('labels',{}).get(k)==v for k,v in selector.items())]
   c.require(len(matching)==spec['replicas'],'STORAGE_RETIREMENT_POD_CENSUS_CHANGED')
   parent_sets={x['metadata']['uid'] for x in sets if any(o.get('uid')==meta['uid'] and o.get('controller') is True for o in x['metadata'].get('ownerReferences',[]))}
   for p in matching:
    pm=p['metadata'];ps=p['spec'];statuses=p.get('status',{}).get('containerStatuses',[])
    c.require(not pm.get('deletionTimestamp') and not pm.get('finalizers') and pm.get('annotations',{}).get(c.ANNOTATION) is None and any(o.get('uid') in parent_sets and o.get('controller') is True for o in pm.get('ownerReferences',[])),'STORAGE_RETIREMENT_POD_LINEAGE_CHANGED')
    c.require(ps.get('containers')==containers and not ps.get('initContainers') and not ps.get('ephemeralContainers') and len(statuses)==1 and statuses[0].get('ready') is True and 'running' in statuses[0].get('state',{}),'STORAGE_RETIREMENT_POD_NOT_RUNNING')
   workloads[name]=dep;selected_pods[name]=matching
  labels=selected_pods['storage'][0]['metadata'].get('labels',{})
  c.require(labels.get('app.kubernetes.io/name')=='storage','STORAGE_RETIREMENT_NETWORK_BOUNDARY_CHANGED')
  for other_service in self.items('services'):
   target=other_service.get('spec',{}).get('selector',{})
   if target and all(labels.get(key)==value for key,value in target.items()):
    spec=other_service['spec']
    c.require(spec.get('type','ClusterIP')=='ClusterIP' and not any(spec.get(x) for x in ('externalIPs','externalName','loadBalancerIP')) and all(not p.get('nodePort') for p in spec.get('ports',[])),'STORAGE_RETIREMENT_DIRECT_STORAGE_EXPOSURE')
  policy=owned(d.get('networkpolicy','internal-services'))
  expected_policy={'podSelector':{'matchExpressions':[{'key':'app.kubernetes.io/name','operator':'NotIn','values':['https']}]},'policyTypes':['Ingress'],'ingress':[{'from':[{'podSelector':{}}]}]}
  c.require(policy.get('spec')==expected_policy,'STORAGE_RETIREMENT_NETWORK_BOUNDARY_CHANGED')
  for other in self.items('networkpolicies'):
   if other['metadata'].get('uid')==policy['metadata']['uid']:continue
   selector=other.get('spec',{}).get('podSelector',{})
   # The reviewed second policy selects HTTPS only. An additional policy that
   # might add Storage ingress requires separate review, never an inferred deny.
   if selector.get('matchLabels',{}).get('app.kubernetes.io/name') not in (None,'storage'):continue
   c.require(False,'STORAGE_RETIREMENT_ADDITIONAL_STORAGE_INGRESS')
  pvc=owned(d.get('pvc','private-objects'));storage=workloads['storage']['spec']['template']['spec'];mounts=storage['containers'][0].get('volumeMounts',[])
  target=[v for v in storage.get('volumes',[]) if v.get('persistentVolumeClaim',{}).get('claimName')=='private-objects']
  c.require(len(target)==1 and any(m.get('name')==target[0]['name'] and m.get('mountPath')=='/var/lib/storage' and not m.get('subPath') and not m.get('readOnly') for m in mounts),'STORAGE_RETIREMENT_PVC_IDENTITY_INVALID')
  # Only non-secret settings from the running pinned container. Absent separator
  # uses the pinned binary's qualified false default; both layouts are censused.
  names=['STORAGE_BACKEND','FILE_STORAGE_BACKEND_PATH','GLOBAL_S3_BUCKET','TENANT_ID','TUS_USE_FILE_VERSION_SEPARATOR','PG_QUEUE_ENABLE','S3_PROTOCOL_ENABLED']
  observed=json.loads(d.command(['exec',selected_pods['storage'][0]['metadata']['name'],'-n',d.NAMESPACE,'--','node','-e','process.stdout.write(JSON.stringify(Object.fromEntries('+json.dumps(names)+'.map(k=>[k,process.env[k]??null]))))']))
  c.require(observed['STORAGE_BACKEND']=='file' and observed['FILE_STORAGE_BACKEND_PATH']=='/var/lib/storage' and observed['PG_QUEUE_ENABLE']=='false' and observed['S3_PROTOCOL_ENABLED']=='false','STORAGE_RETIREMENT_STORAGE_CONFIGURATION_UNQUALIFIED')
  c.require(all(isinstance(observed[x],str) and re.fullmatch('[A-Za-z0-9_.-]{1,255}',observed[x]) and observed[x] not in ('.','..') for x in ('GLOBAL_S3_BUCKET','TENANT_ID')) and observed['TUS_USE_FILE_VERSION_SEPARATOR'] in (None,'true','false'),'STORAGE_RETIREMENT_STORAGE_CONFIGURATION_UNQUALIFIED')
  self.capture_value={'workloads':workloads,'pods':selected_pods,'pvc':pvc,'namespace_uid':selection['namespace_uid'],'storage_configuration':observed,'storage_ingress_policy_uid':policy['metadata']['uid']}
  self.save();return self.capture_value
 def install_fence(self,capture):
  observed=self.query("select jsonb_build_object('owner',pg_get_userbyid(proowner),'security_definer',prosecdef,'config',proconfig,'body_sha256',encode(sha256(convert_to(prosrc,'UTF8')),'hex')) from pg_proc where oid='public.guard_retired_storage_write()'::regprocedure",None)
  c.require(observed=={'owner':'tdp_app_owner','security_definer':True,'config':['search_path=""'],'body_sha256':self.binary.get('guard_body_sha256')},'STORAGE_RETIREMENT_INSTALLED_GUARD_CHANGED')
  # Explicitly inspect actual owners and require the connected administrator can
  # assume BOTH owners. Never create roles, broaden managed ownership or rely on
  # a presumed postgres superuser. A temporary CREATE TRIGGER execute grant is
  # revoked in the same transaction only when this transaction added it.
  self.sql("""do $retire$ declare storage_owner name;function_owner name;caller name:=current_user;had_execute boolean;begin
   if current_database()<>'tenderdesk_app' then raise exception 'STORAGE_RETIREMENT_DATABASE_MISMATCH';end if;
   select pg_get_userbyid(relowner) into storage_owner from pg_class where oid='storage.objects'::regclass;
   select pg_get_userbyid(proowner) into function_owner from pg_proc where oid='public.guard_retired_storage_write()'::regprocedure;
   if storage_owner is null or function_owner<>'tdp_app_owner' or not pg_has_role(session_user,storage_owner,'USAGE') or not pg_has_role(session_user,function_owner,'USAGE') then raise exception 'STORAGE_RETIREMENT_OWNER_AUTHORITY_REQUIRED';end if;
   if exists(select 1 from pg_trigger where tgrelid='storage.objects'::regclass and tgname='tenderdesk_retired_storage_write') then
    if not exists(select 1 from pg_trigger where tgrelid='storage.objects'::regclass and tgname='tenderdesk_retired_storage_write' and tgenabled='O' and tgtype=23 and tgfoid='public.guard_retired_storage_write()'::regprocedure) then raise exception 'STORAGE_RETIREMENT_FOREIGN_TRIGGER';end if;
   else
    had_execute:=has_function_privilege(storage_owner,'public.guard_retired_storage_write()','EXECUTE');
    execute format('set local role %I',function_owner);
    if not had_execute then execute format('grant execute on function public.guard_retired_storage_write() to %I',storage_owner);end if;
    execute format('set local role %I',storage_owner);
    execute 'create trigger tenderdesk_retired_storage_write before insert or update on storage.objects for each row execute function public.guard_retired_storage_write()';
    execute format('set local role %I',function_owner);
    if not had_execute then execute format('revoke execute on function public.guard_retired_storage_write() from %I',storage_owner);end if;
    execute format('set local role %I',caller);
   end if;end $retire$""",None)
  self.fence_sha=self.query("select to_jsonb(encode(sha256(convert_to(pg_get_functiondef('public.guard_retired_storage_write()'::regprocedure)||pg_get_triggerdef(oid),'UTF8')),'hex')) from pg_trigger where tgrelid='storage.objects'::regclass and tgname='tenderdesk_retired_storage_write'",None)
 def prepare(self,selection):return self.query('select app_private.prepare_storage_write_retirement('+literal(selection['actor_id'])+','+literal(selection['operation_nonce'])+','+literal(selection['selection'])+'::jsonb)')
 def census(self):
  # Every version/marker/archived row, and every uncertain metadata-free app key.
  return self.query("select coalesce(jsonb_agg(storage_key),'[]') from (select name storage_key from storage.objects where bucket_id='tenderdesk-private' union select key from storage.s3_multipart_uploads where bucket_id='tenderdesk-private' union select key from storage.s3_multipart_uploads_parts where bucket_id='tenderdesk-private' union select storage_key from public.storage_write_intents union select storage_key from public.storage_cleanup_queue union select storage_key from public.documents union select storage_key from public.export_artifacts union select storage_key from public.proposal_delivery_artifacts union select storage_key from public.export_package_volumes union select storage_key from public.restore_files) keys",None)
 def protect_pods(self,capture,nonce):
  # Keep the full original Pod identity set in the API before stopping anything.
  # It survives local journal loss and remains even if a Pod is force-removed by
  # an outside operator before kubelet termination could be observed.
  for name in c.NAMES:
   current=owned(d.get('deployment',name));old=capture['workloads'][name]
   c.require(current['metadata']['uid']==old['metadata']['uid'] and current['spec']==old['spec'] and current['metadata'].get('annotations',{}).get(UNCERTAIN) is None,'STORAGE_RETIREMENT_DEPLOYMENT_CHANGED')
   ops=[]
   if current['metadata'].get('annotations') is None:ops.append({'op':'add','path':'/metadata/annotations','value':{}})
   ops.append({'op':'add','path':'/metadata/annotations/'+pointer(UNCERTAIN),'value':c.canonical({'nonce':nonce,'pods':[{'name':p['metadata']['name'],'uid':p['metadata']['uid']} for p in capture['pods'][name]],'termination':{}})})
   patch('deployment',name,current,ops)
  for pods in capture['pods'].values():
   for old in pods:
    current=self.pod(old['metadata']['name']);c.require(current and current['metadata']['uid']==old['metadata']['uid'] and not current['metadata'].get('finalizers'),'STORAGE_RETIREMENT_POD_CHANGED')
    ops=[]
    if current['metadata'].get('annotations') is None:ops.append({'op':'add','path':'/metadata/annotations','value':{}})
    ops.extend([{'op':'add','path':'/metadata/annotations/'+pointer(c.ANNOTATION),'value':nonce},{'op':'add','path':'/metadata/finalizers','value':[c.FINALIZER]}])
    patch('pod',old['metadata']['name'],current,ops)
 def stop(self,capture,nonce):
  for name in c.NAMES:
   current=owned(d.get('deployment',name));old=capture['workloads'][name]
   c.require(current['metadata']['uid']==old['metadata']['uid'] and current['spec']==old['spec'],'STORAGE_RETIREMENT_DEPLOYMENT_CHANGED')
   ops=[]
   if current['metadata'].get('annotations') is None:ops.append({'op':'add','path':'/metadata/annotations','value':{}})
   # Durable journal survives a runner crash. Exact original replica count and
   # workload spec digest accompany the nonce; recovery never adopts a new spec.
   marker={'nonce':nonce,'replicas':old['spec']['replicas'],'spec_sha256':c.digest(c.canonical(old['spec']))}
   ops.extend([{'op':'add','path':'/metadata/annotations/'+pointer(c.ANNOTATION),'value':c.canonical(marker)},{'op':'replace','path':'/spec/replicas','value':0}])
   patch('deployment',name,current,ops)
 def assert_stopped(self,capture,name,nonce):
  current=owned(d.get('deployment',name));old=capture['workloads'][name];expected=copy.deepcopy(old['spec']);expected['replicas']=0
  marker=current['metadata'].get('annotations',{}).get(c.ANNOTATION)
  c.require(current['metadata']['uid']==old['metadata']['uid'] and current['spec']==expected and marker==c.canonical({'nonce':nonce,'replicas':old['spec']['replicas'],'spec_sha256':c.digest(c.canonical(old['spec']))}),'STORAGE_RETIREMENT_QUIESCENCE_CHANGED')
  permitted={p['metadata']['uid'] for p in capture['pods'][name]};selector=old['spec']['selector']['matchLabels']
  c.require(not any(all(p['metadata'].get('labels',{}).get(k)==v for k,v in selector.items()) and p['metadata']['uid'] not in permitted for p in self.items('pods')),'STORAGE_RETIREMENT_NEW_PROCESS_APPEARED')
  # The Deployment is intentionally scaled down, but its already-qualified
  # source/config must remain intact for the later service restoration.
  config=owned(d.get('configmap','gateway-config'))
  c.require(config['metadata']['uid']==self.gateway_state['config']['metadata']['uid'] and config.get('data')==self.gateway_state['after_data'],'STORAGE_RETIREMENT_GATEWAY_GUARD_CHANGED')
 def pod(self,name):return d.get('pod',name)
 def assert_no_other_pvc_writers(self,capture):
  current=owned(d.get('pvc','private-objects'));old=capture['pvc'];c.require(current['metadata']['uid']==old['metadata']['uid'] and current['spec']==old['spec'],'STORAGE_RETIREMENT_PVC_CHANGED')
  allowed={p['metadata']['uid'] for p in capture['pods']['storage']}
  if self.physical_uid:allowed.add(self.physical_uid)
  for p in self.items('pods'):
   if any(v.get('persistentVolumeClaim',{}).get('claimName')=='private-objects' for v in p.get('spec',{}).get('volumes',[])):
    c.require(p['metadata']['uid'] in allowed,'STORAGE_RETIREMENT_OTHER_PVC_WRITER')
 def assert_no_multipart(self,key):
  count=self.query("select to_jsonb((select count(*) from storage.s3_multipart_uploads where bucket_id='tenderdesk-private' and key="+literal(key)+")+(select count(*) from storage.s3_multipart_uploads_parts where bucket_id='tenderdesk-private' and key="+literal(key)+"))",None)
  c.require(count==0,'STORAGE_RETIREMENT_MULTIPART_PRESENT')
 def ensure_physical_pod(self):
  if self.physical_uid:
   current=d.get('pod',self.physical_pod);c.require(current and current['metadata']['uid']==self.physical_uid and current['metadata'].get('labels')==self.labels,'STORAGE_RETIREMENT_PHYSICAL_POD_CHANGED');return
  c.require(d.get('pod',self.physical_pod) is None,'STORAGE_RETIREMENT_PHYSICAL_POD_EXISTS')
  source=self.capture_value['pods']['storage'][0]
  c.require(all(p['spec']['nodeName']==source['spec']['nodeName'] for p in self.capture_value['pods']['storage']),'STORAGE_RETIREMENT_STORAGE_NODES_UNQUALIFIED')
  pod={'apiVersion':'v1','kind':'Pod','metadata':{'name':self.physical_pod,'namespace':d.NAMESPACE,'labels':self.labels},'spec':{
   'restartPolicy':'Never','activeDeadlineSeconds':1200,'automountServiceAccountToken':False,'nodeName':source['spec']['nodeName'],
   'securityContext':copy.deepcopy(source['spec']['securityContext']),
   'containers':[{'name':'physical','image':c.STORAGE_IMAGE,'command':['node','-e','setTimeout(()=>{},1100000)'],
    'securityContext':copy.deepcopy(source['spec']['containers'][0]['securityContext']),
    'resources':{'requests':{'cpu':'25m','memory':'32Mi'},'limits':{'cpu':'250m','memory':'128Mi'}},
    'volumeMounts':[{'name':'objects','mountPath':'/var/lib/storage'},{'name':'work','mountPath':'/run/storage-retirement'}]}],
   'volumes':[{'name':'objects','persistentVolumeClaim':{'claimName':'private-objects'}},{'name':'work','emptyDir':{'sizeLimit':'2Mi'}}]}}
  self.save() # deterministic nonce/name precedes create, including lost ACK
  d.command(['create','-f','-'],payload=json.dumps(pod));current=d.get('pod',self.physical_pod)
  c.require(current and current['metadata'].get('labels')==self.labels,'STORAGE_RETIREMENT_PHYSICAL_POD_CHANGED');self.physical_uid=current['metadata']['uid'];self.save()
  d.command(['wait','pod/'+self.physical_pod,'-n',d.NAMESPACE,'--for=condition=Ready','--timeout=90s'],timeout=100)
  self.write_physical('physical.mjs',self.helper.read_text())
 def write_physical(self,name,text):
  c.require(name in ('physical.mjs','scope.json','expected-manifest.json'),'STORAGE_RETIREMENT_FILE_INVALID')
  d.command(['exec','-i',self.physical_pod,'-n',d.NAMESPACE,'--','node','-e',"let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>require('fs').writeFileSync('/run/storage-retirement/"+name+"',s,{mode:0o600}));"],payload=text)
 def physical(self,item,nonce,mode,expected=None):
  self.ensure_physical_pod();self.assert_no_other_pvc_writers(self.capture_value)
  conf=self.capture_value['storage_configuration'];scope={'version':1,'operationNonce':nonce,'globalBucket':conf['GLOBAL_S3_BUCKET'],'tenantId':conf['TENANT_ID'],
   'bucketId':'tenderdesk-private','storageKey':item['storage_key'],'versionSeparator':'-$v-' if conf['TUS_USE_FILE_VERSION_SEPARATOR']=='true' else '/'}
  self.write_physical('scope.json',c.canonical(scope))
  if expected is not None:self.write_physical('expected-manifest.json',c.canonical(expected))
  value=json.loads(d.command(['exec',self.physical_pod,'-n',d.NAMESPACE,'--','node','/run/storage-retirement/physical.mjs',mode],timeout=90))
  # Independently check helper output binding and complete manifest, not just a
  # success exit. The helper also checks inode identity and fsyncs deletions.
  c.require(value.get('version')==1 and value.get('operationNonce')==nonce and value.get('scopeSha256')==c.digest(c.canonical(scope)) and isinstance(value.get('files'),list),'STORAGE_RETIREMENT_PHYSICAL_RECEIPT_INVALID')
  unsigned={k:value[k] for k in ('version','operationNonce','scopeSha256','files','absent')}
  c.require(value.get('manifestSha256')==c.digest(c.canonical(unsigned)),'STORAGE_RETIREMENT_PHYSICAL_RECEIPT_INVALID')
  return value
 def inspect_physical(self,item,nonce):return self.physical(item,nonce,'inspect')
 def remove_physical(self,item,nonce,expected):return self.physical(item,nonce,'remove',expected)
 def delete_metadata(self,key):
  # Pinned server protects direct DELETE; this exact local setting is verified
  # by the independent binary fixture before this adapter is enabled.
  self.sql("do $retire$ declare owner_name name;begin select pg_get_userbyid(relowner) into owner_name from pg_class where oid='storage.objects'::regclass; if not pg_has_role(session_user,owner_name,'USAGE') then raise exception 'STORAGE_RETIREMENT_OWNER_AUTHORITY_REQUIRED';end if;execute format('set local role %I',owner_name);end $retire$; set local storage.allow_delete_query='true';delete from storage.objects where bucket_id='tenderdesk-private' and name="+literal(key),None)
 def metadata_remaining(self,key):return self.query("select to_jsonb(count(*)) from storage.objects where bucket_id='tenderdesk-private' and name="+literal(key),None)
 def identity(self):
  revision=os.environ.get('GITHUB_SHA','');run=os.environ.get('GITHUB_RUN_ID','');attempt=os.environ.get('GITHUB_RUN_ATTEMPT','')
  c.require(re.fullmatch('[a-f0-9]{40}',revision) and re.fullmatch('[0-9]{1,20}',run) and re.fullmatch('[0-9]{1,6}',attempt),'STORAGE_RETIREMENT_RUN_IDENTITY_INVALID')
  return {'source_revision':revision,'run_id':run,'run_attempt':attempt,'namespace_uid':self.selection['namespace_uid'],
   'cluster_id':'a6093a76-a2d6-47fd-8697-579d41ed316f','physical_helper_sha256':c.digest(self.helper.read_bytes()),'fence_sha256':self.fence_sha}
 def finish(self,selection,batch,evidence):
  # Keep the exact submitted proof before its commit, so a lost ACK can replay.
  base.transfer.write_private(self.directory/'storage-retirement-proof.json',c.canonical(evidence).encode())
  return self.query('select app_private.finish_storage_write_retirement('+literal(selection['actor_id'])+','+literal(selection['operation_nonce'])+','+literal(evidence)+'::jsonb)')
 def restore(self,capture,nonce):
  failed=False;unproven=False
  # Attempt each independent restoration even after another one fails. No
  # force-delete, foreign finalizer removal, or overwriting a changed workload.
  try:
   current=d.get('pod',self.physical_pod)
   if current:
    c.require(current['metadata'].get('labels')==self.labels and (self.physical_uid is None or current['metadata']['uid']==self.physical_uid),'STORAGE_RETIREMENT_FOREIGN_PHYSICAL_POD')
    d.command(['delete','pod',self.physical_pod,'-n',d.NAMESPACE,'--wait=true','--timeout=90s'],timeout=100)
  except Exception:failed=True
  for name in reversed(c.NAMES):
   # Restore/fence the Deployment first. A fresh metadata value advances its
   # resourceVersion even when replicas were already restored; a delayed old
   # scale-zero CAS cannot then remove a live Pod after its finalizer is cleared.
   try:
    current=owned(d.get('deployment',name));old=capture['workloads'][name];annotation=current['metadata'].get('annotations',{}).get(c.ANNOTATION)
    if name=='gateway':gateway.require_restart_guard(d)
    c.require(current['metadata']['uid']==old['metadata']['uid'],'STORAGE_RETIREMENT_FOREIGN_DEPLOYMENT')
    if annotation is None and current['metadata'].get('annotations',{}).get(UNCERTAIN) is None:
     c.require(current['spec']==old['spec'],'STORAGE_RETIREMENT_RESTORE_SPEC_CHANGED')
     continue # no stop/protection journal was committed for this workload
    ops=[]
    if current['metadata'].get('annotations') is None:ops.append({'op':'add','path':'/metadata/annotations','value':{}})
    ops.append({'op':'add','path':'/metadata/annotations/'+pointer(RESTORED),'value':nonce+':'+str(uuid.uuid4())})
    if annotation is None:c.require(current['spec']==old['spec'],'STORAGE_RETIREMENT_RESTORE_SPEC_CHANGED')
    else:
     marker=c.canonical({'nonce':nonce,'replicas':old['spec']['replicas'],'spec_sha256':c.digest(c.canonical(old['spec']))})
     expected=copy.deepcopy(old['spec']);expected['replicas']=0
     c.require(annotation==marker and current['spec']==expected,'STORAGE_RETIREMENT_RESTORE_SPEC_CHANGED')
     ops.extend([{'op':'test','path':'/metadata/annotations/'+pointer(c.ANNOTATION),'value':marker},
      {'op':'test','path':'/spec/replicas','value':0},{'op':'replace','path':'/spec/replicas','value':old['spec']['replicas']},
      {'op':'remove','path':'/metadata/annotations/'+pointer(c.ANNOTATION)}])
    patch('deployment',name,current,ops)
   except Exception:failed=True;continue
   try:
    if not self.release_proven_pods(capture,name,nonce):unproven=True
   except Exception:failed=True
  for name in reversed(c.NAMES):
   try:d.command(['rollout','status','deployment/'+name,'-n',d.NAMESPACE,'--timeout=180s'],timeout=190)
   except Exception:failed=True
  if failed:raise c.RetirementError('STORAGE_RETIREMENT_SERVICE_RESTORATION_REQUIRED')
  if unproven:raise c.RetirementError('STORAGE_RETIREMENT_PROCESS_RECONCILIATION_REQUIRED')
  private_replace(self.directory/'storage-retirement-restored.json',c.canonical({'nonce':nonce,'services_restored':True}).encode())
 def recovery_capture(self):
  """Restore original replicas from durable nonce markers, never retire bytes.

  A killed runner's local journal is not assumed available. The reviewed private
  selection binds workload UID/image/original replicas; markers bind the entire
  original spec. Changed resources require explicit operator reconciliation.
  """
  d.probe.validate_cluster();namespace=d.get('namespace',d.NAMESPACE)
  c.require(namespace and namespace['metadata']['uid']==self.selection['namespace_uid'],'STORAGE_RETIREMENT_NAMESPACE_CHANGED')
  self.gateway_state=gateway.require_restart_guard(d)
  capture={'workloads':{},'pods':{}};pods=self.items('pods');sets=self.items('replicasets')
  for name in c.NAMES:
   dep=owned(d.get('deployment',name));expected=self.selection['expected_workloads'][name];spec=dep['spec'];containers=spec.get('template',{}).get('spec',{}).get('containers',[])
   c.require(dep['metadata']['uid']==expected['uid'] and len(containers)==1 and containers[0].get('name')==name and containers[0].get('image')==expected['image'],'STORAGE_RETIREMENT_RESTORE_SPEC_CHANGED')
   original=copy.deepcopy(dep);original['spec']['replicas']=expected['replicas']
   marker=dep['metadata'].get('annotations',{}).get(c.ANNOTATION)
   if marker is not None:
    c.require(spec.get('replicas')==0 and marker==c.canonical({'nonce':self.nonce,'replicas':expected['replicas'],'spec_sha256':c.digest(c.canonical(original['spec']))}),'STORAGE_RETIREMENT_RESTORE_SPEC_CHANGED')
   else:c.require(spec.get('replicas')==expected['replicas'],'STORAGE_RETIREMENT_RESTORE_SPEC_CHANGED')
   parents={x['metadata']['uid'] for x in sets if any(o.get('uid')==dep['metadata']['uid'] and o.get('controller') is True for o in x['metadata'].get('ownerReferences',[]))}
   saved=dep['metadata'].get('annotations',{}).get(UNCERTAIN)
   retained=[]
   if saved is not None:
    saved=json.loads(saved);c.require(set(saved)=={'nonce','pods','termination'} and saved['nonce']==self.nonce and isinstance(saved['pods'],list) and 1<=len(saved['pods'])<=100,'STORAGE_RETIREMENT_FOREIGN_POD_JOURNAL')
    c.require(isinstance(saved['termination'],dict) and set(saved['termination'])<=set(p['uid'] for p in saved['pods']),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
    for identity in saved['pods']:
     c.require(set(identity)=={'name','uid'} and c.valid_uuid(identity['uid']) and isinstance(identity['name'],str) and re.fullmatch('[a-z0-9-]{1,253}',identity['name']),'STORAGE_RETIREMENT_FOREIGN_POD_JOURNAL')
     found=next((p for p in pods if p['metadata']['name']==identity['name'] and p['metadata']['uid']==identity['uid']),None)
     if found:c.require(any(o.get('uid') in parents and o.get('controller') is True for o in found['metadata'].get('ownerReferences',[])),'STORAGE_RETIREMENT_POD_LINEAGE_CHANGED')
     if identity['uid'] in saved['termination']:c.validate_saved_termination(saved['termination'][identity['uid']],identity['uid'])
     retained.append(found or {'metadata':identity,'spec':{}})
   capture['workloads'][name]=original;capture['pods'][name]=retained
  self.capture_value=capture;physical=d.get('pod',self.physical_pod)
  if physical:
   c.require(physical['metadata'].get('labels')==self.labels,'STORAGE_RETIREMENT_FOREIGN_PHYSICAL_POD');self.physical_uid=physical['metadata']['uid']
  self.save();return capture

 def drain_saved_processes(self):
  """Explicitly finish an interrupted stop; never release file allowance.

  Raw Kubernetes DELETE accepts an exact DeleteOptions body, so uid AND
  resourceVersion preconditions survive the network boundary. The Pod's normal
  configured grace remains in force. Its finalizer is retained until real exit.
  """
  capture=self.recovery_capture()
  try:
   try:self.restore(capture,self.nonce)
   except c.RetirementError as error:
    if str(error)!='STORAGE_RETIREMENT_PROCESS_RECONCILIATION_REQUIRED':raise
   capture=self.recovery_capture()
   for name in c.NAMES:
    for old in capture['pods'][name]:
     if self.saved_process_exit(name,old['metadata']['uid']):continue
     current=self.pod(old['metadata']['name'])
     c.require(current is not None and current['metadata']['uid']==old['metadata']['uid'],'STORAGE_RETIREMENT_PROCESS_RECONCILIATION_REQUIRED')
     if current['metadata'].get('annotations',{}).get(c.ANNOTATION) is None and not current['metadata'].get('finalizers'):
      ops=[]
      if current['metadata'].get('annotations') is None:ops.append({'op':'add','path':'/metadata/annotations','value':{}})
      ops.extend([{'op':'add','path':'/metadata/annotations/'+pointer(c.ANNOTATION),'value':self.nonce},{'op':'add','path':'/metadata/finalizers','value':[c.FINALIZER]}])
      patch('pod',old['metadata']['name'],current,ops);current=self.pod(old['metadata']['name'])
     if c.terminated_pod(old,current,self.nonce) is not None:continue
     grace=current['spec'].get('terminationGracePeriodSeconds',30)
     c.require(type(grace) is int and 1<=grace<=600,'STORAGE_RETIREMENT_GRACE_UNQUALIFIED')
     if not current['metadata'].get('deletionTimestamp'):
      path='/api/v1/namespaces/'+d.NAMESPACE+'/pods/'+old['metadata']['name']
      options={'apiVersion':'v1','kind':'DeleteOptions','preconditions':{'uid':current['metadata']['uid'],'resourceVersion':current['metadata']['resourceVersion']},'gracePeriodSeconds':grace,'propagationPolicy':'Background'}
      d.command(['delete','--raw',path,'--filename=-'],payload=json.dumps(options))
   deadline=time.monotonic()+660
   while True:
    ready=True
    for name,pods in capture['pods'].items():
     for old in pods:
      if self.saved_process_exit(name,old['metadata']['uid']):continue
      current=self.pod(old['metadata']['name'])
      c.require(current is not None,'STORAGE_RETIREMENT_PROCESS_RECONCILIATION_REQUIRED')
      if current['metadata'].get('annotations',{}).get(c.ANNOTATION) is None and c.FINALIZER not in current['metadata'].get('finalizers',[]):continue
      if c.terminated_pod(old,current,self.nonce) is None:ready=False
    if ready:break
    c.require(time.monotonic()<deadline,'STORAGE_RETIREMENT_PROCESS_RECONCILIATION_REQUIRED');time.sleep(2)
  finally:self.restore(capture,self.nonce)

 def saved_process_exit(self,name,uid):
  dep=owned(d.get('deployment',name));raw=dep['metadata'].get('annotations',{}).get(UNCERTAIN)
  if raw is None:return False
  journal=json.loads(raw)
  c.require(journal.get('nonce')==self.nonce and isinstance(journal.get('termination'),dict),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
  if uid not in journal['termination']:return False
  c.validate_saved_termination(journal['termination'][uid],uid);return True

 def release_proven_pods(self,capture,name,nonce):
  """Persist all original UID exit proofs before removing any finalizer.

  This two-phase cleanup survives immediate Kubernetes garbage collection and
  lost finalizer-removal ACKs. A mixed terminal/live group remains fully retained.
  """
  dep=owned(d.get('deployment',name));raw=dep['metadata'].get('annotations',{}).get(UNCERTAIN)
  if raw is None:
   # No protected-process journal was ever committed for this workload.
   c.require(not any((self.pod(p['metadata']['name']) or {}).get('metadata',{}).get('annotations',{}).get(c.ANNOTATION)==nonce for p in capture['pods'][name]),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
   return True
  journal=json.loads(raw);identities=[{'name':p['metadata']['name'],'uid':p['metadata']['uid']} for p in capture['pods'][name]]
  c.require(set(journal)=={'nonce','pods','termination'} and journal['nonce']==nonce and journal['pods']==identities and isinstance(journal['termination'],dict) and set(journal['termination'])<=set(p['uid'] for p in identities),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
  proofs=copy.deepcopy(journal['termination']);complete=True
  for old in capture['pods'][name]:
   uid=old['metadata']['uid']
   if uid in proofs:c.validate_saved_termination(proofs[uid],uid);continue
   current=self.pod(old['metadata']['name'])
   if current is None:complete=False;continue
   c.require(current['metadata']['uid']==uid,'STORAGE_RETIREMENT_FOREIGN_POD')
   if current['metadata'].get('annotations',{}).get(c.ANNOTATION)!=nonce or c.FINALIZER not in current['metadata'].get('finalizers',[]):complete=False;continue
   proof=c.terminated_pod(old,current,nonce)
   if proof is None:complete=False
   else:proofs[uid]=proof
  # Persist observations even for a mixed group, but do not delete any record
  # until the whole group is known terminal. Partial/failed CAS leaves it intact.
  if proofs!=journal['termination']:
   updated={**journal,'termination':proofs}
   patch('deployment',name,dep,[{'op':'test','path':'/metadata/annotations/'+pointer(UNCERTAIN),'value':raw},{'op':'replace','path':'/metadata/annotations/'+pointer(UNCERTAIN),'value':c.canonical(updated)}])
   journal=updated;raw=c.canonical(updated)
  if not complete:return False
  for old in capture['pods'][name]:
   uid=old['metadata']['uid'];c.validate_saved_termination(proofs[uid],uid)
   current=self.pod(old['metadata']['name'])
   if current is None:continue # exact real exit proof was durably saved first
   c.require(current['metadata']['uid']==uid,'STORAGE_RETIREMENT_FOREIGN_POD')
   annotation=current['metadata'].get('annotations',{}).get(c.ANNOTATION);finalizers=current['metadata'].get('finalizers',[])
   if annotation is None and c.FINALIZER not in finalizers:continue
   c.require(annotation==nonce and finalizers==[c.FINALIZER],'STORAGE_RETIREMENT_FOREIGN_POD')
   patch('pod',old['metadata']['name'],current,[{'op':'test','path':'/metadata/annotations/'+pointer(c.ANNOTATION),'value':nonce},
    {'op':'test','path':'/metadata/finalizers','value':[c.FINALIZER]},{'op':'remove','path':'/metadata/finalizers'},
    {'op':'remove','path':'/metadata/annotations/'+pointer(c.ANNOTATION)}])
  dep=owned(d.get('deployment',name))
  c.require(dep['metadata'].get('annotations',{}).get(UNCERTAIN)==raw,'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
  patch('deployment',name,dep,[{'op':'test','path':'/metadata/annotations/'+pointer(UNCERTAIN),'value':raw},{'op':'remove','path':'/metadata/annotations/'+pointer(UNCERTAIN)}])
  return True
