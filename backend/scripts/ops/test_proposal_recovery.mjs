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

const owner='00000000-0000-4000-8000-000000000001';
await db.query("insert into auth.users values($1,'fixture@example.test',now())",[owner]);
await db.query("insert into auth.identities values($1,'email',$2::jsonb)",[owner,JSON.stringify({sub:owner})]);
const workspace=(await db.query("select public.bootstrap_workspace($1,'Synthetic proposal inspection') id",[owner])).rows[0].id;
const source=(await db.query("insert into public.sources(workspace_id,name,kind,created_by) values($1,'Synthetic source','manual',$2) returning id",[workspace,owner])).rows[0].id;
await db.query("insert into public.opportunities(id,workspace_id,source_id,title,created_by) values($1,$2,$3,'PRIVATE BUYER TITLE',$4)",[selection.opportunity_id,workspace,source,owner]);
const proposal=(await db.query("insert into public.proposals(workspace_id,opportunity_id,title,created_by) values($1,$2,'PRIVATE PROPOSAL',$3) returning id",[workspace,selection.opportunity_id,owner])).rows[0].id;
const frozen={notice:{text:'PRIVATE NOTICE BODY',reference:{entity_kind:'notice',entity_id:selection.opportunity_id,content_hash:'a'.repeat(64)}},blocks:[{id:'source-block',text:'PRIVATE SOURCE QUOTATION',reference:{entity_kind:'document',entity_id:'00000000-0000-4000-8000-000000000111',content_hash:'b'.repeat(64)}}]};
await db.query(`insert into public.generation_plans(id,workspace_id,opportunity_id,proposal_id,kind,status,evidence_revision,input_hash,frozen_context,error_code,created_by)
 values($1,$2,$3,$4,'proposal','blocked',1,repeat('a',64),$5,'MODEL_CORRECTION_EXHAUSTED',$6)`,[selection.plan_id,workspace,selection.opportunity_id,proposal,JSON.stringify(frozen),owner]);
const job=(await db.query(`insert into public.jobs(workspace_id,type,entity_id,status,input_hash,error_code,attempts,created_by)
 values($1,'analyze_chunk',$2,'blocked',repeat('a',64),'MODEL_CORRECTION_EXHAUSTED',3,$3) returning id`,[workspace,selection.plan_id,owner])).rows[0].id;
await db.query(`insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,created_by)
 values($1,$2,$3,'analyze_chunk','analysis',1,'{"private":"PRIVATE STEP INPUT"}',$4)`,[workspace,selection.plan_id,job,owner]);
await db.query(`insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by)
 values($1,$2,gen_random_uuid(),'private-receipt','qwen_free','synthetic',repeat('a',64),current_date,1,100,100,'unknown',$3)`,[workspace,job,owner]);
await db.query(`insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,status) values(repeat('c',64),$1,$2,repeat('a',64),'analyze_chunk','needs_review')`,[workspace,job]);
await db.query(`insert into app_private.model_graph_budgets(workspace_id,thread_id,unit,candidates) values($1,repeat('c',64),'writer',3)`,[workspace]);
await db.query(`insert into app_private.model_graph_results(workspace_id,thread_id,result_key,value,content_hash) values($1,repeat('c',64),'semantic-instructions-fixture','{"version":2,"instructions":"PRIVATE HISTORICAL PROMPT"}',repeat('d',64))`,[workspace]);
const state=async()=>{
 const value={};
 for(const table of ['public.generation_plans','public.jobs','public.provider_usage','app_private.model_graph_threads','app_private.model_graph_budgets','app_private.model_graph_results','public.content_authorizations','app_private.proposal_workflow_admission'])
  value[table]=(await db.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows;
 return value;
};
const before=await state();
const sql=scripts.sql.replaceAll(selection.workspace_id,workspace).replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'").replace('SET LOCAL ROLE tdp_app_owner','SET LOCAL ROLE postgres');
const results=await db.exec(sql);
const report=results.flatMap(r=>r.rows||[]).find(r=>r.jsonb_build_object)?.jsonb_build_object;
assert.equal(report.mode,'read_only_inspection');assert.match(report.prospective_draft_snapshot_sha256,/^[a-f0-9]{64}$/);assert.equal(report.plan.id,selection.plan_id);assert.equal(report.plan.frozen_blocks,1);assert.equal(report.plan.source_reference_count,2);
assert.equal(report.jobs.length,1);assert.equal(report.threads[0].status,'needs_review');assert.equal(report.budgets[0].candidates,3);assert.equal(report.phase_pins[0].version,2);
assert.equal(report.usage[0].state,'unknown');assert.equal(report.usage[0].actual_input,null);assert.equal(report.workspace_usage_guards.unknown,1);
assert.equal(report.workflow_admission.enabled,false);assert.equal(report.workflow_admission.selected_target_admitted,false);
assert.doesNotMatch(JSON.stringify(report),/PRIVATE|private-receipt/);
assert.deepEqual(await state(),before);
for(const changed of [sql.replace(selection.plan_id,'00000000-0000-4000-8000-000000000999'),sql.replace("current_database()<>'postgres'","current_database()<>'wrong'")]) {
 await assert.rejects(db.exec(changed),/PROPOSAL_INSPECTION_TARGET_MISMATCH/);await db.exec('rollback');
}
assert.deepEqual(await state(),before);await db.close();
