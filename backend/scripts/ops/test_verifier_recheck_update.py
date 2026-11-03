"""Exact migration, managed-role portability and no-activation release guards."""
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

SPEC = importlib.util.spec_from_file_location("tested_verifier_recheck_update", Path(__file__).with_name("verifier-recheck-update.py"))
p = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = p
SPEC.loader.exec_module(p)
CANDIDATE = p.u.REGISTRY + "runtime@sha256:" + "d" * 64


class VerifierRecheckReleaseTests(unittest.TestCase):
    def run_node(self, program):
        program = "process.on('uncaughtException', e=>{console.error(e.message,e.code,e.position,e.where);process.exit(1)});\n" + program
        completed = subprocess.run(["node", "--experimental-strip-types", "--input-type=module"], input=program,
                                   capture_output=True, text=True, cwd=p.u.d.ROOT, timeout=180)
        self.assertEqual(completed.returncode, 0, completed.stderr[-4500:])

    def test_exact_source_and_function_inventory(self):
        p.verify_source()
        self.assertEqual(p.MIGRATION.name, "20261103022500_analysis_verifier_recheck.sql")
        self.assertEqual(len(p.NEW_FUNCTIONS), 5)
        self.assertEqual(len(p.FUNCTION_MARKERS), 14)
        with self.assertRaisesRegex(p.u.UpdateError, "MIGRATION_EMPTY"):
            p.migration_script(" ")

    def test_actual_migration_managed_roles_only_preserves_rows_and_replays(self):
        source = p.MIGRATION.read_text()
        def sql(value):
            return p.migration_script(value).replace("current_database()<>'tenderdesk_app'", "current_database()<>'postgres'")
        variants = [
            (source + "\nUPDATE public.release_preserved_fixture SET attempts=0;", "VERIFIER_RECHECK_EXISTING_ROWS_CHANGED"),
            (source + "\nGRANT EXECUTE ON FUNCTION public.model_graph_store(uuid,uuid,text,text,jsonb) TO tdp_app_authenticated;", "VERIFIER_RECHECK_EXISTING_AUTHORITY_CHANGED"),
            (source + "\nGRANT SELECT ON public.release_preserved_fixture TO tdp_app_authenticated;", "VERIFIER_RECHECK_EXISTING_AUTHORITY_CHANGED"),
            (source + "\nGRANT EXECUTE ON FUNCTION app_private.recheck_analysis_verifier(jsonb,text) TO tdp_app_authenticated;", "VERIFIER_RECHECK_PRIVATE_FUNCTION_AUTHORITY_INVALID"),
        ]
        program = "const release=" + json.dumps(sql(source)) + ";const drift=" + json.dumps(sql(source + "\n-- altered source")) + ";\n"
        program += "const variants=" + json.dumps([(sql(value), code) for value, code in variants]) + ";\n"
        program += "const expectedChecksum=" + json.dumps(p.MIGRATION_SHA256) + ";\n"
        program += r"""
import {PGlite} from '@electric-sql/pglite';import {readFile,readdir} from 'node:fs/promises';
const setup=async()=>{
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
 for(const name of (await readdir('supabase/migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)&&n<'20261103022500_analysis_verifier_recheck.sql').sort())
  await db.exec(await readFile('supabase/migrations/'+name,'utf8'));
 await db.exec(`create table public.release_preserved_fixture(id integer primary key,attempts integer,receipt jsonb);
 insert into public.release_preserved_fixture values(1,7,'{"usage":"unknown","frozen":true,"writer_budget":1,"verifier_budget":2}');
 create table app_private.release_private_fixture(id integer primary key,receipt jsonb);
 insert into app_private.release_private_fixture values(1,'{"checkpoint":"retained","completed_sibling":true}');
 create table app_private.application_release_history(release text primary key,migration_sha256 text not null,applied_at timestamptz not null default now());
 alter table app_private.application_release_history enable row level security;
 revoke all on app_private.application_release_history from public;
 insert into app_private.application_release_history(release,migration_sha256) values('ai-execution-reliability-v1','0353c429634df4f9ed3429074e8ff027ef7151b66edffdc467dae08ecb2f8f4b');
 create role tdp_app_owner nosuperuser nobypassrls nocreatedb nocreaterole;
 alter schema public owner to tdp_app_owner;alter schema app_private owner to tdp_app_owner;
 grant usage on schema auth to tdp_app_owner;grant select,references on auth.users,auth.identities to tdp_app_owner;
 DO $ownership$ DECLARE r record; BEGIN
 FOR r IN SELECT n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p','v','m') LOOP
 EXECUTE format('ALTER %s %I.%I OWNER TO tdp_app_owner',CASE WHEN r.relkind='v' THEN 'VIEW' WHEN r.relkind='m' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,r.nspname,r.relname);END LOOP;
 FOR r IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','app_private') AND p.prokind='f' LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO tdp_app_owner',r.signature);END LOOP;
 END $ownership$;
 ALTER ROLE anon RENAME TO tdp_app_anon;
 ALTER ROLE authenticated RENAME TO tdp_app_authenticated;
 ALTER ROLE service_role RENAME TO tdp_app_service;
 ALTER ROLE tdp_app_service NOBYPASSRLS;
 GRANT tdp_app_owner TO tdp_app_service;`);
 return db;
};
const check=async(db,query)=>Object.values((await db.query(query)).rows[0])[0];
const db=await setup();
if(await check(db,"select count(*)::int from pg_roles where rolname in ('anon','authenticated','service_role')")!==0)throw Error('LEGACY_ROLE_FIXTURE_NOT_REMOVED');
await db.exec(release);await db.exec(release);
if(await check(db,"select migration_sha256 from app_private.application_release_history where release='analysis-verifier-recheck-v1'")!==expectedChecksum)throw Error('RELEASE_RECEIPT_MISMATCH');
if(await check(db,"select count(*)::int from app_private.application_release_history")!==2)throw Error('REPLAY_CHANGED_LEDGER');
if(await check(db,"select attempts from public.release_preserved_fixture")!==7)throw Error('PAID_ROW_CHANGED');
if(await check(db,"select count(*)::int from app_private.analysis_verifier_rechecks")!==0)throw Error('CHILD_CREATED');
if(await check(db,"select has_function_privilege('tdp_app_authenticated','app_private.recheck_analysis_verifier(jsonb,text)','EXECUTE')"))throw Error('BROWSER_ACCESS');
let rejected=false;try{await db.exec(drift);}catch(e){rejected=e.message==='VERIFIER_RECHECK_RELEASE_CHECKSUM_MISMATCH';await db.exec('rollback');}
if(!rejected)throw Error('CHECKSUM_DRIFT_ACCEPTED');await db.close();
for(const [script,expected] of variants){
 const other=await setup();let denied=false;
 try{await other.exec(script);}catch(e){denied=e.message===expected;await other.exec('rollback');if(!denied)throw e;}
 if(!denied)throw Error('UNSAFE_MIGRATION_ACCEPTED '+expected);
 if(await check(other,"select attempts from public.release_preserved_fixture")!==7)throw Error('ROW_MUTATION_ESCAPED');
 if(await check(other,"select count(*)::int from app_private.application_release_history")!==1)throw Error('FAILED_RELEASE_RECORDED');
 if(await check(other,"select to_regclass('app_private.analysis_verifier_rechecks')")!==null)throw Error('FAILED_SCHEMA_ESCAPED');
 await other.close();
}
"""
        self.run_node(program)

    @contextmanager
    def fixture(self, failure=None):
        state = {name: {"metadata": {"uid": name + "-uid"}, "spec": {"replicas": 1,
                 "strategy": copy.deepcopy(p.code.WORKER_STRATEGY), "template": {"spec": {
                  "terminationGracePeriodSeconds": 240, "containers": [{"name": name,
                    "image": p.code.FRONTEND if name == "frontend" else p.code.BASE_RUNTIME}]}}}}
                 for name in ("api", "worker", "frontend")}
        events = []
        def stage(name):
            events.append(name)
            if name == failure:
                raise p.u.UpdateError("FIXTURE_FAILURE")
        def patch_api(name, image, _expected, _before):
            state[name]["spec"]["template"]["spec"]["containers"][0]["image"] = image
            stage("image:" + name)
        def patch_worker(_original, image):
            patch_api("worker", image, None, None)
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {"TENDERDESK_RUNTIME_IMAGE": CANDIDATE, "GITHUB_SHA": "e" * 40,
                "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1", "DIGITALOCEAN_ACCESS_TOKEN": "fixture"}))
            stack.enter_context(patch.object(p.u.d.probe, "validate_cluster"))
            stack.enter_context(patch.object(p.u, "deployment", side_effect=lambda name, **_kwargs: copy.deepcopy(state[name])))
            stack.enter_context(patch.object(p.runtime, "workload_snapshot", return_value={}))
            stack.enter_context(patch.object(p.runtime, "retained_configuration", return_value={}))
            stack.enter_context(patch.object(p.code, "verify_unchanged"))
            stack.enter_context(patch.object(p.code, "verify_runtime"))
            stack.enter_context(patch.object(p.u, "owned", return_value={"data": {}}))
            stack.enter_context(patch.object(p.u.d, "decode_secret", return_value={"PGSSLCA": "fixture-ca"}))
            stack.enter_context(patch.object(p.u.d.probe, "target_credentials", return_value=({}, "fixture-ca")))
            stack.enter_context(patch.object(p.u.d, "get", return_value=None))
            stack.enter_context(patch.object(p.u.d, "sql_pod", side_effect=lambda _values: stage("client")))
            stack.enter_context(patch.object(p.u.d, "cleanup_administrator", side_effect=lambda _pod: stage("cleanup")))
            stack.enter_context(patch.object(p.runtime, "patch_runtime", side_effect=patch_api))
            stack.enter_context(patch.object(p.code, "patch_worker_image", side_effect=patch_worker))
            stack.enter_context(patch.object(p.code, "patch_worker_strategy", side_effect=lambda _original, _image, recreate: stage("strategy:" + str(recreate))))
            stack.enter_context(patch.object(p.u.d, "wait_deployments", side_effect=lambda names: stage("ready:" + ",".join(names))))
            stack.enter_context(patch.object(p.runtime, "wait_runtime_drain", side_effect=lambda _image: stage("drain")))
            stack.enter_context(patch.object(p, "migrate", side_effect=lambda _pod: stage("schema")))
            stack.enter_context(patch.object(p.code, "public_check", side_effect=lambda _config: stage("public")))
            emitted = stack.enter_context(patch.object(p, "emit"))
            yield state, events, emitted

    def test_runtime_ready_and_drained_before_schema_no_activation_and_cleanup_before_success(self):
        with self.fixture() as (state, events, emitted):
            p.update()
            self.assertLess(events.index("ready:api"), events.index("image:worker"))
            self.assertLess(events.index("drain"), events.index("schema"))
            self.assertLess(events.index("schema"), events.index("strategy:False"))
            self.assertEqual(events[-1], "cleanup")
            receipt = emitted.call_args.kwargs
            self.assertFalse(receipt["processing_retried"])
            self.assertFalse(receipt["children_created"])
            self.assertEqual(p.code.image_of(state["frontend"]), p.code.FRONTEND)

    def test_ambiguous_runtime_schema_or_acceptance_failure_retains_candidate_and_cleans_admin(self):
        for failure in ("image:api", "image:worker", "schema", "public"):
            with self.subTest(failure=failure), self.fixture(failure) as (state, events, emitted):
                with self.assertRaisesRegex(p.u.UpdateError, "FIXTURE_FAILURE"):
                    p.update()
                self.assertEqual(p.code.image_of(state["api"]), CANDIDATE)
                self.assertEqual(events[-1], "cleanup")
                self.assertFalse(any(call.args[0] == "passed" for call in emitted.call_args_list))
                receipt = next(call.kwargs for call in emitted.call_args_list if call.args[0] == "compatible_runtime_retained")
                self.assertEqual(receipt["schema_attempted"], failure in ("schema", "public"))

    def test_existing_administrator_or_baseline_mismatch_cannot_mutate(self):
        with self.fixture() as (state, events, emitted), patch.object(p.u.d, "get", return_value={}):
            with self.assertRaisesRegex(p.u.UpdateError, "OTHER_ADMIN_IN_PROGRESS"):
                p.update()
            self.assertEqual(events, [])
        with self.fixture() as (state, events, emitted):
            state["api"]["spec"]["template"]["spec"]["containers"][0]["image"] = "foreign"
            with self.assertRaisesRegex(p.u.UpdateError, "BASELINE_MISMATCH"):
                p.update()
            self.assertEqual(events, [])

    def test_cleanup_failure_never_emits_final_success(self):
        with self.fixture("cleanup") as (state, events, emitted):
            with self.assertRaisesRegex(p.u.UpdateError, "FIXTURE_FAILURE"):
                p.update()
            self.assertFalse(any(call.args[0] == "passed" for call in emitted.call_args_list))

    def test_workflow_cannot_activate_processing_and_push_has_no_production_access(self):
        workflow = (p.u.d.ROOT.parent / ".github/workflows/deploy-verifier-recheck.yml").read_text()
        self.assertEqual(workflow.count("if: ${{ github.event_name == 'workflow_dispatch' }}"), 3)
        self.assertIn("model-validation-runtime-image.py", workflow)
        self.assertNotIn("proposal-verifier-recheck.py", workflow)
        self.assertNotIn("--activate", workflow)
        self.assertNotIn("frontend/Dockerfile", workflow)
        self.assertIn("group: tenderdesk-digitalocean-production", workflow)


if __name__ == "__main__":
    unittest.main()
