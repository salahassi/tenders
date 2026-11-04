#!/usr/bin/env python3
"""Exact reviewed unused-protocol gateway change; no credentials or image update."""
import copy
import hashlib
import json
from pathlib import Path

HERE=Path(__file__).resolve().parent
BASELINE=HERE/'storage-retirement/gateway-before.conf'
TARGET=HERE.parents[1]/'deploy/kubernetes/gateway.conf'
QUALIFICATION=HERE.parents[1]/'docs/evidence/storage-retirement-binary-20261104.json'
STORAGE_QUALIFIED=HERE/'storage-retirement/gateway-storage-qualified.conf'
BATCH_QUALIFICATION=HERE.parents[1]/'docs/evidence/legacy-batch-gateway-compatible-20261104.json'
BASELINE_SHA256='4907ecf81e2fa1e97754202906873ccd7c34e3dcbe26dd1e60cf4e276c639d23'
CHECKSUM='checksum/public-config'
class GatewayError(Exception):pass

def need(ok,code):
 if not ok:raise GatewayError(code)
def sha(value):return hashlib.sha256(value).hexdigest()
def checksum(data):return sha(json.dumps(data,sort_keys=True).encode())
def escape(path):return path.replace('~','~0').replace('/','~1')
def owned(d,kind,name):
 v=d.get(kind,name);m=(v or {}).get('metadata',{})
 need(v and m.get('namespace')==d.NAMESPACE and m.get('name')==name and m.get('uid') and m.get('resourceVersion') and m.get('labels',{}).get('app.kubernetes.io/managed-by')=='tenderdesk-deployment','STORAGE_GATEWAY_OWNERSHIP_REQUIRED');return v

def source_contract(d):
 before,after=BASELINE.read_bytes(),TARGET.read_bytes();storage=STORAGE_QUALIFIED.read_bytes()
 receipt=QUALIFICATION.read_bytes();r=json.loads(receipt);batch_receipt=BATCH_QUALIFICATION.read_bytes();b=json.loads(batch_receipt)
 need(sha(before)==BASELINE_SHA256 and before!=after,'STORAGE_GATEWAY_SOURCE_INVALID')
 need(r.get('passed') is True and r.get('actual_binary_exercised') is True and r.get('signed_tus_bypass_confirmed') is True and r.get('gateway_resumable_denial_qualified') is True,'STORAGE_GATEWAY_QUALIFICATION_REQUIRED')
 need(r.get('gateway_image')==d.renderer.NGINX_IMAGE and r.get('gateway_config_source_sha256')==sha(storage),'STORAGE_GATEWAY_QUALIFICATION_CHANGED')
 need(b.get('passed') is True and b.get('actual_binary_exercised') is True and b.get('legacy_rpc_denial_qualified') is True and b.get('gateway_resumable_denial_qualified') is True and b.get('ordinary_routing_preserved') is True and b.get('restart_denial_qualified') is True and b.get('postgrest_error_envelope_qualified') is True and b.get('cleanup_confirmed') is True,'BATCH_GATEWAY_QUALIFICATION_REQUIRED')
 need(b.get('gateway_image')==d.renderer.NGINX_IMAGE and b.get('gateway_before_source_sha256')==sha(storage) and b.get('gateway_config_source_sha256')==sha(after) and b.get('storage_qualification_sha256')==sha(receipt) and all(type(b.get(key)) is int and b[key]==0 for key in ('production_calls','customer_calls')),'BATCH_GATEWAY_QUALIFICATION_CHANGED')
 data_before={'nginx.conf':BASELINE.read_text().replace('__NAMESPACE__',d.NAMESPACE)};data_after={'nginx.conf':TARGET.read_text().replace('__NAMESPACE__',d.NAMESPACE)}
 contract={'version':2,'before_source_sha256':sha(before),'after_source_sha256':sha(after),'before_data_sha256':checksum(data_before),
  'after_data_sha256':checksum(data_after),'qualification_sha256':sha(batch_receipt),'storage_qualification_sha256':sha(receipt),
  'storage_qualified_source_sha256':sha(storage),'gateway_image':d.renderer.NGINX_IMAGE}
 return contract,data_before,data_after

def preflight(d,contract):
 actual,before,after=source_contract(d);need(actual==contract,'STORAGE_GATEWAY_MANIFEST_CHANGED')
 config=owned(d,'configmap','gateway-config');deployment=owned(d,'deployment','gateway');spec=deployment['spec'];containers=spec.get('template',{}).get('spec',{}).get('containers',[])
 need(config.get('data') in (before,after) and not config.get('binaryData') and not config.get('immutable'),'STORAGE_GATEWAY_CONFIG_CHANGED')
 need(len(containers)==1 and containers[0].get('name')=='gateway' and containers[0].get('image')==contract['gateway_image'],'STORAGE_GATEWAY_IMAGE_CHANGED')
 need(containers[0].get('command')==['nginx','-g','daemon off;'] and not containers[0].get('args'),'STORAGE_GATEWAY_ENTRYPOINT_CHANGED')
 mounts=containers[0].get('volumeMounts',[]);volumes=spec['template']['spec'].get('volumes',[])
 mount=[m for m in mounts if m.get('mountPath')=='/etc/nginx/nginx.conf']
 need(len(mount)==1 and mount[0].get('subPath')=='nginx.conf' and mount[0].get('readOnly') is True and any(v.get('name')==mount[0].get('name') and v.get('configMap',{}).get('name')=='gateway-config' for v in volumes),'STORAGE_GATEWAY_MOUNT_CHANGED')
 current=spec.get('template',{}).get('metadata',{}).get('annotations',{}).get(CHECKSUM)
 need(current in (contract['before_data_sha256'],contract['after_data_sha256']) and not (config['data']==before and current==contract['after_data_sha256']),'STORAGE_GATEWAY_TEMPLATE_CHANGED')
 return {'config':config,'deployment':deployment,'before_data':before,'after_data':after,'contract':contract}

def after_spec(state):
 value=copy.deepcopy(state['deployment']['spec']);value['template']['metadata']['annotations'][CHECKSUM]=state['contract']['after_data_sha256'];return value

def patch(d,kind,name,value,operations):
 d.command(['patch',kind,name,'-n',d.NAMESPACE,'--type=json','--patch',json.dumps([
  {'op':'test','path':'/metadata/uid','value':value['metadata']['uid']},
  {'op':'test','path':'/metadata/resourceVersion','value':value['metadata']['resourceVersion']},*operations])])

def apply(d,state,*,after_rollout=None):
 current=owned(d,'configmap','gateway-config');expected=state['config']
 need(current['metadata']['uid']==expected['metadata']['uid'] and current.get('data') in (state['before_data'],state['after_data']) and not current.get('binaryData') and not current.get('immutable'),'STORAGE_GATEWAY_CONFIG_CHANGED')
 if current['data']!=state['after_data']:
  patch(d,'configmap','gateway-config',current,[{'op':'test','path':'/data','value':state['before_data']},{'op':'replace','path':'/data','value':state['after_data']}])
 dep=owned(d,'deployment','gateway');old=state['deployment'];target=after_spec(state)
 need(dep['metadata']['uid']==old['metadata']['uid'] and dep['spec'] in (old['spec'],target),'STORAGE_GATEWAY_WORKLOAD_CHANGED')
 if dep['spec']!=target:
  path='/spec/template/metadata/annotations/'+escape(CHECKSUM)
  patch(d,'deployment','gateway',dep,[{'op':'test','path':'/spec','value':old['spec']},{'op':'replace','path':path,'value':state['contract']['after_data_sha256']}])
 d.command(['rollout','status','deployment/gateway','-n',d.NAMESPACE,'--timeout=180s'],timeout=190)
 if after_rollout is not None:after_rollout()
 verify(d,state,check_pods=True)

def verify(d,state,*,check_pods=False):
 config=owned(d,'configmap','gateway-config');dep=owned(d,'deployment','gateway')
 need(config['metadata']['uid']==state['config']['metadata']['uid'] and config.get('data')==state['after_data'] and not config.get('binaryData') and not config.get('immutable'),'STORAGE_GATEWAY_CONFIG_CHANGED')
 need(dep['metadata']['uid']==state['deployment']['metadata']['uid'] and dep['spec']==after_spec(state),'STORAGE_GATEWAY_WORKLOAD_CHANGED')
 if check_pods:
  selector=dep['spec']['selector']['matchLabels'];pods=json.loads(d.command(['get','pods','-n',d.NAMESPACE,'-o','json']))['items']
  selected=[p for p in pods if all(p['metadata'].get('labels',{}).get(k)==v for k,v in selector.items())]
  need(len(selected)==dep['spec']['replicas'] and len(selected)>0,'STORAGE_GATEWAY_OLD_PODS_NOT_DRAINED')
  for pod in selected:
   need(not pod['metadata'].get('deletionTimestamp') and pod['metadata'].get('annotations',{}).get(CHECKSUM)==state['contract']['after_data_sha256'] and pod['spec']['containers'][0]['image']==state['contract']['gateway_image'] and all(s.get('ready') for s in pod.get('status',{}).get('containerStatuses',[])) and len(pod.get('status',{}).get('containerStatuses',[]))==1,'STORAGE_GATEWAY_POD_UNQUALIFIED')
   actual=d.command(['exec',pod['metadata']['name'],'-n',d.NAMESPACE,'--','cat','/etc/nginx/nginx.conf'])
   need(actual==state['after_data']['nginx.conf'],'STORAGE_GATEWAY_RUNNING_CONFIG_CHANGED')

def after_snapshot(state):return {'uid':state['deployment']['metadata']['uid'],'spec':after_spec(state)}

def require_installed(d):
 contract,_,_=source_contract(d);state=preflight(d,contract);verify(d,state,check_pods=True);return state

def require_restart_guard(d):
 contract,_,_=source_contract(d);state=preflight(d,contract)
 need(state['config']['data']==state['after_data'] and state['deployment']['spec']['template']['metadata']['annotations'][CHECKSUM]==contract['after_data_sha256'],'STORAGE_GATEWAY_RESTART_GUARD_REQUIRED')
 return state
