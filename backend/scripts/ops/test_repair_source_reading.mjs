import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
process.on('uncaughtException',error=>{console.error(JSON.stringify({message:error.message,code:error.code,where:error.where}));process.exit(1);});
let text='';for await(const x of process.stdin)text+=x;
const {fixture,sql}=JSON.parse(text);const db=new PGlite();await db.waitReady;
try {
 await db.exec(`CREATE ROLE tdp_app_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;GRANT tdp_app_owner TO postgres;ALTER SCHEMA public OWNER TO tdp_app_owner;SET ROLE tdp_app_owner;
 CREATE TABLE memberships(workspace_id uuid,user_id uuid,role text,active boolean);
 INSERT INTO memberships VALUES('${fixture.workspace_id}','00000000-0000-0000-0000-000000000001','Owner',true);
 CREATE TABLE sources(id uuid PRIMARY KEY,workspace_id uuid,adapter_config jsonb,approval text,revision integer,updated_at timestamptz,next_due timestamptz,health text,poll_interval_hours integer);
 CREATE TABLE jobs(id uuid PRIMARY KEY,workspace_id uuid,entity_id uuid,type text,status text,error_code text,cancel_requested boolean,attempts integer,next_attempt_at timestamptz,input_hash text,lease_token uuid,lease_until timestamptz,revision integer,updated_at timestamptz);
 CREATE TABLE audit_events(workspace_id uuid,actor_id uuid,action text,entity_id uuid,reason text,request_id uuid);`);
 for(let i=0;i<fixture.sources.length;i++){
  const s=fixture.sources[i];await db.query('INSERT INTO sources VALUES($1,$2,$3,$4,3,now(),NULL,$5,6)',[s.id,s.workspace_id,{...s.adapter_config,automatic:false},i===1?'approved':i===0?'rejected':'paused','unknown']);
 }
 await db.query("INSERT INTO jobs(id,workspace_id,entity_id,type,status,error_code,cancel_requested,attempts,revision) VALUES($1,$2,$3,'source_collect','blocked','MANUAL_SOURCE_REQUIRED',false,1,1)",['00000000-0000-0000-0000-000000000999',fixture.workspace_id,fixture.sources[1].id]);
 const execute=()=>db.exec(sql.replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'"));
 await execute();
 assert.deepEqual((await db.query('SELECT approval,count(*)::integer n FROM sources GROUP BY approval ORDER BY approval')).rows,[{approval:'approved',n:1},{approval:'paused',n:34},{approval:'rejected',n:1}]);
 assert.equal((await db.query('SELECT count(*)::integer n FROM sources WHERE approval<>\'approved\' AND next_due IS NOT NULL')).rows[0].n,0);
 for(const s of fixture.sources){assert.deepEqual((await db.query('SELECT adapter_config FROM sources WHERE id=$1',[s.id])).rows[0].adapter_config,s.adapter_config);}
 const job=(await db.query('SELECT status,input_hash FROM jobs')).rows[0];assert.equal(job.status,'queued');assert.equal(job.input_hash,'4');
 const audits=(await db.query('SELECT count(*)::integer n FROM audit_events')).rows[0].n;await execute();assert.equal((await db.query('SELECT count(*)::integer n FROM audit_events')).rows[0].n,audits);
 await db.query("UPDATE sources SET adapter_config=adapter_config||'{\"edited\":true}'::jsonb WHERE id=$1",[fixture.sources[35].id]);
 await assert.rejects(execute(),/REPAIR_PROFILE_CHANGED/);await db.exec('ROLLBACK');
 console.log('Reader restoration, paused-source isolation, selected recovery, replay and edit guard passed.');
}finally{await db.close();}
