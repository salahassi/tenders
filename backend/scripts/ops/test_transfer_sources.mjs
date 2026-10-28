import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const {scripts,fixture}=JSON.parse(raw);
const db=new PGlite();
await db.waitReady;
try {
 await db.exec(`CREATE ROLE tdp_app_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
  GRANT tdp_app_owner TO postgres;
  ALTER SCHEMA public OWNER TO tdp_app_owner;
  SET ROLE tdp_app_owner;
  CREATE TABLE workspaces(id uuid PRIMARY KEY);
  CREATE TABLE memberships(workspace_id uuid,user_id uuid,role text,active boolean);
  CREATE TABLE workspace_actors(workspace_id uuid,id uuid,kind text,PRIMARY KEY(workspace_id,id));
  CREATE TABLE sources(id uuid PRIMARY KEY,workspace_id uuid REFERENCES workspaces,name text,kind text,url text,
   approved_hosts text[],approval text,health text,poll_interval_hours integer,next_due timestamptz,last_success_at timestamptz,
   policy_note text,adapter_config jsonb,created_by uuid,created_at timestamptz,updated_at timestamptz,revision integer,
   tags text[],etag text,last_modified text,policy_checked_at timestamptz,adapter_required boolean,
   FOREIGN KEY(workspace_id,created_by) REFERENCES workspace_actors(workspace_id,id));
  ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
  CREATE TABLE audit_events(id uuid DEFAULT gen_random_uuid(),workspace_id uuid,actor_id uuid,action text,entity_id uuid,reason text,request_id uuid);
  INSERT INTO workspaces VALUES('${fixture.workspace_id}');
  INSERT INTO memberships VALUES('${fixture.workspace_id}','00000000-0000-0000-0000-000000000001','Owner',true);
  INSERT INTO workspace_actors VALUES('${fixture.workspace_id}','00000000-0000-0000-0000-000000000002','historical');`);
 const existing={...fixture.sources[5],id:'00000000-0000-0000-0000-000000000999',name:'Preserve destination edit',
  adapter_config:{...fixture.sources[5].adapter_config,local_setting:'retained'}};
 await db.query('INSERT INTO sources SELECT (jsonb_populate_record(NULL::sources,$1::jsonb)).*',[JSON.stringify(existing)]);
 const unrelated={...fixture.sources[7],id:'00000000-0000-0000-0000-000000000998',url:'https://unrelated.example.test',adapter_config:{},name:'Unrelated retained'};
 await db.query('INSERT INTO sources SELECT (jsonb_populate_record(NULL::sources,$1::jsonb)).*',[JSON.stringify(unrelated)]);
 // PGlite's database name is postgres; production remains bound to tenderdesk_app.
 const sql=key=>scripts[key].replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'");
 await db.exec(sql('apply'));
 const matched=(await db.query('SELECT * FROM sources WHERE id=$1',[existing.id])).rows[0];
 assert.equal(matched.name,existing.name); assert.equal(matched.approval,'paused');
 assert.equal(matched.adapter_config.local_setting,'retained');assert.equal(matched.adapter_config.automatic,true);assert.equal(matched.next_due,null);
 assert.equal((await db.query('SELECT count(*)::integer n FROM sources')).rows[0].n,37);
 assert.equal((await db.query("SELECT count(*)::integer n FROM sources WHERE approval='rejected'")).rows[0].n,1);
 assert.equal((await db.query("SELECT count(*)::integer n FROM sources WHERE approval='paused' AND next_due IS NULL")).rows[0].n,35);
 const unchanged=(await db.query('SELECT * FROM sources WHERE id=$1',[unrelated.id])).rows[0];
 assert.equal(unchanged.approval,'approved');assert.equal(unchanged.revision,1);
 assert.equal((await db.query('SELECT count(*)::integer n FROM audit_events')).rows[0].n,36);
 assert.equal((await db.query('SELECT name FROM sources WHERE id=$1',[fixture.sources[2].id])).rows[0].name,fixture.sources[2].name);
 await db.exec(sql('verify'));await db.exec(sql('apply'));
 assert.equal((await db.query('SELECT count(*)::integer n FROM audit_events')).rows[0].n,36);
 // A conflict late in the transaction must roll back earlier disabling changes.
 await db.exec("UPDATE sources SET approval='approved' WHERE id='"+fixture.sources[1].id+"'");
 await assert.rejects(db.exec(sql('bad')),/SOURCE_AMBIGUOUS_MATCH/);
 await db.exec('ROLLBACK');
 assert.equal((await db.query('SELECT approval FROM sources WHERE id=$1',[fixture.sources[1].id])).rows[0].approval,'approved');
 console.log('PostgreSQL transfer, idempotency, isolation, quoting and atomic rollback passed.');
} finally {await db.close();}
