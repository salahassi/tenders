#!/usr/bin/env python3
"""Apply the bounded whole-review recovery schema, then executor-7 images.

No provider configuration, usage settlement or business command is sent. The
scheduler is drained before replacement; rollback is bounded and allowed only
before its activation attempt. After activation, retain the candidate pair
and inspect before further recovery. Actual customer issuance remains a separate trial.
"""
from contextlib import redirect_stderr, redirect_stdout
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import signal
import sys

HERE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


dispatch = module('review_release_dispatch_library', 'proposal-dispatch-release.py')
qualification = module('review_release_qualification', 'proposal-review-runtime.py')
schema = module('review_release_schema', 'proposal-review-schema.py')
quiesce = module('review_release_quiesce', 'proposal-latency-quiesce.py')
PREVIOUS = 'registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:de4312a0bea6170bcd0697bf7e209900295732add424239466bb2cfededc47f1'
BASELINES = {**dispatch.BASELINES, 'worker': PREVIOUS, 'scheduler': PREVIOUS}
TARGETS = ('worker', 'scheduler')
STATE = {}


def require(value, code):
    if not value:
        raise RuntimeError('PROPOSAL_REVIEW_RELEASE_' + code)


def fixed_code(error):
    value = str(error)
    return value if re.fullmatch('[A-Z][A-Z0-9_]{0,119}', value) else 'PROPOSAL_REVIEW_RELEASE_FAILED'


def work_budget():
    budget = min(100, dispatch.remaining_run_seconds() - 65)
    require(budget >= 45, 'WORK_BUDGET_EXHAUSTED')
    return budget


def poll_boundary():
    """Prove PostgREST exposes the service-only RPC before scheduler activation.

    Null identities fail in model_job before any job, usage or attempt write.
    Only the fixed rejection leaves the pod; credentials remain in its process.
    """
    script = """const url=Deno.env.get('SUPABASE_URL');
const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if(!url||!key)throw Error('POLL_BOUNDARY_CONFIGURATION');
const response=await fetch(url+'/rest/v1/rpc/prepare_accepted_model_poll',{
 method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
 headers:{'content-type':'application/json',apikey:key,Authorization:'Bearer '+key},
 body:JSON.stringify({job_id:null,lease:null,thread_id:null,graph_input_hash:null,manifest:[]})});
const value=await response.json();
if(response.status!==400||value.code!=='P0001'||value.message!=='STALE_LEASE')throw Error('POLL_BOUNDARY_REJECTED');
console.log(JSON.stringify({rpc:'prepare_accepted_model_poll',service_route_visible:true,
 null_identity_rejected:true,business_mutations:0,provider_calls:0}));
"""
    raw = dispatch.d.command(['exec', 'deployment/worker', '-n', dispatch.d.NAMESPACE,
        '--', 'deno', 'eval', '--cached-only', script], timeout=8)
    expected = {'rpc': 'prepare_accepted_model_poll', 'service_route_visible': True,
        'null_identity_rejected': True, 'business_mutations': 0, 'provider_calls': 0}
    require(json.loads(raw) == expected, 'RPC_BOUNDARY_ACCEPTANCE')
    return expected



def executor_boundary():
    """Read only the service schema; never invoke a claim or wake function."""
    script = """const url=Deno.env.get('SUPABASE_URL');
const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
if(!url||!key)throw Error('EXECUTOR_BOUNDARY_CONFIGURATION');
const response=await fetch(url+'/rest/v1/',{
 method:'GET',redirect:'error',signal:AbortSignal.timeout(5000),
 headers:{Accept:'application/openapi+json',apikey:key,Authorization:'Bearer '+key}});
if(response.status!==200||!response.body)throw Error('EXECUTOR_BOUNDARY_REJECTED');
const reader=response.body.getReader(),parts=[];let size=0;
for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
 if(size>8388608){await reader.cancel();throw Error('EXECUTOR_BOUNDARY_SIZE');}parts.push(value);}
const bytes=new Uint8Array(size);let offset=0;
for(const value of parts){bytes.set(value,offset);offset+=value.byteLength;}
const value=JSON.parse(new TextDecoder().decode(bytes));
const names=['claim_backend_job_v7','claim_backend_local_job_v7',
 'wake_backend_queue_status_v7','wake_backend_queue_revision_v7'];
if(!value.paths||!names.every(name=>{const route=value.paths['/rpc/'+name];
 return route&&typeof route.post==='object'&&route.post!==null;}))throw Error('EXECUTOR_BOUNDARY_REJECTED');
console.log(JSON.stringify({worker_executor:7,service_routes_visible:4,
 read_only:true,business_mutations:0,provider_calls:0}));
"""
    raw = dispatch.d.command(['exec', 'deployment/worker', '-n', dispatch.d.NAMESPACE,
        '--', 'deno', 'eval', '--cached-only', script], timeout=8)
    expected = {'worker_executor': 7, 'service_routes_visible': 4,
        'read_only': True, 'business_mutations': 0, 'provider_calls': 0}
    require(json.loads(raw) == expected, 'EXECUTOR_BOUNDARY_ACCEPTANCE')
    return expected


def verify_unchanged(before, configuration, candidate, *, final=False, restored=False):
    current = dispatch.runtime.workload_snapshot()
    require(set(current) == set(before), 'WORKLOAD_SET_CHANGED')
    expected = copy.deepcopy(before)
    if STATE.get('scheduler_paused'):
        require(current['scheduler']['spec'].get('replicas') == 0, 'SCHEDULER_PAUSE_CHANGED')
        current['scheduler']['spec']['replicas'] = before['scheduler']['spec']['replicas']
    for name in TARGETS:
        actual = current[name]['spec']['template']['spec']['containers'][0]
        prior = expected[name]['spec']['template']['spec']['containers'][0]['image']
        allowed = {prior} if restored else {candidate} if final else {prior, candidate}
        require(actual['image'] in allowed, 'CONCURRENT_IMAGE_CHANGE')
        actual['image'] = prior
    require(current == expected, 'WORKLOAD_CONFIGURATION_CHANGED')
    require(dispatch.runtime.retained_configuration() == configuration, 'PRIVATE_CONFIGURATION_CHANGED')


def rollback(touched, original, candidate, before, configuration):
    require(not STATE['resume_attempted'], 'FORWARD_RECOVERY_REQUIRED')
    STATE['stage'] = 'rollback'
    STATE['schema_retained_on_rollback'] = STATE['schema_applied']
    if STATE['schema_applied']:
        STATE['marked_review_work_requires_forward_release'] = True
    scheduler = dispatch.u.owned('deployment', 'scheduler')
    replicas = scheduler['spec'].get('replicas')
    image = dispatch.base.image_of(scheduler)
    prior = dispatch.base.image_of(original['scheduler'])
    require(replicas in (0, 1) and image in (candidate, prior), 'ROLLBACK_CONCURRENT_CHANGE')
    if replicas == 1:
        # An unacknowledged pause may have failed before making any change.
        # A resumed candidate may already have accepted executor-7 work.
        require(not touched and image == prior, 'FORWARD_RECOVERY_REQUIRED')
        STATE['scheduler_paused'] = False
        verify_unchanged(before, configuration, candidate, restored=True)
        return
    STATE['scheduler_paused'] = True
    verify_unchanged(before, configuration, candidate)
    STATE['rollback_target'] = 'scheduler'
    quiesce.patch(original['scheduler'], image, prior, 0, 0)
    quiesce.wait_quiet(original['scheduler'], prior, timeout=10)
    STATE['rollback_target'] = 'worker'
    observed = dispatch.base.image_of(dispatch.u.deployment('worker', ready=False))
    worker_prior = dispatch.base.image_of(original['worker'])
    require(observed in (candidate, worker_prior), 'ROLLBACK_CONCURRENT_CHANGE')
    if observed != worker_prior:
        dispatch.runtime.patch_runtime('worker', worker_prior, original['worker'], candidate)
    dispatch.d.wait_deployments(['worker'], seconds=10)
    dispatch.base.wait_drain('worker', worker_prior, timeout=10)
    verify_unchanged(before, configuration, candidate, restored=True)
    STATE['rollback_target'] = 'scheduler_resume'
    quiesce.patch(original['scheduler'], prior, prior, 0, 1)
    STATE['scheduler_paused'] = False
    dispatch.d.wait_deployments(['scheduler'], seconds=10)
    verify_unchanged(before, configuration, candidate, restored=True)
    STATE['rolled_back'] = ['scheduler', 'worker']


def forward_readback():
    """Observe an ambiguous activation; keep the qualified candidate pair."""
    STATE['forward_recovery_required'] = True
    STATE['recovery_action'] = 'INSPECT_AND_REPAIR_FORWARD_RETAIN_CANDIDATE_PAIR'
    remaining = dispatch.remaining_run_seconds()
    if remaining <= 15:
        STATE['activation_readback_error'] = 'PROPOSAL_REVIEW_RELEASE_READBACK_BUDGET'
        return
    signal.alarm(min(10, remaining - 15))
    try:
        values = {}
        for name in TARGETS:
            value = dispatch.u.owned('deployment', name)
            values[name] = {'uid': value['metadata']['uid'], 'image': dispatch.base.image_of(value),
                'replicas': value['spec'].get('replicas'), 'ready_replicas': value.get('status', {}).get('readyReplicas', 0)}
        STATE['activation_readback'] = values
    except (Exception, dispatch.DeadlineExceeded) as error:
        STATE['activation_readback_error'] = fixed_code(error)
    finally:
        signal.alarm(0)


def release(*, inspect_only=False):
    STATE.clear()
    STATE.update(stage='preflight', mode='inspect' if inspect_only else 'apply', patched=[], touched=[],
        rolled_back=[], rollback_failed=[], schema_apply_attempted=False, schema_apply_acknowledged=False, schema_applied=False,
        schema_retained_on_rollback=False, cleanup_verified=False, pause_attempted=False,
        scheduler_paused=False, scheduler_quiesced=False, resume_attempted=False, forward_recovery_required=False)
    before = configuration = original = candidate = None
    try:
        require(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'WORKFLOW_REPLAY_REFUSED')
        revision = dispatch.verify_checkout()
        receipt, candidate = qualification.publication()
        require(candidate != PREVIOUS and receipt['zero_inventory_review_migration'] == {
            'path': str(schema.SOURCE.relative_to(schema.ROOT)), 'sha256': schema.source_sha256()}, 'SQL_QUALIFICATION_CHANGED')
        require(receipt['source']['source_entries']['backend/scripts/runtime/dispatcher.sql']['sha256']
            == schema.retry.PARENT_SQL, 'OUTBOX_SOURCE_CHANGED')
        registry = qualification.registry_identity(candidate, receipt)
        STATE['candidate_image'] = candidate
        dispatch.d.probe.validate_cluster()
        original = {name: dispatch.u.owned('deployment', name) if inspect_only and name == 'scheduler'
            else dispatch.u.deployment(name) for name in BASELINES}
        require(original['scheduler']['spec'].get('replicas') in ((0, 1) if inspect_only else (1,)), 'SCHEDULER_REPLICAS')
        require(all(dispatch.base.image_of(value) in ({BASELINES[name], candidate}
            if inspect_only and name in TARGETS else {BASELINES[name]})
            for name, value in original.items()), 'RUNTIME_BASELINE_CHANGED')
        resources = dispatch.base.worker_resource_envelope(original['worker'])
        dispatch.verify_runtime_contract(original)
        before = dispatch.runtime.workload_snapshot()
        configuration = dispatch.runtime.retained_configuration()
        database = dispatch.base.inventory.observer.Client(1800)
        database.labels['app.kubernetes.io/managed-by'] = dispatch.base.OWNER
        dispatch.base.save_client(database)
        STATE['stage'] = 'owned_database_client'
        database.prepare()
        verify_unchanged(before, configuration, candidate)
        if inspect_only:
            STATE['stage'] = 'read_only_schema_inspection'
            applied = readback = schema.verify(database, allow_parent=True)
            STATE['schema_applied'] = readback['applied']
            require(readback['applied'] or all(dispatch.base.image_of(original[name]) == PREVIOUS
                for name in TARGETS), 'SCHEMA_RUNTIME_INCOMPATIBLE')
            readiness = []
        else:
            # The exact migration retains legacy executor-6 claims and fences
            # marked whole-review jobs at executor 7. Native PostgreSQL proof
            # binds this compatibility before SQL precedes image replacement.
            STATE.update(stage='atomic_schema_apply', schema_apply_attempted=True)
            try:
                applied = schema.apply(database)
                STATE['schema_apply_acknowledged'] = True
            except (Exception, dispatch.DeadlineExceeded) as error:
                STATE.update(schema_error=fixed_code(error), stage='read_only_commit_reconciliation')
                remaining = dispatch.remaining_run_seconds()
                if remaining < 40:
                    raise
                signal.alarm(min(20, remaining - 20))
                try:
                    applied = schema.verify(database, allow_parent=True)
                    STATE['uncertain_commit_readback'] = applied
                    if not applied['applied']:
                        raise error
                except (Exception, dispatch.DeadlineExceeded) as reconciliation_error:
                    STATE['reconciliation_error'] = fixed_code(reconciliation_error)
                    raise error
                STATE['reconciled_after_unknown'] = True
                STATE['schema_applied'] = True
                # A proved SQL-only result can be resumed explicitly later if
                # too little budget remains for guarded image replacement.
                signal.alarm(work_budget())
            STATE['schema_applied'] = True
            STATE['stage'] = 'pre_pause_schema_readback'
            readback = schema.verify(database)
            STATE['schema_readback'] = readback
            verify_unchanged(before, configuration, candidate)
            require(dispatch.remaining_run_seconds() >= 110, 'ROLLOUT_BUDGET_EXHAUSTED')
            STATE.update(stage='scheduler_pause', pause_attempted=True)
            quiesce.patch(original['scheduler'], PREVIOUS, PREVIOUS, 1, 0)
            STATE['scheduler_paused'] = True
            quiesce.wait_quiet(original['scheduler'], PREVIOUS, timeout=15)
            STATE['scheduler_quiesced'] = True
            STATE['stage'] = 'worker_rollout'
            verify_unchanged(before, configuration, candidate)
            STATE['touched'].append('worker')
            dispatch.runtime.patch_runtime('worker', candidate, original['worker'], PREVIOUS)
            STATE['patched'].append('worker')
            dispatch.d.wait_deployments(['worker'], seconds=25)
            dispatch.base.wait_drain('worker', candidate, timeout=25)
            STATE['stage'] = 'scheduler_template_rollout_while_paused'
            verify_unchanged(before, configuration, candidate)
            STATE['touched'].append('scheduler')
            quiesce.patch(original['scheduler'], PREVIOUS, candidate, 0, 0)
            STATE['patched'].append('scheduler')
            quiesce.wait_quiet(original['scheduler'], candidate, timeout=10)
            STATE['stage'] = 'pre_resume_acceptance'
            readiness = [dispatch.acceptance('worker'), poll_boundary(), executor_boundary()]
            readback = schema.verify(database)
            verify_unchanged(before, configuration, candidate, final=True)
            STATE['critical_checks_passed'] = True
            # This is the activation commit point. New executor-7 work may now
            # exist; an ambiguous failure retains this qualified pair and
            # requires actual-state readback before further recovery.
            STATE.update(stage='scheduler_resume', resume_attempted=True)
            quiesce.patch(original['scheduler'], candidate, candidate, 0, 1)
            STATE['scheduler_paused'] = False
            dispatch.d.wait_deployments(['scheduler'], seconds=15)
            readiness.append(dispatch.acceptance('scheduler'))
        STATE['stage'] = 'retained_runtime_verification'
        verify_unchanged(before, configuration, candidate, final=not inspect_only, restored=inspect_only)
        result = {'release': 'proposal-legacy-whole-review-v1', 'status': 'passed', 'mode': STATE['mode'],
            'source_revision': revision, 'artifact_source_revision': receipt['source_revision'],
            'image': candidate, 'image_id': receipt['image']['Id'],
            'qualification_sha256': qualification.RECEIPT_SHA256, 'zero_inventory_review_migration': receipt['zero_inventory_review_migration'],
            'registry_identity': registry, 'schema': applied, 'schema_readback': readback,
            'readiness': readiness, 'deployment_targets': [] if inspect_only else list(TARGETS),
            'retained_images': {k: v for k, v in BASELINES.items() if k not in TARGETS},
            'observed_before_images': {k: dispatch.base.image_of(v) for k, v in original.items()},
            'worker_resource_envelope': resources, 'scheduler_quiesced': STATE['scheduler_quiesced'],
            'activation_commit_point_reached': STATE['resume_attempted'],
            'observed_before_scheduler_replicas': original['scheduler']['spec']['replicas'],
            'configuration_preserved': True, 'worker_executor': 7, 'marked_review_minimum_worker_executor': 7,
            'customer_processing_requested': False,
            'providers_activated': False, 'business_commands_sent': 0, 'customer_completion_verified': False}
    except (Exception, dispatch.DeadlineExceeded):
        STATE['failure_stage'] = STATE['stage']
        if STATE['schema_applied'] and not STATE['pause_attempted']:
            STATE['recovery_action'] = 'INSPECT_EXACT_CHILD_THEN_EXPLICIT_FORWARD_RELEASE'
        if STATE['resume_attempted']:
            forward_readback()
        elif STATE['pause_attempted']:
            remaining = dispatch.remaining_run_seconds()
            if remaining > 15:
                signal.alarm(min(45, remaining - 15))
                try:
                    rollback(STATE['touched'], original, candidate, before, configuration)
                except (Exception, dispatch.DeadlineExceeded) as rollback_error:
                    STATE['rollback_error'] = fixed_code(rollback_error)
                    STATE['rollback_failed'] = [STATE.get('rollback_target', 'scheduler_pause')]
            else:
                STATE['rollback_failed'] = list(STATE['touched']) or ['scheduler_pause']
                STATE['rollback_error'] = 'PROPOSAL_REVIEW_RELEASE_ROLLBACK_BUDGET'
        raise
    finally:
        signal.alarm(0)
        try:
            dispatch.cleanup()
            STATE['cleanup_verified'] = True
        except (Exception, dispatch.DeadlineExceeded) as error:
            STATE['cleanup_failure'] = fixed_code(error)
            if STATE['resume_attempted']:
                STATE['forward_recovery_required'] = True
                STATE['recovery_action'] = 'INSPECT_AND_REPAIR_FORWARD_RETAIN_CANDIDATE_PAIR'
            raise
    STATE['stage'] = 'passed'
    result['cleanup_verified'] = True
    return result


def main():
    signal.signal(signal.SIGALRM, dispatch.deadline)
    signal.signal(signal.SIGTERM, dispatch.deadline)
    try:
        if sys.argv[1:] == ['--cleanup']:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                dispatch.cleanup()
            print('{"proposal_review_cleanup":"confirmed"}', flush=True)
            return 0
        require(sys.argv[1:] in (['--inspect'], ['--apply']), 'EXPLICIT_MODE_REQUIRED')
        signal.alarm(work_budget())
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            result = release(inspect_only=sys.argv[1:] == ['--inspect'])
        print(json.dumps(result), flush=True)
        return 0
    except (Exception, dispatch.DeadlineExceeded) as error:
        print(json.dumps({'release': 'proposal-legacy-whole-review-v1', 'status': 'failed',
            'code': fixed_code(error), 'state': STATE}), flush=True)
        return 1
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    sys.exit(main())
