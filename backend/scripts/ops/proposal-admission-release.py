#!/usr/bin/env python3
"""Apply one ledger-bound admission-wake migration without runtime changes.

No business command, model request, provider configuration, image patch or DDL
rollback is issued here. An uncertain commit is reconciled once by a read-only
ledger check; it is never followed by another apply within the invocation.
"""
from contextlib import redirect_stderr, redirect_stdout
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


dispatch = module('admission_release_dispatch', 'proposal-dispatch-release.py')
schema = module('admission_release_schema', 'proposal-admission-schema.py')
qualification = module('admission_release_qualification', 'proposal-latency-runtime.py')
CURRENT_IMAGE = 'registry.digitalocean.com/tenderdesk-a6093a76/runtime@sha256:03c68b58ebe05d2d35ee5345df3bad8d9c7a2bc2989bdf78a83d322e1b145a3d'
STATE = {}


def require(value, code):
    if not value:
        raise RuntimeError('PROPOSAL_ADMISSION_RELEASE_' + code)


def fixed_code(error):
    value = str(error)
    return value if re.fullmatch('[A-Z][A-Z0-9_]{0,119}', value) else 'PROPOSAL_ADMISSION_RELEASE_FAILED'


def work_budget():
    # A work-alarm interruption must still enter the uncertain-commit readback:
    # 20 seconds readback, 15 cleanup and 10 seconds for exit/runner overhead.
    budget = min(110, dispatch.remaining_run_seconds() - 45)
    require(budget >= 45, 'WORK_BUDGET_EXHAUSTED')
    return budget


def verify_unchanged(before, configuration):
    require(dispatch.runtime.workload_snapshot() == before, 'WORKLOAD_CHANGED')
    require(dispatch.runtime.retained_configuration() == configuration, 'PRIVATE_CONFIGURATION_CHANGED')


def release(*, inspect_only=False):
    STATE.clear()
    STATE.update(stage='preflight', mode='inspect' if inspect_only else 'apply', apply_attempted=False, apply_acknowledged=False,
                 schema_confirmed=False, reconciled_after_unknown=False, cleanup_verified=False)
    try:
        require(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'WORKFLOW_REPLAY_REFUSED')
        revision = dispatch.verify_checkout()
        artifact, candidate = qualification.publication()
        require(candidate == CURRENT_IMAGE, 'QUALIFIED_IMAGE_CHANGED')
        require(artifact['poll_migration'] == {'path': str(schema.parent.SOURCE.relative_to(schema.ROOT)),
            'sha256': schema.PARENT_SQL}, 'POLL_QUALIFICATION_CHANGED')
        require(artifact['source']['source_entries']['backend/scripts/runtime/dispatcher.sql']['sha256']
            == schema.retry.PARENT_SQL, 'OUTBOX_SOURCE_CHANGED')
        dispatch.d.probe.validate_cluster()
        expected = {**dispatch.BASELINES, 'worker': candidate, 'scheduler': candidate}
        original = {name: dispatch.u.deployment(name) for name in expected}
        require(all(dispatch.base.image_of(value) == expected[name] for name, value in original.items()),
                'RUNTIME_CHANGED')
        dispatch.verify_runtime_contract(original)
        before = dispatch.runtime.workload_snapshot()
        configuration = dispatch.runtime.retained_configuration()
        database = dispatch.base.inventory.observer.Client(1800)
        database.labels['app.kubernetes.io/managed-by'] = dispatch.base.OWNER
        dispatch.base.save_client(database)
        STATE['stage'] = 'owned_database_client'
        database.prepare()
        verify_unchanged(before, configuration)
        readback = None
        if inspect_only:
            STATE['stage'] = 'read_only_schema_inspection'
            readback = schema.verify(database, allow_parent=True)
            applied = readback
            STATE.update(schema_confirmed=True, schema_readback=readback)
        else:
            STATE.update(stage='atomic_schema_apply', apply_attempted=True)
            try:
                applied = schema.apply(database)
                STATE['apply_acknowledged'] = True
            except (Exception, dispatch.DeadlineExceeded) as error:
                # A failed transport can hide COMMIT. Read exactly the new ledger,
                # never apply again or reverse DDL based on an absent response.
                STATE.update(apply_error=fixed_code(error), stage='read_only_commit_reconciliation')
                remaining = dispatch.remaining_run_seconds()
                if remaining < 40:
                    raise
                signal.alarm(min(20, remaining - 20))
                try:
                    readback = schema.verify(database, allow_parent=True)
                    STATE['uncertain_commit_readback'] = readback
                    if not readback['applied']:
                        raise error
                    applied = readback
                except (Exception, dispatch.DeadlineExceeded) as reconciliation_error:
                    STATE['reconciliation_error'] = fixed_code(reconciliation_error)
                    raise error
                STATE['reconciled_after_unknown'] = True
        STATE['stage'] = 'schema_readback'
        if readback is None:
            readback = schema.verify(database)
        STATE['schema_confirmed'] = True
        STATE['stage'] = 'retained_runtime_verification'
        verify_unchanged(before, configuration)
        result = {'release': 'proposal-admission-wake', 'status': 'passed',
                  'mode': STATE['mode'], 'apply_attempted': STATE['apply_attempted'],
                  'source_revision': revision, 'schema': applied, 'schema_readback': readback,
                  'retained_images': expected, 'artifact_source_revision': artifact['source_revision'],
                  'qualification_sha256': qualification.RECEIPT_SHA256,
                  'configuration_preserved': True, 'images_changed': False,
                  'customer_processing_requested': False, 'providers_activated': False,
                  'business_commands_sent': 0, 'apply_acknowledged': STATE['apply_acknowledged'],
                  'reconciled_after_unknown': STATE['reconciled_after_unknown']}
    except (Exception, dispatch.DeadlineExceeded):
        STATE['failure_stage'] = STATE['stage']
        raise
    finally:
        signal.alarm(0)
        try:
            dispatch.cleanup()
            STATE['cleanup_verified'] = True
        except (Exception, dispatch.DeadlineExceeded) as error:
            STATE['cleanup_failure'] = fixed_code(error)
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
            print('{"proposal_admission_cleanup":"confirmed"}', flush=True)
            return 0
        require(sys.argv[1:] in (['--inspect'], ['--apply']), 'EXPLICIT_MODE_REQUIRED')
        signal.alarm(work_budget())
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            result = release(inspect_only=sys.argv[1:] == ['--inspect'])
        print(json.dumps(result), flush=True)
        return 0
    except (Exception, dispatch.DeadlineExceeded) as error:
        print(json.dumps({'release': 'proposal-admission-wake', 'status': 'failed',
                          'code': fixed_code(error), 'state': STATE}), flush=True)
        return 1
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    sys.exit(main())
