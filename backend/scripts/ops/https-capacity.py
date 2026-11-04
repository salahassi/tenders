#!/usr/bin/env python3
"""Read-only binding of the qualified HTTPS binary, public config and limits.

The receipt is an isolated transport proof. Kubernetes resource declarations and
ready Pod observations are not cgroup measurements or a hosted load guarantee.
"""
import hashlib
import json
from pathlib import Path
import re

ROOT=Path(__file__).resolve().parents[2]
CONFIG='deploy/kubernetes/Caddyfile'
GATEWAY='deploy/kubernetes/gateway.conf'
QUALIFICATION='docs/evidence/https-api-streaming-20261104.json'
CHECKSUM='checksum/public-config'
MINIMUM_MEMORY=134217728
MINIMUM_CPU=300
COMMAND=['caddy','run','--config','/etc/caddy/Caddyfile','--adapter','caddyfile']
class HttpsError(Exception):pass

def need(ok,code):
 if not ok:raise HttpsError('DELIVERY_HTTPS_'+code)
def sha(value):return hashlib.sha256(value).hexdigest()
def data_hash(data):return sha(json.dumps(data,sort_keys=True).encode())
def source_contract(root=None):
 root=Path(ROOT if root is None else root);values={}
 for key,name in [('config',CONFIG),('gateway',GATEWAY),('receipt',QUALIFICATION)]:
  path=root/name
  need(path.is_file() and not path.is_symlink() and path.stat().st_size<=1048576,'SOURCE_UNAVAILABLE')
  try:values[key]=(path.read_bytes(),path.read_text())
  except (OSError,UnicodeError):raise HttpsError('DELIVERY_HTTPS_SOURCE_UNAVAILABLE') from None
 try:r=json.loads(values['receipt'][1])
 except (ValueError,TypeError):raise HttpsError('DELIVERY_HTTPS_QUALIFICATION_INVALID') from None
 need(isinstance(r,dict),'QUALIFICATION_INVALID')
 need(all(r.get(key) is True for key in ('passed','actual_binary_exercised','exact_delivery_qualified','cancellation_qualified',
  'temporary_budget_qualified','resource_envelope_qualified','tls_streaming_qualified','cleanup_confirmed','source_unchanged','synthetic_only','https_is_deployed_registry_image')),'QUALIFICATION_REQUIRED')
 need(all(type(r.get(key)) is int and r[key]==0 for key in ('production_calls','customer_calls','model_calls')),'QUALIFICATION_INVALID')
 need(all(isinstance(r.get(key),dict) for key in ('images','image_binding','resources','tls','source_hashes')),'QUALIFICATION_INVALID')
 image=r.get('images',{}).get('https');binding=r.get('image_binding',{});resources=r.get('resources',{});tls=r.get('tls',{})
 need(isinstance(image,str) and re.fullmatch(r'registry\.digitalocean\.com/tenderdesk-a6093a76/https@sha256:[a-f0-9]{64}',image),'IMAGE_UNQUALIFIED')
 need(binding.get('kind')=='exact_deployed_registry_digest' and binding.get('repo_digest')==image and isinstance(binding.get('local_image_id'),str) and re.fullmatch(r'sha256:[a-f0-9]{64}',binding['local_image_id']),'IMAGE_UNQUALIFIED')
 need(type(resources.get('https_memory_bytes')) is int and resources['https_memory_bytes']==MINIMUM_MEMORY and type(resources.get('https_cpu_millicores')) is int and resources['https_cpu_millicores']==MINIMUM_CPU,'ENVELOPE_UNQUALIFIED')
 need(re.findall(r'(?m)^worker_processes\s+([^;]+);',values['gateway'][1])==['1'] and type(resources.get('gateway_workers')) is int and resources['gateway_workers']==1 and resources.get('gateway_worker_count_basis')=='exact production directive, no worker-count transform','GATEWAY_WORKERS_UNQUALIFIED')
 need(isinstance(r.get('payload'),dict) and type(r['payload'].get('bytes')) is int and r['payload']['bytes']==412758765 and type(resources.get('tmp_budget_per_service_bytes')) is int and resources['tmp_budget_per_service_bytes']==67108864,'ENVELOPE_UNQUALIFIED')
 fs=r.get('mount_filesystems',{})
 need(isinstance(fs,dict) and all(isinstance(fs.get(name),dict) and isinstance(fs[name].get('statfs_magic'),dict) and fs[name]['statfs_magic'].get('/tmp')=='794c7630' for name in ('gateway','https')),'FILESYSTEM_UNQUALIFIED')
 need(tls.get('verification_enabled') is True and tls.get('actual_handshake_verified') is True and r.get('qualified_encodings')==['identity','gzip','zstd'],'TLS_UNQUALIFIED')
 need(r.get('source_hashes',{}).get('backend/'+CONFIG)==sha(values['config'][0]) and r.get('source_hashes',{}).get('backend/'+GATEWAY)==sha(values['gateway'][0]),'QUALIFICATION_CHANGED')
 return {'version':1,'image':image,'image_id':binding['local_image_id'],'config_source_sha256':sha(values['config'][0]),
  'config_data_sha256':data_hash({'Caddyfile':values['config'][1]}),'gateway_source_sha256':sha(values['gateway'][0]),
  'qualification_sha256':sha(values['receipt'][0]),'minimum_memory_bytes':MINIMUM_MEMORY,'minimum_cpu_millicores':MINIMUM_CPU}

def owned(d,kind,name):
 value=d.get(kind,name);meta=(value or {}).get('metadata',{})
 need(value and meta.get('namespace')==d.NAMESPACE and meta.get('name')==name and meta.get('uid') and meta.get('resourceVersion') and meta.get('labels',{}).get('app.kubernetes.io/managed-by')=='tenderdesk-deployment','OWNERSHIP_REQUIRED')
 return value

def container(spec,contract):
 containers=spec.get('containers',[])
 need(isinstance(containers,list) and len(containers)==1 and isinstance(containers[0],dict) and containers[0].get('name')=='https' and not spec.get('initContainers') and not spec.get('ephemeralContainers'),'CONTAINER_CHANGED')
 c=containers[0]
 need(c.get('image')==contract['image'],'IMAGE_CHANGED')
 need(c.get('command')==COMMAND and not c.get('args'),'ENTRYPOINT_CHANGED')
 env=c.get('env',[])
 need(isinstance(env,list) and len(env)==3 and not c.get('envFrom') and all(isinstance(e,dict) and set(e)=={'name','value'} for e in env),'ENVIRONMENT_CHANGED')
 values={e['name']:e['value'] for e in env}
 host=values.get('PUBLIC_HOST')
 need(set(values)=={'PUBLIC_HOST','XDG_DATA_HOME','XDG_CONFIG_HOME'} and values['XDG_DATA_HOME']=='/data' and values['XDG_CONFIG_HOME']=='/config' and isinstance(host,str) and len(host)<=253 and all(re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?',label) for label in host.split('.')),'ENVIRONMENT_CHANGED')
 mounts=c.get('volumeMounts',[]);volumes=spec.get('volumes',[])
 need(isinstance(mounts,list) and isinstance(volumes,list),'MOUNT_CHANGED')
 need(len(mounts)==4 and {m.get('mountPath') for m in mounts}=={'/tmp','/etc/caddy/Caddyfile','/data','/config'},'MOUNT_CHANGED')
 selected=[m for m in mounts if m.get('mountPath')=='/etc/caddy/Caddyfile']
 need(len(selected)==1 and selected[0].get('subPath')=='Caddyfile' and not selected[0].get('subPathExpr') and selected[0].get('readOnly') is True,'MOUNT_CHANGED')
 need(not any(m.get('mountPath') in ('/etc','/etc/caddy') or str(m.get('mountPath','')).startswith('/etc/caddy/Caddyfile/') for m in mounts),'MOUNT_CHANGED')
 v=[v for v in volumes if v.get('name')==selected[0].get('name')]
 need(len(v)==1 and set(v[0])=={'name','configMap'} and v[0]['configMap'].get('name')=='https-config' and not v[0]['configMap'].get('items'),'MOUNT_CHANGED')
 return c

def observed(d,deployment,contract,parse_resources):
 spec=deployment.get('spec',{});replicas=spec.get('replicas');template=spec.get('template',{})
 need(type(replicas) is int and replicas>=1 and template.get('metadata',{}).get('annotations',{}).get(CHECKSUM)==contract['config_data_sha256'],'TEMPLATE_CHANGED')
 c=container(template.get('spec',{}),contract)
 resources=parse_resources(c.get('resources',{}),replicas,MINIMUM_CPU,MINIMUM_MEMORY,'DELIVERY_HTTPS_')
 selector=spec.get('selector',{}).get('matchLabels')
 need(isinstance(selector,dict) and bool(selector),'SELECTOR_INVALID')
 try:pods=json.loads(d.command(['get','pods','-n',d.NAMESPACE,'-o','json']))['items']
 except (ValueError,KeyError,TypeError):raise HttpsError('DELIVERY_HTTPS_PODS_INVALID') from None
 selected=[p for p in pods if all(p.get('metadata',{}).get('labels',{}).get(k)==v for k,v in selector.items())]
 need(len(selected)==replicas,'PODS_UNQUALIFIED')
 observed_pods=[]
 for pod in selected:
  meta=pod.get('metadata',{});status=pod.get('status',{});statuses=status.get('containerStatuses',[])
  need(meta.get('uid') and meta.get('namespace')==d.NAMESPACE and not meta.get('deletionTimestamp') and meta.get('annotations',{}).get(CHECKSUM)==contract['config_data_sha256'] and status.get('phase')=='Running','PODS_UNQUALIFIED')
  need(len(statuses)==1 and statuses[0].get('name')=='https' and statuses[0].get('ready') is True and statuses[0].get('containerID') and isinstance(statuses[0].get('state',{}).get('running'),dict) and any(v.get('type')=='Ready' and v.get('status')=='True' for v in status.get('conditions',[])),'PODS_UNQUALIFIED')
  image_ids={contract['image'],'docker-pullable://'+contract['image'],contract['image_id'],'docker://'+contract['image_id'],'containerd://'+contract['image_id']}
  need(statuses[0].get('imageID') in image_ids,'RUNNING_IMAGE_CHANGED')
  pc=container(pod.get('spec',{}),contract)
  need(pc.get('env')==c.get('env'),'POD_ENVIRONMENT_CHANGED')
  pod_resources=parse_resources(pc.get('resources',{}),1,MINIMUM_CPU,MINIMUM_MEMORY,'DELIVERY_HTTPS_')
  actual=d.command(['exec',meta['name'],'-n',d.NAMESPACE,'--','cat','/etc/caddy/Caddyfile'])
  need(data_hash({'Caddyfile':actual})==contract['config_data_sha256'],'RUNNING_CONFIG_CHANGED')
  observed_pods.append({'uid':meta['uid'],'container_id':statuses[0]['containerID'],'resources':pod_resources})
 return {'deployment':resources,'ready_pods':sorted(observed_pods,key=lambda p:p['uid']),'hosted_load_qualified':False}

def preflight(d,contract,parse_resources):
 need(source_contract()==contract,'MANIFEST_CHANGED')
 config=owned(d,'configmap','https-config');deployment=owned(d,'deployment','https')
 need(config.get('data')=={'Caddyfile':(ROOT/CONFIG).read_text()} and not config.get('binaryData'),'CONFIG_CHANGED')
 return {'config':config,'deployment':deployment,'contract':contract,'resources':observed(d,deployment,contract,parse_resources)}

def verify(d,state,parse_resources,*,check_pods=True):
 need(source_contract()==state['contract'],'MANIFEST_CHANGED')
 config=owned(d,'configmap','https-config');deployment=owned(d,'deployment','https')
 need(config['metadata']['uid']==state['config']['metadata']['uid'] and config.get('data')==state['config'].get('data') and config.get('binaryData')==state['config'].get('binaryData'),'CONFIG_CHANGED')
 need(deployment['metadata']['uid']==state['deployment']['metadata']['uid'] and deployment['spec']==state['deployment']['spec'],'WORKLOAD_CHANGED')
 if check_pods:need(observed(d,deployment,state['contract'],parse_resources)==state['resources'],'POD_CHANGED')
 return state['resources']
