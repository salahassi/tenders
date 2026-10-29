import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

// PostgreSQL errors can carry the entire operational SQL in their extra fields.
// Keep fixture failures useful without dumping that SQL or candidate contents.
process.on('uncaughtException',error=>{
 console.error(JSON.stringify({message:error.message,code:error.code}));
 process.exit(1);
});

let raw='';for await(const chunk of process.stdin)raw+=chunk;
const scripts=JSON.parse(raw);
assert.equal(typeof scripts.sql,'string');assert.equal(typeof scripts.status,'string');
const adapt=sql=>sql.replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'");
const db=new PGlite();await db.waitReady;
const workspace='64d3c4c3-0c4a-46fa-b6ce-3b1965d3c72d';
const uuid=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const owner=uuid(1),opportunity=uuid(100),original=uuid(200),current=uuid(201),job=uuid(300);
const usageIds=[uuid(400),uuid(401),uuid(402)],leaseIds=[uuid(500),uuid(501),uuid(502)];
const thread='a'.repeat(64),inputHash='b'.repeat(64);
const requestPrefix='fixture/classify_opportunity/repair-2';
const pinKey=`semantic-instructions-${createHash('sha256').update(requestPrefix).digest('hex')}`;
const reason='Owner-authorized automated provider remediation; batch=fixture-recovery';
const references=[{id:'notice1',quote:'Supply services.'}];
const candidate={
 factors:{
  capability:{rating:null,reason:'No company evidence.',notice_evidence:[],company_evidence:[]},
  scope:{rating:0,reason:'Saved keyword-based scope decision.',notice_evidence:references,company_evidence:[]},
  sector:{rating:null,reason:'No company evidence.',notice_evidence:[],company_evidence:[]},
  prerequisite:{rating:null,reason:'No company evidence.',notice_evidence:[],company_evidence:[]},
 },
 scope_decision:{status:'out_of_scope',reason:'Saved definite keyword-based decision.',
  notice_evidence:references,company_evidence:[],keyword_evidence:[{kind:'include',keyword:'services'}]},
 critical_unknown:true,reason_summary:'Retained assessment requires runtime revalidation.',
 missing_information:['Company evidence is unavailable.'],risk_flags:[],suggested_tags:[],
};
const frozen={discovery_scope_policy:{scope:'combined',include_keywords:['services'],exclude_keywords:[]},
 notice:{id:'notice1',text:'Supply services.',kind:'notice'}};
const localValidation=usageId=>({version:1,task:'repair_result',code:'EVIDENCE_REFERENCE_INVALID',
 diagnostics:[{code:'EVIDENCE_REFERENCE_INVALID',reason:'source_missing',
  paths:['$.factors.scope.notice_evidence','$.factors.scope.company_evidence']}],
 usage_id:usageId,request_prefix:requestPrefix});
const migration=name=>readFileSync(new URL(`../../supabase/migrations/${name}`,import.meta.url),'utf8');
const tableDefinition=(sql,name)=>{
 const start=sql.indexOf(`create table ${name} (`);
 assert.ok(start>=0,`missing migration table ${name}`);
 const end=sql.indexOf('\n);',start);
 assert.ok(end>start,`missing migration table terminator ${name}`);
 return sql.slice(start,end+3);
};
const graphTables=['model_graph_threads','model_graph_results','model_graph_budgets','model_graph_checkpoints','model_graph_writes']
 .map(name=>`app_private.${name}`);
const retainedTables=[...graphTables,'public.provider_usage','public.model_attempts'];
const mutableTables=['public.generation_plans','public.jobs','public.generation_steps','public.audit_events',
 'public.opportunities','public.fit_assessments','public.model_execution_settings','public.restore_sessions'];
const snapshot=async tables=>{
 const result={};
 for(const table of tables){
  const rows=await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM ${table} t`);
  result[table]=rows.rows[0].value;
 }
 return result;
};
const execute=()=>db.exec(adapt(scripts.sql));
const receipt=async sql=>{
 const results=await db.exec(adapt(sql));
 const row=results.flatMap(result=>result.rows||[]).find(row=>row.current_setting);
 assert.ok(row,'revalidation must return a receipt');
 return JSON.parse(row.current_setting);
};
const resultPut=async(key,value)=>db.query(`INSERT INTO app_private.model_graph_results
 (thread_id,result_key,value,content_hash) VALUES($1,$2,$3,encode(sha256(convert_to($3::jsonb::text,'UTF8')),'hex'))`,
 [thread,key,value]);
const setLatest=async(path,value)=>db.query(`UPDATE app_private.model_graph_results
 SET value=jsonb_set(value,$1::text[],$2::jsonb) WHERE thread_id=$3 AND result_key='candidate-2'`,
 [path,JSON.stringify(value),thread]);

try{
 await db.exec(`CREATE ROLE tdp_app_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
 CREATE ROLE tdp_app_authadmin NOLOGIN NOSUPERUSER NOBYPASSRLS;
 GRANT tdp_app_owner,tdp_app_authadmin TO postgres;
 CREATE SCHEMA auth AUTHORIZATION tdp_app_authadmin;
 CREATE SCHEMA app_private;
 SET ROLE tdp_app_authadmin;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
 INSERT INTO auth.users VALUES('${owner}',now(),NULL,NULL);
 RESET ROLE;
 CREATE TABLE public.workspaces(id uuid PRIMARY KEY);
 INSERT INTO public.workspaces VALUES('${workspace}');
 CREATE TABLE public.memberships(workspace_id uuid,user_id uuid,active boolean,role text);
 INSERT INTO public.memberships VALUES('${workspace}','${owner}',true,'Owner');
 CREATE TABLE public.identity_allowlist(workspace_id uuid,user_id uuid,status text,role text);
 INSERT INTO public.identity_allowlist VALUES('${workspace}','${owner}','active','Owner');
 CREATE FUNCTION app_private.member_role(w uuid) RETURNS text LANGUAGE sql AS $$
 SELECT m.role FROM public.memberships m JOIN public.identity_allowlist a USING(workspace_id,user_id)
 WHERE m.workspace_id=w AND m.user_id=current_setting('request.jwt.claim.sub',true)::uuid
  AND m.active AND a.status='active' $$;
 CREATE TABLE public.restore_sessions(workspace_id uuid,state text);
 CREATE TABLE public.model_execution_settings(id uuid DEFAULT gen_random_uuid(),workspace_id uuid PRIMARY KEY,enabled boolean,revision integer);
 INSERT INTO public.model_execution_settings(workspace_id,enabled,revision) VALUES('${workspace}',true,2);
 CREATE TABLE public.opportunities(id uuid PRIMARY KEY,workspace_id uuid,revision integer,archived boolean);
 CREATE TABLE public.generation_plans(id uuid PRIMARY KEY,workspace_id uuid,opportunity_id uuid,kind text,
  status text,error_code text,revision integer,created_at timestamptz,frozen_context jsonb,stage text,input_hash text);
 CREATE TABLE public.jobs(id uuid PRIMARY KEY,workspace_id uuid,entity_id uuid,type text,status text,error_code text,
  attempts integer,revision integer,cancel_requested boolean,input_hash text,checkpoint jsonb,
  lease_token uuid,lease_until timestamptz,UNIQUE(workspace_id,id));
 CREATE TABLE public.generation_steps(id uuid PRIMARY KEY,workspace_id uuid,plan_id uuid,job_id uuid,status text,stage text);
 CREATE TABLE public.fit_assessments(plan_id uuid,workspace_id uuid);
 CREATE TABLE public.audit_events(id uuid DEFAULT gen_random_uuid(),workspace_id uuid,actor_id uuid,action text,
  entity_id uuid,reason text,request_id uuid,created_at timestamptz DEFAULT now());`);
 // Use the actual usage/attempt/graph columns, including the durable graph keys,
 // constraints, checkpoints and foreign keys rather than an invented graph model.
 await db.exec(tableDefinition(migration('20261015104947_model_policy_and_budget.sql'),'public.provider_usage'));
 await db.exec(tableDefinition(migration('20261018112447_model_activity_observability.sql'),'public.model_attempts'));
 await db.exec(`ALTER TABLE public.provider_usage ADD COLUMN connection_id uuid,ADD COLUMN model_config_id uuid,
  ADD COLUMN execution_metadata jsonb;
 ALTER TABLE public.model_attempts ADD COLUMN connection_id uuid,ADD COLUMN model_config_id uuid,
  ADD COLUMN execution_metadata jsonb;`);
 const durable=migration('20261020143042_durable_model_graph.sql');
 await db.exec(durable.slice(0,durable.indexOf('do $$ declare name text;begin')));
 const bounded=migration('20261022070632_bounded_hierarchical_planning.sql');
 const budgetColumnStart=bounded.indexOf('alter table app_private.model_graph_threads add column budget_version ');
 assert.ok(budgetColumnStart>=0,'missing actual graph budget version migration');
 await db.exec(bounded.slice(budgetColumnStart,bounded.indexOf(';',budgetColumnStart)+1));
 await db.exec(`GRANT USAGE ON SCHEMA public,app_private TO tdp_app_owner;
 GRANT ALL ON ALL TABLES IN SCHEMA public,app_private TO tdp_app_owner;
 GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public,app_private TO tdp_app_owner;
 CREATE FUNCTION public.app_command(operation text,input jsonb,idempotency_key text) RETURNS jsonb LANGUAGE plpgsql AS $$
 DECLARE result jsonb;
 BEGIN
  IF app_private.member_role('${workspace}') IS DISTINCT FROM 'Owner' THEN RAISE EXCEPTION 'ROLE_FORBIDDEN';END IF;
  IF operation<>'job.action' OR input->>'action'<>'retry' THEN RAISE EXCEPTION 'UNEXPECTED_OPERATION';END IF;
  UPDATE public.jobs SET status='queued',error_code=NULL,revision=revision+1
   WHERE id=(input->>'id')::uuid AND workspace_id='${workspace}'
    AND revision=(input->>'expected_revision')::integer RETURNING to_jsonb(jobs.*) INTO result;
  IF result IS NULL THEN RAISE EXCEPTION 'REVISION_CONFLICT';END IF;
  UPDATE public.generation_plans SET status='queued',error_code=NULL,revision=revision+1
   WHERE id=(SELECT entity_id FROM public.jobs WHERE id=(input->>'id')::uuid) AND workspace_id='${workspace}';
  IF current_setting('tenderdesk.test_mutate_budget',true)='on' THEN
   UPDATE app_private.model_graph_budgets SET candidates=2 WHERE thread_id='${thread}' AND unit='writer';
  END IF;
  RETURN result;
 END $$;`);

 const seed=async()=>{
  await db.exec(`RESET ROLE;
   TRUNCATE public.audit_events,public.fit_assessments,public.generation_steps,
    app_private.model_graph_threads,app_private.model_graph_results,app_private.model_graph_budgets,
    app_private.model_graph_checkpoints,app_private.model_graph_writes,public.model_attempts,
    public.provider_usage,public.jobs,public.generation_plans,public.opportunities RESTART IDENTITY CASCADE;
   SELECT set_config('tenderdesk.test_mutate_budget','off',false);`);
  await db.query('INSERT INTO public.opportunities VALUES($1,$2,4,false)',[opportunity,workspace]);
  await db.query(`INSERT INTO public.generation_plans VALUES
   ($1,$2,$3,'assessment','canceled','NOTICE_DETAILS_REFRESHED',3,'2026-10-28T08:00:00Z',$4,'assessment',$5),
   ($6,$2,$3,'assessment','blocked','MODEL_CORRECTION_EXHAUSTED',8,'2026-10-28T08:01:00Z',$7,'assessment',$5)`,
   [original,workspace,opportunity,{original_snapshot:true},inputHash,current,frozen]);
  await db.query(`INSERT INTO public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id,created_at)
   VALUES($1,$2,'ops.model_assessment.sample',$3,$4,$5,'2026-10-28T08:00:00Z')`,
   [workspace,owner,original,reason,uuid(600)]);
  await db.query(`INSERT INTO public.jobs VALUES
   ($1,$2,$3,'classify_opportunity','blocked','MODEL_CORRECTION_EXHAUSTED',9,7,false,$4,$5,NULL,NULL)`,
   [job,workspace,current,inputHash,{model_executor:2,graph_thread:thread,
    model_routing:{round_attempts:3,provider_index:2},retained:{request_prefix:requestPrefix}}]);
  await db.query("INSERT INTO public.generation_steps VALUES($1,$2,$3,$4,'queued','assessment')",
   [uuid(700),workspace,current,job]);
  await db.query(`INSERT INTO app_private.model_graph_threads
   (id,workspace_id,job_id,input_hash,task,status,budget_version,candidate_count)
   VALUES($1,$2,$3,$4,'classify_opportunity','needs_review',2,1)`,[thread,workspace,job,inputHash]);
  await db.query("INSERT INTO app_private.model_graph_budgets VALUES($1,'writer',1),($1,'writer-repair',2)",[thread]);
  await db.query(`INSERT INTO app_private.model_graph_checkpoints
   (thread_id,checkpoint_id,checkpoint,metadata) VALUES($1,'checkpoint-3',$2,$3)`,
   [thread,{channel_values:{repairCount:2},pending_sends:[]},{step:3,source:'loop'}]);
  await db.query(`INSERT INTO app_private.model_graph_writes
   (thread_id,checkpoint_id,task_id,task_path,idx,channel,value)
   VALUES($1,'checkpoint-3','writer-2','writer',0,'candidate',$2)`,[thread,{result_key:'candidate-2'}]);
  for(let index=0;index<3;index++){
   await db.query(`INSERT INTO public.provider_usage
    (id,workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,
     reserved_input,reserved_output,actual_input,actual_output,thinking_tokens,state,created_by,
     graph_candidate_recorded,execution_metadata)
    VALUES($1,$2,$3,$4,$5,'openai','gpt-4.1-mini',$6,'2026-10-28',2,100,100,75,25,0,'settled',$7,true,$8)`,
    [usageIds[index],workspace,job,leaseIds[index],`writer-${index}`,inputHash,owner,{billing:'paid',fixture:true}]);
   await db.query(`INSERT INTO public.model_attempts
    (workspace_id,job_id,lease_token,provider,model,operation,round_number,worker_attempt,status,
     result_code,sent,usage_id,finished_at,http_status)
    VALUES($1,$2,$3,'openai','gpt-4.1-mini','repair_result',$4,9,'succeeded','MODEL_OUTPUT_RECEIVED',true,$5,now(),200)`,
    [workspace,job,leaseIds[index],index,usageIds[index]]);
   await resultPut(`candidate-${index}`,{result:{target_task:'classify_opportunity',result:candidate},
    local_validation:localValidation(usageIds[index])});
  }
  await resultPut(pinKey,{version:3,legacy_input_hash:inputHash});
 };
 const rejected=async(name,mutate,pattern)=>{
  await seed();await mutate();
  const before=await snapshot([...retainedTables,...mutableTables]);
  await assert.rejects(execute,pattern,name);
  await db.exec('ROLLBACK;RESET ROLE;');
  assert.deepEqual(await snapshot([...retainedTables,...mutableTables]),before,`${name} must roll back every write`);
 };

 for(const state of ['unknown','reserved']){
  await rejected(`${state} provider usage`,()=>db.query('UPDATE public.provider_usage SET state=$1 WHERE id=$2',
   [state,usageIds[0]]),/ASSESSMENT_REVALIDATION_USAGE_REVIEW_REQUIRED/);
 }
 await rejected('unrelated latest validation diagnostic',()=>setLatest(['local_validation','diagnostics',0,'reason'],'quote_not_found'),
  /ASSESSMENT_REVALIDATION_DIAGNOSTICS_MISMATCH/);
 await rejected('older eligible candidate cannot replace latest diagnostic',()=>setLatest(['local_validation','code'],'MODEL_OUTPUT_INVALID'),
  /ASSESSMENT_REVALIDATION_IDENTITY_MISMATCH/);
 await rejected('company-only scope cannot use this correction',()=>db.query(`UPDATE public.generation_plans
  SET frozen_context=jsonb_set(frozen_context,'{discovery_scope_policy,scope}','"company_knowledge"') WHERE id=$1`,[current]),
  /ASSESSMENT_REVALIDATION_SCOPE_POLICY_MISMATCH/);
 await rejected('missing frozen policy',()=>db.query(`UPDATE public.generation_plans
  SET frozen_context=frozen_context-'discovery_scope_policy' WHERE id=$1`,[current]),
  /ASSESSMENT_REVALIDATION_SCOPE_POLICY_MISMATCH/);
 await rejected('missing policy scope with otherwise valid keyword arrays',()=>db.query(`UPDATE public.generation_plans
  SET frozen_context=frozen_context#-'{discovery_scope_policy,scope}' WHERE id=$1`,[current]),
  /ASSESSMENT_REVALIDATION_SCOPE_POLICY_MISMATCH/);
 await rejected('missing definite scope decision status',()=>db.query(`UPDATE app_private.model_graph_results
  SET value=value#-'{result,result,scope_decision,status}' WHERE thread_id=$1 AND result_key='candidate-2'`,[thread]),
  /ASSESSMENT_REVALIDATION_SCOPE_POLICY_MISMATCH/);
 await rejected('unconfigured keyword',()=>setLatest(['result','result','scope_decision','keyword_evidence'],
  [{kind:'include',keyword:'unconfigured'}]),/ASSESSMENT_REVALIDATION_KEYWORD_NOT_CONFIGURED/);
 for(const path of [['result','result','factors','scope','notice_evidence'],['result','result','scope_decision','notice_evidence']]){
  await rejected(`missing ${path.join('.')} notice references`,()=>setLatest(path,[]),
   /ASSESSMENT_REVALIDATION_NOTICE_EVIDENCE_MISSING/);
 }
 await rejected('a newer writer forbids selection of candidate-2',()=>resultPut('candidate-3',{
  result:{target_task:'classify_opportunity',result:candidate},local_validation:localValidation(usageIds[2])}),
  /ASSESSMENT_REVALIDATION_IDENTITY_MISMATCH/);
 await rejected('older semantic policy pin',()=>db.query(`UPDATE app_private.model_graph_results
  SET value=jsonb_set(value,'{version}','2') WHERE thread_id=$1 AND result_key=$2`,[thread,pinKey]),
  /ASSESSMENT_REVALIDATION_IDENTITY_MISMATCH/);
 await rejected('legacy graph budget cannot use split-budget recovery',()=>db.query(`UPDATE app_private.model_graph_threads
  SET budget_version=1 WHERE id=$1`,[thread]),/ASSESSMENT_REVALIDATION_GRAPH_NOT_RETAINED/);
 for(const count of [0,2,3]){
  await rejected(`writer graph count ${count} differs from one`,()=>db.query(`UPDATE app_private.model_graph_threads
   SET candidate_count=$1 WHERE id=$2`,[count,thread]),/ASSESSMENT_REVALIDATION_GRAPH_NOT_RETAINED/);
 }
 for(const unit of ['writer','writer-repair']){
  await rejected(`missing ${unit} budget`,()=>db.query(`DELETE FROM app_private.model_graph_budgets
   WHERE thread_id=$1 AND unit=$2`,[thread,unit]),/ASSESSMENT_REVALIDATION_GRAPH_NOT_RETAINED/);
  for(const count of unit==='writer'?[0,2,3]:[0,1,3]){
   await rejected(`wrong ${unit} budget count ${count}`,()=>db.query(`UPDATE app_private.model_graph_budgets
    SET candidates=$1 WHERE thread_id=$2 AND unit=$3`,[count,thread,unit]),/ASSESSMENT_REVALIDATION_GRAPH_NOT_RETAINED/);
  }
 }
 await rejected('missing received writer receipt',()=>db.query(`UPDATE public.provider_usage
  SET graph_candidate_recorded=false WHERE id=$1`,[usageIds[1]]),/ASSESSMENT_REVALIDATION_WRITER_RECEIPT_MISSING/);
 await rejected('writer receipts must be distinct',()=>db.query(`UPDATE app_private.model_graph_results
  SET value=jsonb_set(value,'{local_validation,usage_id}',to_jsonb($1::text))
  WHERE thread_id=$2 AND result_key='candidate-1'`,[usageIds[0],thread]),/ASSESSMENT_REVALIDATION_WRITER_RECEIPT_MISSING/);
 await rejected('canonical command cannot change retained budget',()=>db.exec(
  "SELECT set_config('tenderdesk.test_mutate_budget','on',false)"),/ASSESSMENT_REVALIDATION_RETAINED_STATE_CHANGED/);

 await seed();
 const retainedBefore=await snapshot(retainedTables);
 const jobBefore=(await db.query('SELECT attempts,checkpoint FROM public.jobs WHERE id=$1',[job])).rows[0];
 const plansBefore=(await db.query('SELECT id,frozen_context,input_hash FROM public.generation_plans ORDER BY id')).rows;
 const status=await receipt(scripts.status);
 assert.equal(status.sample_followed_successor,true);assert.equal(status.sample_current,true);
 assert.equal(status.sample_status,'blocked');assert.equal(status.sample_error,'MODEL_CORRECTION_EXHAUSTED');
 assert.equal(status.sample_completed,false);
 const result=await receipt(scripts.sql);
 assert.equal(result.sample_revalidated,true);assert.equal(result.sample_revalidation_already_requested,false);
 assert.equal(result.sample_followed_successor,true);assert.equal(result.sample_status,'queued');
 assert.equal(result.sample_completed,false,'SQL retry must never claim runtime acceptance');
 assert.deepEqual(await snapshot(retainedTables),retainedBefore,'paid receipts and every graph table must remain exact');
 assert.deepEqual((await db.query('SELECT attempts,checkpoint FROM public.jobs WHERE id=$1',[job])).rows[0],jobBefore);
 assert.deepEqual((await db.query('SELECT id,frozen_context,input_hash FROM public.generation_plans ORDER BY id')).rows,plansBefore);
 assert.deepEqual((await db.query('SELECT status,error_code,revision FROM public.jobs WHERE id=$1',[job])).rows[0],
  {status:'queued',error_code:null,revision:8});
 assert.equal((await db.query('SELECT count(*)::integer n FROM public.fit_assessments')).rows[0].n,0);
 const first=await snapshot([...retainedTables,...mutableTables]);
 const replay=await receipt(scripts.sql);
 assert.equal(replay.sample_revalidated,false);assert.equal(replay.sample_revalidation_already_requested,true);
 assert.deepEqual(await snapshot([...retainedTables,...mutableTables]),first,'repeat revalidation must be a no-op');
 assert.equal((await db.query(`SELECT count(*)::integer n FROM public.audit_events
  WHERE action='ops.model_assessment.sample.revalidated'`)).rows[0].n,1);
 assert.equal((await db.query(`SELECT count(*)::integer n FROM public.audit_events
  WHERE action='ops.model_assessment.sample.successor'`)).rows[0].n,1);
 console.log('Retained paid candidate revalidation, defect guards, canonical retry rollback and replay passed.');
}finally{await db.close();}
