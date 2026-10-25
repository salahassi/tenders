"""Offline checks of the isolated bootstrap's destructive-action boundaries."""
from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import urllib.parse


SCRIPT = Path(__file__).with_name("digitalocean-bootstrap.py")
SPEC = importlib.util.spec_from_file_location("tested_doks_bootstrap", SCRIPT)
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


class BootstrapBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"GITHUB_RUN_ID": "40232030191", "GITHUB_RUN_ATTEMPT": "2"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.state = bootstrap.identity()
        self.state.update(uid="namespace-uid", job_uid="parent-job-uid")

    def test_identity_is_bounded_unique_and_does_not_adopt_production_names(self):
        other = bootstrap.identity()
        self.assertNotEqual(self.state["database"], other["database"])
        self.assertRegex(self.state["database"], r"^td_bootstrap_40232030191_2_[0-9a-f]{8}$")
        self.assertRegex(self.state["role_prefix"], r"^tdb_32030191_[0-9a-f]{8}$")
        self.assertLessEqual(len(self.state["role_prefix"] + "_authenticated"), 63)
        self.assertLessEqual(len(self.state["namespace"]), 63)

    def test_missing_or_malformed_runner_identity_rejected(self):
        for run, attempt in (("", "2"), ("other", "2"), ("40232030191", ""), ("1", "../2")):
            with self.subTest(run=run, attempt=attempt), patch.dict(
                os.environ, {"GITHUB_RUN_ID": run, "GITHUB_RUN_ATTEMPT": attempt}
            ), self.assertRaises(bootstrap.BootstrapError):
                bootstrap.identity()

    def test_cleanup_state_rejects_foreign_run_database_prefix_uid_and_unknown_fields(self):
        mutations = (
            {"database": "defaultdb"}, {"database": "td_bootstrap_40232030191_1_1234abcd"},
            {"role_prefix": "tdb_32030191_1234abcd"}, {"uid": ""}, {"uid": None},
            {"setup_started": "true"}, {"database_cleanup_confirmed": 1},
            {"labels": {"app.kubernetes.io/managed-by": "foreign", "tenderdesk.io/run": "40232030191-2-1234abcd"}},
            {"secret": "not-allowed"},
        )
        for change in mutations:
            with self.subTest(fields=list(change)), self.assertRaises(bootstrap.BootstrapError):
                bootstrap.validate_state({**self.state, **change})
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "40232030192"}), self.assertRaises(bootstrap.BootstrapError):
            bootstrap.validate_state(self.state)

    def test_generated_api_keys_have_expected_audience_role_expiry_and_signature(self):
        secret = "offline-signing-secret-" + "x" * 40
        role = self.state["role_prefix"] + "_service"
        with patch.object(bootstrap.time, "time", return_value=1000):
            token = bootstrap.jwt(secret, role)
        header, payload, signature = token.split(".")
        decode = lambda value: base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        self.assertEqual(json.loads(decode(header))["alg"], "HS256")
        claims = json.loads(decode(payload))
        self.assertEqual(claims["aud"], "authenticated")
        self.assertEqual(claims["role"], role)
        self.assertEqual(claims["iat"], 1000)
        self.assertGreater(claims["exp"], claims["iat"])
        expected = hmac.new(secret.encode(), (header + "." + payload).encode(), hashlib.sha256).digest()
        self.assertTrue(hmac.compare_digest(expected, decode(signature)))

    def test_database_uri_percent_encodes_credentials_and_preserves_full_tls_verification(self):
        credentials = {"PGHOST": "private-test.db.ondigitalocean.com", "PGPORT": "25060"}
        password = "offline:/@?#% password"
        uri = bootstrap.database_uri(credentials, self.state, "_authadmin", password)
        parsed = urllib.parse.urlsplit(uri)
        self.assertEqual(urllib.parse.unquote(parsed.password), password)
        self.assertEqual(parsed.hostname, credentials["PGHOST"])
        self.assertEqual(parsed.port, 25060)
        self.assertEqual(urllib.parse.parse_qs(parsed.query), {
            "sslmode": ["verify-full"], "sslrootcert": ["/run/db-ca/ca.crt"]
        })
        self.assertNotIn(password, uri)

    def test_generated_secrets_are_not_persisted_in_state_or_workload_manifests(self):
        credentials = {"PGHOST": "private-test.db.ondigitalocean.com", "PGPORT": "25060", "PGUSER": "offline-admin",
                       "PGPASSWORD": "offline-sensitive-admin-password", "PGDATABASE": "defaultdb"}
        values = bootstrap.secret_values(credentials, "offline-public-ca", self.state)
        self.assertNotEqual(values["AUTH_DB_PASSWORD"], values["STORAGE_DB_PASSWORD"])
        self.assertNotEqual(values["AUTH_DB_PASSWORD"], values["REST_DB_PASSWORD"])
        job = bootstrap.sql_job(self.state, "database-setup", "setup.sql", "defaultdb")
        text = json.dumps({"state": self.state, "job": job})
        for key in ("PGPASSWORD", "AUTH_DB_PASSWORD", "STORAGE_DB_PASSWORD", "REST_DB_PASSWORD", "JWT_SECRET", "SERVICE_KEY"):
            self.assertNotIn(values[key], text)
        with tempfile.TemporaryDirectory() as directory:
            state_path = Path(directory) / "cleanup.json"
            with patch.object(bootstrap, "private_state_path", return_value=state_path):
                bootstrap.save(self.state)
            self.assertEqual(stat.S_IMODE(state_path.stat().st_mode), 0o600)
            self.assertEqual(json.loads(state_path.read_text()), self.state)

    def test_sql_job_is_restricted_bounded_and_only_uses_reviewed_scripts(self):
        for script in ("setup.sql", "post-migrations.sql", "cleanup.sql"):
            with self.subTest(script=script):
                job = bootstrap.sql_job(self.state, "test-job", script, "defaultdb")
                pod = job["spec"]["template"]["spec"]
                container = pod["containers"][0]
                self.assertFalse(pod["automountServiceAccountToken"])
                self.assertTrue(pod["securityContext"]["runAsNonRoot"])
                self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
                self.assertFalse(container["securityContext"]["allowPrivilegeEscalation"])
                self.assertEqual(container["securityContext"]["capabilities"]["drop"], ["ALL"])
                env = {item["name"]: item["value"] for item in container["env"]}
                self.assertEqual(env["PGSSLMODE"], "verify-full")
                self.assertEqual(env["PGSSLROOTCERT"], "/run/db-ca/ca.crt")
                self.assertEqual(job["spec"]["backoffLimit"], 0)
                self.assertLessEqual(job["spec"]["activeDeadlineSeconds"], 180)
                self.assertRegex(container["image"], r"@sha256:[a-f0-9]{64}$")
                self.assertEqual(container["command"][-1], "/opt/bootstrap/" + script)
        for script in ("../production.sql", "arbitrary.sql", "setup.sql --echo-all"):
            with self.subTest(script=script), self.assertRaises(bootstrap.BootstrapError):
                bootstrap.sql_job(self.state, "test-job", script, "defaultdb")

    def test_foreign_namespace_uid_or_labels_prevent_all_cleanup_mutations(self):
        for metadata in ({"uid": "foreign", "labels": self.state["labels"]},
                         {"uid": self.state["uid"], "labels": {"tenderdesk.io/run": "foreign"}}):
            with self.subTest(metadata=metadata), patch.object(
                bootstrap.preflight, "kubectl_json", return_value={"metadata": metadata}
            ), patch.object(bootstrap.preflight, "kubectl") as command, patch.object(
                bootstrap.preflight, "cleanup_namespace"
            ) as delete, patch.object(bootstrap, "create") as create, self.assertRaises(bootstrap.BootstrapError):
                bootstrap.cleanup(self.state)
            command.assert_not_called()
            delete.assert_not_called()
            create.assert_not_called()

    def test_namespace_only_cleanup_does_not_run_database_commands_before_setup(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(bootstrap, "assert_namespace"), patch.object(
            bootstrap.preflight, "kubectl_json"
        ) as read, patch.object(bootstrap.preflight, "kubectl") as command, patch.object(
            bootstrap, "create"
        ) as create, patch.object(bootstrap.preflight, "cleanup_namespace") as delete, patch.object(
            bootstrap, "private_state_path", return_value=Path(directory) / "cleanup.json"
        ), patch.object(bootstrap, "emit"):
            bootstrap.cleanup(self.state)
        read.assert_not_called()
        command.assert_not_called()
        create.assert_not_called()
        delete.assert_called_once_with(self.state["namespace"], self.state["uid"], self.state["labels"])

    def test_cleanup_suspends_owned_parent_before_sql_and_deletes_namespace_last(self):
        state = {**self.state, "setup_started": True}
        order = []
        def read(arguments):
            if arguments[:2] == ["get", "job"]:
                return {"metadata": {"uid": state["job_uid"]}}
            if arguments[:2] == ["get", "pods"]:
                order.append("clients_stopped")
                return {"items": []}
            if arguments[:2] == ["get", "jobs"]:
                return {"items": []}
            raise AssertionError("Unexpected read")
        def command(arguments):
            self.assertEqual(arguments[:3], ["patch", "job", "compatible-services"])
            self.assertTrue(json.loads(arguments[-1])["spec"]["suspend"])
            order.append("suspend")
        def create(manifest):
            self.assertEqual(manifest["metadata"]["name"], "database-cleanup")
            self.assertEqual(manifest["spec"]["template"]["spec"]["containers"][0]["command"][-1], "/opt/bootstrap/cleanup.sql")
            order.append("create_cleanup")
        with tempfile.TemporaryDirectory() as directory, patch.object(bootstrap, "assert_namespace"), patch.object(
            bootstrap.preflight, "kubectl_json", side_effect=read
        ), patch.object(bootstrap.preflight, "kubectl", side_effect=command), patch.object(
            bootstrap, "create", side_effect=create
        ), patch.object(bootstrap, "wait_sql", side_effect=lambda *a: order.append("sql_complete")), patch.object(
            bootstrap, "save", side_effect=lambda *a: order.append("state_confirmed")
        ), patch.object(bootstrap.preflight, "cleanup_namespace", side_effect=lambda *a: order.append("namespace_deleted")), patch.object(
            bootstrap, "private_state_path", return_value=Path(directory) / "cleanup.json"
        ), patch.object(bootstrap, "emit"):
            bootstrap.cleanup(state)
        self.assertEqual(order, ["suspend", "clients_stopped", "create_cleanup", "sql_complete", "state_confirmed", "namespace_deleted"])
        self.assertTrue(state["database_cleanup_confirmed"])

    def test_unconfirmed_client_shutdown_prevents_database_and_namespace_cleanup(self):
        state = {**self.state, "setup_started": True}
        with patch.object(bootstrap, "assert_namespace"), patch.object(
            bootstrap.preflight, "kubectl_json", return_value={"metadata": {"uid": state["job_uid"]}}
        ), patch.object(bootstrap.preflight, "kubectl") as command, patch.object(
            bootstrap, "wait_clients_stopped", side_effect=bootstrap.BootstrapError("BOOTSTRAP_CLIENT_SHUTDOWN_NOT_CONFIRMED")
        ), patch.object(bootstrap, "create") as create, patch.object(
            bootstrap.preflight, "cleanup_namespace"
        ) as delete, self.assertRaises(bootstrap.BootstrapError):
            bootstrap.cleanup(state)
        command.assert_called_once()
        self.assertEqual(command.call_args.args[0][:3], ["patch", "job", "compatible-services"])
        create.assert_not_called()
        delete.assert_not_called()
        self.assertFalse(state["database_cleanup_confirmed"])

    def test_client_shutdown_wait_is_bounded_and_does_not_accept_running_pods(self):
        with patch.object(bootstrap.preflight, "kubectl_json", return_value={"items": [{"status": {"phase": "Running"}}]}), patch.object(
            bootstrap.time, "monotonic", side_effect=[0, 0, 51]
        ), patch.object(bootstrap.time, "sleep") as sleep, self.assertRaises(bootstrap.BootstrapError) as caught:
            bootstrap.wait_clients_stopped(self.state)
        self.assertEqual(str(caught.exception), "BOOTSTRAP_CLIENT_SHUTDOWN_NOT_CONFIRMED")
        sleep.assert_called_once_with(2)
        for pods in ([], [{"status": {"phase": "Succeeded"}}], [{"status": {"phase": "Failed"}}]):
            with self.subTest(pods=pods), patch.object(bootstrap.preflight, "kubectl_json", return_value={"items": pods}):
                bootstrap.wait_clients_stopped(self.state)

    def test_foreign_parent_job_prevents_sql_and_namespace_deletion(self):
        state = {**self.state, "setup_started": True}
        with patch.object(bootstrap, "assert_namespace"), patch.object(
            bootstrap.preflight, "kubectl_json", return_value={"metadata": {"uid": "foreign-parent"}}
        ), patch.object(bootstrap.preflight, "kubectl") as command, patch.object(
            bootstrap.preflight, "cleanup_namespace"
        ) as delete, patch.object(bootstrap, "create") as create, self.assertRaises(bootstrap.BootstrapError):
            bootstrap.cleanup(state)
        command.assert_not_called()
        create.assert_not_called()
        delete.assert_not_called()


class OptionalSourceProbeTests(unittest.TestCase):
    def test_missing_optional_source_token_preserves_successful_target_result(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(
            bootstrap.preflight, "target_inventory", return_value={"offline": "target"}
        ) as target, patch.object(bootstrap.preflight, "source_inventory") as source, patch.object(
            bootstrap.preflight, "emit"
        ) as emit:
            self.assertEqual(bootstrap.preflight.main(), 0)
        target.assert_called_once()
        source.assert_not_called()
        emit.assert_any_call("managed_database", "ok", inventory={"offline": "target"})
        emit.assert_any_call("source_database", "not_run", code="OPTIONAL_SOURCE_TOKEN_NOT_CONFIGURED")

    def test_target_failure_remains_failure_when_source_probe_is_not_configured(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(
            bootstrap.preflight, "target_inventory", side_effect=bootstrap.preflight.ProbeError("OFFLINE_TARGET_DENIED")
        ), patch.object(bootstrap.preflight, "source_inventory") as source, patch.object(
            bootstrap.preflight, "emit"
        ) as emit:
            self.assertEqual(bootstrap.preflight.main(), 1)
        source.assert_not_called()
        emit.assert_any_call("managed_database", "blocked", code="OFFLINE_TARGET_DENIED")
        emit.assert_any_call("source_database", "not_run", code="OPTIONAL_SOURCE_TOKEN_NOT_CONFIGURED")

    def test_supplied_but_invalid_source_credential_does_not_silently_skip_failure(self):
        with patch.dict(os.environ, {"SUPABASE_ACCESS_TOKEN": "offline-invalid-credential"}, clear=True), patch.object(
            bootstrap.preflight, "target_inventory", return_value={"offline": "target"}
        ), patch.object(
            bootstrap.preflight, "source_inventory", side_effect=bootstrap.preflight.ProbeError("HTTP_403")
        ) as source, patch.object(bootstrap.preflight, "emit") as emit:
            self.assertEqual(bootstrap.preflight.main(), 1)
        source.assert_called_once()
        emit.assert_any_call("source_database", "blocked", code="HTTP_403")


if __name__ == "__main__":
    unittest.main()
