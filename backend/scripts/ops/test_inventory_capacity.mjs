import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const {sql}=JSON.parse(raw);
const db=new PGlite();await db.waitReady;
try {
 await db.exec(`CREATE ROLE tdp_app_authenticator; CREATE ROLE tdp_app_authenticated;
  ALTER ROLE tdp_app_authenticated SET statement_timeout='15s';
  ALTER ROLE tdp_app_authenticator IN DATABASE postgres SET work_mem='8MB';
  ALTER DATABASE postgres SET statement_timeout='30s';
  SET statement_timeout='700ms';SET work_mem='6MB';`);
 // Only the exact disposable database identity differs; query/bounds are unchanged.
 const results=await db.exec(sql.replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'"));
 const row=results.find(result=>result.rows.length)?.rows[0].jsonb_build_object;
 assert.equal(row.version,1);assert.equal(row.database_identity_verified,true);
 assert.equal(row.basis,'observer_login_and_catalog_defaults_not_rest_transaction_effective');
 assert.equal(row.observed_login_role,'unrecognized');
 assert.equal(row.observed_login_settings.find(value=>value.name==='statement_timeout').setting,700);
 assert.equal(row.observed_login_settings.find(value=>value.name==='work_mem').setting,6144);
 assert.equal(row.query_overrides.statement_timeout_ms,20000);
 const defaults=row.configured_defaults;
 assert.ok(defaults.some(value=>value.role===null&&value.scope==='current_database'&&value.name==='statement_timeout'&&value.value==='30s'));
 assert.ok(defaults.some(value=>value.role==='tdp_app_authenticated'&&value.scope==='all_databases'&&value.name==='statement_timeout'&&value.value==='15s'));
 assert.ok(defaults.some(value=>value.role==='tdp_app_authenticator'&&value.scope==='current_database'&&value.name==='work_mem'&&value.value==='8MB'));
 assert.equal((await db.query("select current_setting('statement_timeout') value")).rows[0].value,'700ms');
 console.log(JSON.stringify(row));
} finally { await db.close(); }
