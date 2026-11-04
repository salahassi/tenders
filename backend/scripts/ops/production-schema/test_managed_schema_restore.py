"""Restore actual managed catalogs with column-only grants into isolated PG."""
import json
from pathlib import Path
import subprocess
import unittest
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from build_schema import acl_grants,source_role_mapping

class ManagedSchemaTests(unittest.TestCase):
 def test_explicit_source_family_and_exact_column_privileges(self):
  self.assertEqual(source_role_mapping('tdp_app')['tdp_app_owner'],'postgres')
  result=acl_grants('{tdp_app_authenticated=r/tdp_app_owner}','TABLE','public.snapshots','restored',source_role_prefix='tdp_app',column='id')
  self.assertEqual(result,['REVOKE ALL ("id") ON TABLE public.snapshots FROM PUBLIC;','GRANT SELECT ("id") ON TABLE public.snapshots TO "restored_authenticated";'])
  for acl in ('{authenticated=r/postgres}','{tdp_app_authenticated=r/foreign}','{tdp_app_authenticated=D/tdp_app_owner}'):
   with self.assertRaises(ValueError):acl_grants(acl,'TABLE','public.snapshots','restored',source_role_prefix='tdp_app',column='id')
  with self.assertRaises(ValueError):source_role_mapping('tdp;injection')

 def test_actual_catalog_reconstruction_preserves_rls_column_private_and_service_boundaries(self):
  root=Path(__file__).resolve().parents[3]
  program=r"""
process.on('uncaughtException',e=>{console.error(e.message,e.code,e.position,e.where);process.exit(1)});
import {PGlite} from '@electric-sql/pglite';import {spawnSync} from 'node:child_process';
const source=new PGlite();
const roles=async(db,prefix)=>{
 for(const suffix of ['owner','authadmin','storageadmin','authenticator','anon','authenticated','service'])await db.exec(`create role ${prefix}_${suffix} nosuperuser nobypassrls nocreatedb nocreaterole`);
 await db.exec(`grant create on database postgres to ${prefix}_owner;grant ${prefix}_owner to ${prefix}_service;alter schema public owner to ${prefix}_owner;
 create schema auth authorization ${prefix}_authadmin;create schema storage authorization ${prefix}_storageadmin;
 create table auth.users(id uuid primary key);create table auth.identities(user_id uuid);create table storage.objects(id uuid);
 alter table auth.users owner to ${prefix}_authadmin;alter table auth.identities owner to ${prefix}_authadmin;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth,public,storage to ${prefix}_owner,${prefix}_authenticated,${prefix}_anon,${prefix}_service;`);
};
await roles(source,'tdp_app');
await source.exec(`set role tdp_app_owner;create schema app_private authorization tdp_app_owner;
create table public.proposal_delivery_snapshots(id uuid primary key,created_by uuid not null,payload jsonb not null);
alter table public.proposal_delivery_snapshots enable row level security;
revoke all on public.proposal_delivery_snapshots from public;
grant select(id,created_by) on public.proposal_delivery_snapshots to tdp_app_authenticated;
grant all on public.proposal_delivery_snapshots to tdp_app_service;
create policy member_metadata on public.proposal_delivery_snapshots for select to tdp_app_authenticated using(created_by=auth.uid());
create view public.proposal_delivery_records with(security_invoker=true) as select id,created_by from public.proposal_delivery_snapshots;
revoke all on public.proposal_delivery_records from public;grant select on public.proposal_delivery_records to tdp_app_authenticated,tdp_app_service;
create table app_private.private_receipts(id int primary key,value text);revoke all on app_private.private_receipts from public;
create function public.delivery_context(target uuid) returns jsonb language sql stable security definer set search_path='' as $$select payload from public.proposal_delivery_snapshots where id=target and created_by=auth.uid()$$;
revoke all on function public.delivery_context(uuid) from public;grant execute on function public.delivery_context(uuid) to tdp_app_authenticated;
create function public.complete_delivery() returns boolean language sql security definer set search_path='' as $$select true$$;
revoke all on function public.complete_delivery() from public;grant execute on function public.complete_delivery() to tdp_app_service;
reset role;`);
const query=async(q)=>(await source.query(q)).rows;
const cat={relations:await query(`select c.oid,n.nspname schema,c.relname,c.relkind,pg_get_userbyid(c.relowner) owner,c.relispartition is_partition,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.reloptions,c.relacl::text acl,case when c.relkind='v' then pg_get_viewdef(c.oid) end view_definition from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private') and c.relkind in ('r','v','S')`),
 columns:await query(`select n.nspname schema,c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) data_type,a.attacl::text acl,a.attgenerated,a.attislocal,a.attidentity,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) default_expression,case when a.attcollation<>0 then '"default"' end collation from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname in ('public','app_private') and c.relkind in ('r','v') and a.attnum>0 and not a.attisdropped`),
 constraints:await query(`select c.conrelid,c.contypid,c.conparentid,c.convalidated,c.contype,n.nspname schema,c.conname,pg_get_constraintdef(c.oid) definition from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ('public','app_private')`),
 indexes:[],types:[],sequences:[],dependencies:[],
 routines:await query(`select n.nspname schema,p.proname,pg_get_userbyid(p.proowner) owner,l.lanname language,p.prokind,pg_get_function_identity_arguments(p.oid) identity_arguments,pg_get_functiondef(p.oid) definition,p.proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where n.nspname in ('public','app_private')`)};
cat['triggers-policies']=[{export:{triggers:[],policies:await query(`select n.nspname schema,c.relname,p.polname,p.polpermissive,p.polcmd,array(select pg_get_userbyid(unnest(p.polroles))) roles,pg_get_expr(p.polqual,p.polrelid) using_expression,pg_get_expr(p.polwithcheck,p.polrelid) check_expression from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace`)}}];
const build=spawnSync('python3',['-c',`import sys,json;sys.path.insert(0,'scripts/ops/production-schema');from build_schema import build_schema;sql,manifest=build_schema(json.load(sys.stdin),'restored','postgres',source_role_prefix='tdp_app');print(json.dumps({'sql':sql,'manifest':manifest}))`],{input:JSON.stringify(cat),encoding:'utf8'});
if(build.status!==0)throw Error(build.stderr);const {sql,manifest}=JSON.parse(build.stdout);
if(manifest.source_role_prefix!=='tdp_app')throw Error('SOURCE_FAMILY_NOT_RECORDED');
const target=new PGlite();await roles(target,'restored');await target.exec(sql);
await target.exec(`set role restored_owner;
insert into public.proposal_delivery_snapshots values('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','{"private":"retained"}');
insert into app_private.private_receipts values(1,'private');reset role;
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001',false);set role restored_authenticated;`);
if((await target.query('select id from public.proposal_delivery_records')).rows.length!==1)throw Error('METADATA_UNAVAILABLE');
if((await target.query("select public.delivery_context('10000000-0000-4000-8000-000000000001') data")).rows[0].data.private!=='retained')throw Error('AUTHORIZED_CONTEXT_DENIED');
for(const q of ['select payload from public.proposal_delivery_snapshots','select * from app_private.private_receipts','select public.complete_delivery()']){
 let denied=false;try{await target.query(q)}catch(e){denied=e.code==='42501'}if(!denied)throw Error('PRIVATE_BOUNDARY_BROKEN');
}
await target.exec("select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000002',false)");
if((await target.query('select id from public.proposal_delivery_records')).rows.length!==0)throw Error('OUTSIDER_METADATA');
if((await target.query("select public.delivery_context('10000000-0000-4000-8000-000000000001') data")).rows[0].data!==null)throw Error('OUTSIDER_CONTEXT');
await target.exec('reset role;set role restored_anon');let denied=false;try{await target.query('select id from public.proposal_delivery_records')}catch(e){denied=e.code==='42501'}if(!denied)throw Error('ANON_METADATA');
await target.exec('reset role;set role restored_service');
if((await target.query('select payload from public.proposal_delivery_snapshots')).rows.length!==1)throw Error('SERVICE_READ');
if(!(await target.query('select public.complete_delivery() ok')).rows[0].ok)throw Error('SERVICE_RPC');
await target.exec('reset role');
if((await target.query("select count(*)::int n from pg_roles where rolname like 'restored_%' and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb)")).rows[0].n!==0)throw Error('ROLE_PROMOTION');
await source.close();await target.close();
"""
  result=subprocess.run(['node','--input-type=module'],input=program,text=True,capture_output=True,cwd=root,timeout=120)
  self.assertEqual(result.returncode,0,result.stderr[-5000:])

if __name__=='__main__':unittest.main()
