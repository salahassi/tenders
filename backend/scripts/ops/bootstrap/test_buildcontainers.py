"""Offline acceptance of the generated disposable-service workload contract."""
import json
import re
import unittest

from buildcontainers import build_bootstrap_job, REQUIRED_SECRET_KEYS


class BootstrapPodTests(unittest.TestCase):
    def setUp(self):
        self.job = build_bootstrap_job("td-bootstrap-test", {"tenderdesk.io/run": "offline-test"})
        self.pod = self.job["spec"]["template"]["spec"]

    def env(self, container):
        return {entry["name"]: entry for entry in container["env"]}

    def test_native_sidecar_start_order_and_bounded_http_readiness(self):
        sidecars = self.pod["initContainers"]
        self.assertEqual([c["name"] for c in sidecars], ["auth", "rest", "storage"])
        for container in sidecars:
            self.assertEqual(container["restartPolicy"], "Always")
            probe = container["startupProbe"]
            self.assertEqual(probe["httpGet"]["scheme"], "HTTP")
            self.assertLessEqual(probe["periodSeconds"] * probe["failureThreshold"], 180)
        self.assertEqual(sidecars[1]["startupProbe"]["httpGet"], {"path": "/ready", "port": 3001, "scheme": "HTTP"})

    def test_images_are_immutable_linux_amd64_and_no_unreviewed_override(self):
        for container in self.pod["initContainers"] + self.pod["containers"]:
            self.assertRegex(container["image"], r"^docker\.io/[\w/-]+:[\w.:-]+@sha256:[a-f0-9]{64}$")
        self.assertEqual(self.pod["nodeSelector"], {"kubernetes.io/arch": "amd64", "kubernetes.io/os": "linux"})
        with self.assertRaises(TypeError):
            build_bootstrap_job("td-test", {"owner": "test"}, image="unreviewed")

    def test_secrets_are_selective_references_and_never_embedded(self):
        references = set()
        for container in self.pod["initContainers"] + self.pod["containers"]:
            self.assertNotIn("envFrom", container)
            for entry in container["env"]:
                if "valueFrom" in entry:
                    secret = entry["valueFrom"]["secretKeyRef"]
                    self.assertEqual(secret["name"], "bootstrap-secrets")
                    references.add(secret["key"])
        self.assertEqual(references, set(REQUIRED_SECRET_KEYS))
        main = self.env(self.pod["containers"][0])
        self.assertNotIn("PGPASSWORD", main)
        self.assertNotIn("AUTH_DATABASE_URL", main)

    def test_prefixed_roles_expand_after_role_prefix_and_separate_storage_pool(self):
        for container in self.pod["initContainers"]:
            self.assertEqual(container["env"][0]["name"], "ROLE_PREFIX")
        auth, rest, storage = [self.env(c) for c in self.pod["initContainers"]]
        self.assertEqual(auth["GOTRUE_JWT_DEFAULT_GROUP_NAME"]["value"], "$(ROLE_PREFIX)_authenticated")
        self.assertEqual(rest["PGRST_DB_ANON_ROLE"]["value"], "$(ROLE_PREFIX)_anon")
        self.assertEqual(storage["DB_SERVICE_ROLE"]["value"], "$(ROLE_PREFIX)_service")
        self.assertEqual(storage["DB_INSTALL_ROLES"]["value"], "false")
        self.assertEqual(storage["DATABASE_POOL_URL"]["valueFrom"]["secretKeyRef"]["key"], "POSTGREST_DATABASE_URL")
        self.assertEqual(storage["DATABASE_URL"]["valueFrom"]["secretKeyRef"]["key"], "STORAGE_DATABASE_URL")

    def test_storage_ca_is_pem_secret_and_all_service_connections_have_ca_file(self):
        storage = self.env(self.pod["initContainers"][2])
        self.assertEqual(storage["DATABASE_SSL_ROOT_CERT"]["valueFrom"]["secretKeyRef"]["key"], "PGSSLCA")
        for container in self.pod["initContainers"]:
            ca = next(m for m in container["volumeMounts"] if m["name"] == "database-ca")
            self.assertTrue(ca["readOnly"])
            self.assertEqual(ca["mountPath"], "/run/db-ca")
        self.assertNotIn("NODE_TLS_REJECT_UNAUTHORIZED", json.dumps(self.job))

    def test_disposable_storage_no_public_network_or_ambient_identity(self):
        self.assertEqual(self.job["kind"], "Job")
        self.assertFalse(self.pod["automountServiceAccountToken"])
        self.assertNotIn("hostNetwork", self.pod)
        objects = next(v for v in self.pod["volumes"] if v["name"] == "bootstrap-objects")
        self.assertEqual(objects["emptyDir"]["sizeLimit"], "16Mi")
        self.assertNotIn("persistentVolumeClaim", json.dumps(self.pod))
        self.assertNotIn("LoadBalancer", json.dumps(self.job))

    def test_nonroot_restricted_filesystem_and_bounded_resources(self):
        for container in self.pod["initContainers"] + self.pod["containers"]:
            security = container["securityContext"]
            self.assertTrue(security["runAsNonRoot"])
            self.assertFalse(security["allowPrivilegeEscalation"])
            self.assertTrue(security["readOnlyRootFilesystem"])
            self.assertEqual(security["capabilities"]["drop"], ["ALL"])
            self.assertIn("limits", container["resources"])
        self.assertEqual(self.job["spec"]["backoffLimit"], 0)
        self.assertEqual(self.job["spec"]["activeDeadlineSeconds"], 900)
        self.assertEqual(self.job["spec"]["ttlSecondsAfterFinished"], 900)

    def test_invitation_only_no_external_email_or_model_configuration(self):
        auth = self.env(self.pod["initContainers"][0])
        self.assertEqual(auth["GOTRUE_DISABLE_SIGNUP"]["value"], "true")
        self.assertEqual(auth["GOTRUE_EXTERNAL_PHONE_ENABLED"]["value"], "false")
        envnames = {e["name"] for c in self.pod["initContainers"] + self.pod["containers"] for e in c["env"]}
        self.assertFalse(any(name.startswith("GOTRUE_SMTP_") or name.startswith("APP_MODEL_") for name in envnames))

    def test_acceptance_is_localhost_only_and_has_no_database_admin_credential(self):
        acceptance = self.pod["containers"][0]
        self.assertEqual(acceptance["name"], "acceptance")
        self.assertEqual(acceptance["command"], ["python3", "-B", "/opt/bootstrap/acceptance.py"])
        env = self.env(acceptance)
        for name in ("AUTH_URL", "REST_URL", "STORAGE_URL"):
            self.assertTrue(env[name]["value"].startswith("http://127.0.0.1:"))
        self.assertNotIn("PGUSER", env)
        self.assertNotIn("PGPASSWORD", env)

    def test_input_validation_and_independent_results(self):
        for value in ("bad/name", "../other", "UPPER", "", "x" * 64):
            with self.subTest(value=value), self.assertRaises(ValueError):
                build_bootstrap_job(value, {"owner": "test"})
        with self.assertRaises(ValueError):
            build_bootstrap_job("td-test", {})
        labels = {"owner": "first"}
        first = build_bootstrap_job("td-test", labels)
        labels["owner"] = "changed"
        first["spec"]["template"]["spec"]["initContainers"][0]["env"].clear()
        second = build_bootstrap_job("td-test", {"owner": "second"})
        self.assertEqual(first["metadata"]["labels"]["owner"], "first")
        self.assertTrue(second["spec"]["template"]["spec"]["initContainers"][0]["env"])


if __name__ == "__main__":
    unittest.main()
