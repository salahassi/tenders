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
    def test_partial_receipt_preserves_completed_results_after_timeout(self):
        progress={'progress':{'result':{'passed':False,'usage':None},'generations':1,'requests':1}}
        report=m.parse_execution_output(m.json.dumps(progress)+'\n{',2,False)
        self.assertFalse(report['complete']); self.assertFalse(report['passed'])
        self.assertEqual(len(report['results']),1)
        self.assertTrue(report['generation_count_is_lower_bound'])
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

if __name__=='__main__':unittest.main()
