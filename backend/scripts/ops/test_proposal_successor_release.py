from contextlib import ExitStack
import copy
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('tested_successor_release', HERE/'proposal-successor-release.py')
m = importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)


class SuccessorReleaseTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {'GITHUB_RUN_ATTEMPT':'1'}))
        self.alarm=self.stack.enter_context(patch.object(m.signal,'alarm'))
        self.remaining=self.stack.enter_context(patch.object(m.dispatch,'remaining_run_seconds',return_value=150))
        self.stack.enter_context(patch.object(m.dispatch,'verify_checkout',return_value='a'*40))
        self.candidate='registry.invalid/runtime@sha256:'+'b'*64
        self.stack.enter_context(patch.object(m.schema,'source_sha256',return_value='a'*64))
        self.receipt={'source_revision':'c'*40,'image':{'Id':'sha256:'+'d'*64},'successor_migration':{
            'path':str(m.schema.SOURCE.relative_to(m.schema.ROOT)),'sha256':m.schema.source_sha256()},
            'source':{'source_entries':{'backend/scripts/runtime/dispatcher.sql':{'sha256':m.schema.retry.PARENT_SQL}}}}
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
        self.executor_route=self.stack.enter_context(patch.object(m,'executor_boundary',return_value={'service_routes_visible':4}))
        self.poll_route=self.stack.enter_context(patch.object(m,'poll_boundary',return_value={'service_route_visible':True}))

    def test_sql_precedes_worker_then_scheduler_and_other_state_is_retained(self):
        result=m.release()
        self.assertEqual(self.events,['sql',('scheduler',m.PREVIOUS,0),('patch','worker',self.candidate),
            ('scheduler',self.candidate,0),('scheduler',self.candidate,1)])
        self.assertEqual(result['deployment_targets'],['worker','scheduler'])
        for name in ('api','source-browser','frontend'):
            self.assertEqual(self.work[name],self.initial[name])
        self.assertTrue(result['configuration_preserved']);self.assertTrue(result['cleanup_verified'])
        self.assertFalse(result['customer_processing_requested']);self.assertEqual(result['business_commands_sent'],0)
        self.assertTrue(result['scheduler_quiesced']);self.assertTrue(result['activation_commit_point_reached'])
        self.apply.assert_called_once();self.assertEqual(self.verify.call_count,2);self.cleanup.assert_called_once()
        self.poll_route.assert_called_once();self.executor_route.assert_called_once()

    def test_missing_postgrest_poll_route_rolls_back_before_activation(self):
        self.poll_route.side_effect=RuntimeError('RPC_BOUNDARY_ACCEPTANCE')
        with self.assertRaisesRegex(RuntimeError,'RPC_BOUNDARY_ACCEPTANCE'):m.release()
        self.assertFalse(m.STATE['resume_attempted'])
        self.assertEqual(self.work,self.initial)
        self.assertTrue(m.STATE['schema_retained_on_rollback'])
        self.assertTrue(m.STATE['cleanup_verified'])

    def test_missing_executor_route_rolls_back_but_keeps_v2_fence(self):
        self.executor_route.side_effect=RuntimeError('EXECUTOR_BOUNDARY_ACCEPTANCE')
        with self.assertRaisesRegex(RuntimeError,'EXECUTOR_BOUNDARY_ACCEPTANCE'):m.release()
        self.assertFalse(m.STATE['resume_attempted']);self.assertEqual(self.work,self.initial)
        self.assertTrue(m.STATE['schema_retained_on_rollback'])
        self.assertTrue(m.STATE['version_2_work_requires_forward_release'])
        self.assertTrue(m.STATE['cleanup_verified'])

    def test_sql_bytes_must_match_the_image_qualification(self):
        self.receipt['successor_migration']['sha256']='e'*64
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
            self.assertEqual(self.work['scheduler']['spec']['replicas'],1 if m.STATE['stage']=='pre_pause_schema_readback' else 0)
            return {'applied':True}
        self.verify.side_effect=verify
        m.release()

    def test_unconfirmed_pause_does_not_replace_worker(self):
        self.quiet.side_effect=[RuntimeError('DRAIN_UNCONFIRMED'),None]
        with self.assertRaisesRegex(RuntimeError,'DRAIN_UNCONFIRMED'):m.release()
        self.apply.assert_called_once();self.patcher.assert_not_called();self.assertEqual(self.work,self.initial)

    def test_unacknowledged_pause_that_did_not_apply_retains_original(self):
        self.pause.side_effect=RuntimeError('PAUSE_ACK_LOST')
        with self.assertRaisesRegex(RuntimeError,'PAUSE_ACK_LOST'):m.release()
        self.apply.assert_called_once();self.patcher.assert_not_called();self.assertEqual(self.work,self.initial)

    def test_unknown_schema_commit_uses_only_readback_then_continues_when_proven(self):
        self.apply.side_effect=RuntimeError('SUCCESSOR_SCHEMA_SQL_TRANSPORT_TIMEOUT')
        result=m.release()
        self.apply.assert_called_once();self.assertEqual(self.verify.call_count,3)
        self.assertTrue(m.STATE['reconciled_after_unknown']);self.assertTrue(result['cleanup_verified'])

    def test_unproven_schema_stops_before_any_runtime_patch(self):
        self.apply.side_effect=RuntimeError('SUCCESSOR_SCHEMA_SQL_TRANSPORT_TIMEOUT')
        self.verify.side_effect=[{'applied':False},RuntimeError('SUCCESSOR_SCHEMA_RELEASE_MISSING')]
        with self.assertRaisesRegex(RuntimeError,'SQL_TRANSPORT_TIMEOUT'):m.release()
        self.apply.assert_called_once();self.patcher.assert_not_called();self.cleanup.assert_called_once()
        self.assertEqual(self.work,self.initial)

    def test_unknown_commit_at_work_deadline_is_read_back_without_image_mutation(self):
        self.apply.side_effect=m.dispatch.DeadlineExceeded('DISPATCH_RELEASE_DEADLINE')
        self.remaining.return_value=65
        with self.assertRaisesRegex(RuntimeError,'WORK_BUDGET_EXHAUSTED'):m.release()
        self.apply.assert_called_once();self.verify.assert_called_once_with(self.database,allow_parent=True)
        self.pause.assert_not_called();self.patcher.assert_not_called()
        self.assertTrue(m.STATE['schema_applied']);self.assertTrue(m.STATE['reconciled_after_unknown'])
        self.assertEqual(m.STATE['recovery_action'],'INSPECT_EXACT_CHILD_THEN_EXPLICIT_FORWARD_RELEASE')
        self.assertEqual(self.work,self.initial);self.cleanup.assert_called_once()

    def test_known_child_can_resume_explicitly_from_original_image_pair(self):
        self.apply.side_effect=None;self.apply.return_value={'applied':True,'replayed':True}
        result=m.release()
        self.assertTrue(result['schema']['replayed']);self.assertTrue(result['cleanup_verified'])
        self.assertEqual(self.patcher.call_args.args[0],'worker')

    def test_unconfirmed_pre_pause_readback_preserves_workloads_and_reports_sql_state(self):
        self.verify.side_effect=RuntimeError('SUCCESSOR_SCHEMA_POST_CATALOG_CHANGED')
        with self.assertRaisesRegex(RuntimeError,'POST_CATALOG_CHANGED'):m.release()
        self.assertTrue(m.STATE['schema_applied']);self.pause.assert_not_called();self.patcher.assert_not_called()
        self.assertEqual(m.STATE['recovery_action'],'INSPECT_EXACT_CHILD_THEN_EXPLICIT_FORWARD_RELEASE')

    def test_slow_acknowledged_sql_stops_before_pause_when_rollout_budget_is_short(self):
        self.remaining.return_value=109
        with self.assertRaisesRegex(RuntimeError,'ROLLOUT_BUDGET_EXHAUSTED'):m.release()
        self.apply.assert_called_once();self.verify.assert_called_once_with(self.database)
        self.pause.assert_not_called();self.patcher.assert_not_called()
        self.assertTrue(m.STATE['schema_applied']);self.assertEqual(self.work,self.initial)

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

    def test_inspection_rejects_candidate_image_without_its_child_rpc(self):
        self.verify.return_value={'applied':False}
        self.work['worker']['spec']['template']['spec']['containers'][0]['image']=self.candidate
        with self.assertRaisesRegex(RuntimeError,'SCHEMA_RUNTIME_INCOMPATIBLE'):m.release(inspect_only=True)
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



class ExecutorBoundaryTests(unittest.TestCase):
    def test_exact_four_routes_are_read_only_and_bounded(self):
        expected={'worker_executor':6,'service_routes_visible':4,'read_only':True,'business_mutations':0,'provider_calls':0}
        import json
        with patch.object(m.dispatch.d,'command',return_value=json.dumps(expected)) as command:
            self.assertEqual(m.executor_boundary(),expected)
        self.assertEqual(command.call_args.kwargs,{'timeout':8})
        script=command.call_args.args[0][-1]
        for name in ('claim_backend_job_v6','claim_backend_local_job_v6','wake_backend_queue_status_v6','wake_backend_queue_revision_v6'):
            self.assertIn(name,script)
        self.assertIn("method:'GET'",script);self.assertNotIn("method:'POST'",script)
        self.assertIn("redirect:'error'",script);self.assertIn('AbortSignal.timeout(5000)',script)
        self.assertIn('size>8388608',script)
        with patch.object(m.dispatch.d,'command',return_value=json.dumps({**expected,'service_routes_visible':3})):
            with self.assertRaisesRegex(RuntimeError,'EXECUTOR_BOUNDARY_ACCEPTANCE'):m.executor_boundary()

    def test_actual_route_validator_rejects_each_missing_rpc(self):
        import json, subprocess
        expected={'worker_executor':6,'service_routes_visible':4,'read_only':True,'business_mutations':0,'provider_calls':0}
        with patch.object(m.dispatch.d,'command',return_value=json.dumps(expected)) as command:m.executor_boundary()
        script=command.call_args.args[0][-1]
        program="""let raw='';for await(const part of process.stdin)raw+=part;
const script=JSON.parse(raw),names=['claim_backend_job_v6','claim_backend_local_job_v6','wake_backend_queue_status_v6','wake_backend_queue_revision_v6'];
const run=async(missing)=>{let emitted=false;const paths=Object.fromEntries(names.filter(n=>n!==missing).map(n=>['/rpc/'+n,{post:{}}]));
const fetch=async(url,options)=>{if(url!=='https://synthetic.invalid/rest/v1/'||options.method!=='GET'||options.redirect!=='error'||options.headers.Accept!=='application/openapi+json')throw Error('UNSAFE_REQUEST');return new Response(JSON.stringify({paths}),{status:200});};
const Deno={env:{get:name=>name==='SUPABASE_URL'?'https://synthetic.invalid':'synthetic-key'}},console={log:()=>{emitted=true;}};
let code;try{await new Function('Deno','fetch','console','return(async()=>{'+script+'})()')(Deno,fetch,console);}catch(e){code=e.message;}
if(missing?(code!=='EXECUTOR_BOUNDARY_REJECTED'||emitted):(code||!emitted))throw Error('ROUTE_VALIDATION_FAILED');};
await run(null);for(const name of names)await run(name);console.log('four_routes_passed');
"""
        result=subprocess.run(['node','--input-type=module','-e',program],input=json.dumps(script),text=True,capture_output=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr);self.assertIn('four_routes_passed',result.stdout)

if __name__=='__main__':unittest.main()
