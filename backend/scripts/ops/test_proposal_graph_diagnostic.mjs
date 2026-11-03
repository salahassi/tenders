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
const job=(await db.query(`insert into public.jobs(id,workspace_id,type,entity_id,status,input_hash,error_code,attempts,created_by)
 values($4,$1,'analyze_chunk',$2,'blocked',repeat('a',64),'MODEL_CORRECTION_EXHAUSTED',3,$3) returning id`,[workspace,selection.plan_id,owner,selection.job_id])).rows[0].id;
await db.query(`insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,created_by)
 values($1,$2,$3,'analyze_chunk','analysis',1,'{"private":"PRIVATE STEP INPUT"}',$4)`,[workspace,selection.plan_id,job,owner]);
await db.query(`insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by)
 values($1,$2,gen_random_uuid(),'private-receipt','qwen_free','synthetic',repeat('a',64),current_date,1,100,100,'unknown',$3)`,[workspace,job,owner]);
await db.query(`insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,status) values(repeat('c',64),$1,$2,repeat('a',64),'analyze_chunk','needs_review')`,[workspace,job]);
await db.query(`insert into app_private.model_graph_budgets(workspace_id,thread_id,unit,candidates) values($1,repeat('c',64),'writer',3)`,[workspace]);
await db.query(`insert into app_private.model_graph_results(workspace_id,thread_id,result_key,value,content_hash) values($1,repeat('c',64),'semantic-instructions-fixture','{"version":4,"instructions":"PRIVATE HISTORICAL PROMPT"}',repeat('d',64))`,[workspace]);
// Disallowed routing/credential metadata must never leave the database.
await db.query(`update public.jobs set checkpoint=$2 where id=$1`,[job,JSON.stringify({model_executor:2,graph_thread:'c'.repeat(64),model_routing:{credential_alias:'SECRET_CREDENTIAL_ALIAS',providers:[{api_key:'SECRET_API_KEY'}],round_attempts:3},model_catalog_snapshot:{api_key:'SECRET_CATALOG_VALUE'},model_round:{input_hash:'a'.repeat(64),version:2,credential_alias:'SECRET_ROUND_ALIAS'}})]);
const writer={result:{requirements:[{id:'req_a',text:'PRIVATE WRITER REQUIREMENT بالعربية'}]},producer:{provider:'qwen_free',model:'synthetic'}};
const invalid={verification_key:'verification-synthetic',result:{checked_candidate_hash:'b'.repeat(64),claims:[{candidate_quote:'PRIVATE INVALID VERIFIER QUOTE',evidence_quote:'PRIVATE WRONG QUOTATION'}]},code:'EVIDENCE_REFERENCE_INVALID',validation_diagnostics:[{reason:'source_quote_not_found',paths:['claims[0].evidence_quote'],content_ids:['content_a']}]};
for(const [key,value] of [['candidate-0',writer],['invalid-verification-synthetic',invalid],['invalid-report-distinct-fallback',{...invalid,producer:{provider:'deepseek',model:'synthetic-fallback'}}],['invalid-verification-repair-synthetic',{...invalid,code:'MODEL_COVERAGE_INCOMPLETE'}],['verification-format-synthetic',{version:2,context:{content_units:[{id:'content_a',text:'PRIVATE CONTENT UNIT'}],required_ids:['req_a']}}]])
 await db.query(`insert into app_private.model_graph_results(workspace_id,thread_id,result_key,value,content_hash) values($1,repeat('c',64),$2,$3,repeat('d',64))`,[workspace,key,JSON.stringify(value)]);
const packed={type:'json',data:Buffer.from(JSON.stringify({channel_values:{candidateRef:'retained-candidate-id',repairCount:0,decision:'needs_review'}})).toString('base64')};
await db.query(`insert into app_private.model_graph_checkpoints(thread_id,namespace,checkpoint_id,checkpoint,metadata) values(repeat('c',64),'','checkpoint_1',$1,'{"type":"json","data":"e30="}')`,[JSON.stringify(packed)]);
await db.query(`insert into app_private.model_graph_writes(thread_id,namespace,checkpoint_id,task_id,idx,channel,value) values(repeat('c',64),'','checkpoint_1','verify-task',0,'decision',$1)`,[JSON.stringify(packed)]);
const usage=(await db.query('select id from public.provider_usage where job_id=$1',[job])).rows[0].id;
await db.query(`insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,operation,round_number,worker_attempt,status,result_code,sent,usage_id,provider_error_code,provider_error_type,provider_error_reason) values($1,$2,gen_random_uuid(),'qwen_free','synthetic','verify_grounding',1,3,'failed','EVIDENCE_REFERENCE_INVALID',true,$3,'invalid_quote','validation','source_quote_not_found')`,[workspace,job,usage]);
const sibling=(await db.query(`insert into public.jobs(workspace_id,type,entity_id,status,input_hash,created_by) values($1,'analyze_chunk',$2,'blocked',repeat('a',64),$3) returning id`,[workspace,selection.plan_id,owner])).rows[0].id;
await db.query(`insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,status) values(repeat('e',64),$1,$2,repeat('a',64),'analyze_chunk','needs_review')`,[workspace,sibling]);
await db.query(`insert into app_private.model_graph_results(thread_id,result_key,value,content_hash) values(repeat('e',64),'candidate-0','{"text":"UNSELECTED_SIBLING_CONTENT"}',repeat('d',64))`);
await db.query(`insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,operation,round_number,worker_attempt,status,sent) values($1,$2,gen_random_uuid(),'qwen_free','UNSELECTED_SIBLING_MODEL','analyze_chunk',1,1,'running',false)`,[workspace,sibling]);
// Exercise the same non-superuser ownership boundary used by the deployment.
await db.exec(`create role tdp_app_owner nosuperuser nobypassrls nocreatedb nocreaterole;
 alter schema public owner to tdp_app_owner;alter schema app_private owner to tdp_app_owner;
 grant usage on schema auth to tdp_app_owner;grant select,references on auth.users,auth.identities to tdp_app_owner;
 DO $ownership$ DECLARE rec record; BEGIN
  FOR rec IN SELECT n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p','v','m') LOOP
   EXECUTE format('ALTER %s %I.%I OWNER TO tdp_app_owner',CASE WHEN rec.relkind='v' THEN 'VIEW' WHEN rec.relkind='m' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,rec.nspname,rec.relname);
  END LOOP;
  FOR rec IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN ('public','app_private') AND p.prokind='f' LOOP
   EXECUTE format('ALTER FUNCTION %s OWNER TO tdp_app_owner',rec.signature);
  END LOOP;
 END $ownership$;`);
const state=async()=>{
 const value={};
 for(const table of ['public.generation_plans','public.jobs','public.generation_steps','public.provider_usage','public.model_attempts','app_private.model_graph_threads','app_private.model_graph_budgets','app_private.model_graph_results','app_private.model_graph_checkpoints','app_private.model_graph_writes','public.content_authorizations','app_private.generation_processing_requests','app_private.proposal_workflow_admission','public.audit_events'])
  value[table]=(await db.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows;
 return value;
};
const before=await state();
const sql=scripts.sql.replaceAll(selection.workspace_id,workspace).replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'");
const reports=await db.exec(sql);
await db.exec('reset role');
const report=reports.flatMap(r=>r.rows||[]).find(r=>r.report)?.report;
assert.equal(report.mode,'read_only_graph_diagnostic');assert.equal(report.plan.id,selection.plan_id);assert.equal(report.job.id,selection.job_id);
assert.equal(report.step.input.private,'PRIVATE STEP INPUT');assert.equal(report.plan.frozen_context.notice.text,'PRIVATE NOTICE BODY');
assert.equal(report.threads.length,1);assert.equal(report.budgets[0].candidates,3);assert.equal(report.results.length,6);
assert.deepEqual(report.results.find(r=>r.result_key==='candidate-0').value,writer);
assert.deepEqual(report.results.find(r=>r.result_key==='invalid-verification-synthetic').value,invalid);
assert.deepEqual(report.checkpoints[0].checkpoint,packed);assert.deepEqual(report.writes[0].value,packed);
assert.equal(report.attempts.length,1);assert.equal(report.attempts[0].provider_error_reason,'source_quote_not_found');
assert.equal(report.usage.length,1);assert.equal(report.usage[0].state,'unknown');assert.equal(report.usage[0].actual_input,null);
assert.equal(report.job.checkpoint.graph_thread,'c'.repeat(64));assert.equal(report.job.checkpoint.round_attempts,3);
assert.doesNotMatch(JSON.stringify(report),/SECRET_|UNSELECTED_|lease_token|remote_request_id/);
assert.deepEqual(await state(),before);
for(const changed of [sql.replaceAll(selection.plan_id,'00000000-0000-4000-8000-000000000999'),sql.replaceAll(selection.job_id,sibling),sql.replaceAll(selection.opportunity_id,'00000000-0000-4000-8000-000000000999'),sql.replace("current_database()<>'postgres'","current_database()<>'wrong'")]) {
 await assert.rejects(db.exec(changed),/PROPOSAL_GRAPH_TARGET_MISMATCH/);await db.exec('rollback;reset role');
}
await assert.rejects(db.exec(sql.replaceAll('33554432','1024')),/PROPOSAL_GRAPH_REPORT_TOO_LARGE/);await db.exec('rollback;reset role');
await assert.rejects(db.exec(sql.replace('COMMIT;',`UPDATE public.jobs SET status='canceled' WHERE id='${job}';COMMIT;`)),/read-only transaction/);await db.exec('rollback;reset role');
assert.deepEqual(await state(),before);await db.close();
