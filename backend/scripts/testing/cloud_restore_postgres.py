#!/usr/bin/env python3
"""Local real PostgreSQL reconstruction/restore regression; synthetic data only.

Auth and Storage are schema stubs here. The separately dispatched cloud drill
tests real HTTP services and stored bytes; neither result substitutes for it.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import uuid

HERE=Path(__file__).resolve().parent
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module
h=load('restore_pg_harness',HERE/'postgres_races.py')
m=load('restore_pg_module',HERE.parent/'ops/proposal-cloud-restore.py')
L=h.literal

def run(repository):
 repository=Path(repository).resolve();paths=sorted((repository/'backend/supabase/migrations').glob('[0-9]*_*.sql'))
 if not any(p.name=='20261104150228_restored_source_review_assurance.sql' for p in paths):raise RuntimeError('Final source-review restore migration required')
 checks=[]
 with tempfile.TemporaryDirectory() as directory:
  fixture_root=Path(directory);target=fixture_root/'backend/supabase/migrations';target.mkdir(parents=True)
  for path in paths:
   if path.name<=m.release.CUTOFF:(target/path.name).symlink_to(path)
  f=h.PostgresFixture(repository=fixture_root)
  try:
   f.start()
   # Own network-none container only: no shared global roles are renamed.
   f.sql((repository/'backend/scripts/runtime/dispatcher.sql').read_text().replace(':"service_role"','service_role'))
   f.sql("""create role tdp_app_owner nosuperuser nobypassrls nocreatedb nocreaterole;
    create role tdp_app_authadmin nosuperuser nobypassrls nocreatedb nocreaterole;
    create role tdp_app_storageadmin nosuperuser nobypassrls nocreatedb nocreaterole;
    create role tdp_app_authenticator nosuperuser nobypassrls nocreatedb nocreaterole;
    alter role anon rename to tdp_app_anon;alter role authenticated rename to tdp_app_authenticated;alter role service_role rename to tdp_app_service;alter role tdp_app_service nobypassrls;
    alter schema public owner to tdp_app_owner;alter schema app_private owner to tdp_app_owner;
    grant usage on schema auth,storage to tdp_app_owner;grant select,references on auth.users,auth.identities to tdp_app_owner;grant tdp_app_owner to tdp_app_service;
    do $$declare r record;begin
    for r in select n.nspname,c.relname,c.relkind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private') and c.relkind in ('r','v') loop
     execute format('alter %s %I.%I owner to tdp_app_owner',case when r.relkind='v' then 'view' else 'table' end,r.nspname,r.relname);end loop;
    for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app_private') and p.prokind='f' loop execute format('alter function %s owner to tdp_app_owner',r.sig);end loop;end$$;
    set role tdp_app_owner;create table app_private.application_release_history(release text primary key,migration_sha256 text not null);
    insert into app_private.application_release_history values('synthetic-baseline',repeat('a',64));reset role;""")
   digest=f.scalar("select encode(sha256(convert_to(coalesce(string_agg(p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid)||':'||coalesce(p.proacl::text,''),E'\\n' order by p.oid::regprocedure::text),''),'UTF8')),'hex') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app_private') and p.prokind='f'")
   manifest={'baseline_catalog_sha256':digest,'baseline_releases':{'synthetic-baseline':'a'*64},'migrations':[{'name':p.name,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths if p.name>m.release.CUTOFF]}
   capture=(m.HERE/'production-schema/capture_managed_catalog.sql').read_text().replace("current_database()<>'tenderdesk_app'","current_database()<>"+L(f.database)).replace('__RELEASE_MANIFEST_SHA256__','f'*64).replace('__BASELINE_CATALOG_SHA256__',digest).replace('__BASELINE_RELEASES_JSON__',json.dumps(manifest['baseline_releases']))
   value=m.validate_catalog(f.value(capture));assert value['source_stage']=='baseline';checks.append('actual_managed_baseline_catalog_captured_read_only')
   os.environ['GITHUB_RUN_ID']='40232030191';os.environ['GITHUB_RUN_ATTEMPT']='2'
   state=m.bootstrap.identity();state.update(uid='local-namespace',job_uid='local-job')
   h.docker('exec',f.container,'createdb','-U','postgres',state['database'],check=True)
   f.database=state['database'];prefix=state['role_prefix'];role=lambda x:prefix+'_'+x
   f.sql('comment on database '+f.database+' is '+L('tenderdesk-isolated-bootstrap:'+f.database+':'+prefix)+';')
   for suffix in ('owner','authadmin','storageadmin','authenticator','anon','authenticated','service'):
    f.sql('create role '+role(suffix)+' nosuperuser nobypassrls nocreatedb nocreaterole;')
   f.sql(f"""grant create on database {f.database} to {role('owner')};alter schema public owner to {role('owner')};
     create schema auth authorization {role('authadmin')};create schema storage authorization {role('storageadmin')};
     create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.identities(user_id uuid,provider text,identity_data jsonb);
     alter table auth.users owner to {role('authadmin')};alter table auth.identities owner to {role('authadmin')};
     alter table auth.users enable row level security;alter table auth.identities enable row level security;
     create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;alter function auth.uid() owner to {role('authadmin')};
     create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
     create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;
     alter table storage.buckets owner to {role('storageadmin')};alter table storage.objects owner to {role('storageadmin')};
     grant usage on schema auth,storage,public to {role('owner')},{role('anon')},{role('authenticated')},{role('service')},{role('storageadmin')};
     grant {role('owner')},{role('storageadmin')} to {role('service')};""")
   m.release.ROOT=repository/'backend'
   sql,receipts=m.schema_source(value,state,manifest)
   f.sql(sql.decode());checks.append('managed_owner_reconstruction_and_entire_additive_batch')
   # A production role sharing the instance must not receive target authority.
   assert f.scalar("select has_function_privilege('tdp_app_authenticated','public.source_review_context(uuid)','execute')")=='f'
   assert f.scalar(f"select has_function_privilege('{role('authenticated')}','public.delivery_artifact_context(uuid,uuid)','execute')")=='f'
   assert f.scalar(f"select has_function_privilege('{role('service')}','public.delivery_artifact_context(uuid,uuid)','execute')")=='t'
   assert f.scalar("select count(*) from public.workspaces")=='0';checks.append('no_source_rows_or_production_role_grants_copied')
   source,target_user=str(uuid.uuid4()),str(uuid.uuid4())
   for user in (source,target_user):
    f.sql(f"insert into auth.users values({L(user)},'fixture-{user}@example.invalid',now());insert into auth.identities values({L(user)},'email',jsonb_build_object('sub',{L(user)}));")
   identities=f.value(f"select public.cloud_restore_fixture_users({L(source)},{L(target_user)})")
   def rpc(name,args=(),user=None):
    setting=f"set local role {role('authenticated')};select set_config('request.jwt.claim.sub',{L(user)},true);" if user else f"set local role {role('service')};"
    result=f.sql('begin;'+setting+'select to_jsonb(public.'+name+'('+','.join(L(x) for x in args)+'));commit;')
    lines=result.stdout.strip().splitlines();return json.loads(lines[-1]) if lines else None
   def command(op,payload,user=source):return rpc('app_command',(op,json.dumps(payload),str(uuid.uuid4())),user)
   src=command('source.create',{'name':'Synthetic cloud restore source','kind':'manual'})
   opp=command('opportunity.create',{'source_id':src['id'],'title':'Synthetic cloud restore requirement','reference':'ISOLATED-RESTORE','description':'The supplier must deliver a documented approval workflow.','language':'en','decision':'shortlisted'})
   context=rpc('source_review_context',(opp['id'],),source)
   command('source.authority.review',{'opportunity_id':opp['id'],**context['sources'][0]['reference'],'expected_revision':0,'role':'buyer_rfp','status':'confirmed','supersedes':None,'precedence':0,'reason':'Synthetic owner review of exact original buyer source.'})
   context=rpc('source_review_context',(opp['id'],),source)
   review=command('source.obligation.review',{'opportunity_id':opp['id'],'review_id':None,'expected_revision':0,'spans':[context['source_evidence']['spans'][0]],'semantics':{'modality':'required','actor':'supplier','negated':False,'conditions':[],'exceptions':[],'consequences':[],'quantities':[],'dates':[]},'status':'confirmed','reason':'Synthetic original obligation review for isolated restore.'})
   revision=int(f.scalar('select revision from public.opportunities where id='+L(opp['id'])))
   snapshot=command('delivery.snapshot.prepare',{'opportunity_id':opp['id'],'expected_revision':revision})
   requirement=rpc('cloud_restore_fixture_requirement',(opp['id'],review['review_id']))
   job=rpc('claim_backend_job_v4');assert job['type']=='render_delivery'
   export=rpc('delivery_export_context',(job['id'],job['lease_token']))
   checksum='c'*64
   for artifact in export['artifacts']:rpc('complete_delivery_artifact',(job['id'],job['lease_token'],artifact['id'],checksum,128))
   rpc('finish_delivery_export',(job['id'],job['lease_token']))
   backup=rpc('workspace_backup_manifest',(),source);rows=[]
   for i in range(0,len(backup['rows']),10):rows+=rpc('workspace_backup_rows',(json.dumps([x['key'] for x in backup['rows'][i:i+10]]),),source)
   assert any(x['key'].startswith('source_obligation_reviews/') for x in rows);assert backup['files'];checks.append('canonical_confirmed_source_and_ready_artifact_backed_up')
   before=f.scalar("select md5(string_agg(pg_get_triggerdef(oid)||':'||tgenabled::text,',' order by oid)) from pg_trigger where not tgisinternal")
   f.sql('create table app_private.synthetic_reset_blocker(requirement_id uuid references public.requirements(id));insert into app_private.synthetic_reset_blocker values('+L(requirement)+')')
   rejected=f.sql('select public.cloud_restore_reset_source()',False)
   assert rejected.returncode and 'synthetic_reset_blocker' in rejected.stderr
   assert before==f.scalar("select md5(string_agg(pg_get_triggerdef(oid)||':'||tgenabled::text,',' order by oid)) from pg_trigger where not tgisinternal")
   assert f.scalar('select count(*) from public.requirements where id='+L(requirement))=='1'
   f.sql('drop table app_private.synthetic_reset_blocker');checks.append('reset_failure_rolls_back_rows_and_trigger_enablement')
   # Same helper rejects changed DB identity and a foreign workspace before any DELETE.
   f.sql('comment on database '+f.database+" is 'foreign';")
   rejected=f.sql('select public.cloud_restore_reset_source()',False);assert rejected.returncode and 'CLOUD_RESTORE_DATABASE_GUARD' in rejected.stderr
   f.sql('comment on database '+f.database+' is '+L('tenderdesk-isolated-bootstrap:'+f.database+':'+prefix)+';')
   f.sql("update public.workspaces set name='Nonfixture workspace'")
   rejected=f.sql('select public.cloud_restore_reset_source()',False);assert rejected.returncode and 'CLOUD_RESTORE_FIXTURE_IDENTITY' in rejected.stderr
   f.sql("update public.workspaces set name='Isolated cloud restore source'")
   reset=rpc('cloud_restore_reset_source');assert reset['trigger_fingerprint_preserved'] and reset['source_workspace']!=reset['target_workspace']
   assert before==f.scalar("select md5(string_agg(pg_get_triggerdef(oid)||':'||tgenabled::text,',' order by oid)) from pg_trigger where not tgisinternal")
   assert f.scalar('select count(*) from public.source_obligation_reviews')=='0';checks.append('exact_fixture_reset_guards_and_trigger_fingerprint')
   session=rpc('begin_workspace_restore',(json.dumps(backup),True),target_user)
   for i in range(0,len(rows),10):rpc('stage_restore_rows',(session['id'],json.dumps(rows[i:i+10])),target_user)
   for file in session['files']:rpc('complete_restore_file',(file['id'],target_user,file['content_hash'],file['expected_size']))
   rpc('commit_workspace_restore',(session['id'],),target_user)
   package=rpc('delivery_package',(snapshot['id'],),target_user);assert package['status']=='ready'
   for artifact in export['artifacts']:
    context=rpc('delivery_artifact_context',(artifact['id'],target_user))
    assert context['artifact']['storage_key']!=artifact['storage_key'];assert context['artifact']['content_hash']==checksum
   for table in ('source_authority_decisions','source_obligation_reviews'):
    history=f.value('select jsonb_agg(to_jsonb(x) order by revision) from public.'+table+' x')
    assert history[0]['status']=='confirmed' and history[-1]['status']=='revoked' and history[-1]['created_by']==target_user
   semantics=f.value('select source_semantics from public.requirements where id='+L(requirement))
   assert semantics['review_status']=='pending' and semantics['authority_status']=='unconfirmed' and semantics['review_id'] is None
   checks.append('public_restore_retains_files_and_history_revokes_live_assurance')
   count=f.scalar('select count(*) from public.source_obligation_reviews')
   rpc('commit_workspace_restore',(session['id'],),target_user)
   assert count==f.scalar('select count(*) from public.source_obligation_reviews');assert f.scalar('select count(*) from public.provider_usage')=='0'
   checks.append('restore_replay_is_idempotent_without_model_usage')
   return {'checks':{name:True for name in checks},'postgres_image':h.IMAGE,'schema_service_stubs':True,'actual_http_storage_exercised':False,'migration_receipts':receipts}
  finally:f.close()

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--repository',type=Path,default=HERE.parents[2]);args=parser.parse_args()
 print(json.dumps(run(args.repository),sort_keys=True))
