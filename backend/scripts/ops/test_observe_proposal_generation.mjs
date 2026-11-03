import assert from 'node:assert/strict';
import {databaseWithMigrations} from '../../tests/backend/databaseFixture.ts';

process.on('uncaughtException',error=>{console.error(JSON.stringify({message:error.message,code:error.code}));process.exit(1);});
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const {sql:sourceSql,selection}=JSON.parse(raw);
const db=await databaseWithMigrations();
const owner='00000000-0000-4000-8000-000000000001';
await db.query("insert into auth.users values($1,'fixture@example.test',now())",[owner]);
await db.query("insert into auth.identities values($1,'email',$2::jsonb)",[owner,JSON.stringify({sub:owner})]);
const workspace=(await db.query("select public.bootstrap_workspace($1,'Synthetic proposal observer') id",[owner])).rows[0].id;
const source=(await db.query("insert into public.sources(workspace_id,name,kind,created_by) values($1,'Synthetic source','manual',$2) returning id",[workspace,owner])).rows[0].id;
await db.query("insert into public.opportunities(id,workspace_id,source_id,title,created_by) values($1,$2,$3,'PRIVATE BUYER',$4)",[selection.opportunity_id,workspace,source,owner]);
const proposal=(await db.query("insert into public.proposals(workspace_id,opportunity_id,title,created_by) values($1,$2,'PRIVATE PROPOSAL',$3) returning id",[workspace,selection.opportunity_id,owner])).rows[0].id;
await db.query(`insert into public.generation_plans(id,workspace_id,opportunity_id,proposal_id,kind,status,evidence_revision,input_hash,frozen_context,created_by)
 values($1,$2,$3,$4,'proposal','queued',1,repeat('a',64),'{"private":"PRIVATE SOURCE TEXT"}',$5)`,[selection.plan_id,workspace,selection.opportunity_id,proposal,owner]);
const job=(await db.query(`insert into public.jobs(workspace_id,type,entity_id,status,input_hash,created_by)
 values($1,'analyze_chunk',$2,'queued',repeat('a',64),$3) returning id`,[workspace,selection.plan_id,owner])).rows[0].id;
// An unrelated historical job must not affect the exact selected plan.
await db.query(`insert into public.jobs(workspace_id,type,entity_id,status,input_hash,error_code,created_by)
 values($1,'analyze_chunk',gen_random_uuid(),'blocked',repeat('b',64),'PRIVATE_OTHER_PLAN',$2)`,[workspace,owner]);
const sql=sourceSql.replaceAll(selection.workspace_id,workspace).replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'").replace('SET LOCAL ROLE tdp_app_owner','SET LOCAL ROLE postgres');
const read=async()=>{
 const results=await db.exec(sql);
 return results.flatMap(r=>r.rows||[]).find(r=>r.jsonb_build_object)?.jsonb_build_object;
};
const state=async()=>{
 const result={};
 for(const table of ['public.generation_plans','public.jobs','public.provider_usage','public.proposal_versions','public.content_authorizations','app_private.model_graph_budgets'])
  result[table]=(await db.query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)).rows;
 return result;
};
let before=await state();
let report=await read();
assert.equal(report.plan_status,'queued');assert.equal(report.jobs_total,1);assert.equal(report.pending_jobs,1);
assert.equal(report.version_count,0);assert.equal(report.current_version,false);
assert.deepEqual(report.job_counts,[{status:'queued',count:1}]);assert.deepEqual(report.job_errors,[]);
assert.doesNotMatch(JSON.stringify(report),/PRIVATE|plan_id|workspace_id|opportunity_id|input_hash/);
assert.deepEqual(await state(),before);
await db.query("update public.generation_plans set status='blocked',error_code='MODEL_CORRECTION_EXHAUSTED' where id=$1",[selection.plan_id]);
await db.query("update public.jobs set status='blocked',error_code='MODEL_CORRECTION_EXHAUSTED' where id=$1",[job]);
await db.query(`insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,state,created_by)
 values($1,$2,gen_random_uuid(),'synthetic','qwencloud','synthetic',repeat('a',64),current_date,1,100,100,'reserved',$3)`,[workspace,job,owner]);
before=await state();report=await read();
assert.equal(report.pending_jobs,0);assert.equal(report.active_requests,1);assert.equal(report.plan_status,'blocked');
assert.deepEqual(report.job_errors,[{error_code:'MODEL_CORRECTION_EXHAUSTED',count:1}]);
assert.deepEqual(await state(),before);
await db.query("update public.provider_usage set state='unknown' where job_id=$1",[job]);
await db.query("update public.jobs set status='succeeded',error_code=null where id=$1",[job]);
await db.query("update public.generation_plans set status='completed',stage='completed',error_code=null where id=$1",[selection.plan_id]);
const version=(await db.query(`insert into public.proposal_versions(workspace_id,proposal_id,ordinal,content_hash,plan_id,created_by)
 values($1,$2,1,repeat('c',64),$3,$4) returning id`,[workspace,proposal,selection.plan_id,owner])).rows[0].id;
before=await state();report=await read();
assert.equal(report.version_count,1);assert.equal(report.current_version,false);assert.equal(report.active_requests,0);
assert.deepEqual(await state(),before);
await db.query("update public.proposals set active_version_id=$1 where id=$2",[version,proposal]);
before=await state();report=await read();
assert.equal(report.current_version,true);assert.equal(report.plan_status,'completed');assert.deepEqual(await state(),before);
for(const changed of [sql.replace(selection.plan_id,'00000000-0000-4000-8000-000000000999'),
 sql.replace(selection.opportunity_id,'00000000-0000-4000-8000-000000000999'),
 sql.replace("current_database()<>'postgres'","current_database()<>'wrong'")]) {
 await assert.rejects(db.exec(changed),/PROPOSAL_OBSERVER_TARGET_MISMATCH/);await db.exec('rollback');
}
assert.deepEqual(await state(),before);await db.close();
