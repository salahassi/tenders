import copy
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("tested_langsmith_profile", Path(__file__).with_name("fix-langsmith-profile.py"))
p = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = p
SPEC.loader.exec_module(p)


def resource(name):
    return {"metadata": {"name": name, "namespace": p.d.NAMESPACE, "resourceVersion": "1", "generation": 1,
                         "labels": {"app.kubernetes.io/managed-by": "tenderdesk-deployment"}}}


class LangsmithProfileRepairTests(unittest.TestCase):
    def setUp(self):
        self.resources = {("namespace", p.d.NAMESPACE): resource(p.d.NAMESPACE)}
        for name in p.COMPONENTS:
            value = resource(name)
            value["spec"] = {"replicas": 1, "template": {"metadata": {"labels": {"preserve": "yes"}}, "spec": {
                "containers": [{"name": name, "image": "registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:" + "a" * 64,
                    "env": [{"name": "APP_RUNTIME_SERVICE", "value": name}], "envFrom": [{"secretRef": {"name": "tenderdesk-runtime"}}]}],
                "terminationGracePeriodSeconds": 240}}}
            value["status"] = {"readyReplicas": 1, "updatedReplicas": 1, "observedGeneration": 1}
            self.resources["deployment", name] = value
        self.calls = []
        self.conflict = False

    def get(self, kind, name): return copy.deepcopy(self.resources.get((kind, name)))

    def command(self, args, *, payload=None, **kwargs):
        self.calls.append((copy.deepcopy(args), payload))
        if args[0] == "patch":
            self.assertIn("--patch-file=/dev/stdin", args)
            if self.conflict: raise p.d.DeployError("KUBERNETES_COMMAND_FAILED")
            value = self.resources["deployment", args[2]]
            ops = json.loads(payload)
            self.assertEqual(ops[0], {"op": "test", "path": "/metadata/resourceVersion", "value": "1"})
            self.assertEqual(ops[1]["path"], "/spec/template/spec/containers/0/env")
            value["spec"]["template"]["spec"]["containers"][0]["env"] = ops[1]["value"]
            return ""
        if "run" in args:
            self.assertEqual(payload, p.SMOKE.read_text())
            self.assertNotIn("--allow-net", args)
            self.assertIn("--allow-read=/app,/deno-dir,/tmp", args)
            self.assertIn("--frozen", args)
            return json.dumps({"local_graph": "passed", "home_profile_read_denied": True, "outbound_trace_calls": 0})
        return json.dumps({"profile_configured": True})

    def context(self):
        self.addCleanup(patch.stopall)
        patch.object(p.d, "get", side_effect=self.get).start()
        patch.object(p.d, "command", side_effect=self.command).start()
        patch.object(p.d, "wait_deployments").start()

    def test_only_adds_fixed_selector_preserving_spec_and_checks_restricted_dependency(self):
        self.context(); before = copy.deepcopy(self.resources)
        report = p.repair()
        self.assertEqual(report["updated"], ["api", "worker"])
        self.assertFalse(report["permissions_broadened"])
        for name in p.COMPONENTS:
            original = before["deployment", name]["spec"]
            current = self.resources["deployment", name]["spec"]
            self.assertEqual(p.without_selector(current), original)
        self.assertEqual(sum(1 for args, _ in self.calls if "run" in args), 1)

    def test_replay_skips_rollout_but_repeats_actual_environment_and_dependency_proof(self):
        self.context(); p.repair(); self.calls.clear()
        report = p.repair()
        self.assertEqual(report["updated"], [])
        self.assertFalse(any(args[0] == "patch" for args, _ in self.calls))
        self.assertEqual(len(self.calls), 3)

    def test_refuses_existing_different_selector_or_mutable_image_before_any_write(self):
        for selector in (True, False):
            with self.subTest(selector=selector):
                self.setUp(); self.context()
                value = self.resources["deployment", "worker"]
                if selector: value["spec"]["template"]["spec"]["containers"][0]["env"].append({"name": p.VARIABLE, "value": "/home/profile.json"})
                else: value["spec"]["template"]["spec"]["containers"][0]["image"] = "mutable:latest"
                with self.assertRaises(p.ProfileError): p.repair()
                self.assertEqual(self.calls, [])

    def test_resource_version_conflict_stops_without_touching_worker(self):
        self.context(); self.conflict = True; before = copy.deepcopy(self.resources)
        with self.assertRaises(p.d.DeployError): p.repair()
        self.assertEqual(self.resources, before)
        self.assertEqual(len(self.calls), 1)


if __name__ == "__main__": unittest.main()
