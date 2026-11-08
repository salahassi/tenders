#!/usr/bin/env python3
"""Frontend-only model settings correction; no schema or provider mutations."""
import copy, hashlib, importlib.util, io, json, os, re, signal, subprocess, sys
from pathlib import Path
from contextlib import redirect_stdout, redirect_stderr
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('model_settings_diagnostic',HERE/'workspace-startup-diagnosis.py')
diagnostic=importlib.util.module_from_spec(spec);sys.modules[spec.name]=diagnostic;spec.loader.exec_module(diagnostic)
m=diagnostic.m;d,base,runtime,images=m.d,m.base,m.runtime,m.images
API='registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:f573e991e622c982e82a4a3b4e6dc6f144e87586ba0f5dd0b3d05381b30dbd6a'
STATE={'stage':'preflight','patched':False,'rolled_back':False}

def verify_unchanged(before,configuration,candidate):
    actual=runtime.workload_snapshot();expected=copy.deepcopy(before)
    m.require(set(actual)==set(before),'MODEL_SETTINGS_WORKLOAD_SET_CHANGED')
    prior=expected['frontend']['spec']['template']['spec']['containers'][0]['image']
    m.require(actual['frontend']['spec']['template']['spec']['containers'][0]['image'] in (prior,candidate),'MODEL_SETTINGS_CONCURRENT_IMAGE_CHANGE')
    actual['frontend']['spec']['template']['spec']['containers'][0]['image']=prior
    m.require(actual==expected and runtime.retained_configuration()==configuration,'MODEL_SETTINGS_CONFIGURATION_CHANGED')

def rollback(original,candidate,before,configuration):
    observed=base.image_of(m.u.deployment('frontend'))
    m.require(observed in (m.COMPLETION_FRONTEND,candidate),'MODEL_SETTINGS_ROLLBACK_CONCURRENT_CHANGE')
    if observed==candidate:
        runtime.patch_runtime('frontend',m.COMPLETION_FRONTEND,original['frontend'],candidate)
        d.wait_deployments(['frontend'],seconds=25);base.wait_drain('frontend',m.COMPLETION_FRONTEND,timeout=25)
    verify_unchanged(before,configuration,candidate);STATE['rolled_back']=True

def validate_acceptance(report,index):
    m.require(report.get('index_sha256')==index,'MODEL_SETTINGS_PUBLIC_IMAGE_MISMATCH')
    m.require(all(report.get(k) is True for k in ('settings_ready','models_visible','network_settled','auth_session_logged_out','owned_client_removed')),'MODEL_SETTINGS_UI_NOT_READY')
    m.require(all(report.get(k)==0 for k in ('alert_count','browser_errors','blocked_requests','business_mutations','model_requests')) and report.get('skeleton_visible') is False,'MODEL_SETTINGS_UI_FAILED')
    m.require(set(report.get('table_counts',{}))==set(diagnostic.TABLES),'MODEL_SETTINGS_HISTORY_NOT_CHECKED')
    for table,count in report['table_counts'].items():
        resource={'jobs':'job-summaries','knowledge_items':'knowledge'}.get(table,table.replace('_','-'))
        m.require(report['resources'].get(resource,{}).get('records')==count,'MODEL_SETTINGS_HISTORY_INCOMPLETE')
    checks=report.get('model_poll_checks',[])
    m.require(len(checks)==2 and all(c.get('settled') is True and c.get('status_reads')==1 and c.get('business_reads')==0 and c.get('catalog_reads') in (0,5) and c.get('api_requests')==1+c.get('catalog_reads',-1) for c in checks),'MODEL_SETTINGS_POLL_AMPLIFICATION')
    m.require(report.get('api_requests',100)>=2 and report['api_requests']<100,'MODEL_SETTINGS_STARTUP_AMPLIFICATION')

def release():
    revision=os.environ['GITHUB_SHA'];images.verify_checkout(revision)
    publication=json.loads((HERE.parent.parent/'docs/evidence/model-settings-publication-20261108.json').read_text())
    source=publication['source_revision'];candidate=publication['reference']
    m.require(re.fullmatch('[a-f0-9]{40}',source) and re.fullmatch(re.escape(images.REGISTRY+'frontend')+r'@sha256:[a-f0-9]{64}',candidate),'MODEL_SETTINGS_ARTIFACT_INVALID')
    # All application build inputs must match the committed image source.
    for args in (['merge-base','--is-ancestor',source,revision],['diff','--exit-code',source,revision,'--','frontend','backend/supabase/functions/_shared']):
        m.require(subprocess.run(['git',*args],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0,'MODEL_SETTINGS_SOURCE_CHANGED')
    q=images.qualification;root=images.release.ROOT.parent;q.verify_checkout(root,q.load(root))
    with (Path(os.environ['DOKS_WORKDIR'])/'model-settings-pull.log').open('w') as log:
        m.require(subprocess.run(['docker','pull',candidate],stdout=log,stderr=subprocess.STDOUT,timeout=40).returncode==0,'MODEL_SETTINGS_PULL_FAILED')
    images.inspect(candidate,source,'frontend');d.probe.validate_cluster();m.front.namespace_owned()
    original={name:m.u.deployment(name) for name in m.TARGETS}
    m.require(base.image_of(original['api'])==API and all(base.image_of(original[n])==m.PREVIOUS_RUNTIME for n in ('worker','source-browser','scheduler')) and base.image_of(original['frontend'])==m.COMPLETION_FRONTEND,'MODEL_SETTINGS_BASELINE_CHANGED')
    before=runtime.workload_snapshot();configuration=runtime.retained_configuration()
    STATE['stage']='immutable_browser_checks'
    expected,proof=m.assets.verified_assets(candidate,source,images,m.front,model_settings=True)
    fixture=proof.pop('model_settings_browser_fixture')
    def update(database):
        STATE['stage']='schema_preflight';m.verify_schema(database);verify_unchanged(before,configuration,candidate)
        STATE['stage']='frontend_rollout';STATE['patched']=True
        runtime.patch_runtime('frontend',candidate,original['frontend'],m.COMPLETION_FRONTEND)
        d.wait_deployments(['frontend'],seconds=25);base.wait_drain('frontend',candidate,timeout=25)
        verify_unchanged(before,configuration,candidate);m.verify_schema(database)
        STATE['stage']='public_assets_and_pdf'
        with m.assets.reference_directory(expected) as directory:m.front.public_check(m.u.owned('configmap','frontend-config'),expected,asset_directory=directory)
        STATE['stage']='actual_settings_and_polling'
    try:
        report=diagnostic.diagnose(before_browser=update,observe_model_polls=True)
        report.update(auth_session_logged_out=True,owned_client_removed=True)
        STATE['acceptance']=report;validate_acceptance(report,hashlib.sha256(expected['index']).hexdigest());verify_unchanged(before,configuration,candidate)
        m.require(base.image_of(m.u.deployment('frontend'))==candidate,'MODEL_SETTINGS_FINAL_IMAGE_MISMATCH')
        return {'release':'model-settings-scoped-refresh','status':'passed','source_revision':revision,'artifact_source':source,'frontend_image':candidate,'deployment_targets':['frontend'],'schema_manifest':m.SCHEMA_MANIFEST,'schema_catalog':m.SCHEMA_CATALOG,'schema_mutations':0,'configuration_preserved':True,'frontend_artifact':proof,'isolated_toggle_acceptance':fixture,'production_read_only_acceptance':report}
    except Exception:
        signal.alarm(0);STATE['failure_stage']=STATE['stage']
        if STATE['patched']:STATE['stage']='rollback';rollback(original,candidate,before,configuration)
        raise

if __name__=='__main__':
    def deadline(signum,frame):raise m.ReleaseError('MODEL_SETTINGS_RELEASE_DEADLINE')
    try:
        signal.signal(signal.SIGALRM,deadline);signal.alarm(110)
        try:
            with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):result=release()
        finally:signal.alarm(0)
        print(json.dumps(result))
    except Exception as error:
        code=str(error) if re.fullmatch('[A-Z][A-Z0-9_]{0,99}',str(error)) else 'MODEL_SETTINGS_RELEASE_FAILED'
        print(json.dumps({'release':'model-settings-scoped-refresh','status':'failed','code':code,'state':STATE}));sys.exit(1)
