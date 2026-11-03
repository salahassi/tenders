"""Boundary tests for the small typed-verification code-only release adapter."""
from contextlib import contextmanager
import copy
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("tested_typed_verification_release", HERE / "typed-verification-update.py")
p = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = p
SPEC.loader.exec_module(p)
SPEC = importlib.util.spec_from_file_location("typed_verification_shared_test_fixture", HERE / "test_model_validation_update.py")
fixture_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = fixture_module
SPEC.loader.exec_module(fixture_module)


class TypedVerificationReleaseTests(unittest.TestCase):
    @contextmanager
    def fixture(self):
        # Reuse the existing JSON-patch simulator and forbidden-SQL spies against
        # this adapter's isolated helper instance, without copying rollout code.
        with patch.object(fixture_module, "p", p.code):
            case = fixture_module.ModelValidationReleaseTests(methodName="runTest")
            with case.fixture() as values:
                yield values

    def test_exact_baseline_unique_marker_and_all_previous_sources(self):
        self.assertEqual(p.code.BASE_RUNTIME, p.code.u.REGISTRY + "runtime@sha256:bded9f019592be84ae45e078d55a52e438c3f6942b2bd1bf35d148d4ff0d6c4a")
        self.assertEqual(p.code.RELEASE, "typed-verification-code-v1")
        self.assertEqual(p.code.ROLLOUT_MARKER, "tenderdesk-deployment/typed-verification-image")
        self.assertEqual(len(p.code.PRIOR_MIGRATIONS), 5)
        p.code.verify_source()
        self.assertEqual(fixture_module.p.ROLLOUT_MARKER, "tenderdesk-deployment/model-validation-image")
        self.assertEqual(len(fixture_module.p.PRIOR_MIGRATIONS), 2)

    def test_shared_rollout_preserves_everything_else_and_waits_for_strategy_acknowledgement(self):
        with self.fixture() as (state, events, controls, retained, emitted):
            before = copy.deepcopy(state)
            p.code.update()
            self.assertEqual(events, ["image:api", "ready:api", "strategy:Recreate", "image:worker",
                                     "ready:worker", "drain", "public", "strategy:RollingUpdate", "ready:worker"])
            for name, value in state.items():
                if name in ("api", "worker"):
                    self.assertEqual(p.code.image_of(value), fixture_module.CANDIDATE)
                    self.assertEqual(p.code.u.without_image(value), p.code.u.without_image(before[name]))
                    self.assertNotIn(p.code.ROLLOUT_MARKER, value["metadata"]["annotations"])
                else:
                    self.assertEqual(value, before[name])
            receipt = emitted.call_args.kwargs
            for key in ("database_accessed", "schema_changed", "processing_retried"):
                self.assertFalse(receipt[key])

    def test_ambiguous_acceptance_retains_exact_candidate_and_reuses_owned_transition(self):
        with self.fixture() as (state, events, controls, retained, emitted):
            controls["failure"] = "public"
            with self.assertRaisesRegex(p.code.u.UpdateError, "FIXTURE_FAILURE"):
                p.code.update()
            self.assertEqual(state["worker"]["metadata"]["annotations"][p.code.ROLLOUT_MARKER], fixture_module.CANDIDATE)
            self.assertTrue(any(call.args[0] == "compatible_runtime_retained" for call in emitted.call_args_list))
            controls["failure"] = None
            p.code.update()
            self.assertEqual(p.code.image_of(state["api"]), fixture_module.CANDIDATE)
            self.assertEqual(p.code.image_of(state["worker"]), fixture_module.CANDIDATE)
            self.assertNotIn(p.code.ROLLOUT_MARKER, state["worker"]["metadata"]["annotations"])

    def test_foreign_baseline_or_rollout_marker_refuses_without_mutation(self):
        for foreign in ("api", "worker", "marker"):
            with self.subTest(foreign=foreign), self.fixture() as (state, events, controls, retained, emitted):
                if foreign == "marker":
                    state["worker"]["spec"]["strategy"] = {"type": "Recreate"}
                    state["worker"]["metadata"]["annotations"][p.code.ROLLOUT_MARKER] = "foreign"
                else:
                    state[foreign]["spec"]["template"]["spec"]["containers"][0]["image"] = "foreign"
                with self.assertRaises(p.code.u.UpdateError):
                    p.code.update()
                self.assertEqual(events, [])

    def test_workflow_preserves_code_only_manual_production_and_immutable_reuse(self):
        workflow = (p.code.u.d.ROOT.parent / ".github/workflows/deploy-typed-verification.yml").read_text()
        self.assertEqual(workflow.count("if: ${{ github.event_name == 'workflow_dispatch' }}"), 3)
        self.assertIn("typed-verification-update.py", workflow)
        self.assertIn("model-validation-runtime-image.py", workflow)
        self.assertIn("TENDERDESK_REUSE_RUNTIME_IMAGE: ${{ inputs.candidate_image }}", workflow)
        self.assertIn("group: tenderdesk-digitalocean-production", workflow)
        for forbidden in ("model-admission-update.py", "verifier-recheck-update.py", "proposal-verifier-recheck.py", "--activate", "frontend/Dockerfile"):
            self.assertNotIn(forbidden, workflow)


if __name__ == "__main__":
    unittest.main()
