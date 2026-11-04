#!/usr/bin/env python3
"""Version 2 saved delivery acceptance; GET-only current snapshot and storage checks.

The existing Owner receives a genuine isolated Auth session using the reviewed
generate_link/verify pattern without sending email or changing a password.
Service credentials remain in Python; the HTTP verifier receives only the isolated access token.
All output documents and selected identities use encrypted private transport.
"""
from __future__ import annotations
import argparse
from contextlib import redirect_stdout, redirect_stderr
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import uuid

HERE = Path(__file__).resolve().parent
def load(name, filename):
    spec=importlib.util.spec_from_file_location(name,HERE/filename)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
    return module
observer=load('export_acceptance_observer','observe-assessment-recovery.py')
transfer=load('export_acceptance_transfer','private-transfer.py')
resume=load('export_acceptance_runtime','resume-requested-processing.py')
smoke=load('export_acceptance_auth','digitalocean-smoke.py')
access=observer.access
BUCKET='tenderdesk-migration-a6093a76-sfo3'

class AcceptanceError(Exception): pass

def child_environment():
    # Chromium needs network/CA/runtime settings, never the parent cluster or
    # deployment credential paths. Its only application identity crosses stdin.
    privileged={'DIGITALOCEAN_ACCESS_TOKEN','GH_TOKEN','GITHUB_TOKEN','KUBECONFIG','KUBECTL','DOKS_WORKDIR','DOCKER_CONFIG'}
    return {k:v for k,v in os.environ.items() if k not in privileged}

def validate_selection(value):
    keys={'version','workspace_id','opportunity_id','proposal_id','snapshot_id','delivery_revision','content_hash','expectation','input_state','package_status','plan_id','issuance_id','issuance_outcome','wait_seconds'}
    if not isinstance(value,dict) or set(value)!=keys or type(value['version']) is not int or value['version']!=2:
        raise AcceptanceError('DELIVERY_SELECTION_INVALID')
    for key in ('workspace_id','opportunity_id','proposal_id','snapshot_id'):
        try:
            if str(uuid.UUID(value[key]))!=value[key]: raise ValueError()
        except (ValueError,TypeError,AttributeError): raise AcceptanceError('DELIVERY_SELECTION_INVALID') from None
    if value['workspace_id']!=access.WORKSPACE or type(value['delivery_revision']) is not int or not 1<=value['delivery_revision']<=2147483647 or not isinstance(value['content_hash'],str) or not re.fullmatch(r'[a-f0-9]{64}',value['content_hash']):
        raise AcceptanceError('DELIVERY_SELECTION_INVALID')
    if value['expectation'] not in ('template','partial','substantive','issued') or value['input_state'] not in ('available','partial','insufficient') or value['package_status'] not in ('ready','preparing','blocked') or type(value['wait_seconds']) is not int or not 0<=value['wait_seconds']<=600:
        raise AcceptanceError('DELIVERY_SELECTION_INVALID')
    if any(value[k] is not None for k in ('plan_id','issuance_id','issuance_outcome')):
        for key in ('plan_id','issuance_id'):
            try:
                if str(uuid.UUID(value[key]))!=value[key]: raise ValueError()
            except (ValueError,TypeError,AttributeError): raise AcceptanceError('DELIVERY_SELECTION_INVALID') from None
        if value['issuance_outcome'] not in ('active','issued','failed'): raise AcceptanceError('DELIVERY_SELECTION_INVALID')
    if value['expectation']=='issued' and (value['issuance_outcome']!='issued' or value['package_status']!='ready'):
        raise AcceptanceError('DELIVERY_SELECTION_INVALID')
    return value

def selection_sql(selection):
    validate_selection(selection)
    return (HERE/'delivery-snapshot-selection.sql').read_text().replace('__SELECTION__',json.dumps(selection,separators=(',',':')))

legacy=load('delivery_acceptance_auth_helpers','proposal-export-acceptance.py')
genuine_session=legacy.genuine_session
verify_session=legacy.verify_session

def validate_report(report):
    if not isinstance(report,dict) or report.get('version')!=2 or report.get('kind')!='saved_delivery_acceptance' or type(report.get('passed')) is not bool or not isinstance(report.get('artifacts'),list) or len(report['artifacts'])>2:
        raise AcceptanceError('DELIVERY_REPORT_INVALID')
    if report['passed'] and (report.get('business_writes')!=0 or report.get('model_calls')!=0 or report.get('path')!='authenticated_http'):
        raise AcceptanceError('DELIVERY_REPORT_INVALID')
    return report

def public_receipt(report,digest):
    return {'saved_delivery_acceptance':'passed' if report['passed'] else 'failed',
            'expectation':report.get('expectation'),'package_status':report.get('package_status'),
            'deliverable_verified':report.get('deliverable_verified',False),'issuance_verified':report.get('issuance_verified',False),
            'artifacts':len(report['artifacts']),'report_sha256':digest,'model_calls':0,'business_writes':0}

def main(argv=None):
    if os.environ.get('RUN_SAVED_DELIVERY_ACCEPTANCE')!='true':
        print('{"saved_delivery_acceptance":"not_activated"}');return 0
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--selection-object',required=True);parser.add_argument('--selection-sha256',required=True)
    parser.add_argument('--expected-runtime-image',required=True)
    args=parser.parse_args(argv)
    directory=database=client=session=None
    failure=receipt=None;stage='selection_reference'
    try:
        if not re.fullmatch(r'requests/[A-Za-z0-9][A-Za-z0-9._/-]{0,160}\.bundle',args.selection_object) or not re.fullmatch(r'[a-f0-9]{64}',args.selection_sha256):
            raise AcceptanceError('DELIVERY_SELECTION_REFERENCE_INVALID')
        transfer.identity(BUCKET,args.selection_object)
        os.umask(0o077)
        with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):
            stage='cluster_prepare';directory=access.prepare_cluster()
            resume.verify_runtime(args.expected_runtime_image)
            stage='selection_download';path=directory/'export-selection.json'
            transfer.download(os.environ['DIGITALOCEAN_ACCESS_TOKEN'],BUCKET,args.selection_object,path,args.selection_sha256)
            raw=transfer.read_private(path)
            if len(raw)>8192: raise AcceptanceError('DELIVERY_SELECTION_INVALID')
            selected=validate_selection(json.loads(raw))
            stage='current_delivery_check';database=observer.Client(120);database.prepare()
            identity=json.loads(access.d.sql(database.pod,selection_sql(selected)))
            database.cleanup();database=None
            actor_id=str(uuid.UUID(identity['actor_id']))
            core=access.d.decode_secret(access.d.get('secret','tenderdesk-core'))
            public=smoke.javascript_config(access.d.get('configmap','frontend-config')['data']['runtime-config.js'].encode())
            if public['publishableKey']!=core['ANON_KEY']: raise AcceptanceError('DELIVERY_CONFIGURATION_MISMATCH')
            config=smoke.Config(public['appOrigin'],core['ANON_KEY'],core['SERVICE_KEY'],core['JWT_SECRET']);client=smoke.Client(config)
            stage='genuine_auth_session';session=genuine_session(client,config,actor_id,selected['workspace_id'])
            verify_session(client,config,session,actor_id,selected['workspace_id'])
            stage='draft_export_acceptance'
            payload={**selected,'actor_id':actor_id,'origin':config.origin,'access_token':session['access_token']}
            execution=subprocess.run(['node','--experimental-transform-types',str(HERE/'delivery-snapshot-acceptance.mjs')],input=json.dumps(payload),capture_output=True,text=True,timeout=720,
                env=child_environment())
            if len(execution.stdout.encode())>32*1024*1024: raise AcceptanceError('DELIVERY_REPORT_TOO_LARGE')
            report=validate_report(json.loads(execution.stdout))
            report['source_sha']=os.environ.get('GITHUB_SHA','')
            report['expected_runtime_image']=args.expected_runtime_image
            report['application_origin']=config.origin
            report['auth_mechanism']='existing_allowlisted_owner_genuine_isolated_auth_session'
            secrets=[core[k] for k in ('ANON_KEY','SERVICE_KEY','JWT_SECRET')]+[session['access_token'],session['refresh_token']]
            if any(secret and secret in json.dumps(report) for secret in secrets): raise AcceptanceError('DELIVERY_SECRET_IN_REPORT')
            stage='session_logout';smoke.expect(client.request('/auth/v1/logout?scope=local',token=session['access_token'],method='POST'),{200,204},'DELIVERY_SESSION_LOGOUT_FAILED');session=None
            stage='private_report_upload';output=directory/'delivery-snapshot-acceptance.json'
            transfer.write_private(output,json.dumps(report,ensure_ascii=False).encode())
            digest=transfer.upload(os.environ['DIGITALOCEAN_ACCESS_TOKEN'],BUCKET,'diagnostics/delivery-snapshot-acceptance-'+os.environ['GITHUB_RUN_ID']+'.bundle',output)
            receipt=public_receipt(report,digest)
    except Exception as error:
        code=getattr(error,'code',None) or str(error)
        failure=code if isinstance(code,str) and re.fullmatch(r'[A-Z0-9_]{1,100}',code) else 'DELIVERY_ACCEPTANCE_FAILED'
    finally:
        try:
            with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):
                if session and client and session.get('access_token'):
                    smoke.expect(client.request('/auth/v1/logout?scope=local',token=session['access_token'],method='POST'),{200,204},'DELIVERY_SESSION_LOGOUT_FAILED')
                if database: database.cleanup()
        except Exception: failure='DELIVERY_CLEANUP_NOT_CONFIRMED'
        try:
            if directory: shutil.rmtree(directory)
        except Exception: failure='DELIVERY_RUNNER_CLEANUP_NOT_CONFIRMED'
    if failure:
        print(json.dumps({'saved_delivery_acceptance':'failed','code':failure,'stage':stage}));return 1
    print(json.dumps(receipt));return 0 if receipt['saved_delivery_acceptance']=='passed' else 1

if __name__=='__main__':sys.exit(main())
