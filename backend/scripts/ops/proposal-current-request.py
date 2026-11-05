#!/usr/bin/env python3
"""Activate one actual UI current-contract request, preserving its private evidence.

Only the reviewed production-concurrency GitHub workflow may activate this helper.
The browser's exact batch is encrypted and read back before permission to send it.
An existing prepared object is a stop condition, including after an unknown result.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime
import hashlib
import hmac
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import subprocess
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('current_request_auth', HERE / 'proposal-export-acceptance.py')
auth = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = auth
SPEC.loader.exec_module(auth)
ISSUANCE_SPEC = importlib.util.spec_from_file_location('current_request_issuance', HERE / 'proposal-current-issuance.py')
issuance_observer = importlib.util.module_from_spec(ISSUANCE_SPEC)
sys.modules[ISSUANCE_SPEC.name] = issuance_observer
ISSUANCE_SPEC.loader.exec_module(issuance_observer)
access, observer, transfer, runtime, smoke = auth.access, auth.observer, auth.transfer, auth.resume, auth.smoke
BUCKET = auth.BUCKET
MAX_LINE = 64 * 1024
CHILD_SECONDS = 900
REASON = 'User explicitly requested a current proposal request; preserve the original saved work.'
HISTORY = {'frozen_plan', 'completed_steps', 'graph_threads', 'graph_results', 'phase_pins', 'graph_budgets',
           'graph_checkpoints', 'graph_writes', 'paid_usage', 'model_attempts', 'unknown_usage'}
GUARDS = {'database', 'selected_target', 'unique_active_owner', 'no_restore', 'latest_selected', 'legacy_blocked',
          'no_active_version', 'selected_opportunity', 'same_language', 'sources_match', 'no_active_predecessor_work'}


class CurrentRequestError(Exception):
    pass


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None


def uuid_value(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def revision(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def validate_selection(value):
    if (not isinstance(value, dict) or set(value) != {'version', 'workspace_id', 'opportunity_id', 'plan_id'}
            or type(value['version']) is not int or value['version'] != 1
            or any(not uuid_value(value[k]) for k in ('workspace_id', 'opportunity_id', 'plan_id'))
            or value['workspace_id'] != access.WORKSPACE):
        raise CurrentRequestError('CURRENT_REQUEST_SELECTION_INVALID')
    return value


def inspection_sql(selection):
    validate_selection(selection)
    return (HERE / 'proposal-current-request-inspect.sql').read_text().replace('__WORKSPACE__', selection['workspace_id']).replace(
        '__OPPORTUNITY__', selection['opportunity_id']).replace('__PLAN__', selection['plan_id'])


def validate_proof(proof, selection, *, before=False):
    if (not isinstance(proof, dict) or proof.get('version') != 1 or proof.get('kind') != 'current_proposal_read_only_proof'
            or proof.get('selection') != selection or not isinstance(proof.get('guards'), dict)
            or set(proof['guards']) != GUARDS or not isinstance(proof.get('protected_history'), dict)
            or set(proof['protected_history']) != HISTORY):
        raise CurrentRequestError('CURRENT_REQUEST_PROOF_INVALID')
    for value in proof['protected_history'].values():
        if not isinstance(value, dict) or set(value) != {'count', 'sha256'} or not revision(value['count']) or not digest(value['sha256']):
            raise CurrentRequestError('CURRENT_REQUEST_PROOF_INVALID')
    if before:
        for key in sorted(GUARDS):
            if proof['guards'][key] is not True:
                raise CurrentRequestError('CURRENT_REQUEST_PRECONDITION_' + key.upper())
        if (not uuid_value(proof.get('actor_id')) or not uuid_value(proof.get('proposal_id'))
                or any(not revision(proof.get(k)) for k in ('expected_plan_revision', 'expected_opportunity_revision', 'expected_proposal_revision'))
                or any(not digest(proof.get(k)) for k in ('preserved_input_hash', 'source_manifest_sha256', 'prospective_snapshot_sha256'))
                or not revision(proof.get('proposal_plan_count'))):
            raise CurrentRequestError('CURRENT_REQUEST_PROOF_INVALID')
    return proof


def inspect(database, selection):
    raw = access.d.sql(database.pod, inspection_sql(selection))
    if len(raw.encode()) > 256 * 1024:
        raise CurrentRequestError('CURRENT_REQUEST_PROOF_TOO_LARGE')
    return validate_proof(json.loads(raw), selection)


def observe_issuance(database, selection, before, report, expected_runtime_image):
    target = {key: selection[key] for key in ('workspace_id', 'opportunity_id')}
    target.update(proposal_id=before['proposal_id'], actor_id=before['actor_id'],
                  plan_id=report['successor_plan_id'], issuance_request_id=report['issuance_request_id'])
    sql = issuance_observer.observation_sql(target)

    def read_sample():
        # The shared migration SQL helper has a 300-second migration timeout;
        # this read-only observer instead uses a 45-second transport bound.
        raw = access.d.command(['exec', '-i', database.pod, '-n', access.d.NAMESPACE, '--', 'psql', '-X',
            '--quiet', '--no-align', '--tuples-only', '--set=ON_ERROR_STOP=1',
            '--dbname=' + access.d.DATABASE, '--file=-'], payload=sql, timeout=45)
        if len(raw.encode()) > 256 * 1024:
            raise issuance_observer.IssuanceObservationError('CURRENT_ISSUANCE_OBSERVATION_TOO_LARGE')
        return json.loads(raw)

    return issuance_observer.observe(target, read_sample, lambda: runtime.verify_runtime(expected_runtime_image))


def prepared_object(selection):
    # A runtime upgrade or JSON serialization change must never create a second
    # authorization for the same predecessor after an uncertain send.
    validate_selection(selection)
    identity = hashlib.sha256((':'.join(selection[key] for key in
        ('workspace_id', 'opportunity_id', 'plan_id'))).encode()).hexdigest()
    return 'diagnostics/proposal-current-request-' + identity + '.prepared.bundle'


def require_absent(token, object_name):
    # The workflow's shared production mutex spans both HEAD and later PUT.
    with transfer.temporary_key(token, BUCKET, 'read') as key:
        try:
            transfer.spaces(key, BUCKET, object_name, 'HEAD')
        except transfer.TransferError as error:
            if str(error) != 'SPACES_HTTP_404':
                raise
        else:
            raise CurrentRequestError('CURRENT_REQUEST_PREPARED_ALREADY_EXISTS')


def upload_once(token, object_name, plaintext):
    """HEAD/PUT/GET under the production mutex; never replace an earlier intent."""
    ciphertext = transfer.encrypt(plaintext, transfer.database_password(token), BUCKET, object_name)
    with transfer.temporary_key(token, BUCKET, 'readwrite') as key:
        try:
            transfer.spaces(key, BUCKET, object_name, 'HEAD')
        except transfer.TransferError as error:
            if str(error) != 'SPACES_HTTP_404':
                raise
        else:
            raise CurrentRequestError('CURRENT_REQUEST_PREPARED_ALREADY_EXISTS')
        transfer.spaces(key, BUCKET, object_name, 'PUT', ciphertext,
                        extra_headers={'x-amz-acl': 'private', 'content-type': 'application/octet-stream'})
        persisted = transfer.spaces(key, BUCKET, object_name, 'GET')
        if not hmac.compare_digest(ciphertext, persisted):
            raise CurrentRequestError('CURRENT_REQUEST_PERSISTENCE_READBACK_FAILED')
    return hashlib.sha256(plaintext).hexdigest()


def validate_prepared(request, selection, proof):
    if (not isinstance(request, dict) or set(request) != {'idempotency_key', 'body', 'server_owned_details', 'body_sha256'}
            or not uuid_value(request['idempotency_key']) or not digest(request['body_sha256'])):
        raise CurrentRequestError('CURRENT_REQUEST_PREPARED_INVALID')
    details = {'plan_id': selection['plan_id'], 'expected_plan_revision': proof['expected_plan_revision'],
               'preserved_input_hash': proof['preserved_input_hash'], 'cancel_required': True,
               'opportunity_id': selection['opportunity_id'], 'expected_opportunity_revision': proof['expected_opportunity_revision'],
               'proposal_id': proof['proposal_id'], 'expected_proposal_revision': proof['expected_proposal_revision'],
               'base_version_id': None, 'next_operation': 'proposal.generate'}
    body = {'commands': [
        {'operation': 'generation.cancel', 'input': {'id': selection['plan_id'],
         'expected_revision': proof['expected_plan_revision'], 'reason': REASON}},
        {'operation': 'proposal.generate', 'input': {'id': selection['opportunity_id'],
         'expected_revision': proof['expected_opportunity_revision']}}]}
    if (request['server_owned_details'] != details or request['body'] != body
            or hashlib.sha256(encoded(request['body'])).hexdigest() != request['body_sha256']):
        raise CurrentRequestError('CURRENT_REQUEST_PREPARED_MISMATCH')
    return request


def no_secrets(value, secrets):
    raw = encoded(value)
    if any(secret and str(secret).encode() in raw for secret in secrets):
        raise CurrentRequestError('CURRENT_REQUEST_SECRET_IN_REPORT')


def persist_request(request, selection, before, context, secrets):
    validate_prepared(request, selection, before)
    envelope = {'version': 1, 'kind': 'prepared_current_proposal_request', **context,
                'selection': selection, 'actor_id': before['actor_id'],
                'before_sha256': hashlib.sha256(encoded(before)).hexdigest(), 'request': request}
    no_secrets(envelope, secrets)
    return upload_once(os.environ['DIGITALOCEAN_ACCESS_TOKEN'], context['prepared_object'], encoded(envelope))


def recheck_before_send(database, selection, before, expected_runtime_image):
    fresh = inspect(database, selection)
    validate_proof(fresh, selection, before=True)
    keys = ('actor_id', 'proposal_id', 'expected_plan_revision', 'expected_opportunity_revision',
            'expected_proposal_revision', 'preserved_input_hash', 'proposal_plan_count',
            'source_manifest_sha256', 'prospective_snapshot_sha256', 'protected_history')
    if any(fresh.get(key) != before.get(key) for key in keys):
        raise CurrentRequestError('CURRENT_REQUEST_CHANGED_BEFORE_SEND')
    runtime.verify_runtime(expected_runtime_image)
    return fresh


def prepare_and_recheck(request, selection, before, context, secrets, database):
    # Persisting precedes the final fresh guard. If either later check fails,
    # the durable marker still prevents a different key on a subsequent run.
    recheck_before_send(database, selection, before, context['expected_runtime_image'])
    receipt = persist_request(request, selection, before, context, secrets)
    recheck_before_send(database, selection, before, context['expected_runtime_image'])
    return receipt


def validate_report(report):
    allowed = {'version', 'kind', 'outcome', 'code', 'successor_plan_id', 'issuance_request_id', 'browser_commands',
               'checks', 'request_body_sha256', 'prepared_request_sha256', 'browser_cleanup_confirmed', 'browser_api_reads'}
    if (not isinstance(report, dict) or set(report) - allowed or report.get('version') != 1
            or report.get('kind') != 'actual_current_proposal_request' or report.get('outcome') not in {'started', 'blocked', 'unknown', 'failed'}
            or type(report.get('browser_cleanup_confirmed')) is not bool or not revision(report.get('browser_api_reads'))
            or not isinstance(report.get('checks'), list) or len(report['checks']) > 100
            or any(not isinstance(c, str) or not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_]{0,99}', c) for c in report['checks'])):
        raise CurrentRequestError('CURRENT_REQUEST_CHILD_REPORT_INVALID')
    commands = report.get('browser_commands')
    if (not isinstance(commands, dict) or set(commands) != {'resume', 'batch', 'unexpected_mutations'}
            or any(type(value) is not int or not 0 <= value <= 1 for value in commands.values())
            or commands['unexpected_mutations'] != 0):
        raise CurrentRequestError('CURRENT_REQUEST_CHILD_REPORT_INVALID')
    if 'code' in report and (not isinstance(report['code'], str) or not re.fullmatch(r'[A-Z][A-Z0-9_]{0,99}', report['code'])):
        raise CurrentRequestError('CURRENT_REQUEST_CHILD_REPORT_INVALID')
    for key in ('successor_plan_id', 'issuance_request_id'):
        if key in report and not uuid_value(report[key]):
            raise CurrentRequestError('CURRENT_REQUEST_CHILD_REPORT_INVALID')
    for key in ('request_body_sha256', 'prepared_request_sha256'):
        if key in report and not digest(report[key]):
            raise CurrentRequestError('CURRENT_REQUEST_CHILD_REPORT_INVALID')
    if report['outcome'] == 'started' and (commands != {'resume': 1, 'batch': 1, 'unexpected_mutations': 0}
            or not all(key in report for key in ('successor_plan_id', 'issuance_request_id', 'request_body_sha256', 'prepared_request_sha256'))):
        raise CurrentRequestError('CURRENT_REQUEST_CHILD_REPORT_INVALID')
    return report


def child_environment():
    # Pass only runtime/network variables. Never inherit deployment or cloud keys.
    allow = {'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
             'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy',
             'all_proxy', 'no_proxy', 'PLAYWRIGHT_BROWSERS_PATH'}
    return {key: value for key, value in os.environ.items() if key in allow}


def terminate_child(child):
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)
    for stream in (child.stdin, child.stdout):
        if stream:
            try:
                stream.close()
            except BrokenPipeError:
                # The dead reader cannot consume a buffered acknowledgement;
                # still close the other pipe and confirm process termination.
                pass


def process_identity(pid):
    try:
        fields = Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'state': fields[0], 'parent': int(fields[1]), 'group': int(fields[2]), 'start': fields[19]}
    except FileNotFoundError:
        return None


def capture_browser(pid, child):
    if type(pid) is not int or pid <= 1 or pid in {os.getpid(), child.pid}:
        raise CurrentRequestError('CURRENT_REQUEST_BROWSER_IDENTITY_INVALID')
    identity = process_identity(pid)
    if not identity or identity['parent'] != child.pid or identity['group'] != pid or identity['state'] == 'Z':
        raise CurrentRequestError('CURRENT_REQUEST_BROWSER_IDENTITY_INVALID')
    return identity


def browser_group_alive(identity):
    leader = process_identity(identity['pid'])
    if leader and leader['start'] != identity['start']:
        raise CurrentRequestError('CURRENT_REQUEST_BROWSER_IDENTITY_CHANGED')
    for directory in Path('/proc').iterdir():
        if directory.name.isdigit():
            item = process_identity(int(directory.name))
            if item and item['group'] == identity['group'] and item['state'] != 'Z':
                if leader is None:
                    raise CurrentRequestError('CURRENT_REQUEST_BROWSER_GROUP_OWNERSHIP_UNCONFIRMED')
                return True
    return False


def terminate_browser(identity):
    # Chromium owns a detached group. Killing the Node driver alone is not
    # proof that a paused browser request cannot leave after disconnect.
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if not browser_group_alive(identity):
            return
        try:
            os.killpg(identity['group'], sig)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if not browser_group_alive(identity):
                return
            time.sleep(0.05)
    raise CurrentRequestError('CURRENT_REQUEST_BROWSER_EXIT_NOT_CONFIRMED')


def run_child(payload, persist, state, *, timeout=CHILD_SECONDS, private_directory=None):
    """Bounded two-event protocol. No ack or second send on any failure."""
    env = child_environment()
    if private_directory is not None:
        browser_temp = Path(private_directory) / 'browser-temp'
        browser_temp.mkdir(mode=0o700)
        env.update(TMPDIR=str(browser_temp), TMP=str(browser_temp), TEMP=str(browser_temp))
    child = subprocess.Popen(['node', '--experimental-transform-types', str(HERE / 'proposal-current-request.mjs')],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, start_new_session=True)
    state['child_started'] = True
    deadline = time.monotonic() + timeout
    pending = bytearray()
    total = 0
    report = None
    try:
        child.stdin.write(encoded(payload) + b'\n')
        child.stdin.flush()
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CurrentRequestError('CURRENT_REQUEST_CHILD_DEADLINE')
                ready = selector.select(min(remaining, 1))
                if not ready:
                    continue
                chunk = os.read(child.stdout.fileno(), 4096)
                if not chunk:
                    if pending or report is None:
                        raise CurrentRequestError('CURRENT_REQUEST_CHILD_PROTOCOL_INCOMPLETE')
                    child.wait(timeout=max(0.01, deadline - time.monotonic()))
                    if child.returncode and report['outcome'] == 'started':
                        raise CurrentRequestError('CURRENT_REQUEST_CHILD_EXIT_FAILED')
                    return report
                total += len(chunk)
                pending.extend(chunk)
                if total > 3 * MAX_LINE or len(pending) > MAX_LINE:
                    raise CurrentRequestError('CURRENT_REQUEST_CHILD_PROTOCOL_TOO_LARGE')
                while b'\n' in pending:
                    line, _, rest = pending.partition(b'\n')
                    pending = bytearray(rest)
                    try:
                        event = json.loads(line)
                    except (ValueError, UnicodeError):
                        raise CurrentRequestError('CURRENT_REQUEST_CHILD_PROTOCOL_INVALID') from None
                    if not isinstance(event, dict) or report is not None:
                        raise CurrentRequestError('CURRENT_REQUEST_CHILD_PROTOCOL_INVALID')
                    if set(event) == {'event', 'pid'} and event['event'] == 'browser_started' and not state.get('browser_identity'):
                        state['browser_identity'] = capture_browser(event['pid'], child)
                        child.stdin.write(encoded({'event': 'browser_captured', 'pid': event['pid']}) + b'\n')
                        child.stdin.flush()
                    elif (set(event) == {'event', 'request'} and event['event'] == 'prepared'
                          and not state.get('prepared_seen') and state.get('browser_identity')):
                        state['prepared_seen'] = True
                        sha = persist(event['request'])
                        if not digest(sha):
                            raise CurrentRequestError('CURRENT_REQUEST_PERSISTENCE_DIGEST_INVALID')
                        state['prepared_request_sha256'] = sha
                        state['request_body_sha256'] = event['request']['body_sha256']
                        # Even an uncertain pipe write can permit the browser to send.
                        state['acknowledged'] = True
                        child.stdin.write(encoded({'event': 'persisted', 'body_sha256': state['request_body_sha256'], 'report_sha256': sha}) + b'\n')
                        child.stdin.flush()
                    elif set(event) == {'event', 'report'} and event['event'] == 'result':
                        report = validate_report(event['report'])
                        if report['browser_commands']['batch'] and not state.get('acknowledged'):
                            raise CurrentRequestError('CURRENT_REQUEST_BATCH_WITHOUT_PERSISTENCE')
                        if state.get('acknowledged') and (report.get('prepared_request_sha256') != state['prepared_request_sha256']
                                or report.get('request_body_sha256') != state['request_body_sha256']):
                            raise CurrentRequestError('CURRENT_REQUEST_CHILD_HASH_MISMATCH')
                        # The final event closes the input protocol. Do not keep
                        # readline alive while waiting for the required EOF.
                        child.stdin.close()
                    else:
                        raise CurrentRequestError('CURRENT_REQUEST_CHILD_PROTOCOL_INVALID')
    finally:
        try:
            if state.get('browser_identity'):
                terminate_browser(state['browser_identity'])
                state['browser_process_exit_confirmed'] = True
        finally:
            terminate_child(child)
            state['child_termination_confirmed'] = True


def postconditions(before, after, report):
    if before['protected_history'] != after['protected_history'] or before['source_manifest_sha256'] != after['source_manifest_sha256']:
        raise CurrentRequestError('CURRENT_REQUEST_POSTCONDITION_HISTORY_CHANGED')
    if report['outcome'] == 'started':
        latest = after.get('latest_plan') or {}
        if (after.get('plan_status') != 'canceled' or after.get('expected_plan_revision') != before['expected_plan_revision'] + 1
                or latest.get('id') != report['successor_plan_id'] or latest.get('proposal_id') != before['proposal_id']
                or latest.get('current_contract') is not True or latest.get('issuance_request_id') != report['issuance_request_id']
                or after.get('proposal_plan_count') != before['proposal_plan_count'] + 1):
            raise CurrentRequestError('CURRENT_REQUEST_POSTCONDITION_SUCCESSOR_MISMATCH')
        issuance = after.get('latest_issuance') or {}
        try:
            accepted = datetime.fromisoformat(issuance['accepted_at'])
            deadline = datetime.fromisoformat(issuance['deadline_at'])
            valid_clock = accepted.tzinfo is not None and deadline.tzinfo is not None and (deadline - accepted).total_seconds() == 600
        except (KeyError, TypeError, ValueError, OverflowError):
            valid_clock = False
        if (issuance.get('id') != report['issuance_request_id'] or issuance.get('plan_id') != report['successor_plan_id']
                or issuance.get('requested_by') != before['actor_id'] or issuance.get('operation') != 'proposal.generate'
                or not valid_clock):
            raise CurrentRequestError('CURRENT_REQUEST_POSTCONDITION_ISSUANCE_MISMATCH')


def fixed_code(error, fallback='CURRENT_REQUEST_FAILED'):
    # Only reviewed exception types can contribute fixed-code text to public logs.
    known = (CurrentRequestError, auth.AcceptanceError, runtime.ResumeError, observer.ObserverError, transfer.TransferError,
             access.TransferError, access.d.DeployError, access.d.probe.ProbeError)
    code = str(error)
    return code if isinstance(error, known) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,99}', code) else fallback


def public_receipt(report, sha=None, state=None, issuance=None):
    result = {'actual_current_proposal_request': report['outcome'],
              'send_authorized': (state or {}).get('acknowledged') is True,
              'resume_commands': report.get('browser_commands', {}).get('resume', 0),
              'batch_commands': report.get('browser_commands', {}).get('batch', 0)}
    if report.get('code'):
        result['code'] = report['code']
    if sha:
        result['report_sha256'] = sha
    if issuance is not None:
        result.update(issuance_observation=issuance['outcome'], whole_package_issued=issuance['whole_package_issued'],
                      issuance_code=issuance['code'], authenticated_download_verified=False)
    return result


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if '--activate' not in argv or os.environ.get('RUN_CURRENT_PROPOSAL_REQUEST') != 'true':
        print('{"actual_current_proposal_request":"not_activated"}')
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--activate', action='store_true')
    parser.add_argument('--selection-object', required=True)
    parser.add_argument('--selection-sha256', required=True)
    parser.add_argument('--expected-runtime-image', required=True)
    args = parser.parse_args(argv)
    directory = database = client = session = selection = before = after = issuance = None
    secrets = []
    state = {}
    context = {}
    report = {'version': 1, 'kind': 'actual_current_proposal_request', 'outcome': 'failed'}
    report_sha = None
    cleanup = {}
    try:
        if (os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('GITHUB_REPOSITORY') != 'salahassi/tenders'
                or os.environ.get('GITHUB_RUN_ATTEMPT') != '1'
                or os.environ.get('GITHUB_JOB') != 'request'
                or not re.fullmatch(r'salahassi/tenders/\.github/workflows/request-current-proposal\.yml@refs/heads/[A-Za-z0-9._/-]{1,160}', os.environ.get('GITHUB_WORKFLOW_REF', ''))
                or not re.fullmatch(r'[0-9]{1,20}', os.environ.get('GITHUB_RUN_ID', ''))
                or not re.fullmatch(r'[a-f0-9]{40}', os.environ.get('GITHUB_SHA', ''))):
            raise CurrentRequestError('CURRENT_REQUEST_FIRST_ACTIONS_ATTEMPT_REQUIRED')
        if (not re.fullmatch(r'requests/[A-Za-z0-9][A-Za-z0-9._/-]{0,160}\.bundle', args.selection_object)
                or not digest(args.selection_sha256)
                or not re.fullmatch(r'registry\.digitalocean\.com/tenderdesk-a6093a76/runtime@sha256:[a-f0-9]{64}', args.expected_runtime_image)):
            raise CurrentRequestError('CURRENT_REQUEST_SELECTION_REFERENCE_INVALID')
        transfer.identity(BUCKET, args.selection_object)
        os.umask(0o077)
        context = {'selection_sha256': args.selection_sha256, 'expected_runtime_image': args.expected_runtime_image,
                   'source_sha': os.environ['GITHUB_SHA'], 'run_id': os.environ['GITHUB_RUN_ID']}
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            directory = access.prepare_cluster()
            runtime.verify_runtime(args.expected_runtime_image)
            path = directory / 'selection.json'
            transfer.download(os.environ['DIGITALOCEAN_ACCESS_TOKEN'], BUCKET, args.selection_object, path, args.selection_sha256)
            raw = transfer.read_private(path)
            if len(raw) > 8192:
                raise CurrentRequestError('CURRENT_REQUEST_SELECTION_INVALID')
            selection = validate_selection(json.loads(raw))
            context['prepared_object'] = prepared_object(selection)
            database = observer.Client(CHILD_SECONDS + issuance_observer.MAX_SECONDS + 240)
            database.labels['app.kubernetes.io/managed-by'] = 'tenderdesk-current-proposal-request'
            database.prepare()
            before = inspect(database, selection)
            validate_proof(before, selection, before=True)
            require_absent(os.environ['DIGITALOCEAN_ACCESS_TOKEN'], context['prepared_object'])
            core = access.d.decode_secret(access.d.get('secret', 'tenderdesk-core'))
            public = smoke.javascript_config(access.d.get('configmap', 'frontend-config')['data']['runtime-config.js'].encode())
            if public['publishableKey'] != core['ANON_KEY']:
                raise CurrentRequestError('CURRENT_REQUEST_CONFIGURATION_MISMATCH')
            config = smoke.Config(public['appOrigin'], core['ANON_KEY'], core['SERVICE_KEY'], core['JWT_SECRET'])
            client = smoke.Client(config)
            session = auth.genuine_session(client, config, before['actor_id'], selection['workspace_id'])
            auth.verify_session(client, config, session, before['actor_id'], selection['workspace_id'])
            secrets = [core[k] for k in ('ANON_KEY', 'SERVICE_KEY', 'JWT_SECRET')] + [session['access_token'], session['refresh_token']]
            runtime.verify_runtime(args.expected_runtime_image)
            payload = {**selection, **{k: before[k] for k in ('actor_id', 'proposal_id', 'expected_plan_revision',
                'expected_opportunity_revision', 'expected_proposal_revision', 'preserved_input_hash')},
                'origin': config.origin, 'access_token': session['access_token'], 'session': session, 'run_id': os.environ['GITHUB_RUN_ID']}
            report = run_child(payload, lambda request: prepare_and_recheck(request, selection, before, context, secrets, database), state,
                               private_directory=directory)
            no_secrets(report, secrets)
            if not report['browser_cleanup_confirmed']:
                raise CurrentRequestError('CURRENT_REQUEST_BROWSER_CLEANUP_NOT_CONFIRMED')
            if report['outcome'] == 'started':
                after = inspect(database, selection)
                postconditions(before, after, report)
                issuance = observe_issuance(database, selection, before, report, args.expected_runtime_image)
                no_secrets(issuance, secrets)
    except Exception as error:
        report = {**report, 'outcome': 'unknown' if state.get('acknowledged') else 'failed', 'code': fixed_code(error)}
    finally:
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            if before is not None and database is not None and state.get('child_started'):
                try:
                    after = inspect(database, selection)
                    postconditions(before, after, report)
                    cleanup['history_preserved'] = True
                except Exception as error:
                    # This is an after-commit proof failure, never a rollback claim.
                    report = {**report, 'outcome': 'failed', 'code': fixed_code(error, 'CURRENT_REQUEST_POSTCONDITION_UNAVAILABLE')}
                    cleanup['history_preserved'] = False
            if session and client and session.get('access_token'):
                try:
                    smoke.expect(client.request('/auth/v1/logout?scope=local', token=session['access_token'], method='POST'),
                                 {200, 204}, 'CURRENT_REQUEST_SESSION_LOGOUT_FAILED')
                    cleanup['auth_logout_confirmed'] = True
                except Exception:
                    cleanup['auth_logout_confirmed'] = False
                    report = {**report, 'outcome': 'failed', 'code': 'CURRENT_REQUEST_SESSION_LOGOUT_FAILED'}
            if database:
                try:
                    database.cleanup()
                    cleanup['observer_cleanup_confirmed'] = True
                except Exception:
                    cleanup['observer_cleanup_confirmed'] = False
                    report = {**report, 'outcome': 'failed', 'code': 'CURRENT_REQUEST_OBSERVER_CLEANUP_NOT_CONFIRMED'}
            if directory:
                try:
                    envelope = {'version': 1, 'kind': 'current_proposal_request_diagnostics', **context, 'selection': selection,
                                'before': before, 'after': after, 'report': report, 'issuance': issuance, 'protocol': state, 'cleanup': cleanup}
                    no_secrets(envelope, secrets)
                    report_path = directory / 'current-request-diagnostics.json'
                    transfer.write_private(report_path, encoded(envelope))
                    report_sha = transfer.upload(os.environ['DIGITALOCEAN_ACCESS_TOKEN'], BUCKET,
                        'diagnostics/proposal-current-request-' + os.environ['GITHUB_RUN_ID'] + '.bundle', report_path)
                except Exception:
                    report = {**report, 'outcome': 'failed', 'code': 'CURRENT_REQUEST_DIAGNOSTICS_PERSISTENCE_FAILED'}
                try:
                    shutil.rmtree(directory)
                except Exception:
                    report = {**report, 'outcome': 'failed', 'code': 'CURRENT_REQUEST_RUNNER_CLEANUP_NOT_CONFIRMED'}
    print(json.dumps(public_receipt(report, report_sha, state, issuance)), flush=True)
    return 0 if report['outcome'] == 'started' and issuance and issuance['whole_package_issued'] else 1


if __name__ == '__main__':
    sys.exit(main())
