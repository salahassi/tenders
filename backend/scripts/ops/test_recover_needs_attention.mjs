import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
process.on('uncaughtException',e=>{console.error(JSON.stringify({message:e.message,code:e.code,where:e.where}));process.exit(1);});
let input='';for await(const c of process.stdin)input+=c;
const scripts=JSON.parse(input);const db=new PGlite();await db.waitReady;
const w='64d3c4c3-0c4a-46fa-b6ce-3b1965d3c72d';
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
const owner=id(1),sample=id(10);
try{
 await db.exec(`CREATE ROLE tdp_app_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;CREATE ROLE tdp_app_authadmin NOLOGIN NOSUPERUSER NOBYPASSRLS;
 GRANT tdp_app_owner,tdp_app_authadmin TO postgres;GRANT CREATE ON DATABASE postgres TO tdp_app_owner;ALTER SCHEMA public OWNER TO tdp_app_owner;CREATE SCHEMA auth AUTHORIZATION tdp_app_authadmin;
 SET ROLE tdp_app_authadmin;CREATE TABLE auth.users(id uuid PRIMARY KEY,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
 INSERT INTO auth.users VALUES('${owner}',now(),NULL,NULL);RESET ROLE;SET ROLE tdp_app_owner;
 CREATE SCHEMA app_private AUTHORIZATION tdp_app_owner;
 CREATE TABLE workspaces(id uuid PRIMARY KEY,evidence_revision integer);INSERT INTO workspaces VALUES('${w}',1);
 CREATE TABLE memberships(workspace_id uuid,user_id uuid,active boolean,role text);INSERT INTO memberships VALUES('${w}','${owner}',true,'Owner');
 CREATE TABLE identity_allowlist(workspace_id uuid,user_id uuid,status text,role text);INSERT INTO identity_allowlist VALUES('${w}','${owner}','active','Owner');
 CREATE FUNCTION app_private.member_role(w uuid) RETURNS text LANGUAGE sql AS $$SELECT m.role FROM memberships m JOIN identity_allowlist a USING(workspace_id,user_id) WHERE m.workspace_id=w AND m.user_id=current_setting('request.jwt.claim.sub',true)::uuid AND m.active AND a.status='active'$$;
 CREATE TABLE restore_sessions(workspace_id uuid,state text);CREATE TABLE model_execution_settings(workspace_id uuid,enabled boolean);INSERT INTO model_execution_settings VALUES('${w}',true);
 CREATE TABLE generation_plans(id uuid PRIMARY KEY,workspace_id uuid,opportunity_id uuid,kind text,status text,stage text,evidence_revision integer,input_hash text,created_at timestamptz DEFAULT now());
 CREATE TABLE jobs(id uuid PRIMARY KEY,workspace_id uuid,entity_id uuid,type text,status text,error_code text,cancel_requested boolean DEFAULT false,revision integer DEFAULT 1,updated_at timestamptz DEFAULT now(),input_hash text,checkpoint jsonb DEFAULT '{"retained":true}');
 CREATE TABLE generation_steps(workspace_id uuid,job_id uuid,plan_id uuid,status text,stage text);
 CREATE TABLE sources(id uuid PRIMARY KEY,workspace_id uuid,approval text,kind text,adapter_required boolean);
 CREATE TABLE model_attempts(workspace_id uuid,job_id uuid,sent boolean);CREATE TABLE provider_usage(workspace_id uuid,job_id uuid,state text);
 CREATE TABLE fit_assessments(plan_id uuid,workspace_id uuid);
 CREATE TABLE audit_events(id uuid DEFAULT gen_random_uuid(),workspace_id uuid,actor_id uuid,action text,entity_id uuid,reason text,request_id uuid);
 CREATE FUNCTION public.app_command(operation text,payload jsonb,idempotency_key text) RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE result jsonb;BEGIN
 IF app_private.member_role('${w}') IS DISTINCT FROM 'Owner' THEN RAISE EXCEPTION 'ROLE_FORBIDDEN';END IF;
 IF operation<>'job.action' OR payload->>'action'<>'retry' THEN RAISE EXCEPTION 'UNEXPECTED_COMMAND';END IF;
 IF payload->>'id'='${id(108)}' THEN RAISE EXCEPTION 'DATA_AUTHORIZATION_REQUIRED';END IF;
 UPDATE jobs SET status='queued',error_code=NULL,revision=revision+1 WHERE id=(payload->>'id')::uuid AND revision=(payload->>'expected_revision')::int RETURNING to_jsonb(jobs.*) INTO result;
 IF result IS NULL THEN RAISE EXCEPTION 'REVISION_CONFLICT';END IF;RETURN result;END$$;
 INSERT INTO generation_plans VALUES('${sample}','${w}','${id(20)}','assessment','completed','assessment',1,'sample',now()-interval '1 day');
 INSERT INTO audit_events(workspace_id,actor_id,action,entity_id,reason) VALUES('${w}','${owner}','ops.model_assessment.sample','${sample}','Owner-authorized automated provider remediation; batch=fixture-attention');
 RESET ROLE;`);
 const execute=a=>db.exec(scripts[a].replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'"));
 await assert.rejects(execute('recover'),/ATTENTION_SAMPLE_NOT_COMPLETED/);await db.exec('ROLLBACK');
 await db.query('INSERT INTO fit_assessments VALUES($1,$2)',[sample,w]);
 // Nine operational failures: only one generation and one approved-source technical failure can retry.
 for(let i=0;i<9;i++){
  const plan=id(200+i),job=id(100+i),source=id(300+i);
  let type='classify_opportunity',error=['GENERATION_HANDLER_FAILED','MODEL_CORRECTION_EXHAUSTED','GENERATION_HANDLER_FAILED','MODEL_NOT_CONFIGURED','GENERATION_HANDLER_FAILED','SOURCE_TIMEOUT','SOURCE_TIMEOUT','MANUAL_SOURCE_REQUIRED','GENERATION_HANDLER_FAILED'][i];
  if([5,6,7].includes(i)){
   type='source_collect';await db.query('INSERT INTO sources VALUES($1,$2,$3,$4,false)',[source,w,i===6?'paused':'approved','link_directory']);
  }else{
   await db.query("INSERT INTO generation_plans VALUES($1,$2,$3,'assessment','blocked','assessment',1,$4,now()-interval '1 hour')",[plan,w,id(400+i),'input-'+i]);
   await db.query("INSERT INTO generation_steps VALUES($1,$2,$3,'queued','assessment')",[w,job,plan]);
  }
  await db.query('INSERT INTO jobs(id,workspace_id,entity_id,type,status,error_code,input_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[job,w,[5,6,7].includes(i)?source:plan,type,'blocked',error,'input-'+i]);
  if(i===2)await db.query("INSERT INTO provider_usage VALUES($1,$2,'unknown')",[w,job]);
  if(i===4)await db.query('INSERT INTO model_attempts VALUES($1,$2,true)',[w,job]);
 }
 await execute('inspect');
 assert.equal((await db.query("SELECT count(*)::int n FROM jobs WHERE status='queued'")).rows[0].n,0);
 await execute('recover');
 const retried=(await db.query("SELECT id FROM jobs WHERE status='queued' ORDER BY id")).rows.map(x=>x.id);
 assert.deepEqual(retried,[id(100),id(105)]);
 assert.deepEqual((await db.query('SELECT checkpoint FROM jobs WHERE id=$1',[id(100)])).rows[0].checkpoint,{retained:true});
 assert.equal((await db.query('SELECT state FROM provider_usage')).rows[0].state,'unknown');
 assert.equal((await db.query('SELECT sent FROM model_attempts')).rows[0].sent,true);
 const count=(await db.query('SELECT count(*)::int n FROM audit_events')).rows[0].n;
 // Same batch can never automatically replay a failed retry a second time.
 await db.query("UPDATE jobs SET status='blocked',error_code='GENERATION_HANDLER_FAILED' WHERE id=$1",[id(100)]);
 await execute('recover');
 assert.equal((await db.query('SELECT status FROM jobs WHERE id=$1',[id(100)])).rows[0].status,'blocked');
 assert.equal((await db.query('SELECT count(*)::int n FROM audit_events')).rows[0].n,count);
 await db.exec('UPDATE model_execution_settings SET enabled=false');
 await assert.rejects(execute('recover'),/ATTENTION_EXECUTION_DISABLED/);await db.exec('ROLLBACK');
 console.log('Attention sample gate, canonical retry, dependency/usage preservation and replay guard passed.');
}finally{await db.close();}
