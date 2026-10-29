import importlib.util,json,subprocess,sys,unittest
from pathlib import Path
SPEC=importlib.util.spec_from_file_location('tested_assessment_recovery',Path(__file__).with_name('recover-model-assessments.py'))
r=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=r;SPEC.loader.exec_module(r)


class AssessmentRecoveryTests(unittest.TestCase):
    def test_invalid_flags_aliases_and_batch_are_rejected(self):
        for args in [('bad','batch',[],False),('remaining','batch',[],True),('sample',"batch';bad",[],True),('sample','batch',['BAD_KEY'],True)]:
            with self.assertRaises(r.RecoveryError):r.recovery_sql(*args)

    def test_postgres_canonical_recovery_preserves_history_and_gates_remaining(self):
        data={a:r.recovery_sql(a,'fixture-recovery',['APP_MODEL_OPENAI_KEY'],a=='sample') for a in ['sample','remaining','status','retry-sample']}
        result=subprocess.run(['node',str(Path(__file__).with_name('test_recover_model_assessments.mjs'))],input=json.dumps(data),capture_output=True,text=True,timeout=90)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)


if __name__=='__main__':unittest.main()
