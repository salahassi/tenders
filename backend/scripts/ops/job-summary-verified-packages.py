#!/usr/bin/env python3
"""Reuse only unchanged package checks from the observed failed publication run."""
import json
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
RUN=42367604849
REVISION='84b33ca66e006b085d2d597b27fc3af43964d7f7'
REPOSITORY='salahassi/tenders'
WORKFLOW='.github/workflows/deploy-job-summary-pagination.yml'

def require(ok):
    if not ok:raise ValueError('SUMMARY_PRIOR_PACKAGE_CHECKS_UNVERIFIED')

def verify_evidence(run,jobs):
    require(run.get('head_sha')==REVISION and run.get('status')=='completed'
      and run.get('path')==WORKFLOW and run.get('repository',{}).get('full_name')==REPOSITORY)
    require(len(jobs)==1 and jobs[0].get('run_id')==RUN and jobs[0].get('name')=='release')
    steps={s['name']:s.get('conclusion') for s in jobs[0].get('steps',[])}
    require(all(steps.get(name)=='success' for name in (
      'Verify exact reviewed source and both application packages','Verify actual browser workspace loading',
      'Remove only this release attempt\'s owned temporary database client','Remove private runner credentials and build logs')))
    require(steps.get('Publish exact qualified runtime and frontend')=='failure'
      and steps.get('Update images and verify authenticated job summaries')=='skipped')

def verify_changed_paths(paths):
    # All changed operations are re-tested in this run. Application, dependency,
    # runtime fixture, Dockerfile and schema changes require fresh package checks.
    require(all(path.startswith(('backend/docs/','backend/scripts/ops/')) or path==WORKFLOW for path in paths))

def main():
    def api(path):
        result=subprocess.run(['gh','api','repos/'+REPOSITORY+'/actions/'+path],capture_output=True,text=True,timeout=60,check=True)
        require(len(result.stdout)<2_000_000);return json.loads(result.stdout)
    verify_evidence(api('runs/'+str(RUN)),api('runs/'+str(RUN)+'/jobs?per_page=100')['jobs'])
    subprocess.run(['git','cat-file','-e',REVISION+'^{commit}'],cwd=ROOT,capture_output=True,timeout=120,check=True)
    changed=subprocess.run(['git','diff','--name-only','-z',REVISION,'HEAD','--'],cwd=ROOT,capture_output=True,timeout=30,check=True).stdout
    verify_changed_paths([p.decode() for p in changed.split(b'\0') if p])
    print(json.dumps({'package_checks':'reused_for_identical_application_sources','prior_run':RUN,'verified_revision':REVISION,'operations_retested':True}))
if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('SUMMARY_PRIOR_PACKAGE_CHECKS_UNVERIFIED') from None
