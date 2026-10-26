"""Guard private input, stable identities and bounded production diagnostics."""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.parse


SCRIPT = Path(__file__).with_name("digitalocean-deploy.py")
SPEC = importlib.util.spec_from_file_location("tested_digitalocean_deploy", SCRIPT)
deploy = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = deploy
SPEC.loader.exec_module(deploy)


def secret_object(values, *, owned=True):
    return {"metadata": {"labels": deploy.MARKER if owned else {"app.kubernetes.io/managed-by": "another-operator"}},
            "data": {key: base64.b64encode(value.encode()).decode() for key, value in values.items()}}


class BundleBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def bundle(self, *, manifest_change=None, extra_members=None, contents=None, mode=0o600):
        files = {"schema.sql": b"BEGIN; SELECT 1; COMMIT;", "seed.sql": b"BEGIN; SELECT 2; COMMIT;"}
        files.update(contents or {})
        manifest = {"database": deploy.DATABASE, "role_prefix": deploy.PREFIX,
                    "scope": "first-owner-and-configuration",
                    "sha256": {name: hashlib.sha256(value).hexdigest() for name, value in files.items()}}
        if manifest_change:
            manifest_change(manifest)
        files["manifest.json"] = json.dumps(manifest).encode()
        path = self.directory / ("bundle-" + str(len(list(self.directory.iterdir()))) + ".tar.gz")
        with tarfile.open(path, "w:gz") as archive:
            for name, value in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(value)
                archive.addfile(member, io.BytesIO(value))
            for member, value in extra_members or []:
                archive.addfile(member, io.BytesIO(value))
        path.chmod(mode)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        return path, digest

    def test_backend_root_and_reviewed_asset_paths_resolve(self):
        self.assertEqual(deploy.ROOT, SCRIPT.parents[2])
        self.assertTrue((deploy.ASSETS / "setup.sql").is_file())
        self.assertTrue((deploy.ROOT / "scripts/runtime/dispatcher.sql").is_file())

    def test_exact_private_bundle_is_verified_without_extracting(self):
        path, digest = self.bundle()
        with patch.object(tarfile.TarFile, "extractall", side_effect=AssertionError("No filesystem extraction")):
            files, manifest = deploy.verify_bundle(path, digest)
        self.assertEqual(set(files), {"schema.sql", "seed.sql", "manifest.json"})
        self.assertEqual(manifest["scope"], "first-owner-and-configuration")
        self.assertEqual(list(self.directory.iterdir()), [path])

    def test_wrong_bundle_digest_and_non_private_or_symlink_inputs_are_rejected(self):
        path, digest = self.bundle()
        for wrong in ("0" * 64, "not-a-digest", "a" * 65):
            with self.subTest(digest=wrong), self.assertRaisesRegex(deploy.DeployError, "PRIVATE_BUNDLE_DIGEST_MISMATCH"):
                deploy.verify_bundle(path, wrong)
        link = self.directory / "symlink.tar.gz"
        link.symlink_to(path)
        with self.assertRaisesRegex(deploy.DeployError, "PRIVATE_BUNDLE_FORMAT_REJECTED"):
            deploy.verify_bundle(link, digest)
        path.chmod(0o644)
        with self.assertRaisesRegex(deploy.DeployError, "PRIVATE_BUNDLE_FILE_PERMISSIONS_REQUIRED"):
            deploy.verify_bundle(path, digest)

    def test_duplicate_paths_traversal_and_archive_links_are_rejected(self):
        duplicate = tarfile.TarInfo("schema.sql")
        duplicate.size = 4
        outside = tarfile.TarInfo("../outside.sql")
        outside.size = 4
        symbolic = tarfile.TarInfo("seed.sql")
        symbolic.type = tarfile.SYMTYPE
        symbolic.linkname = "/outside"
        for member, value in ((duplicate, b"oops"), (outside, b"oops"), (symbolic, b"")):
            path, digest = self.bundle(extra_members=[(member, value)])
            with self.subTest(name=member.name, type=member.type), self.assertRaisesRegex(deploy.DeployError, "PRIVATE_BUNDLE_CONTENTS_REJECTED"):
                deploy.verify_bundle(path, digest)
        self.assertFalse((self.directory.parent / "outside.sql").exists())

    def test_scope_and_member_hash_shape_must_match_selected_deployment(self):
        cases = (
            (lambda m: m.update(database="defaultdb"), "PRIVATE_BUNDLE_SCOPE_MISMATCH"),
            (lambda m: m.update(role_prefix="foreign"), "PRIVATE_BUNDLE_SCOPE_MISMATCH"),
            (lambda m: m.update(scope="all-production-data"), "PRIVATE_BUNDLE_SCOPE_MISMATCH"),
            (lambda m: m.update(sha256=[]), "PRIVATE_BUNDLE_MANIFEST_REJECTED"),
            (lambda m: m["sha256"].update({"schema.sql": "invalid"}), "PRIVATE_BUNDLE_MANIFEST_REJECTED"),
            (lambda m: m["sha256"].update({"schema.sql": "0" * 64}), "PRIVATE_BUNDLE_MEMBER_DIGEST_MISMATCH"),
        )
        for mutation, code in cases:
            path, digest = self.bundle(manifest_change=mutation)
            with self.subTest(code=code), self.assertRaisesRegex(deploy.DeployError, code):
                deploy.verify_bundle(path, digest)

    def test_sql_encoding_is_checked_before_any_partial_database_restore(self):
        for value in (b"SELECT '\xff';", b"SELECT '\x00';"):
            path, digest = self.bundle(contents={"seed.sql": value})
            with self.subTest(value=value), self.assertRaisesRegex(deploy.DeployError, "PRIVATE_BUNDLE_SQL_ENCODING_REJECTED"):
                deploy.verify_bundle(path, digest)

    def test_wrong_bundle_prevents_all_cluster_actions(self):
        path, digest = self.bundle()
        with patch.object(deploy.probe, "validate_cluster") as cluster, patch.object(
            deploy, "ensure_namespace"
        ) as namespace, self.assertRaises(deploy.DeployError):
            deploy.deploy(argparse.Namespace(bundle=path, sha256="0" * 64))
        cluster.assert_not_called()
        namespace.assert_not_called()


class CredentialBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.credentials = {"PGHOST": "private-offline-test.db.ondigitalocean.com", "PGPORT": "25060"}
        self.ca = "offline-public-certificate"
        self.values = {"PGSSLCA": self.ca, "JWT_SECRET": "offline-signing-material-" + "s" * 40,
                       "AUTH_DB_PASSWORD": "offline:auth/@?#%-" + "a" * 40,
                       "STORAGE_DB_PASSWORD": "offline-storage-" + "b" * 40,
                       "REST_DB_PASSWORD": "offline-rest-" + "c" * 40}
        for key, suffix, password in (("AUTH_DATABASE_URL", "_authadmin", "AUTH_DB_PASSWORD"),
                                      ("STORAGE_DATABASE_URL", "_storageadmin", "STORAGE_DB_PASSWORD"),
                                      ("POSTGREST_DATABASE_URL", "_authenticator", "REST_DB_PASSWORD")):
            self.values[key] = deploy.uri(self.credentials, suffix, self.values[password])
        self.values["ANON_KEY"] = deploy.token(self.values["JWT_SECRET"], deploy.PREFIX + "_anon")
        self.values["SERVICE_KEY"] = deploy.token(self.values["JWT_SECRET"], deploy.PREFIX + "_service")

    def reuse(self, values):
        with patch.object(deploy, "get", return_value=secret_object(values)), patch.object(deploy, "put_secret") as put:
            result = deploy.core_credentials(self.credentials, self.ca)
            put.assert_not_called()
            return result

    def test_repeat_deployment_reuses_passwords_and_signing_keys_exactly(self):
        self.assertEqual(self.reuse(self.values), self.values)
        parsed = urllib.parse.urlsplit(self.values["AUTH_DATABASE_URL"])
        self.assertEqual(urllib.parse.unquote(parsed.password), self.values["AUTH_DB_PASSWORD"])
        self.assertEqual(urllib.parse.parse_qs(parsed.query), {
            "sslmode": ["verify-full"], "sslrootcert": ["/run/db-ca/ca.crt"]})

    def test_reuse_refuses_changed_host_role_database_port_password_scheme_or_tls(self):
        original = self.values["AUTH_DATABASE_URL"]
        variants = (
            original.replace("private-offline-test", "private-other"),
            original.replace("tdp_app_authadmin", "tdp_app_owner"),
            original.replace("/tenderdesk_app?", "/defaultdb?"),
            original.replace(":25060/", ":5432/"),
            original.replace("postgresql://", "http://"),
            original.replace("sslmode=verify-full", "sslmode=require"),
            original.replace("sslrootcert=%2Frun%2Fdb-ca%2Fca.crt", "sslrootcert=%2Ftmp%2Fother.crt"),
            original + "&sslmode=disable",
            original.replace(urllib.parse.quote(self.values["AUTH_DB_PASSWORD"], safe=""), "wrong-password"),
        )
        for uri in variants:
            with self.subTest(uri_without_password=uri.rsplit("@", 1)[-1]), self.assertRaisesRegex(
                deploy.DeployError, "EXISTING_CORE_DATABASE_IDENTITY_CHANGED"
            ):
                self.reuse({**self.values, "AUTH_DATABASE_URL": uri})

    def test_reuse_refuses_different_ca_and_privileged_or_wrongly_signed_public_keys(self):
        for changes, code in (
            ({"PGSSLCA": "another-public-ca"}, "EXISTING_CORE_DATABASE_CA_CHANGED"),
            ({"ANON_KEY": self.values["SERVICE_KEY"]}, "EXISTING_CORE_API_KEY_INVALID"),
            ({"ANON_KEY": deploy.token("different-signing-key", deploy.PREFIX + "_anon")}, "EXISTING_CORE_API_KEY_INVALID"),
            ({"SERVICE_KEY": self.values["ANON_KEY"]}, "EXISTING_CORE_API_KEY_INVALID"),
            ({"ANON_KEY": "malformed"}, "EXISTING_CORE_API_KEY_INVALID"),
        ):
            with self.subTest(fields=list(changes)), self.assertRaisesRegex(deploy.DeployError, code):
                self.reuse({**self.values, **changes})

    def test_fresh_credentials_have_distinct_passwords_and_scoped_signed_roles(self):
        with patch.object(deploy, "get", return_value=None), patch.object(deploy, "put_secret") as put:
            values = deploy.core_credentials(self.credentials, self.ca)
        self.assertEqual(set(values), deploy.CORE_KEYS)
        self.assertEqual(len({values[key] for key in ("AUTH_DB_PASSWORD", "STORAGE_DB_PASSWORD", "REST_DB_PASSWORD")}), 3)
        deploy.verify_api_key(values["ANON_KEY"], values["JWT_SECRET"], deploy.PREFIX + "_anon")
        deploy.verify_api_key(values["SERVICE_KEY"], values["JWT_SECRET"], deploy.PREFIX + "_service")
        put.assert_called_once_with("tenderdesk-core", values)

    def test_runtime_worker_secrets_preserve_identity_and_only_explicit_provider_values_update(self):
        existing = {"APP_WORKER_SECRET": "offline-worker-" + "a" * 40,
                    "APP_NATIVE_WORKER_SECRET": "offline-native-" + "b" * 40,
                    "APP_MODEL_GEMINI_KEY": "offline-existing-provider"}
        with patch.object(deploy, "get", return_value=secret_object(existing)), patch.object(
            deploy, "put_secret"
        ), patch.dict(os.environ, {"APP_MODEL_GEMINI_KEY": "", "APP_MODEL_GROQ_KEY": "offline-new-provider",
                                   "UNRELATED_TOKEN": "offline-must-not-copy"}, clear=True):
            actual = deploy.runtime_credentials()
        self.assertEqual(actual["APP_WORKER_SECRET"], existing["APP_WORKER_SECRET"])
        self.assertEqual(actual["APP_NATIVE_WORKER_SECRET"], existing["APP_NATIVE_WORKER_SECRET"])
        self.assertEqual(actual["APP_MODEL_GEMINI_KEY"], existing["APP_MODEL_GEMINI_KEY"])
        self.assertEqual(actual["APP_MODEL_GROQ_KEY"], "offline-new-provider")
        self.assertNotIn("UNRELATED_TOKEN", actual)
        with patch.object(deploy, "get", return_value=secret_object({**existing, "APP_WORKER_SECRET": ""})), patch.object(
            deploy, "put_secret"
        ) as put, self.assertRaisesRegex(deploy.DeployError, "EXISTING_RUNTIME_WORKER_SECRET_INVALID"):
            deploy.runtime_credentials()
        put.assert_not_called()

    def test_auth_smtp_sender_uses_parsed_mailbox_and_readable_sender(self):
        with patch.object(deploy, "get", return_value=None), patch.object(deploy, "put_secret"), patch.dict(
            os.environ, {"APP_SMTP_FROM": "TenderDesk Operations <sender@example.test>"}, clear=True
        ):
            values = deploy.runtime_credentials()
        self.assertEqual(values["AUTH_SMTP_ADMIN_EMAIL"], "sender@example.test")
        self.assertEqual(values["AUTH_SMTP_SENDER_NAME"], "TenderDesk Operations")
        with patch.object(deploy, "get", return_value=None), patch.object(deploy, "put_secret"), patch.dict(
            os.environ, {"APP_SMTP_FROM": "<>"}, clear=True
        ):
            values = deploy.runtime_credentials()
        self.assertNotIn("AUTH_SMTP_ADMIN_EMAIL", values)

    def test_foreign_secrets_cannot_be_reused_or_overwritten(self):
        foreign = secret_object(self.values, owned=False)
        with patch.object(deploy, "get", return_value=foreign), patch.object(deploy, "apply") as apply:
            with self.assertRaisesRegex(deploy.DeployError, "EXISTING_SECRET_NOT_OWNED_BY_DEPLOYMENT"):
                deploy.core_credentials(self.credentials, self.ca)
            with self.assertRaisesRegex(deploy.DeployError, "EXISTING_SECRET_NOT_OWNED_BY_DEPLOYMENT"):
                deploy.put_secret("tenderdesk-migration-admin", {"PGPASSWORD": "offline-private"})
        apply.assert_not_called()

    def test_runtime_secret_updates_restart_only_consuming_deployments_without_serializing_values(self):
        worker = {"kind": "Deployment", "spec": {"template": {"spec": {"containers": [
            {"envFrom": [{"secretRef": {"name": "tenderdesk-runtime"}}]}]}}}}
        frontend = {"kind": "Deployment", "spec": {"template": {"spec": {"containers": [{"name": "frontend"}]}}}}
        private = "offline-new-private-provider-token"
        deploy.secret_rollout_revision([worker, frontend], self.values, {"APP_MODEL_GEMINI_KEY": private})
        first = worker["spec"]["template"]["metadata"]["annotations"]["tenderdesk.io/secret-revision"]
        self.assertRegex(first, r"^[a-f0-9]{64}$")
        self.assertNotIn("metadata", frontend["spec"]["template"])
        self.assertNotIn(private, json.dumps([worker, frontend]))
        deploy.secret_rollout_revision([worker, frontend], self.values, {"APP_MODEL_GEMINI_KEY": private + "changed"})
        self.assertNotEqual(first, worker["spec"]["template"]["metadata"]["annotations"]["tenderdesk.io/secret-revision"])


class NamespaceAndLogBoundaryTests(unittest.TestCase):
    def test_foreign_namespace_is_refused_even_when_no_workloads_are_visible(self):
        for value in ({"metadata": {"labels": {}}}, {"metadata": {"labels": {"app.kubernetes.io/managed-by": "foreign"}}}):
            with self.subTest(value=value), patch.object(deploy, "get", return_value=value), patch.object(
                deploy, "command"
            ) as command, patch.object(deploy, "apply") as apply, self.assertRaisesRegex(
                deploy.DeployError, "EXISTING_NAMESPACE_NOT_OWNED_BY_DEPLOYMENT"
            ):
                deploy.ensure_namespace()
            command.assert_not_called()
            apply.assert_not_called()

    def test_namespace_created_with_marker_and_owned_namespace_is_not_recreated(self):
        with patch.object(deploy, "get", return_value=None), patch.object(deploy, "apply") as apply:
            deploy.ensure_namespace()
        created = apply.call_args.args[0]
        self.assertEqual(created["metadata"]["labels"]["app.kubernetes.io/managed-by"], "tenderdesk-deployment")
        self.assertEqual(created["metadata"]["labels"]["pod-security.kubernetes.io/enforce"], "restricted")
        with patch.object(deploy, "get", return_value=created), patch.object(deploy, "apply") as apply:
            deploy.ensure_namespace()
        apply.assert_not_called()

    def test_foreign_same_name_resource_prevents_entire_batch_apply(self):
        objects = [{"apiVersion": "v1", "kind": "Service", "metadata": {"name": "first"}},
                   {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "second"}}]
        with patch.object(deploy, "get", side_effect=[None, {"metadata": {"labels": {}}}]), patch.object(
            deploy, "apply"
        ) as apply, self.assertRaisesRegex(deploy.DeployError, "EXISTING_APPLICATION_RESOURCE_NOT_OWNED"):
            deploy.apply_managed(objects)
        apply.assert_not_called()

    def test_registry_pull_secret_uses_read_only_credential_and_dockerconfig_type(self):
        raw = b'{"auths":{"registry.digitalocean.com":{"auth":"offline-private-token"}}}'
        with patch.object(deploy, "get", return_value=None), patch.object(
            deploy.runner, "docker_credentials", return_value=raw
        ) as credentials, patch.object(deploy, "apply") as apply:
            deploy.registry_pull_secret()
        credentials.assert_called_once_with(write_access=False)
        value = apply.call_args.args[0]
        self.assertEqual(value["type"], "kubernetes.io/dockerconfigjson")
        self.assertEqual(value["metadata"]["name"], "tenderdesk-registry")
        self.assertEqual(base64.b64decode(value["data"][".dockerconfigjson"]), raw)

    def test_cleanup_attempts_secret_removal_even_if_sql_pod_delete_fails(self):
        owned = {"metadata": {"labels": deploy.MARKER}}
        with patch.object(deploy, "get", return_value=owned), patch.object(
            deploy, "command", side_effect=[deploy.DeployError("KUBERNETES_COMMAND_FAILED"), ""]
        ) as command, patch.object(deploy, "emit") as emit, self.assertRaisesRegex(
            deploy.DeployError, "ADMINISTRATOR_CLEANUP_NOT_CONFIRMED"
        ):
            deploy.cleanup_administrator("offline-sql-pod")
        self.assertEqual(command.call_count, 2)
        self.assertEqual(command.call_args_list[0].args[0][:3], ["delete", "pod", "offline-sql-pod"])
        self.assertEqual(command.call_args_list[1].args[0][:3], ["delete", "secret", "tenderdesk-migration-admin"])
        for call in command.call_args_list:
            self.assertIn("--wait=true", call.args[0])
        emit.assert_called_once_with("administrator_cleanup_failed", component="sql_client")

    def test_cleanup_refuses_foreign_resources_without_deleting_them(self):
        with patch.object(deploy, "get", return_value={"metadata": {"labels": {}}}), patch.object(
            deploy, "command"
        ) as command, patch.object(deploy, "emit"), self.assertRaisesRegex(
            deploy.DeployError, "ADMINISTRATOR_CLEANUP_NOT_CONFIRMED"
        ):
            deploy.cleanup_administrator("offline-sql-pod")
        command.assert_not_called()

    def test_subprocess_failures_never_relay_private_stderr_or_stdout(self):
        private = "offline-sensitive-password-should-never-be-printed"
        result = subprocess.CompletedProcess([], 1, stdout=private, stderr=private)
        with patch.dict(os.environ, {"KUBECTL": "/offline/kubectl"}), patch.object(
            subprocess, "run", return_value=result
        ), self.assertRaisesRegex(deploy.DeployError, "KUBERNETES_COMMAND_FAILED") as caught:
            deploy.command(["get", "secrets"])
        self.assertNotIn(private, str(caught.exception))

    def test_sql_diagnostics_emit_only_sqlstate_and_line(self):
        private = "offline-sensitive-provider-key"
        result = subprocess.CompletedProcess([], 1, stdout=private,
            stderr="psql:<stdin>:127: ERROR: 42501: permission denied " + private)
        with patch.dict(os.environ, {"KUBECTL": "/offline/kubectl"}), patch.object(
            subprocess, "run", return_value=result
        ), patch.object(deploy, "emit") as emit, self.assertRaisesRegex(deploy.DeployError, "MIGRATION_SQL_FAILED"):
            deploy.sql("offline-pod", "SELECT '" + private + "';")
        emit.assert_called_once_with("sql_failed", sqlstate="42501", line=127)
        self.assertNotIn(private, json.dumps(emit.call_args.kwargs))


class RestorationCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.files = {"schema.sql": b"-- schema\nBEGIN; CREATE SCHEMA app_private; RESET ROLE; COMMIT;\n",
                      "seed.sql": b"BEGIN; SELECT 1; RESET ROLE; COMMIT;\n"}
        self.manifest = {"sha256": {name: hashlib.sha256(value).hexdigest() for name, value in self.files.items()}}
        self.schema = {"stage": "schema", "schema_sha256": self.manifest["sha256"]["schema.sql"],
                       "seed_sha256": self.manifest["sha256"]["seed.sql"]}
        self.seed = {**self.schema, "stage": "seed"}

    def test_schema_and_seed_checkpoint_sql_are_inserted_before_their_commit(self):
        for stage, field in (("schema", "schema.sql"), ("seed", "seed.sql")):
            value = deploy.with_restore_checkpoint(self.files[field].decode(), stage, self.manifest)
            self.assertTrue(value.endswith("COMMIT;\n"))
            self.assertIn("app_private.deployment_restore_state", value)
            self.assertLess(value.index("app_private.deployment_restore_state"), value.rfind("COMMIT;"))
        with self.assertRaisesRegex(deploy.DeployError, "RESTORE_TRANSACTION_CHECKPOINT_REJECTED"):
            deploy.with_restore_checkpoint("SELECT 1; COMMIT;", "schema", self.manifest)

    def test_schema_success_seed_failure_can_resume_without_replaying_schema(self):
        with patch.object(deploy, "restore_state", return_value=None), patch.object(deploy, "get", return_value=None), patch.object(
            deploy, "sql", side_effect=["", deploy.DeployError("MIGRATION_SQL_FAILED")]
        ) as sql, patch.object(deploy, "apply") as apply, patch.object(deploy, "emit"), self.assertRaises(deploy.DeployError):
            deploy.restore_application("offline-pod", self.files, self.manifest)
        self.assertEqual(sql.call_count, 2)
        self.assertIn("CREATE TABLE app_private.deployment_restore_state", sql.call_args_list[0].args[1])
        apply.assert_not_called()
        with patch.object(deploy, "restore_state", return_value=self.schema), patch.object(deploy, "get", return_value=None), patch.object(
            deploy, "sql", return_value=""
        ) as sql, patch.object(deploy, "apply") as apply, patch.object(deploy, "emit"):
            deploy.restore_application("offline-pod", self.files, self.manifest)
        self.assertEqual(sql.call_count, 1)
        self.assertNotIn("CREATE SCHEMA", sql.call_args.args[1])
        self.assertIn("SET stage='seed'", sql.call_args.args[1])
        apply.assert_called_once()

    def test_completed_database_can_repair_missing_kubernetes_marker_without_seed_replay(self):
        with patch.object(deploy, "restore_state", return_value=self.seed), patch.object(deploy, "get", return_value=None), patch.object(
            deploy, "sql"
        ) as sql, patch.object(deploy, "apply") as apply, patch.object(deploy, "emit"):
            deploy.restore_application("offline-pod", self.files, self.manifest)
        sql.assert_not_called()
        self.assertEqual(apply.call_args.args[0]["data"]["schema_sha256"], self.seed["schema_sha256"])

    def test_changed_database_hash_refuses_all_restore_mutations(self):
        with patch.object(deploy, "restore_state", return_value={**self.schema, "schema_sha256": "0" * 64}), patch.object(
            deploy, "get", return_value=None
        ), patch.object(deploy, "sql") as sql, patch.object(deploy, "apply") as apply, self.assertRaisesRegex(
            deploy.DeployError, "RESTORED_DATABASE_REVISION_MISMATCH"
        ):
            deploy.restore_application("offline-pod", self.files, self.manifest)
        sql.assert_not_called()
        apply.assert_not_called()

    def test_unbounded_or_unknown_ledger_output_is_rejected_without_forwarding_it(self):
        for raw in ("", '{"stage":"offline-private-value"}', '[]', '{"stage":"seed","schema_sha256":"bad","seed_sha256":"bad"}'):
            with self.subTest(raw=raw), patch.object(deploy, "sql", return_value=raw), self.assertRaisesRegex(
                deploy.DeployError, "RESTORE_LEDGER_STATE_REJECTED"
            ) as caught:
                deploy.restore_state("offline-pod")
            self.assertNotIn("offline-private-value", str(caught.exception))


class ApplicationRolloutOrderTests(unittest.TestCase):
    def attempt(self, blocked=None, foreign=None):
        events = []
        workloads = [("Deployment", name) for name in ("auth", "rest", "storage", "api", "worker", "frontend")]
        workloads += [("CronJob", "native-browser"), ("StatefulSet", "future-application")]
        objects = [{"kind": kind, "metadata": {"name": name},
                    "spec": {"template": {"spec": {}}}} for kind, name in workloads]
        objects += [{"kind": "ConfigMap", "metadata": {"name": "shared-config"}}]

        def apply(value):
            events.append(("apply", [(x["kind"], x["metadata"]["name"]) for x in value["items"]]))

        def get(kind, name):
            if name == foreign:
                return {"metadata": {"labels": {"app.kubernetes.io/managed-by": "another-controller"}}}
            return None

        def sql(pod, script, **kwargs):
            if kwargs.get("database") == "defaultdb":
                stage = "setup"
            elif "QwenCloud Singapore" in script:
                stage = "providers"
            elif "BACKEND_DATABASE_COMPATIBILITY_REQUIRED" in script:
                stage = "compatibility"
            elif "auth_role" in kwargs.get("variables", {}):
                stage = "invitations"
            elif "service_role" in kwargs.get("variables", {}):
                stage = "dispatcher"
            else:
                stage = "configuration"
            events.append(("sql", stage))
            if blocked == stage:
                raise deploy.DeployError("OFFLINE_SQL_REJECTED")
            return ""

        def restore(*args):
            events.append(("restore", "application"))
            if blocked == "restore":
                raise deploy.DeployError("OFFLINE_RESTORE_REJECTED")

        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {"GITHUB_RUN_ID": "offline-run", "GITHUB_RUN_ATTEMPT": "1",
                                                       "DOKS_WORKDIR": directory, "GITHUB_ENV": ""}))
            patches = [
                (deploy, "verify_bundle", {"return_value": ({}, {})}),
                (deploy.probe, "validate_cluster", {}),
                (deploy.probe, "target_credentials", {"return_value": ({}, "offline-ca")}),
                (deploy, "ensure_namespace", {}),
                (deploy, "registry_pull_secret", {}),
                (deploy, "core_credentials", {"return_value": {"ANON_KEY": "offline-public"}}),
                (deploy, "runtime_credentials", {"return_value": {"APP_WORKER_SECRET": "offline-worker", "APP_COLLECTION_HOSTS": "example.test"}}),
                (deploy, "sql_pod", {}),
                (deploy, "public_url", {"return_value": "https://offline.example.test"}),
                (deploy.renderer, "build", {"return_value": objects}),
                (deploy, "get", {"side_effect": get}),
                (deploy, "apply", {"side_effect": apply}),
                (deploy, "wait_deployments", {"side_effect": lambda names: events.append(("ready", names))}),
                (deploy, "restore_application", {"side_effect": restore}),
                (deploy, "sql", {"side_effect": sql}),
                (deploy, "cleanup_administrator", {"side_effect": lambda pod: events.append(("cleanup", pod))}),
                (deploy, "emit", {}),
            ]
            for module, name, kwargs in patches:
                stack.enter_context(patch.object(module, name, **kwargs))
            error = None
            try:
                deploy.deploy(argparse.Namespace(bundle=Path("offline-bundle"), sha256="0" * 64))
            except deploy.DeployError as caught:
                error = caught
            return events, error

    def test_application_and_native_workloads_wait_for_restore_and_every_sql_gate(self):
        events, error = self.attempt()
        self.assertIsNone(error)
        configured = events.index(("sql", "configuration"))
        before = [item for event, values in events[:configured] if event == "apply" for item in values]
        self.assertEqual({name for kind, name in before if kind == "Deployment"}, {"auth", "rest", "storage"})
        self.assertFalse(any(kind in {"CronJob", "StatefulSet"} for kind, name in before))
        after = [item for event, values in events[configured + 1:] if event == "apply" for item in values]
        self.assertEqual(set(after), {("Deployment", "api"), ("Deployment", "worker"), ("Deployment", "frontend"),
                                     ("CronJob", "native-browser"), ("StatefulSet", "future-application")})
        self.assertLess(events.index(("ready", ["auth", "rest", "storage"])), events.index(("restore", "application")))
        self.assertLess(events.index(("sql", "providers")), events.index(("sql", "compatibility")))
        self.assertEqual(events[-1][0], "cleanup")

    def test_restore_or_sql_failure_never_applies_new_application_workloads(self):
        for blocked in ("restore", "providers", "compatibility", "invitations", "dispatcher", "configuration"):
            with self.subTest(blocked=blocked):
                events, error = self.attempt(blocked)
                self.assertIsInstance(error, deploy.DeployError)
                applied = [item for event, values in events if event == "apply" for item in values]
                self.assertFalse(any(kind in {"CronJob", "StatefulSet"} or name in {"api", "worker", "frontend"}
                                     for kind, name in applied))
                self.assertEqual(events[-1][0], "cleanup")

    def test_foreign_deferred_workload_is_refused_before_restore_or_core_rollout(self):
        events, error = self.attempt(foreign="worker")
        self.assertEqual(str(error), "EXISTING_APPLICATION_RESOURCE_NOT_OWNED")
        self.assertNotIn(("restore", "application"), events)
        self.assertFalse(any(event == "ready" for event, value in events))
        self.assertEqual(events[-1][0], "cleanup")


if __name__ == "__main__":
    unittest.main()
