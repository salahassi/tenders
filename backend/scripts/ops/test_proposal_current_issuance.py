import copy
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import unittest
import subprocess
import time
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('issuance_target', Path(__file__).with_name('proposal-current-issuance.py'))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class IssuanceTests(unittest.TestCase):
    def setUp(self):
        self.target = {key: '00000000-0000-4000-8000-' + str(i).zfill(12) for i, key in enumerate(sorted(m.KEYS), 1)}
        self.now = 0
        self.reads = self.verifies = 0
        self.start = datetime(2026, 11, 5, tzinfo=timezone.utc)

    def stamp(self, seconds):
        return (self.start + timedelta(seconds=seconds)).isoformat()

    def sample(self, seconds=0):
        return {'version': 1, 'kind': 'current_proposal_issuance_observation', 'target': self.target.copy(),
                'observed_at': self.stamp(seconds), 'guards': dict.fromkeys(m.GUARDS, True),
                'source_check': 'passed', 'artifact_check': 'not_issued', 'package': None,
                'issuance': {'id': self.target['issuance_request_id'], 'plan_id': self.target['plan_id'],
                    'requested_by': self.target['actor_id'], 'operation': 'proposal.generate',
                    'accepted_at': self.stamp(0), 'deadline_at': self.stamp(600), 'outcome': 'active',
                    'completed_at': None, 'error_code': None, 'issued_snapshot_id': None,
                    'effective_outcome': 'active', 'effective_error_code': None, 'effective_completed_at': None},
                'plan': {'status': 'running', 'error_code': None, 'updated_at': self.stamp(seconds)}, 'terminal_jobs': []}

    def run_observer(self, sample_factory):
        def read():
            self.reads += 1
            return sample_factory(self.now)
        def sleep(delay):
            self.now += delay
        def verify():
            self.verifies += 1
        return m.observe(self.target, read, verify, monotonic=lambda: self.now, sleep=sleep)

    def issued(self):
        sample = self.sample(102)
        sample['issuance'].update(outcome='issued', completed_at=self.stamp(100), issued_snapshot_id='snapshot',
                                  effective_outcome='issued', effective_completed_at=self.stamp(100))
        sample['artifact_check'] = 'passed'
        sample['package'] = {'snapshot_id': 'snapshot', 'current_version': True, 'current_snapshot': True,
            'validated_generated_draft': True, 'content_state': 'generated_review_draft', 'approval_state': 'draft',
            'required_volumes': ['technical', 'financial'], 'render_job': {'status': 'succeeded', 'updated_at': self.stamp(99)},
            'artifacts': [{'volume': volume, 'status': 'ready', 'renderer_version': '3', 'expected_size': 1000,
                           'content_hash': 'a' * 64, 'updated_at': self.stamp(98)} for volume in ['technical', 'financial']]}
        return sample

    def test_exact_target_and_read_only_sql(self):
        sql = m.observation_sql(self.target)
        self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', sql)
        self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
        self.assertNotRegex(sql, r'(?i)\b(insert|update|delete|truncate|grant|revoke)\b|for update|app_command\(')
        self.assertIn('public.delivery_artifact_context', sql)
        self.assertIn('app_private.check_source_semantics', sql)
        self.assertNotIn('__PLAN__', sql)
        for target in (self.target | {'plan_id': "';DELETE"}, self.target | {'extra': 'field'}):
            with self.assertRaises(m.IssuanceObservationError):
                m.observation_sql(target)

    def test_known_early_request_failure_returns_without_sleep(self):
        sample = self.sample(23)
        sample['issuance'].update(outcome='failed', completed_at=self.stamp(22), error_code='NO_AGENTS_AVAILABLE',
            effective_outcome='failed', effective_completed_at=self.stamp(22), effective_error_code='NO_AGENTS_AVAILABLE')
        result = self.run_observer(lambda _: sample)
        self.assertEqual((result['outcome'], result['code'], self.now, self.reads), ('failed', 'NO_AGENTS_AVAILABLE', 0, 1))
        self.assertEqual(result['completed_at'], self.stamp(22))
        self.assertFalse(result['whole_package_issued'])

    def test_worker_terminal_error_stops_before_request_persistence_without_invented_completion(self):
        sample = self.sample(23)
        sample['terminal_jobs'] = [{'type': 'generate_section', 'status': 'blocked', 'error_code': 'NO_AGENTS_AVAILABLE', 'updated_at': self.stamp(22)}]
        result = self.run_observer(lambda _: sample)
        self.assertEqual((result['outcome'], result['code'], self.now), ('terminal_pending', 'NO_AGENTS_AVAILABLE', 0))
        self.assertIsNone(result['completed_at'])
        self.assertIsNone(result['effective_completed_at'])

    def test_observation_uses_remaining_database_clock_and_keeps_effective_timeout_separate(self):
        def sample(now):
            value = self.sample(590 + now)
            if now >= 10:
                value['issuance'].update(effective_outcome='failed', effective_error_code='PROPOSAL_ISSUANCE_TIMEOUT',
                                         effective_completed_at=self.stamp(600))
            return value
        result = self.run_observer(sample)
        self.assertEqual((result['outcome'], self.now, self.reads), ('failed', 10, 3))
        self.assertIsNone(result['completed_at'])
        self.assertEqual(result['effective_completed_at'], self.stamp(600))
        self.assertEqual(result['accepted_at'], self.stamp(0))

    def test_success_requires_whole_volume_metadata_and_preserves_approval_download_limits(self):
        result = self.run_observer(lambda _: self.issued())
        self.assertEqual((result['outcome'], result['completed_at']), ('issued', self.stamp(100)))
        self.assertTrue(result['whole_package_issued'])
        self.assertFalse(result['human_approval_verified'])
        self.assertFalse(result['authenticated_download_verified'])
        self.assertTrue(result['metadata_only'])

    def test_partial_wrong_or_stale_package_never_counts_as_issued(self):
        for mutation in (
            lambda s: s['package']['artifacts'].pop(),
            lambda s: s['package'].update(current_version=False),
            lambda s: s['package'].update(current_snapshot=False),
            lambda s: s['package']['artifacts'][0].update(status='pending'),
            lambda s: s['package']['artifacts'][0].update(updated_at=self.stamp(101)),
            lambda s: s['package'].update(validated_generated_draft=False),
            lambda s: s.update(artifact_check='STALE_INPUT'),
        ):
            sample = self.issued()
            mutation(sample)
            result = self.run_observer(lambda _: sample)
            self.assertEqual(result['outcome'], 'observation_failed')
            self.assertFalse(result['whole_package_issued'])
            self.assertEqual(result['completed_at'], self.stamp(100))

    def test_every_currentness_guard_blocks_success_and_retains_actual_timestamps(self):
        for key in m.GUARDS:
            sample = self.issued()
            sample['guards'][key] = False
            result = self.run_observer(lambda _: sample)
            self.assertEqual(result['outcome'], 'guard_failed')
            self.assertEqual(result['completed_at'], self.stamp(100))
            self.assertFalse(result['whole_package_issued'])

    def test_identity_or_clock_changes_never_restart_observation(self):
        for key, value in [('accepted_at', self.stamp(5)), ('deadline_at', self.stamp(605)),
                           ('requested_by', self.target['plan_id']), ('accepted_at', '2026-11-05T00:00:00')]:
            def sample(now):
                result = self.sample(now)
                if now:
                    result['issuance'][key] = value
                return result
            self.now = self.reads = 0
            result = self.run_observer(sample)
            self.assertEqual(result['outcome'], 'observation_failed')
            self.assertEqual(self.now, 5)

    def test_lost_observer_transport_is_not_resent_and_retains_last_sample(self):
        def sample(now):
            if now:
                raise OSError('private transport detail')
            return self.sample(590)
        result = self.run_observer(sample)
        self.assertEqual((result['outcome'], result['code'], self.reads), ('observation_failed', 'CURRENT_ISSUANCE_READ_FAILED', 2))
        self.assertEqual(len(result['samples']), 1)
        self.assertNotIn('private transport', str(result))

    def test_stuck_database_clock_cannot_extend_observer_bound(self):
        result = self.run_observer(lambda _: self.sample(599))
        self.assertEqual(result['outcome'], 'observation_timeout')
        self.assertLessEqual(self.now, 16)

    def test_owned_subprocess_cannot_extend_absolute_observer_watchdog(self):
        # A real owned process, not a fake clock: SIGALRM interrupts run(),
        # whose documented exception cleanup kills/waits for the child.
        started = time.monotonic()
        with patch.object(m, 'MAX_SECONDS', 0.1):
            result = m.observe(self.target, lambda: self.sample(0),
                lambda: subprocess.run(['python3', '-c', 'import time;time.sleep(20)'], check=True))
        self.assertEqual((result['outcome'], result['code']), ('observation_timeout', 'CURRENT_ISSUANCE_OBSERVATION_TIMEOUT'))
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(result['samples'], [])


if __name__ == '__main__':
    unittest.main()
