#!/usr/bin/env python3
"""Read-only actual workspace startup, with a genuine isolated Owner session."""
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import traceback
from contextlib import redirect_stdout, redirect_stderr
import io
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('startup_summary_release',HERE/'job-summary-release.py')
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
d,base,auth=m.d,m.base,m.auth
STAGE='client_identity'
TABLES=('sources','source_runs','opportunities','knowledge_items','jobs','notifications','proposals','documents','proposal_versions','proposal_sections','questions','review_inputs','regeneration_requests','requirements','fit_assessments','opportunity_discovery')

def diagnose(before_browser=None, observe_model_polls=False):
    global STAGE
    database=base.inventory.observer.Client(1800);database.labels['app.kubernetes.io/managed-by']=base.OWNER;base.save_client(database)
    client=session=None
    try:
        STAGE='cluster_identity';d.probe.validate_cluster();m.front.namespace_owned()
        STAGE='client_prepare';database.prepare()
        workspace=auth.access.WORKSPACE
        m.require(bool(re.fullmatch('[a-f0-9-]{36}',workspace)),'STARTUP_WORKSPACE_INVALID')
        counts=','.join("'%s',(SELECT count(*) FROM public.%s WHERE workspace_id='%s')"%(table,table,workspace) for table in TABLES)
        sql="BEGIN READ ONLY;SET LOCAL ROLE tdp_app_owner;SET LOCAL statement_timeout='20s';SELECT jsonb_build_object('counts',jsonb_build_object("+counts+"),'owners',(SELECT jsonb_agg(m.user_id) FROM public.memberships m JOIN public.identity_allowlist a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id WHERE m.workspace_id='"+workspace+"' AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner'));COMMIT;"
        STAGE='aggregate_read';snapshot=json.loads(d.sql(database.pod,sql));m.require(len(snapshot['owners'])==1,'STARTUP_SOLE_OWNER_REQUIRED')
        STAGE='auth_configuration';core=d.decode_secret(d.get('secret','tenderdesk-core'))
        public=auth.smoke.javascript_config(d.get('configmap','frontend-config')['data']['runtime-config.js'].encode())
        m.require(public['publishableKey']==core['ANON_KEY'],'STARTUP_CONFIGURATION_MISMATCH')
        config=auth.smoke.Config(public['appOrigin'],core['ANON_KEY'],core['SERVICE_KEY'],core['JWT_SECRET']);client=auth.smoke.Client(config)
        STAGE='isolated_session';session=auth.genuine_session(client,config,snapshot['owners'][0],workspace);auth.verify_session(client,config,session,snapshot['owners'][0],workspace)
        if before_browser is not None:before_browser(database)
        STAGE='actual_browser';result=subprocess.run(['node',str(HERE/'workspace-startup-diagnosis.mjs')],input=json.dumps({'origin':config.origin,'session':session,'observe_model_polls':observe_model_polls}),capture_output=True,text=True,timeout=90,env=auth.child_environment())
        m.require(result.returncode==0 and len(result.stdout)<32768,'STARTUP_BROWSER_FAILED')
        report=json.loads(result.stdout);report['table_counts']=snapshot['counts'];report['source_revision']=os.environ['GITHUB_SHA']
        return report
    finally:
        try:
            if session:auth.smoke.expect(client.request('/auth/v1/logout?scope=local',token=session['access_token'],method='POST'),{200,204},'STARTUP_LOGOUT_NOT_CONFIRMED')
        finally:base.cleanup_saved_client()

if __name__=='__main__':
    try:
        with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):report=diagnose()
        report['auth_session_logged_out']=True;report['owned_client_removed']=True;print(json.dumps(report))
    except Exception as error:
        code=str(error) if re.fullmatch('[A-Z][A-Z0-9_]{0,99}',str(error)) else 'STARTUP_DIAGNOSTIC_FAILED'
        print(json.dumps({'workspace_startup_diagnosis':'failed','code':code,'stage':STAGE,'exception':type(error).__name__,'frames':[{'file':Path(f.filename).name,'line':f.lineno} for f in traceback.extract_tb(error.__traceback__) if Path(f.filename).parent==HERE]}));sys.exit(1)
