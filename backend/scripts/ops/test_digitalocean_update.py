"""Exercise existing-workspace provider updates without network or production data."""
from __future__ import annotations

import base64
import copy
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("digitalocean-update.py")
SPEC = importlib.util.spec_from_file_location("tested_provider_update", SCRIPT)
u = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = u
SPEC.loader.exec_module(u)
RUNTIME = u.REGISTRY + "runtime@sha256:" + "a" * 64
FRONTEND = u.REGISTRY + "frontend@sha256:" + "b" * 64


def resource(kind, name):
    return {"kind": kind, "metadata": {"name": name, "namespace": u.d.NAMESPACE, "resourceVersion": "1", "generation": 1,
             "labels": {"app.kubernetes.io/managed-by": "tenderdesk-deployment"}}}


def workload(name):
    value = resource("Deployment", name)
    value["spec"] = {"replicas": 1, "template": {"metadata": {"annotations": {"keep": "unchanged"}}, "spec": {
        "containers": [{"name": name, "image": u.REGISTRY + ("frontend" if name == "frontend" else "runtime") + "@sha256:" + "c" * 64,
                        "env": [{"name": "APP_SCHEDULER_ENABLED", "value": "true"}], "resources": {"requests": {"memory": "64Mi"}},
                        "envFrom": [{"secretRef": {"name": "tenderdesk-runtime"}}]}], "terminationGracePeriodSeconds": 240}}}
    value["status"] = {"observedGeneration": 1, "readyReplicas": 1, "updatedReplicas": 1}
    return value


class ExistingWorkspaceUpdateTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.resources = {("deployment", name): workload(name) for name in u.COMPONENTS}
        for name in ("native-browser", "native-ocr"):
            value = resource("CronJob", name)
            value["spec"] = {"schedule": "*/5 * * * *", "suspend": False, "jobTemplate": {"preserve": "native-image"}}
            self.resources["cronjob", name] = value
        value = resource("ConfigMap", "database-restoration")
        value["data"] = {"schema_sha256": "a" * 64, "seed_sha256": "b" * 64}
        self.resources["configmap", "database-restoration"] = value
        value = resource("ConfigMap", "frontend-config")
        self.public = {"apiUrl": "https://offline.example.test", "appOrigin": "https://offline.example.test", "publishableKey": "offline-anon"}
        value["data"] = {"runtime-config.js": "window.__TENDERDESK_CONFIG__ = " + json.dumps(self.public) + ";"}
        self.resources["configmap", "frontend-config"] = value
        value = resource("Secret", "tenderdesk-core")
        value["data"] = {key: base64.b64encode(text.encode()).decode() for key, text in {
            "PGSSLCA": "offline-ca", "ANON_KEY": "offline-anon", "SERVICE_KEY": "offline-service", "JWT_SECRET": "offline-signing"}.items()}
        self.resources["secret", "tenderdesk-core"] = value
        self.initial = copy.deepcopy(self.resources)
        self.patch_failure = False
        self.rollback_failure = False
        self.rollout_failure = False

    def get(self, kind, name):
        return copy.deepcopy(self.resources.get((kind, name)))

    def command(self, args, **kwargs):
        self.assertEqual(args[:2], ["patch", "deployment"])
        self.assertIn("--type=json", args)
        operations = json.loads(args[args.index("--patch") + 1])
        self.assertEqual([x["path"] for x in operations], ["/metadata/resourceVersion", "/spec/template/spec/containers/0/name", "/spec/template/spec/containers/0/image"])
        name, selected = args[2], operations[-1]["value"]
        value = self.resources["deployment", name]
        self.assertEqual(operations[0]["value"], value["metadata"]["resourceVersion"])
        self.assertEqual(operations[1]["value"], name)
        self.events.append(("image", name, selected))
        if self.rollback_failure and selected.endswith("c" * 64):
            raise u.d.DeployError("KUBERNETES_COMMAND_FAILED")
        value["spec"]["template"]["spec"]["containers"][0]["image"] = selected
        value["metadata"]["resourceVersion"] = str(int(value["metadata"]["resourceVersion"]) + 1)
        if self.patch_failure and name == "worker" and selected == RUNTIME:
            self.patch_failure = False
            raise u.d.DeployError("KUBERNETES_COMMAND_TIMEOUT")
        return ""

    def waits(self, names):
        self.events.append(("ready", tuple(names)))
        if self.rollout_failure:
            self.rollout_failure = False
            raise u.d.DeployError("APPLICATION_ROLLOUT_FAILED")

    def sql(self, pod, script, **kwargs):
        self.events.append(("migration" if "provider_update_snapshot" in script else "compatibility", script))
        return ""

    def context(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.dict(os.environ, {"TENDERDESK_RUNTIME_IMAGE": RUNTIME, "TENDERDESK_FRONTEND_IMAGE": FRONTEND,
                                                  "GITHUB_RUN_ID": "12345", "GITHUB_RUN_ATTEMPT": "1"}))
        values = [(u.d, "get", {"side_effect": self.get}), (u.d, "command", {"side_effect": self.command}),
                  (u.d.probe, "validate_cluster", {}), (u.d.probe, "target_credentials", {"return_value": ({"PGHOST": "offline-private"}, "offline-ca")}),
                  (u.d, "sql_pod", {"side_effect": lambda admin: self.events.append(("admin", set(admin)))}),
                  (u.d, "restore_state", {"return_value": {"stage": "seed", "schema_sha256": "a" * 64, "seed_sha256": "b" * 64}}),
                  (u.d, "sql", {"side_effect": self.sql}), (u.d, "wait_deployments", {"side_effect": self.waits}),
                  (u.d, "cleanup_administrator", {"side_effect": lambda pod: self.events.append(("cleanup", pod))}),
                  (u, "public_check", {"side_effect": lambda *args: self.events.append(("public",))}), (u, "emit", {})]
        return {name: stack.enter_context(patch.object(module, name, **kwargs)) for module, name, kwargs in values}

    def test_updates_images_only_after_transactional_data_preservation_and_cleans_admin(self):
        self.context()
        u.update()
        migration = next(i for i, value in enumerate(self.events) if value[0] == "migration")
        self.assertTrue(all(i > migration for i, value in enumerate(self.events) if value[0] == "image"))
        script = self.events[migration][1]
        self.assertIn("BEGIN ISOLATION LEVEL REPEATABLE READ", script)
        self.assertIn("PROVIDER_UPDATE_EXISTING_DATA_CHANGED", script)
        self.assertIn("pg_temp.provider_update_before", script)
        for name in u.COMPONENTS:
            self.assertEqual(u.without_image(self.resources["deployment", name]), u.without_image(self.initial["deployment", name]))
        for key in self.resources:
            if key[0] != "deployment":
                self.assertEqual(self.resources[key], self.initial[key])
        self.assertEqual(self.events[-1][0], "cleanup")

    def test_ambiguous_patch_or_rollout_failure_restores_original_images_and_preserves_schedules(self):
        for failure in ("patch_failure", "rollout_failure"):
            with self.subTest(failure=failure):
                self.setUp()
                self.context()
                setattr(self, failure, True)
                with self.assertRaises(u.d.DeployError):
                    u.update()
                for name in u.COMPONENTS:
                    self.assertEqual(self.resources["deployment", name]["spec"], self.initial["deployment", name]["spec"])
                self.assertEqual(self.events[-1][0], "cleanup")

    def test_sql_failure_never_changes_images_and_still_cleans_admin(self):
        mocks = self.context()
        mocks["sql"].side_effect = u.d.DeployError("MIGRATION_SQL_FAILED")
        with self.assertRaises(u.d.DeployError):
            u.update()
        self.assertFalse(any(value[0] == "image" for value in self.events))
        self.assertEqual(self.events[-1][0], "cleanup")

    def test_foreign_or_unready_workload_is_refused_before_admin_or_images(self):
        self.context()
        self.resources["deployment", "api"]["metadata"]["labels"] = {}
        with self.assertRaisesRegex(u.UpdateError, "OWNERSHIP"):
            u.update()
        self.assertEqual(self.events, [])
        self.resources["deployment", "api"] = workload("api")
        self.resources["deployment", "worker"]["status"]["readyReplicas"] = 0
        with self.assertRaisesRegex(u.UpdateError, "NOT_READY"):
            u.update()
        self.assertEqual(self.events, [])

    def test_missing_restoration_ca_or_mutated_configuration_fails_closed(self):
        mocks = self.context()
        mocks["restore_state"].return_value = None
        with self.assertRaisesRegex(u.UpdateError, "EXISTING_RESTORATION"):
            u.update()
        self.assertFalse(any(value[0] == "image" for value in self.events))
        self.assertEqual(self.events[-1][0], "cleanup")
        self.resources["deployment", "worker"]["spec"]["template"]["spec"]["containers"][0]["env"] = []
        with self.assertRaisesRegex(u.UpdateError, "CONFIGURATION_CHANGED"):
            u.patch_image("worker", RUNTIME, self.initial["deployment", "worker"])

    def test_rollback_failure_is_explicit_and_cleanup_is_still_attempted(self):
        self.context()
        self.rollout_failure = self.rollback_failure = True
        with self.assertRaisesRegex(u.UpdateError, "ROLLBACK_NOT_CONFIRMED"):
            u.update()
        self.assertEqual(self.events[-1][0], "cleanup")

    def test_immutable_images_are_scoped_to_the_owned_registry_repository(self):
        for invalid in ("runtime:latest", RUNTIME.replace("/runtime@", "/other@"), RUNTIME.replace("registry.digitalocean.com", "foreign.test")):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(u.UpdateError, "IMMUTABLE_IMAGE"):
                u.image(invalid, "runtime")

    def test_public_provider_chunks_config_and_health_are_checked_without_auth_or_inference(self):
        configuration = self.resources["configmap", "frontend-config"]
        core = {"ANON_KEY": "offline-anon", "SERVICE_KEY": "offline-service", "JWT_SECRET": "offline-signing"}
        responses = {"/": b'<script src="/assets/index-abc.js"></script>',
                     "/runtime-config.js": configuration["data"]["runtime-config.js"].encode(),
                     "/assets/index-abc.js": b'const deps=["assets/modelProviders-xyz.js"];import(`./Settings-def.js`)',
                     "/assets/Settings-def.js": b'import("./modelProviders-xyz.js")',
                     "/assets/modelProviders-xyz.js": b'"OpenRouter";"QwenCloud"',
                     "/functions/v1/api/v1/health": b'{}', "/functions/v1/api/v1/bootstrap": b'{}'}
        def request(path, **kwargs):
            self.assertNotIn("token", kwargs)
            return u.smoke.Response(401 if path.endswith("bootstrap") else 200, responses[path])
        with patch.object(u.smoke, "Client") as client, patch.object(u, "emit"):
            client.return_value.request.side_effect = request
            u.public_check(configuration, core)
            responses["/assets/modelProviders-xyz.js"] = b'"OpenRouter"'
            with self.assertRaisesRegex(u.UpdateError, "PROVIDER_FRONTEND_MISSING"):
                u.public_check(configuration, core)


if __name__ == "__main__":
    unittest.main()
