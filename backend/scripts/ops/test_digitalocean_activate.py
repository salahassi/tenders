"""Guard regressions for enabling maintenance on the verified empty target."""
import base64
import contextlib
from copy import deepcopy
from datetime import datetime, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import sys
import time
import unittest
from unittest.mock import patch

path = Path(__file__).with_name("digitalocean-activate.py")
spec = importlib.util.spec_from_file_location("activate_under_test", path)
activation = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = activation
spec.loader.exec_module(activation)

WORKSPACE = "10000000-0000-4000-8000-000000000001"
ENVIRONMENT = {"GITHUB_RUN_ID": "40250000000", "GITHUB_RUN_ATTEMPT": "2", "GITHUB_SHA": "a" * 40}
ORIGIN = "https://app.example.test"


def receipt():
    return {"run_id": ENVIRONMENT["GITHUB_RUN_ID"], "attempt": ENVIRONMENT["GITHUB_RUN_ATTEMPT"],
            "source_revision": ENVIRONMENT["GITHUB_SHA"], "origin": ORIGIN,
            "result": {"probe": "tenderdesk_production_smoke", "status": "passed",
                       "checks_passed": len(activation.REQUIRED_SMOKE_CHECKS),
                       "checks": dict.fromkeys(activation.REQUIRED_SMOKE_CHECKS, True),
                       "workspace_fixture_records_created": False, "source_project_deleted": False}}


def configuration():
    return activation.Config(SimpleNamespace(origin=ORIGIN, anon_key="private-anon-key", service_key="private-service-key"),
                             {"APP_WORKER_SECRET": "worker-credential-" * 4, "APP_NATIVE_WORKER_SECRET": "native-credential-" * 4,
                              "APP_COLLECTION_HOSTS": "example.test"}, ["example.test"], ENVIRONMENT["GITHUB_RUN_ID"], ENVIRONMENT["GITHUB_RUN_ATTEMPT"])


def owned(name, component=None):
    return {"metadata": {"name": name, "namespace": activation.NAMESPACE, "uid": "fixture-uid-" + name,
                         "labels": {"app.kubernetes.io/managed-by": activation.MARKER,
                                    "app.kubernetes.io/name": component or name}}}


def empty_rows():
    return {**dict.fromkeys(activation.EMPTY_TABLES, []),
            "workspaces": [{"id": WORKSPACE, "model_enabled": False}],
            "model_execution_settings": [{"workspace_id": WORKSPACE, "enabled": False}],
            "model_routing": [{"workspace_id": WORKSPACE, "enabled": False}],
            # Existing enabled profiles are configuration, not new-work admission.
            "model_settings": [{"workspace_id": WORKSPACE, "enabled": True}],
            "operations": [{"workspace_id": WORKSPACE, "last_heartbeat_at": None, "scheduler_enabled": False}]}


def resource_inventory():
    objects = {}
    for name in ("worker", "source-browser", "scheduler"):
        value = owned(name)
        env = [{"name": "APP_RUNTIME_SERVICE", "value": name}]
        if name == "scheduler":
            env.append({"name": "APP_SCHEDULER_ENABLED", "value": "false"})
        value["spec"] = {"replicas": 1, "template": {"spec": {"containers": [
            {"name": name, "image": activation.REGISTRY + "runtime@sha256:" + "a" * 64, "env": env}]}}}
        objects[("deployment", name)] = value
    for name in ("browser", "ocr"):
        value = owned("native-" + name)
        value["spec"] = {"suspend": True, "schedule": "*/10 * * * *", "concurrencyPolicy": "Forbid",
                         "jobTemplate": {"spec": {"template": {"spec": {
                             "automountServiceAccountToken": False,
                             "containers": [{"name": name, "image": activation.REGISTRY + name + "@sha256:" + "b" * 64,
                                             "env": [{"name": "APP_NATIVE_WORKER_URL", "value": "http://source-browser:8080/functions/v1/source-browser"},
                                                     {"name": "APP_NATIVE_WORKER_SECRET", "valueFrom": {"secretKeyRef": {"name": "tenderdesk-runtime", "key": "APP_NATIVE_WORKER_SECRET"}}}]}]}}}}}
        objects[("cronjob", "native-" + name)] = value
    return objects


class ActivationGuardTests(unittest.TestCase):
    def instance(self):
        return activation.Activation(configuration(), client=object())

    def test_receipt_requires_every_passed_check_cleanup_and_exact_workflow_identity(self):
        activation.validate_receipt(receipt(), ORIGIN, ENVIRONMENT)
        cases = []
        for key, value in (("run_id", "40249999999"), ("attempt", "1"), ("source_revision", "b" * 40), ("origin", "https://foreign.example.test")):
            candidate = receipt(); candidate[key] = value; cases.append(candidate)
        for key, value in (("status", "failed"), ("checks_passed", 0), ("workspace_fixture_records_created", True),
                           ("source_project_deleted", True), ("cleanup_failures", ["CLEANUP_FAILED"])):
            candidate = receipt(); candidate["result"][key] = value; cases.append(candidate)
        missing = receipt(); missing["result"]["checks"].pop(next(iter(activation.REQUIRED_SMOKE_CHECKS))); cases.append(missing)
        false_check = receipt(); false_check["result"]["checks"][next(iter(activation.REQUIRED_SMOKE_CHECKS))] = 1; cases.append(false_check)
        extra = receipt(); extra["unexpected"] = True; cases.append(extra)
        for candidate in cases:
            with self.subTest(candidate=candidate), self.assertRaises(activation.ActivationFailure):
                activation.validate_receipt(candidate, ORIGIN, ENVIRONMENT)
        with self.assertRaisesRegex(activation.ActivationFailure, "WORKFLOW_MISMATCH"):
            activation.validate_receipt(receipt(), ORIGIN, {**ENVIRONMENT, "GITHUB_SHA": "not-a-commit"})

    def test_private_receipt_rejects_symlinks_public_files_and_other_directories(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as other:
            root = Path(directory)
            selected = root / "receipt.json"
            selected.write_text(json.dumps(receipt())); selected.chmod(0o600)
            self.assertEqual(activation.private_json(selected, root), receipt())
            selected.chmod(0o644)
            with self.assertRaisesRegex(activation.ActivationFailure, "PRIVATE_FILE_REJECTED"):
                activation.private_json(selected, root)
            selected.chmod(0o600)
            linked = root / "linked.json"; linked.symlink_to(selected)
            for candidate in (linked, Path(other) / "receipt.json"):
                with self.assertRaises(activation.ActivationFailure): activation.private_json(candidate, root)
            selected.write_bytes(b"x" * (128 * 1024 + 1))
            with self.assertRaises(activation.ActivationFailure): activation.private_json(selected, root)

    def test_collection_allowlist_timestamp_and_ownership_are_strict(self):
        self.assertEqual(activation.collection_hosts("b.example.test,a.example.test,b.example.test"), ["a.example.test", "b.example.test"])
        for value in (None, "UPPER.example.test", "https://example.test", "example..test", "user@example.test", ",".join("h" + str(i) + ".example.test" for i in range(201))):
            with self.subTest(value=value), self.assertRaises(activation.ActivationFailure): activation.collection_hosts(value)
        self.assertIsNone(activation.timestamp(None))
        self.assertEqual(activation.timestamp("2026-10-26T00:00:00Z"), datetime(2026, 10, 26, tzinfo=timezone.utc).timestamp())
        for value in ("2026-10-26T00:00:00", "not-a-date", 0):
            with self.assertRaises(activation.ActivationFailure): activation.timestamp(value)
        for update in ({"namespace": "foreign"}, {"name": "other"}, {"labels": {"app.kubernetes.io/managed-by": "another-owner"}}):
            value = owned("scheduler"); value["metadata"].update(update)
            with self.assertRaises(activation.ActivationFailure): activation.owned(value, "scheduler", "scheduler")

    def test_config_requires_private_bound_smoke_and_distinct_non_api_worker_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            public = root / "public-deployment.json"
            public.write_text(json.dumps({"apiUrl": ORIGIN, "appOrigin": ORIGIN, "publishableKey": "private-anon-key"})); public.chmod(0o600)
            report = root / "production-smoke.json"; report.write_text(json.dumps(receipt())); report.chmod(0o600)
            values = configuration().runtime
            stored = owned("tenderdesk-runtime")
            stored["data"] = {key: base64.b64encode(value.encode()).decode() for key, value in values.items()}
            with patch.dict(os.environ, {**ENVIRONMENT, "DOKS_WORKDIR": directory}), patch.object(activation.smoke.Config, "load", return_value=configuration().public), patch.object(activation.deploy, "get", return_value=stored):
                loaded = activation.Config.load()
                self.assertEqual(loaded.hosts, ["example.test"])
                self.assertNotIn(values["APP_WORKER_SECRET"], repr(loaded))
                for replacement in ("short", "private-service-key", values["APP_NATIVE_WORKER_SECRET"]):
                    stored["data"]["APP_WORKER_SECRET"] = base64.b64encode(replacement.encode()).decode()
                    with self.assertRaises(activation.ActivationFailure): activation.Config.load()
                stored["data"]["APP_WORKER_SECRET"] = base64.b64encode(values["APP_WORKER_SECRET"].encode()).decode()
                public.write_text(json.dumps({"apiUrl": "http://app.example.test", "appOrigin": "http://app.example.test", "publishableKey": "private-anon-key"}))
                with self.assertRaises(activation.smoke.SmokeFailure): activation.Config.load()

    def test_empty_target_accepts_configured_profiles_but_rejects_any_work_admission_or_business_rows(self):
        worker = self.instance(); values = empty_rows()
        with patch.object(worker, "rows", side_effect=lambda table, *_: values[table]):
            self.assertIsNone(worker.empty_target())
            self.assertEqual(worker.workspace_id, WORKSPACE)
        for table in activation.EMPTY_TABLES:
            values = empty_rows(); values[table] = [{"id": "fixture"}]
            worker = self.instance()
            with self.subTest(table=table), patch.object(worker, "rows", side_effect=lambda table, *_: values[table]), self.assertRaisesRegex(activation.ActivationFailure, "BUSINESS_DATA_NOT_EMPTY"):
                worker.empty_target()
        for table in ("workspaces", "model_execution_settings", "model_routing", "model_settings"):
            values = empty_rows(); values[table][0]["model_enabled" if table == "workspaces" else "enabled"] = "false" if table == "model_settings" else True
            worker = self.instance()
            with self.subTest(table=table), patch.object(worker, "rows", side_effect=lambda table, *_: values[table]), self.assertRaises(activation.ActivationFailure): worker.empty_target()
        worker = self.instance(); worker.workspace_id = "20000000-0000-4000-8000-000000000002"; values = empty_rows()
        with patch.object(worker, "rows", side_effect=lambda table, *_: values[table]), self.assertRaisesRegex(activation.ActivationFailure, "IDENTITY_CHANGED"):
            worker.empty_target()

    def test_workload_guard_requires_owned_immutable_runtime_and_native_identity_routes(self):
        objects = resource_inventory(); worker = self.instance()
        with patch.object(activation.deploy, "get", side_effect=lambda kind, name: objects[(kind, name)]): worker.workloads()
        self.assertEqual(set(worker.cronjobs), {"browser", "ocr"})
        for kind, name, mutate in (
            ("deployment", "worker", lambda value: value["metadata"].update(namespace="foreign")),
            ("deployment", "scheduler", lambda value: value["spec"]["template"]["spec"]["containers"][0].update(image=activation.REGISTRY + "runtime:latest")),
            ("cronjob", "native-browser", lambda value: value["spec"].update(concurrencyPolicy="Allow")),
            ("cronjob", "native-ocr", lambda value: value["spec"]["jobTemplate"]["spec"]["template"]["spec"]["containers"][0]["env"][0].update(value="https://foreign.example.test/functions/v1/source-browser")),
        ):
            changed = deepcopy(objects); mutate(changed[(kind, name)])
            with self.subTest(kind=kind, name=name), patch.object(activation.deploy, "get", side_effect=lambda kind, name: changed[(kind, name)]), self.assertRaises(activation.ActivationFailure): self.instance().workloads()

    def test_private_probes_send_credentials_only_through_stdin_and_require_exact_denial_success(self):
        for component in ("worker", "source-browser"):
            worker = self.instance(); native = component == "source-browser"
            with patch.object(activation.deploy, "command", return_value=json.dumps({"denied": 401, "allowed": 200, "empty": True, "native": native})) as command:
                worker.private_probe(component)
                args, kwargs = command.call_args
                key = "APP_NATIVE_WORKER_SECRET" if native else "APP_WORKER_SECRET"
                secret = worker.config.runtime[key]
                self.assertNotIn(secret, json.dumps(args))
                self.assertEqual(json.loads(kwargs["payload"]), {"native": native, "secret": secret})
                self.assertIn("denied.status!==401", args[0][-1])
            for response in ("untrusted raw output", json.dumps({"denied": 200, "allowed": 200, "empty": True, "native": native}), json.dumps({"denied": 401, "allowed": 202, "empty": True, "native": native})):
                with patch.object(activation.deploy, "command", return_value=response), self.assertRaisesRegex(activation.ActivationFailure, "PRIVATE_WORKER_AUTHENTICATION"):
                    self.instance().private_probe(component)

    def test_guard_failure_prevents_dispatcher_and_scheduler_or_native_mutations(self):
        for guard in ("workloads", "empty_target"):
            worker = self.instance()
            with patch.object(worker, "workloads"), patch.object(worker, "empty_target"), patch.object(worker, guard, side_effect=activation.ActivationFailure("GUARD_FAILED")), patch.object(worker, "configure") as configure, patch.object(worker, "scheduler") as scheduler, patch.object(worker, "native_schedules") as native, patch.object(worker, "pause_after_failure") as pause, self.assertRaisesRegex(activation.ActivationFailure, "GUARD_FAILED"):
                worker.run()
            configure.assert_not_called(); scheduler.assert_not_called(); native.assert_not_called(); pause.assert_not_called()

    def test_post_change_failure_pauses_maintenance_and_always_cleans_verification_jobs(self):
        worker = self.instance(); calls = []
        def configure(): worker.changed = True; calls.append("configure")
        with patch.object(worker, "workloads"), patch.object(worker, "empty_target", return_value=None), patch.object(worker, "configure", side_effect=configure), patch.object(worker, "private_probe", side_effect=activation.ActivationFailure("WORKER_FAILED")), patch.object(worker, "pause_after_failure", side_effect=lambda: calls.append("pause")), patch.object(worker, "cleanup_jobs", side_effect=lambda: calls.append("cleanup")), patch.object(worker, "native_schedules") as native, self.assertRaisesRegex(activation.ActivationFailure, "WORKER_FAILED"):
            worker.run()
        self.assertEqual(calls, ["configure", "pause", "cleanup"])
        native.assert_not_called()

    def test_heartbeat_requires_fresh_advancing_owned_workspace_and_enabled_scheduler(self):
        worker = self.instance(); worker.workspace_id = WORKSPACE
        now = time.time(); advanced = datetime.fromtimestamp(now, timezone.utc).isoformat()
        value = [{"workspace_id": WORKSPACE, "last_heartbeat_at": advanced, "scheduler_enabled": True}]
        with patch.object(worker, "rows", return_value=value): self.assertGreater(worker.heartbeat(now - 1, timeout=0), now - 1)
        for update in ({"last_heartbeat_at": datetime.fromtimestamp(now - 1000, timezone.utc).isoformat()}, {"scheduler_enabled": False}, {"workspace_id": "other"}):
            candidate = deepcopy(value); candidate[0].update(update)
            with patch.object(worker, "rows", return_value=candidate), self.assertRaises(activation.ActivationFailure): worker.heartbeat(now - 1, timeout=0)
        with patch.object(worker, "rows", return_value=value), self.assertRaisesRegex(activation.ActivationFailure, "DID_NOT_ADVANCE"):
            worker.heartbeat(now + 1, timeout=0)

    def test_schedules_patch_only_activation_fields_and_verify_idempotently(self):
        worker = self.instance(); objects = resource_inventory(); patches = []
        def command(args, **_):
            if args[0] == "patch":
                patch_value = json.loads(args[args.index("--patch") + 1]); patches.append((args[1:3], patch_value))
                if args[1] == "cronjob": objects[("cronjob", args[2])]["spec"].update(patch_value["spec"])
            return ""
        with patch.object(activation.deploy, "get", side_effect=lambda kind, name: objects[(kind, name)]), patch.object(activation.deploy, "command", side_effect=command):
            worker.scheduler(True); worker.native_schedules(True); worker.native_schedules(True)
        scheduler_patch = patches[0][1]
        self.assertEqual(scheduler_patch["spec"]["template"]["spec"]["containers"], [{"name": "scheduler", "env": [{"name": "APP_SCHEDULER_ENABLED", "value": "true"}]}])
        for _, value in patches[1:]: self.assertEqual(value, {"spec": {"suspend": False, "schedule": "*/5 * * * *"}})
        self.assertTrue(all(objects[("cronjob", "native-" + name)]["spec"]["suspend"] is False for name in ("browser", "ocr")))

    def test_cleanup_refuses_replaced_job_uid_and_still_tries_other_job(self):
        worker = self.instance()
        first = "activation-native-browser-1-1"; second = "activation-native-ocr-1-1"
        worker.jobs = {first: "original-first", second: "original-second"}
        values = {}
        for name in (first, second):
            value = owned(name); value["metadata"]["uid"] = "replacement" if name == first else "original-second"
            value["metadata"]["labels"].update({"tenderdesk.io/run-id": worker.config.run_id, "tenderdesk.io/run-attempt": worker.config.attempt})
            values[name] = value
        with patch.object(activation.deploy, "get", side_effect=lambda _kind, name: values[name]), patch.object(activation.deploy, "command") as command:
            worker.cleanup_jobs()
        self.assertEqual(worker.cleanup_failures, ["NATIVE_VERIFICATION_CLEANUP_NOT_CONFIRMED"])
        self.assertEqual(worker.jobs, {first: "original-first"})
        self.assertEqual(command.call_args.args[0][:3], ["delete", "job", second])
        self.assertEqual(command.call_count, 1)

    def test_success_verifies_manual_and_relay_heartbeats_and_native_images_before_unsuspending_schedules(self):
        worker = self.instance(); calls = []
        def record(name, result=None):
            def call(*args, **kwargs):
                calls.append((name, args, kwargs)); return result
            return call
        with patch.object(worker, "workloads", side_effect=record("workloads")), \
             patch.object(worker, "empty_target", side_effect=record("empty", None)), \
             patch.object(worker, "configure", side_effect=record("configure")), \
             patch.object(worker, "private_probe", side_effect=record("private_probe")), \
             patch.object(worker, "heartbeat", side_effect=[100.0, 101.0]) as heartbeat, \
             patch.object(worker, "scheduler", side_effect=record("scheduler")), \
             patch.object(worker, "verify_native_images", side_effect=record("verify_native_images")), \
             patch.object(worker, "native_schedules", side_effect=record("native_schedules")), \
             patch.object(worker, "cleanup_jobs", side_effect=record("cleanup")):
            worker.run()
        self.assertEqual([item[0] for item in calls], ["workloads", "empty", "configure", "private_probe", "private_probe", "scheduler", "empty", "verify_native_images", "empty", "native_schedules", "cleanup"])
        self.assertEqual([item[1] for item in calls if item[0] == "private_probe"], [("worker",), ("source-browser",)])
        self.assertEqual(heartbeat.call_args_list[0].args, (None,))
        self.assertEqual(heartbeat.call_args_list[0].kwargs, {"timeout": 15})
        self.assertEqual(heartbeat.call_args_list[1].args, (100.0,))
        self.assertEqual(next(item[1] for item in calls if item[0] == "native_schedules"), (True,))

    def test_unconfirmed_cleanup_never_reports_success_and_pauses_new_maintenance(self):
        worker = self.instance()
        def cleanup(): worker.cleanup_failures.append("CLEANUP_FAILED")
        with patch.object(worker, "workloads"), patch.object(worker, "empty_target"), \
             patch.object(worker, "configure"), patch.object(worker, "private_probe"), \
             patch.object(worker, "heartbeat", return_value=time.time()), patch.object(worker, "scheduler"), \
             patch.object(worker, "verify_native_images"), patch.object(worker, "native_schedules"), \
             patch.object(worker, "cleanup_jobs", side_effect=cleanup), patch.object(worker, "pause_after_failure") as pause:
            with self.assertRaisesRegex(activation.ActivationFailure, "ACTIVATION_CLEANUP_NOT_CONFIRMED"):
                worker.run()
        pause.assert_called_once()

    def test_ambiguous_native_job_create_is_tracked_and_cleanup_recovers_only_owned_current_attempt(self):
        for foreign in (False, True):
            worker = self.instance()
            worker.cronjobs = {name: resource_inventory()[("cronjob", "native-" + name)] for name in ("browser", "ocr")}
            state = {}; commands = []
            def get(_kind, name): return state.get(name)
            def command(args, **kwargs):
                commands.append(args)
                if args[0] == "create":
                    value = json.loads(kwargs["payload"])
                    value["metadata"]["uid"] = "created-before-client-timeout"
                    if foreign: value["metadata"]["labels"]["tenderdesk.io/run-attempt"] = "999"
                    state[value["metadata"]["name"]] = value
                    raise activation.deploy.DeployError("KUBERNETES_COMMAND_TIMEOUT")
                if args[0] == "delete": state.pop(args[2])
                return ""
            with self.subTest(foreign=foreign), patch.object(activation.deploy, "get", side_effect=get), patch.object(activation.deploy, "command", side_effect=command):
                with self.assertRaises(activation.deploy.DeployError): worker.verify_native_images()
                self.assertEqual(len(worker.jobs), 1)
                self.assertIsNone(next(iter(worker.jobs.values())))
                worker.cleanup_jobs()
            self.assertEqual(commands[0], ["create", "-f", "-"])
            if foreign:
                self.assertEqual(len(worker.jobs), 1)
                self.assertEqual(worker.cleanup_failures, ["NATIVE_VERIFICATION_CLEANUP_NOT_CONFIRMED"])
                self.assertEqual(len(commands), 1)
            else:
                self.assertEqual(worker.jobs, {})
                self.assertEqual(worker.cleanup_failures, [])
                self.assertEqual(commands[1][:2], ["delete", "job"])
                self.assertEqual(state, {})

    def test_scheduler_patch_refuses_foreign_workload_before_any_mutation(self):
        foreign = owned("scheduler"); foreign["metadata"]["labels"]["app.kubernetes.io/managed-by"] = "foreign"
        with patch.object(activation.deploy, "get", return_value=foreign), patch.object(activation.deploy, "command") as command:
            with self.assertRaisesRegex(activation.ActivationFailure, "NOT_OWNED"): self.instance().scheduler(True)
        command.assert_not_called()

    def test_public_failures_and_representations_never_include_credentials(self):
        config = configuration()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            activation.emit("failed", [], code="FIXED_ERROR", cleanup_failures=["FIXED_CLEANUP"])
        for secret in (config.runtime["APP_WORKER_SECRET"], config.runtime["APP_NATIVE_WORKER_SECRET"], config.public.service_key, config.public.anon_key):
            self.assertNotIn(secret, repr(config)); self.assertNotIn(secret, output.getvalue())
        result = json.loads(output.getvalue())
        self.assertFalse(result["source_project_deleted"])
        self.assertFalse(result["external_processing_enabled"])


if __name__ == "__main__":
    unittest.main()
