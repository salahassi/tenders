"""Private canonical verifier recheck transport; no network or business data."""
from contextlib import ExitStack, redirect_stdout
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

SPEC=importlib.util.spec_from_file_location('tested_verifier_recheck',Path(__file__).with_name('proposal-verifier-recheck.py'))
s=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=s;SPEC.loader.exec_module(s)
SELECTION={'version':1,'workspace_id':'00000000-0000-4000-8000-000000000100','opportunity_id':'00000000-0000-4000-8000-000000000101',
 'plan_id':'00000000-0000-4000-8000-000000000102','proposal_id':'00000000-0000-4000-8000-000000000103',
 'expected_runtime_image':'registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:'+'e'*64,
 'payload':{'id':'00000000-0000-4000-8000-000000000104','candidate_id':'00000000-0000-4000-8000-000000000105',
 'writer_usage_id':'00000000-0000-4000-8000-000000000106','expected_revision':1,'expected_plan_revision':2,'expected_step_revision':1,
 'parent_thread_id':'a'*64,'candidate_content_hash':'b'*64,'candidate_hash':'c'*64,'expected_input_hash':'d'*64,'expected_graph_input_hash':'f'*64,
 'reason':'Owner requested fresh verification of the retained settled analysis writer under the corrected source-block verification contract.'}}

class VerifierRecheckTests(unittest.TestCase):
 def test_selection_exact_scope_hashes_and_revisions(self):
  with patch.object(s.r.access,'WORKSPACE',SELECTION['workspace_id']):
   self.assertEqual(s.validate_selection(SELECTION),SELECTION)
   for key,value in [('version',True),('expected_runtime_image','runtime:latest'),('workspace_id','private'),('extra','private')]:
    with self.subTest(key=key),self.assertRaises(s.RecheckError):s.validate_selection({**SELECTION,key:value})
   for key,value in [('id',"';select 1"),('expected_revision',True),('candidate_hash','private'),('reason','private'),('extra','private')]:
    changed=copy.deepcopy(SELECTION);changed['payload'][key]=value
    with self.subTest(key=key),self.assertRaises(s.RecheckError):s.validate_selection(changed)

 def test_default_check_rolls_back_and_invokes_only_canonical_operation(self):
  with patch.object(s.r.access,'WORKSPACE',SELECTION['workspace_id']):
   sql=s.recovery_sql(SELECTION)
   self.assertIn("IF NOT false THEN RAISE EXCEPTION 'PROPOSAL_RECHECK_CHECK_ROLLBACK'",sql)
   self.assertIn("IF NOT true THEN RAISE EXCEPTION 'PROPOSAL_RECHECK_CHECK_ROLLBACK'",s.recovery_sql(SELECTION,activate=True))
   self.assertIn('app_private.recheck_analysis_verifier',sql)
   self.assertNotIn('UPDATE public.',sql)
   self.assertNotIn('__HISTORY__',sql)
   with self.assertRaises(s.RecheckError):s.recovery_sql(SELECTION,activate='true')

 def test_public_receipt_contains_no_customer_or_provenance_fields(self):
  receipt={'status':'started','count':1,'child_job_id':'PRIVATE','candidate_hash':'PRIVATE','retained_history_sha256':'PRIVATE'}
  self.assertEqual(s.public_receipt(receipt,'a'*64),{'proposal_verifier_recheck':'started','count':1,'report_sha256':'a'*64})
  for change in [{'count':True},{'status':'PRIVATE'},{'count':2}]:
   with self.assertRaises(s.RecheckError):s.public_receipt({**receipt,**change})
  with self.assertRaises(s.RecheckError):s.public_receipt(receipt,'PRIVATE')

 def run_main(self,*,runtime_fail=None,sql_fail=False,digest='b'*64,cleanup_fail=False):
  with tempfile.TemporaryDirectory() as directory,ExitStack() as stack:
   stack.enter_context(patch.dict(os.environ,{'DIGITALOCEAN_ACCESS_TOKEN':'PRIVATE_SECRET','GITHUB_RUN_ID':'123'}))
   stack.enter_context(patch.object(s.r.access,'WORKSPACE',SELECTION['workspace_id']))
   stack.enter_context(patch.object(s.r.access,'prepare_cluster',return_value=Path(directory)))
   for name in ('identity','download','write_private'):stack.enter_context(patch.object(s.r.transfer,name))
   stack.enter_context(patch.object(s.r.transfer,'read_private',return_value=json.dumps(SELECTION).encode()))
   upload=stack.enter_context(patch.object(s.r.transfer,'upload',return_value=digest))
   events=[]
   def verify(image):
    events.append('runtime')
    self.assertEqual(image,SELECTION['expected_runtime_image'])
    if len(events)==runtime_fail:raise s.r.base.ResumeError('RESUME_RUNTIME_CHANGED')
   stack.enter_context(patch.object(s.r.base,'verify_runtime',side_effect=verify))
   def sql(*args):
    events.append('sql')
    if sql_fail:raise RuntimeError('PRIVATE_SQL_ERROR')
    return json.dumps({'status':'checked','count':0,'parent_job_id':'PRIVATE'})
   sql_call=stack.enter_context(patch.object(s.r.access.d,'sql',side_effect=sql))
   client=Mock(labels={})
   if cleanup_fail:client.cleanup.side_effect=RuntimeError('PRIVATE_CLEANUP')
   stack.enter_context(patch.object(s.r.observer,'Client',return_value=client))
   output=io.StringIO()
   with redirect_stdout(output):code=s.main(['--selection-object','requests/synthetic.bundle','--selection-sha256','c'*64])
   visible=output.getvalue();self.assertNotIn('PRIVATE',visible);self.assertNotIn(SELECTION['workspace_id'],visible)
   return code,json.loads(visible),events,sql_call.call_count,upload.call_count,client.cleanup.call_count

 def test_runtime_mismatch_prevents_any_sql(self):
  for phase in (1,2):
   with self.subTest(phase=phase):
    code,receipt,_events,sql,upload,_cleanup=self.run_main(runtime_fail=phase)
    self.assertEqual(code,1);self.assertEqual(sql,0);self.assertEqual(upload,0)
    self.assertEqual(receipt['code'],'RESUME_RUNTIME_CHANGED')

 def test_private_transport_success_and_failure_paths(self):
  code,receipt,events,sql,upload,cleanup=self.run_main()
  self.assertEqual((code,sql,upload,cleanup),(0,1,1,1));self.assertEqual(events,['runtime','runtime','sql'])
  self.assertEqual(receipt,{'proposal_verifier_recheck':'checked','count':0,'report_sha256':'b'*64})
  for args,expected in [({'sql_fail':True},'PROPOSAL_RECHECK_FAILED'),({'digest':'PRIVATE'},'PROPOSAL_RECHECK_RECEIPT_INVALID'),
                        ({'cleanup_fail':True},'PROPOSAL_RECHECK_CLIENT_CLEANUP_NOT_CONFIRMED')]:
   with self.subTest(args=args):
    code,receipt,*_=self.run_main(**args);self.assertEqual(code,1);self.assertEqual(receipt['code'],expected)

 def test_workflow_requires_manual_explicit_activation_and_production_mutex(self):
  workflow=(Path(__file__).resolve().parents[3]/'.github/workflows/recheck-proposal-verifier.yml').read_text()
  self.assertIn('default: check',workflow)
  self.assertIn("recover:\n    if: ${{ github.event_name == 'workflow_dispatch' }}",workflow)
  self.assertIn('group: tenderdesk-digitalocean-production',workflow)
  self.assertIn('recheck) mode_arguments+=(--activate)',workflow)
  self.assertEqual(workflow.count('secrets.DIGITALOCEAN_ACCESS_TOKEN'),1)

if __name__=='__main__':unittest.main()
