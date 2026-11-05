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
 for(const table of ['public.generation_plans','public.proposal_issuance_requests','public.jobs','public.provider_usage','public.model_attempts','public.model_execution_settings','public.operations','app_private.dispatcher_settings','app_private.k8s_dispatch_queue','app_private.queue_dispatch_state','app_private.queue_owner_service','app_private.model_graph_threads','app_private.model_graph_budgets','app_private.model_graph_results','public.content_authorizations','app_private.proposal_workflow_admission'])
  if((await db.query('select to_regclass($1) relation',[table])).rows[0].relation)
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
assert.deepEqual(report.scheduler.outbox,{available:false,state:null});
assert.equal(report.workspace_execution.effective_max_parallel_requests,1);
assert.equal(report.workspace_execution.reserved_count,0);
assert.equal(report.workspace_execution.request_capacity_full,false);
assert.doesNotMatch(JSON.stringify(report),/PRIVATE|private-receipt/);
assert.deepEqual(await state(),before);
for(const changed of [sql.replace(selection.plan_id,'00000000-0000-4000-8000-000000000999'),sql.replace("current_database()<>'postgres'","current_database()<>'wrong'")]) {
 await assert.rejects(db.exec(changed),/PROPOSAL_INSPECTION_TARGET_MISMATCH/);await db.exec('rollback');
}
assert.deepEqual(await state(),before);

// Exercise the exact optional Kubernetes outbox DDL rather than inventing a
// fixture schema. Lease credentials and dispatcher secrets must never escape.
await db.exec((await readFile(new URL('scripts/runtime/dispatcher.sql',root),'utf8')).replaceAll(':"service_role"','service_role'));
await db.exec(`insert into app_private.dispatcher_settings(singleton,project_url,secret_hash,enabled,last_dispatch_at)
 values(true,'https://private-dispatch.example.test',repeat('9',64),true,now()-interval '20 seconds')
 on conflict(singleton) do update set project_url=excluded.project_url,secret_hash=excluded.secret_hash,enabled=true,last_dispatch_at=excluded.last_dispatch_at;
 update app_private.k8s_dispatch_queue set generation=9,acknowledged_generation=6,lease_generation=8,
 lease_token='00000000-0000-4000-8000-000000009999',lease_until=now()+interval '2 minutes',last_periodic_at=now()-interval '30 seconds',failures=1;`);
await db.query(`insert into public.model_execution_settings(workspace_id,enabled,max_parallel_requests,created_by) values($1,true,1,$2)
 on conflict(workspace_id) do update set enabled=true,max_parallel_requests=1`,[workspace,owner]);
await db.query('update public.operations set last_heartbeat_at=now(),scheduler_enabled=true where workspace_id=$1',[workspace]);
const otherPlan=(await db.query(`insert into public.generation_plans(workspace_id,opportunity_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by)
 values($1,$2,'assessment','assessment','running',1,repeat('e',64),'{}',$3) returning id`,[workspace,selection.opportunity_id,owner])).rows[0].id;
const reservedOwner=(await db.query(`insert into public.jobs(workspace_id,type,entity_id,status,input_hash,error_code,next_attempt_at,checkpoint,created_by)
 values($1,'classify_opportunity',$2,'retry_wait',repeat('e',64),'MODEL_IN_PROGRESS',now()+interval '1 hour','{"model_executor":2,"secret":"PRIVATE CHECKPOINT SECRET"}',$3) returning id`,[workspace,otherPlan,owner])).rows[0].id;
const reserved=(await db.query(`insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,
 state,remote_request_id,remote_deadline,remote_project_ref,execution_metadata,created_by)
 values($1,$2,'00000000-0000-4000-8000-000000008888','PRIVATE CALL KEY','openai','synthetic-background',repeat('e',64),current_date,1,100,100,
 'reserved','resp_PRIVATE_REMOTE_ID',now()+interval '1 day','synthetic-project','{"headers":{"authorization":"PRIVATE PROVIDER SECRET"}}',$3) returning id`,[workspace,reservedOwner,owner])).rows[0].id;
const running=(await db.query(`insert into public.jobs(workspace_id,type,entity_id,status,input_hash,lease_token,lease_until,next_attempt_at,checkpoint,created_by)
 values($1,'model_probe',$1,'running',repeat('e',64),'00000000-0000-4000-8000-000000007777',now()+interval '1 minute',now(),'{"secret":"PRIVATE RUNNING CHECKPOINT"}',$2) returning id`,[workspace,owner])).rows[0].id;
await db.query(`insert into public.jobs(workspace_id,type,entity_id,status,input_hash,next_attempt_at,checkpoint,created_by)
 values($1,'model_probe',$1,'queued',repeat('f',64),now()-interval '2 minutes','{"model_executor":2}',$2),
 ($1,'model_probe',$1,'queued',repeat('f',64),now()-interval '1 minute','{"model_executor":3}',$2)`,[workspace,owner]);
await db.query(`update public.jobs set checkpoint='{"model_executor":2,"graph_thread":"synthetic-thread","model_round":{"input_hash":"synthetic-round-hash","version":2,"private":"PRIVATE ROUND"},"model_routing":{"round_attempts":7,"key":"PRIVATE KEY"}}' where id=$1`,[job]);
await db.query(`insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,project_ref,operation,round_number,worker_attempt,status,sent,result_code,http_status,request_phase,execution_metadata)
 values($1,$2,gen_random_uuid(),'qwen_free','synthetic','synthetic-project','verify_grounding',1,1,'failed',true,'MODEL_NETWORK_UNCERTAIN',503,'response','{"headers":"PRIVATE ATTEMPT HEADER"}')`,[workspace,job]);
const extendedBefore=await state();
const metadata=(await db.exec(sql)).flatMap(r=>r.rows||[]).find(r=>r.jsonb_build_object).jsonb_build_object;
assert.equal(metadata.jobs.length,1);
assert.equal(metadata.usage.length,1);
assert.equal(metadata.workspace_execution.reserved_count,1);
assert.equal(metadata.workspace_execution.effective_max_parallel_requests,1);
assert.equal(metadata.workspace_execution.request_capacity_full,true);
assert.equal(metadata.workspace_execution.reserved_rows_truncated,false);
assert.equal(metadata.workspace_execution.reserved_requests.length,1);
assert.equal(metadata.workspace_execution.reserved_requests[0].id,reserved);
assert.equal(metadata.workspace_execution.reserved_requests[0].job_id,reservedOwner);
assert.equal(metadata.workspace_execution.reserved_requests[0].owner_plan_id,otherPlan);
assert.equal(metadata.workspace_execution.reserved_requests[0].owner_plan_kind,'assessment');
assert.equal(metadata.workspace_execution.reserved_requests[0].belongs_to_selected_plan,false);
assert.equal(metadata.workspace_execution.reserved_requests[0].accepted_remote,true);
assert.equal(metadata.workspace_execution.reserved_requests[0].job_lease_present,false);
assert.equal(metadata.workspace_execution.reserved_requests[0].usage_matches_current_job_lease,false);
assert.equal(metadata.workspace_execution.running_count,1);
assert.equal(metadata.workspace_execution.running_with_active_lease,1);
assert.equal(metadata.workspace_execution.running_jobs[0].id,running);
assert.equal(metadata.workspace_execution.due_by_class.find(r=>r.executor_supported).due_count,1);
assert.equal(metadata.workspace_execution.due_by_class.find(r=>!r.executor_supported).due_count,1);
assert.equal(metadata.scheduler.operations.scheduler_enabled,true);
assert.equal(metadata.scheduler.dispatcher.enabled,true);
assert.equal(metadata.scheduler.outbox.available,true);
assert.equal(metadata.scheduler.outbox.state.pending_generations,3);
assert.equal(metadata.scheduler.outbox.state.lease_active,true);
assert.equal(metadata.jobs[0].checkpoint.round_attempts,7);
assert.equal(metadata.latest_attempts[0].result_code,'MODEL_NETWORK_UNCERTAIN');
assert.doesNotMatch(JSON.stringify(metadata),/PRIVATE|private-dispatch|999999999999999999|00000000-0000-4000-8000-000000009999|00000000-0000-4000-8000-000000008888|00000000-0000-4000-8000-000000007777/);
assert.deepEqual(await state(),extendedBefore);
assert.equal(report.latest_issuance, null);
const issuance = (await db.query(`insert into public.proposal_issuance_requests
 (workspace_id,plan_id,requested_by,operation,idempotency_key,accepted_at,deadline_at,outcome,error_code,completed_at)
 values($1,$2,$3,'proposal.generate','PRIVATE ISSUANCE KEY',now()-interval '1 minute',now()+interval '9 minutes',
 'failed','AI_AGENTS_UNAVAILABLE',now()) returning id`, [workspace,selection.plan_id,owner])).rows[0].id;
await db.query('update public.generation_plans set issuance_request_id=$1 where id=$2',[issuance,selection.plan_id]);
const issuanceBefore = await state();
const withIssuance = (await db.exec(sql)).flatMap(r=>r.rows||[]).find(r=>r.jsonb_build_object).jsonb_build_object;
assert.equal(withIssuance.latest_issuance.id, issuance);
assert.equal(withIssuance.latest_issuance.plan_id, selection.plan_id);
assert.equal(withIssuance.latest_issuance.requested_by, owner);
assert.equal(withIssuance.latest_issuance.outcome, 'failed');
assert.equal(withIssuance.latest_issuance.error_code, 'AI_AGENTS_UNAVAILABLE');
assert.equal(new Date(withIssuance.latest_issuance.deadline_at)-new Date(withIssuance.latest_issuance.accepted_at),600000);
assert.equal(withIssuance.latest_issuance.completed_at,withIssuance.latest_issuance.effective_completed_at);
assert.doesNotMatch(JSON.stringify(withIssuance),/PRIVATE ISSUANCE KEY/);
assert.deepEqual(await state(),issuanceBefore);
await db.close();
