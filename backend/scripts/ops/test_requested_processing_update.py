"""Verify the exact one-shot release without network or production records."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("tested_requested_processing_update", Path(__file__).with_name("requested-processing-update.py"))
p = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = p
SPEC.loader.exec_module(p)


class RequestedProcessingReleaseTests(unittest.TestCase):
    def test_only_exact_requested_migration_is_selected(self):
        self.assertEqual(p.MIGRATION.name, "20261031115846_requested_model_processing.sql")
        with patch.object(Path, "read_text", return_value="SELECT 1;") as read:
            script = p.migration_script()
        self.assertEqual(read.call_args.args, ())
        self.assertIn("requested-model-processing-v1", script)
        self.assertNotIn("openrouter_provider", script)
        self.assertNotIn("provider_update_migration", script)
        with self.assertRaisesRegex(p.u.UpdateError, "MIGRATION_EMPTY"):
            p.migration_script(" ")

    def test_restoration_identity_is_required_before_any_sql(self):
        with patch.object(p.u.d, "restore_state", return_value=None), patch.object(p.u, "owned", return_value={"data": {}}), patch.object(p.u.d, "sql") as sql:
            with self.assertRaisesRegex(p.u.UpdateError, "EXISTING_RESTORATION"):
                p.migrate("offline-client")
            sql.assert_not_called()

    def test_release_transaction_is_atomic_idempotent_and_preserves_rows_and_counters(self):
        migration = """
CREATE TABLE app_private.generation_processing_requests(plan_id uuid PRIMARY KEY,actor_id uuid);
CREATE FUNCTION app_private.check_requested_model_payload(uuid,text,jsonb) RETURNS void
 LANGUAGE sql AS 'SELECT NULL::void';
"""
        valid = p.migration_script(migration)
        bad = p.migration_script(migration + "\nUPDATE public.jobs SET attempts=0;")
        drift = p.migration_script(migration + "\n-- different release body\n")
        incomplete = p.migration_script("CREATE TABLE app_private.generation_processing_requests(plan_id uuid PRIMARY KEY);")
        program = "const valid=" + json.dumps(valid) + ";const bad=" + json.dumps(bad) + ";const drift=" + json.dumps(drift) + ";const incomplete=" + json.dumps(incomplete) + ";\n" + r"""
import {PGlite} from '@electric-sql/pglite';
const setup=async()=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
  create role tdp_app_owner nosuperuser nobypassrls nocreatedb nocreaterole;
  create schema app_private authorization tdp_app_owner;alter schema public owner to tdp_app_owner;
  create table public.jobs(id int primary key,attempts int,status text,checkpoint jsonb);
  insert into public.jobs values(1,7,'blocked','{"saved":true}');
  create table app_private.model_graph_budgets(thread_id int,unit text,candidates int);
  insert into app_private.model_graph_budgets values(1,'writer',3);
  alter table public.jobs owner to tdp_app_owner;
  alter table app_private.model_graph_budgets owner to tdp_app_owner;
  revoke temporary on database postgres from public,tdp_app_owner;`);
 return db;
};
const db=await setup();
const before=(await db.query('select to_jsonb(j) value from public.jobs j')).rows[0].value;
await db.exec(valid);
const ledger=(await db.query('select migration_sha256 from app_private.application_release_history')).rows;
if(ledger.length!==1)throw Error('RELEASE_NOT_RECORDED');
await db.exec("insert into app_private.generation_processing_requests values('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002')");
await db.exec(valid);
if((await db.query('select count(*)::int n from app_private.generation_processing_requests')).rows[0].n!==1)throw Error('REPLAY_CHANGED_REQUESTS');
let rejected=false;try{await db.exec(drift);}catch(e){rejected=e.message==='REQUESTED_PROCESSING_RELEASE_CHECKSUM_MISMATCH';await db.exec('rollback');}
if(!rejected)throw Error('CHECKSUM_DRIFT_ACCEPTED');
const after=(await db.query('select to_jsonb(j) value from public.jobs j')).rows[0].value;
if(JSON.stringify(before)!==JSON.stringify(after))throw Error('EXISTING_JOB_CHANGED');
if((await db.query('select candidates from app_private.model_graph_budgets')).rows[0].candidates!==3)throw Error('BUDGET_CHANGED');
const exposed=(await db.query("select has_table_privilege('authenticated','app_private.application_release_history','SELECT') allowed")).rows[0].allowed;
if(exposed)throw Error('LEDGER_EXPOSED');
await db.close();
for(const [sql,expected] of [[bad,'REQUESTED_PROCESSING_EXISTING_DATA_CHANGED'],[incomplete,'REQUESTED_PROCESSING_SCHEMA_INCOMPLETE']]){
 const check=await setup();let denied=false;
 try{await check.exec(sql);}catch(e){denied=e.message===expected;await check.exec('rollback');}
 if(!denied)throw Error('INVALID_MIGRATION_ACCEPTED '+expected);
 if((await check.query('select attempts from public.jobs')).rows[0].attempts!==7)throw Error('MUTATION_ESCAPED_ROLLBACK');
 if((await check.query("select to_regclass('app_private.application_release_history') ledger")).rows[0].ledger!==null)throw Error('FAILED_LEDGER_PERSISTED');
 await check.close();
}
console.log('requested processing one-shot release passed');
"""
        result = subprocess.run(["node", "--experimental-strip-types", "--input-type=module"], input=program,
                                capture_output=True, text=True, cwd=p.u.d.ROOT, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        self.assertIn("requested processing one-shot release passed", result.stdout)

    def test_served_frontend_contains_in_context_help_and_no_separate_permission_controls(self):
        config = {"apiUrl": "https://offline.example.test", "appOrigin": "https://offline.example.test", "publishableKey": "offline-anon"}
        configuration = {"data": {"runtime-config.js": "window.__TENDERDESK_CONFIG__ = " + json.dumps(config) + ";"}}
        core = {"ANON_KEY": "offline-anon", "SERVICE_KEY": "offline-service", "JWT_SECRET": "offline-signing"}
        assets = {"/": b'<script src="/assets/index-a.js"></script>',
                  "/assets/index-a.js": b'import("./Settings-b.js");import("./OpportunityDetail-c.js")',
                  "/assets/Settings-b.js": b'"Assessment & data"',
                  "/assets/OpportunityDetail-c.js": b'import("./GenerationPanel-d.js")',
                  "/assets/GenerationPanel-d.js": p.FRONTEND_MARKER + b'"Reference code:"'}
        def request(path, **kwargs):
            self.assertNotIn("token", kwargs)
            return p.u.smoke.Response(200, assets[path])
        with patch.object(p, "ORIGINAL_PUBLIC_CHECK"), patch.object(p.u.smoke, "Client") as client, patch.object(p, "emit"):
            client.return_value.request.side_effect = request
            p.public_check(configuration, core)
            assets["/assets/Settings-b.js"] += b'"Individual content permissions"'
            with self.assertRaisesRegex(p.u.UpdateError, "SEPARATE_CONTENT_PERMISSION_UI_PRESENT"):
                p.public_check(configuration, core)
            assets["/assets/Settings-b.js"] = b'"Assessment & data"'
            assets["/assets/GenerationPanel-d.js"] = b'"old blocked copy"'
            with self.assertRaisesRegex(p.u.UpdateError, "IN_CONTEXT_PROCESSING_HELP_MISSING"):
                p.public_check(configuration, core)

    def test_actual_migration_runs_as_restricted_application_owner_and_is_replay_safe(self):
        program = "const release=" + json.dumps(p.migration_script()) + ";\n" + r"""
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
 create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
 create table auth.identities(user_id uuid,provider text,identity_data jsonb);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
 alter table storage.objects enable row level security;grant usage on schema storage to authenticated;grant insert,select on storage.objects to authenticated;`);
for(const name of (await readdir('supabase/migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)&&n!=='20261031115846_requested_model_processing.sql').sort())
 await db.exec(await readFile('supabase/migrations/'+name,'utf8'));
const actor='00000000-0000-4000-8000-000000000001';
await db.query("insert into auth.users values($1,'fixture@example.test',now())",[actor]);
await db.query("insert into auth.identities values($1,'email',$2::jsonb)",[actor,JSON.stringify({sub:actor})]);
const workspace=(await db.query("select public.bootstrap_workspace($1,'Synthetic restricted requested processing') id",[actor])).rows[0].id;
await db.query("insert into public.sources(workspace_id,name,kind,created_by) values($1,'Synthetic preserved source','manual',$2)",[workspace,actor]);
await db.exec(`create role tdp_app_owner nosuperuser nobypassrls nocreatedb nocreaterole;
 alter schema public owner to tdp_app_owner;alter schema app_private owner to tdp_app_owner;
 grant usage on schema auth to tdp_app_owner;
 grant select,references on auth.users,auth.identities to tdp_app_owner;
 DO $ownership$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p','v','m') LOOP
   EXECUTE format('ALTER %s %I.%I OWNER TO tdp_app_owner',CASE WHEN r.relkind='v' THEN 'VIEW' WHEN r.relkind='m' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,r.nspname,r.relname);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN ('public','app_private') AND p.prokind='f' LOOP
   EXECUTE format('ALTER FUNCTION %s OWNER TO tdp_app_owner',r.signature);
  END LOOP;
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC,tdp_app_owner',current_database());
 END $ownership$;`);
await db.exec(release);
await db.exec(release);
if((await db.query('select count(*)::int n from app_private.application_release_history')).rows[0].n!==1)throw Error('LIVE_RELEASE_LEDGER_NOT_SINGLE');
if((await db.query('select name from public.sources')).rows[0].name!=='Synthetic preserved source')throw Error('SOURCE_CHANGED');
const helper=(await db.query("select to_regprocedure('app_private.check_requested_model_payload(uuid,text,jsonb)')::text helper")).rows[0].helper;
if(!helper)throw Error('HELPER_MISSING');
for(const name of ['public.task_model_preflight(uuid,uuid,jsonb)','public.model_preflight(uuid,uuid,jsonb)','public.model_preflight_core(uuid,uuid,jsonb)']){
 const body=(await db.query('select pg_get_functiondef($1::regprocedure) body',[name])).rows[0].body;
 if(!body.includes('check_requested_model_payload(j.id,'))throw Error('PREFLIGHT_NOT_PATCHED');
}
await db.close();console.log('actual restricted requested-processing release passed');
"""
        result = subprocess.run(["node", "--experimental-strip-types", "--input-type=module"], input=program,
                                capture_output=True, text=True, cwd=p.u.d.ROOT, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr[-2500:])
        self.assertIn("actual restricted requested-processing release passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
