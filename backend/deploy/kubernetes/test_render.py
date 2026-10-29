import base64
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
from render import build, public_entrypoint


def jwt(role):
    payload = base64.urlsafe_b64encode(json.dumps({"role": role}).encode()).decode().rstrip("=")
    return "fixture." + payload + ".fixture"


class RuntimeManifestTest(unittest.TestCase):
    def setUp(self):
        self.config = {"public_origin": "https://app.example.test", "runtime_image": "registry.example.test/runtime@sha256:" + "a" * 64,
            "frontend_image": "registry.example.test/frontend@sha256:" + "b" * 64, "https_image": "registry.example.test/https@sha256:" + "e" * 64, "browser_image": "registry.example.test/browser@sha256:" + "c" * 64,
            "ocr_image": "registry.example.test/ocr@sha256:" + "d" * 64, "publishable_key": jwt("tdp_app_anon")}
        self.objects = build(self.config)
        self.deployments = {obj["metadata"]["name"]: obj for obj in self.objects if obj["kind"] == "Deployment"}

    def test_public_endpoint_targets_only_tls_front(self):
        public = [o for o in self.objects if o["kind"] == "Service" and o["spec"].get("type") == "LoadBalancer"]
        self.assertEqual(len(public), 1)
        self.assertEqual(public[0]["spec"]["selector"], {"app.kubernetes.io/name": "https"})
        self.assertEqual([p["port"] for p in public[0]["spec"]["ports"]], [80, 443])
        self.assertEqual(len(public_entrypoint()), 2)

    def test_credentials_are_references_and_never_admin_values(self):
        content = json.dumps(self.objects)
        for key in ["AUTH_DB_PASSWORD", "STORAGE_DB_PASSWORD", "REST_DB_PASSWORD", "PGPASSWORD", "PGUSER"]:
            self.assertNotIn(key, content)
        self.assertIn('"secretKeyRef"', content)
        for obj in self.objects:
            self.assertNotEqual(obj["kind"], "Secret")
        runtime = self.deployments["api"]["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(runtime["envFrom"], [{"secretRef": {"name": "tenderdesk-runtime"}}])
        self.assertIn({"name": "APP_PUBLIC_API_URL", "value": "https://app.example.test"}, runtime["env"])

    def test_private_objects_and_tls_certificates_survive_rollout(self):
        claims = {o["metadata"]["name"]: o for o in self.objects if o["kind"] == "PersistentVolumeClaim"}
        self.assertEqual(set(claims), {"private-objects", "https-state"})
        self.assertEqual(claims["private-objects"]["spec"]["resources"]["requests"]["storage"], "20Gi")
        for name in ["storage", "https"]:
            deployment = self.deployments[name]
            self.assertEqual(deployment["spec"]["strategy"], {"type": "Recreate"})
            self.assertTrue(any("persistentVolumeClaim" in v for v in deployment["spec"]["template"]["spec"]["volumes"]))

    def test_local_graph_profile_discovery_keeps_restricted_filesystem_permissions(self):
        for name in ["api", "worker", "source-browser", "scheduler"]:
            container = self.deployments[name]["spec"]["template"]["spec"]["containers"][0]
            self.assertIn({"name": "LANGSMITH_CONFIG_FILE", "value": "/app/backend/.langsmith-disabled.json"}, container["env"])
            self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
            self.assertEqual(container["securityContext"]["capabilities"], {"drop": ["ALL"]})

    def test_ordinary_pods_have_no_service_account_or_privilege(self):
        for obj in self.deployments.values():
            pod = obj["spec"]["template"]["spec"]
            self.assertFalse(pod["automountServiceAccountToken"])
            for container in pod["containers"]:
                self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
                self.assertTrue(container["securityContext"]["runAsNonRoot"])
                self.assertFalse(container["securityContext"]["allowPrivilegeEscalation"])
                self.assertEqual(container["securityContext"]["capabilities"]["drop"], ["ALL"])
                self.assertIn("@sha256:", container["image"])

    def test_https_uses_the_capability_free_custom_image_on_unprivileged_ports(self):
        pod = self.deployments["https"]["spec"]["template"]["spec"]
        container = pod["containers"][0]
        self.assertEqual(container["image"], self.config["https_image"])
        self.assertEqual(container["securityContext"]["capabilities"], {"drop": ["ALL"]})
        self.assertFalse(container["securityContext"]["allowPrivilegeEscalation"])
        self.assertTrue(container["securityContext"]["readOnlyRootFilesystem"])
        self.assertEqual({port["containerPort"] for port in container["ports"]}, {8080, 8443, 8082})
        missing = {key: value for key, value in self.config.items() if key != "https_image"}
        with self.assertRaisesRegex(ValueError, "DIGEST_REQUIRED"):
            build(missing)

    def test_workers_remain_paused_until_explicit_activation(self):
        scheduler = self.deployments["scheduler"]["spec"]["template"]["spec"]["containers"][0]
        self.assertIn({"name": "APP_SCHEDULER_ENABLED", "value": "false"}, scheduler["env"])
        cronjobs = [o for o in self.objects if o["kind"] == "CronJob"]
        self.assertEqual(len(cronjobs), 2)
        self.assertTrue(all(o["spec"]["suspend"] for o in cronjobs))
        self.assertTrue(all(o["spec"]["concurrencyPolicy"] == "Forbid" for o in cronjobs))
        self.assertGreaterEqual(self.deployments["worker"]["spec"]["template"]["spec"]["terminationGracePeriodSeconds"], 180)

    def test_public_gateway_rejects_private_worker_paths(self):
        gateway = next(o["data"]["nginx.conf"] for o in self.objects if o["kind"] == "ConfigMap" and o["metadata"]["name"] == "gateway-config")
        public = gateway.split("# Cluster-only interface")[0]
        self.assertIn("location ~ ^/functions/v1/(worker|source-browser)(/|$) { return 404; }", public)
        self.assertNotIn("proxy_pass http://worker", public)
        self.assertIn("auth.tenderdesk.svc.cluster.local", gateway)
        self.assertNotIn("__NAMESPACE__", gateway)
        self.assertNotIn("access_log /", gateway)
        self.assertEqual(gateway.count("location /functions/v1/api/ { client_max_body_size 32m;"), 2)

    def test_public_configuration_contains_only_public_anon_key(self):
        config = next(o["data"]["runtime-config.js"] for o in self.objects if o["kind"] == "ConfigMap" and o["metadata"]["name"] == "frontend-config")
        payload = json.loads(config.split(" = ")[1].rstrip(";\n"))
        self.assertEqual(payload, {"apiUrl": "https://app.example.test", "publishableKey": self.config["publishable_key"], "appOrigin": "https://app.example.test"})
        with self.assertRaisesRegex(ValueError, "PRIVILEGED"):
            build({**self.config, "publishable_key": jwt("tdp_app_service")})

    def test_mutable_images_insecure_urls_and_string_activation_fail(self):
        for update in [{"runtime_image": "repo/runtime:latest"}, {"https_image": "repo/https:latest"}, {"https_image": ""}, {"public_origin": "http://app.example.test"},
            {"public_origin": "https://user:secret@app.example.test"}, {"public_origin": "https://app.example.test/path"},
            {"public_origin": "https://app.example.test/?token=secret"}, {"namespace": "../../other"},
            {"scheduler_enabled": "true"}, {"native_workers_enabled": "false"}]:
            with self.assertRaises(ValueError):
                build({**self.config, **update})

    def test_invitation_hook_and_email_confirmation_remain_enforced(self):
        auth = self.deployments["auth"]["spec"]["template"]["spec"]["containers"][0]
        values = {item["name"]: item.get("value") for item in auth["env"]}
        self.assertEqual(values["GOTRUE_DISABLE_SIGNUP"], "false")
        self.assertEqual(values["GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED"], "true")
        self.assertEqual(values["GOTRUE_HOOK_BEFORE_USER_CREATED_URI"], "pg-functions://postgres/app_private/before_user_created")
        self.assertEqual(values["GOTRUE_MAILER_AUTOCONFIRM"], "false")
        self.assertEqual(values["API_EXTERNAL_URL"], "https://app.example.test")
        self.assertEqual(values["GOTRUE_MAILER_URLPATHS_CONFIRMATION"], "/auth/v1/verify")
        smtp = {item["name"]: item["valueFrom"]["secretKeyRef"] for item in auth["env"] if "valueFrom" in item and item["name"].startswith("GOTRUE_SMTP_")}
        self.assertEqual(len(smtp), 6)
        self.assertTrue(all(ref["name"] == "tenderdesk-runtime" and ref["optional"] for ref in smtp.values()))
        self.assertEqual(smtp["GOTRUE_SMTP_ADMIN_EMAIL"]["key"], "AUTH_SMTP_ADMIN_EMAIL")

    def test_public_config_change_triggers_frontend_rollout(self):
        before = self.deployments["frontend"]["spec"]["template"]["metadata"]["annotations"]
        after = next(o for o in build({**self.config, "public_origin": "https://new.example.test"}) if o["kind"] == "Deployment" and o["metadata"]["name"] == "frontend")["spec"]["template"]["metadata"]["annotations"]
        self.assertNotEqual(before, after)

    def test_references_original_private_db_tls_ca(self):
        for name in ["auth", "rest", "storage"]:
            pod = self.deployments[name]["spec"]["template"]["spec"]
            self.assertTrue(any(v.get("secret", {}).get("secretName") == "tenderdesk-core" for v in pod["volumes"]))
            self.assertTrue(any(m["mountPath"] == "/run/db-ca" and m["readOnly"] for m in pod["containers"][0]["volumeMounts"]))
        rest = self.deployments["rest"]["spec"]["template"]["spec"]["containers"][0]
        self.assertIn({"name": "PGRST_DB_MAX_ROWS", "value": "1000"}, rest["env"])


if __name__ == "__main__":
    unittest.main()
