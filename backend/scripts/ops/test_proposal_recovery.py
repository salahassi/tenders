"""Proposal inspection guards use synthetic records and no network."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('tested_proposal_recovery', Path(__file__).with_name('proposal-recovery.py'))
r = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = r
SPEC.loader.exec_module(r)
SELECTION = {'version': 1, 'workspace_id': '00000000-0000-4000-8000-000000000100',
             'opportunity_id': '00000000-0000-4000-8000-000000000101', 'plan_id': '00000000-0000-4000-8000-000000000102'}


class ProposalRecoveryTests(unittest.TestCase):
    def test_exact_private_selection_rejects_other_scope_and_injected_fields(self):
        with patch.object(r.access, 'WORKSPACE', SELECTION['workspace_id']):
            self.assertEqual(r.validate_selection(SELECTION), SELECTION)
            for key, value in [('version', True), ('workspace_id', '00000000-0000-4000-8000-000000000999'),
                               ('plan_id', "';drop table x"), ('content', 'private'), ('action', 'resume')]:
                with self.subTest(key=key), self.assertRaises(r.RecoveryError):
                    r.validate_selection({**SELECTION, key: value})

    def test_public_receipt_contains_no_business_metadata(self):
        self.assertEqual(r.public_receipt({'version': 1, 'mode': 'read_only_inspection', 'plan': {'id': 'private'},
                                          'private_diagnostics': 'private', 'source': 'private'}),
                         {'proposal_recovery': 'inspected', 'business_mutations': 0})
        with self.assertRaises(r.RecoveryError):
            r.public_receipt({'version': 1, 'mode': 'arbitrary private value'})

    def test_report_digest_is_explicit_and_bounded(self):
        receipt = {'version': 1, 'mode': 'read_only_inspection', 'source_hash': 'private'}
        result = r.public_receipt(receipt, 'a' * 64)
        self.assertEqual(result['report_sha256'], 'a' * 64)
        self.assertNotIn('source_hash', result)
        for digest in ['private', True, 'a' * 65]:
            with self.subTest(digest=digest), self.assertRaises(r.RecoveryError):
                r.public_receipt(receipt, digest)

    def test_push_only_registers_offline_guards(self):
        workflow = Path(__file__).resolve().parents[3] / '.github/workflows/inspect-proposal-recovery.yml'
        source = workflow.read_text()
        self.assertIn('branches: [codex/ai-reliability-resume]', source)
        self.assertIn("if: ${{ github.event_name == 'workflow_dispatch' }}", source)
        self.assertNotIn('concurrency:', source)
        self.assertEqual(source.count('secrets.DIGITALOCEAN_ACCESS_TOKEN'), 1)

    def test_real_schema_inspection_is_readonly_scoped_and_private(self):
        with patch.object(r.access, 'WORKSPACE', SELECTION['workspace_id']):
            sql = r.inspection_sql(SELECTION)
        self.assertIn('REPEATABLE READ READ ONLY', sql)
        for forbidden in ['app_command(', 'task_model_preflight(', 'check_model_payload(', 'check_requested_model_payload(', 'UPDATE ', 'INSERT ', 'DELETE ']:
            self.assertNotIn(forbidden, sql)
        result = subprocess.run(['node', str(Path(__file__).with_name('test_proposal_recovery.mjs'))],
                                input=json.dumps({'sql': sql, 'selection': SELECTION}), capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr[-4000:])


if __name__ == '__main__':
    unittest.main()
