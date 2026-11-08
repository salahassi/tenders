#!/usr/bin/env python3
"""One authorized proposal/settings command, or bounded read-only observations.

The business request keeps its database deadline across runner invocations.
Exact request intent is encrypted and read back before one authenticated send.
This coordinator never retries a sent command or changes deployment/provider state.
"""
from contextlib import redirect_stderr, redirect_stdout
import argparse
import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import signal
import sys
import time
import urllib.request

HERE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


release = module('trial_runtime_release', 'proposal-dispatch-release.py')
auth = module('trial_owner_auth', 'proposal-export-acceptance.py')
history = module('trial_private_intent', 'proposal-current-request.py')
request = module('trial_one_request', 'proposal-trial-request.py')
observe = module('trial_one_observation', 'proposal-trial-observe.py')
download = module('trial_existing_download', 'proposal-trial-download.py')
settings_repair = module('trial_settings_repair', 'proposal-settings-repair.py')
runtime_snapshot = module('trial_runtime_snapshot', 'proposal-runtime-snapshot.py')
commercial_inspection = module('trial_commercial_inspection', 'proposal-commercial-inspection.py')
d = release.d
transfer = auth.transfer
BUCKET = auth.BUCKET
STAGE = 'initial'
PRIVATE_VALUES = set()
PUBLIC_STATE = {}


class InspectionComplete(Exception):
    pass


def require(value, code):
    if not value:
        raise RuntimeError('PROPOSAL_TRIAL_' + code)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()


def fixed_code(error):
    value = getattr(error, 'code', None) or str(error)
    return value if isinstance(value, str) and re.fullmatch('[A-Z][A-Z0-9_]{0,119}', value) else 'PROPOSAL_TRIAL_FAILED'


def work_budget():
    # Reserve session logout, scoped pod cleanup and encrypted report readback.
    budget = min(100, release.remaining_run_seconds() - 70)
    require(budget >= 40, 'WORK_BUDGET_EXHAUSTED')
    return budget


def bind_deadline():
    repository, run = os.environ['GITHUB_REPOSITORY'], os.environ['GITHUB_RUN_ID']
    require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository)
            and re.fullmatch(r'[0-9]{1,20}', run), 'RUN_IDENTITY')
    endpoint = 'https://api.github.com/repos/' + repository + '/actions/runs/' + run
    req = urllib.request.Request(endpoint, headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                                                   'Accept': 'application/vnd.github+json'})
    with urllib.request.build_opener(auth.smoke.NoRedirect).open(req, timeout=10) as response:
        raw = response.read(1048577)
    require(len(raw) <= 1048576, 'RUN_METADATA_SIZE')
    value = json.loads(raw)
    require(str(value['id']) == run and value['repository']['full_name'] == repository
            and value['head_sha'] == os.environ['GITHUB_SHA'], 'RUN_METADATA_IDENTITY')
    created = datetime.datetime.fromisoformat(value['created_at'].replace('Z', '+00:00')).timestamp()
    require(created <= time.time() + 5 and created + 170 - time.time() >= 85, 'RUN_BUDGET')
    with open(os.environ['GITHUB_ENV'], 'a') as output:
        output.write('TENDERDESK_RUN_DEADLINE_EPOCH=' + str(int(created) + 170) + '\n')


def verify_runtime(database=None):
    release.verify_checkout()
    d.probe.validate_cluster()
    qualification = module('trial_reference_qualification', 'proposal-reference-runtime.py')
    receipt, image = qualification.publication()
    expected = {**release.BASELINES, 'worker': image, 'scheduler': image}
    original = {name: release.u.deployment(name) for name in expected}
    require(all(release.base.image_of(value) == expected[name] for name, value in original.items()),
            'RUNTIME_CHANGED')
    release.verify_runtime_contract(original)
    if database:
        schema = module('trial_runtime_schema', 'proposal-poll-schema.py')
        require(receipt['source']['source_entries']['backend/scripts/runtime/dispatcher.sql']['sha256'] == schema.retry.PARENT_SQL,
                'DISPATCH_SOURCE_CHANGED')
        require(receipt['poll_migration'] == {'path': str(schema.latency.SOURCE.relative_to(schema.ROOT)),
            'sha256': schema.latency.source_sha256()}, 'POLL_SOURCE_CHANGED')
        require(receipt['pending_poll_migration'] == {'path': str(schema.SOURCE.relative_to(schema.ROOT)),
            'sha256': schema.source_sha256()}, 'PENDING_POLL_SOURCE_CHANGED')
        schema.verify(database)


def session_path():
    return Path(os.environ['DOKS_WORKDIR']) / 'proposal-trial-session.json'


def open_session(actor, workspace):
    core = d.decode_secret(d.get('secret', 'tenderdesk-core'))
    public = auth.smoke.javascript_config(d.get('configmap', 'frontend-config')['data']['runtime-config.js'].encode())
    require(public['publishableKey'] == core['ANON_KEY'], 'AUTH_CONFIGURATION')
    config = auth.smoke.Config(public['appOrigin'], core['ANON_KEY'], core['SERVICE_KEY'], core['JWT_SECRET'])
    client = auth.smoke.Client(config)
    session = auth.genuine_session(client, config, actor, workspace)
    PRIVATE_VALUES.update(value for value in (core['SERVICE_KEY'], core['JWT_SECRET'],
        session.get('access_token'), session.get('refresh_token')) if isinstance(value, str) and value)
    transfer.write_private(session_path(), encoded({'version': 1, 'origin': config.origin,
        'anon_key': config.anon_key, 'access_token': session['access_token']}))
    auth.verify_session(client, config, session, actor, workspace)
    return client, config, session


def close_session():
    path = session_path()
    if not path.exists():
        return
    value = json.loads(transfer.read_private(path))
    require(set(value) == {'version', 'origin', 'anon_key', 'access_token'} and value['version'] == 1,
            'SESSION_JOURNAL')
    public = auth.smoke.javascript_config(d.get('configmap', 'frontend-config')['data']['runtime-config.js'].encode())
    require(value['origin'] == public['appOrigin'] and value['anon_key'] == public['publishableKey']
            and isinstance(value['access_token'], str) and value['access_token'], 'SESSION_JOURNAL')
    config = auth.smoke.Config(value['origin'], value['anon_key'], '', '')
    auth.smoke.expect(auth.smoke.Client(config).request('/auth/v1/logout?scope=local',
        token=value['access_token'], method='POST'), {200, 204}, 'PROPOSAL_TRIAL_LOGOUT_FAILED')
    path.unlink()


def cleanup():
    failures = []
    if session_path().exists():
        try:
            signal.alarm(min(20, max(1, release.remaining_run_seconds())))
            close_session()
        except (Exception, release.DeadlineExceeded) as error:
            failures.append(fixed_code(error))
        finally:
            signal.alarm(0)
    try:
        release.cleanup()
    except (Exception, release.DeadlineExceeded) as error:
        failures.append(fixed_code(error))
    require(not failures, 'CLEANUP_NOT_CONFIRMED')


def private_input(name, digest):
    require(re.fullmatch(r'(requests|diagnostics)/[A-Za-z0-9][A-Za-z0-9._/-]{0,160}\.bundle', name)
            and re.fullmatch('[a-f0-9]{64}', digest), 'INPUT_REFERENCE')
    transfer.identity(BUCKET, name)
    path = Path(os.environ['DOKS_WORKDIR']) / 'proposal-trial-input.json'
    transfer.download(os.environ['DIGITALOCEAN_ACCESS_TOKEN'], BUCKET, name, path, digest)
    value = json.loads(transfer.read_private(path))
    require(isinstance(value, dict), 'INPUT_INVALID')
    return value


def run(args):
    global STAGE
    os.environ['TENDERDESK_TRANSFER_HTTP_TIMEOUT_SECONDS'] = '10'
    expected_operation = getattr(args, 'expected_operation', 'any')
    require(expected_operation in {'any', 'generation.retry', 'proposal.generate'}
            and (expected_operation == 'any' or args.mode == 'start'), 'EXPECTED_OPERATION_INVALID')
    report = {'version': 1, 'kind': 'proposal_trial_report', 'mode': args.mode,
              'source_revision': os.environ['GITHUB_SHA'], 'request_sent': False, 'send_attempted': False,
              'intent_persisted': False, 'cleanup_verified': False, 'expected_operation': expected_operation}
    require(args.mode not in {'start', 'settings-apply'}
            or (args.activate and os.environ.get('RUN_PROPOSAL_TRIAL') == 'true'),
            'ACTIVATION_REQUIRED')
    require(os.environ.get('GITHUB_RUN_ATTEMPT') == '1', 'WORKFLOW_REPLAY_REFUSED')
    signal.alarm(work_budget())
    try:
        STAGE = 'runtime_preflight'
        verify_runtime()
        STAGE = 'private_input'
        incoming = private_input(args.input_object, args.input_sha256)
        STAGE = 'owned_database_client'
        database = release.base.inventory.observer.Client(1800)
        database.labels['app.kubernetes.io/managed-by'] = release.base.OWNER
        release.base.save_client(database)
        database.prepare()
        verify_runtime(database)
        if args.mode == 'settings-plan':
            STAGE = 'read_only_settings_plan'
            prepared = settings_repair.plan(database, incoming)
            settings_repair.validate_prepared(prepared)
            report.update(selection=prepared['proof']['selection'], prepared=prepared)
            raise InspectionComplete()
        if args.mode in {'settings-apply', 'settings-observe'}:
            expected_mode = 'settings-plan' if args.mode == 'settings-apply' else 'settings-apply'
            require(incoming.get('version') == 1 and incoming.get('kind') == 'proposal_trial_report'
                    and incoming.get('mode') == expected_mode, 'SETTINGS_REPORT_INPUT')
            prepared = incoming.get('prepared')
            settings_repair.validate_prepared(prepared)
            require(incoming.get('selection') == prepared['proof']['selection'], 'SETTINGS_SELECTION_CHANGED')
            report.update(selection=prepared['proof']['selection'], prepared=prepared)
            if args.mode == 'settings-observe':
                require(incoming.get('intent_persisted') is True, 'SETTINGS_INTENT_MISSING')
            else:
                STAGE = 'settings_recheck_before_auth'
                settings_repair.recheck(database, prepared)
                STAGE = 'genuine_settings_owner_session'
                client, config, session = open_session(prepared['proof']['actor_id'],
                                                       prepared['proof']['selection']['workspace_id'])

                def persist_settings(value):
                    global STAGE
                    STAGE = 'persist_exact_settings_request'
                    settings_repair.recheck(database, value)
                    verify_runtime(database)
                    digest = history.upload_once(os.environ['DIGITALOCEAN_ACCESS_TOKEN'],
                        value['prepared_object'], encoded(value))
                    report['intent_persisted'] = True
                    return digest

                def before_settings_send():
                    global STAGE
                    fresh = settings_repair.recheck(database, prepared)
                    STAGE = 'single_authenticated_settings_send'
                    report['send_attempted'] = True
                    report['request_sent'] = None
                    return fresh

                try:
                    acknowledgement = settings_repair.send(client, session, prepared,
                        persist_settings, before_send=before_settings_send)
                    report.update(request_sent=acknowledgement['sent'], acknowledgement=acknowledgement)
                except Exception as error:
                    if not report['send_attempted']:
                        raise
                    report['acknowledgement'] = {'sent': None, 'unknown': True,
                        'error_code': fixed_code(error)}
            STAGE = 'authoritative_settings_readback'
            report['settings_readback'] = settings_repair.verify_result(database, prepared)
            raise InspectionComplete()
        if args.mode == 'inspect':
            STAGE = 'read_only_admission_inspection'
            report.update(selection=incoming, proof=request.inspect(database, incoming),
                admission_diagnostic=request.diagnostic(database, incoming))
            report['commercial_snapshot'] = commercial_inspection.capture(database, incoming, request)
            report['runtime_snapshot'] = runtime_snapshot.capture(d, release.remaining_run_seconds)
            raise InspectionComplete()
        if args.mode == 'start':
            STAGE = 'fresh_target_inspection'
            proof = request.inspect(database, incoming)
            report.update(selection=incoming, proof=proof)
            prepared = request.prepare(proof)
            # Restrict the permitted command before authentication, durable
            # intent or transmission. Observing an existing request sends none.
            require(expected_operation == 'any' or prepared['mode'] == 'observe_existing'
                    or prepared.get('operation') == expected_operation, 'EXPECTED_OPERATION_MISMATCH')
            report.update(selection=incoming, prepared=prepared)
            if prepared['mode'] == 'observe_existing':
                target = prepared['target']
            else:
                STAGE = 'genuine_owner_session'
                client, config, session = open_session(proof['actor_id'], incoming['workspace_id'])

                def persist(value):
                    global STAGE
                    STAGE = 'persist_exact_request'
                    request.recheck(database, incoming, value)
                    verify_runtime(database)
                    digest = history.upload_once(os.environ['DIGITALOCEAN_ACCESS_TOKEN'],
                        value['prepared_object'], encoded(value))
                    report['intent_persisted'] = True
                    return digest

                def before_send():
                    global STAGE
                    request.recheck(database, incoming, prepared)
                    STAGE = 'single_authenticated_send'
                    # The network may be interrupted after transmission. Once
                    # reached, a missing acknowledgement means unknown, not safe
                    # to submit another command.
                    report['send_attempted'] = True
                    report['request_sent'] = None

                try:
                    acknowledgement = request.send(client, session, prepared, persist, before_send=before_send)
                    report.update(request_sent=acknowledgement['sent'], acknowledgement=acknowledgement)
                except Exception as error:
                    if not report['send_attempted']:
                        raise
                    report['acknowledgement'] = {'sent': None, 'unknown': True,
                        'error_code': fixed_code(error)}
                STAGE = 'authoritative_issuance_binding'
                target = request.verify_result(database, prepared)
            report['target'] = target
        else:
            require(incoming.get('version') == 1 and incoming.get('kind') == 'proposal_trial_report', 'REPORT_INPUT')
            request.validate_selection(incoming.get('selection'))
            target = incoming.get('target')
            if target is None and incoming.get('intent_persisted') and incoming.get('prepared'):
                target = request.verify_result(database, incoming['prepared'])
            require(isinstance(target, dict), 'TARGET_MISSING')
            report.update(selection=incoming['selection'], target=target)
            require(target['workspace_id'] == incoming['selection']['workspace_id']
                    and target['opportunity_id'] == incoming['selection']['opportunity_id'], 'TARGET_CHANGED')
        STAGE = 'read_only_observation'
        previous = incoming.get('observation') if args.mode != 'start' else None
        samples = []
        end = time.monotonic() + (55 if args.mode == 'observe' else 0)
        while True:
            sample = observe.sample(database, target, previous)
            samples.append(sample)
            report.update(observation=sample, samples=samples)
            previous = sample
            if sample['outcome'] != 'active' or time.monotonic() + 15 > end:
                break
            # Original database deadline remains authoritative. Each runner
            # only reads the same exact request; it cannot extend its clock.
            time.sleep(15)
        if args.mode == 'download':
            require(sample['whole_package_issued'] is True, 'PACKAGE_NOT_ISSUED')
            STAGE = 'genuine_download_session'
            client, config, session = open_session(target['actor_id'], target['workspace_id'])
            STAGE = 'authenticated_existing_files'
            report['download'] = download.download(client, config, session, sample)
        elif args.mode == 'observe':
            report['runtime_snapshot'] = runtime_snapshot.capture(d, release.remaining_run_seconds)
    except InspectionComplete:
        pass
    except (Exception, release.DeadlineExceeded) as error:
        report.update(failure_code=fixed_code(error), failure_stage=STAGE)
    finally:
        signal.alarm(0)
        try:
            cleanup()
            report['cleanup_verified'] = True
        except (Exception, release.DeadlineExceeded) as error:
            report.update(cleanup_failure=fixed_code(error))
    STAGE = 'private_report_persistence'
    PUBLIC_STATE.clear()
    PUBLIC_STATE.update({key: report[key] for key in ('request_sent', 'send_attempted',
        'intent_persisted', 'cleanup_verified', 'failure_code', 'failure_stage') if key in report})
    remaining = release.remaining_run_seconds()
    require(remaining > 5, 'REPORT_BUDGET_EXHAUSTED')
    signal.alarm(min(25, remaining - 3))
    try:
        path = Path(os.environ['DOKS_WORKDIR']) / 'proposal-trial-report.json'
        if args.mode == 'inspect':
            commercial_inspection.fit_report(report)
        payload = encoded(report)
        require(not any(secret.encode() in payload for secret in PRIVATE_VALUES), 'REPORT_CREDENTIAL_REJECTED')
        transfer.write_private(path, payload)
        object_name = 'diagnostics/proposal-trial-' + os.environ['GITHUB_RUN_ID'] + '.bundle'
        digest = transfer.upload(os.environ['DIGITALOCEAN_ACCESS_TOKEN'], BUCKET, object_name, path)
    finally:
        signal.alarm(0)
    summary = {'proposal_trial': 'captured', 'mode': args.mode, 'report_object': object_name,
               'report_sha256': digest, 'request_sent': report['request_sent'],
               'send_attempted': report['send_attempted'],
               'intent_persisted': report['intent_persisted'], 'cleanup_verified': report['cleanup_verified']}
    if 'observation' in report:
        summary['observation'] = observe.public_receipt(report['observation'])
    if 'download' in report:
        summary['files_downloaded'] = len(report['download']['artifacts'])
    for field in ('failure_code', 'failure_stage', 'cleanup_failure'):
        if field in report:
            summary[field] = report[field]
    return summary


def main():
    signal.signal(signal.SIGALRM, release.deadline)
    if sys.argv[1:] == ['--bind-deadline']:
        bind_deadline()
        print('Proposal trial deadline includes queue and setup time.')
        return 0
    if sys.argv[1:] == ['--cleanup']:
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            cleanup()
        print('{"proposal_trial_cleanup":"confirmed"}')
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', required=True, choices=('start', 'inspect', 'observe', 'download',
        'settings-plan', 'settings-apply', 'settings-observe'))
    parser.add_argument('--input-object', required=True)
    parser.add_argument('--input-sha256', required=True)
    parser.add_argument('--activate', action='store_true')
    parser.add_argument('--expected-operation', choices=('any', 'generation.retry', 'proposal.generate'), default='any')
    args = parser.parse_args()
    try:
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            result = run(args)
        print(json.dumps(result), flush=True)
        return 0 if result['cleanup_verified'] and not result.get('failure_code') else 1
    except (Exception, release.DeadlineExceeded) as error:
        print(json.dumps({'proposal_trial': 'failed', 'code': fixed_code(error), 'stage': STAGE,
            'state': PUBLIC_STATE}), flush=True)
        return 1


if __name__ == '__main__':
    sys.exit(main())
