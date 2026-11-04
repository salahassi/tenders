import importlib.util
import os
from pathlib import Path
import unittest
import tempfile
import io
from contextlib import redirect_stdout
from unittest.mock import patch
import sys
spec=importlib.util.spec_from_file_location('live_evaluation',Path(__file__).with_name('live-model-evaluation.py'))
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)

class EvaluationGuards(unittest.TestCase):
    def rows(self):
        return [{'provider':p,'credential_alias':'APP_MODEL_'+p.upper()+'_KEY','project_ref':'fixture','model':'fixture','capabilities':{}} for p in ['openai','qwencloud']]
    def test_no_activation_means_zero_cluster_access(self):
        with patch.dict(os.environ,{'RUN_LIVE_AI_EVALUATION':'false'}), patch.object(m.access,'prepare_cluster') as cluster:
            self.assertEqual(m.main(),0);cluster.assert_not_called()
    def test_exact_configured_alias_and_both_providers_required(self):
        rows=self.rows(); bindings={r['credential_alias']:'private-test-value' for r in rows}
        self.assertEqual(len(m.targets(rows,bindings)),2)
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_CONFIGURED_KEY_MISSING'):m.targets(rows,{})
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_BOTH_PROVIDERS_REQUIRED'):m.targets(rows[:1],bindings)
        rows[0]['credential_alias']='DIGITALOCEAN_ACCESS_TOKEN'
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_CREDENTIAL_ALIAS_INVALID'):m.targets(rows,bindings)
    def test_never_truncates_extra_models_silently(self):
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_CATALOG_LIMIT'):m.targets(self.rows()*3,{})
    def test_extended_targets_only_qwen_and_at_most_two_models(self):
        rows=self.rows(); bindings={r['credential_alias']:'private-test-value' for r in rows}
        self.assertEqual(m.targets(rows[1:],bindings,'extended')[0]['provider'],'qwencloud')
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_CREDENTIAL_ALIAS_INVALID'):m.targets(rows,bindings,'extended')
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_CATALOG_LIMIT'):m.targets(rows[1:]*3,bindings,'extended')
        self.assertEqual(m.catalog_sql('extended'),m.CATALOG_SQL.replace("c.provider IN ('openai','qwencloud')","c.provider='qwencloud'").replace('LIMIT 5','LIMIT 3'))
        self.assertIn('BEGIN READ ONLY',m.catalog_sql('extended'))
    def test_invalid_suite_stops_before_cluster_access(self):
        with patch.dict(os.environ,{'RUN_LIVE_AI_EVALUATION':'true','AI_EVALUATION_SUITE':'unknown'}), patch.object(m.access,'prepare_cluster') as cluster, redirect_stdout(io.StringIO()) as output:
            self.assertEqual(m.main(),1);cluster.assert_not_called()
        self.assertEqual(m.json.loads(output.getvalue())['code'],'EVAL_SUITE_INVALID')
    def test_extended_reports_enforce_sixteen_calls_and_provider_selection(self):
        report=m.parse_execution_output('',2,False,'extended')
        self.assertEqual(report['suite'],'extended')
        report['generations']=17
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_REPORT_INVALID'):m.validate_report(report,2,'extended')
        report['generations']=1;report['results']=[{'passed':False,'provider':'openai'}]
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_REPORT_INVALID'):m.validate_report(report,2,'extended')
    def test_recheck_requires_exact_two_models_and_four_failed_pairs(self):
        row=self.rows()[1]
        rows=[dict(row,model=model) for model in ['deepseek-v4-pro','qwen3.8-max']]
        bindings={row['credential_alias']:'private-test-value'}
        self.assertEqual(len(m.targets(rows,bindings,'extended_recheck')),2)
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_RECHECK_TARGETS_INVALID'):m.targets(rows[:1],bindings,'extended_recheck')
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_RECHECK_TARGETS_INVALID'):m.targets([dict(row,model='other-qwen'),rows[1]],bindings,'extended_recheck')
        self.assertIn("m.model IN ('deepseek-v4-pro','qwen3.8-max')",m.catalog_sql('extended_recheck'))
        report=m.parse_execution_output('',2,False,'extended_recheck')
        report.update(complete=True,generations=4,results=[{'provider':'qwencloud','model':model,'case':case,'passed':False} for model,case in m.RECHECK_PAIRS])
        self.assertEqual(m.validate_report(report,2,'extended_recheck'),report)
        report['generations']=5
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_REPORT_INVALID'):m.validate_report(report,2,'extended_recheck')
        report['generations']=4;report['results'][0]['case']='proposal_plan_coverage'
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_REPORT_INVALID'):m.validate_report(report,2,'extended_recheck')
    def test_partial_receipt_preserves_completed_results_after_timeout(self):
        progress={'progress':{'result':{'passed':False,'usage':None},'generations':1,'requests':1}}
        report=m.parse_execution_output(m.json.dumps(progress)+'\n{',2,False)
        self.assertFalse(report['complete']); self.assertFalse(report['passed'])
        self.assertEqual(len(report['results']),1)
        self.assertTrue(report['generation_count_is_lower_bound'])
    def test_planning_repair_requires_qwen_max_and_two_exact_cases(self):
        row=dict(self.rows()[1],model='qwen3.8-max')
        bindings={row['credential_alias']:'private-test-value'}
        self.assertEqual(len(m.targets([row],bindings,'planning_repair')),1)
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_PLANNING_TARGET_INVALID'):m.targets([dict(row,model='deepseek-v4-pro')],bindings,'planning_repair')
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_CATALOG_LIMIT'):m.targets([row,row],bindings,'planning_repair')
        self.assertIn("m.model='qwen3.8-max'",m.catalog_sql('planning_repair'))
        self.assertIn('LIMIT 2',m.catalog_sql('planning_repair'))
        report=m.parse_execution_output('',1,False,'planning_repair')
        report.update(complete=True,generations=2,results=[{'provider':'qwencloud','model':model,'case':case,'passed':False} for model,case in m.PLANNING_PAIRS])
        self.assertEqual(m.validate_report(report,1,'planning_repair'),report)
        report['generations']=3
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_REPORT_INVALID'):m.validate_report(report,1,'planning_repair')
        report['generations']=2;report['results'][0]['case']='source_listing_exact_notice'
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_REPORT_INVALID'):m.validate_report(report,1,'planning_repair')
    def test_analysis_verification_requires_exact_qwen_models_and_catalog_scope(self):
        row=self.rows()[1]
        rows=[dict(row,model=model) for model in ('deepseek-v4-pro','qwen3.8-max')]
        bindings={row['credential_alias']:'private-test-value'}
        self.assertEqual(m.suite_limits('analysis_verification'),(2,4))
        self.assertEqual(len(m.targets(rows,bindings,'analysis_verification')),2)
        for invalid in (rows[:1],[rows[0],rows[0]],[rows[0],dict(row,model='other-qwen')]):
            with self.subTest(models=[r['model'] for r in invalid]):
                with self.assertRaisesRegex(m.EvaluationError,'EVAL_ANALYSIS_VERIFICATION_TARGETS_INVALID'):
                    m.targets(invalid,bindings,'analysis_verification')
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_CATALOG_LIMIT'):m.targets(rows+[row],bindings,'analysis_verification')
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_CREDENTIAL_ALIAS_INVALID'):
            m.targets([dict(rows[0],provider='openai'),rows[1]],bindings,'analysis_verification')
        expected=m.CATALOG_SQL.replace("c.provider IN ('openai','qwencloud')","c.provider='qwencloud' AND m.model IN ('deepseek-v4-pro','qwen3.8-max')").replace('LIMIT 5','LIMIT 3')
        self.assertEqual(m.catalog_sql('analysis_verification'),expected)
        self.assertIn('BEGIN READ ONLY',expected)
    def test_analysis_verification_report_accepts_only_four_unique_expected_pairs(self):
        expected={(model,case) for model in ('deepseek-v4-pro','qwen3.8-max')
                  for case in ('analysis_reference_empty_v4','analysis_obligation_omission_v4')}
        self.assertEqual(m.ANALYSIS_VERIFICATION_PAIRS,expected)
        base=m.parse_execution_output('',2,False,'analysis_verification')
        base.update(complete=True,generations=4,results=[{'provider':'qwencloud','model':model,'case':case,'passed':False}
                                                      for model,case in sorted(expected)])
        self.assertEqual(m.validate_report(base,2,'analysis_verification'),base)
        def invalid(change):
            report=m.json.loads(m.json.dumps(base));change(report)
            with self.assertRaisesRegex(m.EvaluationError,'EVAL_REPORT_INVALID'):
                m.validate_report(report,2,'analysis_verification')
        invalid(lambda r:r.update(generations=5))
        invalid(lambda r:r['results'].pop())
        invalid(lambda r:r['results'].__setitem__(1,dict(r['results'][0])))
        invalid(lambda r:r['results'][0].update(case='proposal_plan_coverage'))
        invalid(lambda r:r['results'][0].update(model='other-qwen'))
        invalid(lambda r:r['results'][0].update(provider='openai'))
        invalid(lambda r:r.update(model_count=1))
        progress={'progress':{'result':base['results'][0],'generations':1,'requests':1}}
        partial=m.parse_execution_output(m.json.dumps(progress)+'\n{',2,False,'analysis_verification')
        self.assertFalse(partial['complete']);self.assertEqual(len(partial['results']),1)
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_REPORT_INVALID'):
            m.parse_execution_output(m.json.dumps(progress)+'\n'+m.json.dumps(progress),2,False,'analysis_verification')
    def test_analysis_verification_selection_does_not_activate_live_calls(self):
        with patch.dict(os.environ,{'RUN_LIVE_AI_EVALUATION':'false','AI_EVALUATION_SUITE':'analysis_verification'}), patch.object(m.access,'prepare_cluster') as cluster, patch.object(m.subprocess,'run') as child, redirect_stdout(io.StringIO()) as output:
            self.assertEqual(m.main(),0)
        cluster.assert_not_called();child.assert_not_called()
        self.assertEqual(m.json.loads(output.getvalue()),{'live_ai_evaluation':'not_activated'})
    def test_analysis_authority_requires_exact_two_qwen_models_and_read_only_catalog(self):
        row=self.rows()[1]
        rows=[dict(row,model=model) for model in ('deepseek-v4-pro','qwen3.8-max')]
        bindings={row['credential_alias']:'private-test-value'}
        self.assertEqual(m.suite_limits('analysis_authority'),(2,4))
        self.assertEqual(m.expected_case_count(2,'analysis_authority'),4)
        self.assertEqual(len(m.targets(rows,bindings,'analysis_authority')),2)
        for invalid in (rows[:1],[rows[0],rows[0]],[rows[0],dict(row,model='other-qwen')]):
            with self.subTest(models=[r['model'] for r in invalid]):
                with self.assertRaisesRegex(m.EvaluationError,'EVAL_ANALYSIS_AUTHORITY_TARGETS_INVALID'):
                    m.targets(invalid,bindings,'analysis_authority')
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_CATALOG_LIMIT'):
            m.targets(rows+[row],bindings,'analysis_authority')
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_CREDENTIAL_ALIAS_INVALID'):
            m.targets([dict(rows[0],provider='openai'),rows[1]],bindings,'analysis_authority')
        expected=m.CATALOG_SQL.replace("c.provider IN ('openai','qwencloud')","c.provider='qwencloud' AND m.model IN ('deepseek-v4-pro','qwen3.8-max')").replace('LIMIT 5','LIMIT 3')
        self.assertEqual(m.catalog_sql('analysis_authority'),expected)
        self.assertIn('BEGIN READ ONLY',expected)
    def test_analysis_authority_report_enforces_four_unique_pairs_and_partial_bounds(self):
        expected={(model,case) for model in ('deepseek-v4-pro','qwen3.8-max')
                  for case in ('analysis_optional_authority_supported_v3','analysis_optional_authority_strengthened_v3')}
        self.assertEqual(m.ANALYSIS_AUTHORITY_PAIRS,expected)
        base=m.parse_execution_output('',2,False,'analysis_authority')
        base.update(complete=True,generations=4,results=[{'provider':'qwencloud','model':model,'case':case,'passed':False}
                                                      for model,case in sorted(expected)])
        self.assertEqual(m.validate_report(base,2,'analysis_authority'),base)
        def invalid(change):
            report=m.json.loads(m.json.dumps(base));change(report)
            with self.assertRaisesRegex(m.EvaluationError,'EVAL_REPORT_INVALID'):
                m.validate_report(report,2,'analysis_authority')
        invalid(lambda r:r.update(generations=5))
        invalid(lambda r:r['results'].pop())
        invalid(lambda r:r['results'].__setitem__(1,dict(r['results'][0])))
        invalid(lambda r:r['results'][0].update(case='analysis_reference_empty_v4'))
        invalid(lambda r:r['results'][0].update(model='other-qwen'))
        invalid(lambda r:r['results'][0].update(provider='openai'))
        invalid(lambda r:r.update(model_count=1))
        invalid(lambda r:r.update(suite='analysis_verification'))
        progress={'progress':{'result':base['results'][0],'generations':1,'requests':1}}
        partial=m.parse_execution_output(m.json.dumps(progress)+'\n{',2,False,'analysis_authority')
        self.assertFalse(partial['complete']);self.assertEqual(len(partial['results']),1)
        with self.assertRaisesRegex(m.EvaluationError,'EVAL_REPORT_INVALID'):
            m.parse_execution_output(m.json.dumps(progress)+'\n'+m.json.dumps(progress),2,False,'analysis_authority')
    def test_analysis_authority_selection_never_activates_live_calls_by_itself(self):
        with patch.dict(os.environ,{'RUN_LIVE_AI_EVALUATION':'false','AI_EVALUATION_SUITE':'analysis_authority'}), patch.object(m.access,'prepare_cluster') as cluster, patch.object(m.subprocess,'run') as child, redirect_stdout(io.StringIO()) as output:
            self.assertEqual(m.main(),0)
        cluster.assert_not_called();child.assert_not_called()
        self.assertEqual(m.json.loads(output.getvalue()),{'live_ai_evaluation':'not_activated'})
    def test_sql_failure_reports_fixed_stage_and_sqlstate_without_subprocess_or_private_error(self):
        with tempfile.TemporaryDirectory() as parent:
            directory=Path(parent)/'private';directory.mkdir()
            def failure(*args):
                print(m.json.dumps({'deployment':'tenderdesk-dev','status':'sql_failed','sqlstate':'42601','line':41}))
                raise m.access.d.DeployError('MIGRATION_SQL_FAILED')
            output=io.StringIO()
            with patch.dict(os.environ,{'RUN_LIVE_AI_EVALUATION':'true'}), patch.object(m.access,'prepare_cluster',return_value=directory), patch.object(m.observer,'Client'), patch.object(m.access.d,'sql',side_effect=failure), patch.object(m.subprocess,'run') as run, redirect_stdout(output):
                self.assertEqual(m.main(),1)
            run.assert_not_called()
            self.assertEqual(m.json.loads(output.getvalue()),{'live_ai_evaluation':'failed','code':'MIGRATION_SQL_FAILED','stage':'catalog_read','sqlstate':'42601','line':41})
    def test_sql_reads_only_and_excludes_prompt_projection(self):
        self.assertIn('BEGIN READ ONLY',m.CATALOG_SQL)
        sql=(m.HERE/'ai-routing-diagnostic.sql').read_text()
        self.assertIn('REPEATABLE READ READ ONLY',sql)
        self.assertNotIn('"prompt"',sql)
    def test_workflow_push_cannot_activate_live_requests(self):
        workflow=(m.HERE.parents[2]/'.github/workflows/evaluate-ai-models.yml').read_text()
        self.assertIn("github.event_name == 'workflow_dispatch' && inputs.run_live",workflow)
        self.assertIn('default: false',workflow)
        self.assertIn('default: core',workflow)
        self.assertIn('options: [core, extended, extended_recheck, planning_repair, analysis_verification, analysis_authority, semantic_en, semantic_ar, semantic_v2_en, semantic_v2_ar]',workflow)
        self.assertIn('liveModelEvaluationExtended.test.ts',workflow)
        self.assertIn('liveModelEvaluationVerification.test.ts',workflow)
        self.assertIn('liveModelEvaluationAuthority.test.ts',workflow)
        self.assertIn('codex/ai-reliability-resume',workflow)

    def test_frozen_semantic_suites_select_actual_catalog_and_both_providers_without_activation(self):
        rows=self.rows(); bindings={r['credential_alias']:'private-test-value' for r in rows}
        for suite in ('semantic_en','semantic_ar','semantic_v2_en','semantic_v2_ar'):
            self.assertEqual(m.suite_limits(suite),(4,64))
            self.assertEqual(m.expected_case_count(2,suite),32)
            self.assertEqual(m.catalog_sql(suite),m.CATALOG_SQL)
            self.assertEqual(len(m.targets(rows,bindings,suite)),2)
            with self.assertRaisesRegex(m.EvaluationError,'EVAL_BOTH_PROVIDERS_REQUIRED'):
                m.targets(rows[:1],bindings,suite)
            with patch.dict(os.environ,{'RUN_LIVE_AI_EVALUATION':'false','AI_EVALUATION_SUITE':suite}), patch.object(m.access,'prepare_cluster') as cluster, redirect_stdout(io.StringIO()):
                self.assertEqual(m.main(),0);cluster.assert_not_called()

    def test_semantic_receipts_reject_duplicate_missing_foreign_case_or_corpus_and_false_success(self):
        for suite in ('semantic_en','semantic_ar','semantic_v2_en','semantic_v2_ar'):
            cases=m.semantic_cases(suite)
            base=m.parse_execution_output('',2,False,suite)
            base.update(complete=True,generations=32,results=[{'provider':p,'model':'fixture','case':c,'passed':False,
              'qualification':{'corpus_sha256':m.SEMANTIC_V2_CORPUS_SHA256 if suite.startswith('semantic_v2_') else m.SEMANTIC_CORPUS_SHA256,'split':'development',**({'oracle_version':2} if suite.startswith('semantic_v2_') else {})}}
              for p in ('openai','qwencloud') for c in sorted(cases)])
            self.assertEqual(m.validate_report(base,2,suite),base)
            def invalid(change):
                r=m.json.loads(m.json.dumps(base));change(r)
                with self.assertRaisesRegex(m.EvaluationError,'EVAL_REPORT_INVALID'):m.validate_report(r,2,suite)
            invalid(lambda r:r['results'].pop())
            invalid(lambda r:r['results'].__setitem__(1,dict(r['results'][0])))
            invalid(lambda r:r['results'][0].update(case='unknown'))
            invalid(lambda r:r['results'][0]['qualification'].update(corpus_sha256='0'*64))
            invalid(lambda r:r.update(passed=True))
            invalid(lambda r:r.update(generations=65))
            if suite.startswith('semantic_v2_'):
                invalid(lambda r:r['results'][0]['qualification'].update(oracle_version=1))
                invalid(lambda r:r['results'][0].update(case=next(iter(m.semantic_cases('semantic_'+suite[-2:])))))

    def test_changed_semantic_corpus_stops_before_cluster_or_model_access(self):
        for suite in ('semantic_en','semantic_ar','semantic_v2_en','semantic_v2_ar'):
            with patch.dict(os.environ,{'RUN_LIVE_AI_EVALUATION':'true','AI_EVALUATION_SUITE':suite}), patch.object(Path,'read_bytes',return_value=b'{}'), patch.object(m.access,'prepare_cluster') as cluster, redirect_stdout(io.StringIO()) as output:
                self.assertEqual(m.main(),1);cluster.assert_not_called()
            self.assertEqual(m.json.loads(output.getvalue())['code'],'EVAL_CORPUS_CHANGED')

if __name__=='__main__':unittest.main()
