import copy,importlib.util,json,sys,unittest
from pathlib import Path
from unittest.mock import Mock,patch
spec=importlib.util.spec_from_file_location('summary_release_test',Path(__file__).with_name('job-summary-release.py'));m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
def identifier(n):return '00000000-0000-4000-8000-'+str(n).zfill(12)
def response(rows,cursor):return m.auth.smoke.Response(200,json.dumps({'data':{'records':rows,'next_cursor':cursor}}).encode())
class SummaryReleaseTests(unittest.TestCase):
    def test_completion_keeps_runtime_and_uses_exact_already_published_frontend(self):
        selected,sources,targets=m.selection('new-helper-source',True)
        self.assertEqual(targets,('frontend',));self.assertEqual(selected['runtime'],m.PREVIOUS_RUNTIME)
        self.assertEqual(selected['frontend'],m.COMPLETION_FRONTEND)
        self.assertEqual(sources,{'runtime':m.RETAINED_RUNTIME_SOURCE,'frontend':m.proof.OPS_REVISION})
    def test_authenticated_complete_history_is_three_requests_and_only_gets(self):
        rows=[{'id':identifier(n)} for n in range(1,1202)]
        client=Mock();client.request.side_effect=[response(rows[:500],identifier(500)),response(rows[500:1000],identifier(1000)),response(rows[1000:],None)]
        result=m.check_summaries(client,None,{'access_token':'synthetic'})
        self.assertEqual((result['job_records'],result['page_requests']),(1201,3))
        for call in client.request.call_args_list:
            self.assertTrue(call.args[0].startswith('/functions/v1/api/v1/job-summaries?limit=500'))
            self.assertEqual(call.kwargs,{'token':'synthetic'})
    def test_amplified_or_duplicate_pages_and_full_checkpoints_fail(self):
        for rows,cursor in [([{'id':identifier(1)}],identifier(1)),([{'id':identifier(1)}]*2,None),([{'id':identifier(1),'checkpoint':{}}],None),([],identifier(2))]:
            client=Mock();client.request.return_value=response(rows,cursor)
            with self.assertRaises(m.ReleaseError):m.check_summaries(client,None,{'access_token':'synthetic'})
            self.assertEqual(client.request.call_count,1)
    def test_schema_receipt_requires_exact_deployed_catalog_and_ledger(self):
        valid={'routine_catalog_sha256':m.SCHEMA_CATALOG,'release_history':[{'release':m.base.release.RELEASE,'migration_sha256':m.SCHEMA_MANIFEST}]}
        for value,ok in [(valid,True),({**valid,'routine_catalog_sha256':'0'*64},False),({**valid,'release_history':[]},False)]:
            with patch.object(m.d,'sql',return_value='{}'),patch.object(m.base.inventory,'public_schema',return_value=value):
                if ok:self.assertEqual(m.verify_schema(Mock())['schema_mutations'],0)
                else:
                    with self.assertRaises(m.ReleaseError):m.verify_schema(Mock())
    def test_workload_drift_is_not_overwritten(self):
        old={n:{'uid':n,'spec':{'template':{'spec':{'containers':[{'image':'old','name':n,'resources':{'memory':'384Mi'}}]}}}} for n in ['api','frontend','rest']}
        selected={'runtime':'new-runtime','frontend':'new-frontend'};current=copy.deepcopy(old);current['api']['spec']['template']['spec']['containers'][0]['image']='new-runtime'
        with patch.object(m.runtime,'workload_snapshot',return_value=current),patch.object(m.runtime,'retained_configuration',return_value={'unchanged':True}):
            m.verify_unchanged(old,{'unchanged':True},selected)
            for name,key,value in [('api','image','operator-image'),('api','resources',{}),('rest','image','new-rest')]:
                changed=copy.deepcopy(current);changed[name]['spec']['template']['spec']['containers'][0][key]=value
                with patch.object(m.runtime,'workload_snapshot',return_value=changed),self.assertRaises(m.ReleaseError):m.verify_unchanged(old,{'unchanged':True},selected)
    def test_rollback_attempts_all_owned_targets_even_when_one_drain_fails(self):
        original={n:{'spec':{'template':{'spec':{'containers':[{'image':'old-'+n}]}}}} for n in ('api','worker','frontend')}
        m.STATE.update(rolled_back=[],rollback_failed=[])
        def drain(name,image,**kwargs):
            if name=='frontend':raise RuntimeError('synthetic failure')
        with patch.object(m.runtime,'patch_runtime') as patch_image,patch.object(m.d,'wait_deployments'),patch.object(m.base,'wait_drain',side_effect=drain):
            with self.assertRaisesRegex(m.ReleaseError,'ROLLBACK_NOT_CONFIRMED'):
                m.rollback(['api','worker','frontend'],{'runtime':'new-runtime','frontend':'new-frontend'},original)
        self.assertEqual([c.args[0] for c in patch_image.call_args_list],['frontend','worker','api'])
        self.assertEqual(m.STATE['rolled_back'],['worker','api']);self.assertEqual(m.STATE['rollback_failed'],['frontend'])
    def test_release_source_has_no_migration_or_processing_operation(self):
        source=Path(m.__file__).read_text()
        for forbidden in ['migration_script(', 'app_command(', 'retry_processing(', 'INSERT INTO ', 'UPDATE public.', 'DELETE FROM ']:self.assertNotIn(forbidden,source)
        self.assertIn('READ ONLY',source)
        self.assertIn('base.cleanup_saved_client()',source)
        self.assertIn("/auth/v1/logout?scope=local",source)
if __name__=='__main__':unittest.main()
