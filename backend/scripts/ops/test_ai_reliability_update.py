"""Release transaction and workload preservation tests; never contact production."""
from __future__ import annotations

import copy
from contextlib import ExitStack, contextmanager
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("tested_ai_reliability_update", Path(__file__).with_name("ai-reliability-update.py"))
p = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = p
SPEC.loader.exec_module(p)


class AIReliabilityReleaseTests(unittest.TestCase):
    def test_migration_set_is_exact_and_includes_no_backfill(self):
        self.assertEqual([path.name for path in p.MIGRATIONS], [
            "20261102231710_writer_handoff_usage_blocker.sql",
            "20261102231721_terminal_background_request_lifecycle.sql",
        ])
        for sources in ([], ["SELECT 1;"], ["SELECT 1;", " "]):
            with self.assertRaisesRegex(p.u.UpdateError, "MIGRATION_SET_INVALID"):
                p.migration_script(sources)
        self.assertEqual(p.RUNTIME_COMPONENTS, ("api", "worker"))

    def run_node(self, program):
        program = "process.on('uncaughtException', e=>{console.error(e.message,e.code,e.position,e.where);process.exit(1)});\n" + program
        result = subprocess.run(["node", "--experimental-strip-types", "--input-type=module"], input=program,
                                capture_output=True, text=True, cwd=p.u.d.ROOT, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr[-3500:])

    def test_atomic_release_preserves_existing_rows_and_rejects_grant_changes(self):
        targets = json.dumps(p.FUNCTIONS)
        create = "\n".join("CREATE OR REPLACE FUNCTION " + signature + " RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN "
                            + ("if false then raise exception 'USAGE_REVIEW_REQUIRED';end if;" if index == 0 else "perform 'PROVIDER_BACKGROUND_TERMINATED';")
                            + "RETURN '{}'::jsonb;END$$;" for index, signature in enumerate(p.FUNCTIONS))
        def sql(sources):
            # PGlite's single database is named postgres. Only the fixture guard
            # differs; the shipped release accepts tenderdesk_app exclusively.
            return p.migration_script(sources).replace("current_database()<>'tenderdesk_app'", "current_database()<>'postgres'")
        good = sql([create, "SELECT 1;"])
        mutate = sql([create, "UPDATE public.jobs SET attempts=0;"])
        authority = sql([create, "GRANT EXECUTE ON FUNCTION " + p.FUNCTIONS[1] + " TO authenticated;"])
        drift = sql([create, "SELECT 2;"])
        program = "const targets=" + targets + ";const good=" + json.dumps(good) + ";const mutate=" + json.dumps(mutate) + ";const authority=" + json.dumps(authority) + ";const drift=" + json.dumps(drift) + ";\n" + r"""
import {PGlite} from '@electric-sql/pglite';
const setup=async()=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
  create role tdp_app_owner nosuperuser nobypassrls nocreatedb nocreaterole;
  create schema app_private authorization tdp_app_owner;alter schema public owner to tdp_app_owner;
  create table public.jobs(id int primary key,attempts int,checkpoint jsonb);
  insert into public.jobs values(1,7,'{"frozen":true}');
  create table app_private.model_graph_budgets(thread_id int,unit text,candidates int);
  insert into app_private.model_graph_budgets values(1,'writer',3);
  alter table public.jobs owner to tdp_app_owner;alter table app_private.model_graph_budgets owner to tdp_app_owner;`);
 for(const signature of targets){
  await db.exec(`create function ${signature} returns jsonb language plpgsql as $$begin return '{}'::jsonb;end$$;
   alter function ${signature} owner to tdp_app_owner; revoke all on function ${signature} from public,anon,authenticated,service_role;`);
 }
 return db;
};
const db=await setup();await db.exec(good);await db.exec(good);
if((await db.query('select count(*)::int n from app_private.application_release_history')).rows[0].n!==1)throw Error('DUPLICATE_RELEASE');
if((await db.query('select attempts from public.jobs')).rows[0].attempts!==7)throw Error('JOB_CHANGED');
if((await db.query('select candidates from app_private.model_graph_budgets')).rows[0].candidates!==3)throw Error('BUDGET_CHANGED');
let denied=false;try{await db.exec(drift);}catch(e){denied=e.message==='AI_RELIABILITY_RELEASE_CHECKSUM_MISMATCH';await db.exec('rollback');}
if(!denied)throw Error('CHECKSUM_DRIFT_ACCEPTED');await db.close();
for(const [sql,expected] of [[mutate,'AI_RELIABILITY_EXISTING_DATA_CHANGED'],[authority,'AI_RELIABILITY_FUNCTION_AUTHORITY_CHANGED']]){
 const check=await setup();let rejected=false;
 try{await check.exec(sql);}catch(e){rejected=e.message===expected;await check.exec('rollback');}
 if(!rejected)throw Error('UNSAFE_MIGRATION_ACCEPTED '+expected);
 if((await check.query('select attempts from public.jobs')).rows[0].attempts!==7)throw Error('MUTATION_ESCAPED');
 if((await check.query("select to_regclass('app_private.application_release_history') ledger")).rows[0].ledger!==null)throw Error('FAILED_LEDGER_PERSISTED');
 await check.close();
}
"""
        self.run_node(program)

    def test_actual_migrations_apply_as_restricted_owner_and_replay(self):
        script = p.migration_script().replace("current_database()<>'tenderdesk_app'", "current_database()<>'postgres'")
        program = "const release=" + json.dumps(script) + ";\n" + r"""
import {PGlite} from '@electric-sql/pglite';import {readFile,readdir} from 'node:fs/promises';
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
for(const name of (await readdir('supabase/migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)&&n<'20261102231710_writer_handoff_usage_blocker.sql').sort())
 await db.exec(await readFile('supabase/migrations/'+name,'utf8'));
await db.exec(`create role tdp_app_owner nosuperuser nobypassrls nocreatedb nocreaterole;
 alter schema public owner to tdp_app_owner;alter schema app_private owner to tdp_app_owner;
 grant usage on schema auth to tdp_app_owner;grant select,references on auth.users,auth.identities to tdp_app_owner;
 DO $ownership$ DECLARE r record; BEGIN
 FOR r IN SELECT n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p','v','m') LOOP
 EXECUTE format('ALTER %s %I.%I OWNER TO tdp_app_owner',CASE WHEN r.relkind='v' THEN 'VIEW' WHEN r.relkind='m' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,r.nspname,r.relname);END LOOP;
 FOR r IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','app_private') AND p.prokind='f' LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO tdp_app_owner',r.signature);END LOOP;
 END $ownership$;`);
await db.exec(release);await db.exec(release);
if((await db.query('select count(*)::int n from app_private.application_release_history')).rows[0].n!==1)throw Error('REPLAY_FAILED');
await db.close();
"""
        self.run_node(program)

    @contextmanager
    def fixture(self, failure=None):
        old = p.u.REGISTRY + "runtime@sha256:" + "a" * 64
        new = p.u.REGISTRY + "runtime@sha256:" + "b" * 64
        state = {name: {"metadata": {"uid": name+"-uid"}, "spec": {"template": {"spec": {"containers": [{"name": name, "image": old}]}}}}
                 for name in ("api", "worker", "frontend", "scheduler", "auth", "source-browser")}
        events=[]
        def snapshot():
            return {name: {"uid": value["metadata"]["uid"], "spec": copy.deepcopy(value["spec"])} for name,value in state.items()}
        def patch_image(name, selected, expected, from_image):
            events.append(("patch",name,selected));state[name]["spec"]["template"]["spec"]["containers"][0]["image"]=selected
        def stage(name):
            events.append((name,))
            if failure==name:raise p.u.UpdateError("FIXTURE_"+name.upper())
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {"TENDERDESK_RUNTIME_IMAGE":new,"GITHUB_RUN_ID":"1","GITHUB_RUN_ATTEMPT":"1","DIGITALOCEAN_ACCESS_TOKEN":"fixture"}))
            stack.enter_context(patch.object(p.u.d.probe,"validate_cluster"))
            stack.enter_context(patch.object(p,"workload_snapshot",side_effect=snapshot))
            stack.enter_context(patch.object(p,"retained_configuration",return_value={"unchanged":True}))
            stack.enter_context(patch.object(p.u,"deployment",side_effect=lambda name:copy.deepcopy(state[name])))
            stack.enter_context(patch.object(p.u,"owned",return_value={"data":{}}))
            stack.enter_context(patch.object(p.u.d,"decode_secret",return_value={"PGSSLCA":"fixture-ca"}))
            stack.enter_context(patch.object(p.u.d.probe,"target_credentials",return_value=({},"fixture-ca")))
            stack.enter_context(patch.object(p.u.d,"get",return_value=None))
            stack.enter_context(patch.object(p.u.d,"sql_pod",side_effect=lambda _values:stage("client")))
            stack.enter_context(patch.object(p.u.d,"cleanup_administrator",side_effect=lambda _pod:events.append(("cleanup",))))
            stack.enter_context(patch.object(p,"patch_runtime",side_effect=patch_image))
            stack.enter_context(patch.object(p.u.d,"wait_deployments"))
            stack.enter_context(patch.object(p,"wait_runtime_drain",side_effect=lambda _:stage("drain")))
            stack.enter_context(patch.object(p,"migrate",side_effect=lambda _:stage("schema")))
            stack.enter_context(patch.object(p.u,"public_check",side_effect=lambda *_:stage("public")))
            stack.enter_context(patch.object(p,"emit"))
            yield state,events,old,new

    def test_only_api_worker_change_after_drain_before_schema(self):
        with self.fixture() as (state,events,old,new):
            p.update()
            self.assertLess(events.index(("drain",)),events.index(("schema",)))
            for name,value in state.items():
                self.assertEqual(value["spec"]["template"]["spec"]["containers"][0]["image"],new if name in p.RUNTIME_COMPONENTS else old)
            self.assertEqual(events[-1],("cleanup",))

    def test_failure_before_schema_rolls_back_but_ambiguous_schema_retains_code(self):
        for stage in ("client","drain","schema","public"):
            with self.subTest(stage=stage),self.fixture(stage) as (state,events,old,new):
                with self.assertRaisesRegex(p.u.UpdateError,"FIXTURE_"):p.update()
                expected=new if stage in ("schema","public") else old
                self.assertTrue(all(state[name]["spec"]["template"]["spec"]["containers"][0]["image"]==expected for name in p.RUNTIME_COMPONENTS))
                self.assertEqual(events[-1],("cleanup",))

    def test_configuration_drift_fails_without_overwriting_other_resources(self):
        with self.fixture() as (state,events,old,new),patch.object(p,"retained_configuration",side_effect=[{"before":True},{"after":True}]):
            with self.assertRaisesRegex(p.u.UpdateError,"CONFIGURATION_CHANGED"):p.update()
            self.assertFalse(any(e[0]=="patch" and e[1] not in p.RUNTIME_COMPONENTS for e in events))

    def test_existing_administrator_is_not_adopted_or_deleted(self):
        with self.fixture() as (state,events,old,new),patch.object(p.u.d,"get",return_value={"data":{}}):
            with self.assertRaisesRegex(p.u.UpdateError,"OTHER_ADMIN_IN_PROGRESS"):p.update()
            self.assertEqual(events,[])

    def test_image_patch_rejects_recreated_workload_and_concurrent_image_change(self):
        old=p.u.REGISTRY+"runtime@sha256:"+"a"*64
        new=p.u.REGISTRY+"runtime@sha256:"+"b"*64
        expected={"metadata":{"uid":"original-uid","resourceVersion":"1"},"spec":{"template":{"spec":{"containers":[{"name":"api","image":old}]}}}}
        for change in ("uid","image"):
            current=copy.deepcopy(expected)
            if change=="uid":current["metadata"]["uid"]="replacement-uid"
            else:current["spec"]["template"]["spec"]["containers"][0]["image"]=p.u.REGISTRY+"runtime@sha256:"+"c"*64
            with self.subTest(change=change),patch.object(p.u,"deployment",return_value=current),patch.object(p.u.d,"command") as command:
                with self.assertRaisesRegex(p.u.UpdateError,"CONCURRENT_WORKLOAD_CHANGE"):p.patch_runtime("api",new,expected,old)
                command.assert_not_called()
        with patch.object(p.u,"deployment",return_value=expected),patch.object(p.u.d,"command") as command:
            p.patch_runtime("api",new,expected,old)
            operations=json.loads(command.call_args.args[0][-1])
            self.assertIn({"op":"test","path":"/metadata/uid","value":"original-uid"},operations)
            self.assertIn({"op":"test","path":"/spec/template/spec/containers/0/image","value":old},operations)

    def test_workflow_is_manual_runtime_only_and_verifies_both_packages(self):
        workflow=(p.u.d.ROOT.parent/".github/workflows/deploy-ai-reliability.yml").read_text()
        self.assertIn("workflow_dispatch:",workflow)
        self.assertIn("branches: [codex/ai-execution-reliability]",workflow)
        self.assertEqual(workflow.count("if: ${{ github.event_name == 'workflow_dispatch' }}"),3)
        self.assertNotIn("frontend/Dockerfile",workflow)
        self.assertNotIn("digitalocean-deploy.py",workflow)
        for package in ("backend","frontend"):
            for command in ("run typecheck","test -- --maxWorkers=1","run build"):
                self.assertIn("npm --prefix "+package+" "+command,workflow)


if __name__ == "__main__":
    unittest.main()
