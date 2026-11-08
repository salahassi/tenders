#!/usr/bin/env python3
"""One exact read-only proposal trial sample; callers own access and cleanup.

No polling loop, mutation, provider request or credential transport lives here.
The coordinator may take more samples inside its remaining Actions budget, but
the business clock always remains the database's original 600-second issuance.
Private artifact identifiers support a separate authenticated download check.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import sys
import uuid

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('trial_issuance_contract', HERE / 'proposal-current-issuance.py')
issuance = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = issuance
SPEC.loader.exec_module(issuance)
UUID_KEYS = issuance.KEYS
KEYS = UUID_KEYS | {'operation'}
OPERATIONS = {'proposal.generate', 'generation.retry'}
STATUSES = ('queued', 'running', 'retry_wait', 'quota_wait', 'succeeded', 'blocked', 'failed', 'canceled')
MAX_BYTES = 512 * 1024
STAGES = {
    'analyze_chunk': 'analysis', 'summarize_review': 'analysis', 'consolidate_requirements': 'analysis',
    'plan_proposal': 'planning', 'draft_section': 'drafting',
    'plan_commercial': 'commercial', 'review_proposal': 'review',
    'advance_plan': 'finalizing', 'prepare_generated_delivery': 'finalizing',
    'render_delivery': 'rendering', 'verify_delivery': 'rendering',
}
STAGE_ORDER = ('analysis', 'planning', 'drafting', 'commercial', 'review', 'finalizing', 'rendering', 'processing')
ATTEMPT_KEYS = {'id', 'job_id', 'type', 'operation', 'provider', 'model', 'status', 'result_code', 'http_status',
                'request_phase', 'sent', 'round_number', 'worker_attempt', 'started_at', 'finished_at', 'retry_after',
                'usage_state', 'actual_input', 'actual_output', 'thinking_tokens', 'reserved_input', 'reserved_output'}


class TrialObservationError(Exception):
    pass


def require(value, code='PROPOSAL_TRIAL_OBSERVATION_INVALID'):
    if not value:
        raise TrialObservationError(code)


def uuid_value(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def validate_target(target):
    require(isinstance(target, dict) and set(target) == KEYS
            and target.get('operation') in OPERATIONS
            and all(uuid_value(target.get(key)) for key in UUID_KEYS), 'PROPOSAL_TRIAL_TARGET_INVALID')
    return target


def replace_once(text, old, new):
    require(text.count(old) == 1, 'PROPOSAL_TRIAL_SQL_CONTRACT_CHANGED')
    return text.replace(old, new)


def observation_sql(target):
    validate_target(target)
    sql = issuance.observation_sql({key: target[key] for key in UUID_KEYS})
    # Both the selected issuance and the actor guard bind the actual command.
    # generation.retry is not renamed to proposal.generate in any evidence.
    require(sql.count("'proposal.generate'") == 2, 'PROPOSAL_TRIAL_SQL_CONTRACT_CHANGED')
    sql = sql.replace("'proposal.generate'", "'" + target['operation'] + "'")
    actor = "'actor_id','" + target['actor_id'] + "')"
    sql = replace_once(sql, actor, actor[:-1] + ",'operation','" + target['operation'] + "')")
    # Projection precedes aggregation and never includes raw execution metadata,
    # lease tokens, remote request IDs, prompts or response bodies.
    sql = replace_once(sql, ")\nSELECT jsonb_build_object(\n 'version',1", """), selected_attempts AS MATERIALIZED (
 SELECT a.id::text id,a.job_id,j.type,a.operation,a.provider,a.model,a.status,a.result_code,a.http_status,
  a.request_phase,a.sent,a.round_number,a.worker_attempt,a.started_at,a.finished_at,a.retry_after,
  u.state usage_state,u.actual_input,u.actual_output,u.thinking_tokens,u.reserved_input,u.reserved_output
 FROM public.model_attempts a JOIN jobs j ON j.workspace_id=a.workspace_id AND j.id=a.job_id
 JOIN request r ON r.workspace_id=a.workspace_id AND a.started_at>=r.accepted_at
 LEFT JOIN public.provider_usage u ON u.workspace_id=a.workspace_id AND u.id=a.usage_id
)
SELECT jsonb_build_object(
 'version',1""")
    progress = """ 'job_progress',jsonb_build_object(
  'total',(SELECT count(*) FROM jobs),
  'completed',(SELECT count(*) FROM jobs WHERE status='succeeded'),
  'groups',(SELECT coalesce(jsonb_agg(jsonb_build_object('type',type,'status',status,'count',n,
   'updated_at',updated_at) ORDER BY type,status),'[]') FROM (
    SELECT type,status,count(*) n,max(updated_at) updated_at FROM jobs GROUP BY type,status) grouped)),
 'attempt_progress',(SELECT jsonb_build_object('total',count(*),
  'accepted_waits',count(*) FILTER(WHERE status='waiting' AND http_status=200 AND result_code='MODEL_IN_PROGRESS'),
  'accepted_http_attempts',count(*) FILTER(WHERE sent AND http_status BETWEEN 200 AND 299 AND request_phase IS DISTINCT FROM 'poll'),
  'poll_attempts',count(*) FILTER(WHERE request_phase='poll'),
  'skipped_attempts',count(*) FILTER(WHERE status='skipped'),
  'last_started_at',max(started_at),'last_finished_at',max(finished_at)) FROM selected_attempts),
 'attempt_timeline',jsonb_build_object('total',(SELECT count(*) FROM selected_attempts),
  'truncated',(SELECT count(*) FROM selected_attempts)>200,
  'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(safe) ORDER BY safe.started_at,safe.id::bigint),'[]') FROM (
   SELECT * FROM selected_attempts ORDER BY started_at DESC,id::bigint DESC LIMIT 200) safe)),
"""
    sql = replace_once(sql, " 'plan',(SELECT", progress + " 'plan',(SELECT")
    sql = replace_once(sql, "'snapshot_id',s.id,'created_at',s.created_at,",
                       "'snapshot_id',s.id,'proposal_version_id',s.payload#>>'{generation,proposal_version_id}','created_at',s.created_at,")
    sql = replace_once(sql, "jsonb_build_object('volume',volume,'status',status,'expected_size',expected_size,",
                       "jsonb_build_object('id',id,'snapshot_id',snapshot_id,'workspace_id',workspace_id,"
                       "'original_name',original_name,'mime_type',mime_type,"
                       "'volume',volume,'status',status,'expected_size',expected_size,")
    return sql


def validate_sample(value, target, previous=None):
    """Retain the established issuance checks with an explicit operation binding."""
    validate_target(target)
    require(isinstance(value, dict) and value.get('version') == 1
            and value.get('kind') == 'current_proposal_issuance_observation' and value.get('target') == target
            and isinstance(value.get('guards'), dict) and set(value['guards']) == issuance.GUARDS)
    observed = issuance.timestamp(value.get('observed_at'))
    request = value.get('issuance')
    require(isinstance(request, dict) and request.get('id') == target['issuance_request_id']
            and request.get('plan_id') == target['plan_id'] and request.get('requested_by') == target['actor_id']
            and request.get('operation') == target['operation'], 'PROPOSAL_TRIAL_ISSUANCE_IDENTITY_CHANGED')
    accepted, deadline = issuance.timestamp(request.get('accepted_at')), issuance.timestamp(request.get('deadline_at'))
    require((deadline - accepted).total_seconds() == 600 and observed >= accepted, 'PROPOSAL_TRIAL_CLOCK_INVALID')
    if previous is not None:
        require(isinstance(previous, dict) and previous.get('target') == target
                and isinstance(previous.get('issuance'), dict), 'PROPOSAL_TRIAL_PREVIOUS_INVALID')
        require(all(request.get(key) == previous['issuance'].get(key) for key in
                    ('id', 'plan_id', 'requested_by', 'operation', 'accepted_at', 'deadline_at')),
                'PROPOSAL_TRIAL_ISSUANCE_IDENTITY_CHANGED')
        require(observed >= issuance.timestamp(previous.get('observed_at')), 'PROPOSAL_TRIAL_CLOCK_INVALID')
    require(request.get('outcome') in {'active', 'issued', 'failed'}
            and request.get('effective_outcome') in {'active', 'issued', 'failed'})
    for key in ('error_code', 'effective_error_code'):
        require(request.get(key) is None or isinstance(request[key], str)
                and re.fullmatch(r'[A-Z][A-Z0-9_]{0,119}', request[key]))
    for key in ('completed_at', 'effective_completed_at'):
        if request.get(key) is not None:
            require(accepted <= issuance.timestamp(request[key]) <= observed, 'PROPOSAL_TRIAL_CLOCK_INVALID')
    if request['outcome'] == 'active':
        require(request.get('completed_at') is None and request.get('error_code') is None
                and request.get('issued_snapshot_id') is None)
        if request['effective_outcome'] == 'failed':
            require(observed >= deadline and request.get('effective_error_code') == 'PROPOSAL_ISSUANCE_TIMEOUT'
                    and issuance.timestamp(request.get('effective_completed_at')) == deadline)
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
            require(request.get('error_code') is None and issuance.timestamp(request['completed_at']) < deadline)
    require(isinstance(value.get('terminal_jobs'), list) and len(value['terminal_jobs']) <= 1000)
    progress = value.get('job_progress')
    require(isinstance(progress, dict) and type(progress.get('total')) is int
            and type(progress.get('completed')) is int and 0 <= progress['completed'] <= progress['total'] <= 1000000
            and isinstance(progress.get('groups'), list) and len(progress['groups']) <= 256,
            'PROPOSAL_TRIAL_PROGRESS_INVALID')
    seen = set()
    for group in progress['groups']:
        require(isinstance(group, dict) and isinstance(group.get('type'), str)
                and re.fullmatch(r'[a-z][a-z0-9_]{0,79}', group['type']) and group.get('status') in STATUSES
                and type(group.get('count')) is int and 0 < group['count'] <= 1000000
                and (group['type'], group['status']) not in seen, 'PROPOSAL_TRIAL_PROGRESS_INVALID')
        seen.add((group['type'], group['status']))
        require(issuance.timestamp(group.get('updated_at')) <= observed, 'PROPOSAL_TRIAL_CLOCK_INVALID')
    require(sum(group['count'] for group in progress['groups']) == progress['total']
            and sum(group['count'] for group in progress['groups'] if group['status'] == 'succeeded') == progress['completed'],
            'PROPOSAL_TRIAL_PROGRESS_INVALID')
    attempts = value.get('attempt_progress')
    require(isinstance(attempts, dict) and type(attempts.get('total')) is int
            and type(attempts.get('accepted_waits')) is int
            and 0 <= attempts['accepted_waits'] <= attempts['total'] <= 10000000, 'PROPOSAL_TRIAL_PROGRESS_INVALID')
    for key in ('last_started_at', 'last_finished_at'):
        if attempts.get(key) is not None:
            require(issuance.timestamp(attempts[key]) <= observed, 'PROPOSAL_TRIAL_CLOCK_INVALID')
    # Earlier encrypted reports have only aggregate metadata. They remain valid
    # previous-clock evidence while every newly sampled SQL result adds this.
    if 'attempt_timeline' in value:
        timeline = value['attempt_timeline']
        require(isinstance(timeline, dict) and timeline.get('total') == attempts['total']
                and timeline.get('truncated') is (attempts['total'] > 200)
                and isinstance(timeline.get('attempts'), list)
                and len(timeline['attempts']) == min(attempts['total'], 200), 'PROPOSAL_TRIAL_TIMELINE_INVALID')
        for key in ('accepted_http_attempts', 'poll_attempts', 'skipped_attempts'):
            require(type(attempts.get(key)) is int and 0 <= attempts[key] <= attempts['total'],
                    'PROPOSAL_TRIAL_TIMELINE_INVALID')
        prior_order, identities = None, set()
        for row in timeline['attempts']:
            require(isinstance(row, dict) and set(row) == ATTEMPT_KEYS
                    and isinstance(row['id'], str) and re.fullmatch(r'[1-9][0-9]{0,18}', row['id'])
                    and row['id'] not in identities and uuid_value(row['job_id'])
                    and row['status'] in {'running', 'succeeded', 'failed', 'skipped', 'waiting', 'historical'}
                    and type(row['sent']) is bool, 'PROPOSAL_TRIAL_TIMELINE_INVALID')
            identities.add(row['id'])
            for key in ('type', 'operation', 'provider', 'model', 'request_phase', 'result_code', 'usage_state'):
                require(row[key] is None and key in {'request_phase', 'result_code', 'usage_state'}
                        or isinstance(row[key], str) and len(row[key]) <= 200
                        and not re.search(r'[\x00-\x1f\x7f]', row[key]), 'PROPOSAL_TRIAL_TIMELINE_INVALID')
            require(row['http_status'] is None or type(row['http_status']) is int and 100 <= row['http_status'] <= 599,
                    'PROPOSAL_TRIAL_TIMELINE_INVALID')
            for key in ('round_number', 'worker_attempt', 'actual_input', 'actual_output', 'thinking_tokens', 'reserved_input', 'reserved_output'):
                require(row[key] is None and key not in {'round_number', 'worker_attempt'}
                        or type(row[key]) is int and 0 <= row[key] <= 9007199254740991, 'PROPOSAL_TRIAL_TIMELINE_INVALID')
            started = issuance.timestamp(row['started_at'])
            require(accepted <= started <= observed, 'PROPOSAL_TRIAL_CLOCK_INVALID')
            order = (started, int(row['id']))
            require(prior_order is None or order > prior_order, 'PROPOSAL_TRIAL_TIMELINE_INVALID')
            prior_order = order
            if row['finished_at'] is not None:
                require(started <= issuance.timestamp(row['finished_at']) <= observed, 'PROPOSAL_TRIAL_CLOCK_INVALID')
            if row['retry_after'] is not None:
                issuance.timestamp(row['retry_after'])
    package = value.get('package')
    if package is not None:
        require(isinstance(package, dict) and uuid_value(package.get('snapshot_id'))
                and uuid_value(package.get('proposal_version_id')) and isinstance(package.get('artifacts'), list),
                'PROPOSAL_TRIAL_PACKAGE_IDENTITY_INVALID')
        for artifact in package['artifacts']:
            require(isinstance(artifact, dict) and uuid_value(artifact.get('id'))
                    and artifact.get('snapshot_id') == package['snapshot_id']
                    and artifact.get('workspace_id') == target['workspace_id']
                    and isinstance(artifact.get('original_name'), str) and 0 < len(artifact['original_name']) <= 1024
                    and artifact.get('mime_type') == 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    'PROPOSAL_TRIAL_PACKAGE_IDENTITY_INVALID')
    return value


def read_sql(database, sql):
    spec = importlib.util.spec_from_file_location('trial_observer_sql_transport', HERE / 'digitalocean-deploy.py')
    deploy = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = deploy
    spec.loader.exec_module(deploy)
    return deploy.command(['exec', '-i', database.pod, '-n', deploy.NAMESPACE, '--', 'psql', '-X',
        '--quiet', '--no-align', '--tuples-only', '--set=ON_ERROR_STOP=1', '--dbname=' + deploy.DATABASE,
        '--file=-'], payload=sql, timeout=25)


def sample(database, target, previous=None, *, reader=None):
    sql = observation_sql(target)
    raw = (reader or read_sql)(database, sql)
    require(isinstance(raw, str) and len(raw.encode('utf-8')) <= MAX_BYTES, 'PROPOSAL_TRIAL_SAMPLE_TOO_LARGE')
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise TrialObservationError('PROPOSAL_TRIAL_SAMPLE_INVALID') from None
    prior = None
    if previous is not None:
        require(isinstance(previous, dict) and previous.get('version') == 1
                and previous.get('kind') == 'proposal_trial_observation' and previous.get('target') == target
                and isinstance(previous.get('sample'), dict),
                'PROPOSAL_TRIAL_PREVIOUS_INVALID')
        prior = previous.get('sample')
        validate_sample(prior, target)
    validate_sample(value, target, prior)
    outcome, code = issuance.classify(value)
    return {'version': 1, 'kind': 'proposal_trial_observation', 'target': dict(target),
            'outcome': outcome, 'code': code, 'whole_package_issued': outcome == 'issued',
            'metadata_only': True, 'authenticated_download_verified': False, 'sample': value}


def public_receipt(evidence):
    require(isinstance(evidence, dict) and evidence.get('version') == 1
            and evidence.get('kind') == 'proposal_trial_observation', 'PROPOSAL_TRIAL_EVIDENCE_INVALID')
    value = validate_sample(evidence.get('sample'), evidence.get('target'))
    outcome, code = issuance.classify(value)
    require(evidence.get('outcome') == outcome and evidence.get('code') == code
            and evidence.get('whole_package_issued') is (outcome == 'issued'), 'PROPOSAL_TRIAL_EVIDENCE_INVALID')
    progress = value['job_progress']
    counts = dict.fromkeys(STATUSES, 0)
    for group in progress['groups']:
        counts[group['status']] += group['count']
    stage = 'package_ready' if outcome == 'issued' else 'stopped' if outcome != 'active' else 'waiting'
    if outcome == 'active':
        for status in ('running', 'retry_wait', 'queued', 'quota_wait'):
            pending = [STAGES.get(group['type'], 'processing') for group in progress['groups'] if group['status'] == status]
            if pending:
                stage = min(pending, key=STAGE_ORDER.index)
                break
    result = {'proposal_trial': 'observed', 'outcome': outcome, 'code': code, 'stage': stage,
            'total_jobs': progress['total'], 'completed_jobs': progress['completed'], 'status_counts': counts,
            'model_attempt_count': value['attempt_progress']['total'], 'whole_package_issued': outcome == 'issued',
            'metadata_only': True, 'authenticated_download_verified': False, 'business_mutations': 0}
    if 'attempt_timeline' in value:
        result.update({key: value['attempt_progress'][key]
                       for key in ('accepted_http_attempts', 'poll_attempts', 'skipped_attempts')})
    return result
