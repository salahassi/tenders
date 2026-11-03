#!/usr/bin/env python3
"""Explicitly selected actual draft export acceptance; never generates or approves a proposal.

The existing Owner receives a genuine isolated Auth session using the reviewed
generate_link/verify pattern without sending email or changing a password.
Service credentials remain in Python; the browser receives only that session.
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
    keys={'version','workspace_id','opportunity_id','plan_id','proposal_version_id','expected_revision'}
    if not isinstance(value,dict) or set(value)!=keys or type(value['version']) is not int or value['version']!=1:
        raise AcceptanceError('EXPORT_SELECTION_INVALID')
    for key in ('workspace_id','opportunity_id','plan_id','proposal_version_id'):
        try:
            if str(uuid.UUID(value[key]))!=value[key]: raise ValueError()
        except (ValueError,TypeError,AttributeError): raise AcceptanceError('EXPORT_SELECTION_INVALID') from None
    if value['workspace_id']!=access.WORKSPACE or type(value['expected_revision']) is not int or not 1<=value['expected_revision']<=2147483647:
        raise AcceptanceError('EXPORT_SELECTION_INVALID')
    return value

def selection_sql(selection):
    validate_selection(selection)
    return (HERE/'proposal-export-selection.sql').read_text().replace('__SELECTION__',json.dumps(selection,separators=(',',':')))

def genuine_session(client, config, actor_id, workspace_id):
    """No invitation, email, forged JWT, password change or business service-role request."""
    user=smoke.expect(client.request('/auth/v1/admin/users/'+actor_id,token=config.service_key),{200},'EXPORT_ACTOR_LOOKUP_FAILED').json('EXPORT_ACTOR_LOOKUP_INVALID')
    if user.get('id')!=actor_id or user.get('role')!=smoke.PREFIX+'_authenticated' or not user.get('email_confirmed_at') or not user.get('email'):
        raise AcceptanceError('EXPORT_ACTOR_IDENTITY_INVALID')
    link=smoke.expect(client.request('/auth/v1/admin/generate_link',token=config.service_key,method='POST',data={'type':'magiclink','email':user['email']}),{200},'EXPORT_SESSION_LINK_FAILED').json('EXPORT_SESSION_LINK_INVALID')
    if not isinstance(link.get('hashed_token'),str) or not link['hashed_token']:
        raise AcceptanceError('EXPORT_SESSION_LINK_INVALID')
    session=smoke.expect(client.request('/auth/v1/verify',token=config.anon_key,method='POST',data={'type':'magiclink','token_hash':link['hashed_token']}),{200},'EXPORT_SESSION_VERIFY_FAILED').json('EXPORT_SESSION_INVALID')
    # Caller stores this session immediately and validates it before any export.
    return session

def verify_session(client, config, session, actor_id, workspace_id):
    token=session.get('access_token')
    if not isinstance(token,str) or not token or not isinstance(session.get('refresh_token'),str):
        raise AcceptanceError('EXPORT_SESSION_INVALID')
    claims=smoke.jwt_claims(token,config.jwt_secret,smoke.PREFIX+'_authenticated',config.origin+'/auth/v1')
    if claims.get('sub')!=actor_id or session.get('user',{}).get('id')!=actor_id:
        raise AcceptanceError('EXPORT_SESSION_IDENTITY_MISMATCH')
    user=smoke.expect(client.request('/auth/v1/user',token=token),{200},'EXPORT_SESSION_USER_FAILED').json('EXPORT_SESSION_USER_INVALID')
    bootstrap=smoke.expect(client.request('/functions/v1/api/v1/bootstrap',token=token),{200},'EXPORT_BOOTSTRAP_FAILED').json('EXPORT_BOOTSTRAP_INVALID').get('data',{})
    member=bootstrap.get('membership',{})
    if user.get('id')!=actor_id or member.get('user_id')!=actor_id or member.get('workspace_id')!=workspace_id or member.get('role')!='Owner' or bootstrap.get('workspace',{}).get('id')!=workspace_id:
        raise AcceptanceError('EXPORT_WORKSPACE_IDENTITY_MISMATCH')

def validate_report(report):
    if not isinstance(report,dict) or report.get('version')!=1 or report.get('kind')!='actual_proposal_draft_export' or type(report.get('passed')) is not bool or report.get('mode') not in {'browser','http'} or not isinstance(report.get('artifacts'),list) or len(report['artifacts'])>2:
        raise AcceptanceError('EXPORT_REPORT_INVALID')
    return report

def public_receipt(report,digest):
    return {'actual_proposal_draft_export':'passed' if report['passed'] else 'failed','acceptance_path':report['mode'],
            'artifacts':len(report['artifacts']),'report_sha256':digest,'model_calls':0,'final_approval_changed':False}

def main(argv=None):
    if os.environ.get('RUN_ACTUAL_PROPOSAL_EXPORT_ACCEPTANCE')!='true':
        print('{"actual_proposal_draft_export":"not_activated"}');return 0
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--selection-object',required=True);parser.add_argument('--selection-sha256',required=True)
    parser.add_argument('--expected-runtime-image',required=True);parser.add_argument('--mode',choices=['browser','http'],default='browser')
    args=parser.parse_args(argv)
    directory=database=client=session=None
    failure=receipt=None;stage='selection_reference'
    try:
        if not re.fullmatch(r'requests/[A-Za-z0-9][A-Za-z0-9._/-]{0,160}\.bundle',args.selection_object) or not re.fullmatch(r'[a-f0-9]{64}',args.selection_sha256):
            raise AcceptanceError('EXPORT_SELECTION_REFERENCE_INVALID')
        transfer.identity(BUCKET,args.selection_object)
        os.umask(0o077)
        with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):
            stage='cluster_prepare';directory=access.prepare_cluster()
            resume.verify_runtime(args.expected_runtime_image)
            stage='selection_download';path=directory/'export-selection.json'
            transfer.download(os.environ['DIGITALOCEAN_ACCESS_TOKEN'],BUCKET,args.selection_object,path,args.selection_sha256)
            raw=transfer.read_private(path)
            if len(raw)>8192: raise AcceptanceError('EXPORT_SELECTION_INVALID')
            selected=validate_selection(json.loads(raw))
            stage='completed_version_check';database=observer.Client(120);database.prepare()
            identity=json.loads(access.d.sql(database.pod,selection_sql(selected)))
            database.cleanup();database=None
            actor_id=str(uuid.UUID(identity['actor_id']));proposal_id=str(uuid.UUID(identity['proposal_id']))
            core=access.d.decode_secret(access.d.get('secret','tenderdesk-core'))
            public=smoke.javascript_config(access.d.get('configmap','frontend-config')['data']['runtime-config.js'].encode())
            if public['publishableKey']!=core['ANON_KEY']: raise AcceptanceError('EXPORT_CONFIGURATION_MISMATCH')
            config=smoke.Config(public['appOrigin'],core['ANON_KEY'],core['SERVICE_KEY'],core['JWT_SECRET']);client=smoke.Client(config)
            stage='genuine_auth_session';session=genuine_session(client,config,actor_id,selected['workspace_id'])
            verify_session(client,config,session,actor_id,selected['workspace_id'])
            stage='draft_export_acceptance'
            payload={**{k:v for k,v in selected.items() if k!='version'},'actor_id':actor_id,'proposal_id':proposal_id,
                     'origin':config.origin,'access_token':session['access_token'],'session':session,'mode':args.mode,'run_id':os.environ['GITHUB_RUN_ID']}
            execution=subprocess.run(['node','--experimental-transform-types',str(HERE/'proposal-export-acceptance.mjs')],input=json.dumps(payload),capture_output=True,text=True,timeout=600,
                env=child_environment())
            if len(execution.stdout.encode())>32*1024*1024: raise AcceptanceError('EXPORT_REPORT_TOO_LARGE')
            report=validate_report(json.loads(execution.stdout))
            report['source_sha']=os.environ.get('GITHUB_SHA','')
            report['expected_runtime_image']=args.expected_runtime_image
            report['application_origin']=config.origin
            report['auth_mechanism']='existing_allowlisted_owner_genuine_isolated_auth_session'
            secrets=[core[k] for k in ('ANON_KEY','SERVICE_KEY','JWT_SECRET')]+[session['access_token'],session['refresh_token']]
            if any(secret and secret in json.dumps(report) for secret in secrets): raise AcceptanceError('EXPORT_SECRET_IN_REPORT')
            stage='session_logout';smoke.expect(client.request('/auth/v1/logout?scope=local',token=session['access_token'],method='POST'),{200,204},'EXPORT_SESSION_LOGOUT_FAILED');session=None
            stage='private_report_upload';output=directory/'proposal-export-acceptance.json'
            transfer.write_private(output,json.dumps(report,ensure_ascii=False).encode())
            digest=transfer.upload(os.environ['DIGITALOCEAN_ACCESS_TOKEN'],BUCKET,'diagnostics/proposal-export-acceptance-'+os.environ['GITHUB_RUN_ID']+'.bundle',output)
            receipt=public_receipt(report,digest)
    except Exception as error:
        code=getattr(error,'code',None) or str(error)
        failure=code if isinstance(code,str) and re.fullmatch(r'[A-Z0-9_]{1,100}',code) else 'EXPORT_ACCEPTANCE_FAILED'
    finally:
        try:
            with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):
                if session and client and session.get('access_token'):
                    smoke.expect(client.request('/auth/v1/logout?scope=local',token=session['access_token'],method='POST'),{200,204},'EXPORT_SESSION_LOGOUT_FAILED')
                if database: database.cleanup()
        except Exception: failure='EXPORT_CLEANUP_NOT_CONFIRMED'
        try:
            if directory: shutil.rmtree(directory)
        except Exception: failure='EXPORT_RUNNER_CLEANUP_NOT_CONFIRMED'
    if failure:
        print(json.dumps({'actual_proposal_draft_export':'failed','code':failure,'stage':stage}));return 1
    print(json.dumps(receipt));return 0 if receipt['actual_proposal_draft_export']=='passed' else 1

if __name__=='__main__':sys.exit(main())
