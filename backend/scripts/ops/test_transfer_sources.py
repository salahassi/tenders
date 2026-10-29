"""Verify disabled-only validation and real PostgreSQL transfer transactions."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
import uuid

SPEC=importlib.util.spec_from_file_location('tested_source_transfer',Path(__file__).with_name('transfer-sources.py'))
t=importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name]=t
SPEC.loader.exec_module(t)


def fixture():
    rows=[]
    for i in range(36):
        rows.append(dict(id=str(uuid.UUID(int=100+i)),workspace_id=t.WORKSPACE,name='Fixture source '+str(i),
         kind='link_directory',url='https://official.example.test/tenders/'+str(i),approved_hosts=['official.example.test'],
         approval='rejected' if i==0 else 'approved',health='unknown',poll_interval_hours=6,next_due='2026-10-28T00:00:00Z',
         last_success_at=None,policy_note='Fixture only',adapter_config={'catalog':{'key':'fixture-'+str(i)},'automatic':True},
         created_by=str(uuid.UUID(int=2)),created_at='2026-10-20T00:00:00Z',updated_at='2026-10-20T00:00:00Z',
         revision=1,tags=[],etag=None,last_modified=None,policy_checked_at=None,adapter_required=False))
    return dict(source_project=t.PROJECT,workspace_id=t.WORKSPACE,captured_at='2026-10-28T00:00:00Z',sources=rows)


class SourceTransferTests(unittest.TestCase):
    def test_payload_excludes_memberships_and_refuses_wrong_workspace_and_duplicate_ids(self):
        p=fixture()
        self.assertIs(t.validate(p),p)
        for modify in [lambda p:p.update(memberships=[]),lambda p:p.update(workspace_id=str(uuid.UUID(int=9))),
                       lambda p:p['sources'][0].update(id=p['sources'][1]['id']),lambda p:p['sources'].pop(),
                       lambda p:p['sources'][0].update(unexpected='data')]:
            bad=copy.deepcopy(p);modify(bad)
            with self.assertRaises(t.TransferError): t.validate(bad)

    def test_real_postgres_disabled_insert_duplicate_preservation_replay_and_rollback(self):
        p=fixture()
        p['sources'][2]['name']="Quoted ' fixture $source_transfer$; __WORKSPACE__ \\ text"
        variants={}
        variants['apply']=t.migration_sql(p)
        variants['verify']=t.migration_sql(p,verify_only=True)
        bad=copy.deepcopy(p);bad['sources'][35]['url']=bad['sources'][34]['url']
        variants['bad']=t.migration_sql(bad)
        process=subprocess.run(['node',str(Path(__file__).with_name('test_transfer_sources.mjs'))],
          input=json.dumps({'scripts':variants,'fixture':p}),capture_output=True,text=True,timeout=90)
        self.assertEqual(process.returncode,0,process.stdout+process.stderr)


if __name__=='__main__': unittest.main()
