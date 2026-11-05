from contextlib import ExitStack, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('tested_release_preflight', Path(__file__).with_name('proposal-delivery-preflight.py'))
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)


class ReleasePreflightTests(unittest.TestCase):
    def run_probe(self, fail=None, error=None):
        stages = [('source', m.p.release, 'verify_source'), ('cluster', m.p.d.probe, 'validate_cluster'),
                  ('worker_resources', m.p, 'worker_resource_envelope'), ('api_resources', m.p, 'api_resource_envelope'),
                  ('storage_gateway', m.p.gateway, 'preflight'), ('https', m.p.https, 'preflight')]
        calls = []
        def call(stage):
            def run(*args, **kwargs):
                calls.append(stage)
                print('PRIVATE_HELPER_PAYLOAD')
                if stage == fail:
                    raise error
            return run
        output = io.StringIO()
        with ExitStack() as stack:
            for stage, obj, name in stages:
                stack.enter_context(patch.object(obj, name, side_effect=call(stage)))
            stack.enter_context(patch.object(m.p.u, 'deployment', return_value={}))
            mutation = stack.enter_context(patch.object(m.p, 'update', side_effect=AssertionError('WRITE_FORBIDDEN')))
            client = stack.enter_context(patch.object(m.p.inventory.observer, 'Client', side_effect=AssertionError('CLIENT_FORBIDDEN')))
            with redirect_stdout(output):
                result = m.main()
            mutation.assert_not_called()
            client.assert_not_called()
        self.assertNotIn('PRIVATE', output.getvalue())
        return result, json.loads(output.getvalue()), calls

    def test_pass_is_read_only_and_scoped(self):
        result, receipt, calls = self.run_probe()
        self.assertEqual(result, 0)
        self.assertEqual(receipt['completed'], calls)
        self.assertFalse(receipt['schema_or_workload_writes'])
        self.assertEqual(receipt['scope'], 'resource_and_proxy_prerequisites_only')

    def test_each_failure_stops_before_later_checks_and_redacts_unknown_error(self):
        stages = ['source', 'cluster', 'worker_resources', 'api_resources', 'storage_gateway', 'https']
        for i, stage in enumerate(stages):
            with self.subTest(stage=stage):
                result, receipt, calls = self.run_probe(stage, RuntimeError('PRIVATE_SQL_RESPONSE'))
                self.assertEqual(result, 1)
                self.assertEqual(receipt['stage'], stage)
                self.assertEqual(receipt['completed'], stages[:i])
                self.assertEqual(calls, stages[:i+1])
                self.assertEqual(receipt['code'], 'DELIVERY_PREFLIGHT_FAILED')

    def test_fixed_proxy_codes_survive_without_private_helper_output(self):
        for stage, error in [('storage_gateway', m.p.gateway.GatewayError('STORAGE_GATEWAY_TMP_BELOW_PROOF')),
                             ('https', m.p.https.HttpsError('DELIVERY_HTTPS_TEMPLATE_CHANGED'))]:
            with self.subTest(stage=stage):
                _, receipt, _ = self.run_probe(stage, error)
                self.assertEqual(receipt['code'], str(error))

    def test_release_preserves_fixed_proxy_guard_errors(self):
        for error in [m.p.gateway.GatewayError('STORAGE_GATEWAY_TMP_BELOW_PROOF'),
                      m.p.https.HttpsError('DELIVERY_HTTPS_TEMPLATE_CHANGED')]:
            output = io.StringIO()
            with patch.object(m.p, 'update', side_effect=error), redirect_stdout(output):
                self.assertEqual(m.p.main(), 1)
            self.assertEqual(json.loads(output.getvalue())['code'], str(error))

    def test_release_preserves_only_bounded_sql_metadata_and_fixed_transport_codes(self):
        def failed_update():
            print(json.dumps({'deployment':'tenderdesk-dev','status':'sql_failed','sqlstate':'42501','line':22,'private':'PRIVATE_SQL'}))
            raise m.p.d.DeployError('MIGRATION_SQL_FAILED')
        output = io.StringIO()
        with patch.object(m.p,'update',side_effect=failed_update), redirect_stdout(output):
            self.assertEqual(m.p.main(),1)
        receipt=json.loads(output.getvalue())
        self.assertEqual(receipt['code'],'MIGRATION_SQL_FAILED')
        self.assertEqual(receipt['sql_failure'],{'sqlstate':'42501','line':22})
        self.assertNotIn('PRIVATE',output.getvalue())
        output=io.StringIO()
        with patch.object(m.p,'update',side_effect=m.p.d.DeployError('PRIVATE_RESPONSE')), redirect_stdout(output):
            self.assertEqual(m.p.main(),1)
        self.assertEqual(json.loads(output.getvalue())['code'],'DELIVERY_UPDATE_FAILED')
        self.assertNotIn('PRIVATE',output.getvalue())
