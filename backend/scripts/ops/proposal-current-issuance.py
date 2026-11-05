#!/usr/bin/env python3
"""Bounded read-only evidence for an existing proposal issuance, never a retry.

Database issuance and artifact metadata prove the recorded whole-package state.
They do not prove a fresh authenticated download or human approval. Persisted
completion timestamps remain nullable; effective deadline closure is separate.
"""
from __future__ import annotations

from datetime import datetime
from contextlib import contextmanager
import json
from pathlib import Path
import re
import signal
import time
import uuid

HERE = Path(__file__).resolve().parent
KEYS = {'workspace_id', 'opportunity_id', 'proposal_id', 'plan_id', 'issuance_request_id', 'actor_id'}
GUARDS = {'database', 'selected_target', 'actor', 'no_restore', 'opportunity', 'latest_plan', 'current_contract', 'sources'}
MAX_SECONDS = 630
MAX_SAMPLES = 128


class IssuanceObservationError(Exception):
    pass


@contextmanager
def operation_budget(seconds):
    """Linux Actions main-thread watchdog covers blocking owned subprocesses.

    subprocess.run kills and waits for its child if the alarm interrupts it.
    Any remote read also has its independent SQL statement timeout; the owned
    observer and browser are cleaned by the caller's finally block.
    """
    require(seconds > 0, 'CURRENT_ISSUANCE_OBSERVATION_TIMEOUT')
    require(signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0), 'CURRENT_ISSUANCE_WATCHDOG_UNAVAILABLE')
    previous = signal.getsignal(signal.SIGALRM)
    def expired(signum, frame):
        raise IssuanceObservationError('CURRENT_ISSUANCE_OBSERVATION_TIMEOUT')
    signal.signal(signal.SIGALRM, expired)
    try:
        signal.setitimer(signal.ITIMER_REAL, seconds)
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def require(value, code='CURRENT_ISSUANCE_OBSERVATION_INVALID'):
    if not value:
        raise IssuanceObservationError(code)


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value)
        require(parsed.tzinfo is not None)
        return parsed
    except (ValueError, TypeError, OverflowError):
        raise IssuanceObservationError('CURRENT_ISSUANCE_TIMESTAMP_INVALID') from None


def validate_target(target):
    require(isinstance(target, dict) and set(target) == KEYS, 'CURRENT_ISSUANCE_TARGET_INVALID')
    for value in target.values():
        try:
            require(isinstance(value, str) and str(uuid.UUID(value)) == value, 'CURRENT_ISSUANCE_TARGET_INVALID')
        except (ValueError, TypeError, AttributeError):
            raise IssuanceObservationError('CURRENT_ISSUANCE_TARGET_INVALID') from None
    return target


def observation_sql(target):
    validate_target(target)
    sql = (HERE / 'proposal-current-issuance.sql').read_text()
    placeholders = {'workspace_id': 'WORKSPACE', 'opportunity_id': 'OPPORTUNITY', 'proposal_id': 'PROPOSAL',
                    'plan_id': 'PLAN', 'issuance_request_id': 'ISSUANCE', 'actor_id': 'ACTOR'}
    for key, name in placeholders.items():
        sql = sql.replace('__' + name + '__', target[key])
    return sql


def validate_sample(sample, target, previous=None):
    require(isinstance(sample, dict) and sample.get('version') == 1
            and sample.get('kind') == 'current_proposal_issuance_observation' and sample.get('target') == target
            and isinstance(sample.get('guards'), dict) and set(sample['guards']) == GUARDS)
    observed = timestamp(sample.get('observed_at'))
    request = sample.get('issuance')
    require(isinstance(request, dict) and request.get('id') == target['issuance_request_id']
            and request.get('plan_id') == target['plan_id'] and request.get('requested_by') == target['actor_id']
            and request.get('operation') == 'proposal.generate', 'CURRENT_ISSUANCE_IDENTITY_CHANGED')
    accepted, deadline = timestamp(request.get('accepted_at')), timestamp(request.get('deadline_at'))
    require((deadline - accepted).total_seconds() == 600 and observed >= accepted, 'CURRENT_ISSUANCE_CLOCK_INVALID')
    if previous:
        require(all(request.get(key) == previous['issuance'].get(key) for key in
                    ('id', 'plan_id', 'requested_by', 'operation', 'accepted_at', 'deadline_at')),
                'CURRENT_ISSUANCE_IDENTITY_CHANGED')
        require(observed >= timestamp(previous['observed_at']), 'CURRENT_ISSUANCE_CLOCK_INVALID')
    require(request.get('outcome') in {'active', 'issued', 'failed'}
            and request.get('effective_outcome') in {'active', 'issued', 'failed'})
    for key in ('error_code', 'effective_error_code'):
        require(request.get(key) is None or isinstance(request[key], str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,119}', request[key]))
    for key in ('completed_at', 'effective_completed_at'):
        if request.get(key) is not None:
            require(accepted <= timestamp(request[key]) <= observed, 'CURRENT_ISSUANCE_CLOCK_INVALID')
    if request['outcome'] == 'active':
        require(request.get('completed_at') is None and request.get('error_code') is None and request.get('issued_snapshot_id') is None)
        if request['effective_outcome'] == 'failed':
            require(observed >= deadline and request.get('effective_error_code') == 'PROPOSAL_ISSUANCE_TIMEOUT'
                    and timestamp(request.get('effective_completed_at')) == deadline)
        else:
            require(request['effective_outcome'] == 'active' and request.get('effective_completed_at') is None
                    and request.get('effective_error_code') is None)
    else:
        require(request['outcome'] == request['effective_outcome'] and request.get('completed_at') is not None
                and request.get('completed_at') == request.get('effective_completed_at')
                and request.get('error_code') == request.get('effective_error_code'))
        if request['outcome'] == 'failed':
            require(request.get('error_code') is not None and request.get('issued_snapshot_id') is None)
        else:
            require(request.get('error_code') is None and timestamp(request['completed_at']) < deadline)
    require(isinstance(sample.get('terminal_jobs'), list) and len(sample['terminal_jobs']) <= 1000)
    return sample


def check_package(sample):
    request, package = sample['issuance'], sample.get('package')
    require(sample.get('artifact_check') == 'passed' and isinstance(package, dict)
            and package.get('snapshot_id') == request.get('issued_snapshot_id')
            and package.get('current_version') is True and package.get('current_snapshot') is True
            and package.get('validated_generated_draft') is True
            and package.get('content_state') == 'generated_review_draft' and package.get('approval_state') == 'draft',
            'CURRENT_ISSUANCE_PACKAGE_INCOMPLETE')
    expected = package.get('required_volumes')
    require(expected in [['combined'], ['technical', 'financial']], 'CURRENT_ISSUANCE_PACKAGE_INCOMPLETE')
    artifacts = package.get('artifacts')
    require(isinstance(artifacts, list) and len(artifacts) == len(expected)
            and sorted(a.get('volume') for a in artifacts) == sorted(expected), 'CURRENT_ISSUANCE_PACKAGE_INCOMPLETE')
    completed = timestamp(request['completed_at'])
    require(isinstance(package.get('render_job'), dict) and package['render_job'].get('status') == 'succeeded'
            and timestamp(package['render_job'].get('updated_at')) <= completed, 'CURRENT_ISSUANCE_PACKAGE_INCOMPLETE')
    for artifact in artifacts:
        require(artifact.get('status') == 'ready' and artifact.get('renderer_version') == '3'
                and type(artifact.get('expected_size')) is int and artifact['expected_size'] > 0
                and isinstance(artifact.get('content_hash'), str) and re.fullmatch(r'[a-f0-9]{64}', artifact['content_hash'])
                and timestamp(artifact.get('updated_at')) <= completed, 'CURRENT_ISSUANCE_PACKAGE_INCOMPLETE')


def classify(sample):
    if any(value is not True for value in sample['guards'].values()):
        return 'guard_failed', 'CURRENT_ISSUANCE_CURRENTNESS_FAILED'
    request = sample['issuance']
    if request['effective_outcome'] == 'failed':
        return 'failed', request['effective_error_code']
    if request['effective_outcome'] == 'issued':
        check_package(sample)
        return 'issued', None
    # A known worker/plan terminal error is evidence immediately, even before
    # maintenance persists request failure. Do not invent completed_at for it.
    terminal = [job for job in sample['terminal_jobs'] if job.get('status') in {'blocked', 'failed'}]
    plan = sample.get('plan') or {}
    if plan.get('status') in {'blocked', 'failed', 'canceled'}:
        terminal.insert(0, plan)
    if terminal:
        code = terminal[0].get('error_code')
        code = code if isinstance(code, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{0,119}', code) else 'CURRENT_ISSUANCE_TERMINAL_STATE'
        return 'terminal_pending', code
    return 'active', None


def observe(target, read_sample, verify_runtime, *, monotonic=time.monotonic, sleep=time.sleep, interval=5):
    """Stop at the first observed terminal state; never authorize new work.

    The hard observer bound is anchored once to the remaining DATABASE request
    clock. Starting/restarting observation cannot extend the request's deadline.
    SQL and Kubernetes calls have their own finite transport limits.
    """
    validate_target(target)
    require(type(interval) is int and 1 <= interval <= 15)
    started = monotonic()
    stop = started + MAX_SECONDS
    samples = []
    outcome, code = 'observation_timeout', 'CURRENT_ISSUANCE_OBSERVATION_TIMEOUT'
    try:
        for _ in range(MAX_SAMPLES):
            if monotonic() >= stop:
                break
            # One absolute remaining budget includes all synchronous runtime
            # inventory and SQL transport time; nested per-call limits cannot
            # extend the observer window.
            with operation_budget(stop - monotonic()):
                verify_runtime()
                sample = read_sample()
            # Keep a source-scoped raw sample before validation. It may contain
            # the actual terminal DB timestamp even when a guard fails.
            require(isinstance(sample, dict) and sample.get('target') == target)
            previous = samples[-1] if samples else None
            samples.append(sample)
            validate_sample(sample, target, previous)
            remaining = (timestamp(sample['issuance']['deadline_at']) - timestamp(sample['observed_at'])).total_seconds()
            stop = min(stop, monotonic() + max(0, remaining) + 15)
            outcome, code = classify(sample)
            if outcome != 'active':
                break
            delay = min(interval, max(0, stop - monotonic()), max(0.05, remaining))
            if delay <= 0:
                break
            sleep(delay)
        if outcome == 'active':
            outcome, code = 'observation_timeout', 'CURRENT_ISSUANCE_OBSERVATION_TIMEOUT'
    except Exception as error:
        outcome = 'observation_failed'
        code = str(error) if isinstance(error, IssuanceObservationError) else 'CURRENT_ISSUANCE_READ_FAILED'
        if code == 'CURRENT_ISSUANCE_OBSERVATION_TIMEOUT':
            outcome = 'observation_timeout'
    last = samples[-1] if samples else None
    return {'version': 1, 'kind': 'current_proposal_issuance_evidence', 'outcome': outcome, 'code': code,
            'whole_package_issued': outcome == 'issued', 'metadata_only': True,
            'authenticated_download_verified': False, 'human_approval_verified': False,
            'elapsed_observer_seconds': round(monotonic() - started, 3), 'samples': samples,
            'accepted_at': last['issuance'].get('accepted_at') if last and isinstance(last.get('issuance'), dict) else None,
            'deadline_at': last['issuance'].get('deadline_at') if last and isinstance(last.get('issuance'), dict) else None,
            'completed_at': last['issuance'].get('completed_at') if last and isinstance(last.get('issuance'), dict) else None,
            'effective_completed_at': last['issuance'].get('effective_completed_at') if last and isinstance(last.get('issuance'), dict) else None}
