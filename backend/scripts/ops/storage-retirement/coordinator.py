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

def terminated_pod(original,current,nonce):
 require(current is not None,'STORAGE_RETIREMENT_POD_DISAPPEARED_WITHOUT_PROOF')
 meta=current.get('metadata',{});old=original['metadata']
 require(meta.get('uid')==old['uid'] and meta.get('annotations',{}).get(ANNOTATION)==nonce and FINALIZER in meta.get('finalizers',[]),'STORAGE_RETIREMENT_POD_OWNERSHIP_CHANGED')
 require(current.get('spec')==original.get('spec'),'STORAGE_RETIREMENT_POD_SPEC_CHANGED')
 # A container can temporarily terminate in a live restartPolicy=Always Pod.
 # Only a deleting or terminal-phase Pod establishes that it cannot restart.
 if not meta.get('deletionTimestamp') and current.get('status',{}).get('phase') not in ('Succeeded','Failed'):return None
 expected={x['name'] for x in original['spec']['containers']}
 statuses=current.get('status',{}).get('containerStatuses',[])
 require(isinstance(statuses,list),'STORAGE_RETIREMENT_PROCESS_PROOF_INVALID')
 if len(statuses)!=len(expected):return None
 result=[]
 for status in statuses:
  require(status.get('name') in expected,'STORAGE_RETIREMENT_PROCESS_PROOF_INVALID')
  state=status.get('state',{}).get('terminated')
  if not state:return None
  cid=state.get('containerID',status.get('containerID'))
  require(isinstance(cid,str) and re.fullmatch(r'(containerd|docker|cri-o)://[a-f0-9]{64}',cid) and type(state.get('exitCode')) is int,'STORAGE_RETIREMENT_PROCESS_PROOF_INVALID')
  stamp=state.get('finishedAt')
  try:date=datetime.fromisoformat(stamp.replace('Z','+00:00'))
  except (AttributeError,ValueError):raise RetirementError('STORAGE_RETIREMENT_PROCESS_PROOF_INVALID') from None
  require(date.tzinfo is not None and date<=datetime.now(timezone.utc),'STORAGE_RETIREMENT_PROCESS_PROOF_INVALID')
  result.append({'name':status['name'],'container_id':cid,'finished_at':stamp,'exit_code':state['exitCode']})
 require(len({x['name'] for x in result})==len(expected),'STORAGE_RETIREMENT_PROCESS_PROOF_INVALID')
 return {'uid':old['uid'],'containers':sorted(result,key=lambda x:x['name'])}

def validate_saved_termination(value,uid):
 require(isinstance(value,dict) and set(value)=={'uid','containers'} and value['uid']==uid and isinstance(value['containers'],list) and 1<=len(value['containers'])<=10,'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
 names=[]
 for container in value['containers']:
  require(isinstance(container,dict) and set(container)=={'name','container_id','finished_at','exit_code'} and isinstance(container['name'],str) and re.fullmatch('[a-z0-9-]{1,63}',container['name']) and isinstance(container['container_id'],str) and re.fullmatch(r'(containerd|docker|cri-o)://[a-f0-9]{64}',container['container_id']) and type(container['exit_code']) is int,'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
  try:stamp=datetime.fromisoformat(container['finished_at'].replace('Z','+00:00'))
  except (AttributeError,ValueError):raise RetirementError('STORAGE_RETIREMENT_POD_JOURNAL_INVALID') from None
  require(stamp.tzinfo is not None and stamp<=datetime.now(timezone.utc),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID');names.append(container['name'])
 require(len(set(names))==len(names),'STORAGE_RETIREMENT_POD_JOURNAL_INVALID')
 return value

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
     else:pods.append(result)
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
