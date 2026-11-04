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
    HERE.parent/'ops/production-schema/capture_managed_catalog.sql',canonical]}}

if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--container',required=True)
 print(json.dumps(run(parser.parse_args().container),sort_keys=True))
