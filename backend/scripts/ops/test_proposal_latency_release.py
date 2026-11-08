from contextlib import ExitStack
import copy
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('tested_latency_release', HERE/'proposal-latency-release.py')
m = importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)


class LatencyReleaseTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {'GITHUB_RUN_ATTEMPT':'1'}))
        self.alarm=self.stack.enter_context(patch.object(m.signal,'alarm'))
        self.remaining=self.stack.enter_context(patch.object(m.dispatch,'remaining_run_seconds',return_value=150))
        self.stack.enter_context(patch.object(m.dispatch,'verify_checkout',return_value='a'*40))
        self.candidate='registry.invalid/runtime@sha256:'+'b'*64
        self.receipt={'source_revision':'c'*40,'image':{'Id':'sha256:'+'d'*64},'poll_migration':{
            'path':str(m.schema.SOURCE.relative_to(m.schema.ROOT)),'sha256':m.schema.source_sha256()},
            'source':{'source_entries':{'backend/scripts/runtime/dispatcher.sql':{'sha256':m.schema.parent.PARENT_SQL}}}}
        self.stack.enter_context(patch.object(m.qualification,'publication',return_value=(self.receipt,self.candidate)))
        self.registry=self.stack.enter_context(patch.object(m.qualification,'registry_identity',return_value={'verified':True}))
        self.stack.enter_context(patch.object(m.dispatch.d.probe,'validate_cluster'))
        self.work={name:{'metadata':{'uid':name},'spec':{'replicas':1,'template':{'spec':{'containers':[{'name':name,'image':image}]}}}} for name,image in m.BASELINES.items()}
        self.initial=copy.deepcopy(self.work)
        self.stack.enter_context(patch.object(m.dispatch.u,'deployment',side_effect=lambda name,**_:copy.deepcopy(self.work[name])))
        self.stack.enter_context(patch.object(m.dispatch.u,'owned',side_effect=lambda kind,name:copy.deepcopy(self.work[name])))
        self.stack.enter_context(patch.object(m.dispatch,'verify_runtime_contract'))
        self.resources=self.stack.enter_context(patch.object(m.dispatch.base,'worker_resource_envelope',return_value={
            'cpu_millicores':1000,'memory_bytes':640*1024**2,'desired_replicas':1}))
        self.stack.enter_context(patch.object(m.dispatch.runtime,'workload_snapshot',side_effect=lambda:copy.deepcopy(self.work)))
        self.configuration=self.stack.enter_context(patch.object(m.dispatch.runtime,'retained_configuration',return_value={'private':'unchanged'}))
        self.database=SimpleNamespace(labels={},prepare=Mock())
        self.factory=self.stack.enter_context(patch.object(m.dispatch.base.inventory.observer,'Client',return_value=self.database))
        self.stack.enter_context(patch.object(m.dispatch.base,'save_client'))
        self.cleanup=self.stack.enter_context(patch.object(m.dispatch,'cleanup'))
        self.events=[]
        self.apply=self.stack.enter_context(patch.object(m.schema,'apply',side_effect=lambda _:self.events.append('sql') or {'applied':True}))
        self.verify=self.stack.enter_context(patch.object(m.schema,'verify',return_value={'applied':True}))
        def change(name,image,*_):
            self.events.append(('patch',name,image));self.work[name]['spec']['template']['spec']['containers'][0]['image']=image
        self.change=change
        self.patcher=self.stack.enter_context(patch.object(m.dispatch.runtime,'patch_runtime',side_effect=change))
        def pause_change(original,old_image,image,old_count,count):
            self.assertEqual(self.work['scheduler']['spec']['replicas'],old_count)
            self.assertEqual(self.work['scheduler']['spec']['template']['spec']['containers'][0]['image'],old_image)
            self.events.append(('scheduler',image,count))
            self.work['scheduler']['spec']['replicas']=count
            self.work['scheduler']['spec']['template']['spec']['containers'][0]['image']=image
        self.pause_change=pause_change
        self.pause=self.stack.enter_context(patch.object(m.quiesce,'patch',side_effect=pause_change))
        self.quiet=self.stack.enter_context(patch.object(m.quiesce,'wait_quiet'))
        self.wait=self.stack.enter_context(patch.object(m.dispatch.d,'wait_deployments'))
        self.drain=self.stack.enter_context(patch.object(m.dispatch.base,'wait_drain'))
        self.accept=self.stack.enter_context(patch.object(m.dispatch,'acceptance',side_effect=lambda name:{'component':name,'ready':True}))

    def test_sql_precedes_worker_then_scheduler_and_other_state_is_retained(self):
        result=m.release()
        self.assertEqual(self.events,[('scheduler',m.PREVIOUS,0),'sql',('patch','worker',self.candidate),
            ('scheduler',self.candidate,0),('scheduler',self.candidate,1)])
        self.assertEqual(result['deployment_targets'],['worker','scheduler'])
        for name in ('api','source-browser','frontend'):
            self.assertEqual(self.work[name],self.initial[name])
        self.assertTrue(result['configuration_preserved']);self.assertTrue(result['cleanup_verified'])
        self.assertFalse(result['customer_processing_requested']);self.assertEqual(result['business_commands_sent'],0)
        self.assertTrue(result['scheduler_quiesced']);self.assertTrue(result['activation_commit_point_reached'])
        self.apply.assert_called_once();self.assertEqual(self.verify.call_count,2);self.cleanup.assert_called_once()

    def test_sql_bytes_must_match_the_image_qualification(self):
        self.receipt['poll_migration']['sha256']='e'*64
        with self.assertRaisesRegex(RuntimeError,'SQL_QUALIFICATION_CHANGED'):m.release()
        self.factory.assert_not_called();self.apply.assert_not_called();self.patcher.assert_not_called();self.pause.assert_not_called()

    def test_worker_resource_floor_is_checked_before_database_or_mutation(self):
        self.resources.side_effect=RuntimeError('DELIVERY_WORKER_RESOURCES_TOO_SMALL')
        with self.assertRaisesRegex(RuntimeError,'RESOURCES_TOO_SMALL'):m.release()
        self.factory.assert_not_called();self.apply.assert_not_called();self.patcher.assert_not_called();self.pause.assert_not_called()

    def test_outbox_source_must_match_exact_deployed_catalog_source(self):
        self.receipt['source']['source_entries']['backend/scripts/runtime/dispatcher.sql']['sha256']='f'*64
        with self.assertRaisesRegex(RuntimeError,'OUTBOX_SOURCE_CHANGED'):m.release()
        self.factory.assert_not_called();self.pause.assert_not_called();self.apply.assert_not_called()

    def test_ambiguous_scheduler_patch_rolls_back_scheduler_before_worker(self):
        def ambiguous(original,old_image,image,old_count,count):
            self.pause_change(original,old_image,image,old_count,count)
            if image==self.candidate and count==0:raise RuntimeError('AMBIGUOUS_PATCH')
        self.pause.side_effect=ambiguous
        with self.assertRaisesRegex(RuntimeError,'AMBIGUOUS_PATCH'):m.release()
        self.assertEqual(self.events[-3:],[('scheduler',m.PREVIOUS,0),('patch','worker',m.PREVIOUS),('scheduler',m.PREVIOUS,1)])
        self.assertEqual(self.work,self.initial)
        self.assertEqual(m.STATE['rolled_back'],['scheduler','worker'])
        self.assertTrue(m.STATE['schema_retained_on_rollback']);self.assertTrue(m.STATE['cleanup_verified'])

    def test_post_resume_failure_keeps_candidate_pair_for_forward_recovery(self):
        def accept(name):
            if name=='scheduler':raise RuntimeError('READINESS_FAILED')
            return {'component':name,'ready':True}
        self.accept.side_effect=accept
        with self.assertRaisesRegex(RuntimeError,'READINESS_FAILED'):m.release()
        self.assertEqual(m.STATE['rolled_back'],[]);self.assertTrue(m.STATE['forward_recovery_required'])
        for name in m.TARGETS:
            self.assertEqual(self.work[name]['spec']['template']['spec']['containers'][0]['image'],self.candidate)
        self.assertNotIn(('patch','worker',m.PREVIOUS),self.events)
        self.assertTrue(m.STATE['cleanup_verified'])

    def test_ambiguous_resume_is_also_forward_only(self):
        def ambiguous(original,old_image,image,old_count,count):
            self.pause_change(original,old_image,image,old_count,count)
            if image==self.candidate and count==1:raise RuntimeError('RESUME_ACK_LOST')
        self.pause.side_effect=ambiguous
        with self.assertRaisesRegex(RuntimeError,'RESUME_ACK_LOST'):m.release()
        self.assertTrue(m.STATE['forward_recovery_required']);self.assertEqual(m.STATE['rolled_back'],[])
        self.assertEqual(m.STATE['activation_readback']['scheduler']['replicas'],1)
        self.assertEqual(m.STATE['activation_readback']['worker']['image'],self.candidate)
        self.assertNotIn(('patch','worker',m.PREVIOUS),self.events)

    def test_pre_resume_readiness_failure_restores_images_before_original_replica_count(self):
        self.accept.side_effect=RuntimeError('WORKER_AUTH_REJECTED')
        with self.assertRaisesRegex(RuntimeError,'WORKER_AUTH_REJECTED'):m.release()
        self.assertEqual(self.work,self.initial)
        self.assertEqual(self.events[-3:],[('scheduler',m.PREVIOUS,0),('patch','worker',m.PREVIOUS),('scheduler',m.PREVIOUS,1)])
        self.assertFalse(m.STATE['resume_attempted']);self.assertFalse(m.STATE['forward_recovery_required'])

    def test_critical_acceptance_runs_while_scheduler_is_zero(self):
        def accept(name):
            self.assertEqual(self.work['scheduler']['spec']['replicas'],0 if name=='worker' else 1)
            return {'component':name,'ready':True}
        self.accept.side_effect=accept
        def verify(_,**kwargs):
            if not kwargs:self.assertEqual(self.work['scheduler']['spec']['replicas'],0)
            return {'applied':True}
        self.verify.side_effect=verify
        m.release()

    def test_unconfirmed_pause_does_not_replace_worker(self):
        self.quiet.side_effect=[RuntimeError('DRAIN_UNCONFIRMED'),None]
        with self.assertRaisesRegex(RuntimeError,'DRAIN_UNCONFIRMED'):m.release()
        self.apply.assert_not_called();self.patcher.assert_not_called();self.assertEqual(self.work,self.initial)

    def test_unacknowledged_pause_that_did_not_apply_retains_original(self):
        self.pause.side_effect=RuntimeError('PAUSE_ACK_LOST')
        with self.assertRaisesRegex(RuntimeError,'PAUSE_ACK_LOST'):m.release()
        self.apply.assert_not_called();self.patcher.assert_not_called();self.assertEqual(self.work,self.initial)

    def test_unknown_schema_commit_uses_only_readback_then_continues_when_proven(self):
        self.apply.side_effect=RuntimeError('LATENCY_SCHEMA_SQL_TRANSPORT_TIMEOUT')
        result=m.release()
        self.apply.assert_called_once();self.assertEqual(self.verify.call_count,3)
        self.assertTrue(m.STATE['reconciled_after_unknown']);self.assertTrue(result['cleanup_verified'])

    def test_unproven_schema_stops_before_any_runtime_patch(self):
        self.apply.side_effect=RuntimeError('LATENCY_SCHEMA_SQL_TRANSPORT_TIMEOUT')
        self.verify.side_effect=[{'applied':False},RuntimeError('LATENCY_SCHEMA_RELEASE_MISSING')]
        with self.assertRaisesRegex(RuntimeError,'SQL_TRANSPORT_TIMEOUT'):m.release()
        self.apply.assert_called_once();self.patcher.assert_not_called();self.cleanup.assert_called_once()
        self.assertEqual(self.work,self.initial)

    def test_inspection_has_no_apply_or_runtime_mutation(self):
        self.verify.return_value={'applied':False}
        result=m.release(inspect_only=True)
        self.verify.assert_called_once_with(self.database,allow_parent=True)
        self.apply.assert_not_called();self.patcher.assert_not_called();self.accept.assert_not_called();self.pause.assert_not_called()
        self.assertEqual(result['deployment_targets'],[]);self.assertTrue(result['cleanup_verified'])

    def test_inspection_can_prove_paused_mixed_pair_without_resuming(self):
        self.work['scheduler']['spec']['replicas']=0
        self.work['worker']['spec']['template']['spec']['containers'][0]['image']=self.candidate
        result=m.release(inspect_only=True)
        self.assertEqual(result['observed_before_scheduler_replicas'],0)
        self.assertEqual(result['observed_before_images']['worker'],self.candidate)
        self.pause.assert_not_called();self.apply.assert_not_called();self.patcher.assert_not_called()

    def test_apply_never_auto_enables_preexisting_paused_scheduler(self):
        self.work['scheduler']['spec']['replicas']=0
        with self.assertRaisesRegex(RuntimeError,'SCHEDULER_REPLICAS'):m.release()
        self.pause.assert_not_called();self.factory.assert_not_called()

    def test_cleanup_failure_after_activation_is_forward_recovery_not_success(self):
        self.cleanup.side_effect=RuntimeError('CLEANUP_UNCONFIRMED')
        with self.assertRaisesRegex(RuntimeError,'CLEANUP_UNCONFIRMED'):m.release()
        self.assertTrue(m.STATE['forward_recovery_required']);self.assertFalse(m.STATE['cleanup_verified'])
        self.assertNotIn(('patch','worker',m.PREVIOUS),self.events)

    def test_current_baseline_and_queue_time_are_strict(self):
        self.work['api']['spec']['template']['spec']['containers'][0]['image']=self.candidate
        with self.assertRaisesRegex(RuntimeError,'RUNTIME_BASELINE_CHANGED'):m.release()
        self.factory.assert_not_called();self.apply.assert_not_called()
        for remaining,expected in ((170,100),(120,55),(110,45)):
            self.remaining.return_value=remaining;self.assertEqual(m.work_budget(),expected)
        self.remaining.return_value=109
        with self.assertRaisesRegex(RuntimeError,'WORK_BUDGET_EXHAUSTED'):m.work_budget()


if __name__=='__main__':unittest.main()
