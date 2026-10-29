import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
process.on('uncaughtException',e=>{console.error(JSON.stringify({message:e.message,code:e.code,where:e.where}));process.exit(1);});
let raw='';for await(const c of process.stdin)raw+=c;
const scripts=JSON.parse(raw);const db=new PGlite();await db.waitReady;
const w='64d3c4c3-0c4a-46fa-b6ce-3b1965d3c72d';
const owner='00000000-0000-0000-0000-000000000001';
const ids=Array.from({length:4},(_,i)=>'00000000-0000-0000-0000-'+String(100+i).padStart(12,'0'));
const plans=Array.from({length:4},(_,i)=>'00000000-0000-0000-0000-'+String(200+i).padStart(12,'0'));
try{
 await db.exec(`CREATE ROLE tdp_app_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
 CREATE ROLE tdp_app_authadmin NOLOGIN NOSUPERUSER NOBYPASSRLS;
 GRANT tdp_app_owner,tdp_app_authadmin TO postgres;
 GRANT CREATE ON DATABASE postgres TO tdp_app_owner;
 ALTER SCHEMA public OWNER TO tdp_app_owner;
 CREATE SCHEMA auth AUTHORIZATION tdp_app_authadmin;
 SET ROLE tdp_app_authadmin;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
 INSERT INTO auth.users VALUES('${owner}',now(),NULL,NULL);
 RESET ROLE;SET ROLE tdp_app_owner;
 CREATE TABLE public.workspaces(id uuid PRIMARY KEY);
 INSERT INTO public.workspaces VALUES('${w}');
 CREATE TABLE public.memberships(workspace_id uuid,user_id uuid,active boolean,role text);
 INSERT INTO public.memberships VALUES('${w}','${owner}',true,'Owner');
 CREATE TABLE public.identity_allowlist(workspace_id uuid,user_id uuid,status text,role text);
 INSERT INTO public.identity_allowlist VALUES('${w}','${owner}','active','Owner');
 CREATE SCHEMA app_private AUTHORIZATION tdp_app_owner;
 CREATE FUNCTION app_private.member_role(w uuid) RETURNS text LANGUAGE sql AS $$SELECT m.role FROM public.memberships m JOIN public.identity_allowlist a USING(workspace_id,user_id) WHERE m.workspace_id=w AND m.user_id=current_setting('request.jwt.claim.sub',true)::uuid AND m.active AND a.status='active'$$;
 CREATE TABLE public.restore_sessions(workspace_id uuid,state text);
 CREATE TABLE public.model_execution_settings(id uuid DEFAULT gen_random_uuid(),workspace_id uuid PRIMARY KEY,enabled boolean,revision integer);
 INSERT INTO public.model_execution_settings(workspace_id,enabled,revision) VALUES('${w}',false,2);
 CREATE TABLE public.model_task_routes(workspace_id uuid,task text,model_ids uuid[]);
 CREATE TABLE public.model_configurations(id uuid PRIMARY KEY,connection_id uuid,enabled boolean);
 CREATE TABLE public.model_connections(id uuid PRIMARY KEY,enabled boolean,credential_alias text);
 INSERT INTO public.model_connections VALUES('00000000-0000-0000-0000-000000000050',true,'APP_MODEL_OPENAI_KEY');
 INSERT INTO public.model_configurations VALUES('00000000-0000-0000-0000-000000000051','00000000-0000-0000-0000-000000000050',true);
 INSERT INTO public.model_task_routes VALUES('${w}','default',ARRAY['00000000-0000-0000-0000-000000000051'::uuid]);
 CREATE TABLE public.opportunities(id uuid PRIMARY KEY,workspace_id uuid,revision integer,archived boolean,allowed boolean);
 CREATE TABLE public.generation_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid,opportunity_id uuid,kind text,status text,error_code text,revision integer,created_at timestamptz DEFAULT now(),frozen_context jsonb,stage text DEFAULT 'assessment',input_hash text DEFAULT 'fixture-input');
 CREATE TABLE public.jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),entity_id uuid,status text,error_code text,attempts integer DEFAULT 0,workspace_id uuid DEFAULT '${w}',revision integer DEFAULT 1,cancel_requested boolean DEFAULT false,input_hash text DEFAULT 'fixture-input');
 CREATE TABLE public.generation_steps(workspace_id uuid,plan_id uuid,job_id uuid,status text,stage text);
 CREATE TABLE public.model_attempts(job_id uuid,provider text,status text,result_code text,sent boolean,http_status integer);
 CREATE TABLE public.provider_usage(job_id uuid);
 CREATE TABLE public.fit_assessments(plan_id uuid,workspace_id uuid);
 CREATE TABLE public.audit_events(id uuid DEFAULT gen_random_uuid(),workspace_id uuid,actor_id uuid,action text,entity_id uuid,reason text,request_id uuid,created_at timestamptz DEFAULT now());
 CREATE FUNCTION public.app_command(operation text,input jsonb,idempotency_key text) RETURNS jsonb LANGUAGE plpgsql AS $$
 DECLARE target uuid; queued_job uuid; result jsonb;
 BEGIN
 IF app_private.member_role('${w}') IS DISTINCT FROM 'Owner' THEN RAISE EXCEPTION 'ROLE_FORBIDDEN';END IF;
 IF operation='model.execution.configure' THEN
  UPDATE public.model_execution_settings SET enabled=(input->>'enabled')::boolean,revision=revision+1 WHERE workspace_id='${w}' AND revision=(input->>'expected_revision')::int RETURNING to_jsonb(model_execution_settings.*) INTO result;
 ELSIF operation='generation.cancel' THEN
  UPDATE public.generation_plans SET status='canceled',revision=generation_plans.revision+1 WHERE id=(input->>'id')::uuid AND generation_plans.revision=(input->>'expected_revision')::int RETURNING to_jsonb(generation_plans.*) INTO result;
  UPDATE public.jobs SET status='canceled' WHERE entity_id=(input->>'id')::uuid;
 ELSIF operation='opportunity.assess' THEN
  IF NOT EXISTS(SELECT 1 FROM public.opportunities WHERE id=(input->>'id')::uuid AND allowed) THEN RAISE EXCEPTION 'DATA_AUTHORIZATION_REQUIRED'; END IF;
  INSERT INTO public.generation_plans(workspace_id,opportunity_id,kind,status,revision,frozen_context) VALUES('${w}',(input->>'id')::uuid,'assessment','queued',1,'{"fresh_snapshot":true}') RETURNING id INTO target;
  INSERT INTO public.jobs(entity_id,status) VALUES(target,'queued') RETURNING id INTO queued_job;
  INSERT INTO public.generation_steps VALUES('${w}',target,queued_job,'queued','assessment');result:=jsonb_build_object('id',target);
 ELSIF operation='job.action' THEN
  UPDATE public.jobs SET status='queued',error_code=NULL,revision=revision+1 WHERE id=(input->>'id')::uuid AND revision=(input->>'expected_revision')::integer RETURNING to_jsonb(jobs.*) INTO result;
  UPDATE public.generation_plans SET status='queued',error_code=NULL,revision=revision+1 WHERE id=(SELECT entity_id FROM public.jobs WHERE id=(input->>'id')::uuid);
 ELSE RAISE EXCEPTION 'UNEXPECTED_OPERATION';END IF;
 IF result IS NULL THEN RAISE EXCEPTION 'REVISION_CONFLICT';END IF;
 RETURN result;
 END $$;
 RESET ROLE;`);
 for(let i=0;i<4;i++){
  await db.query('INSERT INTO public.opportunities VALUES($1,$2,1,false,true)',[ids[i],w]);
  await db.query("INSERT INTO public.generation_plans(id,workspace_id,opportunity_id,kind,status,error_code,revision,created_at,frozen_context) VALUES($1,$2,$3,'assessment','blocked','MODEL_NOT_CONFIGURED',2,now()-interval '1 hour',$4)",[plans[i],w,ids[i],{retained:'original'}]);
  const j=(await db.query("INSERT INTO public.jobs(entity_id,status,error_code) VALUES($1,'blocked','MODEL_NOT_CONFIGURED') RETURNING id",[plans[i]])).rows[0].id;
  await db.query("INSERT INTO public.model_attempts VALUES($1,'openai','skipped','MODEL_NOT_CONFIGURED',$2,NULL)",[j,i===1]);
  if(i===2)await db.query('INSERT INTO public.provider_usage VALUES($1)',[j]);
 }
 const execute=action=>db.exec(scripts[action].replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'"));
 const receipt=async action=>{
  const results=await execute(action);
  const row=results.flatMap(r=>r.rows||[]).find(r=>r.current_setting);
  assert.ok(row,'recovery receipt must be returned');return JSON.parse(row.current_setting);
 };
 const state=async()=> (await db.query('SELECT enabled,revision FROM public.model_execution_settings')).rows[0];
 await assert.rejects(execute('retry-sample'),/ASSESSMENT_SAMPLE_RETRY_NOT_CURRENT/);await db.exec('ROLLBACK');
 // Canonical permission failure rolls back the preceding enable and cancel.
 await db.query('UPDATE public.opportunities SET allowed=false WHERE id=$1',[ids[0]]);
 await assert.rejects(execute('sample'),/DATA_AUTHORIZATION_REQUIRED/);await db.exec('ROLLBACK');
 assert.deepEqual(await state(),{enabled:false,revision:2});
 assert.equal((await db.query('SELECT status FROM public.generation_plans WHERE id=$1',[plans[0]])).rows[0].status,'blocked');
 await db.query('UPDATE public.opportunities SET allowed=true WHERE id=$1',[ids[0]]);
 await execute('sample');
 const marker=(await db.query("SELECT entity_id FROM public.audit_events WHERE action='ops.model_assessment.sample'")).rows[0].entity_id;
 assert.equal((await db.query('SELECT count(*)::int n FROM public.generation_plans')).rows[0].n,5);
 assert.equal((await db.query('SELECT status,frozen_context FROM public.generation_plans WHERE id=$1',[plans[0]])).rows[0].status,'canceled');
 assert.deepEqual((await db.query('SELECT frozen_context FROM public.generation_plans WHERE id=$1',[plans[0]])).rows[0].frozen_context,{retained:'original'});
 await execute('sample');assert.equal((await db.query('SELECT count(*)::int n FROM public.generation_plans')).rows[0].n,5);
 await assert.rejects(execute('remaining'),/ASSESSMENT_SAMPLE_NOT_COMPLETED/);await db.exec('ROLLBACK');
 await db.query("UPDATE public.generation_plans SET status='completed' WHERE id=$1",[marker]);
 await assert.rejects(execute('remaining'),/ASSESSMENT_SAMPLE_NOT_COMPLETED/);await db.exec('ROLLBACK');
 await db.query('INSERT INTO public.fit_assessments VALUES($1,$2)',[marker,w]);
 await execute('remaining');
 assert.equal((await db.query('SELECT count(*)::int n FROM public.generation_plans')).rows[0].n,6);
 for(const p of [plans[1],plans[2]])assert.equal((await db.query('SELECT status FROM public.generation_plans WHERE id=$1',[p])).rows[0].status,'blocked');
 // Existing success marker never re-enables a switch subsequently disabled by Owner.
 await db.exec('UPDATE public.model_execution_settings SET enabled=false');
 await assert.rejects(execute('sample'),/ASSESSMENT_EXECUTION_DISABLED/);await db.exec('ROLLBACK');
 assert.equal((await state()).enabled,false);
 await execute('status');
 // A notice refresh creates a new immutable assessment. Follow only the
 // current same-opportunity successor, retaining the original marker/results.
 await db.exec('UPDATE public.model_execution_settings SET enabled=true');
 await db.query("UPDATE public.generation_plans SET status='canceled',error_code='NOTICE_DETAILS_REFRESHED' WHERE id=$1",[marker]);
 const successor='00000000-0000-0000-0000-000000000900';
 await db.query("INSERT INTO public.generation_plans(id,workspace_id,opportunity_id,kind,status,revision,created_at,frozen_context) SELECT $1,workspace_id,opportunity_id,'assessment','queued',1,created_at+interval '1 minute',$2 FROM public.generation_plans WHERE id=$3",[successor,{canonical_successor:true},marker]);
 const planCount=(await db.query('SELECT count(*)::int n FROM public.generation_plans')).rows[0].n;
 const frozen=(await db.query('SELECT frozen_context FROM public.generation_plans WHERE id=$1',[successor])).rows[0].frozen_context;
 let status=await receipt('status');
 assert.equal(status.sample_followed_successor,true);assert.equal(status.sample_current,true);
 assert.equal(status.sample_status,'queued');assert.equal(status.sample_completed,false);
 await receipt('status');
 assert.equal((await db.query("SELECT count(*)::int n FROM public.audit_events WHERE action='ops.model_assessment.sample.successor'")).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int n FROM public.generation_plans')).rows[0].n,planCount);
 assert.deepEqual((await db.query('SELECT frozen_context FROM public.generation_plans WHERE id=$1',[successor])).rows[0].frozen_context,frozen);
 // The known runtime failure can be retried once, only on this current sample,
 // with no previous send/usage anywhere in its plan and a queued current step.
 const retryJob='00000000-0000-0000-0000-000000000910';
 await db.query("UPDATE public.generation_plans SET status='blocked',error_code='GENERATION_HANDLER_FAILED' WHERE id=$1",[successor]);
 await db.query("INSERT INTO public.jobs(id,entity_id,status,error_code,attempts,revision) VALUES($1,$2,'blocked','GENERATION_HANDLER_FAILED',7,3)",[retryJob,successor]);
 await db.query("INSERT INTO public.generation_steps VALUES($1,$2,$3,'queued','assessment')",[w,successor,retryJob]);
 await db.query('INSERT INTO public.provider_usage VALUES($1)',[retryJob]);
 await assert.rejects(execute('retry-sample'),/ASSESSMENT_SAMPLE_RETRY_PRIOR_SEND_OR_USAGE/);await db.exec('ROLLBACK');
 await db.query('DELETE FROM public.provider_usage WHERE job_id=$1',[retryJob]);
 await db.query("INSERT INTO public.model_attempts VALUES($1,'openai','failed','MODEL_NETWORK_UNCERTAIN',true,NULL)",[retryJob]);
 await assert.rejects(execute('retry-sample'),/ASSESSMENT_SAMPLE_RETRY_PRIOR_SEND_OR_USAGE/);await db.exec('ROLLBACK');
 await db.query('DELETE FROM public.model_attempts WHERE job_id=$1',[retryJob]);
 await db.query("UPDATE public.generation_steps SET status='completed' WHERE job_id=$1",[retryJob]);
 await assert.rejects(execute('retry-sample'),/query returned no rows/);await db.exec('ROLLBACK');
 await db.query("UPDATE public.generation_steps SET status='queued' WHERE job_id=$1",[retryJob]);
 status=await receipt('retry-sample');assert.equal(status.sample_retried,true);assert.equal(status.sample_status,'queued');
 const retriedJob=(await db.query('SELECT status,attempts,revision FROM public.jobs WHERE id=$1',[retryJob])).rows[0];
 assert.deepEqual(retriedJob,{status:'queued',attempts:7,revision:4});
 status=await receipt('retry-sample');assert.equal(status.sample_retry_already_requested,true);assert.equal(status.sample_retried,false);
 assert.deepEqual((await db.query('SELECT status,attempts,revision FROM public.jobs WHERE id=$1',[retryJob])).rows[0],retriedJob);
 assert.equal((await db.query("SELECT count(*)::int n FROM public.audit_events WHERE action='ops.model_assessment.sample.retried'")).rows[0].n,1);
 assert.deepEqual((await db.query('SELECT frozen_context FROM public.generation_plans WHERE id=$1',[successor])).rows[0].frozen_context,frozen);
 assert.equal((await db.query('SELECT count(*)::int n FROM public.generation_plans')).rows[0].n,planCount);
 await db.query("UPDATE public.generation_plans SET status='completed' WHERE id=$1",[successor]);
 assert.equal((await receipt('status')).sample_completed,false);
 await db.query('INSERT INTO public.fit_assessments VALUES($1,$2)',[successor,w]);
 assert.equal((await receipt('status')).sample_completed,true);
 // A newer pending assessment invalidates acceptance of an older completed fit.
 const newer='00000000-0000-0000-0000-000000000901';
 await db.query("INSERT INTO public.generation_plans(id,workspace_id,opportunity_id,kind,status,revision,created_at) SELECT $1,workspace_id,opportunity_id,'assessment','queued',1,created_at+interval '1 minute' FROM public.generation_plans WHERE id=$2",[newer,successor]);
 status=await receipt('status');assert.equal(status.sample_status,'queued');assert.equal(status.sample_completed,false);
 // Different opportunities/workspaces, even completed with fit rows, cannot
 // satisfy this sample or forge a successor through an unrelated audit marker.
 const wrongOpp='00000000-0000-0000-0000-000000000902';
 const wrongWorkspace='00000000-0000-0000-0000-000000000903';
 await db.query("INSERT INTO public.generation_plans(id,workspace_id,opportunity_id,kind,status,revision,created_at) SELECT $1,workspace_id,$2,'assessment','completed',1,created_at+interval '3 minutes' FROM public.generation_plans WHERE id=$3",[wrongOpp,ids[1],newer]);
 await db.query("INSERT INTO public.generation_plans(id,workspace_id,opportunity_id,kind,status,revision,created_at) SELECT $1,'00000000-0000-0000-0000-000000009999',opportunity_id,'assessment','completed',1,created_at+interval '3 minutes' FROM public.generation_plans WHERE id=$2",[wrongWorkspace,newer]);
 await db.query('INSERT INTO public.fit_assessments VALUES($1,$2),($3,$4)',[wrongOpp,w,wrongWorkspace,'00000000-0000-0000-0000-000000009999']);
 await db.query("INSERT INTO public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id) VALUES($1,$2,'ops.model_assessment.sample.successor',$3,'Owner-authorized automated provider remediation; batch=fixture-recovery',gen_random_uuid())",[w,owner,wrongOpp]);
 status=await receipt('status');assert.equal(status.sample_status,'queued');assert.equal(status.sample_completed,false);
 // Never follow a canceled plan for other errors or a later user cancellation.
 await db.query("UPDATE public.generation_plans SET status='canceled',error_code='OWNER_CANCELED' WHERE id=$1",[newer]);
 status=await receipt('status');assert.equal(status.sample_followed_successor,false);assert.equal(status.sample_current,false);assert.equal(status.sample_completed,false);assert.equal(status.sample_waiting_successor,false);
 await db.query("UPDATE public.generation_plans SET error_code='NOTICE_DETAILS_REFRESHED' WHERE id=$1",[newer]);
 status=await receipt('status');assert.equal(status.sample_waiting_successor,true);assert.equal(status.sample_completed,false);
 await db.query("UPDATE public.generation_plans SET status='completed',error_code=NULL WHERE id=$1",[newer]);
 await db.query('INSERT INTO public.fit_assessments VALUES($1,$2)',[newer,w]);
 await db.query("UPDATE public.generation_plans SET error_code='OWNER_CANCELED' WHERE id=$1",[marker]);
 status=await receipt('status');assert.equal(status.sample_followed_successor,false);assert.equal(status.sample_current,false);assert.equal(status.sample_completed,false);
 // An original completed sample may not be silently switched to an unrelated
 // later assessment; it must report superseded rather than accept stale fit.
 await db.query("UPDATE public.generation_plans SET status='completed',error_code=NULL WHERE id=$1",[marker]);
 status=await receipt('status');assert.equal(status.sample_followed_successor,false);assert.equal(status.sample_current,false);assert.equal(status.sample_completed,false);assert.equal(status.sample_error,'ASSESSMENT_SAMPLE_SUPERSEDED');
 await db.query('UPDATE public.opportunities SET archived=true WHERE id=$1',[ids[0]]);
 await db.query("UPDATE public.generation_plans SET status='canceled',error_code='NOTICE_DETAILS_REFRESHED' WHERE id=$1",[marker]);
 status=await receipt('status');assert.equal(status.sample_current,false);assert.equal(status.sample_completed,false);
 console.log('Canonical recovery, permission guards, current notice-successor observation and stale/unrelated-result exclusion passed.');
}finally{await db.close();}
