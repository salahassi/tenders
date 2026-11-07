#!/usr/bin/env python3
"""Update only the API to the qualified runtime; require actual settings startup."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
from contextlib import redirect_stdout, redirect_stderr
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('workspace_startup_acceptance',HERE/'workspace-startup-diagnosis.py')
diagnostic=importlib.util.module_from_spec(spec);sys.modules[spec.name]=diagnostic;spec.loader.exec_module(diagnostic)
m=diagnostic.m
d,base,runtime,images=m.d,m.base,m.runtime,m.images
STATE={'stage':'preflight','patched':False,'rolled_back':False}

def verify_unchanged(before,configuration,candidate):
    actual=runtime.workload_snapshot();expected=copy.deepcopy(before)
    m.require(set(actual)==set(before),'WORKSPACE_WORKLOAD_SET_CHANGED')
    previous=expected['api']['spec']['template']['spec']['containers'][0]['image']
    m.require(actual['api']['spec']['template']['spec']['containers'][0]['image'] in (previous,candidate),'WORKSPACE_CONCURRENT_IMAGE_CHANGE')
    actual['api']['spec']['template']['spec']['containers'][0]['image']=previous
    m.require(actual==expected and runtime.retained_configuration()==configuration,'WORKSPACE_CONFIGURATION_CHANGED')

def rollback_api(original,reference,before,configuration):
    observed=base.image_of(m.u.deployment('api'))
    m.require(observed in (m.PREVIOUS_RUNTIME,reference),'WORKSPACE_ROLLBACK_CONCURRENT_CHANGE')
    if observed==reference:
        runtime.patch_runtime('api',m.PREVIOUS_RUNTIME,original['api'],reference)
        d.wait_deployments(['api'],seconds=30);base.wait_drain('api',m.PREVIOUS_RUNTIME,timeout=30)
    verify_unchanged(before,configuration,reference);STATE['rolled_back']=True

def validate_acceptance(report):
    m.require(report.get('version')==1 and report.get('kind')=='actual_workspace_startup' and set(report.get('table_counts',{}))==set(diagnostic.TABLES),'WORKSPACE_ACCEPTANCE_REPORT_INVALID')
    m.require(report.get('index_sha256')=='aaa576da3f4ebde3e1c8289ad6d0dfd93d486b1d5b8b53bf63a33c594e840616','WORKSPACE_FRONTEND_CHANGED')
    m.require(all(report.get(key) is True for key in ('settings_ready','models_visible','network_settled','auth_session_logged_out','owned_client_removed')),'WORKSPACE_UI_NOT_READY')
    m.require(all(report.get(key)==0 for key in ('alert_count','browser_errors','blocked_requests','business_mutations','model_requests')) and report.get('skeleton_visible') is False,'WORKSPACE_UI_FAILURE')
    for table,count in report['table_counts'].items():
        resource={'jobs':'job-summaries','knowledge_items':'knowledge'}.get(table,table.replace('_','-'))
        m.require(report['resources'].get(resource,{}).get('records')==count,'WORKSPACE_HISTORY_INCOMPLETE')
    m.require(report['api_requests']<100,'WORKSPACE_REQUEST_AMPLIFICATION')

def release():
    revision=os.environ.get('GITHUB_SHA','');images.verify_checkout(revision)
    q=images.qualification;root=images.release.ROOT.parent;receipt=q.load(root);q.verify_checkout(root,receipt);q.verify_native_receipts(root,receipt)
    reference=q.publication(root);source=receipt['qualified_image']['labels'][q.REVISION_LABEL]
    with (Path(os.environ['DOKS_WORKDIR'])/'workspace-runtime-pull.log').open('w') as log:
        result=subprocess.run(['docker','pull',reference],stdout=log,stderr=subprocess.STDOUT,timeout=45,check=False)
    m.require(result.returncode==0,'WORKSPACE_IMAGE_PULL_FAILED');images.inspect(reference,source,'runtime')
    d.probe.validate_cluster();m.front.namespace_owned()
    original={name:m.u.deployment(name) for name in m.TARGETS}
    m.require(all(base.image_of(original[name])==m.PREVIOUS_RUNTIME for name in m.RUNTIME) and base.image_of(original['frontend'])==m.COMPLETION_FRONTEND,'WORKSPACE_IMAGE_BASELINE_CHANGED')
    before=runtime.workload_snapshot();configuration=runtime.retained_configuration()
    def update_api(database):
        STATE['stage']='schema_preflight';m.verify_schema(database);verify_unchanged(before,configuration,reference)
        STATE['stage']='api_rollout';STATE['patched']=True
        runtime.patch_runtime('api',reference,original['api'],m.PREVIOUS_RUNTIME)
        d.wait_deployments(['api'],seconds=30);base.wait_drain('api',reference,timeout=30)
        verify_unchanged(before,configuration,reference);m.verify_schema(database);STATE['stage']='actual_settings_acceptance'
    try:
        report=diagnostic.diagnose(before_browser=update_api)
        report['auth_session_logged_out']=True;report['owned_client_removed']=True
        STATE['acceptance']=report;validate_acceptance(report);verify_unchanged(before,configuration,reference)
        m.require(base.image_of(m.u.deployment('api'))==reference,'WORKSPACE_FINAL_IMAGE_MISMATCH')
        return {'release':'workspace-full-content-pagination','status':'passed','source_revision':revision,'runtime_artifact_source':source,'api_image':reference,'frontend_image':m.COMPLETION_FRONTEND,'deployment_targets':['api'],'schema_manifest':m.SCHEMA_MANIFEST,'schema_catalog':m.SCHEMA_CATALOG,'schema_mutations':0,'configuration_preserved':True,'acceptance':report}
    except Exception:
        signal.alarm(0);STATE['failure_stage']=STATE['stage']
        if STATE['patched']:
            STATE['stage']='rollback';rollback_api(original,reference,before,configuration)
        raise

if __name__=='__main__':
    def deadline(signum,frame):raise m.ReleaseError('WORKSPACE_RELEASE_DEADLINE')
    try:
        signal.signal(signal.SIGALRM,deadline);signal.alarm(105)
        try:
            with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):result=release()
        finally:signal.alarm(0)
        print(json.dumps(result));sys.exit(0)
    except Exception as error:
        code=str(error) if re.fullmatch('[A-Z][A-Z0-9_]{0,99}',str(error)) else 'WORKSPACE_RELEASE_FAILED'
        print(json.dumps({'release':'workspace-full-content-pagination','status':'failed','code':code,'state':STATE}));sys.exit(1)
