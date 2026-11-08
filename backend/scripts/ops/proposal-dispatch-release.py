#!/usr/bin/env python3
"""Apply compatible dispatch SQL, then only worker and scheduler images.

This does not activate providers or retry customer work. Existing authorized
queues can continue while their runtime is replaced. Rollback restores scheduler
before worker and deliberately leaves the compatible, ledger-bound SQL in place.
"""
import copy
from contextlib import redirect_stdout, redirect_stderr
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


base = load_module('dispatch_release_base', 'proposal-delivery-update.py')
qualification = load_module('dispatch_release_qualification', 'proposal-dispatch-runtime.py')
d, runtime, u = base.d, base.runtime, base.u
TARGETS = ('worker', 'scheduler')
PREVIOUS_RUNTIME = 'registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:077b06edd81eb58296ef755e7baa8af32a73dd931c6f06097acc513d3f684e3e'
BASELINES = {
    'worker': PREVIOUS_RUNTIME,
    'scheduler': PREVIOUS_RUNTIME,
    'source-browser': PREVIOUS_RUNTIME,
    'api': 'registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:f573e991e622c982e82a4a3b4e6dc6f144e87586ba0f5dd0b3d05381b30dbd6a',
    'frontend': 'registry.digitalocean.com/tenderdesk-a6093a76/frontend@sha256:522ad1b7258f1842bafd94f7f1b8c4c3a4642c098063dea848248f49b3c8e0f3',
}
STATE = {'stage': 'initial', 'patched': [], 'rolled_back': [], 'rollback_failed': [],
         'schema_applied': False, 'schema_retained_on_rollback': False}


class ReleaseError(Exception):
    pass


class DeadlineExceeded(BaseException):
    """Do not let a dependency's broad cleanup retry swallow our wall clock."""


def require(value, code):
    if not value:
        raise ReleaseError('DISPATCH_RELEASE_' + code)


def deadline(_signum, _frame):
    raise DeadlineExceeded('DISPATCH_RELEASE_DEADLINE')


def remaining_run_seconds(now=None):
    raw = os.environ.get('TENDERDESK_RUN_DEADLINE_EPOCH', '')
    require(re.fullmatch('[0-9]{10}', raw) is not None, 'TOTAL_DEADLINE_MISSING')
    remaining = int(raw) - (time.time() if now is None else now)
    require(remaining <= 175, 'TOTAL_DEADLINE_INVALID')
    return int(remaining)


def work_budget(now=None):
    # The workflow binds this deadline to API-observed run creation, including
    # queue and setup. Keep 25s rollback + 15s cleanup inside created+170s.
    budget = min(110, remaining_run_seconds(now) - 40)
    require(budget >= 45, 'INSUFFICIENT_TOTAL_BUDGET')
    return budget


def verify_checkout():
    revision = os.environ.get('GITHUB_SHA', '')
    require(re.fullmatch('[a-f0-9]{40}', revision) is not None, 'REVISION')
    root = str(qualification.ROOT)
    observed = subprocess.check_output(['git', '-C', root, 'rev-parse', 'HEAD'], text=True).strip()
    dirty = subprocess.check_output(['git', '-C', root, 'status', '--porcelain=v1', '--untracked-files=no'], text=True)
    require(observed == revision and not dirty, 'CHECKOUT_CHANGED')
    return revision


def verify_runtime_contract(original):
    for name in TARGETS:
        container = original[name]['spec']['template']['spec']['containers'][0]
        require(container.get('name') == name and not container.get('command') and not container.get('args'), 'ENTRYPOINT_OVERRIDE')
        require([e for e in container.get('env', []) if e.get('name') == 'APP_RUNTIME_SERVICE'] ==
                [{'name': 'APP_RUNTIME_SERVICE', 'value': name}], 'RUNTIME_ROLE')
    environment = original['scheduler']['spec']['template']['spec']['containers'][0].get('env', [])
    for name, value in (('APP_SCHEDULER_ENABLED', 'true'),
                        ('APP_WORKER_URL', 'http://worker:8080/functions/v1/worker')):
        require([entry for entry in environment if entry.get('name') == name] ==
                [{'name': name, 'value': value}], 'SCHEDULER_BINDING')


def verify_unchanged(before, configuration, candidate, *, final=False, restored=False):
    current = runtime.workload_snapshot()
    require(set(current) == set(before), 'WORKLOAD_SET_CHANGED')
    expected = copy.deepcopy(before)
    for name in TARGETS:
        actual = current[name]['spec']['template']['spec']['containers'][0]
        prior = expected[name]['spec']['template']['spec']['containers'][0]['image']
        allowed = {prior} if restored else {candidate} if final else {prior, candidate}
        require(actual['image'] in allowed, 'CONCURRENT_IMAGE_CHANGE')
        actual['image'] = prior
    require(current == expected, 'WORKLOAD_CONFIGURATION_CHANGED')
    require(runtime.retained_configuration() == configuration, 'PRIVATE_CONFIGURATION_CHANGED')


def rollback(touched, original, candidate, before, configuration):
    STATE['stage'] = 'rollback'
    STATE['schema_retained_on_rollback'] = STATE['schema_applied']
    # Old scheduler understands both old and new worker responses. The reverse
    # combination would call new RPC/maintenance paths against an old worker.
    for name in ('scheduler', 'worker'):
        if name not in touched:
            continue
        try:
            observed = base.image_of(u.deployment(name, ready=False))
            prior = base.image_of(original[name])
            require(observed in (candidate, prior), 'ROLLBACK_CONCURRENT_CHANGE')
            if observed != prior:
                runtime.patch_runtime(name, prior, original[name], candidate)
            # A prior template can coexist with terminating candidate pods
            # after an interrupted patch. Confirm their drain before reverting
            # the worker to the implementation that lacks the new endpoint.
            d.wait_deployments([name], seconds=10)
            base.wait_drain(name, prior, timeout=10)
            STATE['rolled_back'].append(name)
        except Exception:
            STATE['rollback_failed'].append(name)
            # Do not roll back worker if scheduler could still be new.
            if name == 'scheduler':
                break
    require(not STATE['rollback_failed'], 'ROLLBACK_NOT_CONFIRMED')
    verify_unchanged(before, configuration, candidate, restored=True)


def acceptance(name):
    # Readiness and authentication probes only: no authenticated dispatch or
    # maintenance request, no generation/claim RPC and no business command.
    script = """const component=__COMPONENT__;
const ready=await fetch('http://127.0.0.1:8080/readyz');
const data=await ready.json();
if(ready.status!==200||data.status!=='ready'||data.component!==component)throw Error('READY');
let unauthorized=null;
if(component==='worker'){
 const denied=await fetch('http://127.0.0.1:8080/functions/v1/worker/maintenance',{method:'POST'});
 unauthorized=denied.status;
 if(unauthorized!==401)throw Error('AUTH');
 await denied.body?.cancel();
}
console.log(JSON.stringify({component,ready:true,unauthorized_maintenance_status:unauthorized}));
""".replace('__COMPONENT__', json.dumps(name))
    raw = d.command(['exec', 'deployment/' + name, '-n', d.NAMESPACE, '--', 'deno', 'eval',
                     '--cached-only', script], timeout=12)
    result = json.loads(raw)
    require(result == {'component': name, 'ready': True,
                      'unauthorized_maintenance_status': 401 if name == 'worker' else None}, 'READINESS_ACCEPTANCE')
    return result


def cleanup_owned_client():
    path = base.journal_path()
    if not path.exists():
        return
    require(not path.is_symlink() and path.stat().st_size <= 4096
            and not path.stat().st_mode & 0o077, 'CLEANUP_JOURNAL_INVALID')
    value = json.loads(path.read_text())
    nonce = value.get('nonce')
    require(isinstance(nonce, str) and re.fullmatch('[a-f0-9]{8}', nonce), 'CLEANUP_JOURNAL_INVALID')
    name = 'assess-observer-' + os.environ['GITHUB_RUN_ID'] + '-' + os.environ['GITHUB_RUN_ATTEMPT'] + '-' + nonce
    expected = {'base': name, 'nonce': nonce, 'pod': name + '-pg', 'secret': name + '-db',
                'labels': {'app.kubernetes.io/managed-by': base.OWNER, 'tenderdesk.io/observation': nonce},
                'timeout': 1800}
    require(value == expected, 'CLEANUP_JOURNAL_INVALID')
    selected = []
    for kind in ('pod', 'secret'):
        resource_name = value[kind]
        current = d.get(kind, resource_name)
        if current is None:
            continue
        metadata = current.get('metadata', {})
        require(metadata.get('name') == resource_name and metadata.get('namespace') == d.NAMESPACE
                and all(metadata.get('labels', {}).get(k) == v for k, v in value['labels'].items())
                and isinstance(metadata.get('uid'), str) and metadata['uid']
                and isinstance(metadata.get('resourceVersion'), str) and metadata['resourceVersion'],
                'CLEANUP_FOREIGN_RESOURCE')
        selected.append((kind, resource_name, metadata))
    for kind, resource_name, metadata in selected:
        options = {'apiVersion': 'v1', 'kind': 'DeleteOptions',
                   'preconditions': {key: metadata[key] for key in ('uid', 'resourceVersion')}}
        if kind == 'pod':
            # Only this run's temporary psql/sleep client, never a workload.
            # A one-second graceful deletion fits the reserved cleanup window.
            options['gracePeriodSeconds'] = 1
        uri = '/api/v1/namespaces/' + d.NAMESPACE + '/' + kind + 's/' + resource_name
        d.command(['delete', '--raw', uri, '--filename=-'], payload=json.dumps(options), timeout=5)
        end = time.monotonic() + 5
        while True:
            current = d.get(kind, resource_name)
            if current is None:
                break
            require(current.get('metadata', {}).get('uid') == metadata['uid'], 'CLEANUP_RESOURCE_REPLACED')
            require(time.monotonic() < end, 'CLEANUP_NOT_CONFIRMED')
            time.sleep(0.2)
    path.unlink()


def cleanup():
    # The always() retry must not restart a fresh 15-second window after the
    # run's reserve has already elapsed. A missing journal needs no API call.
    if not base.journal_path().exists():
        return
    remaining = remaining_run_seconds()
    require(remaining > 0, 'CLEANUP_TOTAL_DEADLINE')
    signal.alarm(min(15, remaining))
    try:
        cleanup_owned_client()
    finally:
        signal.alarm(0)


def release():
    STATE.update(stage='preflight', patched=[], rolled_back=[], rollback_failed=[],
                 schema_applied=False, schema_retained_on_rollback=False)
    revision = verify_checkout()
    receipt, candidate = qualification.publication()
    STATE['stage'] = 'registry_identity'
    registry = qualification.registry_identity(candidate, receipt)
    STATE['stage'] = 'cluster_preflight'
    d.probe.validate_cluster()
    original = {name: u.deployment(name) for name in BASELINES}
    require(all(base.image_of(value) == BASELINES[name] for name, value in original.items()), 'IMAGE_BASELINE_CHANGED')
    resources = base.worker_resource_envelope(original['worker'])
    verify_runtime_contract(original)
    before = runtime.workload_snapshot()
    configuration = runtime.retained_configuration()
    database = base.inventory.observer.Client(1800)
    database.labels['app.kubernetes.io/managed-by'] = base.OWNER
    base.save_client(database)
    touched = []
    schema = load_module('dispatch_release_schema', 'proposal-dispatch-schema.py')
    sql_sha = receipt['source']['source_entries']['backend/scripts/runtime/dispatcher.sql']['sha256']
    try:
        STATE['stage'] = 'schema_apply'
        database.prepare()
        verify_unchanged(before, configuration, candidate)
        schema_receipt = schema.apply(database, sql_sha)
        STATE['schema_applied'] = True
        for name in TARGETS:
            STATE['stage'] = name + '_rollout'
            verify_unchanged(before, configuration, candidate)
            touched.append(name)  # Includes an ambiguous transport outcome.
            runtime.patch_runtime(name, candidate, original[name], BASELINES[name])
            STATE['patched'].append(name)
            d.wait_deployments([name], seconds=25)
            base.wait_drain(name, candidate, timeout=25)
        STATE['stage'] = 'readiness_and_authority_acceptance'
        observed = [acceptance(name) for name in TARGETS]
        schema_after = schema.verify(database, sql_sha)
        verify_unchanged(before, configuration, candidate, final=True)
        STATE['stage'] = 'passed'
        return {'release': 'proposal-dispatch-v2', 'status': 'passed', 'source_revision': revision,
                'artifact_source_revision': receipt['source_revision'], 'image': candidate,
                'image_id': receipt['image']['Id'], 'qualification_sha256': qualification.RECEIPT_SHA256,
                'registry_identity': registry,
                'deployment_targets': list(TARGETS), 'retained_images': {k: v for k, v in BASELINES.items() if k not in TARGETS},
                'schema': schema_receipt, 'schema_readback': schema_after, 'readiness': observed,
                'worker_resource_envelope': resources, 'configuration_preserved': True,
                'customer_processing_retried': False, 'providers_activated': False,
                'native_scope': 'worker_and_scheduler_only', 'customer_completion_verified': False}
    except (Exception, DeadlineExceeded):
        STATE['failure_stage'] = STATE['stage']
        signal.alarm(25)
        try:
            if touched:
                rollback(touched, original, candidate, before, configuration)
        finally:
            signal.alarm(0)
        raise
    finally:
        cleanup()


def main():
    signal.signal(signal.SIGALRM, deadline)
    try:
        if sys.argv[1:] == ['--cleanup']:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                cleanup()
            print('{"dispatch_cleanup":"confirmed"}')
            return 0
        require(not sys.argv[1:], 'ARGUMENTS')
        signal.alarm(work_budget())
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                result = release()
        finally:
            signal.alarm(0)
        print(json.dumps(result), flush=True)
        return 0
    except (Exception, DeadlineExceeded) as error:
        code = str(error) if re.fullmatch('[A-Z][A-Z0-9_]{0,99}', str(error)) else 'DISPATCH_RELEASE_FAILED'
        print(json.dumps({'release': 'proposal-dispatch-v2', 'status': 'failed', 'code': code, 'state': STATE}), flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
