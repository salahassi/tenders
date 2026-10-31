import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';

process.on('uncaughtException',error=>{console.error(JSON.stringify({message:error.message,code:error.code}));process.exit(1);});
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const scripts=JSON.parse(raw),selection=scripts.selection;
const root=new URL('../../',import.meta.url);
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
 alter table storage.objects enable row level security;grant usage on schema storage to authenticated;grant insert,select on storage.objects to authenticated;`);
for(const name of (await readdir(new URL('supabase/migrations/',root))).filter(n=>/^\d+_.+\.sql$/.test(n)).sort())
 await db.exec(await readFile(new URL('supabase/migrations/'+name,root),'utf8'));
const owner='00000000-0000-4000-8000-000000000001',job='00000000-0000-4000-8000-000000000103';
await db.query("insert into auth.users values($1,'fixture@example.test',now())",[owner]);
await db.query("insert into auth.identities values($1,'email',$2::jsonb)",[owner,JSON.stringify({sub:owner})]);
const workspace=(await db.query("select public.bootstrap_workspace($1,'Synthetic guarded resume') id",[owner])).rows[0].id;
const source=(await db.query("insert into public.sources(workspace_id,name,kind,created_by) values($1,'Synthetic manual source','manual',$2) returning id",[workspace,owner])).rows[0].id;
await db.query("insert into public.opportunities(id,workspace_id,source_id,title,created_by) values($1,$2,$3,'Synthetic requested proposal',$4)",[selection.opportunity_id,workspace,source,owner]);
const proposal=(await db.query("insert into public.proposals(workspace_id,opportunity_id,title,created_by) values($1,$2,'Synthetic retained proposal',$3) returning id",[workspace,selection.opportunity_id,owner])).rows[0].id;
await db.query(`insert into public.generation_plans(id,workspace_id,opportunity_id,proposal_id,kind,status,evidence_revision,input_hash,frozen_context,error_code,created_by)
 values($1,$2,$3,$4,'proposal','blocked',(select evidence_revision from public.workspaces where id=$2),repeat('a',64),'{}','DATA_AUTHORIZATION_REQUIRED',$5)`,[selection.plan_id,workspace,selection.opportunity_id,proposal,owner]);
await db.query(`insert into public.jobs(id,workspace_id,type,entity_id,status,input_hash,error_code,attempts,checkpoint,created_by)
 values($1,$2,'analyze_chunk',$3,'blocked',repeat('a',64),'DATA_AUTHORIZATION_REQUIRED',2,'{"saved_checkpoint":true}',$4)`,[job,workspace,selection.plan_id,owner]);
await db.query(`insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,created_by)
 values($1,$2,$3,'analyze_chunk','analysis',1,'{"block_id":"retained-block","start":0,"end":5}',$4)`,[workspace,selection.plan_id,job,owner]);
await db.query(`insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task) values(repeat('b',64),$1,$2,repeat('c',64),'analyze_chunk')`,[workspace,job]);
await db.query(`insert into app_private.model_graph_budgets(workspace_id,thread_id,unit,candidates) values($1,repeat('b',64),'writer',0)`,[workspace]);
await db.query(`insert into app_private.model_graph_results(workspace_id,thread_id,result_key,value,content_hash) values($1,repeat('b',64),'semantic-instructions-fixture','{"saved":true}',repeat('d',64))`,[workspace]);
await db.exec(`create table app_private.application_release_history(release text primary key,migration_sha256 text not null,applied_at timestamptz default now());`);
await db.query("insert into app_private.application_release_history(release,migration_sha256) values('requested-model-processing-v1',$1)",[scripts.migration_sha256]);
await db.exec(`create role tdp_app_owner nosuperuser nobypassrls nocreatedb nocreaterole;
 alter schema public owner to tdp_app_owner;alter schema app_private owner to tdp_app_owner;
 grant usage on schema auth to tdp_app_owner;grant select,references on auth.users,auth.identities to tdp_app_owner;
 DO $ownership$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p','v','m') LOOP
   EXECUTE format('ALTER %s %I.%I OWNER TO tdp_app_owner',CASE WHEN r.relkind='v' THEN 'VIEW' WHEN r.relkind='m' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,r.nspname,r.relname);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN ('public','app_private') AND p.prokind='f' LOOP
   EXECUTE format('ALTER FUNCTION %s OWNER TO tdp_app_owner',r.signature);
  END LOOP;
 END $ownership$;`);
const adapt=sql=>sql.replaceAll(selection.workspace_id,workspace).replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'");
const execute=async name=>{
 const results=await db.exec(adapt(scripts[name]));
 const receipt=results.flatMap(x=>x.rows||[]).find(x=>x.current_setting);
 assert.ok(receipt,'private receipt required');return JSON.parse(receipt.current_setting);
};
const beforeJobs=(await db.query('select to_jsonb(j) value from public.jobs j where id=$1',[job])).rows[0].value;
let result=await execute('changed');assert.equal(result.status,'refused');assert.equal(result.code,'RESUME_REVISION_CHANGED');
assert.deepEqual((await db.query('select to_jsonb(j) value from public.jobs j where id=$1',[job])).rows[0].value,beforeJobs);
await db.exec('revoke select on auth.users from tdp_app_owner');
result=await execute('diagnose');assert.equal(result.status,'checked','direct Auth-table SELECT must not become another Owner gate');
assert.equal(result.private_state.auth_users_select,false);
assert.deepEqual((await db.query('select to_jsonb(j) value from public.jobs j where id=$1',[job])).rows[0].value,beforeJobs);
await db.exec('grant select on auth.users to tdp_app_owner');
await db.query('update auth.users set email_confirmed_at=null where id=$1',[owner]);
assert.equal((await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner])).rows.length,1);
assert.equal((await db.query('select app_private.member_role($1) role',[workspace])).rows[0].role,'Owner');
result=await execute('diagnose');assert.equal(result.status,'checked','canonical Owner authority must not require a second email-confirmation gate');
assert.equal(result.private_state.owner_auth_state.email_confirmed,0);assert.equal(result.private_state.owner_auth_state.usable_auth_rows,1);
assert.equal((await db.query('select status from public.jobs where id=$1',[job])).rows[0].status,'blocked');
await db.exec('alter table auth.users enable row level security;set role tdp_app_owner;');
assert.equal((await db.query('select count(*)::int n from auth.users')).rows[0].n,0,'Auth rows must actually be invisible to the operational role');
await db.exec('reset role');
result=await execute('diagnose');assert.equal(result.status,'checked','canonical Owner authority is independent of direct Auth-row visibility');
assert.equal(result.private_state.auth_users_select,true);assert.equal(result.private_state.owner_auth_state.matching_auth_rows,0);
for(const invalid of ['inactive','revoked','reviewer']){
 if(invalid==='inactive')await db.query('update public.memberships set active=false where workspace_id=$1 and user_id=$2',[workspace,owner]);
 if(invalid==='revoked')await db.query("update public.identity_allowlist set status='inactive' where workspace_id=$1 and user_id=$2",[workspace,owner]);
 if(invalid==='reviewer')await db.query("update public.memberships set role='Reviewer' where workspace_id=$1 and user_id=$2",[workspace,owner]);
 result=await execute('diagnose');assert.equal(result.status,'refused',invalid+' Owner must remain rejected');
 assert.equal(result.private_diagnostics.stage,'owner_lookup');
 assert.equal((await db.query('select status from public.jobs where id=$1',[job])).rows[0].status,'blocked');
 await db.query("update public.memberships set active=true,role='Owner' where workspace_id=$1 and user_id=$2",[workspace,owner]);
 await db.query("update public.identity_allowlist set status='active' where workspace_id=$1 and user_id=$2",[workspace,owner]);
}
await db.query(`insert into public.model_attempts(workspace_id,job_id,lease_token,provider,operation,round_number,worker_attempt,status,sent)
 values($1,$2,gen_random_uuid(),'qwen_free','analyze_chunk',1,1,'failed',true)`,[workspace,job]);
result=await execute('valid');assert.equal(result.status,'refused');assert.equal(result.code,'RESUME_PROVIDER_ACTIVITY_EXISTS');
await db.query('delete from public.model_attempts where job_id=$1',[job]);
await db.exec(`alter function app_private.app_command(text,jsonb,text) rename to fixture_previous_command;
 create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
 declare result jsonb;begin result:=app_private.fixture_previous_command(operation,input,idempotency_key);
 update public.jobs set attempts=0 where entity_id=(input->>'id')::uuid;return result;end $$;
 alter function app_private.app_command(text,jsonb,text) owner to tdp_app_owner;`);
result=await execute('valid');assert.equal(result.status,'refused');assert.equal(result.code,'RESUME_IMMUTABLE_STATE_CHANGED');
assert.equal((await db.query('select attempts,status from public.jobs where id=$1',[job])).rows[0].attempts,2);
assert.equal((await db.query('select count(*)::int n from app_private.generation_processing_requests')).rows[0].n,0,'canonical request must roll back with counter mutation');
await db.exec('drop function app_private.app_command(text,jsonb,text);alter function app_private.fixture_previous_command(text,jsonb,text) rename to app_command;');
await db.exec(`alter function app_private.app_command(text,jsonb,text) rename to fixture_previous_command;
 create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
 begin raise exception using errcode='XX001',message='SYNTHETIC_PRIVATE_FAILURE',detail='SYNTHETIC_PRIVATE_DETAIL',hint='SYNTHETIC_PRIVATE_HINT';end $$;
 alter function app_private.app_command(text,jsonb,text) owner to tdp_app_owner;`);
result=await execute('diagnose');assert.equal(result.status,'refused');assert.equal(result.code,'RESUME_CANONICAL_COMMAND_FAILED');
assert.equal(result.private_diagnostics.sqlstate,'XX001');assert.equal(result.private_diagnostics.stage,'canonical_retry');
assert.equal(result.private_diagnostics.message,'SYNTHETIC_PRIVATE_FAILURE');assert.equal(result.private_diagnostics.detail,'SYNTHETIC_PRIVATE_DETAIL');
assert.equal(result.private_diagnostics.hint,'SYNTHETIC_PRIVATE_HINT');assert.match(result.private_diagnostics.context,/app_command/);
assert.equal((await db.query('select attempts,status from public.jobs where id=$1',[job])).rows[0].attempts,2);
await db.exec('drop function app_private.app_command(text,jsonb,text);alter function app_private.fixture_previous_command(text,jsonb,text) rename to app_command;');
result=await execute('diagnose');assert.equal(result.status,'checked');assert.equal(result.count,0);assert.equal(result.mutation_rolled_back,true);assert.equal(result.would_resume,true);
assert.equal((await db.query('select status from public.jobs where id=$1',[job])).rows[0].status,'blocked');
assert.equal((await db.query('select count(*)::int n from app_private.generation_processing_requests')).rows[0].n,0,'diagnostic must roll back canonical authorization');
assert.equal((await db.query("select count(*)::int n from public.audit_events where action='generation.retry'")).rows[0].n,0,'diagnostic must roll back canonical audit');
result=await execute('valid');assert.equal(result.status,'resumed');assert.equal(result.count,1);assert.equal(result.immutable_state_preserved,true);
const after=(await db.query('select attempts,checkpoint,status from public.jobs where id=$1',[job])).rows[0];
assert.equal(after.attempts,2);assert.deepEqual(after.checkpoint,{saved_checkpoint:true});assert.equal(after.status,'queued');
assert.equal((await db.query('select candidates from app_private.model_graph_budgets')).rows[0].candidates,0);
assert.equal((await db.query('select count(*)::int n from public.provider_usage')).rows[0].n,0);
assert.equal((await db.query('select count(*)::int n from public.model_attempts')).rows[0].n,0);
result=await execute('valid');assert.equal(result.status,'already_active');assert.equal(result.count,0);
await db.close();console.log('guarded canonical requested-processing resume passed');
