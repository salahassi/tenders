import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
process.on('uncaughtException',error=>{console.error(JSON.stringify({message:error.message,code:error.code}));process.exit(1);});
let raw='';for await(const x of process.stdin)raw+=x;
const {sql,workspace}=JSON.parse(raw);const db=new PGlite();await db.waitReady;
try{
 await db.exec(`CREATE ROLE tdp_app_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;GRANT tdp_app_owner TO postgres;ALTER SCHEMA public OWNER TO tdp_app_owner;SET ROLE tdp_app_owner;
 CREATE TABLE workspaces(id uuid);INSERT INTO workspaces VALUES('${workspace}');
 CREATE TABLE opportunities(id uuid,workspace_id uuid,archived boolean,assessment_pending boolean);
 CREATE TABLE generation_plans(id uuid,workspace_id uuid,opportunity_id uuid,kind text,status text,error_code text,input_hash text,evidence_revision bigint,created_at timestamptz);
 CREATE TABLE fit_assessments(id uuid,workspace_id uuid,plan_id uuid,routing text,input_hash text,evidence_revision bigint,created_at timestamptz);
 CREATE TABLE jobs(entity_id uuid,workspace_id uuid,type text,status text,error_code text);`);
 const uid=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0');
 for(let n=1;n<=3;n++) await db.query('INSERT INTO opportunities VALUES($1,$2,$3,false)',[uid(n),workspace,n===3]);
 for(const [id,opp,status,when] of [[11,1,'canceled','2026-01-01'],[12,1,'completed','2026-01-02'],[21,2,'blocked','2026-01-02'],[31,3,'running','2026-01-03']])
  await db.query("INSERT INTO generation_plans VALUES($1,$2,$3,'assessment',$4,NULL,'exact',4,$5)",[uid(id),workspace,uid(opp),status,when]);
 for(const [id,plan,route,hash,when] of [[41,11,'recommended','exact','2026-01-01'],[42,12,'low_fit','old','2026-01-02'],[43,12,'recommended','exact','2026-01-02'],[44,12,'needs_review','exact','2026-01-03']])
  await db.query('INSERT INTO fit_assessments VALUES($1,$2,$3,$4,$5,4,$6)',[uid(id),workspace,uid(plan),route,hash,when]);
 await db.query("INSERT INTO jobs VALUES($1,$2,'classify_opportunity','blocked','MODEL_NOT_CONFIGURED')",[uid(21),workspace]);
 await db.query("INSERT INTO jobs VALUES($1,$2,'advance_plan','quota_wait','MODEL_RATE_WAIT')",[uid(21),workspace]);
 await db.query("INSERT INTO jobs VALUES($1,$2,'classify_opportunity','running',NULL)",[uid(31),workspace]);
 const result=await db.exec(sql.replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'"));
 const state=result.find(x=>x.rows.length)?.rows[0].jsonb_build_object;
 assert.equal(state.latest_total,2);assert.equal(state.current_fit_total,1);assert.equal(state.current_fit_needs_review,1);assert.equal(state.pending_jobs,1);
 assert.deepEqual(state.latest_statuses,[{status:'blocked',count:1},{status:'completed',count:1}]);
 assert.deepEqual(state.attention_jobs,[{type:'classify_opportunity',status:'blocked',error_code:'MODEL_NOT_CONFIGURED',count:1}]);
 assert.equal('opportunity_id' in state,false);
 console.log('Latest nonarchived read-only scope, current fit identity and business review counts verified.');
}finally{await db.close();}
