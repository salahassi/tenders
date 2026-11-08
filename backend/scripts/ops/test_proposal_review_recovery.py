import copy
import hashlib
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('review_recovery_request_tests', HERE / 'test_proposal_trial_request.py')
base = importlib.util.module_from_spec(SPEC); sys.modules[SPEC.name] = base; SPEC.loader.exec_module(base)
m = base.m


def fixture():
    proof = base.fixture()
    proof['plan']['stage'] = 'completed'
    proof['proposal']['active_version_id'] = base.J
    proof['guards']['usage_ready'] = False
    proof['whole_review_recovery'] = {'version': 1, 'kind': m.review_recovery.KIND,
        'actor_id': proof['actor_id'], 'status': 'ready', 'code': None, 'proof': {
            'plan_id': base.G, 'workspace_id': base.W, 'original_base_version_id': None,
            'input_hash': 'a' * 64, 'frozen_context_hash': 'b' * 64, 'last_ordinal': 37,
            'predecessor_version_id': base.J, 'predecessor_version_hash': 'c' * 64,
            'predecessor_sections_hash': 'd' * 64, 'predecessor_proposal_revision': 4,
            'predecessor_projection_job_id': '00000000-0000-4000-8000-000000000107',
            'predecessor_projection_job_hash': 'e' * 64,
            'saved_history': dict.fromkeys(m.review_recovery.HISTORY_HASHES, 'f' * 64) | {
                'step_count': 37, 'accepted_count': 31, 'receipts_complete': True},
            'section_keys': ['approach', 'handover'],
        }}
    return proof


class ReviewRecoveryHarnessTests(unittest.TestCase):
    def setUp(self):
        m._ATTEMPTED.clear()

    def test_canonical_command_and_original_stable_identity_are_retained(self):
        proof = fixture(); before = copy.deepcopy(proof); prepared = m.prepare(proof)
        self.assertEqual(prepared['body'], {'commands': [{'operation': 'generation.retry', 'input': {
            'id': base.G, 'expected_revision': 287, 'reason': m.REASON}}]})
        self.assertEqual(proof, before)
        # A new metadata/recovery marker cannot invent a fresh replay identity.
        normal = m.prepare(base.fixture())
        for key in ('idempotency_key', 'command_key', 'prepared_object', 'body_sha256'):
            self.assertEqual(prepared[key], normal[key])
        self.assertEqual(m.OPERATIONS, {'proposal.generate', 'generation.retry'})

    def test_missing_declined_uninstalled_or_oversized_proof_cannot_start(self):
        for status in ('not_installed', 'not_eligible', 'oversized', 'rejected'):
            proof = fixture(); proof['whole_review_recovery'].update(status=status, proof=None,
                code='USAGE_REVIEW_REQUIRED' if status == 'rejected' else None)
            with self.subTest(status=status), self.assertRaisesRegex(m.TrialRequestError, 'PROPOSAL_RENDER_RETRY_REQUIRED'):
                m.prepare(proof)
        proof = fixture(); proof.pop('whole_review_recovery')
        with self.assertRaisesRegex(m.TrialRequestError, 'PROPOSAL_RENDER_RETRY_REQUIRED'): m.prepare(proof)

    def test_all_existing_owner_lease_and_restore_guards_still_apply(self):
        for guard in m.GUARDS - {'usage_ready'}:
            proof = fixture(); proof['guards'][guard] = False
            with self.subTest(guard=guard), self.assertRaises(m.TrialRequestError): m.prepare(proof)
        for key, bad in [('actor_id', base.O), ('kind', 'untrusted'), ('version', True)]:
            proof = fixture(); proof['whole_review_recovery'][key] = bad
            with self.subTest(key=key), self.assertRaises(m.review_recovery.RecoveryProofError): m.prepare(proof)

    def test_version_source_history_scope_and_original_base_are_shape_bound(self):
        mutations = [
            lambda data: data.update(plan_id=base.O), lambda data: data.update(workspace_id=base.O),
            lambda data: data.update(input_hash='0' * 64), lambda data: data.update(original_base_version_id=base.O),
            lambda data: data.update(predecessor_version_id=base.O), lambda data: data.update(predecessor_proposal_revision=5),
            lambda data: data.update(predecessor_projection_job_id='invalid'), lambda data: data.update(last_ordinal=299),
            lambda data: data.update(frozen_context_hash='invalid'), lambda data: data.update(section_keys=['same', 'same']),
            lambda data: data['saved_history'].update(receipts_complete=False),
            lambda data: data['saved_history'].update(accepted_count=38),
            lambda data: data.update(private_customer_body='never permitted'),
        ]
        for mutation in mutations:
            proof = fixture(); mutation(proof['whole_review_recovery']['proof'])
            with self.subTest(mutation=mutation), self.assertRaises(m.review_recovery.RecoveryProofError): m.prepare(proof)

    def test_preflight_optional_catalog_read_is_bounded_and_does_not_run_commands(self):
        proof = fixture(); metadata = proof.pop('whole_review_recovery')
        with patch.object(m, 'read', side_effect=[proof, metadata]) as read:
            actual = m.inspect(object(), proof['selection'])
        self.assertEqual(actual['whole_review_recovery'], metadata)
        sql = read.call_args_list[1].args[1]
        self.assertIn("to_regprocedure('app_private.legacy_review_recovery_proof(uuid)')", sql)
        self.assertIn("EXECUTE 'SELECT app_private.legacy_review_recovery_proof($1)'", sql)
        self.assertIn("octet_length(value::text)>48000", sql)
        self.assertIn("p.error_code='GENERATED_DELIVERY_VALIDATION_FAILED'", sql)
        self.assertIn("m.user_id='" + base.A, sql)
        self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
        self.assertNotRegex(sql, r'(?i)\b(insert|update|delete|truncate|grant|revoke)\b|app_command\(|for update')
        ordinary = base.fixture()
        with patch.object(m, 'read', return_value=ordinary) as read: m.inspect(object(), ordinary['selection'])
        read.assert_called_once()

    def test_acceptance_binds_actual_new_review_lineage_and_original_hashes(self):
        proof = fixture(); prepared = m.prepare(proof); sql = m.acceptance_sql(prepared)
        for text in ("r.operation='generation.retry'", 'l.issuance_request_id=r.id', 'l.authorized_by=r.requested_by',
                     'l.original_base_version_id IS NOT DISTINCT FROM NULL::uuid', 'l.saved_history=',
                     "review_job.checkpoint->'minimum_worker_executor'='7'::jsonb", "review_step.input->'legacy_zero_inventory_review_version'='1'::jsonb",
                     "l.predecessor_version_hash='" + 'c' * 64, "l.predecessor_sections_hash='" + 'd' * 64,
                     hashlib.sha256(prepared['command_key'].encode()).hexdigest()):
            self.assertIn(text, sql)
        self.assertNotRegex(sql, r'(?i)\b(insert|update|delete|truncate|grant|revoke)\b|app_command\(|for update')
        target = m.existing_target(proof) | {'operation': 'generation.retry', 'issuance_request_id': base.O}
        with patch.object(m, 'read', return_value={'count': 1, 'bound': True, 'target': target}):
            self.assertEqual(m.verify_result(None, prepared), target)
        with patch.object(m, 'read', return_value={'count': 0, 'bound': False, 'target': None}), \
             self.assertRaisesRegex(m.TrialRequestError, 'ACCEPTANCE_UNPROVEN'): m.verify_result(None, prepared)

    def test_readback_history_change_stops_send_recheck(self):
        proof = fixture(); prepared = m.prepare(proof); fresh = copy.deepcopy(proof)
        fresh['whole_review_recovery']['proof']['saved_history']['attempts_hash'] = '0' * 64
        with patch.object(m, 'inspect', return_value=fresh), self.assertRaisesRegex(m.TrialRequestError, 'CHANGED_BEFORE_SEND'):
            m.recheck(None, proof['selection'], prepared)

    def test_unknown_send_has_the_same_single_request_and_durable_marker_rules(self):
        prepared = m.prepare(fixture()); client = Mock()
        client.request.return_value = Mock(status=0, body=b'')
        session = {'user': {'id': base.A}, 'access_token': 'synthetic-private-session'}
        persisted = Mock(side_effect=lambda value: hashlib.sha256(m.encoded(value)).hexdigest())
        self.assertTrue(m.send(client, session, prepared, persisted)['unknown'])
        with self.assertRaisesRegex(m.TrialRequestError, 'ALREADY_ATTEMPTED'): m.send(client, session, prepared, persisted)
        client.request.assert_called_once(); persisted.assert_called_once()


if __name__ == '__main__': unittest.main()
