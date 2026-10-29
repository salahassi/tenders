"""Exercise image-only frontend updates and failure recovery without network/data."""
from __future__ import annotations

import contextlib
import copy
from contextlib import ExitStack
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("tested_frontend_update", Path(__file__).with_name("digitalocean-update-frontend.py"))
f = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = f
SPEC.loader.exec_module(f)
PREVIOUS = f.u.REGISTRY + "frontend@sha256:" + "a" * 64
CANDIDATE = f.u.REGISTRY + "frontend@sha256:" + "b" * 64
FOREIGN = f.u.REGISTRY + "frontend@sha256:" + "c" * 64


def resource(kind, name):
    return {"kind": kind, "metadata": {"name": name, "namespace": f.d.NAMESPACE,
            "uid": "fixture-" + name, "resourceVersion": "1", "generation": 1,
            "labels": {"app.kubernetes.io/managed-by": "tenderdesk-deployment"}}}


def workload(name):
    value = resource("Deployment", name)
    image = PREVIOUS if name == "frontend" else f.u.REGISTRY + "runtime@sha256:" + "d" * 64
    value["spec"] = {"replicas": 1, "template": {"metadata": {"annotations": {"keep": "unchanged"}},
        "spec": {"containers": [{"name": name, "image": image, "resources": {"requests": {"memory": "64Mi"}},
                                "envFrom": [{"secretRef": {"name": "tenderdesk-runtime"}}]}]}}}
    value["status"] = {"observedGeneration": 1, "readyReplicas": 1, "updatedReplicas": 1}
    return value


def assets():
    return {"index": b'<script type="module" src="./assets/index-fixture.js"></script><link href="./assets/index-fixture.css">',
            "assets": {"/assets/index-fixture.js": b"export const app = true;",
                       "/assets/index-fixture.css": b"body { color: black; }",
                       "/assets/extraction.worker-fixture.js": b"self.onmessage = () => {};",
                       "/assets/pdf.worker.min-fixture.mjs": b"export const worker = true;"}}


class FrontendUpdateTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.resources = {("deployment", name): workload(name) for name in
                          ("frontend", "api", "worker", "scheduler", "source-browser", "auth", "https")}
        namespace = resource("Namespace", f.d.NAMESPACE)
        namespace["metadata"].pop("namespace")
        self.resources["namespace", f.d.NAMESPACE] = namespace
        for name in ("native-browser", "native-ocr"):
            value = resource("CronJob", name)
            value["spec"] = {"suspend": False, "schedule": "*/5 * * * *", "jobTemplate": {"preserve": name}}
            self.resources["cronjob", name] = value
        self.public = {"apiUrl": "https://offline.example.test", "appOrigin": "https://offline.example.test",
                       "publishableKey": "synthetic-public-key"}
        configuration = resource("ConfigMap", "frontend-config")
        configuration["data"] = {"runtime-config.js": "window.__TENDERDESK_CONFIG__ = " + json.dumps(self.public) + ";"}
        self.resources["configmap", "frontend-config"] = configuration
        self.initial = copy.deepcopy(self.resources)
        self.expected = assets()
        self.patch_failure = self.rollback_failure = self.rollout_failure = False
        self.wait_hook = None
        self.bad_mime = self.bad_hash = self.bad_css = False
        self.bad_cache = self.bad_missing = self.bad_health = self.bad_anonymous = False

    def get(self, kind, name):
        self.assertNotEqual(kind, "secret", "frontend updates must never read Secrets")
        return copy.deepcopy(self.resources.get((kind, name)))

    def command(self, args, **kwargs):
        if args[:1] == ["get"]:
            self.assertIn(args[1], ("deployments", "cronjobs"))
            self.assertEqual(args[2:], ["-n", f.d.NAMESPACE, "-o", "json"])
            kind = {"deployments": "deployment", "cronjobs": "cronjob"}[args[1]]
            return json.dumps({"items": [copy.deepcopy(value) for (current_kind, _), value in self.resources.items()
                                        if current_kind == kind]})
        self.assertEqual(args[:3], ["patch", "deployment", "frontend"], "only frontend image patches are allowed")
        operations = json.loads(args[args.index("--patch") + 1])
        self.assertEqual([operation["op"] for operation in operations], ["test", "test", "test", "test", "replace"])
        self.assertEqual([operation["path"] for operation in operations], ["/metadata/resourceVersion", "/metadata/uid",
            "/spec/template/spec/containers/0/name", "/spec/template/spec/containers/0/image", "/spec/template/spec/containers/0/image"])
        current = self.resources["deployment", "frontend"]
        self.assertEqual(operations[0]["value"], current["metadata"]["resourceVersion"])
        self.assertEqual(operations[1]["value"], current["metadata"]["uid"])
        self.assertEqual(operations[2]["value"], "frontend")
        self.assertEqual(operations[3]["value"], f.selected_image(current))
        selected = operations[-1]["value"]
        self.events.append(("image", selected))
        if self.rollback_failure and selected == PREVIOUS:
            raise f.d.DeployError("KUBERNETES_COMMAND_FAILED")
        current["spec"]["template"]["spec"]["containers"][0]["image"] = selected
        current["metadata"]["resourceVersion"] = str(int(current["metadata"]["resourceVersion"]) + 1)
        if self.patch_failure and selected == CANDIDATE:
            self.patch_failure = False
            raise f.d.DeployError("KUBERNETES_COMMAND_TIMEOUT")
        return ""

    def wait(self, names, seconds):
        self.assertEqual(names, ["frontend"])
        self.events.append(("ready",))
        if self.wait_hook:
            hook, self.wait_hook = self.wait_hook, None
            hook()
        if self.rollout_failure:
            self.rollout_failure = False
            raise f.d.DeployError("APPLICATION_ROLLOUT_FAILED")

    def response(self, path, **kwargs):
        self.assertFalse(kwargs.get("token"), "public acceptance cannot use a session")
        self.assertEqual(kwargs.get("method", "GET"), "GET")
        self.events.append(("http", path))
        if path == "/":
            return f.smoke.Response(200, self.expected["index"])
        if path == "/runtime-config.js":
            return f.smoke.Response(200, self.resources["configmap", "frontend-config"]["data"]["runtime-config.js"].encode())
        if path in self.expected["assets"]:
            mime = "text/css" if path.endswith(".css") else "application/javascript"
            if self.bad_mime and path.endswith(".mjs"):
                mime = "application/octet-stream"
            if self.bad_css and path.endswith(".css"):
                mime = "application/octet-stream"
            content = self.expected["assets"][path]
            if self.bad_hash and path.endswith(".js"):
                content = b"wrong source revision"
            return f.smoke.Response(200, content, {"Content-Type": mime, "X-Content-Type-Options": "nosniff",
                "Cache-Control": "no-cache" if self.bad_cache else "public, max-age=31536000, immutable"})
        if path.startswith("/assets/__frontend_acceptance_absent__."):
            return f.smoke.Response(200 if self.bad_missing else 404, b"absent")
        if path.endswith("/health"):
            return f.smoke.Response(500 if self.bad_health else 200, b"{}")
        if path.endswith("/bootstrap"):
            return f.smoke.Response(200 if self.bad_anonymous else 401, b"{}")
        self.fail("Unexpected HTTP request: " + path)

    @contextlib.contextmanager
    def context(self):
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, {"TENDERDESK_FRONTEND_IMAGE": CANDIDATE,
                "GITHUB_RUN_ID": "12345", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_SHA": "e" * 40,
                "GITHUB_ENV": ""}))
            client = stack.enter_context(patch.object(f.smoke, "Client"))
            client.return_value.request.side_effect = self.response
            values = [(f.d, "get", {"side_effect": self.get}), (f.d, "command", {"side_effect": self.command}),
                      (f.d.probe, "validate_cluster", {}), (f.d, "wait_deployments", {"side_effect": self.wait}),
                      (f, "build_assets", {"return_value": self.expected}),
                      (f, "browser_check", {"side_effect": lambda origin: self.events.append(("browser", origin))}),
                      (f, "emit", {})]
            mocks = {name: stack.enter_context(patch.object(module, name, **kwargs)) for module, name, kwargs in values}
            for forbidden in ("sql", "sql_pod", "restore_application", "decode_secret", "apply"):
                stack.enter_context(patch.object(f.d, forbidden, side_effect=AssertionError("forbidden backend operation")))
            mocks["client"] = client
            yield mocks

    def assert_previous(self):
        self.assertEqual(f.selected_image(self.resources["deployment", "frontend"]), PREVIOUS)

    def test_only_frontend_image_changes_and_public_acceptance_has_no_service_identity(self):
        with self.context() as mocks:
            f.update()
            config = mocks["client"].call_args.args[0]
            self.assertEqual((config.service_key, config.jwt_secret), ("", ""))
        for key, value in self.resources.items():
            if key == ("deployment", "frontend"):
                self.assertEqual(f.selected_image(value), CANDIDATE)
                self.assertEqual(f.u.without_image(value), f.u.without_image(self.initial[key]))
            else:
                self.assertEqual(value, self.initial[key])
        self.assertEqual([event for event in self.events if event[0] == "image"], [("image", CANDIDATE)])
        self.assertIn(("browser", self.public["appOrigin"]), self.events)

    def test_ambiguous_accepted_patch_and_failed_rollout_restore_previous_image(self):
        for failure in ("patch_failure", "rollout_failure"):
            with self.subTest(failure=failure):
                self.setUp()
                setattr(self, failure, True)
                with self.context(), self.assertRaises(f.d.DeployError):
                    f.update()
                self.assert_previous()
                self.assertEqual([event for event in self.events if event[0] == "image"],
                                 [("image", CANDIDATE), ("image", PREVIOUS)])

    def test_mime_hash_cache_missing_asset_health_and_anonymous_failures_roll_back(self):
        for failure, code in (("bad_mime", "MIME_INVALID"), ("bad_css", "MIME_INVALID"),
                              ("bad_hash", "ASSET_MISMATCH"), ("bad_cache", "HEADERS_INVALID"),
                              ("bad_missing", "MISSING_ASSET"), ("bad_health", "HEALTH_FAILED"),
                              ("bad_anonymous", "ANONYMOUS_BOUNDARY")):
            with self.subTest(failure=failure):
                self.setUp()
                setattr(self, failure, True)
                with self.context(), self.assertRaisesRegex(f.FrontendUpdateError, code):
                    f.update()
                self.assert_previous()

    def test_browser_extraction_failure_is_inside_the_rollback_boundary(self):
        with self.context() as mocks:
            mocks["browser_check"].side_effect = f.FrontendUpdateError("FRONTEND_BROWSER_ACCEPTANCE_FAILED")
            with self.assertRaisesRegex(f.FrontendUpdateError, "BROWSER_ACCEPTANCE_FAILED"):
                f.update()
        self.assert_previous()

    def test_foreign_namespace_or_frontend_and_unready_frontend_never_patch(self):
        for target in ("namespace", "frontend", "readiness"):
            with self.subTest(target=target):
                self.setUp()
                if target == "namespace":
                    self.resources["namespace", f.d.NAMESPACE]["metadata"]["labels"] = {}
                elif target == "frontend":
                    self.resources["deployment", "frontend"]["metadata"]["labels"] = {}
                else:
                    self.resources["deployment", "frontend"]["status"]["readyReplicas"] = 0
                with self.context(), self.assertRaises((f.FrontendUpdateError, f.u.UpdateError)):
                    f.update()
                self.assertFalse(any(event[0] == "image" for event in self.events))

    def test_foreign_concurrent_image_is_never_overwritten_even_during_rollback(self):
        def switch():
            self.resources["deployment", "frontend"]["spec"]["template"]["spec"]["containers"][0]["image"] = FOREIGN
        self.wait_hook = switch
        with self.context(), self.assertRaisesRegex(f.FrontendUpdateError, "ROLLBACK_NOT_CONFIRMED"):
            f.update()
        self.assertEqual(f.selected_image(self.resources["deployment", "frontend"]), FOREIGN)
        self.assertEqual([event for event in self.events if event[0] == "image"], [("image", CANDIDATE)])

    def test_configuration_and_runtime_drift_are_detected_and_never_reverted(self):
        for target in ("configmap", "runtime", "schedule"):
            with self.subTest(target=target):
                self.setUp()
                def mutate():
                    if target == "configmap":
                        self.resources["configmap", "frontend-config"]["data"]["external"] = "retain"
                    elif target == "runtime":
                        self.resources["deployment", "worker"]["spec"]["replicas"] = 2
                    else:
                        self.resources["cronjob", "native-ocr"]["spec"]["suspend"] = True
                self.wait_hook = mutate
                with self.context(), self.assertRaisesRegex(f.FrontendUpdateError, "UNRELATED_CONFIGURATION_CHANGED"):
                    f.update()
                self.assert_previous()
                if target == "configmap":
                    self.assertEqual(self.resources["configmap", "frontend-config"]["data"]["external"], "retain")
                elif target == "runtime":
                    self.assertEqual(self.resources["deployment", "worker"]["spec"]["replicas"], 2)
                else:
                    self.assertTrue(self.resources["cronjob", "native-ocr"]["spec"]["suspend"])

    def test_frontend_configuration_or_namespace_drift_blocks_rollback(self):
        for target in ("frontend", "namespace"):
            with self.subTest(target=target):
                self.setUp()
                def mutate():
                    if target == "frontend":
                        self.resources["deployment", "frontend"]["spec"]["template"]["spec"]["containers"][0]["env"] = []
                    else:
                        self.resources["namespace", f.d.NAMESPACE]["metadata"]["labels"] = {}
                self.wait_hook = mutate
                with self.context(), self.assertRaisesRegex(f.FrontendUpdateError, "ROLLBACK_NOT_CONFIRMED"):
                    f.update()
                self.assertEqual([event for event in self.events if event[0] == "image"], [("image", CANDIDATE)])

    def test_failed_rollback_is_explicit(self):
        self.rollout_failure = self.rollback_failure = True
        with self.context(), self.assertRaisesRegex(f.FrontendUpdateError, "ROLLBACK_NOT_CONFIRMED"):
            f.update()

    def test_preexisting_concurrent_image_and_replaced_workload_are_refused(self):
        for target in ("image", "uid"):
            with self.subTest(target=target):
                self.setUp()
                if target == "image":
                    self.resources["deployment", "frontend"]["spec"]["template"]["spec"]["containers"][0]["image"] = FOREIGN
                    code = "CONCURRENT_IMAGE_CHANGED"
                else:
                    self.resources["deployment", "frontend"]["metadata"]["uid"] = "different-deployment"
                    code = "CONFIGURATION_CHANGED"
                with self.context(), self.assertRaisesRegex(f.FrontendUpdateError, code):
                    f.patch_frontend(CANDIDATE, self.initial["deployment", "frontend"], {PREVIOUS})
                self.assertFalse(any(event[0] == "image" for event in self.events))

    def test_invalid_image_or_run_identity_fails_before_cluster_mutations(self):
        for values in ({"TENDERDESK_FRONTEND_IMAGE": "frontend:latest"}, {"GITHUB_SHA": "not-a-revision"},
                       {"GITHUB_RUN_ID": "bad"}, {"GITHUB_RUN_ATTEMPT": "bad"}):
            with self.subTest(values=values), self.context(), patch.dict(os.environ, values):
                with self.assertRaises((f.FrontendUpdateError, f.u.UpdateError)):
                    f.update()
                self.assertFalse(self.events)


class FrontendAcceptanceProcessTests(unittest.TestCase):
    def test_browser_output_is_private_and_failure_timeout_and_oversize_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = root / "frontend/deploy/verify-pdf-worker.mjs"
            script.parent.mkdir(parents=True)
            script.write_text("// synthetic subprocess fixture")
            for mode in ("passed", "failed", "timeout", "oversized"):
                with self.subTest(mode=mode):
                    def run(arguments, **kwargs):
                        self.assertEqual(arguments, ["node", str(script), "https://offline.example.test"])
                        self.assertNotIn("shell", kwargs)
                        self.assertEqual(kwargs["timeout"], 180)
                        if mode == "timeout":
                            raise subprocess.TimeoutExpired(arguments, 180)
                        kwargs["stdout"].write(b"private subprocess diagnostics" if mode != "oversized" else b"x" * (f.MAX_BROWSER_OUTPUT + 1))
                        return subprocess.CompletedProcess(arguments, 1 if mode == "failed" else 0)
                    output = io.StringIO()
                    with patch.object(f, "REPOSITORY", root), patch.object(f.subprocess, "run", side_effect=run), contextlib.redirect_stdout(output):
                        if mode == "passed":
                            f.browser_check("https://offline.example.test")
                        else:
                            with self.assertRaises(f.FrontendUpdateError):
                                f.browser_check("https://offline.example.test")
                    self.assertNotIn("private subprocess diagnostics", output.getvalue())
                    self.assertEqual(bool(output.getvalue()), mode == "passed")

    def test_asset_inventory_requires_real_build_workers_and_rejects_empty_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            fixture = assets()
            (directory / "index.html").write_bytes(fixture["index"])
            (directory / "assets").mkdir()
            for path, content in fixture["assets"].items():
                (directory / path.lstrip("/")).write_bytes(content)
            self.assertEqual(f.build_assets(directory), fixture)
            worker = directory / "assets/pdf.worker.min-fixture.mjs"
            worker.write_bytes(b"")
            with self.assertRaisesRegex(f.FrontendUpdateError, "BUILD_ASSETS_REQUIRED"):
                f.build_assets(directory)
            worker.unlink()
            with self.assertRaisesRegex(f.FrontendUpdateError, "BUILD_ASSETS_REQUIRED"):
                f.build_assets(directory)


if __name__ == "__main__":
    unittest.main()
