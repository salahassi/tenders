import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('reference_runtime_tests', HERE/'proposal-reference-runtime.py')
m = importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name] = m;SPEC.loader.exec_module(m)


class ReferenceQualificationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        for name in m.BOUNDARY_HARNESSES:
            path = self.root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('synthetic harness')
        self.baseline = {'source': {'source_entries': {
            m.CHANGED_SOURCE: {'type':'file','git_mode':'100644','sha256':'1'*64,'size':10},
            'unchanged.ts': {'type':'file','git_mode':'100644','sha256':'2'*64,'size':20}},
            'supplementary_inputs': {'recipe': {'sha256':'3'*64}}}}
        source = copy.deepcopy(self.baseline['source'])
        source['source_entries'][m.CHANGED_SOURCE]['sha256'] = '4'*64
        self.receipt = {'image': {'Id':'sha256:'+'5'*64},'source':source}
        self.native = {'version':1,'kind':'proposal_reference_boundary_native','image_id':self.receipt['image']['Id'],
            'passed':True,'actual_image_entrypoint':True,'network':'none','external_calls':0,'provider_calls':0,
            'cleanup_verified':True,'source_sha256':m.source_hashes(source),'baseline_image_id':m.BASELINE_IMAGE,
            'baseline_source_sha256':m.source_hashes(self.baseline['source']),
            'baseline_qualification_sha256':m.previous.RECEIPT_SHA256,'checks':dict.fromkeys(m.BOUNDARY_CHECKS,True),
            'harness_sha256':{name:m.sha(self.root/name) for name in m.BOUNDARY_HARNESSES},
            'case_input_sha256':dict.fromkeys(m.BOUNDARY_CASES,'6'*64),
            'case_results':{name:self.expected(name,False) for name in m.BOUNDARY_CASES}}
        self.native['baseline'] = {'case_input_sha256':self.native['case_input_sha256'].copy(),
            'case_results':{name:self.expected(name,True) for name in m.BOUNDARY_CASES}}

    @staticmethod
    def expected(name, baseline):
        accepted = name in m.RETAINED_CASES or name in m.COLON_CASES and not baseline
        return {'accepted':accepted,'error_code':None if accepted else 'EVIDENCE_REFERENCE_INVALID',
            'diagnostic_reasons':[] if accepted else ['numeric_evidence_mismatch']}

    def validate(self, value=None):
        with patch.object(m,'historical',return_value=self.baseline):
            m.validate_boundary_native(self.native if value is None else value,self.receipt,self.root)

    def test_actual_image_baseline_sources_and_offline_cleanup_are_required(self):
        self.validate()
        for key,value in [('image_id',m.BASELINE_IMAGE),('baseline_image_id','sha256:'+'0'*64),
            ('source_sha256',{}),('baseline_source_sha256',{}),('passed',False),
            ('actual_image_entrypoint',False),('network','bridge'),('provider_calls',1),('external_calls',1),
            ('cleanup_verified',False),('baseline_qualification_sha256','0'*64)]:
            with self.subTest(key=key),self.assertRaises(m.QualificationError):self.validate(self.native|{key:value})

    def test_all_eight_boundary_checks_are_mandatory(self):
        for check in m.BOUNDARY_CHECKS:
            value=copy.deepcopy(self.native);value['checks'][check]=False
            with self.subTest(check=check),self.assertRaisesRegex(m.QualificationError,'CHECKS'):self.validate(value)

    def test_all_44_cases_and_exact_inputs_are_bound_on_both_images(self):
        self.assertEqual((len(m.BOUNDARY_CASES),len(m.COLON_CASES)),(44,24))
        for baseline in (False,True):
            for field in ('case_results','case_input_sha256'):
                value=copy.deepcopy(self.native);subject=value['baseline'] if baseline else value
                subject[field].pop(next(iter(m.BOUNDARY_CASES)))
                with self.subTest(baseline=baseline,field=field),self.assertRaisesRegex(m.QualificationError,'CASES'):self.validate(value)
        value=copy.deepcopy(self.native);value['baseline']['case_input_sha256'][next(iter(m.BOUNDARY_CASES))]='7'*64
        with self.assertRaisesRegex(m.QualificationError,'INPUT_CHANGED'):self.validate(value)

    def test_fixed_regression_and_retained_rejections_cannot_be_reversed(self):
        for baseline in (False,True):
            for name in m.BOUNDARY_CASES:
                value=copy.deepcopy(self.native);subject=value['baseline'] if baseline else value
                subject['case_results'][name]['accepted']=not subject['case_results'][name]['accepted']
                with self.subTest(name=name,baseline=baseline),self.assertRaisesRegex(m.QualificationError,'OUTCOME'):self.validate(value)
        value=copy.deepcopy(self.native);value['case_results'][next(iter(m.COLON_CASES))]['accepted']=1
        with self.assertRaisesRegex(m.QualificationError,'OUTCOME'):self.validate(value)

    def test_exact_harness_paths_and_bytes_are_required(self):
        value=copy.deepcopy(self.native);value['harness_sha256']['extra.ts']='8'*64
        with self.assertRaisesRegex(m.QualificationError,'HARNESS'):self.validate(value)
        (self.root/m.BOUNDARY_HARNESSES[0]).write_text('changed')
        with self.assertRaisesRegex(m.QualificationError,'HARNESS_CHANGED'):self.validate()

    def test_only_grounding_validator_source_may_change(self):
        m.validate_source_scope(self.receipt['source'],self.baseline['source'])
        for kind in ('unchanged','another_file','new_file','removed_file','mode','supplementary'):
            source=copy.deepcopy(self.receipt['source'])
            if kind=='unchanged':source=copy.deepcopy(self.baseline['source'])
            elif kind=='another_file':source['source_entries']['unchanged.ts']['sha256']='9'*64
            elif kind=='new_file':source['source_entries']['unreviewed.ts']={'type':'file','sha256':'9'*64}
            elif kind=='removed_file':source['source_entries'].pop('unchanged.ts')
            elif kind=='mode':source['source_entries'][m.CHANGED_SOURCE]['git_mode']='100755'
            else:source['supplementary_inputs']={}
            with self.subTest(kind=kind),self.assertRaises(m.QualificationError):m.validate_source_scope(source,self.baseline['source'])

    def test_actual_product_scope_and_historical_receipts_are_unchanged(self):
        baseline=m.historical(m.ROOT)
        m.validate_source_scope(m.snapshot(),baseline['source'])
        self.assertEqual(baseline['image']['Id'],m.BASELINE_IMAGE)
        self.assertEqual(m.previous.RECEIPT_SHA256,'1557117fc44b44ff3c5f9beb5244edf3bdb3a0fa67cbff83193a18790dd40c5f')
        self.assertNotIn(m.RECEIPT,(m.previous.RECEIPT,m.latency.RECEIPT,m.dispatch.RECEIPT))
        self.assertNotIn(m.PUBLICATION,(m.previous.PUBLICATION,m.latency.PUBLICATION,m.dispatch.PUBLICATION))
        self.assertEqual(m.policy_migrations(m.ROOT),{key:baseline[key] for key in ('poll_migration','pending_poll_migration')})

    def test_sql_changes_are_rejected_even_when_committed(self):
        policies={'poll_migration':{'path':'old.sql','sha256':'1'*64},'pending_poll_migration':{'path':'poll.sql','sha256':'2'*64}}
        with patch.object(m.previous,'policy_migrations',return_value=policies),patch.object(m,'historical',return_value=policies):
            self.assertEqual(m.policy_migrations(self.root),policies)
        changed=copy.deepcopy(policies);changed['pending_poll_migration']['sha256']='3'*64
        with patch.object(m.previous,'policy_migrations',return_value=changed),patch.object(m,'historical',return_value=policies):
            with self.assertRaisesRegex(m.QualificationError,'SQL_POLICY_CHANGED'):m.policy_migrations(self.root)

    def test_unfrozen_or_existing_publication_never_reaches_registry(self):
        with patch.object(m,'ROOT',self.root),patch.object(m,'RECEIPT_SHA256',None),patch.object(m,'docker') as docker:
            with self.assertRaisesRegex(m.QualificationError,'NOT_FROZEN'):m.publish()
            docker.assert_not_called()
        path=self.root/m.PUBLICATION;path.parent.mkdir(parents=True);path.write_text('{}')
        with patch.object(m,'ROOT',self.root),patch.object(m,'load') as load:
            with self.assertRaisesRegex(m.QualificationError,'PUBLICATION_EXISTS'):m.publish()
            load.assert_not_called()

    def test_broad_source_change_stops_build_before_image_access(self):
        source=copy.deepcopy(self.receipt['source']);source['source_entries']['unchanged.ts']['sha256']='9'*64
        with patch.object(m.subprocess,'check_output',return_value='a'*40),patch.object(m,'assert_source_revision'), \
            patch.object(m,'snapshot',return_value=source),patch.object(m,'historical',return_value=self.baseline), \
            patch.object(m,'image_metadata') as image:
            with self.assertRaisesRegex(m.QualificationError,'SOURCE_SCOPE_CHANGED'):m.build(SimpleNamespace(source_revision='a'*40))
            image.assert_not_called()

    def test_all_four_native_receipts_and_existing_sql_bindings_are_required(self):
        policies={'poll_migration':{'path':'old.sql','sha256':'1'*64},'pending_poll_migration':{'path':'poll.sql','sha256':'2'*64}}
        value=self.receipt|{'kind':'proposal_reference_runtime','native':{'path':'dispatch'},
            'prompt_native':{'path':'prompt'},'poll_native':{'path':'poll'},'boundary_native':{'path':'boundary'},
            'build':{'path':'build'},'poll_sql_qualified':False,**policies,
            'baseline':{'reference':m.BASELINE_REFERENCE,'image_id':m.BASELINE_IMAGE,'qualification_sha256':m.previous.RECEIPT_SHA256}}
        contents={'dispatch':{'checks':dict.fromkeys(m.latency.DISPATCH_CHECKS,True)},'prompt':{'kind':'prompt'},
            'poll':{'kind':'poll'},'boundary':self.native,'build':copy.deepcopy(policies)}
        with patch.object(m.dispatch,'validate_receipt'),patch.object(m.dispatch,'read_bound',side_effect=lambda root,item:contents[item['path']]), \
            patch.object(m,'historical',return_value=self.baseline),patch.object(m,'policy_migrations',return_value=policies), \
            patch.object(m.latency,'validate_prompt_native') as prompt,patch.object(m.previous,'validate_poll_native') as poll, \
            patch.object(m,'validate_boundary_native') as boundary:
            m.validate_receipt(self.root,value)
            prompt.assert_called_once_with(contents['prompt'],value,self.root)
            poll.assert_called_once_with(contents['poll'],value,self.root)
            boundary.assert_called_once_with(self.native,value,self.root)
            for key in policies:
                with self.assertRaisesRegex(m.QualificationError,'SQL_BINDING'):
                    m.validate_receipt(self.root,value|{key:{'path':'other.sql','sha256':'0'*64}})
            for check in m.latency.DISPATCH_CHECKS:
                contents['dispatch']['checks'][check]=False
                with self.assertRaisesRegex(m.QualificationError,'DISPATCH_NATIVE_CHECKS'):m.validate_receipt(self.root,value)
                contents['dispatch']['checks'][check]=True
            with self.assertRaisesRegex(m.QualificationError,'SQL_SCOPE'):m.validate_receipt(self.root,value|{'poll_sql_qualified':True})


if __name__=='__main__':unittest.main()
