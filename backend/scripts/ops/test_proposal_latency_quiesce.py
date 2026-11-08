from contextlib import ExitStack
import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('tested_latency_quiesce',HERE/'proposal-latency-quiesce.py')
m=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(m)


class SchedulerQuiesceTests(unittest.TestCase):
    def setUp(self):
        self.stack=ExitStack();self.addCleanup(self.stack.close)
        self.original={'metadata':{'uid':'owned-scheduler','resourceVersion':'3','generation':1},
            'spec':{'replicas':1,'selector':{'matchLabels':{'app':'scheduler'}},'template':{'spec':{
                'containers':[{'name':'scheduler','image':'old','env':[{'name':'SCHEDULER_ENABLED','value':'true'}]}]}}}}
        self.current=copy.deepcopy(self.original)
        self.owned=self.stack.enter_context(patch.object(m.dispatch.u,'owned',side_effect=lambda *_:copy.deepcopy(self.current)))
        def execute(args,**kwargs):
            operations=json.loads(args[-1])
            self.assertEqual(kwargs,{'timeout':10})
            self.assertEqual(operations[:3],[{'op':'test','path':'/metadata/uid','value':'owned-scheduler'},
                {'op':'test','path':'/metadata/resourceVersion','value':'3'},
                {'op':'test','path':'/spec','value':self.current['spec']}])
            for change in operations[3:]:
                if change['path']=='/spec/replicas':self.current['spec']['replicas']=change['value']
                elif change['path']=='/spec/template/spec/containers/0/image':
                    self.current['spec']['template']['spec']['containers'][0]['image']=change['value']
                else:self.fail('unexpected mutation')
            self.current['metadata']['generation']+=1
        self.command=self.stack.enter_context(patch.object(m.dispatch.d,'command',side_effect=execute))
        self.pods=self.stack.enter_context(patch.object(m.dispatch.runtime.base,'runtime_pods',return_value=[]))
        self.sleep=self.stack.enter_context(patch.object(m.time,'sleep'))

    def test_pause_then_replace_then_resume_preserve_all_other_fields(self):
        m.patch(self.original,'old','old',1,0)
        m.patch(self.original,'old','new',0,0)
        m.patch(self.original,'new','new',0,1)
        expected=copy.deepcopy(self.original['spec']);expected['template']['spec']['containers'][0]['image']='new'
        self.assertEqual(self.current['spec'],expected)
        self.assertEqual(self.command.call_count,3)

    def test_image_replacement_requires_zero_replicas(self):
        for transition in ((1,1),(1,0),(0,1)):
            with self.subTest(transition=transition),self.assertRaisesRegex(RuntimeError,'TRANSITION'):
                m.patch(self.original,'old','new',*transition)
        self.command.assert_not_called()

    def test_uid_resource_version_and_full_spec_are_checked_before_mutation(self):
        for change in ('uid','resourceVersion','env'):
            self.current=copy.deepcopy(self.original)
            if change=='uid':self.current['metadata']['uid']='foreign'
            elif change=='resourceVersion':self.current['metadata'].pop('resourceVersion')
            else:self.current['spec']['template']['spec']['containers'][0]['env'][0]['value']='false'
            with self.subTest(change=change),self.assertRaisesRegex(RuntimeError,'CONCURRENT_CHANGE'):
                m.patch(self.original,'old','old',1,0)
        self.command.assert_not_called()

    def test_original_zero_or_multiple_replicas_are_not_auto_enabled(self):
        for count in (0,2):
            self.original['spec']['replicas']=count
            with self.subTest(count=count),self.assertRaisesRegex(RuntimeError,'REPLICAS'):
                m.expected_spec(self.original,'old',1)

    def test_drain_requires_observed_generation_zero_status_and_no_active_owned_pods(self):
        self.current['spec']['replicas']=0
        good={'observedGeneration':1,'replicas':0,'updatedReplicas':0,'readyReplicas':0,'availableReplicas':0}
        for failure in ('generation','status','running','terminating','pending'):
            self.current['status']=dict(good)
            self.pods.return_value=[]
            if failure=='generation':self.current['status']['observedGeneration']=0
            elif failure=='status':self.current['status']['replicas']=1
            else:self.pods.return_value=[{'metadata':{'deletionTimestamp':'now'} if failure=='terminating' else {},
                'status':{'phase':'Pending' if failure=='pending' else 'Running'}}]
            with self.subTest(failure=failure),self.assertRaisesRegex(RuntimeError,'DRAIN_UNCONFIRMED'):
                m.wait_quiet(self.original,'old',timeout=0)
        self.current['status']=dict(good)
        self.pods.return_value=[{'status':{'phase':'Succeeded'}},{'status':{'phase':'Failed'}}]
        m.wait_quiet(self.original,'old',timeout=0)
        self.pods.assert_called_with('scheduler',self.current)


if __name__=='__main__':unittest.main()
