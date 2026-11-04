#!/usr/bin/env python3
"""Tiny real-PG regression for the isolated Auth-RLS boundary; no HTTP claims.

Uses a fresh database/role family in an existing network-none test container.
Auth table RLS matches the pinned GoTrue v2.197.0 migration
20240612123726_enable_rls_update_grants.up.sql. The fixture helper and canonical
workspace bootstrap are actual repository functions; no production connection.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
spec=importlib.util.spec_from_file_location('auth_rls_restore',HERE.parent/'ops/proposal-cloud-restore.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def run(container):
 if not re.fullmatch(r'tdp-races-[a-z0-9-]{1,48}',container):raise ValueError('TEST_CONTAINER_REQUIRED')
 def docker(*args,input=None):
  return subprocess.run(['docker','--host=unix:///var/run/docker.sock',*args],input=input,text=True,capture_output=True,timeout=30)
 inspected=docker('inspect',container,'--format','{{json .HostConfig}}')
 if inspected.returncode:raise RuntimeError('TEST_CONTAINER_UNAVAILABLE')
 host=json.loads(inspected.stdout)
 if host['NetworkMode']!='none' or host.get('PortBindings'):raise RuntimeError('TEST_CONTAINER_NOT_ISOLATED')
 os.environ['GITHUB_RUN_ID']='40232030191';os.environ['GITHUB_RUN_ATTEMPT']='2'
 state=m.bootstrap.identity();state.update(uid='local-only',job_uid='local-only')
 database=state['database'];prefix=state['role_prefix'];created=False;roles=[];checks=[]
 I=m.builder.identifier;L=m.builder.literal
 def sql(value,ok=True):
  result=docker('exec','-i',container,'psql','-XAtq','-v','ON_ERROR_STOP=1','-U','postgres','-d',database,input=value)
  if ok and result.returncode:raise RuntimeError(result.stderr)
  return result
 def role(suffix):return I(prefix+'_'+suffix)
 try:
  result=docker('exec',container,'createdb','-U','postgres',database)
  if result.returncode:raise RuntimeError('TEST_FRESH_DATABASE_REQUIRED')
  created=True
  sql('comment on database '+I(database)+' is '+L('tenderdesk-isolated-bootstrap:'+database+':'+prefix))
  for suffix in ('owner','authadmin','storageadmin','authenticator','anon','authenticated','service'):
   sql('create role '+role(suffix)+' nosuperuser nobypassrls nocreatedb nocreaterole');roles.append(prefix+'_'+suffix)
  sql(f"""alter schema public owner to {role('owner')};
   create schema auth authorization {role('authadmin')};create schema storage authorization {role('storageadmin')};
   create schema app_private authorization {role('owner')};
   grant usage on schema auth,storage,public,app_private to {role('owner')},{role('anon')},{role('authenticated')},{role('service')};
   grant {role('owner')} to {role('service')};
   set role {role('authadmin')};
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
   create table auth.identities(user_id uuid,provider text,identity_data jsonb);
   create table auth.sessions(id uuid);
   alter table auth.users enable row level security;alter table auth.identities enable row level security;
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant select,references on auth.users,auth.identities to {role('owner')};
   reset role;set role {role('storageadmin')};create table storage.objects(id uuid);create table storage.buckets(id text);
   reset role;set role {role('owner')};
   create table public.workspaces(id uuid primary key default gen_random_uuid(),name text,created_by uuid);
   create table public.identity_allowlist(workspace_id uuid,provider text,provider_user_id text,verified_email text,user_id uuid,role text,created_by uuid);
   create table public.memberships(workspace_id uuid,user_id uuid,role text,created_by uuid,active boolean default true);
   create table public.operations(workspace_id uuid);
   create table public.audit_events(workspace_id uuid,actor_id uuid,action text,request_id uuid);
   create function app_private.backup_tables() returns text[] language sql as $$select array['memberships','identity_allowlist','operations','audit_events']::text[]$$;
   reset role;""")
  canonical=ROOT/'backend/supabase/migrations/20261014224723_email_password_identities.sql'
  definition=canonical.read_text().split('create or replace function public.bootstrap_workspace',1)[1].split('end $$;',1)[0]
  sql('set role '+role('owner')+';create or replace function public.bootstrap_workspace'+definition+'end $$;reset role;')
  sql(m.fixture_source(state))
  source='00000000-0000-4000-8000-000000000001';target='00000000-0000-4000-8000-000000000002'
  for actor in (source,target):
   sql('insert into auth.users values('+L(actor)+','+L(actor+'@example.invalid')+',now());insert into auth.identities values('+L(actor)+",'email',jsonb_build_object('sub',"+L(actor)+'));')
  invoke='set role '+role('service')+';select public.cloud_restore_fixture_users('+L(source)+','+L(target)+');'
  assert sql('set role '+role('owner')+';select count(*) from auth.users;').stdout.strip()=='0'
  red=sql(invoke,False)
  assert red.returncode and 'CLOUD_RESTORE_FIXTURE_IDENTITY' in red.stderr
  assert sql('select count(*) from public.workspaces').stdout.strip()=='0'
  checks.append('before_fix_exact_fixture_rejects_rls_hidden_confirmed_users')
  capture=(HERE.parent/'ops/production-schema/capture_managed_catalog.sql').read_text()
  metadata_sql=capture.split("'auth_read_authority',",1)[1].split(",\n 'catalog',jsonb_build_object(",1)[0]
  def metadata():return json.loads(sql('select '+metadata_sql.replace('tdp_app_owner',prefix+'_owner')).stdout)
  authority=metadata()
  assert all(row['rls_enabled'] and row['app_owner_select'] and not row['app_owner_effective_owner'] and row['applicable_policies']==[] for row in authority['tables'])
  checks.append('actual_catalog_metadata_reports_select_without_rls_read_policy')
  sql(m.upstream_access_source(state))
  policy=m.builder.auth_read.render(database,prefix,marker='tenderdesk-isolated-bootstrap:'+database+':'+prefix)
  admin=prefix+'_admin'
  sql('create role '+I(admin)+' nosuperuser nobypassrls nocreatedb nocreaterole noinherit');roles.append(admin)
  sql('grant '+role('owner')+','+role('authadmin')+' to '+I(admin)+' with inherit false,set true')
  def policy_sql(extra='',ok=True):return sql('set session authorization '+I(admin)+';begin;'+policy+extra+'commit;',ok)
  assert sql('set session authorization '+I(admin)+';select pg_has_role(current_user,'+L(prefix+'_authadmin')+",'USAGE'),pg_has_role(current_user,"+L(prefix+'_authadmin')+",'SET')").stdout.strip()=='f|t'
  failed=policy_sql('select 1/0;',False)
  assert failed.returncode and 'division by zero' in failed.stderr
  assert sql("select count(*) from pg_policy where polname='tenderdesk_application_identity_read'").stdout.strip()=='0'
  checks.append('late_failure_rolls_back_both_policies_in_caller_transaction')
  policy_sql()
  policies=sql("select oid from pg_policy where polname='tenderdesk_application_identity_read' order by oid").stdout
  policy_sql()
  assert sql("select oid from pg_policy where polname='tenderdesk_application_identity_read' order by oid").stdout==policies
  checks.append('noninheriting_set_authority_and_exact_oid_preserving_replay')
  denied=sql('set session authorization '+role('authenticated')+';begin;'+policy+'commit;',False)
  assert denied.returncode and 'APPLICATION_AUTH_SET_ROLE_REQUIRED' in denied.stderr
  checks.append('browser_cannot_install_auth_read_policy')
  assert sql('set role '+role('owner')+';select count(*) from auth.users;select count(*) from auth.identities;').stdout.strip().splitlines()==['2','2']
  result=json.loads(sql(invoke).stdout)
  assert result['source_workspace'] and result['target_workspace'] is None
  authority=metadata()
  assert all(row['applicable_policies']==[{'command':'r','permissive':True,'count':1,'unconditional_count':1}] for row in authority['tables'])
  checks.append('owner_select_policy_allows_exact_fixture_and_canonical_bootstrap')
  for suffix in ('anon','authenticated'):
   for table in ('users','identities'):
    rejected=sql('set role '+role(suffix)+';select * from auth.'+table,False)
    assert rejected.returncode and 'permission denied' in rejected.stderr
  assert sql("select count(*) from pg_policy where polrelid in ('auth.users'::regclass,'auth.identities'::regclass) and polcmd='r' and polroles=array["+L(prefix+'_owner')+"::regrole::oid]").stdout.strip()=='2'
  assert sql("select count(*) from pg_class where oid in ('auth.users'::regclass,'auth.identities'::regclass) and relrowsecurity").stdout.strip()=='2'
  assert sql('select count(*) from pg_roles where rolname like '+L(prefix+'_%')+' and (rolsuper or rolbypassrls)').stdout.strip()=='0'
  assert sql('select has_table_privilege('+L(prefix+'_owner')+",'auth.sessions','SELECT'),has_table_privilege("+L(prefix+'_owner')+",'auth.users','INSERT,UPDATE,DELETE')").stdout.strip()=='f|f'
  checks.append('browser_denials_auth_rls_and_nobypass_read_only_boundary_preserved')
  authority_before=sql("select md5(string_agg(to_jsonb(p)::text,',' order by oid)) from pg_policy p where polname='tenderdesk_application_identity_read'").stdout
  rows_before=sql("select md5(string_agg(to_jsonb(u)::text,',' order by id)) from auth.users u").stdout
  for change,code in (
   ('alter policy tenderdesk_application_identity_read on auth.users to '+role('authenticated')+';','APPLICATION_AUTH_POLICY_DRIFT'),
   ('create policy unknown_identity_condition on auth.users for select to '+role('owner')+' using(false);','APPLICATION_AUTH_POLICY_CONFLICT'),
   ('alter table auth.users disable row level security;','APPLICATION_AUTH_TABLE_MISMATCH'),
   ('grant select on auth.users to '+role('authenticated')+';','APPLICATION_AUTH_BROWSER_PRIVILEGE'),
   ('revoke select on auth.users from '+role('owner')+';','APPLICATION_AUTH_TABLE_MISMATCH')):
   rejected=sql('set session authorization '+I(admin)+';begin;set local role '+role('authadmin')+';'+change+policy+'commit;',False)
   assert rejected.returncode and code in rejected.stderr,rejected.stderr
   assert sql("select md5(string_agg(to_jsonb(p)::text,',' order by oid)) from pg_policy p where polname='tenderdesk_application_identity_read'").stdout==authority_before
   assert sql("select md5(string_agg(to_jsonb(u)::text,',' order by id)) from auth.users u").stdout==rows_before
  checks.append('policy_role_predicate_rls_and_grant_drift_fail_with_full_rollback')

  # Catalog SQL inside REPEATABLE READ uses the established transaction
  # snapshot. Prove why the release must take top-level Auth locks first.
  def remove_policies():sql("drop policy if exists tenderdesk_application_identity_read on auth.users;drop policy if exists tenderdesk_application_identity_read on auth.identities;drop policy if exists concurrent_auth_restriction on auth.users;")
  def session(text):
   command=['docker','--host=unix:///var/run/docker.sock','exec','-i',container,'psql','-XAtq','-v','ON_ERROR_STOP=1','-U','postgres','-d',database]
   process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   process.stdin.write(text+'\n');process.stdin.flush();return process
  def finish(process,text=''):
   output,error=process.communicate(text+'\n\\q\n',timeout=20);return process.returncode,output,error
  remove_policies()
  stale=session('set session authorization '+I(admin)+";begin isolation level repeatable read;select 'snapshot-ready' from pg_database where datname=current_database();")
  try:
   assert stale.stdout.readline().strip()=='snapshot-ready'
   sql('set role '+role('authadmin')+';create policy concurrent_auth_restriction on auth.users for select to '+role('owner')+' using(false);')
   assert sql('set role '+role('owner')+';select count(*) from auth.users;').stdout.strip()=='0'
   status,_,error=finish(stale,policy+'commit;')
   assert status==0,error
   assert sql("select count(*) from pg_policy where polname in ('tenderdesk_application_identity_read','concurrent_auth_restriction')").stdout.strip()=='3'
   assert sql('set role '+role('owner')+';select count(*) from auth.users;').stdout.strip()=='2'
  finally:
   if stale.poll() is None:stale.kill();stale.communicate()
  checks.append('late_lock_red_reproduces_hidden_concurrently_committed_auth_policy')
  remove_policies()
  blocker=session('begin;set local role '+role('authadmin')+';lock table auth.users,auth.identities in share row exclusive mode;create policy concurrent_auth_restriction on auth.users for select to '+role('owner')+" using(false);select 'writer-ready';")
  guarded=None
  try:
   assert blocker.stdout.readline().strip()=='writer-ready'
   name='auth_read_lock_'+state['labels']['tenderdesk.io/run']
   guarded=session('set application_name='+L(name)+';set session authorization '+I(admin)+';begin isolation level repeatable read;set local role '+role('authadmin')+';lock table auth.users,auth.identities in share row exclusive mode;set local role '+role('owner')+';'+policy+'commit;')
   deadline=time.monotonic()+8
   while sql('select count(*) from pg_stat_activity where datname='+L(database)+' and application_name='+L(name)+" and wait_event_type='Lock'").stdout.strip()!='1':
    if time.monotonic()>deadline:raise RuntimeError('AUTH_EARLY_LOCK_NOT_OBSERVED')
    time.sleep(.02)
   assert finish(blocker,'commit;')[0]==0
   status,_,error=finish(guarded)
   assert status and 'APPLICATION_AUTH_POLICY_CONFLICT' in error,error
   assert sql("select count(*) from pg_policy where polname='tenderdesk_application_identity_read'").stdout.strip()=='0'
  finally:
   for process in (guarded,blocker):
    if process is not None and process.poll() is None:process.kill();process.communicate()
  checks.append('early_relation_lock_observed_then_concurrent_policy_rejected_atomically')
  remove_policies();policy_sql()
  sql('comment on database '+I(database)+" is 'foreign'")
  rejected=sql(m.upstream_access_source(state),False)
  assert rejected.returncode and 'RESTORE_TARGET_DATABASE_GUARD' in rejected.stderr
  checks.append('wrong_database_comment_refuses_policy_installation')
 finally:
  if created:
   removed=docker('exec',container,'dropdb','-U','postgres',database)
   if removed.returncode:raise RuntimeError('TEST_DATABASE_CLEANUP_FAILED')
  for name in reversed(roles):
   removed=docker('exec','-i',container,'psql','-XAtq','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres',input='drop role '+I(name))
   if removed.returncode:raise RuntimeError('TEST_ROLE_CLEANUP_FAILED')
 return {'passed':True,'checks':checks,'cleanup_verified':True,'actual_auth_http_exercised':False,
  'scope':'isolated_postgresql_auth_rls_with_actual_fixture_and_canonical_bootstrap',
  'sources':{str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest() for path in
   [Path(__file__),HERE.parent/'ops/proposal-cloud-restore.py',HERE.parent/'ops/cloud-restore/fixture.sql',
    HERE.parent/'ops/application_auth_read.py',HERE.parent/'ops/proposal-delivery-release.py',ROOT/'backend/deploy/kubernetes/application-auth-read.sql',
    HERE.parent/'ops/production-schema/capture_managed_catalog.sql',canonical]}}

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--container',required=True)
 print(json.dumps(run(parser.parse_args().container),sort_keys=True))
