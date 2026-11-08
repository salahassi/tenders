import copy
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('model_settings_release_test',Path(__file__).with_name('model-settings-release.py'))
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)

class AcceptanceTests(unittest.TestCase):
    def test_readiness_cannot_replace_complete_history_and_settled_requests(self):
        report={key:True for key in ('settings_ready','models_visible','network_settled','auth_session_logged_out','owned_client_removed')}
        report.update({key:0 for key in ('alert_count','browser_errors','blocked_requests','business_mutations','model_requests')})
        report.update(skeleton_visible=False,api_requests=28,table_counts={'jobs':1795,'source_runs':32,'opportunities':119,'knowledge_items':0},resources={'job-summaries':{'records':1795},'source-runs':{'records':32},'opportunities':{'records':119},'knowledge':{'records':0}},index_sha256='aaa576da3f4ebde3e1c8289ad6d0dfd93d486b1d5b8b53bf63a33c594e840616')
        report.update(version=1,kind='actual_workspace_startup')
        for table in m.diagnostic.TABLES:
            report['table_counts'].setdefault(table,0)
            resource={'jobs':'job-summaries','knowledge_items':'knowledge'}.get(table,table.replace('_','-'))
            report['resources'].setdefault(resource,{'records':report['table_counts'][table]})
        report['model_poll_checks']=[{'settled':True,'status_reads':1,'business_reads':0,'catalog_reads':0,'api_requests':1},{'settled':True,'status_reads':1,'business_reads':0,'catalog_reads':5,'api_requests':6}]
        m.validate_acceptance(report,report['index_sha256'])
        for key,value in [('network_settled',False),('settings_ready',False),('blocked_requests',1),('model_requests',1),('api_requests',100),('index_sha256','0'*64)]:
            with self.assertRaises(m.m.ReleaseError):m.validate_acceptance({**report,key:value},report['index_sha256'])
        missing=copy.deepcopy(report);missing['table_counts'].pop('fit_assessments')
        with self.assertRaises(m.m.ReleaseError):m.validate_acceptance(missing,report['index_sha256'])
        bad_poll=copy.deepcopy(report);bad_poll['model_poll_checks'][0]['business_reads']=1
        with self.assertRaises(m.m.ReleaseError):m.validate_acceptance(bad_poll,report['index_sha256'])
        changed=copy.deepcopy(report);changed['resources']['opportunities']['records']=118
        with self.assertRaises(m.m.ReleaseError):m.validate_acceptance(changed,report['index_sha256'])

    def test_only_frontend_image_can_differ_from_snapshot(self):
        before={name:{'spec':{'template':{'spec':{'containers':[{'image':'old-'+name}]}}}} for name in ('api','worker','frontend')}
        current=copy.deepcopy(before);current['frontend']['spec']['template']['spec']['containers'][0]['image']='new'
        with patch.object(m.runtime,'workload_snapshot',side_effect=lambda:copy.deepcopy(current)),patch.object(m.runtime,'retained_configuration',return_value={'fixed':True}):
            m.verify_unchanged(before,{'fixed':True},'new')
            current['worker']['spec']['template']['spec']['containers'][0]['image']='new'
            with self.assertRaises(m.m.ReleaseError):m.verify_unchanged(before,{'fixed':True},'new')

    def test_rollback_checks_current_image_and_never_overwrites_an_operator_change(self):
        original={'frontend':{'original':True}}
        for image in (m.m.COMPLETION_FRONTEND,'candidate','operator-image'):
            with patch.object(m.m.u,'deployment',return_value={'spec':{'template':{'spec':{'containers':[{'image':image}]}}}}),patch.object(m.runtime,'patch_runtime') as patch_image,patch.object(m.d,'wait_deployments'),patch.object(m.base,'wait_drain'),patch.object(m,'verify_unchanged'):
                if image=='operator-image':
                    with self.assertRaises(m.m.ReleaseError):m.rollback(original,'candidate',{}, {})
                    patch_image.assert_not_called()
                else:
                    m.rollback(original,'candidate',{}, {})
                    if image=='candidate':patch_image.assert_called_once_with('frontend',m.m.COMPLETION_FRONTEND,original['frontend'],'candidate')
                    else:patch_image.assert_not_called()

if __name__=='__main__':unittest.main()
