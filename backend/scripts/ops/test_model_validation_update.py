"""Offline guards for the code-only runtime release and durable prompt pins."""
from __future__ import annotations

import copy
from contextlib import ExitStack, contextmanager
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("tested_model_validation_update", Path(__file__).with_name("model-validation-update.py"))
p = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = p
SPEC.loader.exec_module(p)
CANDIDATE = p.u.REGISTRY + "runtime@sha256:" + "c" * 64


class ModelValidationReleaseTests(unittest.TestCase):
    @contextmanager
    def fixture(self):
        names = ("api", "worker", "frontend", "scheduler", "auth", "source-browser")
        state = {name: {"metadata": {"uid": name + "-uid", "resourceVersion": "1", "annotations": {"keep": "yes"}},
                       "spec": {"replicas": 1, "strategy": copy.deepcopy(p.WORKER_STRATEGY),
                                "template": {"spec": {"terminationGracePeriodSeconds": 240,
                                    "containers": [{"name": name, "image": p.FRONTEND if name == "frontend" else p.BASE_RUNTIME}]}}}}
                 for name in names}
        events = []
        controls = {"failure": None, "on_public": None, "on_stage": None}
        retained = {"secrets": {"runtime": "fixture-private"}, "schedules": {"browser": "unchanged"}}

        def stage(name):
            events.append(name)
            if controls["on_stage"]:
                controls["on_stage"](name, state)
            if controls["failure"] == name:
                raise p.u.UpdateError("FIXTURE_FAILURE")

        def command(arguments):
            self.assertEqual(arguments[:2], ["patch", "deployment"])
            name = arguments[2]
            self.assertIn(name, ("api", "worker"))
            value = copy.deepcopy(state[name])
            image_changed = False
            for operation in json.loads(arguments[-1]):
                parts = [part.replace("~1", "/").replace("~0", "~") for part in operation["path"].split("/")[1:]]
                cursor = value
                for part in parts[:-1]:
                    cursor = cursor[int(part)] if isinstance(cursor, list) else cursor[part]
                key = int(parts[-1]) if isinstance(cursor, list) else parts[-1]
                if operation["op"] == "test":
                    self.assertEqual(cursor[key], operation["value"])
                elif operation["op"] in ("replace", "add"):
                    cursor[key] = copy.deepcopy(operation["value"])
                    image_changed |= operation["path"].endswith("/image")
                elif operation["op"] == "remove":
                    del cursor[key]
                else:
                    self.fail("Unexpected patch operation")
            value["metadata"]["resourceVersion"] = str(int(value["metadata"]["resourceVersion"]) + 1)
            state[name] = value
            if image_changed:
                stage("image:" + name)
            else:
                stage("strategy:" + value["spec"]["strategy"]["type"])

        def snapshot():
            return {name: {"uid": value["metadata"]["uid"], "spec": copy.deepcopy(value["spec"])} for name, value in state.items()}

        def drain(selected):
            self.assertEqual(p.image_of(state["api"]), selected)
            self.assertEqual(state["worker"]["spec"]["strategy"], {"type": "Recreate"})
            stage("drain")

        def public(_configuration):
            stage("public")
            if controls["on_public"]:
                controls["on_public"](state, retained)

        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {"TENDERDESK_RUNTIME_IMAGE": CANDIDATE,
                "GITHUB_SHA": "d" * 40, "GITHUB_RUN_ID": "12", "GITHUB_RUN_ATTEMPT": "1"}))
            stack.enter_context(patch.object(p.u.d.probe, "validate_cluster"))
            stack.enter_context(patch.object(p.u, "deployment", side_effect=lambda name, **_kwargs: copy.deepcopy(state[name])))
            stack.enter_context(patch.object(p.u, "owned", return_value={"data": {}}))
            stack.enter_context(patch.object(p.u.d, "command", side_effect=command))
            stack.enter_context(patch.object(p.u.d, "wait_deployments", side_effect=lambda names: stage("ready:" + ",".join(names))))
            stack.enter_context(patch.object(p.runtime, "workload_snapshot", side_effect=snapshot))
            stack.enter_context(patch.object(p.runtime, "retained_configuration", side_effect=lambda: copy.deepcopy(retained)))
            stack.enter_context(patch.object(p.runtime, "wait_runtime_drain", side_effect=drain))
            stack.enter_context(patch.object(p, "public_check", side_effect=public))
            emitted = stack.enter_context(patch.object(p, "emit"))
            for module, name in [(p.u.d, name) for name in ("sql", "sql_pod", "restore_application", "restore_state", "decode_secret", "apply", "cleanup_administrator")] + [(p.u.d.probe, "target_credentials"), (p.runtime, "migrate")]:
                stack.enter_context(patch.object(module, name, side_effect=AssertionError("FORBIDDEN_DATABASE_OR_ADMIN_OPERATION")))
            yield state, events, controls, retained, emitted

    def test_api_ready_then_recreate_worker_drain_before_successful_strategy_restoration(self):
        with self.fixture() as (state, events, controls, retained, emitted):
            before = copy.deepcopy(state)
            p.update()
            self.assertEqual(events, ["image:api", "ready:api", "strategy:Recreate", "image:worker",
                                      "ready:worker", "drain", "public", "strategy:RollingUpdate"])
            for name, value in state.items():
                if name in ("api", "worker"):
                    self.assertEqual(p.image_of(value), CANDIDATE)
                    self.assertEqual(p.u.without_image(value), p.u.without_image(before[name]))
                    self.assertEqual(value["metadata"]["annotations"], {"keep": "yes"})
                else:
                    self.assertEqual(value, before[name])
            receipt = emitted.call_args.kwargs
            self.assertFalse(receipt["database_accessed"])
            self.assertFalse(receipt["schema_changed"])
            self.assertFalse(receipt["processing_retried"])
            self.assertTrue(receipt["old_workers_drained_before_new"])

    def test_ambiguous_patch_and_failed_acceptance_keep_candidate_and_support_forward_completion(self):
        for failure in ("image:api", "ready:api", "strategy:Recreate", "image:worker", "ready:worker", "drain", "public"):
            with self.subTest(failure=failure), self.fixture() as (state, events, controls, retained, emitted):
                controls["failure"] = failure
                with self.assertRaisesRegex(p.u.UpdateError, "FIXTURE_FAILURE"):
                    p.update()
                self.assertEqual(p.image_of(state["api"]), CANDIDATE)
                self.assertIn(unittest.mock.call("compatible_runtime_retained", automatic_rollback=False,
                    forward_completion_required=True, rollout_may_be_partial=True,
                    candidate_image=CANDIDATE), emitted.call_args_list)
                if "image:worker" in events:
                    self.assertEqual(p.image_of(state["worker"]), CANDIDATE)
                    self.assertEqual(state["worker"]["spec"]["strategy"], {"type": "Recreate"})
                controls["failure"] = None
                p.update()
                self.assertEqual(p.image_of(state["worker"]), CANDIDATE)
                self.assertEqual(state["worker"]["spec"]["strategy"], p.WORKER_STRATEGY)
                self.assertNotIn(p.ROLLOUT_MARKER, state["worker"]["metadata"]["annotations"])

    def test_wrong_image_strategy_marker_or_insufficient_grace_refuses_before_mutations(self):
        for failure in ("api", "worker", "frontend", "strategy", "marker", "grace"):
            with self.subTest(failure=failure), self.fixture() as (state, events, controls, retained, emitted):
                if failure in ("api", "worker", "frontend"):
                    state[failure]["spec"]["template"]["spec"]["containers"][0]["image"] = "foreign"
                elif failure == "strategy":
                    state["worker"]["spec"]["strategy"] = {"type": "Recreate"}
                elif failure == "marker":
                    state["worker"]["metadata"]["annotations"][p.ROLLOUT_MARKER] = "foreign"
                else:
                    state["worker"]["spec"]["template"]["spec"]["terminationGracePeriodSeconds"] = 239
                with self.assertRaises(p.u.UpdateError):
                    p.update()
                self.assertEqual(events, [])

    def test_unrelated_workload_identity_or_private_configuration_drift_is_never_reverted(self):
        for kind in ("workload", "configuration"):
            with self.subTest(kind=kind), self.fixture() as (state, events, controls, retained, emitted):
                def change(live, saved):
                    if kind == "workload":
                        live["frontend"]["metadata"]["uid"] = "foreign-replacement"
                    else:
                        saved["secrets"]["runtime"] = "concurrent-private-change"
                controls["on_public"] = change
                with self.assertRaisesRegex(p.u.UpdateError, "(OTHER_WORKLOAD|CONFIGURATION)_CHANGED"):
                    p.update()
                self.assertEqual(p.image_of(state["worker"]), CANDIDATE)
                self.assertEqual(state["worker"]["spec"]["strategy"], {"type": "Recreate"})
                if kind == "workload":
                    self.assertEqual(state["frontend"]["metadata"]["uid"], "foreign-replacement")
                else:
                    self.assertEqual(retained["secrets"]["runtime"], "concurrent-private-change")

    def test_worker_strategy_compare_and_set_rejects_uid_or_configuration_drift(self):
        for kind in ("uid", "config"):
            with self.subTest(kind=kind), self.fixture() as (state, events, controls, retained, emitted):
                original = copy.deepcopy(state["worker"])
                if kind == "uid":
                    state["worker"]["metadata"]["uid"] = "replacement"
                else:
                    state["worker"]["spec"]["template"]["spec"]["unreviewed"] = True
                with self.assertRaisesRegex(p.u.UpdateError, "CONCURRENT_WORKLOAD_CHANGE"):
                    p.patch_worker_strategy(original, CANDIDATE, True)
                self.assertEqual(events, [])

    def test_foreign_change_after_strategy_is_not_adopted_by_worker_image_patch(self):
        for kind in ("uid", "image", "config", "strategy", "marker"):
            with self.subTest(kind=kind), self.fixture() as (state, events, controls, retained, emitted):
                def change(stage, live):
                    if stage != "strategy:Recreate":
                        return
                    worker = live["worker"]
                    if kind == "uid":
                        worker["metadata"]["uid"] = "foreign-worker"
                    elif kind == "image":
                        worker["spec"]["template"]["spec"]["containers"][0]["image"] = "foreign"
                    elif kind == "config":
                        worker["spec"]["template"]["spec"]["unreviewed"] = True
                    elif kind == "strategy":
                        worker["spec"]["strategy"] = copy.deepcopy(p.WORKER_STRATEGY)
                    else:
                        worker["metadata"]["annotations"][p.ROLLOUT_MARKER] = "foreign"
                controls["on_stage"] = change
                with self.assertRaises(p.u.UpdateError):
                    p.update()
                self.assertNotIn("image:worker", events)
                self.assertNotEqual(p.image_of(state["worker"]), CANDIDATE)

    def test_late_runtime_drift_cannot_produce_a_success_receipt(self):
        for name, kind, late in (("api", "image", False), ("api", "uid", False),
                                 ("api", "config", False), ("worker", "uid", False),
                                 ("worker", "uid", True), ("api", "image", True)):
            with self.subTest(name=name, kind=kind, late=late), self.fixture() as (state, events, controls, retained, emitted):
                def change(live):
                    if kind == "image":
                        live[name]["spec"]["template"]["spec"]["containers"][0]["image"] = p.BASE_RUNTIME
                    elif kind == "uid":
                        live[name]["metadata"]["uid"] = "replacement"
                    else:
                        live[name]["spec"]["template"]["spec"]["foreign"] = True
                if late:
                    controls["on_stage"] = lambda stage, live: change(live) if stage == "strategy:RollingUpdate" else None
                else:
                    controls["on_public"] = lambda live, _saved: change(live)
                with self.assertRaises(p.u.UpdateError):
                    p.update()
                self.assertFalse(any(call.args[0] == "passed" for call in emitted.call_args_list))

    def test_unchanged_migration_sources_are_checked_without_executing_sql(self):
        p.verify_source()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in p.PRIOR_MIGRATIONS:
                target = root / "supabase/migrations" / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("-- unreviewed migration change")
            with patch.object(p.u.d, "ROOT", root), self.assertRaisesRegex(p.u.UpdateError, "PRIOR_MIGRATION_CHANGED"):
                p.verify_source()

    def test_invalid_release_identity_or_old_candidate_refuses_before_mutations(self):
        for values in ({"GITHUB_SHA": "not-a-revision"}, {"GITHUB_RUN_ID": "bad"},
                       {"GITHUB_RUN_ATTEMPT": "bad"}, {"TENDERDESK_RUNTIME_IMAGE": p.BASE_RUNTIME}):
            with self.subTest(values=values), self.fixture() as (state, events, controls, retained, emitted), patch.dict(os.environ, values):
                with self.assertRaises(p.u.UpdateError):
                    p.update()
                self.assertEqual(events, [])

    def test_public_acceptance_does_not_use_a_privileged_identity(self):
        configuration = {"data": {"runtime-config.js": "fixture"}}
        with patch.object(p.u.smoke, "javascript_config", return_value={"publishableKey": "public"}), patch.object(p.u, "public_check") as check:
            p.public_check(configuration)
        self.assertEqual(check.call_args.args[1], {"ANON_KEY": "public", "SERVICE_KEY": "", "JWT_SECRET": ""})

    def test_workflow_offline_push_and_manual_runtime_only_release(self):
        workflow = (p.u.d.ROOT.parent / ".github/workflows/deploy-model-validation.yml").read_text()
        self.assertIn("branches: [codex/ai-reliability-resume]", workflow)
        self.assertEqual(workflow.count("if: ${{ github.event_name == 'workflow_dispatch' }}"), 3)
        self.assertIn("always() && github.event_name == 'workflow_dispatch'", workflow)
        self.assertNotIn("frontend/Dockerfile", workflow)
        self.assertNotIn("digitalocean-deploy.py", workflow)
        self.assertNotIn("ai-reliability-update.py", workflow)
        self.assertNotIn("--registry-pull-secret", workflow)
        self.assertIn("model-validation-runtime-image.py", workflow)
        self.assertIn("TENDERDESK_REUSE_RUNTIME_IMAGE: ${{ inputs.candidate_image }}", workflow)
        for package in ("backend", "frontend"):
            for command in ("run typecheck", "test -- --maxWorkers=1", "run build"):
                self.assertIn("npm --prefix " + package + " " + command, workflow)
        dockerfile = (p.u.d.ROOT / "deploy/Dockerfile").read_text()
        self.assertIn("backend/supabase/functions/ ./supabase/functions/", dockerfile)


if __name__ == "__main__":
    unittest.main()
