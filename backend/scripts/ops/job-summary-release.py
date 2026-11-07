#!/usr/bin/env python3
"""Image-only pagination release against the already applied schema; never starts work."""
import copy
from contextlib import redirect_stdout, redirect_stderr
import io
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid
import importlib.util
HERE=Path(__file__).resolve().parent

def load(name,file):
    s=importlib.util.spec_from_file_location(name,HERE/file);m=importlib.util.module_from_spec(s);sys.modules[name]=m;s.loader.exec_module(m);return m
base=load('summary_release_base','proposal-delivery-update.py')
front=load('summary_release_frontend','digitalocean-update-frontend.py')
auth=load('summary_release_auth','proposal-export-acceptance.py')
assets=load('summary_frontend_image_assets','frontend-image-assets.py')
d,u,runtime,images=base.d,base.u,base.runtime,base.images
RUNTIME=('api','worker','source-browser','scheduler')
TARGETS=RUNTIME+('frontend',)
PREVIOUS_RUNTIME='registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:077b06edd81eb58296ef755e7baa8af32a73dd931c6f06097acc513d3f684e3e'
PREVIOUS_FRONTEND='registry.digitalocean.com/tenderdesk-a6093a76/frontend@sha256:32f26e92e33861e591fbc408cea0fca8ca817a7bd5496f11f48d32a2c53cf180'
SCHEMA_MANIFEST='ada21f57461fa81e3b45778685d86438117ef419ad8c31ceaac86c06dcb2dba3'
SCHEMA_CATALOG='8f82c88194713bff62224f307d8ab6744a42f4d7fa57a3559fafc4d083cddc04'
class ReleaseError(Exception):pass
STATE={'stage':'initial','patched':[],'rolled_back':[],'rollback_failed':[]}

def rollback(touched,selected,original):
    STATE['stage']='rollback'
    for name in reversed(touched):
        try:
            candidate=selected['frontend' if name=='frontend' else 'runtime'];prior=base.image_of(original[name])
            runtime.patch_runtime(name,prior,original[name],candidate)
            d.wait_deployments([name]);base.wait_drain(name,prior)
            STATE['rolled_back'].append(name)
        except Exception:
            STATE['rollback_failed'].append(name)
    require(not STATE['rollback_failed'],'SUMMARY_ROLLBACK_NOT_CONFIRMED')

def require(ok,code):
    if not ok:raise ReleaseError(code)

def verify_schema(client):
    result=base.inventory.public_schema(json.loads(d.sql(client.pod,(HERE/'digitalocean-inventory.sql').read_text())))
    ledger={r['release']:r['migration_sha256'] for r in result['release_history']}
    require(result['routine_catalog_sha256']==SCHEMA_CATALOG and ledger.get(base.release.RELEASE)==SCHEMA_MANIFEST,'SUMMARY_SCHEMA_BASELINE_CHANGED')
    return {'manifest_sha256':SCHEMA_MANIFEST,'catalog_sha256':SCHEMA_CATALOG,'schema_mutations':0}

def verify_unchanged(original,configuration,selected):
    current=runtime.workload_snapshot()
    require(set(current)==set(original),'SUMMARY_WORKLOAD_SET_CHANGED')
    for name,old in original.items():
        actual=copy.deepcopy(current[name]);expected=copy.deepcopy(old)
        if name in TARGETS:
            prior=old['spec']['template']['spec']['containers'][0]['image']
            allowed={prior,selected['frontend' if name=='frontend' else 'runtime']}
            require(actual['spec']['template']['spec']['containers'][0]['image'] in allowed,'SUMMARY_CONCURRENT_IMAGE_CHANGE')
            actual['spec']['template']['spec']['containers'][0]['image']=prior
        require(actual==expected,'SUMMARY_WORKLOAD_CONFIGURATION_CHANGED')
    require(runtime.retained_configuration()==configuration,'SUMMARY_PRIVATE_CONFIGURATION_CHANGED')

def check_summaries(client,config,session):
    ids=set();cursor=None;pages=0;counts=[];deadline=time.monotonic()+120
    while True:
        require(time.monotonic()<deadline,'SUMMARY_DIAGNOSTIC_TIMEOUT')
        path='/functions/v1/api/v1/job-summaries?limit=500'+('&cursor='+cursor if cursor else '')
        response=client.request(path,token=session['access_token'])
        auth.smoke.expect(response,{200},'SUMMARY_AUTHENTICATED_READ_FAILED')
        page=response.json('SUMMARY_RESPONSE_INVALID').get('data',{})
        rows=page.get('records');next_cursor=page.get('next_cursor')
        require(isinstance(rows,list) and len(rows)<=500,'SUMMARY_PAGE_INVALID')
        for row in rows:
            identifier=row.get('id')
            require(isinstance(identifier,str) and re.fullmatch(r'[a-f0-9-]{36}',identifier) and identifier not in ids and (cursor is None or identifier>cursor),'SUMMARY_CURSOR_INVALID')
            require('checkpoint' not in row and 'lease_token' not in row,'SUMMARY_FULL_CHECKPOINT_RETURNED')
            ids.add(identifier)
        pages+=1;counts.append(len(rows))
        if next_cursor is None:break
        require(len(rows)==500 and next_cursor==rows[-1]['id'] and next_cursor not in {cursor},'SUMMARY_PAGINATION_AMPLIFICATION')
        cursor=next_cursor
        require(pages<10000,'SUMMARY_DIAGNOSTIC_BOUND')
    return {'authenticated_owner':True,'job_records':len(ids),'page_requests':pages,'page_sizes':counts,'complete_cursor_traversal':True,'full_checkpoint_fields':0,'business_mutations':0,'model_requests':0}

def acceptance(database):
    workspace=auth.access.WORKSPACE
    require(str(uuid.UUID(workspace))==workspace,'SUMMARY_WORKSPACE_INVALID')
    sql="""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;SET LOCAL statement_timeout='20s';
SELECT jsonb_build_object('owners',(SELECT coalesce(jsonb_agg(m.user_id),'[]') FROM public.memberships m
JOIN public.identity_allowlist a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
WHERE m.workspace_id='__W__' AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner'),
'job_count',(SELECT count(*) FROM public.jobs WHERE workspace_id='__W__'));
COMMIT;""".replace('__W__',workspace)
    before=json.loads(d.sql(database.pod,sql));require(len(before['owners'])==1,'SUMMARY_SOLE_OWNER_REQUIRED')
    core=d.decode_secret(d.get('secret','tenderdesk-core'))
    public=auth.smoke.javascript_config(d.get('configmap','frontend-config')['data']['runtime-config.js'].encode())
    require(public['publishableKey']==core['ANON_KEY'],'SUMMARY_CONFIGURATION_MISMATCH')
    config=auth.smoke.Config(public['appOrigin'],core['ANON_KEY'],core['SERVICE_KEY'],core['JWT_SECRET'])
    client=auth.smoke.Client(config);session=None
    try:
        session=auth.genuine_session(client,config,before['owners'][0],workspace)
        auth.verify_session(client,config,session,before['owners'][0],workspace)
        result=check_summaries(client,config,session)
        after=json.loads(d.sql(database.pod,sql))
        require(before==after and result['job_records']==before['job_count'],'SUMMARY_HISTORY_CHANGED_DURING_CHECK')
        return result
    finally:
        if session:auth.smoke.expect(client.request('/auth/v1/logout?scope=local',token=session['access_token'],method='POST'),{200,204},'SUMMARY_LOGOUT_NOT_CONFIRMED')

def update():
    STATE.update(stage='preflight',patched=[],rolled_back=[],rollback_failed=[])
    revision=os.environ.get('GITHUB_SHA','');require(re.fullmatch('[a-f0-9]{40}',revision),'SUMMARY_REVISION_REQUIRED')
    selected={name:u.image(os.environ.get('TENDERDESK_'+name.upper()+'_IMAGE',''),name) for name in ('runtime','frontend')}
    images.verify_checkout(revision);q=images.qualification;receipt=q.load(images.release.ROOT.parent);q.verify_checkout(images.release.ROOT.parent,receipt)
    images.inspect(selected['runtime'],revision,'runtime');images.inspect(selected['frontend'],revision,'frontend')
    d.probe.validate_cluster();front.namespace_owned()
    original={name:u.deployment(name) for name in TARGETS}
    require(all(base.image_of(original[n])==PREVIOUS_RUNTIME for n in RUNTIME) and base.image_of(original['frontend'])==PREVIOUS_FRONTEND,'SUMMARY_DEPLOYED_IMAGE_BASELINE_CHANGED')
    before=runtime.workload_snapshot();configuration=runtime.retained_configuration()
    STATE['stage']='frontend_image_acceptance'
    expected,frontend_proof=assets.verified_assets(selected['frontend'],revision,images,front)
    database=base.inventory.observer.Client(1800);database.labels['app.kubernetes.io/managed-by']=base.OWNER;base.save_client(database)
    touched=[]
    try:
        STATE['stage']='schema_preflight'
        database.prepare();schema=verify_schema(database)
        for name in TARGETS:
            STATE['stage']='update_'+name
            verify_unchanged(before,configuration,selected)
            candidate=selected['frontend' if name=='frontend' else 'runtime'];prior=base.image_of(original[name]);touched.append(name)
            runtime.patch_runtime(name,candidate,original[name],prior);STATE['patched'].append(name)
            d.wait_deployments([name]);base.wait_drain(name,candidate)
        verify_unchanged(before,configuration,selected);verify_schema(database)
        STATE['stage']='public_acceptance'
        front.public_check(u.owned('configmap','frontend-config'),expected)
        STATE['stage']='authenticated_acceptance'
        observed=acceptance(database)
        require(all(base.image_of(u.deployment(n))==selected['frontend' if n=='frontend' else 'runtime'] for n in TARGETS),'SUMMARY_FINAL_IMAGE_MISMATCH')
        return {'release':'job-summary-pagination','status':'passed','source_revision':revision,'images':selected,'schema':schema,'frontend_artifact':frontend_proof,'acceptance':observed,'configuration_preserved':True,'auth_session_logged_out':True,'processing_retried':False}
    except Exception:
        # Image-only, additive endpoint release: restore our exact changed images,
        # never overwrite an operator's concurrent specification or image edit.
        STATE['failure_stage']=STATE['stage']
        rollback(touched,selected,original)
        raise
    finally:
        base.cleanup_saved_client()

def main():
    try:
        if sys.argv[1:]==['--publish']:
            images.IMAGES={k:v for k,v in images.IMAGES.items() if k in ('runtime','frontend')}
            images.prepare();return 0
        require(not sys.argv[1:],'SUMMARY_ARGUMENTS_INVALID')
        with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):result=update()
        print(json.dumps(result),flush=True);return 0
    except Exception as error:
        code=str(error) if re.fullmatch('[A-Z][A-Z0-9_]{0,99}',str(error)) else 'SUMMARY_RELEASE_FAILED'
        print(json.dumps({'release':'job-summary-pagination','status':'failed','code':code,'rollout':STATE}),flush=True);return 1
if __name__=='__main__':sys.exit(main())
