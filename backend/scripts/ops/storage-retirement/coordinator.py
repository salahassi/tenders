#!/usr/bin/env python3
"""Owner-selected storage retirement, using observed process and physical proof.

Only the original-CA GitHub runner adapter calls Kubernetes. Unit tests inject
an in-memory adapter; they prove control flow, not real kubelet/Storage behavior.
No age, client timeout, missing object, or replica count alone releases quota.
"""
from __future__ import annotations
import copy
from datetime import datetime, timezone
import hashlib
import json
import re
import time
import uuid

STORAGE_IMAGE='docker.io/supabase/storage-api:v1.81.0@sha256:92c5fe87ba5291915d0c21ca530ece9a58e13cc76a36a6c84fc69121a8dde799'
NAMES=('worker','gateway','storage')
FINALIZER='tenderdesk.io/storage-retirement'
ANNOTATION='tenderdesk.io/storage-retirement'
MAX_KEYS=25

class RetirementError(Exception):pass

def require(condition,code):
 if not condition:raise RetirementError(code)
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def digest(value):return hashlib.sha256(value if isinstance(value,bytes) else value.encode()).hexdigest()
def valid_uuid(value):
 try:return isinstance(value,str) and str(uuid.UUID(value))==value
 except (ValueError,TypeError,AttributeError):return False

def validate_selection(value):
 require(isinstance(value,dict) and set(value)=={'version','operation_nonce','actor_id','selection','namespace_uid','expected_workloads','binary_receipt_sha256'},'STORAGE_RETIREMENT_SELECTION_INVALID')
 require(type(value['version']) is int and value['version']==1 and all(valid_uuid(value[k]) for k in ('operation_nonce','actor_id','namespace_uid')),'STORAGE_RETIREMENT_SELECTION_INVALID')
 require(isinstance(value['binary_receipt_sha256'],str) and re.fullmatch('[a-f0-9]{64}',value['binary_receipt_sha256']),'STORAGE_RETIREMENT_SELECTION_INVALID')
 selected=value['selection'];require(isinstance(selected,list) and 1<=len(selected)<=MAX_KEYS,'STORAGE_RETIREMENT_SELECTION_INVALID')
 require(len({x.get('id') for x in selected if isinstance(x,dict)})==len(selected),'STORAGE_RETIREMENT_SELECTION_INVALID')
 for x in selected:
  require(isinstance(x,dict) and set(x)=={'id','storage_key','retirement_nonce','revision'} and valid_uuid(x['id']) and valid_uuid(x['retirement_nonce']) and type(x['revision']) is int and 1<=x['revision']<=2147483647,'STORAGE_RETIREMENT_SELECTION_INVALID')
  validate_key(x['storage_key'])
  cparts=x['storage_key'].split('/')
  require(len(cparts)<=32 and all(re.fullmatch(r'[A-Za-z0-9_.-]{1,255}',part) for part in cparts),'STORAGE_RETIREMENT_PHYSICAL_KEY_UNQUALIFIED')
 expected=value['expected_workloads'];require(isinstance(expected,dict) and set(expected)==set(NAMES),'STORAGE_RETIREMENT_SELECTION_INVALID')
 for name,x in expected.items():
  require(isinstance(x,dict) and set(x)=={'uid','image','replicas'} and valid_uuid(x['uid']) and type(x['replicas']) is int and 1<=x['replicas']<=99 and isinstance(x['image'],str) and re.fullmatch(r'[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}',x['image']),'STORAGE_RETIREMENT_SELECTION_INVALID')
  if name=='storage':require(x['image']==STORAGE_IMAGE,'STORAGE_RETIREMENT_UNQUALIFIED_BINARY')
 return value

def validate_key(key):
 require(isinstance(key,str) and 1<=len(key.encode())<=1024 and not key.startswith('/') and all(part not in ('','.','..') for part in key.split('/')) and not any(ord(c)<32 or c in '\\\x7f' for c in key),'STORAGE_RETIREMENT_KEY_INVALID')
 return key

def overlapping(a,b):
 # Conservative namespace protection. It includes unknown old separator flags
 # and sidecar aliases. It never guesses that an orphan path has no other owner.
 return a==b or any(a.startswith(b+s) or b.startswith(a+s) for s in ('/','-$v-','.info'))

def check_collisions(selected,census):
 require(isinstance(census,list) and len(census)<=100000,'STORAGE_RETIREMENT_CENSUS_TOO_LARGE')
 keys=[validate_key(x) for x in selected]
 for n,a in enumerate(keys):
  require(not any(overlapping(a,b) for b in keys[n+1:]),'STORAGE_RETIREMENT_NAMESPACE_COLLISION')
 for key in census:
  validate_key(key)
  if key in keys:continue
  require(not any(overlapping(key,selected) for selected in keys),'STORAGE_RETIREMENT_NAMESPACE_COLLISION')

def container_identities(pod):
 expected={x['name'] for x in pod['spec']['containers']};statuses=pod.get('status',{}).get('containerStatuses',[])
 require(isinstance(statuses,list) and len(statuses)==len(expected),'STORAGE_RETIREMENT_PROCESS_PROOF_INVALID')
 result=[]
 for status in statuses:
  name=status.get('name');cid=status.get('containerID')
  require(name in expected and isinstance(cid,str) and re.fullmatch(r'(containerd|docker|cri-o)://[a-f0-9]{64}',cid),'STORAGE_RETIREMENT_PROCESS_PROOF_INVALID')
  result.append({'name':name,'container_id':cid})
 require(len({x['name'] for x in result})==len(expected),'STORAGE_RETIREMENT_PROCESS_PROOF_INVALID')
 return sorted(result,key=lambda x:x['name'])

def pod_identity(pod):
 return {'name':pod['metadata']['name'],'uid':pod['metadata']['uid'],'containers':container_identities(pod)}

def validate_identity(identity):
 require(isinstance(identity,dict) and set(identity)=={'name','uid','containers'} and valid_uuid(identity['uid']) and isinstance(identity['name'],str) and re.fullmatch('[a-z0-9-]{1,253}',identity['name']),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
 cs=identity['containers'];require(isinstance(cs,list) and 1<=len(cs)<=10,'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
 for x in cs:
  require(isinstance(x,dict) and set(x)=={'name','container_id'} and isinstance(x['name'],str) and re.fullmatch('[a-z0-9-]{1,63}',x['name']) and isinstance(x['container_id'],str) and re.fullmatch(r'(containerd|docker|cri-o)://[a-f0-9]{64}',x['container_id']),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
 require(len({x['name'] for x in cs})==len(cs) and cs==sorted(cs,key=lambda x:x['name']),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
 return identity

def validate_saved_termination(value,uid,expected):
 require(isinstance(value,dict) and set(value)=={'uid','containers'} and value['uid']==uid and isinstance(value['containers'],list) and len(value['containers'])==len(expected),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
 ids={x['name']:x['container_id'] for x in expected};names=[]
 for item in value['containers']:
  require(isinstance(item,dict) and set(item)=={'name','container_id','started_at','finished_at','exit_code','reason'} and item['name'] in ids and item['container_id']==ids[item['name']] and type(item['exit_code']) is int and 0<=item['exit_code']<=255 and item['reason'] in ('Completed','Error','OOMKilled'),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
  stamps=[]
  for key in ('started_at','finished_at'):
   raw=item[key]
   require(isinstance(raw,str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+]00:00)',raw),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
   try:stamp=datetime.fromisoformat(raw.replace('Z','+00:00'))
   except ValueError:raise RetirementError('STORAGE_RETIREMENT_POD_JOURNAL_INVALID') from None
   require(datetime(1970,1,1,tzinfo=timezone.utc)<stamp<=datetime.now(timezone.utc),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID');stamps.append(stamp)
  require(stamps[0]<=stamps[1],'STORAGE_RETIREMENT_POD_JOURNAL_INVALID');names.append(item['name'])
 require(len(set(names))==len(ids),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
 return value

def validate_process_journal(value,nonce):
 require(isinstance(value,dict) and set(value)=={'nonce','pods','termination'} and value['nonce']==nonce and isinstance(value['pods'],list) and 1<=len(value['pods'])<=100 and isinstance(value['termination'],dict),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
 for identity in value['pods']:validate_identity(identity)
 require(len({p['uid'] for p in value['pods']})==len(value['pods']) and len({p['name'] for p in value['pods']})==len(value['pods']) and set(value['termination'])<=set(p['uid'] for p in value['pods']),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
 for identity in value['pods']:
  if identity['uid'] in value['termination']:validate_saved_termination(value['termination'][identity['uid']],identity['uid'],identity['containers'])
 return value

def terminated_pod(original,current,nonce):
 require(current is not None,'STORAGE_RETIREMENT_POD_DISAPPEARED_WITHOUT_PROOF')
 meta=current.get('metadata',{});old=original['metadata']
 require(meta.get('uid')==old['uid'] and meta.get('annotations',{}).get(ANNOTATION)==nonce and FINALIZER in meta.get('finalizers',[]),'STORAGE_RETIREMENT_POD_OWNERSHIP_CHANGED')
 require(current.get('spec')==original.get('spec'),'STORAGE_RETIREMENT_POD_SPEC_CHANGED')
 if not meta.get('deletionTimestamp') and current.get('status',{}).get('phase') not in ('Succeeded','Failed'):return None
 require(current.get('status',{}).get('reason') not in ('NodeLost','ContainerStatusUnknown'),'STORAGE_RETIREMENT_PROCESS_PROOF_INVALID')
 expected=container_identities(original);statuses=current.get('status',{}).get('containerStatuses',[])
 require(isinstance(statuses,list),'STORAGE_RETIREMENT_PROCESS_PROOF_INVALID')
 if len(statuses)!=len(expected):return None
 require(container_identities(current)==expected,'STORAGE_RETIREMENT_PROCESS_PROOF_INVALID')
 result=[]
 for status in statuses:
  state=status.get('state',{}).get('terminated')
  if not state:return None
  result.append({'name':status['name'],'container_id':state.get('containerID'),'started_at':state.get('startedAt'),
   'finished_at':state.get('finishedAt'),'exit_code':state.get('exitCode'),'reason':state.get('reason')})
 proof={'uid':old['uid'],'containers':sorted(result,key=lambda x:x['name'])}
 try:return validate_saved_termination(proof,old['uid'],expected)
 except RetirementError:raise RetirementError('STORAGE_RETIREMENT_PROCESS_PROOF_INVALID') from None

def database_process_proof(proof):
 # The trusted runner validated the stronger exit proof. Keep the existing SQL
 # evidence shape; durable Kubernetes journals retain reason/start and identities.
 return {'uid':proof['uid'],'containers':[{k:v for k,v in item.items() if k not in ('started_at','reason')} for item in proof['containers']]}

def retire(adapter,selection,*,clock=time.monotonic,pause=time.sleep,timeout=420):
 """Finish only after actual old-container exit + exact metadata/PVC absence.

 Restore is attempted for every captured workload even if capture/prepare/stop/
 reconciliation/finish fails. The adapter retains a durable nonce journal before
 each mutation, including ambiguous API responses; cleanup never force-deletes.
 """
 validate_selection(selection);nonce=selection['operation_nonce'];capture=None;batch=None;receipt=None
 try:
  adapter.validate_binary(selection['binary_receipt_sha256'])
  capture=adapter.capture(selection)
  adapter.install_fence(capture)
  # Do not install a permanent family fence over a known live/uncertain alias.
  # Repeat after prepare and after drain to catch races before any deletion.
  check_collisions([x['storage_key'] for x in selection['selection']],adapter.census())
  batch=adapter.prepare(selection)
  if batch['state']=='complete':return batch
  check_collisions([x['storage_key'] for x in batch['scope']],adapter.census())
  adapter.protect_pods(capture,nonce)
  adapter.stop(capture,nonce)
  deadline=clock()+timeout
  operation_deadline=deadline+900
  while True:
   proofs=[];complete=True
   for name in NAMES:
    adapter.assert_stopped(capture,name,nonce)
    pods=[]
    for original in capture['pods'][name]:
     result=terminated_pod(original,adapter.pod(original['metadata']['name']),nonce)
     if result is None:complete=False
     else:pods.append(database_process_proof(result))
    expected=capture['workloads'][name]
    proofs.append({'name':name,'deployment_uid':expected['metadata']['uid'],'image':expected['spec']['template']['spec']['containers'][0]['image'],
      'original_replicas':expected['spec']['replicas'],'pods':pods})
   if complete:break
   require(clock()<deadline,'STORAGE_RETIREMENT_DRAIN_NOT_PROVEN');pause(min(2,max(0,deadline-clock())))
  # Re-read after all writers stopped, including keys with absent metadata.
  check_collisions([x['storage_key'] for x in batch['scope']],adapter.census())
  adapter.assert_no_other_pvc_writers(capture)
  keys=[]
  for item in batch['scope']:
   require(clock()<operation_deadline,'STORAGE_RETIREMENT_OPERATION_DEADLINE')
   for name in NAMES:adapter.assert_stopped(capture,name,nonce)
   adapter.assert_no_multipart(item['storage_key'])
   inspected=adapter.inspect_physical(item,nonce)
   removed=adapter.remove_physical(item,nonce,inspected)
   require(removed.get('remainingCount')==0 and removed.get('absent') is True,'STORAGE_RETIREMENT_PHYSICAL_REMAINS')
   adapter.delete_metadata(item['storage_key'])
   require(adapter.metadata_remaining(item['storage_key'])==0,'STORAGE_RETIREMENT_METADATA_REMAINS')
   after=adapter.inspect_physical(item,nonce)
   require(after.get('absent') is True and after.get('files')==[] and after.get('manifestSha256')==removed.get('afterManifestSha256'),'STORAGE_RETIREMENT_PHYSICAL_CHANGED')
   keys.append({'id':item['id'],'retirement_nonce':item['retirement_nonce'],'storage_key_sha256':digest(item['storage_key']),
    'before_manifest_sha256':removed['beforeManifestSha256'],'after_manifest_sha256':removed['afterManifestSha256'],
    'remaining_count':0,'metadata_remaining':0,'removed_count':removed['removedCount'],'removed_bytes':removed['removedBytes']})
  for name in NAMES:adapter.assert_stopped(capture,name,nonce)
  evidence={**adapter.identity(),'version':1,'operation_nonce':nonce,'scope_sha256':batch['scope_sha256'],
   'storage_image':STORAGE_IMAGE,'quiescence':proofs,'keys':keys}
  receipt=adapter.finish(selection,batch,evidence)
  require(receipt.get('state')=='complete','STORAGE_RETIREMENT_COMPLETION_NOT_CONFIRMED')
  return receipt
 finally:
  if capture is not None:adapter.restore(capture,nonce)
