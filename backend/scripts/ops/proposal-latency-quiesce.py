"""Guarded, temporary scheduler scaling for a versioned worker replacement.

The original enabled setting, selectors, environment and all other spec fields
stay unchanged. Only the owned Deployment's replica count and qualified image
are changed through UID/resourceVersion/spec JSON-Patch preconditions.
"""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import time

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('latency_quiesce_dispatch',HERE/'proposal-dispatch-release.py')
dispatch=importlib.util.module_from_spec(spec);sys.modules[spec.name]=dispatch;spec.loader.exec_module(dispatch)


def require(value,code):
    if not value:raise RuntimeError('PROPOSAL_LATENCY_QUIESCE_'+code)


def expected_spec(original,image,replicas):
    require(original['spec'].get('replicas')==1 and replicas in (0,1),'REPLICAS')
    value=copy.deepcopy(original['spec'])
    value['replicas']=replicas
    value['template']['spec']['containers'][0]['image']=image
    return value


def current(original,image,replicas):
    value=dispatch.u.owned('deployment','scheduler')
    metadata=value['metadata']
    require(metadata.get('uid')==original['metadata'].get('uid') and metadata.get('uid')
        and metadata.get('resourceVersion') and value['spec']==expected_spec(original,image,replicas),'CONCURRENT_CHANGE')
    return value


def patch(original,from_image,to_image,from_replicas,to_replicas):
    require(from_replicas in (0,1) and to_replicas in (0,1)
        and (from_image==to_image or from_replicas==to_replicas==0),'TRANSITION')
    observed=current(original,from_image,from_replicas)
    operations=[{'op':'test','path':'/metadata/uid','value':observed['metadata']['uid']},
        {'op':'test','path':'/metadata/resourceVersion','value':observed['metadata']['resourceVersion']},
        {'op':'test','path':'/spec','value':observed['spec']}]
    if from_image!=to_image:
        operations.append({'op':'replace','path':'/spec/template/spec/containers/0/image','value':to_image})
    if from_replicas!=to_replicas:
        operations.append({'op':'replace','path':'/spec/replicas','value':to_replicas})
    if len(operations)>3:
        dispatch.d.command(['patch','deployment','scheduler','-n',dispatch.d.NAMESPACE,'--type=json','--patch',json.dumps(operations)],timeout=10)
    return current(original,to_image,to_replicas)


def wait_quiet(original,image,timeout=15):
    deadline=time.monotonic()+timeout
    while True:
        value=current(original,image,0)
        pods=dispatch.runtime.base.runtime_pods('scheduler',value)
        status=value.get('status',{})
        observed=status.get('observedGeneration',-1)>=value['metadata'].get('generation',0)
        stopped=all(status.get(key,0)==0 for key in ('replicas','updatedReplicas','readyReplicas','availableReplicas'))
        if observed and stopped and not any(p.get('status',{}).get('phase') not in ('Succeeded','Failed') for p in pods):return
        require(time.monotonic()<deadline,'DRAIN_UNCONFIRMED')
        time.sleep(0.25)
