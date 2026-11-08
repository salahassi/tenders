import copy
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location('tested_runtime_snapshot', Path(__file__).with_name('proposal-runtime-snapshot.py'))
m = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(m)


def fixture():
    return {'items': [{'metadata': {'namespace': 'fixture', 'name': role + '-abc-123',
        'uid': '00000000-0000-4000-8000-00000000000' + str(i),
        'labels': {'app.kubernetes.io/name': role}, 'annotations': {'private': 'private-customer-value'}},
        'spec': {'containers': [{'name': role, 'env': [{'name': 'PRIVATE_KEY', 'value': 'private-secret'}]}]},
        'status': {'containerStatuses': [{'name': role, 'ready': True, 'restartCount': i}]}}
        for i, role in enumerate(m.COMPONENTS)]}


def metrics():
    return {'items': [{'metadata': {'namespace': 'fixture', 'name': role + '-abc-123'},
        'timestamp': '2026-11-08T20:20:00Z', 'window': '30.5s',
        'containers': [{'name': role, 'usage': {'cpu': '125000000n', 'memory': '64Mi'}}]}
        for role in m.COMPONENTS]}


CGROUP = {'cpu.stat': 'usage_usec 1000\nuser_usec 800\nsystem_usec 200\nnr_periods 20\nnr_throttled 3\nthrottled_usec 100\n',
    'memory.current': '100000\n', 'memory.events': 'low 0\nhigh 1\nmax 0\noom 0\noom_kill 0\n'}


class RuntimeSnapshotTests(unittest.TestCase):
    def deploy(self, values=None):
        return SimpleNamespace(NAMESPACE='fixture', command=Mock(side_effect=values or [
            json.dumps(fixture()), json.dumps(metrics()), json.dumps(CGROUP)]))

    def test_fixed_projection_retains_cpu_memory_restarts_without_private_metadata(self):
        d = self.deploy(); value = m.capture(d, lambda: 150)
        self.assertEqual((value['status'], value['metrics_status'], value['cgroup_status']), ('captured',) * 3)
        self.assertEqual(len(value['pods']), 3)
        worker = value['pods'][0]
        self.assertEqual(worker['usage']['cpu_nanocores'], 125000000)
        self.assertEqual(worker['usage']['memory_bytes'], 64 * 1024**2)
        self.assertEqual(worker['usage']['window_ms'], 30500)
        self.assertEqual(worker['cgroup']['cpu']['nr_throttled'], 3)
        self.assertEqual(worker['cgroup']['memory_events']['oom_kill'], 0)
        self.assertEqual(set(worker), {'component', 'identity', 'ready', 'restarts', 'usage', 'cgroup'})
        raw = json.dumps(value)
        for private in ('private-customer-value', 'private-secret', 'PRIVATE_KEY', 'worker-abc-123', 'annotations'):
            self.assertNotIn(private, raw)
        self.assertEqual(d.command.call_count, 3)
        for call in d.command.call_args_list:
            self.assertLessEqual(call.kwargs['timeout'], 2)
        self.assertEqual(d.command.call_args.args[0][-1], m.CGROUP_SCRIPT)
        self.assertNotIn('env', m.CGROUP_SCRIPT)
        self.assertNotIn('fetch', m.CGROUP_SCRIPT)

    def test_reserve_exhaustion_skips_without_a_command(self):
        d = self.deploy(); value = m.capture(d, lambda: 70)
        self.assertEqual(value['status'], 'skipped_budget'); d.command.assert_not_called()

    def test_absolute_extra_budget_bounds_each_remaining_command(self):
        d = self.deploy()
        with patch.object(m.time, 'monotonic', side_effect=[0, 0, 2, 4, 6]):
            value = m.capture(d, lambda: 77)
        self.assertEqual(value['elapsed_ms'], 6000)
        self.assertEqual([c.kwargs['timeout'] for c in d.command.call_args_list], [2, 2, 2])

    def test_unavailable_optional_sources_keep_pod_metadata_and_fixed_status(self):
        d = self.deploy([json.dumps(fixture()), RuntimeError('private-metrics-response'), RuntimeError('private-cgroup-response')])
        value = m.capture(d, lambda: 150)
        self.assertEqual(value['status'], 'captured')
        self.assertEqual((value['metrics_status'], value['cgroup_status']), ('unavailable', 'unavailable'))
        self.assertTrue(all(row['usage'] is None and row['cgroup'] is None for row in value['pods']))
        self.assertNotIn('private-', json.dumps(value))

    def test_invalid_identity_cardinality_or_large_response_never_executes(self):
        variants = [json.dumps({'items': fixture()['items'] * 9}), 'x' * (m.MAX_BYTES + 1)]
        wrong = fixture(); wrong['items'][0]['metadata']['namespace'] = 'other'; variants.append(json.dumps(wrong))
        wrong = fixture(); wrong['items'][0]['metadata']['name'] = 'worker; cat /private'; variants.append(json.dumps(wrong))
        for raw in variants:
            d = self.deploy([raw]); value = m.capture(d, lambda: 150)
            self.assertEqual(value['status'], 'unavailable'); self.assertEqual(value['pods'], [])
            d.command.assert_called_once()

    def test_invalid_numeric_metadata_cannot_enter_private_report(self):
        for text in ('private-response', '-1', 'NaN', '1e999', '12secret'):
            with self.assertRaises((ValueError, TypeError)): m.quantity(text, True)
        wrong = copy.deepcopy(CGROUP); wrong['cpu.stat'] += 'nr_throttled 2\n'
        with self.assertRaises(ValueError): m.cgroup(json.dumps(wrong))
        wrong = copy.deepcopy(CGROUP); wrong['memory.current'] = 'private-customer-value'
        with self.assertRaises(ValueError): m.cgroup(json.dumps(wrong))


if __name__ == '__main__': unittest.main()
