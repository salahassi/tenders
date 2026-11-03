"""Canonical proposal successor safety, using synthetic records only."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('tested_proposal_successor',Path(__file__).with_name('proposal-successor.py'))
s=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=s;SPEC.loader.exec_module(s)
SELECTION={
 'version':1,'workspace_id':'00000000-0000-4000-8000-000000000100','opportunity_id':'00000000-0000-4000-8000-000000000101',
 'plan_id':'00000000-0000-4000-8000-000000000102','proposal_id':'00000000-0000-4000-8000-000000000103',
 'expected_plan_revision':1,'expected_opportunity_revision':1,'expected_proposal_revision':1,'expected_workspace_evidence_revision':1,
 'expected_frozen_snapshot_sha256':'a'*64,'expected_input_hash':'a'*64,
 'expected_jobs':[{'id':'00000000-0000-4000-8000-000000000104','revision':1}],
 'expected_usage':[{'id':'00000000-0000-4000-8000-000000000105','record_sha256':'b'*64}],
 'expected_documents':[{'id':'00000000-0000-4000-8000-000000000106','revision':1,'kind':'rfp','status':'ready','archived':False,
                        'original_hash':'c'*64,'extraction_hash':'d'*64,'extracted_characters':100}],
 'expected_admission':None,'expected_workflow_version':1,
 'expected_runtime_image':'registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:'+'e'*64,
}

class ProposalSuccessorTests(unittest.TestCase):
 def test_selection_rejects_injected_scope_or_options(self):
  with patch.object(s.r.access,'WORKSPACE',SELECTION['workspace_id']):
   self.assertEqual(s.validate_selection(SELECTION),SELECTION)
   for key,value in [('version',True),('expected_plan_revision',True),('expected_input_hash','private'),('expected_runtime_image','runtime:latest'),
                     ('expected_workflow_version',3),('expected_jobs',[]),('proposal_id',"';select 1"),('extra','private')]:
    with self.subTest(key=key),self.assertRaises(s.SuccessorError):s.validate_selection({**SELECTION,key:value})
   duplicate=copy.deepcopy(SELECTION);duplicate['expected_usage']*=2
   with self.assertRaises(s.SuccessorError):s.validate_selection(duplicate)

 def test_public_receipt_excludes_private_recovery_evidence(self):
  value={'status':'started','count':1,'plan_id':'private','language':'private','retained_history_sha256':'private','code':'private'}
  self.assertEqual(s.public_receipt(value,'f'*64),{'proposal_successor':'started','count':1,'report_sha256':'f'*64})
  with self.assertRaises(s.SuccessorError):s.public_receipt({'status':'started','count':True})
  with self.assertRaises(s.SuccessorError):s.public_receipt(value,'private')

 def test_default_mode_is_canonical_rollback_and_requires_typed_activation(self):
  with patch.object(s.r.access,'WORKSPACE',SELECTION['workspace_id']):
   self.assertIn("IF NOT false THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_CHECK_ROLLBACK'",s.recovery_sql(SELECTION))
   self.assertIn("IF NOT true THEN RAISE EXCEPTION 'PROPOSAL_SUCCESSOR_CHECK_ROLLBACK'",s.recovery_sql(SELECTION,restart=True))
   with self.assertRaises(s.SuccessorError):s.recovery_sql(SELECTION,restart='true')

 def test_workflow_requires_manual_activation_and_serializes_production(self):
  workflow=(Path(__file__).resolve().parents[3]/'.github/workflows/recover-proposal-successor.yml').read_text()
  self.assertIn('default: check',workflow)
  self.assertIn("recover:\n    if: ${{ github.event_name == 'workflow_dispatch' }}",workflow)
  self.assertIn('group: tenderdesk-digitalocean-production',workflow)
  self.assertIn('restart) mode_arguments+=(--restart)',workflow)
  self.assertEqual(workflow.count('secrets.DIGITALOCEAN_ACCESS_TOKEN'),1)

 def test_canonical_successor_safety_in_complete_schema(self):
  result=subprocess.run(['node',str(Path(__file__).with_name('test_proposal_successor.mjs'))],capture_output=True,text=True,timeout=120)
  self.assertEqual(result.returncode,0,result.stdout+result.stderr[-5000:])

if __name__=='__main__':unittest.main()
