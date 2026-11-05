"""Nonce-owned resources for the isolated retirement drill only.

This module never imports or retargets the fixed production retirement adapter.
All mutations bind an already-observed namespace UID and resource UID/version.
"""
from __future__ import annotations
import base64
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import time

import contract as c

b=c.bootstrap
p=b.preflight
containers=c.load('retirement_fixture_containers',c.OPS/'bootstrap/buildcontainers.py')
renderer=c.load('retirement_fixture_renderer',c.OPS.parent.parent/'deploy/kubernetes/render.py')
STATE=c.STATE_NAME
PHYSICAL='retirement-physical'
SQL='retirement-sql'

def pointer(value):return value.replace('~','~0').replace('/','~1')

def command(args,*,payload=None,timeout=60):
    executable=os.environ.get('KUBECTL','')
    c.need(executable.startswith('/') and os.environ.get('KUBECONFIG'),'RETIREMENT_FIXTURE_CLIENT_MISSING')
    try:r=subprocess.run([executable,'--request-timeout=30s',*args],input=payload,capture_output=True,text=True,timeout=timeout)
    except (OSError,subprocess.TimeoutExpired):raise c.FixtureError('RETIREMENT_FIXTURE_COMMAND_TIMEOUT') from None
    c.need(r.returncode==0,'RETIREMENT_FIXTURE_COMMAND_FAILED')
    c.need(len(r.stdout.encode())<=10*1024*1024,'RETIREMENT_FIXTURE_RESPONSE_TOO_LARGE')
    return r.stdout

def namespace_guard(state):
    c.validate_state(state)
    b.assert_namespace(state['bootstrap'])

def get(state,kind,name,*,known=True,missing=False):
    namespace_guard(state)
    value=json.loads(command(['get',kind,name,'-n',c.namespace(state),'-o','json','--ignore-not-found=true']) or 'null')
    if value is None:
        c.need(missing,'RETIREMENT_FIXTURE_RESOURCE_MISSING');return None
    return c.owned(state,kind,name,value,known=known)

def items(state,kind):
    namespace_guard(state)
    value=json.loads(command(['get',kind,'-n',c.namespace(state),'-o','json']))
    c.need(isinstance(value,dict) and isinstance(value.get('items'),list) and len(value['items'])<=100,'RETIREMENT_FIXTURE_RESOURCE_CENSUS_INVALID')
    return value['items']

def patch(state,kind,name,actual,operations):
    c.owned(state,kind,name,actual)
    namespace_guard(state)
    body=[{'op':'test','path':'/metadata/uid','value':actual['metadata']['uid']},
          {'op':'test','path':'/metadata/resourceVersion','value':actual['metadata']['resourceVersion']},*operations]
    command(['patch',kind,name,'-n',c.namespace(state),'--type=json','--patch',c.canonical(body)])

def state_object(state):
    return {'apiVersion':'v1','kind':'Secret','type':'Opaque','metadata':{'name':STATE,'namespace':c.namespace(state),'labels':c.labels(state)},
            'data':{'state':base64.b64encode(c.canonical(state).encode()).decode()}}

def save(state,*,initial=False):
    namespace_guard(state)
    value=state_object(state)
    if initial:
        observed=b.create(value)
        c.owned(state,'secret',STATE,observed,known=False)
        state['resource_uids']['secret/'+STATE]=observed['metadata']['uid']
    observed=get(state,'secret',STATE)
    encoded=base64.b64encode(c.canonical(state).encode()).decode()
    patch(state,'secret',STATE,observed,[{'op':'replace','path':'/data/state','value':encoded}])
    confirmed=get(state,'secret',STATE)
    c.need(confirmed.get('data',{}).get('state')==encoded,'RETIREMENT_FIXTURE_JOURNAL_READBACK_FAILED')

def load(nonce):
    c.need(isinstance(nonce,str) and re.fullmatch('[a-f0-9]{8}',nonce),'RETIREMENT_FIXTURE_NONCE_INVALID')
    run=os.environ.get('GITHUB_RUN_ID','');attempt=c.origin_attempt()
    c.need(re.fullmatch('[0-9]{1,20}',run) and re.fullmatch('[0-9]{1,6}',attempt),'RETIREMENT_FIXTURE_RUN_INVALID')
    namespace='td-bootstrap-'+run+'-'+attempt+'-'+nonce
    raw=json.loads(command(['get','secret',STATE,'-n',namespace,'-o','json']))
    try:
        data=base64.b64decode(raw['data']['state'],validate=True)
        c.need(len(data)<=750000,'RETIREMENT_FIXTURE_JOURNAL_TOO_LARGE')
        state=c.validate_state(json.loads(data))
    except (ValueError,KeyError,TypeError):raise c.FixtureError('RETIREMENT_FIXTURE_JOURNAL_INVALID') from None
    c.need(c.namespace(state)==namespace,'RETIREMENT_FIXTURE_RUN_INVALID')
    c.owned(state,'secret',STATE,raw)
    namespace_guard(state)
    c.need(state['manifest_sha256']==c.manifest_contract(),'RETIREMENT_FIXTURE_MANIFEST_CHANGED')
    return state

def create(state,kind,manifest):
    namespace_guard(state)
    name=manifest['metadata']['name']
    c.need(manifest['metadata']['namespace']==c.namespace(state) and manifest['metadata']['labels']==c.labels(state),'RETIREMENT_FIXTURE_RESOURCE_SCOPE_INVALID')
    c.need(get(state,kind,name,known=False,missing=True) is None,'RETIREMENT_FIXTURE_RESOURCE_EXISTS')
    observed=b.create(manifest)
    c.owned(state,kind,name,observed,known=False)
    state['resource_uids'][kind+'/'+name]=observed['metadata']['uid'];save(state)
    return observed

def meta(state,name):return {'name':name,'namespace':c.namespace(state),'labels':c.labels(state)}

def service(state,name,selector,ports):
    return {'apiVersion':'v1','kind':'Service','metadata':meta(state,name),'spec':{'type':'ClusterIP','selector':selector,'ports':[{'name':label,'port':port,'targetPort':port} for label,port in ports]}}

def security():return {'runAsNonRoot':True,'runAsUser':1000,'runAsGroup':1000,'fsGroup':1000,'seccompProfile':{'type':'RuntimeDefault'}}

def deployment(state,name,container,volumes):
    labels={**c.labels(state),'tenderdesk.io/fixture-workload':name}
    return {'apiVersion':'apps/v1','kind':'Deployment','metadata':meta(state,name),'spec':{
      'replicas':1,'strategy':{'type':'Recreate'},'selector':{'matchLabels':labels},
      'template':{'metadata':{'labels':labels},'spec':{'automountServiceAccountToken':False,
       'nodeSelector':{'kubernetes.io/arch':'amd64','kubernetes.io/os':'linux'},'terminationGracePeriodSeconds':15,
       'securityContext':security(),'containers':[container],'volumes':volumes}}}}

def workload_manifests(state):
    original=containers.build_bootstrap_job(c.namespace(state),c.labels(state))
    pod=original['spec']['template']['spec']
    storage=copy.deepcopy(next(x for x in pod['initContainers'] if x['name']=='storage'))
    storage.pop('restartPolicy')
    for item in storage['env']:
        if item['name']=='POSTGREST_URL':item['value']='http://rest:3000'
    storage['env'].append({'name':'TUS_USE_FILE_VERSION_SEPARATOR','value':'false'})
    storage['readinessProbe']=copy.deepcopy(storage['startupProbe'])
    volumes=[copy.deepcopy(v) for v in pod['volumes'] if v['name'] in ('database-ca','tmp-storage')]
    volumes.append({'name':'bootstrap-objects','persistentVolumeClaim':{'claimName':c.PVC_NAME}})
    storage_dep=deployment(state,'storage',storage,volumes)
    gateway={'name':'gateway','image':renderer.NGINX_IMAGE,'imagePullPolicy':'IfNotPresent','command':['nginx','-g','daemon off;'],
      'securityContext':containers._security(),'ports':[{'containerPort':8080},{'containerPort':8081}],
      'resources':{'requests':{'cpu':'25m','memory':'16Mi'},'limits':{'cpu':'200m','memory':'64Mi'}},
      'readinessProbe':{'httpGet':{'path':'/healthz','port':8081},'periodSeconds':2},
      'volumeMounts':[{'name':'config','mountPath':'/etc/nginx/nginx.conf','subPath':'nginx.conf','readOnly':True}, {'name':'tmp','mountPath':'/tmp'}]}
    gateway_dep=deployment(state,'gateway',gateway,[{'name':'config','configMap':{'name':'gateway-config'}},{'name':'tmp','emptyDir':{'sizeLimit':'64Mi'}}])
    worker={'name':'worker','image':containers.PROBE_IMAGE,'imagePullPolicy':'IfNotPresent',
      'command':['python3','-c','import time; time.sleep(3500)'],
      'securityContext':containers._security(),'resources':{'requests':{'cpu':'10m','memory':'16Mi'},'limits':{'cpu':'100m','memory':'64Mi'}}}
    return [storage_dep,gateway_dep,deployment(state,'worker',worker,[])]

def wait_deployment(state,name,seconds=240):
    get(state,'deployment',name)
    command(['rollout','status','deployment/'+name,'-n',c.namespace(state),'--timeout='+str(seconds)+'s'],timeout=seconds+10)
    return get(state,'deployment',name)

def bootstrap_pod(state):
    found=[x for x in items(state,'pods') if x.get('metadata',{}).get('labels',{}).get('job-name')=='compatible-services']
    c.need(len(found)==1,'RETIREMENT_FIXTURE_UPSTREAM_POD_INVALID')
    pod=found[0]
    c.owned(state,'pod',pod['metadata']['name'],pod,known=False)
    c.need(any(o.get('uid')==state['bootstrap']['job_uid'] and o.get('controller') is True for o in pod['metadata'].get('ownerReferences',[])),'RETIREMENT_FIXTURE_UPSTREAM_POD_INVALID')
    return pod

def sql(state,statement,*,role='owner'):
    get(state,'pod',SQL)
    c.need(role in ('owner','storageadmin',None),'RETIREMENT_FIXTURE_ROLE_INVALID')
    prefix="BEGIN ISOLATION LEVEL REPEATABLE READ;SET LOCAL statement_timeout='30s';SET LOCAL lock_timeout='5s';SET LOCAL search_path='';"+c.database_guard(state)
    if role:prefix+='SET LOCAL ROLE '+c.restore.builder.identifier(state['bootstrap']['role_prefix']+'_'+role)+';'
    return command(['exec','-i',SQL,'-n',c.namespace(state),'--','psql','-X','-A','-t','-q','-v','ON_ERROR_STOP=1'],payload=prefix+statement+';COMMIT;',timeout=45).strip()

def query(state,statement,*,role='owner'):
    value=sql(state,statement,role=role)
    try:return json.loads(value)
    except ValueError:raise c.FixtureError('RETIREMENT_FIXTURE_SQL_RESULT_INVALID') from None

def sql_client(state):
    template=b.sql_job(state['bootstrap'],'retirement-client','post-migrations.sql',state['bootstrap']['database'])['spec']['template']['spec']
    template['containers'][0]['command']=['sh','-ec','sleep 3500']
    return {'apiVersion':'v1','kind':'Pod','metadata':meta(state,SQL),'spec':{**template,'activeDeadlineSeconds':3500}}

def delete(state,kind,name):
    actual=get(state,kind,name,missing=True)
    if actual is None:return
    ns=c.namespace(state)
    plural={'pod':'pods','deployment':'deployments','persistentvolumeclaim':'persistentvolumeclaims'}[kind]
    prefix='/apis/apps/v1' if kind=='deployment' else '/api/v1'
    options={'apiVersion':'v1','kind':'DeleteOptions','preconditions':{'uid':actual['metadata']['uid'],'resourceVersion':actual['metadata']['resourceVersion']},'propagationPolicy':'Background'}
    command(['delete','--raw',prefix+'/namespaces/'+ns+'/'+plural+'/'+name,'--filename=-'],payload=c.canonical(options))

