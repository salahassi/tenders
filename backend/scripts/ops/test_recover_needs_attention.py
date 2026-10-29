import importlib.util,json,subprocess,sys,unittest
from pathlib import Path
SPEC=importlib.util.spec_from_file_location('tested_attention_recovery',Path(__file__).with_name('recover-needs-attention.py'))
m=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=m;SPEC.loader.exec_module(m)


class AttentionRecoveryTests(unittest.TestCase):
    def test_only_supported_actions_and_bounded_batch_identifier(self):
        for action,batch in [('retry','valid'),('recover',"bad';--"),('inspect','')]:
            with self.assertRaises(m.r.RecoveryError):m.attention_sql(action,batch)

    def test_postgres_sample_gate_canonical_retry_usage_and_dependency_guards(self):
        scripts={a:m.attention_sql(a,'fixture-attention') for a in ['inspect','recover']}
        process=subprocess.run(['node',str(Path(__file__).with_name('test_recover_needs_attention.mjs'))],
          input=json.dumps(scripts),text=True,capture_output=True,timeout=90)
        self.assertEqual(process.returncode,0,process.stdout+process.stderr)


if __name__=='__main__':unittest.main()
