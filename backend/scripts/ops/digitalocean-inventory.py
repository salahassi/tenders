#!/usr/bin/env python3
"""Bounded runner-only inventory; no bootstrap, model, schema or business writes.

A nonce-owned temporary SQL-client Pod/Secret reads the deployed application
catalog using original cluster/database CAs, then verifies cleanup. Raw resource,
database and credential payloads never enter public logs or workflow artifacts.
"""
from __future__ import annotations
from contextlib import redirect_stdout, redirect_stderr
from datetime import datetime, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('inventory_observer', HERE / 'observe-assessment-recovery.py')
observer = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = observer
SPEC.loader.exec_module(observer)
d = observer.d
OWNER = 'tenderdesk-read-only-inventory'
NAMES = ('api','worker','frontend','auth','rest','storage','source-browser','scheduler','gateway','https')
RELEASES = frozenset(('flexible-proposal-inputs-v1','requested-model-processing-v1','ai-execution-reliability-v1',
 'analysis-verifier-recheck-v1','analysis-recheck-prompt-identity-v1','model-admission-fairness-v1',
 'model-admission-and-recheck-binding-v1','proposal-delivery-reliability-v1','proposal-delivery-reliability-v1-catalog'))
HEX = re.compile(r'[a-f0-9]{64}')
SOURCE = re.compile(r'[a-f0-9]{40}')
IMAGE = re.compile(r'registry\.digitalocean\.com/tenderdesk-a6093a76/(?:runtime|frontend|browser|ocr|https)@sha256:[a-f0-9]{64}')
UPSTREAM = frozenset((d.renderer.AUTH_IMAGE,d.renderer.REST_IMAGE,d.renderer.STORAGE_IMAGE,d.renderer.NGINX_IMAGE))
CAPABILITIES = frozenset(('delivery_snapshots','delivery_artifacts','claim_executor_3','delivery_export_context','delivery_package'))

class InventoryError(Exception):
    pass

def integer(value, maximum=1000000):
    if type(value) is not int or not 0<=value<=maximum: raise InventoryError('INVENTORY_COUNT_INVALID')
    return value

def digest(value):
    if not isinstance(value,str) or not HEX.fullmatch(value): raise InventoryError('INVENTORY_DIGEST_INVALID')
    return value

def image(value):
    if not isinstance(value,str) or not (IMAGE.fullmatch(value) or value in UPSTREAM):
        raise InventoryError('INVENTORY_UNREVIEWED_IMAGE')
    return value

def public_metrics(value):
    if not isinstance(value,dict) or set(value)!={'window_hours','jobs','delivery','capacity','issuance'} or value['window_hours']!=24: raise InventoryError('INVENTORY_SCHEMA_INVALID')
    jobs=value['jobs']
    if jobs is not None:
        if not isinstance(jobs,list) or len(jobs)>5: raise InventoryError('INVENTORY_SCHEMA_INVALID')
        classes=set()
        for row in jobs:
            if not isinstance(row,dict) or set(row)!={'class','pending','due','running','blocked','expired_leases','oldest_due_age_seconds','succeeded_in_window','terminal_row_elapsed_p95_seconds'} or row['class'] not in ('local','poll','proposal','background','other') or row['class'] in classes: raise InventoryError('INVENTORY_SCHEMA_INVALID')
            classes.add(row['class'])
            for key in ('pending','due','running','blocked','expired_leases','succeeded_in_window'): integer(row[key],1000000000)
            for key in ('oldest_due_age_seconds','terminal_row_elapsed_p95_seconds'):
                if row[key] is None and key=='terminal_row_elapsed_p95_seconds': continue
                if type(row[key]) not in (int,float) or not 0<=row[key]<=315576000: raise InventoryError('INVENTORY_SCHEMA_INVALID')
    for key,fields in {'delivery':{'pending','ready','expired','reserved_bytes','ready_bytes'},'capacity':{'workspace_count','total_reserved_bytes','largest_workspace_reserved_bytes','workspaces_at_or_above_limit','workspace_limit_bytes'}}.items():
        row=value[key]
        if row is None: continue
        if not isinstance(row,dict) or set(row)!=fields: raise InventoryError('INVENTORY_SCHEMA_INVALID')
        for item in row.values(): integer(item,10**15)
        if key=='capacity' and row['workspace_limit_bytes']!=262144000: raise InventoryError('INVENTORY_SCHEMA_INVALID')
    issuance=value['issuance']
    if issuance is not None:
        counts={'active_before_deadline','expired_unsettled','issued_in_window','failed_in_window','issued_after_deadline','invalid_deadline_bindings','deadline_seconds'}
        durations={'issued_latency_p95_seconds','issued_latency_max_seconds'}
        if not isinstance(issuance,dict) or set(issuance)!=counts|durations or issuance['deadline_seconds']!=600: raise InventoryError('INVENTORY_SCHEMA_INVALID')
        for key in counts: integer(issuance[key],1000000000)
        for key in durations:
            number=issuance[key]
            if number is not None and (type(number) not in (float,int) or not 0<=number<=315576000): raise InventoryError('INVENTORY_SCHEMA_INVALID')
    return value

def public_schema(value):
    fields={'version','database_identity_verified','releases','canonical_migrations','routine_catalog_sha256','capabilities','metrics'}
    if not isinstance(value,dict) or set(value)!=fields or type(value['version']) is not int or value['version']!=1 or value['database_identity_verified'] is not True:
        raise InventoryError('INVENTORY_SCHEMA_INVALID')
    if not isinstance(value['releases'],list) or len(value['releases'])>200: raise InventoryError('INVENTORY_SCHEMA_INVALID')
    releases=[]
    for item in value['releases']:
        if not isinstance(item,dict) or set(item)!={'release','migration_sha256','applied_at'}: raise InventoryError('INVENTORY_SCHEMA_INVALID')
        if not isinstance(item['release'],str): raise InventoryError('INVENTORY_SCHEMA_INVALID')
        if not isinstance(item['applied_at'],str) or len(item['applied_at'])>40: raise InventoryError('INVENTORY_SCHEMA_INVALID')
        try: stamp=datetime.fromisoformat(item['applied_at'].replace('Z','+00:00'))
        except ValueError: raise InventoryError('INVENTORY_SCHEMA_INVALID') from None
        if stamp.tzinfo is None: raise InventoryError('INVENTORY_SCHEMA_INVALID')
        releases.append({'release':item['release'] if item['release'] in RELEASES else 'UNRECOGNIZED_RELEASE',
                         'migration_sha256':digest(item['migration_sha256']),'applied_at':stamp.isoformat()})
    canonical=value['canonical_migrations']
    if canonical is not None:
        if not isinstance(canonical,dict) or set(canonical)!={'count','latest_version'}: raise InventoryError('INVENTORY_SCHEMA_INVALID')
        integer(canonical['count'])
        if canonical['latest_version'] is not None and (not isinstance(canonical['latest_version'],str) or not re.fullmatch(r'[0-9]{14}',canonical['latest_version'])):
            raise InventoryError('INVENTORY_SCHEMA_INVALID')
    capabilities=value['capabilities']
    if not isinstance(capabilities,dict) or set(capabilities)!=CAPABILITIES or any(type(v) is not bool for v in capabilities.values()): raise InventoryError('INVENTORY_SCHEMA_INVALID')
    return {'release_history':releases,'canonical_migrations':canonical,'routine_catalog_sha256':digest(value['routine_catalog_sha256']),
            'capabilities':capabilities,'metrics':public_metrics(value['metrics']),'source_tip_basis':'canonical_history_if_present_otherwise_release_receipts_only'}

def public_workloads(deployments,pods):
    if not isinstance(deployments,list) or not isinstance(pods,list) or len(deployments)>100 or len(pods)>500: raise InventoryError('INVENTORY_WORKLOADS_INVALID')
    selected={}
    for value in deployments:
        meta=value.get('metadata',{})
        name=meta.get('name')
        if name not in NAMES: continue
        if name in selected or meta.get('namespace')!=d.NAMESPACE or meta.get('labels',{}).get('app.kubernetes.io/managed-by')!='tenderdesk-deployment':
            raise InventoryError('INVENTORY_OWNERSHIP_INVALID')
        spec,status=value.get('spec',{}),value.get('status',{})
        containers=spec.get('template',{}).get('spec',{}).get('containers',[])
        if len(containers)!=1 or containers[0].get('name')!=name: raise InventoryError('INVENTORY_WORKLOADS_INVALID')
        reference=image(containers[0].get('image'))
        labels=spec.get('selector',{}).get('matchLabels',{})
        if not labels or not isinstance(labels,dict): raise InventoryError('INVENTORY_WORKLOADS_INVALID')
        matching=[p for p in pods if p.get('metadata',{}).get('namespace')==d.NAMESPACE and all(p.get('metadata',{}).get('labels',{}).get(k)==v for k,v in labels.items())]
        ids=[]
        for pod in matching:
            for container in pod.get('status',{}).get('containerStatuses',[]):
                if container.get('name')!=name: continue
                observed=container.get('imageID','')
                if observed:
                    match=re.fullmatch(r'(?:docker-pullable://|containerd://)?(?:[a-z0-9./:_-]+@)?sha256:([a-f0-9]{64})',observed)
                    if not match: raise InventoryError('INVENTORY_POD_IMAGE_INVALID')
                    ids.append(match.group(1))
        revision=meta.get('annotations',{}).get('deployment.kubernetes.io/revision')
        if revision is not None and (not isinstance(revision,str) or not re.fullmatch(r'[0-9]{1,12}',revision)): raise InventoryError('INVENTORY_REVISION_INVALID')
        selected[name]={'name':name,'image':reference,'kubernetes_revision':revision,
          'generation':integer(meta.get('generation',0)),'observed_generation':integer(status.get('observedGeneration',0)),
          'desired':integer(spec.get('replicas',0)),'ready':integer(status.get('readyReplicas',0)),
          'updated':integer(status.get('updatedReplicas',0)),'unavailable':integer(status.get('unavailableReplicas',0)),
          'matching_pods':len(matching),'observed_image_digests':sorted(set(ids)),
          'image_source_revision':None,'image_source_revision_status':'not_independently_inspected'}
    if set(selected)!=set(NAMES): raise InventoryError('INVENTORY_REQUIRED_WORKLOAD_MISSING')
    return [selected[name] for name in NAMES]

def public_schedules(values):
    if not isinstance(values,list) or len(values)>100: raise InventoryError('INVENTORY_SCHEDULE_INVALID')
    result={}
    for value in values:
        meta=value.get('metadata',{});name=meta.get('name')
        if name not in ('native-browser','native-ocr'): continue
        if name in result or meta.get('namespace')!=d.NAMESPACE or meta.get('labels',{}).get('app.kubernetes.io/managed-by')!='tenderdesk-deployment':
            raise InventoryError('INVENTORY_OWNERSHIP_INVALID')
        spec=value.get('spec',{});job=spec.get('jobTemplate',{}).get('spec',{});pod=job.get('template',{}).get('spec',{})
        containers=pod.get('containers',[])
        if not isinstance(containers,list) or len(containers)!=1: raise InventoryError('INVENTORY_NATIVE_CONTAINER_COUNT')
        schedule=spec.get('schedule')
        if not isinstance(schedule,str) or len(schedule)>100 or not re.fullmatch(r'[0-9*/,\-]+(?: +[0-9*/,\-]+){4}',schedule): raise InventoryError('INVENTORY_NATIVE_SCHEDULE_FORMAT')
        concurrency=spec.get('concurrencyPolicy','Allow')
        if concurrency not in ('Allow','Forbid','Replace') or type(spec.get('suspend',False)) is not bool: raise InventoryError('INVENTORY_NATIVE_CONCURRENCY_INVALID')
        container=containers[0];resources=container.get('resources',{})
        if not isinstance(resources,dict): raise InventoryError('INVENTORY_NATIVE_RESOURCES_FORMAT')
        projected={}
        for mode in ('requests','limits'):
            group=resources.get(mode)
            if group is None: projected[mode]=None;continue
            if not isinstance(group,dict): raise InventoryError('INVENTORY_NATIVE_RESOURCES_FORMAT')
            projected[mode]={}
            for key in ('cpu','memory','ephemeral-storage'):
                quantity=group.get(key)
                if quantity is not None and (not isinstance(quantity,str) or len(quantity)>24 or not re.fullmatch(r'[0-9]{1,15}(?:\.[0-9]{1,9})?(?:m|Ki|Mi|Gi|Ti|K|M|G|T)?',quantity)):
                    raise InventoryError('INVENTORY_NATIVE_RESOURCES_FORMAT')
                projected[mode][key]=quantity
        deadline=job.get('activeDeadlineSeconds');backoff=job.get('backoffLimit')
        if deadline is not None and (type(deadline) is not int or not 1<=deadline<=604800): raise InventoryError('INVENTORY_NATIVE_DEADLINE_INVALID')
        if backoff is not None and (type(backoff) is not int or not 0<=backoff<=100): raise InventoryError('INVENTORY_NATIVE_BACKOFF_INVALID')
        result[name]={'name':name,'image':image(container.get('image')),'schedule':schedule,
          'container_identity_recognized':container.get('name')==name.removeprefix('native-'),
          'concurrency_policy':concurrency,'concurrency_policy_explicit':'concurrencyPolicy' in spec,
          'suspended':spec.get('suspend',False),'suspend_explicit':'suspend' in spec,
          'active_deadline_seconds':deadline,'backoff_limit':backoff,'effective_backoff_limit':6 if backoff is None else backoff,
          'resources':projected,'generation':integer(meta.get('generation',0))}
    if set(result)!={'native-browser','native-ocr'}: raise InventoryError('INVENTORY_REQUIRED_SCHEDULE_MISSING')
    return [result[name] for name in sorted(result)]

def journal_path():
    run,attempt=os.environ.get('GITHUB_RUN_ID',''),os.environ.get('GITHUB_RUN_ATTEMPT','')
    if not re.fullmatch(r'[0-9]{1,20}',run) or not re.fullmatch(r'[0-9]{1,6}',attempt): raise InventoryError('INVENTORY_RUN_SOURCE_INVALID')
    expected=Path(os.environ['RUNNER_TEMP'])/('doks-access-'+run+'-'+attempt)
    if Path(os.environ['DOKS_WORKDIR'])!=expected: raise InventoryError('INVENTORY_CLEANUP_JOURNAL_INVALID')
    return expected/'inventory-client.json'

def save_client(client):
    state={'base':client.base,'nonce':client.nonce,'pod':client.pod,'secret':client.secret,'labels':client.labels,'timeout':client.timeout}
    d.runner.write(journal_path(),json.dumps(state).encode())

def clear_client():
    journal_path().unlink(missing_ok=True)

def cleanup_saved_client():
    path=journal_path()
    if not path.exists(): return
    if path.is_symlink() or path.stat().st_size>4096 or path.stat().st_mode&0o077: raise InventoryError('INVENTORY_CLEANUP_JOURNAL_INVALID')
    state=json.loads(path.read_text())
    nonce=state.get('nonce')
    if not isinstance(nonce,str) or not re.fullmatch(r'[a-f0-9]{8}',nonce): raise InventoryError('INVENTORY_CLEANUP_JOURNAL_INVALID')
    base='assess-observer-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']+'-'+nonce
    expected={'base':base,'nonce':nonce,'pod':base+'-pg','secret':base+'-db','labels':{'app.kubernetes.io/managed-by':OWNER,'tenderdesk.io/observation':nonce},'timeout':60}
    if state!=expected: raise InventoryError('INVENTORY_CLEANUP_JOURNAL_INVALID')
    client=object.__new__(observer.Client)
    client.__dict__.update(state)
    try: client.cleanup()
    except Exception: raise InventoryError('INVENTORY_TEMPORARY_CLIENT_CLEANUP_NOT_CONFIRMED') from None
    clear_client()

def inventory():
    revision=os.environ.get('GITHUB_SHA','')
    if not SOURCE.fullmatch(revision): raise InventoryError('INVENTORY_RUN_SOURCE_INVALID')
    # Full service manifests are held privately; only the fixed schema above is emitted.
    deployments=json.loads(d.command(['get','deployments','-n',d.NAMESPACE,'-o','json']))['items']
    pods=json.loads(d.command(['get','pods','-n',d.NAMESPACE,'-o','json']))['items']
    workloads=public_workloads(deployments,pods)
    schedules=public_schedules(json.loads(d.command(['get','cronjobs','-n',d.NAMESPACE,'-o','json']))['items'])
    client=observer.Client(60)
    client.labels['app.kubernetes.io/managed-by']=OWNER
    save_client(client)
    schema=None
    try:
        client.prepare()
        schema=public_schema(json.loads(d.sql(client.pod,(HERE/'digitalocean-inventory.sql').read_text())))
    finally:
        try:
            client.cleanup()
            clear_client()
        except Exception: raise InventoryError('INVENTORY_TEMPORARY_CLIENT_CLEANUP_NOT_CONFIRMED') from None
    after=json.loads(d.command(['get','deployments','-n',d.NAMESPACE,'-o','json']))['items']
    final=public_workloads(after,pods)
    final_schedules=public_schedules(json.loads(d.command(['get','cronjobs','-n',d.NAMESPACE,'-o','json']))['items'])
    if schedules!=final_schedules: raise InventoryError('INVENTORY_WORKLOAD_CHANGED_DURING_READ')
    keys=('name','image','generation','kubernetes_revision','desired')
    if [{k:w[k] for k in keys} for w in final]!=[{k:w[k] for k in keys} for w in workloads]:
        raise InventoryError('INVENTORY_WORKLOAD_CHANGED_DURING_READ')
    return {'inventory':'captured','version':1,'namespace':d.NAMESPACE,'runner_source_revision':revision,'observed_at':datetime.now(timezone.utc).isoformat(),
      'workloads':workloads,'native_schedules':schedules,'ready_workloads':sum(w['desired']>0 and w['ready']==w['desired']==w['updated'] and w['unavailable']==0 and w['observed_generation']>=w['generation'] for w in workloads),
      'schema':schema,'business_mutations':0,'schema_mutations':0,'models_called':0,'bootstrap_run':False,'temporary_client_cleanup_verified':True}

def main(argv=()):
    try:
        if argv not in ((),[],['--cleanup']): raise InventoryError('INVENTORY_MODE_INVALID')
        with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):
            if argv==['--cleanup']:
                cleanup_saved_client()
                receipt={'inventory':'temporary_client_cleanup_verified'}
            else:
                d.probe.validate_cluster()
                receipt=inventory()
    except Exception as error:
        allowed={'INVENTORY_COUNT_INVALID','INVENTORY_DIGEST_INVALID','INVENTORY_SCHEMA_INVALID','INVENTORY_UNREVIEWED_IMAGE',
          'INVENTORY_WORKLOADS_INVALID','INVENTORY_OWNERSHIP_INVALID','INVENTORY_POD_IMAGE_INVALID','INVENTORY_REVISION_INVALID',
          'INVENTORY_REQUIRED_WORKLOAD_MISSING','INVENTORY_RUN_SOURCE_INVALID','INVENTORY_TEMPORARY_CLIENT_CLEANUP_NOT_CONFIRMED',
          'INVENTORY_CLEANUP_JOURNAL_INVALID','INVENTORY_MODE_INVALID','INVENTORY_WORKLOAD_CHANGED_DURING_READ',
          'INVENTORY_SCHEDULE_INVALID','INVENTORY_REQUIRED_SCHEDULE_MISSING','INVENTORY_NATIVE_CONTAINER_COUNT',
          'INVENTORY_NATIVE_SCHEDULE_FORMAT','INVENTORY_NATIVE_CONCURRENCY_INVALID','INVENTORY_NATIVE_RESOURCES_FORMAT',
          'INVENTORY_NATIVE_DEADLINE_INVALID','INVENTORY_NATIVE_BACKOFF_INVALID'}
        code=str(error) if isinstance(error,InventoryError) and str(error) in allowed else 'INVENTORY_FAILED'
        print(json.dumps({'inventory':'failed','code':code}),flush=True)
        return 1
    print(json.dumps(receipt,sort_keys=True),flush=True)
    return 0

if __name__=='__main__': sys.exit(main(sys.argv[1:]))
