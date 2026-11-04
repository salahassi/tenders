#!/usr/bin/env python3
"""Apply frozen additive SQL, then drain old workers and complete forward.

No bootstrap, model call, credential/settings change, historical retry or data
restore is performed. Workloads can process already-authorized queued work.
The only writes are the guarded SQL batch, fixed image patches, and the owned
worker Recreate marker. Ambiguity never triggers an incompatible image rollback.
"""
from contextlib import redirect_stdout,redirect_stderr
from decimal import Decimal
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sys
import time

HERE=Path(__file__).resolve().parent

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,HERE/path);module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module
release=load('delivery_release_contract','proposal-delivery-release.py')
images=load('delivery_release_images','proposal-delivery-images.py')
code=load('delivery_release_runtime','model-validation-update.py')
inventory=load('delivery_release_inventory','digitalocean-inventory.py')
gateway=load('delivery_storage_gateway','storage-gateway-update.py')
https=load('delivery_https_runtime','https-capacity.py')
cutover=load('delivery_batch_cutover','command-batch-cutover.py')
runtime,u=code.runtime,code.u
d=u.d
RUNTIME=('worker','api','source-browser','scheduler')
TARGETS=RUNTIME+('frontend',)
MARKER='tenderdesk-deployment/proposal-delivery-image'
OWNER='tenderdesk-delivery-release'
class UpdateError(Exception):pass

def emit(status,**fields):print(json.dumps({'release':release.RELEASE,'status':status,**fields},sort_keys=True),flush=True)
def image_of(value):return code.image_of(value)

def runtime_resource_envelope(value,name,minimum_cpu_millicores,minimum_memory_bytes):
    """Read the actual target; never raise requests/limits or infer an SLO.

    Parse a deliberately bounded Kubernetes quantity subset with exact decimal
    arithmetic. Unsupported units/exponents, missing limits and malformed values
    fail closed. Binary memory units and decimal CPU cores/milli/micro/nano are
    accepted; stronger observed limits satisfy the required release envelope.
    """
    if name not in ('worker','api'):raise UpdateError('DELIVERY_RUNTIME_NAME_INVALID')
    error_prefix='DELIVERY_'+name.upper()+'_'
    containers=value.get('spec',{}).get('template',{}).get('spec',{}).get('containers',[])
    if not isinstance(containers,list) or len(containers)!=1 or not isinstance(containers[0],dict) or containers[0].get('name')!=name:raise UpdateError(error_prefix+'RESOURCES_INVALID')
    container=containers[0]
    if container.get('command') or container.get('args'):raise UpdateError(error_prefix+'ENTRYPOINT_OVERRIDE')
    service=[entry for entry in container.get('env',[]) if isinstance(entry,dict) and entry.get('name')=='APP_RUNTIME_SERVICE']
    if service!=[{'name':'APP_RUNTIME_SERVICE','value':name}]:raise UpdateError(error_prefix+'RUNTIME_ROLE_INVALID')
    return resource_envelope(container.get('resources',{}),value.get('spec',{}).get('replicas',1),
      minimum_cpu_millicores,minimum_memory_bytes,error_prefix)

def resource_envelope(resources,replicas,minimum_cpu_millicores,minimum_memory_bytes,error_prefix):
    """Shared exact quantity parsing; callers separately bind runtime identity."""
    if not isinstance(resources,dict) or not isinstance(resources.get('limits',{}),dict):raise UpdateError(error_prefix+'RESOURCES_INVALID')
    limits=resources.get('limits',{})
    requests=resources.get('requests',{})
    if not isinstance(requests,dict) or type(replicas) is not int or not 1<=replicas<=2147483647:raise UpdateError(error_prefix+'RESOURCES_INVALID')
    def quantity(raw,factors,allow_zero=False):
        match=re.fullmatch(r'([0-9]{1,15}(?:\.[0-9]{1,9})?)([a-zA-Z]*)',raw) if isinstance(raw,str) else None
        if not match or match[2] not in factors:raise UpdateError(error_prefix+'RESOURCES_INVALID')
        result=Decimal(match[1])*factors[match[2]]
        if result<0 or (not allow_zero and result==0) or result>2**63-1:raise UpdateError(error_prefix+'RESOURCES_INVALID')
        return raw,result
    factors={'cpu':{'':Decimal(1),'m':Decimal('0.001'),'u':Decimal('0.000001'),'n':Decimal('0.000000001')},
      'memory':{'':1,'k':1000,'K':1000,'M':1000**2,'G':1000**3,'T':1000**4,'P':1000**5,'E':1000**6,
      'Ki':1024,'Mi':1024**2,'Gi':1024**3,'Ti':1024**4,'Pi':1024**5,'Ei':1024**6}}
    cpu,cores=quantity(limits.get('cpu'),factors['cpu'])
    memory,byte_count=quantity(limits.get('memory'),factors['memory'])
    observed_requests={name:quantity(requests[name],factor,True)[0] if name in requests else None for name,factor in factors.items()}
    if cores<Decimal(minimum_cpu_millicores)/1000 or byte_count<minimum_memory_bytes:raise UpdateError(error_prefix+'RESOURCES_BELOW_QUALIFIED_ENVELOPE')
    return {'limits':{'cpu':cpu,'memory':memory},'requests':observed_requests,'desired_replicas':replicas,'cpu_millicores':int(cores*1000),'memory_bytes':int(byte_count),
      'minimum_cpu_millicores':minimum_cpu_millicores,'minimum_memory_bytes':minimum_memory_bytes,'hosted_load_qualified':False}

def worker_resource_envelope(value):return runtime_resource_envelope(value,'worker',1000,640*1024**2)
def api_resource_envelope(value):return runtime_resource_envelope(value,'api',700,384*1024**2)

def journal_path():
    run,attempt=os.environ.get('GITHUB_RUN_ID',''),os.environ.get('GITHUB_RUN_ATTEMPT','')
    if not re.fullmatch('[0-9]{1,20}',run) or not re.fullmatch('[0-9]{1,6}',attempt):raise UpdateError('DELIVERY_RUN_IDENTITY_INVALID')
    expected=Path(os.environ['RUNNER_TEMP'])/('td-deploy-'+run+'-'+attempt)
    if Path(os.environ['DOKS_WORKDIR'])!=expected:raise UpdateError('DELIVERY_JOURNAL_INVALID')
    return expected/'delivery-client.json'

def save_client(client):
    value={key:getattr(client,key) for key in ('base','nonce','pod','secret','labels','timeout')}
    d.runner.write(journal_path(),json.dumps(value).encode())

def cleanup_saved_client():
    path=journal_path()
    if not path.exists():return
    if path.is_symlink() or path.stat().st_size>4096 or path.stat().st_mode&0o077:raise UpdateError('DELIVERY_JOURNAL_INVALID')
    value=json.loads(path.read_text());nonce=value.get('nonce')
    if not isinstance(nonce,str) or not re.fullmatch('[a-f0-9]{8}',nonce):raise UpdateError('DELIVERY_JOURNAL_INVALID')
    base='assess-observer-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']+'-'+nonce
    expected={'base':base,'nonce':nonce,'pod':base+'-pg','secret':base+'-db','labels':{'app.kubernetes.io/managed-by':OWNER,'tenderdesk.io/observation':nonce},'timeout':1800}
    if value!=expected:raise UpdateError('DELIVERY_JOURNAL_INVALID')
    client=object.__new__(inventory.observer.Client);client.__dict__.update(value)
    client.cleanup();path.unlink()

def native_spec(value):
    result=copy.deepcopy(value['spec']);result['jobTemplate']['spec']['template']['spec']['containers'][0].pop('image');return result

def verify_configuration(before,configuration,native_original,selected,*,final=False,gateway_state=None,https_state=None):
    after=runtime.workload_snapshot()
    if set(before)!=set(after) or any(before[name]!=after[name] for name in before if name not in TARGETS):raise UpdateError('DELIVERY_OTHER_WORKLOAD_CHANGED')
    now=runtime.retained_configuration()
    if now['configuration']!=configuration['configuration'] or now['secrets']!=configuration['secrets'] or now['schedules']['native-browser']!=configuration['schedules']['native-browser']:
        raise UpdateError('DELIVERY_CONFIGURATION_CHANGED')
    native=u.owned('cronjob','native-ocr')
    if native['metadata'].get('uid')!=native_original['metadata'].get('uid') or native_spec(native)!=native_spec(native_original):raise UpdateError('DELIVERY_NATIVE_CONFIGURATION_CHANGED')
    current=native['spec']['jobTemplate']['spec']['template']['spec']['containers'][0]['image']
    if current not in (native_original['spec']['jobTemplate']['spec']['template']['spec']['containers'][0]['image'],selected['ocr']) or (final and current!=selected['ocr']):raise UpdateError('DELIVERY_NATIVE_IMAGE_CHANGED')
    if gateway_state is not None:gateway.verify(d,gateway_state,check_pods=final)
    if https_state is not None:https.verify(d,https_state,resource_envelope,check_pods=True)

def patch_native(original,selected):
    current=u.owned('cronjob','native-ocr');path='/spec/jobTemplate/spec/template/spec/containers/0'
    if not original['metadata'].get('uid') or current['metadata'].get('uid')!=original['metadata']['uid'] or native_spec(current)!=native_spec(original):raise UpdateError('DELIVERY_NATIVE_CONFIGURATION_CHANGED')
    container=current['spec']['jobTemplate']['spec']['template']['spec']['containers'][0]
    prior=original['spec']['jobTemplate']['spec']['template']['spec']['containers'][0]['image']
    if container.get('name')!='ocr' or container['image'] not in (prior,selected):raise UpdateError('DELIVERY_NATIVE_IMAGE_CHANGED')
    if container['image']==selected:return
    operations=[{'op':'test','path':'/metadata/uid','value':current['metadata']['uid']},
      {'op':'test','path':'/metadata/resourceVersion','value':current['metadata']['resourceVersion']},
      {'op':'test','path':path+'/name','value':'ocr'},{'op':'test','path':path+'/image','value':container['image']},
      {'op':'replace','path':path+'/image','value':selected}]
    d.command(['patch','cronjob','native-ocr','-n',d.NAMESPACE,'--type=json','--patch',json.dumps(operations)])

def wait_drain(name,selected,timeout=330):
    deadline=time.monotonic()+timeout
    while True:
        current=u.deployment(name)
        if image_of(current)!=selected:raise UpdateError('DELIVERY_RUNTIME_CHANGED')
        pending=[p for p in runtime.base.runtime_pods(name,current) if p.get('status',{}).get('phase') not in ('Succeeded','Failed') and p['spec']['containers'][0]['image']!=selected]
        if not pending:return
        if time.monotonic()>=deadline:raise UpdateError('DELIVERY_OLD_WORKER_NOT_DRAINED')
        time.sleep(3)

def verify_targets(original,selected,transition=False):
    for name in TARGETS:
        current=u.deployment(name)
        if name=='worker' and transition:current=code.worker_baseline(current,selected['runtime'])
        target=selected['frontend' if name=='frontend' else 'runtime']
        if current['metadata'].get('uid')!=original[name]['metadata'].get('uid') or image_of(current)!=target or u.without_image(current)!=u.without_image(original[name]):raise UpdateError('DELIVERY_WORKLOAD_ACCEPTANCE_FAILED')

def update():
    revision=os.environ.get('GITHUB_SHA','')
    if not re.fullmatch('[a-f0-9]{40}',revision):raise UpdateError('DELIVERY_RUN_SOURCE_INVALID')
    images.verify_checkout(revision)
    manifest=json.loads(release.MANIFEST.read_text());release.verify_source(manifest)
    if manifest['executor_max']!=4 or manifest['renderer_versions']!=[1,2,3] or manifest['minimum_worker_executor']!=4:raise UpdateError('DELIVERY_FINAL_RUNTIME_CONTRACT_REQUIRED')
    selected={name:u.image(os.environ.get('TENDERDESK_'+name.upper()+'_IMAGE',''),name) for name in images.IMAGES}
    for name,reference in selected.items():
        if images.inspect(reference,revision,name)!=reference:raise UpdateError('DELIVERY_IMAGE_SOURCE_MISMATCH')
    d.probe.validate_cluster()
    code.BASE_RUNTIME=manifest['baseline_images']['worker'];code.ROLLOUT_MARKER=MARKER
    original={name:u.deployment(name,ready=False) for name in TARGETS}
    observed_worker_resources=worker_resource_envelope(original['worker'])
    observed_api_resources=api_resource_envelope(original['api'])
    gateway_state=gateway.preflight(d,manifest.get('gateway_configuration'))
    https_state=https.preflight(d,manifest.get('https_configuration'),resource_envelope)
    for name,value in original.items():
        if image_of(value) not in (manifest['baseline_images'][name],selected['frontend' if name=='frontend' else 'runtime']):raise UpdateError('DELIVERY_WORKLOAD_BASELINE_CHANGED')
    original['worker']=code.worker_baseline(original['worker'],selected['runtime'])
    before=runtime.workload_snapshot();configuration=runtime.retained_configuration()
    for name,value in before.items():
        if name not in manifest['baseline_images'] or (name not in TARGETS and image_of(value)!=manifest['baseline_images'][name]):raise UpdateError('DELIVERY_OTHER_WORKLOAD_CHANGED')
    native_original=u.owned('cronjob','native-ocr')
    native_container=native_original['spec']['jobTemplate']['spec']['template']['spec']['containers'][0]
    if native_container.get('name')!='ocr' or native_container.get('command') or native_container.get('args'):
        raise UpdateError('DELIVERY_NATIVE_ENTRYPOINT_OVERRIDE')
    schedules=inventory.public_schedules([u.owned('cronjob','native-browser'),native_original])
    expected=copy.deepcopy(manifest['baseline_native_schedules'])
    # Generation advances on our single image patch; all actual schedule fields
    # and resource settings must still match the reviewed baseline.
    for actual,baseline in zip(schedules,expected):
        if actual['name']!=baseline['name']:raise UpdateError('DELIVERY_NATIVE_BASELINE_CHANGED')
        current_image=actual['image'];actual.pop('generation');baseline.pop('generation')
        if actual['name']=='native-ocr':actual['image']=baseline['image']
        if actual!=baseline or (actual['name']=='native-ocr' and current_image not in (baseline['image'],selected['ocr'])):raise UpdateError('DELIVERY_NATIVE_BASELINE_CHANGED')
    client=inventory.observer.Client(1800);client.labels['app.kubernetes.io/managed-by']=OWNER
    save_client(client)
    attempted=False;receipt=None
    try:
        client.prepare()
        verify_configuration(before,configuration,native_original,selected,https_state=https_state)
        api_binding=cutover.api_gateway_binding(d,original['api'])
        # Fail before the permanent gateway change if this runner cannot see
        # every relevant transaction. This preflight marker is not reused as
        # the drain boundary: that clock is captured only after process exits.
        cutover.observe_transactions(d,client)
        attempted=True
        # The unused resumable endpoint bypasses Storage's permission probe for
        # signed tokens. Install its qualified gateway denial before new schema
        # or runtime can rely on retirement. Never roll this guard back after an
        # ambiguous later stage; its exact bytes/spec are checked throughout.
        gateway_drain=cutover.GatewayDrain(d,gateway,gateway_state)
        old_gateway=gateway_drain.prepare()
        gateway.apply(d,gateway_state,after_rollout=gateway_drain.after_rollout)
        before['gateway']=gateway.after_snapshot(gateway_state)
        transaction_drain=cutover.drain_transactions(d,client)
        receipt=json.loads(d.sql(client.pod,release.migration_script(manifest)))
        if set(receipt)!={'release','manifest_sha256','catalog_sha256','replayed'} or receipt['release']!=release.RELEASE or receipt['manifest_sha256']!=release.digest(release.canonical(manifest).encode()) or not re.fullmatch('[a-f0-9]{64}',receipt['catalog_sha256']) or type(receipt['replayed']) is not bool:raise UpdateError('DELIVERY_SCHEMA_RECEIPT_INVALID')
        # All SQL becomes visible atomically before any runtime admits new pins.
        # The final batch must also enforce minimum_worker_executor4 on ALL
        # newly pinned normal/child/retry/render jobs. Its mixed-version claim
        # regression is a release prerequisite, not inferred from render jobs.
        code.patch_worker_strategy(original['worker'],selected['runtime'],True)
        code.patch_worker_image(original['worker'],selected['runtime'])
        d.wait_deployments(['worker']);wait_drain('worker',selected['runtime'])
        for name in ('api','source-browser','scheduler'):
            runtime.patch_runtime(name,selected['runtime'],original[name],manifest['baseline_images'][name]);d.wait_deployments([name]);wait_drain(name,selected['runtime'])
        patch_native(native_original,selected['ocr'])
        runtime.patch_runtime('frontend',selected['frontend'],original['frontend'],manifest['baseline_images']['frontend']);d.wait_deployments(['frontend'])
        verify_targets(original,selected,True);verify_configuration(before,configuration,native_original,selected,final=True,gateway_state=gateway_state,https_state=https_state)
        code.public_check(u.owned('configmap','frontend-config'))
        # Re-read the exact post-catalog receipt after runtime/public acceptance.
        check=json.loads(d.sql(client.pod,release.migration_script(manifest)))
        if check.get('manifest_sha256')!=receipt['manifest_sha256'] or check.get('catalog_sha256')!=receipt['catalog_sha256'] or check.get('replayed') is not True:raise UpdateError('DELIVERY_SCHEMA_RECHECK_FAILED')
        code.patch_worker_strategy(original['worker'],selected['runtime'],False)
        verify_targets(original,selected);verify_configuration(before,configuration,native_original,selected,final=True,gateway_state=gateway_state,https_state=https_state)
    except Exception:
        if attempted:emit('forward_completion_required',automatic_rollback=False,compatible_candidate_retained=True,images=selected)
        raise
    finally:
        try:client.cleanup();journal_path().unlink(missing_ok=True)
        except Exception:raise UpdateError('DELIVERY_CLIENT_CLEANUP_NOT_CONFIRMED') from None
    emit('passed',source_revision=revision,images=selected,schema=receipt,worker_resources=observed_worker_resources,api_resources=observed_api_resources,https_resources=https_state['resources'],https_configuration=manifest['https_configuration'],deployments_updated=list(TARGETS)+['gateway'],cronjobs_updated=['native-ocr'],old_workers_drained=True,configuration_preserved_except_reviewed_storage_gateway=True,storage_gateway_configuration=manifest['gateway_configuration'],command_batch_cutover={'api_binding':api_binding,'old_gateway':old_gateway,'actual_gateway_process_exits_proved':True,'transaction_drain':transaction_drain},processing_retried=False,hosted_artifact_acceptance=False)

def main(argv=()):
    try:
        # Suppress raw manifests/SQL/provider exceptions; only validated receipts
        # and fixed status codes leave the private runner.
        capture=io.StringIO()
        with redirect_stdout(capture),redirect_stderr(io.StringIO()):
            if argv==['--cleanup']:cleanup_saved_client()
            elif not argv:update()
            else:raise UpdateError('DELIVERY_MODE_INVALID')
        for line in capture.getvalue().splitlines():
            try:value=json.loads(line)
            except ValueError:continue
            if value.get('release')==release.RELEASE:print(json.dumps(value),flush=True)
        return 0
    except Exception as error:
        code_value=str(error)
        safe=code_value if isinstance(error,(UpdateError,release.ReleaseError,images.ImageError,cutover.CutoverError)) and re.fullmatch('[A-Z_]{1,100}',code_value) else 'DELIVERY_UPDATE_FAILED'
        emit('blocked',code=safe,automatic_rollback=False,forward_completion_may_be_required=True)
        return 1
if __name__=='__main__':sys.exit(main(sys.argv[1:]))
