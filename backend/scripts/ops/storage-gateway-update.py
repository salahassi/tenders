#!/usr/bin/env python3
"""Exact reviewed unused-protocol gateway change; no credentials or image update."""
import copy
import hashlib
import json
import re
from decimal import Decimal
from pathlib import Path

HERE=Path(__file__).resolve().parent
BASELINE=HERE/'storage-retirement/gateway-before.conf'
TARGET=HERE.parents[1]/'deploy/kubernetes/gateway.conf'
QUALIFICATION=HERE.parents[1]/'docs/evidence/storage-retirement-binary-20261104.json'
STORAGE_QUALIFIED=HERE/'storage-retirement/gateway-storage-qualified.conf'
BATCH_QUALIFICATION=HERE.parents[1]/'docs/evidence/legacy-batch-gateway-pinned-worker-20261104.json'
STREAM_QUALIFICATION=HERE.parents[1]/'docs/evidence/api-proxy-streaming-pinned-worker-20261104.json'
MEMORY_MIN=64*1024*1024
CPU_MIN=Decimal('0.2')
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
 need(re.findall(r'(?m)^worker_processes\s+([^;]+);',after.decode())==['1'],'STORAGE_GATEWAY_WORKER_SOURCE_CHANGED')
 need(sha(before)==BASELINE_SHA256 and before!=after,'STORAGE_GATEWAY_SOURCE_INVALID')
 need(r.get('passed') is True and r.get('actual_binary_exercised') is True and r.get('signed_tus_bypass_confirmed') is True and r.get('gateway_resumable_denial_qualified') is True,'STORAGE_GATEWAY_QUALIFICATION_REQUIRED')
 need(r.get('gateway_image')==d.renderer.NGINX_IMAGE and r.get('gateway_config_source_sha256')==sha(storage),'STORAGE_GATEWAY_QUALIFICATION_CHANGED')
 need(b.get('passed') is True and b.get('actual_binary_exercised') is True and b.get('legacy_rpc_denial_qualified') is True and b.get('gateway_resumable_denial_qualified') is True and b.get('ordinary_routing_preserved') is True and b.get('restart_denial_qualified') is True and b.get('postgrest_error_envelope_qualified') is True and b.get('cleanup_confirmed') is True,'BATCH_GATEWAY_QUALIFICATION_REQUIRED')
 need(b.get('gateway_image')==d.renderer.NGINX_IMAGE and b.get('gateway_before_source_sha256')==sha(storage) and b.get('gateway_config_source_sha256')==sha(after) and b.get('storage_qualification_sha256')==sha(receipt) and all(type(b.get(key)) is int and b[key]==0 for key in ('production_calls','customer_calls')),'BATCH_GATEWAY_QUALIFICATION_CHANGED')
 stream_receipt=STREAM_QUALIFICATION.read_bytes();t=json.loads(stream_receipt)
 need(all(t.get(k) is True for k in ('passed','actual_binary_exercised','cleanup_confirmed','exact_delivery_qualified','cancellation_qualified','temporary_budget_qualified','gateway_memory_qualified')),'API_PROXY_QUALIFICATION_REQUIRED')
 need(t.get('gateway_image')==d.renderer.NGINX_IMAGE and t.get('gateway_config_source_sha256')==sha(after) and b.get('api_proxy_streaming_receipt_sha256')==sha(stream_receipt) and all(type(t.get(k)) is int and t[k]==0 for k in ('production_calls','customer_calls')),'API_PROXY_QUALIFICATION_CHANGED')
 envelope=t.get('envelope',{})
 need(type(envelope.get('gateway_worker_processes')) is int and envelope['gateway_worker_processes']==1 and type(t.get('running_gateway_worker_count')) is int and t['running_gateway_worker_count']==1 and envelope.get('gateway_memory_bytes')==MEMORY_MIN and envelope.get('gateway_cpu_millicores')==200 and envelope.get('tmp_budget_bytes')==MEMORY_MIN and envelope.get('tmp_medium')=='disk' and t.get('actual_gateway_tmp_filesystem_magic') in ('794c7630','ef53','58465342','9123683e') and envelope.get('census_includes_open_unlinked_files') is True and t.get('payload_bytes')==412758765,'API_PROXY_ENVELOPE_CHANGED')
 data_before={'nginx.conf':BASELINE.read_text().replace('__NAMESPACE__',d.NAMESPACE)};data_after={'nginx.conf':TARGET.read_text().replace('__NAMESPACE__',d.NAMESPACE)}
 contract={'version':2,'before_source_sha256':sha(before),'after_source_sha256':sha(after),'before_data_sha256':checksum(data_before),
  'after_data_sha256':checksum(data_after),'qualification_sha256':sha(batch_receipt),'storage_qualification_sha256':sha(receipt),
  'storage_qualified_source_sha256':sha(storage),'gateway_image':d.renderer.NGINX_IMAGE}
 return contract,data_before,data_after

def quantity(value):
 # Quantity syntax needed by reviewed K8s CPU/memory limits; reject unknown forms.
 if not isinstance(value,str):return None
 match=re.fullmatch(r'([0-9]+(?:\.[0-9]+)?)(n|u|m|Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?',value)
 if not match:return None
 factors={'':1,'n':Decimal('0.000000001'),'u':Decimal('0.000001'),'m':Decimal('0.001'),'k':1000,'M':1000**2,'G':1000**3,'T':1000**4,'P':1000**5,'E':1000**6,**{p+'i':1024**i for i,p in enumerate('KMGTPE',1)}}
 return Decimal(match[1])*factors[match[2] or '']

def require_envelope(spec):
 containers=spec.get('containers',[])
 need(len(containers)==1 and containers[0].get('name')=='gateway','STORAGE_GATEWAY_ENVELOPE_CHANGED')
 limits=containers[0].get('resources',{}).get('limits',{})
 memory,cpu=quantity(limits.get('memory')),quantity(limits.get('cpu'))
 need(memory is not None and memory>=MEMORY_MIN and cpu is not None and cpu>=CPU_MIN,'STORAGE_GATEWAY_RESOURCE_BELOW_PROOF')
 mounts=containers[0].get('volumeMounts',[])
 tmp=[m for m in mounts if m.get('mountPath')=='/tmp' or m.get('mountPath','').startswith('/tmp/')]
 need(len(tmp)==1 and tmp[0].get('mountPath')=='/tmp' and not tmp[0].get('readOnly') and not tmp[0].get('subPath') and not tmp[0].get('subPathExpr'),'STORAGE_GATEWAY_TMP_MOUNT_CHANGED')
 volumes=[v for v in spec.get('volumes',[]) if v.get('name')==tmp[0].get('name')]
 need(len(volumes)==1 and set(volumes[0])=={'name','emptyDir'} and isinstance(volumes[0]['emptyDir'],dict),'STORAGE_GATEWAY_TMP_VOLUME_CHANGED')
 tmp=volumes[0]['emptyDir'];size=quantity(tmp.get('sizeLimit'))
 need(not tmp.get('medium') and size is not None and size>=MEMORY_MIN,'STORAGE_GATEWAY_TMP_BELOW_PROOF')

def require_runtime(spec,image):
 require_envelope(spec);container=spec['containers'][0]
 need(container.get('image')==image,'STORAGE_GATEWAY_IMAGE_CHANGED')
 need(container.get('command')==['nginx','-g','daemon off;'] and not container.get('args'),'STORAGE_GATEWAY_ENTRYPOINT_CHANGED')
 mounts=container.get('volumeMounts',[]);volumes=spec.get('volumes',[])
 config_path='/etc/nginx/nginx.conf'
 mounts=[m for m in mounts if m.get('mountPath')==config_path or config_path.startswith(m.get('mountPath','')+'/') or m.get('mountPath','').startswith(config_path+'/')]
 need(len(mounts)==1 and mounts[0].get('mountPath')==config_path and mounts[0].get('subPath')=='nginx.conf' and not mounts[0].get('subPathExpr') and mounts[0].get('readOnly') is True,'STORAGE_GATEWAY_MOUNT_CHANGED')
 matches=[v for v in volumes if v.get('name')==mounts[0].get('name')]
 need(len(matches)==1 and matches[0].get('configMap',{}).get('name')=='gateway-config','STORAGE_GATEWAY_MOUNT_CHANGED')

def require_disk_mount(d,pod):
 # BusyBox can label overlay UNKNOWN; the kernel filesystem magic is exact.
 observed=d.command(['exec',pod['metadata']['name'],'-n',d.NAMESPACE,'--','stat','-f','-c','%T %t','/tmp']).strip().split()
 need(len(observed)==2 and observed[1].lower() in ('794c7630','ef53','58465342','9123683e'),'STORAGE_GATEWAY_TMP_FILESYSTEM_UNQUALIFIED')

def require_one_worker(d,pod):
 observed=d.command(['exec',pod['metadata']['name'],'-n',d.NAMESPACE,'--','ps','-o','args'])
 need(sum(line.strip()=='nginx: worker process' for line in observed.splitlines())==1,'STORAGE_GATEWAY_WORKER_COUNT_UNQUALIFIED')

def selected_pods(d,dep):
 selector=dep['spec']['selector']['matchLabels'];pods=json.loads(d.command(['get','pods','-n',d.NAMESPACE,'-o','json']))['items']
 return [p for p in pods if all(p['metadata'].get('labels',{}).get(k)==v for k,v in selector.items())]

def preflight(d,contract):
 actual,before,after=source_contract(d);need(actual==contract,'STORAGE_GATEWAY_MANIFEST_CHANGED')
 config=owned(d,'configmap','gateway-config');deployment=owned(d,'deployment','gateway');spec=deployment['spec'];containers=spec.get('template',{}).get('spec',{}).get('containers',[])
 need(config.get('data') in (before,after) and not config.get('binaryData') and not config.get('immutable'),'STORAGE_GATEWAY_CONFIG_CHANGED')
 require_runtime(spec['template']['spec'],contract['gateway_image'])
 for pod in selected_pods(d,deployment):
  require_runtime(pod.get('spec',{}),contract['gateway_image'])
  # Protected terminated old Pods remain for the coordinator's exit proof.
  # Inspect every running/ready process here; final acceptance requires all ready.
  if any(s.get('ready') or s.get('state',{}).get('running') is not None for s in pod.get('status',{}).get('containerStatuses',[])):
   require_disk_mount(d,pod)
   # The unqualified old configuration is the authorized repair input. A Pod
   # already carrying the final checksum must meet the final one-worker proof.
   if pod['metadata'].get('annotations',{}).get(CHECKSUM)==contract['after_data_sha256']:require_one_worker(d,pod)
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
  selected=selected_pods(d,dep)
  need(len(selected)==dep['spec']['replicas'] and len(selected)>0,'STORAGE_GATEWAY_OLD_PODS_NOT_DRAINED')
  for pod in selected:
   require_runtime(pod.get('spec',{}),state['contract']['gateway_image'])
   need(not pod['metadata'].get('deletionTimestamp') and pod['metadata'].get('annotations',{}).get(CHECKSUM)==state['contract']['after_data_sha256'] and pod['spec']['containers'][0]['image']==state['contract']['gateway_image'] and all(s.get('ready') for s in pod.get('status',{}).get('containerStatuses',[])) and len(pod.get('status',{}).get('containerStatuses',[]))==1,'STORAGE_GATEWAY_POD_UNQUALIFIED')
   require_disk_mount(d,pod)
   require_one_worker(d,pod)
   actual=d.command(['exec',pod['metadata']['name'],'-n',d.NAMESPACE,'--','cat','/etc/nginx/nginx.conf'])
   need(actual==state['after_data']['nginx.conf'],'STORAGE_GATEWAY_RUNNING_CONFIG_CHANGED')

def after_snapshot(state):return {'uid':state['deployment']['metadata']['uid'],'spec':after_spec(state)}

def require_installed(d):
 contract,_,_=source_contract(d);state=preflight(d,contract);verify(d,state,check_pods=True);return state

def require_restart_guard(d):
 contract,_,_=source_contract(d);state=preflight(d,contract)
 need(state['config']['data']==state['after_data'] and state['deployment']['spec']['template']['metadata']['annotations'][CHECKSUM]==contract['after_data_sha256'],'STORAGE_GATEWAY_RESTART_GUARD_REQUIRED')
 return state
