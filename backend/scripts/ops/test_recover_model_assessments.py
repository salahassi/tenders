import importlib.util,json,subprocess,sys,unittest
from pathlib import Path
from unittest.mock import patch
SPEC=importlib.util.spec_from_file_location('tested_assessment_recovery',Path(__file__).with_name('recover-model-assessments.py'))
r=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=r;SPEC.loader.exec_module(r)


class AssessmentRecoveryTests(unittest.TestCase):
    def test_invalid_flags_aliases_and_batch_are_rejected(self):
        for args in [('bad','batch',[],False),('remaining','batch',[],True),('sample',"batch';bad",[],True),('sample','batch',['BAD_KEY'],True)]:
            with self.assertRaises(r.RecoveryError):r.recovery_sql(*args)
        for args in [('revalidate-sample','batch',[],False,None),('revalidate-sample','batch',[],False,'unreviewed-guard'),('status','batch',[],False,r.SCOPE_GUARD_FIX)]:
            with self.assertRaises(r.RecoveryError):r.recovery_sql(*args)

    def test_revalidation_requires_exact_owned_ready_runtime_image(self):
        image='registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:'+'a'*64
        def deployment(kind,name):
            return {'metadata':{'name':name,'namespace':r.t.d.NAMESPACE,'generation':3,
                      'labels':{'app.kubernetes.io/managed-by':'tenderdesk-deployment'}},
                    'spec':{'replicas':1,'template':{'spec':{'containers':[{'name':name,'image':image}]}}},
                    'status':{'observedGeneration':3,'readyReplicas':1,'updatedReplicas':1}}
        with patch.object(r.t.d,'get',side_effect=deployment):r.verify_guard_runtime(image)
        with self.assertRaises(r.RecoveryError):r.verify_guard_runtime('runtime:latest')
        wrong=deployment('deployment','worker');wrong['spec']['template']['spec']['containers'][0]['image']=image[:-1]+'b'
        with patch.object(r.t.d,'get',side_effect=lambda kind,name:wrong if name=='worker' else deployment(kind,name)):
            with self.assertRaisesRegex(r.RecoveryError,'RUNTIME_NOT_VERIFIED'):r.verify_guard_runtime(image)

    def test_revalidation_preserves_paid_latest_candidate_and_rejects_other_defects(self):
        data={'sql':r.recovery_sql('revalidate-sample','fixture-recovery',['APP_MODEL_OPENAI_KEY'],guard_fix=r.SCOPE_GUARD_FIX),
              'status':r.recovery_sql('status','fixture-recovery')}
        result=subprocess.run(['node',str(Path(__file__).with_name('test_revalidate_assessment_sample.mjs'))],
          input=json.dumps(data),capture_output=True,text=True,timeout=90)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)

    def test_postgres_canonical_recovery_preserves_history_and_gates_remaining(self):
        data={a:r.recovery_sql(a,'fixture-recovery',['APP_MODEL_OPENAI_KEY'],a=='sample') for a in ['sample','remaining','status','retry-sample']}
        result=subprocess.run(['node',str(Path(__file__).with_name('test_recover_model_assessments.mjs'))],input=json.dumps(data),capture_output=True,text=True,timeout=90)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)


if __name__=='__main__':unittest.main()
