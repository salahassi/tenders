"""Verify the exact one-shot release without network or production records."""
from __future__ import annotations

import importlib.util
import copy
import base64
from contextlib import ExitStack, contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("tested_flexible_input_update", Path(__file__).with_name("flexible-proposal-inputs-update.py"))
p = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = p
SPEC.loader.exec_module(p)


class FlexibleInputReleaseTests(unittest.TestCase):
    def test_only_exact_requested_migration_is_selected(self):
        self.assertEqual(p.MIGRATION.name, "20261031202143_flexible_proposal_input_drafts.sql")
        with patch.object(Path, "read_text", return_value="SELECT 1;") as read:
            script = p.migration_script()
        self.assertEqual(read.call_args.args, ())
        self.assertIn("flexible-proposal-inputs-v1", script)
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
CREATE FUNCTION app_private.seal_draft_package(uuid,uuid,uuid) RETURNS void LANGUAGE sql AS 'SELECT NULL::void';
CREATE FUNCTION app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb) RETURNS jsonb
 LANGUAGE sql AS $$SELECT '{"draft_input_version":1}'::jsonb$$;
CREATE FUNCTION app_private.generation_command(text,jsonb,text) RETURNS jsonb
 LANGUAGE sql AS $$SELECT app_private.draft_generation_snapshot(NULL,NULL,NULL,NULL,NULL)$$;
CREATE FUNCTION app_private.refresh_proposal_evidence(uuid) RETURNS void
 LANGUAGE plpgsql AS $$BEGIN PERFORM app_private.draft_generation_snapshot(NULL,NULL,NULL,NULL,NULL);END$$;
CREATE FUNCTION app_private.approval_gate_before_flexible_inputs(uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
CREATE FUNCTION app_private.approval_gate(uuid,uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT app_private.approval_gate_before_flexible_inputs(NULL,NULL)$$;
"""
        valid = p.migration_script(migration)
        bad = p.migration_script(migration + "\nUPDATE public.jobs SET attempts=0;")
        drift = p.migration_script(migration + "\n-- different release body\n")
        incomplete = p.migration_script("CREATE FUNCTION app_private.seal_draft_package(uuid,uuid,uuid) RETURNS void LANGUAGE sql AS 'SELECT NULL::void';")
        program = "const valid=" + json.dumps(valid) + ";const bad=" + json.dumps(bad) + ";const drift=" + json.dumps(drift) + ";const incomplete=" + json.dumps(incomplete) + ";\n" + r"""
import {PGlite} from '@electric-sql/pglite';
const setup=async()=>{
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
  create role tdp_app_owner nosuperuser nobypassrls nocreatedb nocreaterole;
  create schema app_private authorization tdp_app_owner;alter schema public owner to tdp_app_owner;
  create table public.jobs(id int primary key,attempts int,status text,checkpoint jsonb);
  insert into public.jobs values(1,7,'blocked','{"saved":true}');
  create table app_private.generation_processing_requests(plan_id uuid primary key,actor_id uuid);
  create table app_private.model_graph_budgets(thread_id int,unit text,candidates int);
  insert into app_private.model_graph_budgets values(1,'writer',3);
  alter table public.jobs owner to tdp_app_owner;
  alter table app_private.model_graph_budgets owner to tdp_app_owner;
  alter table app_private.generation_processing_requests owner to tdp_app_owner;
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
let rejected=false;try{await db.exec(drift);}catch(e){rejected=e.message==='FLEXIBLE_INPUTS_RELEASE_CHECKSUM_MISMATCH';await db.exec('rollback');}
if(!rejected)throw Error('CHECKSUM_DRIFT_ACCEPTED');
const after=(await db.query('select to_jsonb(j) value from public.jobs j')).rows[0].value;
if(JSON.stringify(before)!==JSON.stringify(after))throw Error('EXISTING_JOB_CHANGED');
if((await db.query('select candidates from app_private.model_graph_budgets')).rows[0].candidates!==3)throw Error('BUDGET_CHANGED');
const exposed=(await db.query("select has_table_privilege('authenticated','app_private.application_release_history','SELECT') allowed")).rows[0].allowed;
if(exposed)throw Error('LEDGER_EXPOSED');
await db.close();
for(const [sql,expected] of [[bad,'FLEXIBLE_INPUTS_EXISTING_DATA_CHANGED'],[incomplete,'FLEXIBLE_INPUTS_SCHEMA_INCOMPLETE']]){
 const check=await setup();let denied=false;
 try{await check.exec(sql);}catch(e){denied=e.message===expected;await check.exec('rollback');}
 if(!denied)throw Error('INVALID_MIGRATION_ACCEPTED '+expected);
 if((await check.query('select attempts from public.jobs')).rows[0].attempts!==7)throw Error('MUTATION_ESCAPED_ROLLBACK');
 if((await check.query("select to_regclass('app_private.application_release_history') ledger")).rows[0].ledger!==null)throw Error('FAILED_LEDGER_PERSISTED');
 await check.close();
}
console.log('flexible input one-shot release passed');
"""
        result = subprocess.run(["node", "--experimental-strip-types", "--input-type=module"], input=program,
                                capture_output=True, text=True, cwd=p.u.d.ROOT, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        self.assertIn("flexible input one-shot release passed", result.stdout)

    def test_served_frontend_contains_in_context_help_and_no_separate_permission_controls(self):
        config = {"apiUrl": "https://offline.example.test", "appOrigin": "https://offline.example.test", "publishableKey": "offline-anon"}
        configuration = {"data": {"runtime-config.js": "window.__TENDERDESK_CONFIG__ = " + json.dumps(config) + ";"}}
        core = {"ANON_KEY": "offline-anon", "SERVICE_KEY": "offline-service", "JWT_SECRET": "offline-signing"}
        assets = {"/": b'<script src="/assets/index-a.js"></script>',
                  "/assets/index-a.js": b'import("./Settings-b.js");import("./OpportunityDetail-c.js")',
                  "/assets/Settings-b.js": b'"Assessment & data"',
                  "/assets/OpportunityDetail-c.js": p.UPLOAD_MARKER + b'import("./GenerationPanel-d.js")',
                  "/assets/GenerationPanel-d.js": p.GENERATION_MARKER}
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
            with self.assertRaisesRegex(p.u.UpdateError, "FLEXIBLE_DRAFT_FRONTEND_MISSING"):
                p.public_check(configuration, core)
            assets["/assets/GenerationPanel-d.js"] = p.GENERATION_MARKER
            assets["/assets/OpportunityDetail-c.js"] = b'import("./GenerationPanel-d.js")'
            with self.assertRaisesRegex(p.u.UpdateError, "FLEXIBLE_DRAFT_FRONTEND_MISSING"):
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
for(const name of (await readdir('supabase/migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)&&n<'20261031202143_flexible_proposal_input_drafts.sql').sort())
 await db.exec(await readFile('supabase/migrations/'+name,'utf8'));
const actor='00000000-0000-4000-8000-000000000001';
await db.query("insert into auth.users values($1,'fixture@example.test',now())",[actor]);
await db.query("insert into auth.identities values($1,'email',$2::jsonb)",[actor,JSON.stringify({sub:actor})]);
const workspace=(await db.query("select public.bootstrap_workspace($1,'Synthetic restricted flexible input') id",[actor])).rows[0].id;
await db.query("insert into public.sources(workspace_id,name,kind,created_by) values($1,'Synthetic preserved source','manual',$2)",[workspace,actor]);
await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
const source=(await db.query('select id from public.sources limit 1')).rows[0].id;
const opportunity=(await db.query("select public.app_command('opportunity.create',$1::jsonb,'flexible-fixture-opportunity') result",[JSON.stringify({source_id:source,title:'Synthetic legacy paid work',description:'Existing frozen proposal context.',decision:'shortlisted',language:'en'})])).rows[0].result.id;
const plan=(await db.query(`insert into public.generation_plans(workspace_id,opportunity_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by)
 values($1,$2,'proposal','analysis','blocked',0,repeat('a',64),'{"legacy_paid":true,"blocks":[{"text":"Synthetic frozen text"}]}',$3) returning id`,[workspace,opportunity,actor])).rows[0].id;
const job=(await db.query(`insert into public.jobs(workspace_id,type,entity_id,input_hash,status,attempts,checkpoint,created_by)
 values($1,'analyze_chunk',$2,repeat('a',64),'blocked',3,'{"retained_checkpoint":true}',$3) returning id`,[workspace,plan,actor])).rows[0].id;
await db.query(`insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,created_by,state)
 values($1,$2,gen_random_uuid(),'synthetic-retained-paid-call','openai','synthetic-model',repeat('a',64),current_date,1,100,100,$3,'unknown')`,[workspace,job,actor]);
await db.query(`insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,candidate_count,budget_version)
 values(repeat('b',64),$1,$2,repeat('a',64),'analyze_chunk',2,2)`,[workspace,job]);
await db.query(`insert into app_private.model_graph_budgets(workspace_id,thread_id,unit,candidates) values($1,repeat('b',64),'writer',2)`,[workspace]);
await db.query(`insert into app_private.generation_processing_requests(plan_id,workspace_id,requested_by,operation,idempotency_key,requested_at)
 values($1,$2,$3,'proposal.generate','synthetic-retained-request',now())`,[plan,workspace,actor]);
const frozenBefore=(await db.query('select frozen_context from public.generation_plans where id=$1',[plan])).rows[0].frozen_context;
const retainedBefore=(await db.query(`select jsonb_build_object(
 'job',(select to_jsonb(j) from public.jobs j where j.id=$1),
 'usage',(select jsonb_agg(to_jsonb(u) order by id) from public.provider_usage u),
 'request',(select to_jsonb(x) from app_private.generation_processing_requests x where x.plan_id=$2),
 'budget',(select jsonb_agg(to_jsonb(b) order by thread_id,unit) from app_private.model_graph_budgets b)) value`,[job,plan])).rows[0].value;
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
for(const name of ['app_private.seal_draft_package(uuid,uuid,uuid)',
 'app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb)',
 'app_private.approval_gate_before_flexible_inputs(uuid,uuid)']){
 const helper=(await db.query('select to_regprocedure($1)::text helper',[name])).rows[0].helper;
 if(!helper)throw Error('HELPER_MISSING '+name);
}
const frozenAfter=(await db.query('select frozen_context from public.generation_plans where id=$1',[plan])).rows[0].frozen_context;
if(JSON.stringify(frozenAfter)!==JSON.stringify(frozenBefore))throw Error('PAID_FROZEN_CONTEXT_CHANGED');
const retainedAfter=(await db.query(`select jsonb_build_object(
 'job',(select to_jsonb(j) from public.jobs j where j.id=$1),
 'usage',(select jsonb_agg(to_jsonb(u) order by id) from public.provider_usage u),
 'request',(select to_jsonb(x) from app_private.generation_processing_requests x where x.plan_id=$2),
 'budget',(select jsonb_agg(to_jsonb(b) order by thread_id,unit) from app_private.model_graph_budgets b)) value`,[job,plan])).rows[0].value;
if(JSON.stringify(retainedAfter)!==JSON.stringify(retainedBefore))throw Error('RETAINED_PAID_WORK_CHANGED');
await db.close();console.log('actual restricted flexible-input release passed');
"""
        result = subprocess.run(["node", "--experimental-strip-types", "--input-type=module"], input=program,
                                capture_output=True, text=True, cwd=p.u.d.ROOT, timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr[-2500:])
        self.assertIn("actual restricted flexible-input release passed", result.stdout)


    @contextmanager
    def update_fixture(self, failure=None):
        registry = p.u.REGISTRY
        old_runtime, runtime = registry + "runtime@sha256:" + "a" * 64, registry + "runtime@sha256:" + "b" * 64
        old_frontend, frontend = registry + "frontend@sha256:" + "c" * 64, registry + "frontend@sha256:" + "d" * 64
        state = {name: {"spec": {"replicas": 1, "template": {"spec": {"containers": [
            {"name": name, "image": old_frontend if name == "frontend" else old_runtime}], "serviceAccountName": "synthetic-preserved"}}}}
            for name in p.u.COMPONENTS}
        events = []
        configuration = {"data": {"runtime-config.js": "synthetic-preserved"}}
        def owned(kind, name):
            if kind == "cronjob": return {"spec": {"schedule": "*/5 * * * *", "suspend": False}}
            if kind == "configmap": return copy.deepcopy(configuration)
            if kind == "secret": return {"data": {}}
            raise AssertionError("UNEXPECTED_RESOURCE")
        def patch_image(name, selected, expected):
            self.assertEqual(p.u.without_image(state[name]), p.u.without_image(expected))
            events.append(("image", name, selected))
            state[name]["spec"]["template"]["spec"]["containers"][0]["image"] = selected
        def migrate(_pod):
            events.append(("schema",))
            if failure == "schema": raise p.u.UpdateError("SYNTHETIC_SCHEMA_FAILURE")
        def drain(_expected):
            events.append(("drain",))
            if failure == "drain": raise p.u.UpdateError("SYNTHETIC_DRAIN_FAILURE")
        def public_check(_configuration, _core):
            events.append(("public",))
            if failure == "public": raise p.u.UpdateError("SYNTHETIC_PUBLIC_FAILURE")
        env = {"TENDERDESK_RUNTIME_IMAGE": runtime, "TENDERDESK_FRONTEND_IMAGE": frontend,
               "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1", "DIGITALOCEAN_ACCESS_TOKEN": "synthetic"}
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, env))
            stack.enter_context(patch.object(p.u.d.probe, "validate_cluster"))
            stack.enter_context(patch.object(p.u, "deployment", side_effect=lambda name: copy.deepcopy(state[name])))
            stack.enter_context(patch.object(p.u, "owned", side_effect=owned))
            stack.enter_context(patch.object(p.u.d, "decode_secret", return_value={"PGSSLCA": "synthetic-ca"}))
            stack.enter_context(patch.object(p.u.d.probe, "target_credentials", return_value=({"PGHOST": "synthetic-private"}, "synthetic-ca")))
            stack.enter_context(patch.object(p.u.d, "sql_pod", side_effect=lambda _values: events.append(("client",))))
            stack.enter_context(patch.object(p.u.d, "cleanup_administrator", side_effect=lambda _pod: events.append(("cleanup",))))
            stack.enter_context(patch.object(p.u, "patch_image", side_effect=patch_image))
            stack.enter_context(patch.object(p.u.d, "wait_deployments", side_effect=lambda names: events.append(("ready", tuple(names)))))
            stack.enter_context(patch.object(p, "wait_runtime_drain", side_effect=drain))
            stack.enter_context(patch.object(p, "migrate", side_effect=migrate))
            stack.enter_context(patch.object(p, "public_check", side_effect=public_check))
            emitter = stack.enter_context(patch.object(p, "emit"))
            yield state, events, emitter, old_runtime, runtime, old_frontend, frontend

    def test_runtime_drains_before_schema_and_frontend_follows_versioned_admission(self):
        with self.update_fixture() as (state, events, emitter, old_runtime, runtime, old_frontend, frontend):
            p.update()
            schema_index = events.index(("schema",))
            drain_index = events.index(("drain",))
            frontend_index = events.index(("image", "frontend", frontend))
            self.assertLess(drain_index, schema_index)
            self.assertLess(schema_index, frontend_index)
            for name in p.RUNTIME_COMPONENTS:
                self.assertLess(events.index(("image", name, runtime)), drain_index)
            self.assertEqual(events[-1], ("cleanup",))
            self.assertEqual(emitter.call_args.args, ("passed",))

    def test_before_schema_failure_restores_runtime_but_post_schema_failure_keeps_compatible_code(self):
        for failure in ("drain", "schema", "public"):
            with self.subTest(failure=failure), self.update_fixture(failure) as (state, events, emitter, old_runtime, runtime, old_frontend, frontend):
                with self.assertRaisesRegex(p.u.UpdateError, "SYNTHETIC_.*_FAILURE"):
                    p.update()
                for name in p.RUNTIME_COMPONENTS:
                    actual = state[name]["spec"]["template"]["spec"]["containers"][0]["image"]
                    self.assertEqual(actual, old_runtime if failure == "drain" else runtime)
                self.assertEqual(state["frontend"]["spec"]["template"]["spec"]["containers"][0]["image"], old_frontend)
                self.assertEqual(events[-1], ("cleanup",))
                expected = "runtime_images_rolled_back" if failure == "drain" else "compatible_runtime_retained"
                self.assertEqual(emitter.call_args.args, (expected,))

    def test_drain_checks_old_worker_processes_after_deployment_readiness(self):
        runtime = p.u.REGISTRY + "runtime@sha256:" + "b" * 64
        old = p.u.REGISTRY + "runtime@sha256:" + "a" * 64
        deployment = {"spec": {"template": {"spec": {"containers": [{"image": runtime}]}}}}
        calls = {name: 0 for name in p.RUNTIME_COMPONENTS}
        def pods(name, deployment):
            calls[name] += 1
            if name == "worker" and calls[name] == 1:
                return [{"status": {"phase": "Running"}, "metadata": {"deletionTimestamp": "synthetic"},
                         "spec": {"containers": [{"image": old}]}}]
            return []
        with patch.object(p.u, "deployment", return_value=deployment), patch.object(p, "runtime_pods", side_effect=pods), \
             patch.object(p.time, "monotonic", side_effect=[0, 1]), patch.object(p.time, "sleep") as pause:
            p.wait_runtime_drain(runtime)
        pause.assert_called_once_with(3)
        self.assertTrue(all(value == 2 for value in calls.values()))

    def rendered_runtime_identity(self):
        payload = base64.urlsafe_b64encode(json.dumps({"role": "tdp_app_anon"}).encode()).decode().rstrip("=")
        config = {"namespace": p.u.d.NAMESPACE, "public_origin": "https://offline.example.test",
            "runtime_image": p.u.REGISTRY + "runtime@sha256:" + "a" * 64,
            "frontend_image": p.u.REGISTRY + "frontend@sha256:" + "b" * 64,
            "https_image": p.u.REGISTRY + "https@sha256:" + "c" * 64,
            "browser_image": p.u.REGISTRY + "browser@sha256:" + "d" * 64,
            "ocr_image": p.u.REGISTRY + "ocr@sha256:" + "e" * 64,
            "publishable_key": "fixture." + payload + ".fixture"}
        deployment = next(obj for obj in p.u.d.renderer.build(config)
            if obj["kind"] == "Deployment" and obj["metadata"]["name"] == "worker")
        deployment["metadata"]["uid"] = "deployment-uid"
        # apply_managed labels only the persisted top-level object.
        deployment["metadata"]["labels"]["app.kubernetes.io/managed-by"] = "tenderdesk-deployment"
        labels = copy.deepcopy(deployment["spec"]["template"]["metadata"]["labels"])
        self.assertNotIn("app.kubernetes.io/managed-by", labels)
        pod = {"metadata": {"namespace": p.u.d.NAMESPACE, "name": "worker-pod", "uid": "pod-uid", "labels": labels,
                "ownerReferences": [{"apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "worker-rs", "uid": "replica-set-uid", "controller": True}]},
               "spec": {"containers": copy.deepcopy(deployment["spec"]["template"]["spec"]["containers"])},
               "status": {"phase": "Running"}}
        replica_set = {"metadata": {"name": "worker-rs", "namespace": p.u.d.NAMESPACE, "uid": "replica-set-uid", "labels": labels,
            "ownerReferences": [{"apiVersion": "apps/v1", "kind": "Deployment", "name": "worker", "uid": "deployment-uid", "controller": True}]}}
        return deployment, pod, replica_set

    def test_canonical_rendered_pod_labels_need_exact_controller_chain_not_managed_by(self):
        deployment, pod, replica_set = self.rendered_runtime_identity()
        old_pod = copy.deepcopy(pod)
        old_pod["metadata"]["uid"] = "old-pod-uid"
        old_pod["metadata"]["ownerReferences"][0].update(name="worker-old-rs", uid="old-replica-set-uid")
        old_pod["metadata"]["deletionTimestamp"] = "synthetic"
        old_pod["spec"]["containers"][0]["image"] = p.u.REGISTRY + "runtime@sha256:" + "f" * 64
        old_replica_set = copy.deepcopy(replica_set)
        old_replica_set["metadata"].update(name="worker-old-rs", uid="old-replica-set-uid")
        def lookup(kind, name):
            self.assertEqual(kind, "replicaset")
            return {"worker-rs": replica_set, "worker-old-rs": old_replica_set}[name]
        with patch.object(p.u.d, "command", return_value=json.dumps({"items": [pod, old_pod]})), patch.object(p.u.d, "get", side_effect=lookup) as read:
            self.assertEqual(p.runtime_pods("worker", deployment), [pod, old_pod])
            self.assertEqual(read.call_count, 2)

    def test_same_label_pods_refuse_missing_spoofed_or_foreign_controller_identity(self):
        original_deployment, original_pod, original_rs = self.rendered_runtime_identity()
        cases = []
        def candidate(label):
            dep, pod, rs = copy.deepcopy((original_deployment, original_pod, original_rs))
            cases.append((label, dep, pod, rs))
            return dep, pod, rs
        _, pod, _ = candidate("unowned")
        pod["metadata"]["ownerReferences"] = []
        _, pod, _ = candidate("noncontroller")
        pod["metadata"]["ownerReferences"][0]["controller"] = False
        _, pod, _ = candidate("ambiguous_pod_controller")
        pod["metadata"]["ownerReferences"].append(copy.deepcopy(pod["metadata"]["ownerReferences"][0]))
        _, pod, _ = candidate("spoofed_replicaset_uid")
        pod["metadata"]["ownerReferences"][0]["uid"] = "spoofed"
        _, _, rs = candidate("missing_replicaset")
        cases[-1] = (*cases[-1][:3], None)
        _, _, rs = candidate("foreign_replicaset_namespace")
        rs["metadata"]["namespace"] = "foreign"
        _, _, rs = candidate("foreign_deployment_uid")
        rs["metadata"]["ownerReferences"][0]["uid"] = "foreign-deployment"
        _, _, rs = candidate("foreign_deployment_name")
        rs["metadata"]["ownerReferences"][0]["name"] = "foreign-deployment"
        _, _, rs = candidate("noncontroller_deployment_reference")
        rs["metadata"]["ownerReferences"][0]["controller"] = False
        _, _, rs = candidate("ambiguous_deployment_controller")
        rs["metadata"]["ownerReferences"].append(copy.deepcopy(rs["metadata"]["ownerReferences"][0]))
        _, pod, _ = candidate("foreign_pod_namespace")
        pod["metadata"]["namespace"] = "foreign"
        _, pod, _ = candidate("foreign_container")
        pod["spec"]["containers"][0]["name"] = "foreign"
        _, pod, _ = candidate("extra_container")
        pod["spec"]["containers"].append(copy.deepcopy(pod["spec"]["containers"][0]))
        _, pod, _ = candidate("missing_pod_uid")
        pod["metadata"].pop("uid")
        for label, dep, pod, rs in cases:
            with self.subTest(label=label), patch.object(p.u.d, "command", return_value=json.dumps({"items": [pod]})), patch.object(p.u.d, "get", return_value=rs):
                with self.assertRaisesRegex(p.u.UpdateError, "POD_OWNERSHIP"):
                    p.runtime_pods("worker", dep)
        for malformed in ("--raw", "worker/foreign", "", "x" * 254):
            dep, pod, rs = copy.deepcopy((original_deployment, original_pod, original_rs))
            pod["metadata"]["ownerReferences"][0]["name"] = malformed
            with self.subTest(name=malformed), patch.object(p.u.d, "command", return_value=json.dumps({"items": [pod]})), patch.object(p.u.d, "get") as read:
                with self.assertRaisesRegex(p.u.UpdateError, "POD_OWNERSHIP"):
                    p.runtime_pods("worker", dep)
                read.assert_not_called()

    def test_runtime_drain_workflow_has_no_restore_or_resume(self):
        workflow = (p.u.d.ROOT.parent / ".github/workflows/deploy-flexible-proposal-inputs.yml").read_text()
        for forbidden in ("resume-requested-processing", "digitalocean-deploy.py", "first-owner", "selection_object", "--selection"):
            self.assertNotIn(forbidden, workflow)
        self.assertIn("codex/flexible-proposal-inputs", workflow)
        self.assertIn("flexible-proposal-inputs-update.py", workflow)


if __name__ == "__main__":
    unittest.main()
