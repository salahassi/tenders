import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';

process.on('uncaughtException',error=>{console.error(JSON.stringify({message:error.message,code:error.code}));process.exit(1);});
const selection={workspace_id:'00000000-0000-4000-8000-000000000100',opportunity_id:'00000000-0000-4000-8000-000000000101',plan_id:'00000000-0000-4000-8000-000000000102'};
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
const workspace=(await db.query("select public.bootstrap_workspace($1,'Synthetic paid proposal successor') id",[owner])).rows[0].id;
const source=(await db.query("insert into public.sources(workspace_id,name,kind,created_by) values($1,'Synthetic source','manual',$2) returning id",[workspace,owner])).rows[0].id;
await db.query("insert into public.opportunities(id,workspace_id,source_id,title,decision,language,created_by) values($1,$2,$3,'Synthetic source retained','shortlisted','en',$4)",[selection.opportunity_id,workspace,source,owner]);
const proposal=(await db.query("insert into public.proposals(workspace_id,opportunity_id,title,language,created_by) values($1,$2,'Synthetic retained proposal','en',$3) returning id",[workspace,selection.opportunity_id,owner])).rows[0].id;
const document=(await db.query(`insert into public.documents(workspace_id,opportunity_id,kind,original_name,mime_type,expected_size,original_hash,storage_key,status,extracted_text,extraction_hash,created_by)
 values($1,$2,'rfp','PRIVATE ORIGINAL.pdf','application/pdf',100,repeat('a',64),'private/original','ready','PRIVATE SOURCE TEXT',repeat('b',64),$3) returning id`,[workspace,selection.opportunity_id,owner])).rows[0].id;
const block=(await db.query(`insert into public.document_blocks(workspace_id,document_id,ordinal,locator,text,text_hash,created_by)
 values($1,$2,0,'{}','PRIVATE SOURCE TEXT',repeat('b',64),$3) returning id`,[workspace,document,owner])).rows[0].id;
await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
const packageId=(await db.query('select (app_private.seal_draft_package($1,$2,$3)).id id',[workspace,selection.opportunity_id,owner])).rows[0].id;
const knowledge=(await db.query(`insert into public.knowledge_items(workspace_id,category,title,content,verified,verified_by,verified_at,created_by)
 values($1,'company','Synthetic company','Synthetic verified capability.',true,$2,now(),$2) returning id`,[workspace,owner])).rows[0].id;
const template=(await db.query(`insert into public.templates(workspace_id,title,language,volume_mode,required_sections,fixed_blocks,content_hash,approved,approved_by,approved_at,created_by)
 values($1,'Synthetic template','en','combined','[{"key":"approach","title":"Approach","purpose":"Propose a workflow","volume":"technical","applicable":true}]','[]',repeat('f',64),true,$2,now(),$2) returning id`,[workspace,owner])).rows[0].id;
const rate=(await db.query(`insert into public.rate_catalog(workspace_id,title,unit,currency,unit_cost,valid_from,valid_until,source_reference,source,content_hash,public_approved,approved,approved_by,approved_at,created_by)
 values($1,'Synthetic public rate','day','SAR',100,current_date-1,current_date+1,'synthetic-reference','Synthetic authorized rate basis.',repeat('e',64),true,true,$2,now(),$2) returning id`,[workspace,owner])).rows[0].id;
const frozen={language:'en',notice:{text:'PRIVATE NOTICE',reference:{entity_kind:'notice',entity_id:selection.opportunity_id,content_hash:'a'.repeat(64)}},blocks:[{id:block,text:'PRIVATE SOURCE TEXT',reference:{entity_kind:'document',entity_id:document,content_hash:'b'.repeat(64)}}]};
await db.query(`insert into public.generation_plans(id,workspace_id,opportunity_id,proposal_id,kind,status,evidence_revision,input_hash,frozen_context,error_code,created_by)
 values($1,$2,$3,$4,'proposal','blocked',1,repeat('a',64),$5,'MODEL_CORRECTION_EXHAUSTED',$6)`,[selection.plan_id,workspace,selection.opportunity_id,proposal,JSON.stringify(frozen),owner]);
await db.query('update public.generation_plans set package_id=$1 where id=$2',[packageId,selection.plan_id]);
const job=(await db.query(`insert into public.jobs(workspace_id,type,entity_id,status,input_hash,error_code,attempts,checkpoint,created_by)
 values($1,'analyze_chunk',$2,'blocked',repeat('a',64),'MODEL_CORRECTION_EXHAUSTED',3,'{"private":"retained checkpoint"}',$3) returning id`,[workspace,selection.plan_id,owner])).rows[0].id;
await db.query(`insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,created_by)
 values($1,$2,$3,'analyze_chunk','analysis',1,'{"block_id":"retained"}',$4)`,[workspace,selection.plan_id,job,owner]);
const usage=(await db.query(`insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_at,remote_request_id,remote_deadline,remote_project_ref,error_code,created_by)
 values($1,$2,gen_random_uuid(),'private-receipt','openai','synthetic',repeat('a',64),current_date,1,100,100,'unknown',now()-interval '3 days','resp_private',now()-interval '2 days','synthetic-project','PROVIDER_BACKGROUND_TERMINATED',$3) returning id`,[workspace,job,owner])).rows[0].id;
const unrelated=(await db.query(`insert into public.jobs(workspace_id,type,entity_id,status,input_hash,created_by) values($1,'source_collect',$2,'blocked',repeat('e',64),$3) returning id`,[workspace,source,owner])).rows[0].id;
await db.query(`insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by)
 values($1,$2,gen_random_uuid(),'unrelated-unknown','qwen_free','synthetic',repeat('e',64),current_date,1,100,100,'unknown',$3)`,[workspace,unrelated,owner]);
await db.query(`insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,status) values(repeat('c',64),$1,$2,repeat('a',64),'analyze_chunk','needs_review')`,[workspace,job]);
await db.query(`insert into app_private.model_graph_budgets(workspace_id,thread_id,unit,candidates) values($1,repeat('c',64),'writer',3)`,[workspace]);
const candidate=(await db.query(`insert into app_private.model_graph_results(workspace_id,thread_id,result_key,value,content_hash) values($1,repeat('c',64),'candidate-2','{"result":"PRIVATE RETAINED CANDIDATE"}',repeat('d',64)) returning id`,[workspace])).rows[0].id;
await db.query(`insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,project_ref,operation,round_number,worker_attempt,status,sent,usage_id)
 values($1,$2,gen_random_uuid(),'openai','synthetic','synthetic-project','analyze_chunk',1,3,'succeeded',true,$3)`,[workspace,job,usage]);
await db.query(`insert into app_private.model_graph_checkpoints(thread_id,namespace,checkpoint_id,checkpoint,metadata) values(repeat('c',64),'','retained_checkpoint','{"type":"json","data":"e30="}','{"type":"json","data":"e30="}')`);
await db.query(`insert into app_private.model_graph_writes(thread_id,namespace,checkpoint_id,task_id,idx,channel,value) values(repeat('c',64),'','retained_checkpoint','retained_task',0,'candidateRef','{"type":"json","data":"e30="}')`);
await db.query(`insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,reason) values($1,$2,'ops.synthetic.retained','generation_plan',$3,'Retained original event')`,[workspace,owner,selection.plan_id]);
await db.query(`insert into public.model_execution_settings(workspace_id,enabled,created_by) values($1,true,$2) on conflict(workspace_id) do update set enabled=true`,[workspace,owner]);
await db.exec("delete from app_private.proposal_workflow_admission;create table app_private.application_release_history(release text primary key,migration_sha256 text);insert into app_private.application_release_history values('ai-execution-reliability-v1',repeat('f',64));");
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
 for(const table of ['public.generation_plans','public.proposals','public.opportunities','public.jobs','public.generation_steps','public.provider_usage','public.model_attempts','app_private.model_graph_threads','app_private.model_graph_budgets','app_private.model_graph_results','app_private.model_graph_checkpoints','app_private.model_graph_writes','app_private.generation_processing_requests','public.content_authorizations','public.documents','public.document_packages','public.knowledge_items','public.templates','public.rate_catalog','public.review_inputs','app_private.proposal_workflow_admission','public.audit_events'])
  value[table]=(await db.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows;
 return value;
};
const adapt=sql=>{
 const name=sql.includes('BEGIN ISOLATION LEVEL SERIALIZABLE;')?'successor_tx':'inspection_tx';
 return sql.replaceAll(selection.workspace_id,workspace).replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'")
  .replace(/^BEGIN ISOLATION LEVEL (?:SERIALIZABLE|REPEATABLE READ READ ONLY);/,`SAVEPOINT ${name};`).replace(/COMMIT;\s*$/,`RESET ROLE;RELEASE SAVEPOINT ${name};`);
};
const inspector=(await readFile(new URL('proposal-recovery-inspect.sql',import.meta.url),'utf8')).replaceAll('__WORKSPACE__',workspace).replaceAll('__PLAN__',selection.plan_id).replaceAll('__OPPORTUNITY__',selection.opportunity_id);
const script=fileURLToPath(new URL('proposal-successor.py',import.meta.url));
const compile=async(restart=false,change=()=>{})=>{
 const rows=(await db.exec(adapt(inspector))).flatMap(r=>r.rows||[]);
 const report=rows.find(r=>r.jsonb_build_object).jsonb_build_object;
 report.runtime_images={api:'registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:'+'e'.repeat(64),worker:'registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:'+'e'.repeat(64)};
 change(report);
 return adapt(execFileSync('python3',['-c',`import importlib.util,json,sys; spec=importlib.util.spec_from_file_location('fixture_successor',sys.argv[1]); s=importlib.util.module_from_spec(spec);sys.modules[spec.name]=s;spec.loader.exec_module(s);report=json.load(sys.stdin);s.r.access.WORKSPACE=report['selection']['workspace_id'];print(s.recovery_sql(s.selection_from_inspection(report),restart=sys.argv[2]=='true'))`,script,String(restart)],{input:JSON.stringify(report),encoding:'utf8'}));
};
const run=async sql=>{
 const rows=(await db.exec(sql)).flatMap(r=>r.rows||[]);return JSON.parse(rows.find(r=>r.current_setting).current_setting);
};
await db.exec('begin isolation level serializable');
const baseState=await state();
assert.equal(baseState['public.model_attempts'].length,1,'a real retained successful attempt must exist');
let result=await run(await compile(false));
assert.equal(result.status,'checked',JSON.stringify(result));assert.equal(result.canonical_mutations_rolled_back,true);assert.deepEqual(await state(),baseState);
for(const [name,setup,expected] of [
 ['missing blocker',async()=>{await db.query("update public.jobs set error_code=null where id=$1",[job]);await db.query("update public.generation_plans set error_code=null where id=$1",[selection.plan_id]);},'PROPOSAL_SUCCESSOR_PLAN_CHANGED'],
 ['recent nonterminal unknown',()=>db.query("update public.provider_usage set error_code=null,created_at=now() where id=$1",[usage]),'PROPOSAL_SUCCESSOR_PENDING_USAGE'],
 ['active nonterminal remote',()=>db.query("update public.provider_usage set error_code='PROVIDER_BACKGROUND_RETRIEVAL_FAILED',remote_deadline=now()+interval '1 hour' where id=$1",[usage]),'PROPOSAL_SUCCESSOR_PENDING_USAGE'],
 ['old nonterminal unknown',()=>db.query("update public.provider_usage set error_code=null where id=$1",[usage]),'PROPOSAL_SUCCESSOR_PENDING_USAGE'],
 ['terminal marker without remote identity',()=>db.query("update public.provider_usage set remote_request_id=null,remote_deadline=null where id=$1",[usage]),'PROPOSAL_SUCCESSOR_PENDING_USAGE'],
 ['terminal marker without remote project identity',()=>db.query("update public.provider_usage set remote_project_ref=null where id=$1",[usage]),'PROPOSAL_SUCCESSOR_PENDING_USAGE'],
 ['reserved',()=>db.query("update public.provider_usage set state='reserved' where id=$1",[usage]),'PROPOSAL_SUCCESSOR_PENDING_USAGE'],
 ['running job',()=>db.query("update public.jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '1 hour' where id=$1",[job]),'PROPOSAL_SUCCESSOR_JOB_STATE_CHANGED'],
 ['idle retry with lease',()=>db.query("update public.jobs set status='retry_wait',lease_token=gen_random_uuid(),lease_until=now()+interval '1 hour' where id=$1",[job]),'PROPOSAL_SUCCESSOR_JOB_STATE_CHANGED'],
 ['queued nonanalysis job',()=>db.query("update public.jobs set type='advance_plan',status='queued' where id=$1",[job]),'PROPOSAL_SUCCESSOR_JOB_STATE_CHANGED'],
 ['no remaining failed analysis job',()=>db.query("update public.jobs set status='queued' where id=$1",[job]),'PROPOSAL_SUCCESSOR_JOB_STATE_CHANGED'],
 ['completed step',()=>db.query("update public.generation_steps set status='completed' where job_id=$1",[job]),'PROPOSAL_SUCCESSOR_JOB_STATE_CHANGED'],
 ['final graph accepted',()=>db.query("update app_private.model_graph_threads set status='accepted',result_id=$1 where job_id=$2",[candidate,job]),'PROPOSAL_SUCCESSOR_COMPLETED_WORK_AVAILABLE'],
 ['accepted artifact before thread commit',()=>db.query("insert into app_private.model_graph_results(thread_id,result_key,value,content_hash) values(repeat('c',64),'accepted','{\"retained_final\":true}',repeat('f',64))"),'PROPOSAL_SUCCESSOR_COMPLETED_WORK_AVAILABLE'],
 ['changed original extraction',()=>db.query("update public.documents set extraction_hash=repeat('f',64) where id=$1",[document]),'PROPOSAL_SUCCESSOR_SELECTED_SOURCES_CHANGED'],
 ['language override',()=>db.query("update public.generation_plans set frozen_context=jsonb_set(frozen_context,'{language}','\"ar\"') where id=$1",[selection.plan_id]),'PROPOSAL_REQUEST_OPTIONS_CHANGED'],
]) {
 await db.exec('savepoint scenario');await setup();const sql=await compile(true);const before=await state();result=await run(sql);
 assert.equal(result.status,'refused',name+JSON.stringify(result));assert.equal(result.code,expected,name+JSON.stringify(result));assert.deepEqual(await state(),before);await db.exec('rollback to savepoint scenario;release savepoint scenario');
}
result=await run(await compile(true,r=>r.plan.revision++));assert.equal(result.code,'PROPOSAL_SUCCESSOR_PLAN_CHANGED');assert.deepEqual(await state(),baseState);
const stale=await compile(true);await db.query('update public.documents set revision=revision+1 where id=$1',[document]);
result=await run(stale);assert.equal(result.code,'PROPOSAL_SUCCESSOR_DOCUMENTS_CHANGED');await db.query('update public.documents set revision=revision-1 where id=$1',[document]);
for(const [kind,mutate,expected] of [
 ['job revision',()=>db.query('update public.jobs set revision=revision+1 where id=$1',[job]),'PROPOSAL_SUCCESSOR_JOB_STATE_CHANGED'],
 ['usage receipt',()=>db.query("update public.provider_usage set error_code='PROVIDER_BACKGROUND_RETRIEVAL_FAILED' where id=$1",[usage]),'PROPOSAL_SUCCESSOR_USAGE_CHANGED'],
]) {
 await db.exec('savepoint stale_selection');const bound=await compile(true);await mutate();const changed=await state();
 result=await run(bound);assert.equal(result.code,expected,kind+JSON.stringify(result));assert.deepEqual(await state(),changed);
 await db.exec('rollback to savepoint stale_selection;release savepoint stale_selection');
}
// Guard the reviewed complete prospective inputs, including fields not covered
// by the selected RFP document manifest or the opportunity revision alone.
for(const [name,mutate] of [
 ['company',()=>db.query("update public.knowledge_items set content='Changed verified capability.' where id=$1",[knowledge])],
 ['template',()=>db.query("update public.templates set style_config='{\"tone\":\"changed\"}' where id=$1",[template])],
 ['rate',()=>db.query("update public.rate_catalog set source='Changed authorized rate basis.' where id=$1",[rate])],
 ['tender',()=>db.query("update public.opportunities set description='Changed buyer obligation.' where id=$1",[selection.opportunity_id])],
]) {
 await db.exec('savepoint relevant_source');const bound=await compile(true);await mutate();const before=await state();
 result=await run(bound);assert.equal(result.code,'PROPOSAL_SUCCESSOR_RELEVANT_EVIDENCE_CHANGED',name+JSON.stringify(result));
 assert.deepEqual(await state(),before);await db.exec('rollback to savepoint relevant_source;release savepoint relevant_source');
}
// Initial generation has no active review base. A real active-version review
// changes the same canonical snapshot, and the separate business-state guard
// prevents this initial-draft helper from silently becoming regeneration.
await db.exec('savepoint review_source');
const initialBound=await compile(true);
const version=(await db.query(`insert into public.proposal_versions(workspace_id,proposal_id,ordinal,content_hash,created_by) values($1,$2,1,repeat('a',64),$3) returning id`,[workspace,proposal,owner])).rows[0].id;
await db.query('update public.proposals set active_version_id=$1 where id=$2',[version,proposal]);
const review=(await db.query(`insert into public.review_inputs(workspace_id,proposal_id,base_version_id,target_kind,target_id,body,source_signature,created_by)
 values($1,$2,$3,'general','general','Original reviewed instruction.',repeat('a',64),$4) returning id`,[workspace,proposal,version,owner])).rows[0].id;
const snapshotHash=async()=> (await db.query("select encode(sha256(convert_to(app_private.draft_generation_snapshot($1,$2,$3,$4)::text,'UTF8')),'hex') value",[workspace,selection.opportunity_id,proposal,packageId])).rows[0].value;
const reviewBefore=await snapshotHash();await db.query("update public.review_inputs set body='Changed reviewed instruction.' where id=$1",[review]);
assert.notEqual(await snapshotHash(),reviewBefore);const reviewedState=await state();
result=await run(initialBound);assert.equal(result.code,'PROPOSAL_SUCCESSOR_BUSINESS_STATE_CHANGED');assert.deepEqual(await state(),reviewedState);
await db.exec('rollback to savepoint review_source;release savepoint review_source');
// Detect even a canonical-side snapshot mutation and roll back cancellation.
await db.exec(`create function public.synthetic_change_snapshot() returns trigger language plpgsql as $$ begin new.frozen_context:=jsonb_set(new.frozen_context,'{title}','"Changed after reviewed snapshot"');return new;end $$;create trigger synthetic_change_snapshot before insert on public.generation_plans for each row execute function public.synthetic_change_snapshot();`);
result=await run(await compile(true));assert.equal(result.code,'PROPOSAL_SUCCESSOR_SNAPSHOT_CHANGED',JSON.stringify(result));
await db.exec('drop trigger synthetic_change_snapshot on public.generation_plans;drop function public.synthetic_change_snapshot()');assert.deepEqual(await state(),baseState);
// A faulty canonical-side accounting mutation must roll back the entire cancellation/generation.
await db.exec(`create function public.synthetic_corrupt_history() returns trigger language plpgsql as $$ begin update public.provider_usage set actual_input=1 where id='${usage}';return new;end $$;create trigger synthetic_corrupt_history after insert on public.generation_plans for each row execute function public.synthetic_corrupt_history();`);
result=await run(await compile(true));assert.equal(result.code,'PROPOSAL_SUCCESSOR_HISTORY_CHANGED',JSON.stringify(result));
await db.exec('drop trigger synthetic_corrupt_history on public.generation_plans;drop function public.synthetic_corrupt_history()');assert.deepEqual(await state(),baseState);
await db.exec(`create function public.synthetic_corrupt_audit() returns trigger language plpgsql as $$ begin update public.audit_events set reason='Changed historical event' where action='ops.synthetic.retained';return new;end $$;create trigger synthetic_corrupt_audit after insert on public.generation_plans for each row execute function public.synthetic_corrupt_audit();`);
result=await run(await compile(true));assert.equal(result.code,'PROPOSAL_SUCCESSOR_HISTORY_CHANGED',JSON.stringify(result));
await db.exec('drop trigger synthetic_corrupt_audit on public.generation_plans;drop function public.synthetic_corrupt_audit()');assert.deepEqual(await state(),baseState);
await db.exec('savepoint admitted');
await db.query('insert into app_private.proposal_workflow_admission(singleton,enabled,trial_opportunity_id) values(true,true,$1)',[selection.opportunity_id]);
result=await run(await compile(false));assert.equal(result.status,'checked',JSON.stringify(result));assert.equal(result.workflow_version,3);
assert.equal((await db.query('select enabled from app_private.proposal_workflow_admission')).rows[0].enabled,true);
await db.exec('rollback to savepoint admitted;release savepoint admitted');
// Safe idle siblings and proven terminal unknown receipts permit a distinct
// canonical request without spending or resetting any predecessor allowance.
await db.exec('savepoint mixed_idle_analysis');
const idleJobs=[];
for(const [index,status] of ['queued','retry_wait'].entries()) {
 const sibling=(await db.query(`insert into public.jobs(workspace_id,type,entity_id,status,input_hash,next_attempt_at,checkpoint,created_by)
  values($1,'analyze_chunk',$2,$3,repeat('a',64),now()+interval '10 minutes','{"retained_idle_phase":true}',$4) returning id`,[workspace,selection.plan_id,status,owner])).rows[0].id;
 idleJobs.push(sibling);
 await db.query(`insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,created_by)
  values($1,$2,$3,'analyze_chunk','analysis',$4,'{"retained_input":true}',$5)`,[workspace,selection.plan_id,sibling,index+2,owner]);
}
await db.query("update public.provider_usage set created_at=now(),remote_deadline=now()+interval '23 hours' where id=$1",[usage]);
await db.query("update app_private.model_graph_budgets set candidates=1 where thread_id=repeat('c',64) and unit='writer'");
await db.query("update app_private.model_graph_threads set candidate_count=1 where id=repeat('c',64)");
await db.query("insert into app_private.model_graph_budgets(thread_id,unit,candidates) values(repeat('c',64),'verifier-retained',2),(repeat('c',64),'verifier-repair-retained',1)");

await db.query(`insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,actual_input,actual_output,graph_candidate_recorded,created_by)
 values($1,$2,gen_random_uuid(),'settled-intermediate','qwen_free','synthetic-paid',repeat('a',64),current_date,1,100,100,'settled',50,20,true,$3)`,[workspace,job,owner]);
await db.query(`insert into app_private.model_graph_results(thread_id,result_key,value,content_hash) values(repeat('c',64),'semantic-instructions-existing','{"version":4}',repeat('f',64))`);
const mixedBefore=await state(),mixedSql=await compile(true);
result=await run(await compile(false));assert.equal(result.status,'checked',JSON.stringify(result));assert.deepEqual(await state(),mixedBefore);
result=await run(mixedSql);assert.equal(result.status,'started',JSON.stringify(result));
const mixedAfter=await state();
for(const table of ['public.provider_usage','public.model_attempts','app_private.model_graph_threads','app_private.model_graph_budgets','app_private.model_graph_results','app_private.model_graph_checkpoints','app_private.model_graph_writes']) assert.deepEqual(mixedAfter[table],mixedBefore[table],table);
const oldAuditIds=new Set(mixedBefore['public.audit_events'].map(r=>r.value.id));
assert.deepEqual(mixedAfter['public.audit_events'].filter(r=>oldAuditIds.has(r.value.id)),mixedBefore['public.audit_events']);
for(const id of [job,...idleJobs]) {
 const before=mixedBefore['public.jobs'].find(r=>r.value.id===id).value,after=mixedAfter['public.jobs'].find(r=>r.value.id===id).value;
 assert.equal(after.status,'canceled');assert.equal(after.cancel_requested,true);assert.deepEqual(after.checkpoint,before.checkpoint);assert.equal(after.attempts,before.attempts);assert.equal(after.next_attempt_at,before.next_attempt_at);
 const immutable=row=>Object.fromEntries(Object.entries(row).filter(([key])=>!['status','cancel_requested','revision','updated_at'].includes(key)));
 assert.deepEqual(immutable(after),immutable(before));
}
const newJobs=mixedAfter['public.jobs'].filter(r=>r.value.entity_id===result.plan_id);
assert.ok(newJobs.length>0);assert.ok(newJobs.every(r=>![job,...idleJobs].includes(r.value.id)));
assert.equal(mixedAfter['app_private.model_graph_threads'].filter(r=>newJobs.some(j=>j.value.id===r.value.job_id)).length,0);
await db.exec('rollback to savepoint mixed_idle_analysis;release savepoint mixed_idle_analysis');assert.deepEqual(await state(),baseState);
const restart=await compile(true);
const inspectedRevision=(await db.query('select evidence_revision from public.workspaces where id=$1',[workspace])).rows[0].evidence_revision;
// A substantive change to another tender genuinely increments the workspace
// counter but changes none of this proposal's actual selected inputs.
const otherOpportunity=(await db.query("insert into public.opportunities(workspace_id,source_id,title,created_by) values($1,$2,'Unrelated original title',$3) returning id",[workspace,source,owner])).rows[0].id;
await db.query("update public.opportunities set description='Unrelated changed notice.' where id=$1",[otherOpportunity]);
const currentRevision=(await db.query('select evidence_revision from public.workspaces where id=$1',[workspace])).rows[0].evidence_revision;
assert.ok(currentRevision>inspectedRevision);
result=await run(restart);assert.equal(result.status,'started',JSON.stringify(result));
assert.equal(result.inspected_workspace_evidence_revision,inspectedRevision);assert.equal(result.current_workspace_evidence_revision,currentRevision);assert.equal(result.prospective_snapshot_preserved,true);
assert.equal(result.workflow_version,1);assert.equal(result.language,'en');assert.equal(result.original_selected_document_references_preserved,true);
const successor=result.plan_id;
assert.equal((await db.query('select status from public.generation_plans where id=$1',[selection.plan_id])).rows[0].status,'canceled');
assert.equal((await db.query('select status from public.jobs where id=$1',[job])).rows[0].status,'canceled');
assert.equal((await db.query('select state,actual_input from public.provider_usage where id=$1',[usage])).rows[0].state,'unknown');
assert.equal((await db.query('select candidates from app_private.model_graph_budgets')).rows[0].candidates,3);
assert.deepEqual((await state())['public.model_attempts'],baseState['public.model_attempts']);
assert.equal((await db.query('select operation from app_private.generation_processing_requests where plan_id=$1',[successor])).rows[0].operation,'proposal.generate');
const committed=await state();result=await run(restart);assert.equal(result.status,'already_started');assert.equal(result.plan_id,successor);assert.deepEqual(await state(),committed);
assert.doesNotMatch(JSON.stringify(result),/PRIVATE|private-receipt/);await db.close();
