"""Credential synchronization guards using local synthetic values only."""
from contextlib import ExitStack, redirect_stdout
import base64
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("tested_provider_sync", Path(__file__).with_name("sync-provider-credentials.py"))
s = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = s
SPEC.loader.exec_module(s)
KEY = "APP_MODEL_OPENAI_KEY"
OTHER = "APP_MODEL_CUSTOM_ACCOUNT_KEY"


def resource(name):
    return {"metadata": {"name": name, "namespace": s.d.NAMESPACE, "resourceVersion": "1", "generation": 1,
                         "labels": {"app.kubernetes.io/managed-by": "tenderdesk-deployment"}}}


def workload(name):
    value = resource(name)
    value["spec"] = {"replicas": 1, "template": {"metadata": {"labels": {"keep": "unchanged"}, "annotations": {"existing": "retained"}},
        "spec": {"containers": [{"name": name, "image": "offline.example/runtime@sha256:" + "a" * 64,
             "env": [{"name": "APP_RUNTIME_SERVICE", "value": name}], "envFrom": [{"secretRef": {"name": s.SECRET}}]}],
             "terminationGracePeriodSeconds": 240}}}
    value["status"] = {"readyReplicas": 1, "updatedReplicas": 1, "observedGeneration": 1}
    return value


class ProviderSyncTests(unittest.TestCase):
    def setUp(self):
        secret = resource(s.SECRET)
        secret.update(type="Opaque", data={name: base64.b64encode(value.encode()).decode() for name, value in {
            "APP_WORKER_SECRET": "synthetic-worker-credential", OTHER: "synthetic-preserved-key", "APP_SMTP_PASSWORD": "synthetic-smtp"}.items()})
        self.resources = {("namespace", s.d.NAMESPACE): resource(s.d.NAMESPACE), ("secret", s.SECRET): secret}
        self.resources.update({("deployment", name): workload(name) for name in s.COMPONENTS})
        self.environments = {name: {OTHER: "synthetic-preserved-key"} for name in s.COMPONENTS}
        self.calls = []
        self.conflict = False
        self.reload = True

    def get(self, kind, name):
        return copy.deepcopy(self.resources.get((kind, name)))

    def command(self, args, *, payload=None, **kwargs):
        self.calls.append((copy.deepcopy(args), payload))
        if args[0] == "exec":
            name = args[2].split("/")[1]
            self.assertEqual(args[-1], s.ENVIRONMENT_CHECK)
            expected = json.loads(payload)
            return json.dumps({key: self.environments[name].get(key) == value for key, value in expected.items()})
        self.assertEqual(args[0], "patch")
        self.assertIn("--patch-file=/dev/stdin", args)
        self.assertNotIn("--patch", args)
        kind, name = args[1:3]
        current = self.resources[kind, name]
        if self.conflict and kind == "secret":
            raise s.d.DeployError("KUBERNETES_COMMAND_FAILED")
        for operation in json.loads(payload):
            fields = operation["path"].split("/")[1:]
            target = current
            for field in fields[:-1]:
                target = target[field]
            if operation["op"] == "test":
                self.assertEqual(target[fields[-1]], operation["value"])
            else:
                self.assertEqual(operation["op"], "add")
                target[fields[-1]] = operation["value"]
        current["metadata"]["resourceVersion"] = str(int(current["metadata"]["resourceVersion"]) + 1)
        if kind == "deployment" and self.reload:
            self.environments[name] = s.d.decode_secret(self.resources["secret", s.SECRET])
        return ""

    def context(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(s.d, "get", side_effect=self.get))
        stack.enter_context(patch.object(s.d, "command", side_effect=self.command))
        stack.enter_context(patch.object(s.d, "wait_deployments"))

    def test_merges_supplied_keys_preserves_other_keys_and_updates_only_two_consumers(self):
        self.context()
        before = copy.deepcopy(self.resources)
        output = io.StringIO()
        with redirect_stdout(output):
            report = s.sync({KEY: "synthetic-new-api-key", OTHER: "", "DIGITALOCEAN_ACCESS_TOKEN": "must-not-copy"}, {KEY, OTHER})
        self.assertEqual(report["keys_updated"], 1)
        self.assertEqual(report["restarted"], ["api", "worker"])
        current = s.d.decode_secret(self.resources["secret", s.SECRET])
        self.assertEqual(current[KEY], "synthetic-new-api-key")
        self.assertEqual(current[OTHER], "synthetic-preserved-key")
        self.assertEqual(current["APP_WORKER_SECRET"], "synthetic-worker-credential")
        self.assertEqual(current["APP_SMTP_PASSWORD"], "synthetic-smtp")
        self.assertNotIn("DIGITALOCEAN_ACCESS_TOKEN", current)
        self.assertNotIn("synthetic-new-api-key", output.getvalue() + json.dumps(report))
        for args, payload in self.calls:
            self.assertNotIn("synthetic-new-api-key", json.dumps(args))
        for name in s.COMPONENTS:
            spec = self.resources["deployment", name]["spec"]
            self.assertEqual(spec["template"]["spec"], before["deployment", name]["spec"]["template"]["spec"])
            self.assertEqual(spec["template"]["metadata"]["annotations"]["existing"], "retained")
            token = spec["template"]["metadata"]["annotations"][s.ANNOTATION]
            self.assertRegex(token, r"^[a-f0-9]{32}$")

    def test_replay_is_idempotent_without_restarting_up_to_date_processes(self):
        self.context()
        s.sync({KEY: "synthetic-new-api-key"}, {KEY, OTHER})
        self.calls.clear()
        report = s.sync({KEY: "synthetic-new-api-key"}, {KEY, OTHER})
        self.assertEqual(report["keys_updated"], 0)
        self.assertEqual(report["restarted"], [])
        self.assertFalse(any(args[0] == "patch" for args, _ in self.calls))

    def test_restart_preserves_a_workload_whose_template_had_no_annotations(self):
        self.context()
        for name in s.COMPONENTS:
            self.resources["deployment", name]["spec"]["template"]["metadata"].pop("annotations")
        report = s.sync({KEY: "synthetic-new-api-key"}, {KEY, OTHER})
        self.assertEqual(report["restarted"], ["api", "worker"])

    def test_preexisting_runtime_key_is_preserved_when_repository_binding_absent(self):
        self.context()
        before = copy.deepcopy(self.resources)
        report = s.sync({}, {KEY, OTHER})
        self.assertEqual(report["key_presence"], {OTHER: True, KEY: False})
        self.assertEqual(self.resources, before)
        self.assertEqual(report["restarted"], [])

    def test_resource_version_conflict_does_not_restart_or_reveal_secrets(self):
        self.context()
        self.conflict = True
        before = copy.deepcopy(self.resources)
        with self.assertRaises(s.d.DeployError):
            s.sync({KEY: "synthetic-new-api-key"}, {KEY, OTHER})
        self.assertEqual(before, self.resources)
        self.assertFalse(any(args[:2] == ["patch", "deployment"] for args, _ in self.calls))

    def test_foreign_workload_or_environment_override_refused_before_secret_mutation(self):
        for mode in ("foreign", "override", "unready"):
            with self.subTest(mode=mode):
                self.setUp()
                self.context()
                w = self.resources["deployment", "api"]
                if mode == "foreign": w["metadata"]["labels"] = {}
                elif mode == "override": w["spec"]["template"]["spec"]["containers"][0]["env"].append({"name": KEY, "value": "do-not-change"})
                else: w["status"]["readyReplicas"] = 0
                with self.assertRaises(s.SyncError): s.sync({KEY: "synthetic-new-api-key"}, {KEY, OTHER})
                self.assertEqual(self.calls, [])

    def test_a_stale_process_is_restarted_even_if_secret_already_has_correct_value(self):
        self.context()
        self.resources["secret", s.SECRET]["data"][KEY] = base64.b64encode(b"synthetic-new-api-key").decode()
        report = s.sync({KEY: "synthetic-new-api-key"}, {KEY, OTHER})
        self.assertEqual(report["keys_updated"], 0)
        self.assertEqual(report["restarted"], ["api", "worker"])

    def test_failed_environment_reload_cannot_be_reported_as_success(self):
        self.context()
        self.reload = False
        with self.assertRaisesRegex(s.SyncError, "PROVIDER_ENVIRONMENT_NOT_RELOADED"):
            s.sync({KEY: "synthetic-new-api-key"}, {KEY, OTHER})

    def test_dynamic_registry_accepts_new_provider_without_python_prefix_list(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ids, backend = root / "providers.ts", root / "backend.ts"
            ids.write_text('export const MODEL_PROVIDER_IDS = ["new-provider", "anthropic"] as const;')
            backend.write_text('const SECRET_PREFIX: Record<ModelProviderId, string> = {\n"new-provider": "APP_MODEL_NEW_VENDOR",\nanthropic: "APP_MODEL_CLAUDE",\n};')
            self.assertEqual(s.canonical_aliases(ids, backend), {"APP_MODEL_NEW_VENDOR_KEY", "APP_MODEL_CLAUDE_KEY"})
            ids.write_text('export const MODEL_PROVIDER_IDS = ["undeclared"] as const;')
            with self.assertRaisesRegex(s.SyncError, "PROVIDER_REGISTRY_PREFIX_MISMATCH"): s.canonical_aliases(ids, backend)

    def test_json_binding_discovery_ignores_non_model_secrets_and_rejects_invalid_shape(self):
        self.assertEqual(s.decode_bindings(json.dumps({KEY: "synthetic", "GITHUB_TOKEN": "must-ignore", "APP_SMTP_PASSWORD": "must-ignore"})), {KEY: "synthetic"})
        for raw in ("[]", "invalid", "null"):
            with self.assertRaises(s.SyncError): s.decode_bindings(raw)

    def test_main_pops_full_secret_environment_before_spawning_and_cleans_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory) / "private"
            private.mkdir()
            def prepare():
                self.assertNotIn("PROVIDER_SECRET_BINDINGS", os.environ)
                return private
            with patch.dict(os.environ, {"PROVIDER_SECRET_BINDINGS": json.dumps({KEY: "synthetic", "GITHUB_TOKEN": "ignored"})}), \
                 patch.object(s.access, "prepare_cluster", side_effect=prepare), \
                 patch.object(s, "discover_aliases", return_value={KEY}), \
                 patch.object(s, "sync", return_value={"provider_sync": "verified"}) as sync, redirect_stdout(io.StringIO()):
                self.assertEqual(s.main(), 0)
                sync.assert_called_once_with({KEY: "synthetic"}, {KEY})
            self.assertFalse(private.exists())

    def test_database_alias_discovery_is_read_only_and_admin_cleanup_is_unconditional(self):
        core = resource("tenderdesk-core")
        core["data"] = {"PGSSLCA": base64.b64encode(b"synthetic-ca").decode()}
        with patch.dict(os.environ, {"DIGITALOCEAN_ACCESS_TOKEN": "synthetic-token", "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}), \
             patch.object(s, "canonical_aliases", return_value={KEY}), \
             patch.object(s.d, "get", side_effect=lambda kind,name: None if name == "tenderdesk-migration-admin" else core), \
             patch.object(s.d.probe, "target_credentials", return_value=({"PGHOST": "synthetic-private"}, "synthetic-ca")), \
             patch.object(s.d, "sql_pod"), patch.object(s.d, "sql", return_value=json.dumps([OTHER])) as sql, \
             patch.object(s.d, "cleanup_administrator") as cleanup:
            self.assertEqual(s.discover_aliases(), {KEY, OTHER})
            self.assertIn("BEGIN READ ONLY", sql.call_args.args[1])
            cleanup.assert_called_once_with("migration-client-123-1")


if __name__ == "__main__": unittest.main()
