import importlib.util,unittest
from pathlib import Path
s=importlib.util.spec_from_file_location('summary_prior_checks',Path(__file__).with_name('job-summary-verified-packages.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class VerifiedPackages(unittest.TestCase):
 def test_application_dependency_fixture_and_workflow_changes_need_fresh_checks(self):
  for path in ['frontend/src/lib/store.tsx','backend/package-lock.json','backend/supabase/migrations/change.sql','backend/scripts/testing/capacity_api_batch.ts','backend/deploy/Dockerfile','AGENTS.md','.github/workflows/deploy-proposal-delivery.yml']:
   with self.subTest(path=path),self.assertRaises(ValueError):m.verify_changed_paths([path])
  m.verify_changed_paths(['backend/scripts/ops/proposal-delivery-images.py','backend/docs/IMPLEMENTATION_CHECKLIST.md',m.WORKFLOW])
 def test_prior_steps_source_and_repository_are_all_required(self):
  run={'head_sha':m.REVISION,'status':'completed','path':m.WORKFLOW,'repository':{'full_name':m.REPOSITORY}}
  outcomes={'Verify exact reviewed source and both application packages':'success','Verify actual browser workspace loading':'success',"Remove only this release attempt's owned temporary database client":'success','Remove private runner credentials and build logs':'success','Publish exact qualified runtime and frontend':'failure','Update images and verify authenticated job summaries':'skipped'}
  def jobs():return [{'run_id':m.RUN,'name':'release','steps':[{'name':k,'conclusion':v} for k,v in outcomes.items()]}]
  m.verify_evidence(run,jobs())
  for key,value in [('head_sha','0'*40),('repository',{'full_name':'other/repo'}),('status','in_progress'),('path','other.yml')]:
   with self.subTest(key=key),self.assertRaises(ValueError):m.verify_evidence({**run,key:value},jobs())
  for key in outcomes:
   changed=jobs();next(s for s in changed[0]['steps'] if s['name']==key)['conclusion']='cancelled'
   with self.subTest(step=key),self.assertRaises(ValueError):m.verify_evidence(run,changed)
if __name__=='__main__':unittest.main()
