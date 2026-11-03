"""SQL-only release, exact managed-role migration and preservation boundaries."""
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

SPEC = importlib.util.spec_from_file_location("tested_model_admission_update", Path(__file__).with_name("model-admission-update.py"))
p = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = p
SPEC.loader.exec_module(p)


class ModelAdmissionReleaseTests(unittest.TestCase):
    def run_node(self, program):
        program = "process.on('uncaughtException',e=>{console.error(e.message,e.code,e.position,e.where);process.exit(1)});\n" + program
        completed = subprocess.run(["node", "--experimental-strip-types", "--input-type=module"], input=program,
                                   capture_output=True, text=True, cwd=p.u.d.ROOT, timeout=180)
        self.assertEqual(completed.returncode, 0, completed.stderr[-4500:])

    def test_exact_source_and_sql_only_inventory(self):
        p.verify_source()
        self.assertEqual([path.name for path, _sha, _release in p.MIGRATIONS], [
            "20261103031500_analysis_recheck_prompt_identity.sql", "20261103032000_model_admission_fairness.sql"])
        self.assertEqual(set(p.FUNCTION_MARKERS), {"app_private.next_fair_job(uuid,boolean)", "app_private.analysis_recheck_binding(uuid)"})
        with self.assertRaisesRegex(p.u.UpdateError, "MIGRATION_EMPTY"):
            p.migration_script([" ", " "])
        with patch.object(p, "MIGRATIONS", [(path, "0" * 64, release) for path, _sha, release in p.MIGRATIONS]):
            with self.assertRaisesRegex(p.u.UpdateError, "SOURCE_CHANGED"):
                p.verify_source()

    def test_exact_managed_role_migration_preserves_rows_authorities_and_replays(self):
        sources = [path.read_text() for path, _checksum, _release in p.MIGRATIONS]
        source = sources[-1]
        def sql(value):
            return p.migration_script([sources[0], value]).replace("current_database()<>'tenderdesk_app'", "current_database()<>'postgres'")
        variants = [
            (source + "\nUPDATE public.release_preserved_fixture SET attempts=0;", "MODEL_ADMISSION_EXISTING_ROWS_CHANGED"),
            (source + "\nGRANT EXECUTE ON FUNCTION app_private.next_fair_job(uuid,boolean) TO tdp_app_authenticated;", "MODEL_ADMISSION_EXISTING_AUTHORITY_CHANGED"),
            (source + "\nGRANT SELECT ON public.release_preserved_fixture TO tdp_app_authenticated;", "MODEL_ADMISSION_EXISTING_AUTHORITY_CHANGED"),
            (source + "\nGRANT SELECT ON app_private.queue_model_admission_state TO tdp_app_authenticated;", "MODEL_ADMISSION_CURSOR_AUTHORITY_INVALID"),
            (source + "\nALTER TABLE public.release_preserved_fixture ADD COLUMN unexpected text;", "MODEL_ADMISSION_EXISTING_ROWS_CHANGED"),
            (source + "\nALTER TABLE public.release_preserved_fixture ADD CONSTRAINT unexpected CHECK(attempts>=0);", "MODEL_ADMISSION_EXISTING_STRUCTURE_CHANGED"),
            (source + "\nCREATE TABLE app_private.unreviewed(id int);", "MODEL_ADMISSION_UNEXPECTED_SCHEMA"),
            (source + "\nCREATE FUNCTION app_private.unreviewed() RETURNS int LANGUAGE sql AS 'select 1';", "MODEL_ADMISSION_UNEXPECTED_SCHEMA"),
            (source + "\nINSERT INTO app_private.queue_model_admission_state(workspace_id) SELECT id FROM public.workspaces;", "MODEL_ADMISSION_INITIAL_CURSOR_NOT_EMPTY"),
        ]
        program = "const release=" + json.dumps(sql(source)) + ";const drift=" + json.dumps(sql(source + "\n-- changed source")) + ";\n"
        program += "const variants=" + json.dumps([(sql(value), code) for value, code in variants]) + ";\n"
        program += "const expectedChecksums=" + json.dumps({release: checksum for _path, checksum, release in p.MIGRATIONS}) + ";\n"
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
 for(const name of (await readdir('supabase/migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)&&n<'20261103031500_analysis_recheck_prompt_identity.sql').sort())
  await db.exec(await readFile('supabase/migrations/'+name,'utf8'));
 await db.exec(`insert into public.workspaces(id,name) values('10000000-0000-4000-8000-000000000001','synthetic release fixture');
 create table public.release_preserved_fixture(id integer primary key,attempts integer,receipt jsonb);
 insert into public.release_preserved_fixture values(1,7,'{"usage":"unknown","frozen":true,"writer_budget":1,"verifier_budget":2}');
 create table app_private.release_private_fixture(id integer primary key,receipt jsonb);
 insert into app_private.release_private_fixture values(1,'{"checkpoint":"retained","completed_sibling":true}');
 create table app_private.application_release_history(release text primary key,migration_sha256 text not null,applied_at timestamptz not null default now());
 alter table app_private.application_release_history enable row level security;
 revoke all on app_private.application_release_history from public;
 insert into app_private.application_release_history(release,migration_sha256) values
 ('ai-execution-reliability-v1','0353c429634df4f9ed3429074e8ff027ef7151b66edffdc467dae08ecb2f8f4b'),
 ('analysis-verifier-recheck-v1','cead30c43776e35822e4fa63476223a5ff4abe8de35218286d66dd5bd8c22382');
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
if(await check(db,"select count(*)::int from pg_roles where rolname in ('anon','authenticated','service_role')")!==0)throw Error('LEGACY_ROLES_REMAIN');
await db.exec(release);await db.exec(release);
for(const [key,value] of Object.entries(expectedChecksums)){
 if((await db.query('select migration_sha256 from app_private.application_release_history where release=$1',[key])).rows[0]?.migration_sha256!==value)throw Error('RELEASE_RECEIPT_MISMATCH');
}
if(await check(db,"select count(*)::int from app_private.application_release_history")!==4)throw Error('REPLAY_CHANGED_LEDGER');
if(await check(db,"select attempts from public.release_preserved_fixture")!==7)throw Error('PAID_ROW_CHANGED');
if(await check(db,"select count(*)::int from app_private.queue_model_admission_state")!==0)throw Error('CLAIM_CURSOR_CREATED');
if(await check(db,"select count(*)::int from app_private.analysis_verifier_rechecks")!==0)throw Error('RECHECK_CHILD_CREATED');
if(await check(db,"select has_function_privilege('tdp_app_authenticated','app_private.next_fair_job(uuid,boolean)','EXECUTE')"))throw Error('BROWSER_ACCESS');
await db.exec("insert into app_private.queue_model_admission_state(workspace_id,next_class,dispatch_count) values('10000000-0000-4000-8000-000000000001','background',7)");
await db.exec(release);
if(await check(db,"select dispatch_count::int from app_private.queue_model_admission_state")!==7)throw Error('REPLAY_RESET_LIVE_CURSOR');
let rejected=false;try{await db.exec(drift);}catch(e){rejected=e.message==='MODEL_ADMISSION_RELEASE_CHECKSUM_MISMATCH';await db.exec('rollback');}
if(!rejected)throw Error('CHECKSUM_DRIFT_ACCEPTED');await db.close();
const partial=await setup();
await partial.query('insert into app_private.application_release_history(release,migration_sha256) values($1,$2)',Object.entries(expectedChecksums)[0]);
let partialRejected=false;try{await partial.exec(release);}catch(e){partialRejected=e.message==='MODEL_ADMISSION_PARTIAL_BATCH_LEDGER';await partial.exec('rollback');}
if(!partialRejected)throw Error('PARTIAL_BATCH_ACCEPTED');await partial.close();
for(const [script,expected] of variants){
 const other=await setup();let denied=false;
 try{await other.exec(script);}catch(e){denied=e.message===expected;await other.exec('rollback');if(!denied)throw e;}
 if(!denied)throw Error('UNSAFE_MIGRATION_ACCEPTED '+expected);
 if(await check(other,"select attempts from public.release_preserved_fixture")!==7)throw Error('ROW_MUTATION_ESCAPED');
 if(await check(other,"select count(*)::int from app_private.application_release_history")!==2)throw Error('FAILED_RELEASE_RECORDED');
 if(await check(other,"select to_regclass('app_private.queue_model_admission_state')")!==null)throw Error('FAILED_SCHEMA_ESCAPED');
 if(!await check(other,"select position('analyze_chunk.%' in pg_get_functiondef('app_private.analysis_recheck_binding(uuid)'::regprocedure))>0"))throw Error('FIRST_MIGRATION_ESCAPED_BATCH_ROLLBACK');
 await other.close();
}
"""
        self.run_node(program)

    @contextmanager
    def fixture(self, failure=None, on_public=None):
        deployments = {name: {"metadata": {"uid": name + "-uid"}, "spec": {"replicas": 1,
                       "template": {"spec": {"containers": [{"name": name, "image":
                       p.code.FRONTEND if name == "frontend" else p.RUNTIME}]}}}}
                       for name in ("api", "worker", "frontend", "scheduler")}
        retained = {"configuration": {"a": "b"}, "secrets": {"private": "fixture"}, "schedules": {"fixed": True}}
        events = []
        def stage(name):
            events.append(name)
            if name == "public" and on_public:
                on_public(deployments, retained)
            if name == failure:
                raise p.u.UpdateError("FIXTURE_FAILURE")
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {"GITHUB_SHA": "e" * 40, "GITHUB_RUN_ID": "123",
                                                       "GITHUB_RUN_ATTEMPT": "1", "DIGITALOCEAN_ACCESS_TOKEN": "fixture"}))
            stack.enter_context(patch.object(p.u.d.probe, "validate_cluster"))
            stack.enter_context(patch.object(p.u, "deployment", side_effect=lambda name, **_kw: copy.deepcopy(deployments[name])))
            stack.enter_context(patch.object(p.runtime, "workload_snapshot", side_effect=lambda: copy.deepcopy(deployments)))
            stack.enter_context(patch.object(p.runtime, "retained_configuration", side_effect=lambda: copy.deepcopy(retained)))
            stack.enter_context(patch.object(p.u, "owned", return_value={"data": {}}))
            stack.enter_context(patch.object(p.u.d, "decode_secret", return_value={"PGSSLCA": "fixture-ca"}))
            stack.enter_context(patch.object(p.u.d.probe, "target_credentials", return_value=({}, "fixture-ca")))
            stack.enter_context(patch.object(p.u.d, "get", return_value=None))
            stack.enter_context(patch.object(p.u.d, "sql_pod", side_effect=lambda _values: stage("client")))
            stack.enter_context(patch.object(p.u.d, "cleanup_administrator", side_effect=lambda _pod: stage("cleanup")))
            stack.enter_context(patch.object(p, "migrate", side_effect=lambda _pod: stage("schema")))
            stack.enter_context(patch.object(p.code, "public_check", side_effect=lambda _config: stage("public")))
            # Any attempted rollout is an immediate test failure.
            stack.enter_context(patch.object(p.runtime, "patch_runtime", side_effect=AssertionError("RUNTIME_MUTATION_FORBIDDEN")))
            stack.enter_context(patch.object(p.code, "patch_worker_strategy", side_effect=AssertionError("STRATEGY_MUTATION_FORBIDDEN")))
            emitted = stack.enter_context(patch.object(p, "emit"))
            yield deployments, retained, events, emitted

    def test_sql_only_acceptance_preserves_all_images_and_cleans_before_success(self):
        with self.fixture() as (state, retained, events, emitted):
            original = copy.deepcopy(state)
            p.update()
            self.assertEqual(state, original)
            self.assertEqual(events, ["client", "schema", "public", "cleanup"])
            self.assertEqual(emitted.call_args.args[0], "passed")
            receipt = emitted.call_args.kwargs
            self.assertEqual(receipt["deployments_updated"], [])
            self.assertFalse(receipt["children_created"])
            self.assertFalse(receipt["processing_retried"])
            self.assertFalse(receipt["jobs_claimed"])

    def test_ambiguous_schema_and_public_failures_preserve_images_and_cleanup(self):
        for failure in ("client", "schema", "public"):
            with self.subTest(failure=failure), self.fixture(failure) as (state, retained, events, emitted):
                original = copy.deepcopy(state)
                with self.assertRaisesRegex(p.u.UpdateError, "FIXTURE_FAILURE"):
                    p.update()
                self.assertEqual(state, original)
                self.assertEqual(events[-1], "cleanup")
                self.assertFalse(any(call.args[0] == "passed" for call in emitted.call_args_list))
                receipt = next(call.kwargs for call in emitted.call_args_list if call.args[0] == "verification_incomplete")
                self.assertEqual(receipt["schema_attempted"], failure != "client")

    def test_foreign_administrator_or_wrong_baseline_cannot_mutate(self):
        for kind in ("secret", "pod"):
            with self.subTest(kind=kind), self.fixture() as (_state, _retained, events, _emit), patch.object(
                    p.u.d, "get", side_effect=lambda actual, _name: {} if actual == kind else None):
                with self.assertRaisesRegex(p.u.UpdateError, "OTHER_ADMIN_IN_PROGRESS"):
                    p.update()
                self.assertEqual(events, [])
        for name in ("api", "worker", "frontend"):
            with self.subTest(name=name), self.fixture() as (state, retained, events, emitted):
                state[name]["spec"]["template"]["spec"]["containers"][0]["image"] = "foreign"
                with self.assertRaisesRegex(p.u.UpdateError, "BASELINE_MISMATCH"):
                    p.update()
                self.assertEqual(events, [])

    def test_late_workload_or_configuration_drift_cannot_report_success(self):
        mutations = [
            lambda state, _retained: state["api"]["metadata"].update(uid="replaced"),
            lambda state, _retained: state["worker"]["spec"].update(replicas=2),
            lambda state, _retained: state["scheduler"]["spec"].update(replicas=2),
            lambda _state, retained: retained["secrets"].update(private="changed"),
        ]
        for mutate in mutations:
            with self.fixture(on_public=mutate) as (state, retained, events, emitted):
                with self.assertRaisesRegex(p.u.UpdateError, "CHANGED"):
                    p.update()
                self.assertEqual(events[-1], "cleanup")
                self.assertFalse(any(call.args[0] == "passed" for call in emitted.call_args_list))

    def test_cleanup_failure_prevents_success(self):
        with self.fixture("cleanup") as (state, retained, events, emitted):
            with self.assertRaisesRegex(p.u.UpdateError, "FIXTURE_FAILURE"):
                p.update()
            self.assertFalse(any(call.args[0] == "passed" for call in emitted.call_args_list))

    def test_workflow_has_no_image_build_or_mutating_push_path(self):
        workflow = (p.u.d.ROOT.parent / ".github/workflows/deploy-model-admission.yml").read_text()
        self.assertEqual(workflow.count("if: ${{ github.event_name == 'workflow_dispatch' }}"), 1)
        self.assertIn("model-admission-update.py", workflow)
        for forbidden in ("runtime-image.py", "docker build", "docker push", "digitalocean-runner.py", "--activate", "proposal-verifier-recheck.py"):
            self.assertNotIn(forbidden, workflow)
        self.assertIn("group: tenderdesk-digitalocean-production", workflow)
        self.assertIn("cancel-in-progress: false", workflow)


if __name__ == "__main__":
    unittest.main()
