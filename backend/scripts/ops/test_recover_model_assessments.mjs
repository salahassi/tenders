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
 CREATE TABLE public.generation_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid,opportunity_id uuid,kind text,status text,error_code text,revision integer,created_at timestamptz DEFAULT now(),frozen_context jsonb);
 CREATE TABLE public.jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),entity_id uuid,status text,error_code text,attempts integer DEFAULT 0);
 CREATE TABLE public.model_attempts(job_id uuid,provider text,status text,result_code text,sent boolean,http_status integer);
 CREATE TABLE public.provider_usage(job_id uuid);
 CREATE TABLE public.fit_assessments(plan_id uuid,workspace_id uuid);
 CREATE TABLE public.audit_events(id uuid DEFAULT gen_random_uuid(),workspace_id uuid,actor_id uuid,action text,entity_id uuid,reason text,request_id uuid,created_at timestamptz DEFAULT now());
 CREATE FUNCTION public.app_command(operation text,input jsonb,idempotency_key text) RETURNS jsonb LANGUAGE plpgsql AS $$
 DECLARE target uuid; result jsonb;
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
  INSERT INTO public.jobs(entity_id,status) VALUES(target,'queued');result:=jsonb_build_object('id',target);
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
 const state=async()=> (await db.query('SELECT enabled,revision FROM public.model_execution_settings')).rows[0];
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
 console.log('Canonical delegation, no-send guards, rollback, fresh snapshots, sample gating and Owner-off preservation passed.');
}finally{await db.close();}
