#!/usr/bin/env python3
"""Two-runner, nonce-owned Kubernetes/PVC retirement qualification.

The first process deliberately exits 86 only after the adapter has durably
journaled its capture and scaled all three fixture Deployments to zero. A new
GitHub runner resumes from the Kubernetes Secret. No production adapter is
retargeted, and no arbitrary namespace, SQL, key or database is accepted.
"""
from __future__ import annotations
import argparse
import base64
from contextlib import redirect_stderr, redirect_stdout
import io
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sys
import time

import contract as c
import resources as r

b=c.bootstrap
access=c.load('retirement_fixture_access',c.OPS/'transfer-sources.py')
CLEANUP='retirement-cleanup'

def emit(status,**safe):
    print(c.canonical({'storage_retirement_qualification':status,**safe}),flush=True)

def private_directory():
    run=os.environ.get('GITHUB_RUN_ID','');attempt=os.environ.get('GITHUB_RUN_ATTEMPT','')
    c.need(re.fullmatch('[0-9]{1,20}',run) and re.fullmatch('[0-9]{1,6}',attempt),'RETIREMENT_FIXTURE_RUN_INVALID')
    root=Path(os.environ['RUNNER_TEMP'])
    c.need(root.is_absolute() and root.is_dir() and not root.is_symlink(),'RETIREMENT_FIXTURE_RUNNER_PATH_INVALID')
    return root/('doks-access-'+run+'-'+attempt)

def prepare_access():
    os.umask(0o077)
    directory=private_directory()
    source=directory.with_name('td-sources-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT'])
    if source.exists():
        c.need(not source.is_symlink() and source.is_dir() and source.stat().st_mode&0o077==0,'RETIREMENT_FIXTURE_RUNNER_PATH_INVALID')
        for name in ('kubectl','kubeconfig'):
            path=source/name
            c.need(path.is_file() and not path.is_symlink() and path.stat().st_mode&0o077==0,'RETIREMENT_FIXTURE_RUNNER_PATH_INVALID')
        os.environ.update(KUBECTL=str(source/'kubectl'),KUBECONFIG=str(source/'kubeconfig'))
        b.preflight.validate_cluster()
    else:
        access.prepare_cluster()
    if directory.exists():
        c.need(not directory.is_symlink() and directory.is_dir() and directory.stat().st_mode&0o077==0,'RETIREMENT_FIXTURE_RUNNER_PATH_INVALID')
    else:directory.mkdir(mode=0o700)
    os.environ['DOKS_WORKDIR']=str(directory)
    c.restore.images.verify_checkout(c.revision())
    c.manifest_contract()

def runner_cleanup():
    directory=private_directory()
    for path in (directory,directory.with_name('td-sources-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT'])):
        c.need(not path.is_symlink(),'RETIREMENT_FIXTURE_RUNNER_PATH_INVALID')
        if path.exists():shutil.rmtree(path)

def output_nonce(base):
    nonce=base['labels']['tenderdesk.io/run'].rsplit('-',1)[1]
    c.need(re.fullmatch('[a-f0-9]{8}',nonce),'RETIREMENT_FIXTURE_NONCE_INVALID')
    path=Path(os.environ['GITHUB_OUTPUT'])
    with path.open('a') as stream:
        stream.write('nonce='+nonce+'\norigin_attempt='+os.environ['GITHUB_RUN_ATTEMPT']+'\n')
    return nonce

def parent_job(state):
    job=json.loads(r.command(['get','job','compatible-services','-n',c.namespace(state),'-o','json']))
    metadata=job.get('metadata',{})
    c.need(metadata.get('uid')==state['bootstrap']['job_uid'] and metadata.get('namespace')==c.namespace(state)
      and all(metadata.get('labels',{}).get(k)==v for k,v in c.labels(state).items()),'RETIREMENT_FIXTURE_UPSTREAM_IDENTITY_CHANGED')
    return job

def patch_parent(state,suspend):
    r.namespace_guard(state);job=parent_job(state)
    patch=[{'op':'test','path':'/metadata/uid','value':job['metadata']['uid']},
      {'op':'test','path':'/metadata/resourceVersion','value':job['metadata']['resourceVersion']},
      {'op':'replace','path':'/spec/suspend','value':suspend}]
    r.command(['patch','job','compatible-services','-n',c.namespace(state),'--type=json','--patch',c.canonical(patch)])

def wait_upstream(state):
    end=time.monotonic()+300
    while time.monotonic()<end:
        parent_job(state)
        pods=[p for p in r.items(state,'pods') if p.get('metadata',{}).get('labels',{}).get('job-name')=='compatible-services']
        if len(pods)==1:
            pod=r.bootstrap_pod(state)
            statuses={s.get('name'):s for s in pod.get('status',{}).get('initContainerStatuses',[])}
            main=pod.get('status',{}).get('containerStatuses',[])
            if set(statuses)=={'auth','rest'} and all(s.get('started') is True for s in statuses.values()) and len(main)==1 and main[0].get('state',{}).get('running'):
                return
            c.need(all(s.get('restartCount',0)<2 for s in statuses.values()),'RETIREMENT_FIXTURE_UPSTREAM_START_FAILED')
        time.sleep(2)
    raise c.FixtureError('RETIREMENT_FIXTURE_UPSTREAM_TIMEOUT')

def create_sql_job(state,job):
    """Journal the actual SQL Job UID before polling its result."""
    name=job['metadata']['name']
    job['metadata']['labels']=c.labels(state)
    # Retain the exact successful Job as cleanup proof across GitHub reruns.
    # The nonce namespace owns its lifetime, not a short TTL controller.
    job['spec'].pop('ttlSecondsAfterFinished',None)
    r.create(state,'job',job)
    wait_sql_job(state,name)

def wait_sql_job(state,name):
    end=time.monotonic()+185
    while time.monotonic()<end:
        job=r.get(state,'job',name)
        status=job.get('status',{})
        if status.get('succeeded')==1:return
        c.need(not status.get('failed'),'RETIREMENT_FIXTURE_SQL_JOB_FAILED')
        time.sleep(2)
    raise c.FixtureError('RETIREMENT_FIXTURE_SQL_JOB_TIMEOUT')

def writer(state,mode):
    c.need(mode in ('prepare','verify','status'),'RETIREMENT_FIXTURE_CLIENT_MODE_INVALID')
    pod=r.bootstrap_pod(state)
    raw=r.command(['exec',pod['metadata']['name'],'-n',c.namespace(state),'-c','acceptance','--',
      'python3','-B','/opt/bootstrap/writer.py',mode],timeout=180)
    after=r.bootstrap_pod(state)
    c.need(after['metadata']['uid']==pod['metadata']['uid'],'RETIREMENT_FIXTURE_UPSTREAM_IDENTITY_CHANGED')
    try:value=json.loads(raw)
    except ValueError:raise c.FixtureError('RETIREMENT_FIXTURE_CLIENT_RESULT_INVALID') from None
    c.need(isinstance(value,dict),'RETIREMENT_FIXTURE_CLIENT_RESULT_INVALID')
    return value

def fixture_source(base):
    values={'__OWNER__':c.restore.builder.identifier(base['role_prefix']+'_owner'),
      '__SERVICE__':c.restore.builder.identifier(base['role_prefix']+'_service'),
      '__DATABASE_LITERAL__':c.restore.builder.literal(base['database']),
      '__DATABASE_COMMENT_LITERAL__':c.restore.builder.literal('tenderdesk-isolated-bootstrap:'+base['database']+':'+base['role_prefix'])}
    sql=(c.HERE/'fixture.sql').read_text()
    for token,value in values.items():sql=sql.replace(token,value)
    c.need(re.search('__+[A-Z_]+__',sql) is None,'RETIREMENT_FIXTURE_SQL_PLACEHOLDER_INVALID')
    return sql

def schema_job(state,catalog,manifest):
    base=state['bootstrap'];raw,_=c.restore.schema_source(catalog,base,manifest)
    old=c.restore.fixture_source(base).encode()
    c.need(raw.endswith(old),'RETIREMENT_FIXTURE_SCHEMA_SOURCE_CHANGED')
    raw=raw[:-len(old)]+fixture_source(base).encode()
    c.need(0<len(raw)<=c.restore.MAX_SCHEMA_BYTES,'RETIREMENT_FIXTURE_SCHEMA_SIZE_INVALID')
    sources=[]
    for index,offset in enumerate(range(0,len(raw),c.restore.CHUNK_BYTES)):
        name='retirement-schema-'+str(index).zfill(3)
        r.create(state,'secret',{'apiVersion':'v1','kind':'Secret','type':'Opaque','metadata':r.meta(state,name),
          'data':{'schema':base64.b64encode(raw[offset:offset+c.restore.CHUNK_BYTES]).decode()}})
        sources.append({'secret':{'name':name,'items':[{'key':'schema','path':str(index).zfill(3)+'.sql'}]}})
    job=b.sql_job(base,'post-migrations','post-migrations.sql',base['database'])
    job['metadata']['labels']=c.labels(state)
    pod=job['spec']['template']['spec'];pod['securityContext']['fsGroup']=999
    pod['volumes'] += [{'name':'retirement-schema','projected':{'defaultMode':0o444,'sources':sources}},
      {'name':'retirement-work','emptyDir':{'medium':'Memory','sizeLimit':'12Mi'}}]
    client=pod['containers'][0]
    client['volumeMounts'] += [{'name':'retirement-schema','mountPath':'/opt/retirement-schema','readOnly':True},
      {'name':'retirement-work','mountPath':'/tmp/retirement'}]
    client['command']=['sh','-ec','cat /opt/retirement-schema/*.sql > /tmp/retirement/schema.sql && '
      "printf '%s  %s\\n' '"+c.sha(raw)+"' '/tmp/retirement/schema.sql' | sha256sum -c - >/dev/null && "
      'exec psql --no-psqlrc --set=ON_ERROR_STOP=1 --quiet --file=/tmp/retirement/schema.sql']
    return job

def network_policies(state,credentials):
    addresses={x[4][0] for x in socket.getaddrinfo(credentials['PGHOST'],int(credentials['PGPORT']),family=socket.AF_INET,type=socket.SOCK_STREAM)}
    c.need(1<=len(addresses)<=8 and all(ipaddress.ip_address(x).is_private and not ipaddress.ip_address(x).is_loopback for x in addresses),'RETIREMENT_FIXTURE_PRIVATE_DATABASE_REQUIRED')
    same={'podSelector':{}}
    egress=[{'to':[same]},
      {'to':[{'namespaceSelector':{'matchLabels':{'kubernetes.io/metadata.name':'kube-system'}}}],
       'ports':[{'protocol':'UDP','port':53},{'protocol':'TCP','port':53}]},
      {'to':[{'ipBlock':{'cidr':x+'/32'}} for x in sorted(addresses)],'ports':[{'protocol':'TCP','port':int(credentials['PGPORT'])}]}]
    common={'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy'}
    return [{**common,'metadata':r.meta(state,'private-fixture'),'spec':{
      'podSelector':{'matchExpressions':[{'key':'tenderdesk.io/fixture-workload','operator':'NotIn','values':['storage']}]},
      'policyTypes':['Ingress','Egress'],'ingress':[{'from':[same]}],'egress':egress}},
      {**common,'metadata':r.meta(state,'storage-gateway-only'),'spec':{
      'podSelector':{'matchLabels':{'tenderdesk.io/fixture-workload':'storage'}},'policyTypes':['Ingress','Egress'],
      'ingress':[{'from':[{'podSelector':{'matchLabels':{'tenderdesk.io/fixture-workload':'gateway'}}}],
        'ports':[{'protocol':'TCP','port':5000}]}],'egress':egress}}]

def pvc_manifest(state):
    storage=json.loads(r.command(['get','storageclass','do-block-storage','-o','json']))
    c.need(storage.get('provisioner')=='dobs.csi.digitalocean.com' and storage.get('reclaimPolicy')=='Delete'
      and storage.get('volumeBindingMode','Immediate') in ('Immediate','WaitForFirstConsumer'),'RETIREMENT_FIXTURE_STORAGE_CLASS_UNQUALIFIED')
    return {'apiVersion':'v1','kind':'PersistentVolumeClaim','metadata':r.meta(state,c.PVC_NAME),
      'spec':{'storageClassName':'do-block-storage','accessModes':['ReadWriteOnce'],'volumeMode':'Filesystem',
        'resources':{'requests':{'storage':'1Gi'}}}}

def upstream_job(state):
    parent=b.build_bootstrap_job(c.namespace(state),c.labels(state))
    parent['spec'].update(suspend=True,activeDeadlineSeconds=3500)
    # Keep the exact upstream Job identity for late, ownership-checked cleanup.
    # Its clients still have a bounded lifetime; namespace cleanup owns the Job.
    parent['spec'].pop('ttlSecondsAfterFinished',None)
    pod=parent['spec']['template']['spec']
    pod['initContainers']=[x for x in pod['initContainers'] if x['name'] in ('auth','rest')]
    pod['volumes']=[x for x in pod['volumes'] if x['name'] not in ('bootstrap-objects','tmp-storage')]
    pod['containers'][0]['command']=['python3','-B','-c','import time; time.sleep(3500)']
    return parent

def prepare():
    manifest=json.loads(c.restore.release.MANIFEST.read_text())
    catalog=c.restore.capture(manifest)
    credentials,ca=b.preflight.target_credentials(os.environ['DIGITALOCEAN_ACCESS_TOKEN'])
    base=b.identity();output_nonce(base)
    created=b.create({'apiVersion':'v1','kind':'Namespace','metadata':{'name':base['namespace'],
      'labels':{**base['labels'],'tenderdesk.io/qualification':'storage-retirement','pod-security.kubernetes.io/enforce':'restricted'}}})
    base['uid']=created.get('metadata',{}).get('uid');b.save(base)
    state=c.initial_state(base,c.manifest_contract());r.save(state,initial=True)
    parent=upstream_job(state)
    job=b.create(parent);base['job_uid']=job['metadata']['uid'];b.save(base);r.save(state)
    values=b.secret_values(credentials,ca,base)
    r.create(state,'secret',{'apiVersion':'v1','kind':'Secret','type':'Opaque','metadata':r.meta(state,'bootstrap-secrets'),
      'data':{k:base64.b64encode(v.encode()).decode() for k,v in values.items()}})
    assets={name:(b.ASSETS/name).read_text() for name in ('setup.sql','cleanup.sql','acceptance.py')}
    assets.update({'post-migrations.sql':'-- Exact reconstructed SQL is privately mounted and hash verified.\n',
      'writer.py':(c.HERE/'writer.py').read_text()})
    r.create(state,'configmap',{'apiVersion':'v1','kind':'ConfigMap','metadata':r.meta(state,'bootstrap-code'),'data':assets})
    for policy in network_policies(state,credentials):r.create(state,'networkpolicy',policy)
    r.create(state,'configmap',{'apiVersion':'v1','kind':'ConfigMap','metadata':r.meta(state,'gateway-config'),
      'data':{'nginx.conf':r.renderer.gateway_configuration(c.namespace(state))}})
    r.create(state,'persistentvolumeclaim',pvc_manifest(state))
    for name,port in (('auth',9999),('rest',3000)):
        r.create(state,'service',r.service(state,name,{'job-name':'compatible-services'},[(name,port)]))
    for name,ports in (('storage',[('storage',5000)]),('gateway',[('public',8080),('internal',8081)])):
        r.create(state,'service',r.service(state,name,{'tenderdesk.io/fixture-workload':name},ports))
    base['setup_started']=True;b.save(base);r.save(state)
    create_sql_job(state,b.sql_job(base,'database-setup','setup.sql','defaultdb'))
    patch_parent(state,False)
    for deployment in r.workload_manifests(state):r.create(state,'deployment',deployment)
    wait_upstream(state)
    r.wait_deployment(state,'storage')
    create_sql_job(state,schema_job(state,catalog,manifest))
    state['phase']='schema_ready';r.save(state)
    r.create(state,'pod',r.sql_client(state))
    r.command(['wait','pod/'+r.SQL,'-n',c.namespace(state),'--for=condition=Ready','--timeout=120s'],timeout=130)
    for name in ('worker','gateway'):r.wait_deployment(state,name)
    state['fixture']=c.validate_fixture(writer(state,'prepare'));state['phase']='fixture_ready';r.save(state)
    from fixture_adapter import FixtureAdapter
    adapter=FixtureAdapter(state,interrupt_after_stop=True)
    c.proof.retire(adapter,adapter.selection())
    raise c.FixtureError('RETIREMENT_FIXTURE_INTERRUPTION_NOT_REACHED')

def cleanup_journal(state):
    current=r.get(state,'secret',CLEANUP,missing=True) if 'secret/'+CLEANUP in state['resource_uids'] else None
    if current:
        try:value=json.loads(base64.b64decode(current['data']['cleanup'],validate=True))
        except (KeyError,ValueError,TypeError):raise c.FixtureError('RETIREMENT_FIXTURE_CLEANUP_JOURNAL_INVALID') from None
        c.need(set(value)=={'pvc_uid','pv_name','pv_uid','storage_absence_confirmed'} and c.uid(value['pvc_uid'])
          and (value['pv_name'] is None or re.fullmatch('[a-z0-9-]{1,253}',value['pv_name']))
          and (value['pv_uid'] is None or c.uid(value['pv_uid'])) and type(value['storage_absence_confirmed']) is bool,
          'RETIREMENT_FIXTURE_CLEANUP_JOURNAL_INVALID')
        c.need(state['resource_uids'].get('persistentvolumeclaim/'+c.PVC_NAME)==value['pvc_uid'],'RETIREMENT_FIXTURE_CLEANUP_JOURNAL_INVALID')
        if state['process_capture'] is not None:
            c.need(value['pv_name']==state['process_capture']['pvc']['spec'].get('volumeName'),'RETIREMENT_FIXTURE_VOLUME_BINDING_CHANGED')
        return value
    pvc=r.get(state,'persistentvolumeclaim',c.PVC_NAME)
    name=pvc.get('spec',{}).get('volumeName');pv=None
    if name:
        c.need(re.fullmatch('[a-z0-9-]{1,253}',name),'RETIREMENT_FIXTURE_VOLUME_INVALID')
        pv=json.loads(r.command(['get','pv',name,'-o','json']))
        spec=pv.get('spec',{});claim=spec.get('claimRef',{})
        c.need(claim.get('uid')==pvc['metadata']['uid'] and claim.get('namespace')==c.namespace(state)
          and claim.get('name')==c.PVC_NAME and spec.get('persistentVolumeReclaimPolicy')=='Delete'
          and spec.get('csi',{}).get('driver')=='dobs.csi.digitalocean.com' and c.uid(pv.get('metadata',{}).get('uid')),
          'RETIREMENT_FIXTURE_VOLUME_IDENTITY_CHANGED')
    value={'pvc_uid':pvc['metadata']['uid'],'pv_name':name,'pv_uid':pv['metadata']['uid'] if pv else None,'storage_absence_confirmed':False}
    r.create(state,'secret',{'apiVersion':'v1','kind':'Secret','type':'Opaque','metadata':r.meta(state,CLEANUP),
      'data':{'cleanup':base64.b64encode(c.canonical(value).encode()).decode()}})
    c.need(r.get(state,'secret',CLEANUP).get('data',{}).get('cleanup')==base64.b64encode(c.canonical(value).encode()).decode(),'RETIREMENT_FIXTURE_CLEANUP_JOURNAL_READBACK_FAILED')
    return value

def save_cleanup_journal(state,value):
    secret=r.get(state,'secret',CLEANUP);encoded=base64.b64encode(c.canonical(value).encode()).decode()
    r.patch(state,'secret',CLEANUP,secret,[{'op':'replace','path':'/data/cleanup','value':encoded}])
    c.need(r.get(state,'secret',CLEANUP).get('data',{}).get('cleanup')==encoded,'RETIREMENT_FIXTURE_CLEANUP_JOURNAL_READBACK_FAILED')

def bind_cleanup_volume(state,journal,pv):
    metadata=pv.get('metadata',{});spec=pv.get('spec',{});claim=spec.get('claimRef',{})
    c.need(claim.get('uid')==journal['pvc_uid'] and claim.get('namespace')==c.namespace(state) and claim.get('name')==c.PVC_NAME
      and spec.get('persistentVolumeReclaimPolicy')=='Delete' and spec.get('csi',{}).get('driver')=='dobs.csi.digitalocean.com'
      and c.uid(metadata.get('uid')) and re.fullmatch('[a-z0-9-]{1,253}',metadata.get('name','')),'RETIREMENT_FIXTURE_VOLUME_IDENTITY_CHANGED')
    if journal['pv_name'] is not None:
        c.need(metadata['name']==journal['pv_name'] and metadata['uid']==journal['pv_uid'],'RETIREMENT_FIXTURE_VOLUME_IDENTITY_CHANGED')
        return journal
    c.need(state['process_capture'] is None,'RETIREMENT_FIXTURE_VOLUME_BINDING_CHANGED')
    updated={**journal,'pv_name':metadata['name'],'pv_uid':metadata['uid'],'storage_absence_confirmed':False}
    save_cleanup_journal(state,updated);return updated

def delete_fixture_pvc(state,journal):
    pvc=r.get(state,'persistentvolumeclaim',c.PVC_NAME,missing=True)
    if pvc is not None:
        name=pvc.get('spec',{}).get('volumeName')
        if name!=journal['pv_name']:
            c.need(journal['pv_name'] is None and isinstance(name,str) and re.fullmatch('[a-z0-9-]{1,253}',name),'RETIREMENT_FIXTURE_VOLUME_BINDING_CHANGED')
        if name is not None:journal=bind_cleanup_volume(state,journal,json.loads(r.command(['get','pv',name,'-o','json'])))
        # The same binding observation supplies deletion UID+resourceVersion;
        # a concurrent bind/update conflicts instead of bypassing the PV wait.
        r.delete_observed(state,'persistentvolumeclaim',c.PVC_NAME,pvc)
    await_gone(state,'persistentvolumeclaim',c.PVC_NAME)
    if journal['pv_name'] is None:
        census=json.loads(r.command(['get','pv','-o','json']))
        c.need(isinstance(census.get('items'),list) and len(census['items'])<=2000,'RETIREMENT_FIXTURE_VOLUME_CENSUS_INVALID')
        owned=[pv for pv in census['items'] if pv.get('spec',{}).get('claimRef',{}).get('uid')==journal['pvc_uid']]
        c.need(len(owned)<=1,'RETIREMENT_FIXTURE_VOLUME_IDENTITY_CHANGED')
        if owned:journal=bind_cleanup_volume(state,journal,owned[0])
        # An empty API census does not settle an external CSI CreateVolume
        # already in flight. Keep this namespace/state for later reconciliation.
        c.need(journal['pv_name'] is not None,'RETIREMENT_FIXTURE_VOLUME_ALLOCATION_RECONCILIATION_REQUIRED')
    return journal

def await_gone(state,kind,name,seconds=180):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        value=r.get(state,kind,name,missing=True)
        if value is None:return
        time.sleep(2)
    raise c.FixtureError('RETIREMENT_FIXTURE_RESOURCE_CLEANUP_PENDING')

def delete_namespace(base):
    b.assert_namespace(base)
    actual=json.loads(r.command(['get','namespace',base['namespace'],'-o','json']))
    metadata=actual.get('metadata',{})
    c.need(metadata.get('uid')==base['uid'] and all(metadata.get('labels',{}).get(key)==value for key,value in base['labels'].items()),
      'RETIREMENT_FIXTURE_NAMESPACE_IDENTITY_CHANGED')
    options={'apiVersion':'v1','kind':'DeleteOptions','preconditions':{
      'uid':base['uid'],'resourceVersion':metadata['resourceVersion']},'propagationPolicy':'Background'}
    r.command(['delete','--raw','/api/v1/namespaces/'+base['namespace'],'--filename=-'],payload=c.canonical(options))
    end=time.monotonic()+90
    while time.monotonic()<end:
        raw=r.command(['get','namespace',base['namespace'],'-o','json','--ignore-not-found=true'])
        if not raw:return
        c.need(json.loads(raw).get('metadata',{}).get('uid')==base['uid'],'RETIREMENT_FIXTURE_NAMESPACE_IDENTITY_CHANGED')
        time.sleep(2)
    raise c.FixtureError('RETIREMENT_FIXTURE_NAMESPACE_CLEANUP_PENDING')

def cleanup(state):
    from fixture_adapter import FixtureAdapter
    r.namespace_guard(state)
    if state['cleanup_proof'] is None:
        if state['process_capture'] is not None:proof=FixtureAdapter(state).cleanup_preconditions()
        else:proof={'version':1,'operation_nonce':state['operation_nonce'],'namespace_uid':state['bootstrap']['uid'],'mode':'uncaptured','workloads':{}}
        c.validate_cleanup_proof(state,proof)
    else:
        c.need(state['phase']=='cleaning','RETIREMENT_FIXTURE_CLEANUP_PHASE_INVALID')
        proof=FixtureAdapter(state).validate_cleanup_checkpoint()
    # Protected originals require complete exit proof. A distinct pre-protection
    # checkpoint retains still-live originals without claiming an exit or quota
    # release. Unknown or newly observed protection blocks both cleanup paths.
    c.need(not any(c.proof.FINALIZER in p.get('metadata',{}).get('finalizers',[]) or c.proof.ANNOTATION in p.get('metadata',{}).get('annotations',{}) for p in r.items(state,'pods')),
      'RETIREMENT_FIXTURE_PROTECTED_PROCESS_REQUIRES_RECONCILIATION')
    if state['cleanup_proof'] is None:
        state['cleanup_proof']=proof;state['phase']='cleaning'
        # save() performs UID/version CAS and exact Secret-data readback. No
        # ordinary fixture controller/PVC/database deletion precedes it.
        r.save(state)
    for name in c.proof.NAMES:
        if 'deployment/'+name in state['resource_uids']:r.delete(state,'deployment',name)
    for name in (r.PHYSICAL,r.SQL):
        if 'pod/'+name in state['resource_uids']:
            r.delete(state,'pod',name);await_gone(state,'pod',name,seconds=90)
    # Delete controllers, then wait for every Pod that could mount this PVC.
    end=time.monotonic()+90
    while time.monotonic()<end:
        mounted=[p for p in r.items(state,'pods') if any(v.get('persistentVolumeClaim',{}).get('claimName')==c.PVC_NAME for v in p.get('spec',{}).get('volumes',[]))]
        if not mounted:break
        time.sleep(2)
    c.need(not mounted,'RETIREMENT_FIXTURE_VOLUME_CLIENTS_REMAIN')
    if 'persistentvolumeclaim/'+c.PVC_NAME in state['resource_uids']:
        journal=cleanup_journal(state)
        journal=delete_fixture_pvc(state,journal)
        if journal['pv_name']:
            end=time.monotonic()+180
            while time.monotonic()<end:
                raw=r.command(['get','pv',journal['pv_name'],'-o','json','--ignore-not-found=true'])
                if not raw:break
                value=json.loads(raw)
                c.need(value.get('metadata',{}).get('uid')==journal['pv_uid'],'RETIREMENT_FIXTURE_VOLUME_IDENTITY_CHANGED')
                time.sleep(2)
            c.need(not raw,'RETIREMENT_FIXTURE_PHYSICAL_VOLUME_CLEANUP_PENDING')
        journal['storage_absence_confirmed']=True
        save_cleanup_journal(state,journal)
    # The reviewed bootstrap SQL checks exact nonce DB/role comments. Keep its
    # Job UID and the confirmed database-cleanup result durable before deleting
    # the namespace; a resumed cleanup can reobserve the same successful Job.
    base=state['bootstrap']
    if base['setup_started'] and not base['database_cleanup_confirmed']:
        patch_parent(state,True)
        b.wait_clients_stopped(base)
        for name in ('database-setup','post-migrations'):
            if 'job/'+name not in state['resource_uids']:continue
            job=r.get(state,'job',name)
            if not (job.get('status',{}).get('succeeded') or job.get('status',{}).get('failed')):
                # An interrupted preparer may still have a database client.
                # Suspend the exact Job and wait for its Pods before dropping
                # any nonce database or role. This never supplies quota proof.
                operation='replace' if 'suspend' in job['spec'] else 'add'
                r.patch(state,'job',name,job,[{'op':operation,'path':'/spec/suspend','value':True}])
                end=time.monotonic()+60
                while time.monotonic()<end:
                    active=[p for p in r.items(state,'pods') if any(o.get('uid')==job['metadata']['uid'] for o in p.get('metadata',{}).get('ownerReferences',[]))
                      and p.get('status',{}).get('phase') not in ('Succeeded','Failed')]
                    if not active:break
                    time.sleep(2)
                c.need(not active,'RETIREMENT_FIXTURE_DATABASE_CLIENTS_REMAIN')
        if 'job/database-cleanup' not in state['resource_uids']:
            create_sql_job(state,b.sql_job(base,'database-cleanup','cleanup.sql','defaultdb'))
        else:wait_sql_job(state,'database-cleanup')
        base['database_cleanup_confirmed']=True;b.save(base);r.save(state)
    # This marker proves DB and PV cleanup were already confirmed. Namespace
    # absence remains separately required, including after a lost delete reply.
    record_cleaned(base)
    delete_namespace(base)
    b.private_state_path().unlink(missing_ok=True)

def record_cleaned(base):
    marker=private_directory()/('retirement-cleaned-'+base['labels']['tenderdesk.io/run'].rsplit('-',1)[1]+'.json')
    marker.write_text(c.canonical({'source_revision':c.revision(),'namespace_uid':base['uid'],'origin_attempt':c.origin_attempt()}));marker.chmod(0o600)

def cleanup_unjournaled_namespace(nonce):
    """Only the original runner can remove its pre-journal empty allocation.

    No namespace is adopted from a derived name. Once any Job or database setup
    may have started, the durable Kubernetes journal is mandatory.
    """
    c.need(re.fullmatch('[a-f0-9]{8}',nonce),'RETIREMENT_FIXTURE_NONCE_INVALID')
    path=b.private_state_path()
    if not path.exists():return False
    c.need(not path.is_symlink() and path.stat().st_mode&0o077==0,'RETIREMENT_FIXTURE_RUNNER_PATH_INVALID')
    base=c.validate_bootstrap(json.loads(path.read_text()))
    if base['setup_started'] or base['job_uid'] is not None:return False
    c.need(base['labels']['tenderdesk.io/run'].endswith('-'+nonce) and c.uid(base['uid']),'RETIREMENT_FIXTURE_CLEANUP_JOURNAL_INVALID')
    b.assert_namespace(base)
    if r.command(['get','secret',c.STATE_NAME,'-n',base['namespace'],'-o','json','--ignore-not-found=true']):return False
    record_cleaned(base);delete_namespace(base)
    path.unlink();return True

def already_cleaned(nonce):
    c.need(re.fullmatch('[a-f0-9]{8}',nonce),'RETIREMENT_FIXTURE_NONCE_INVALID')
    path=private_directory()/('retirement-cleaned-'+nonce+'.json')
    if not path.exists():return False
    c.need(not path.is_symlink() and path.stat().st_mode&0o077==0,'RETIREMENT_FIXTURE_RUNNER_PATH_INVALID')
    value=json.loads(path.read_text())
    c.need(set(value)=={'source_revision','namespace_uid','origin_attempt'} and value['source_revision']==c.revision()
      and c.uid(value['namespace_uid']) and value['origin_attempt']==c.origin_attempt(),'RETIREMENT_FIXTURE_CLEANUP_JOURNAL_INVALID')
    namespace='td-bootstrap-'+os.environ['GITHUB_RUN_ID']+'-'+c.origin_attempt()+'-'+nonce
    raw=r.command(['get','namespace',namespace,'-o','json','--ignore-not-found=true'])
    if not raw:return True
    c.need(json.loads(raw).get('metadata',{}).get('uid')==value['namespace_uid'],'RETIREMENT_FIXTURE_NAMESPACE_REAPPEARED')
    return False

def resume(nonce):
    from fixture_adapter import FixtureAdapter
    state=r.load(nonce)
    c.need(state['phase']=='interrupted' and state['process_capture'] is not None,'RETIREMENT_FIXTURE_INTERRUPTION_NOT_JOURNALED')
    started=time.monotonic()
    adapter=FixtureAdapter(state)
    c.proof.retire(adapter,adapter.selection())
    checks=adapter.verify_retirement()
    c.need(isinstance(checks,dict) and checks and all(type(x) is bool and x for x in checks.values()),'RETIREMENT_FIXTURE_ACCEPTANCE_FAILED')
    client=writer(state,'verify')
    client_checks=client.get('checks')
    c.need(isinstance(client_checks,dict) and client_checks and all(re.fullmatch('[a-z_]{1,100}',key) and type(value) is bool and value for key,value in client_checks.items()),'RETIREMENT_FIXTURE_POST_RESTART_CLIENT_FAILED')
    c.need(not set(checks)&set(client_checks),'RETIREMENT_FIXTURE_CHECK_NAMES_COLLIDE')
    checks.update(client_checks)
    checks['post_restart_retired_key_physically_absent']=adapter.post_restart_absence(client.get('new_storage_key')) is True
    c.need(checks['post_restart_retired_key_physically_absent'],'RETIREMENT_FIXTURE_OLD_KEY_REAPPEARED')
    checks['new_canonical_key_physically_present']=checks['post_restart_retired_key_physically_absent']
    state['phase']='verified';r.save(state)
    elapsed=time.monotonic()-started
    cleanup(state)
    return c.public_receipt(state,checks,{'resume_and_verification':elapsed},cleaned=True)

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=('prepare','resume','cleanup','runner-cleanup'))
    parser.add_argument('--nonce')
    parser.add_argument('--origin-attempt')
    args=parser.parse_args(argv)
    try:
        c.need((args.mode in ('resume','cleanup'))==(args.nonce is not None),'RETIREMENT_FIXTURE_ARGUMENTS_INVALID')
        c.need(args.origin_attempt is None or args.mode in ('resume','cleanup'),'RETIREMENT_FIXTURE_ARGUMENTS_INVALID')
        if args.mode in ('resume','cleanup'):
            actual=os.environ.get('GITHUB_RUN_ATTEMPT','');origin=args.origin_attempt or actual
            c.need(re.fullmatch('[1-9][0-9]{0,5}',origin) and re.fullmatch('[1-9][0-9]{0,5}',actual)
              and int(origin)<=int(actual),'RETIREMENT_FIXTURE_ORIGIN_ATTEMPT_INVALID')
            os.environ['RETIREMENT_FIXTURE_ORIGIN_ATTEMPT']=origin
        else:
            c.need(not os.environ.get('RETIREMENT_FIXTURE_ORIGIN_ATTEMPT'),'RETIREMENT_FIXTURE_ORIGIN_ATTEMPT_INVALID')
        if args.mode=='runner-cleanup':runner_cleanup();emit('runner_files_removed');return 0
        # All upstream diagnostics are kept private; only fixed codes and the
        # explicit redacted receipt below reach public GitHub Actions logs.
        with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):
            prepare_access()
            if args.mode=='prepare':prepare();result=None
            elif args.mode=='resume':result=resume(args.nonce)
            elif already_cleaned(args.nonce):result={'cleanup_verified':True}
            elif cleanup_unjournaled_namespace(args.nonce):result={'cleanup_verified':True}
            else:cleanup(r.load(args.nonce));result={'cleanup_verified':True}
        emit('passed',**result);return 0
    except Exception as error:
        # A catalog observer can have failed before the fixture nonce exists.
        # Its own exact-UID journal remains the only cleanup authority.
        try:
            with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):c.restore.inventory.cleanup_saved_client()
        except Exception:
            emit('blocked',code='RETIREMENT_FIXTURE_CATALOG_CLIENT_CLEANUP_PENDING')
        safe=str(error) if isinstance(error,(c.FixtureError,c.proof.RetirementError,b.BootstrapError,b.preflight.ProbeError,c.restore.RestoreError)) and re.fullmatch('[A-Z0-9_]{1,100}',str(error)) else 'RETIREMENT_FIXTURE_FAILED'
        emit('blocked',code=safe);return 1

if __name__=='__main__':sys.exit(main())
