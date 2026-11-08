#!/usr/bin/env python3
"""One selected proposal command through the same authenticated API as the UI.

The coordinator owns activation, genuine Owner authentication, encrypted durable
write/readback, runtime checks and cleanup. This module never opens a session,
changes providers, cancels saved work, retries HTTP, or exports customer content.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import hmac
import importlib.util
import json
from pathlib import Path
import re
import sys
import uuid

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('trial_request_auth', HERE / 'proposal-export-acceptance.py')
auth = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = auth
SPEC.loader.exec_module(auth)
d = auth.access.d
REASON = 'User requested continuation of the saved work.'
OPERATIONS = {'proposal.generate', 'generation.retry'}
TARGET_KEYS = {'workspace_id', 'opportunity_id', 'proposal_id', 'plan_id', 'issuance_request_id', 'actor_id', 'operation'}
GUARDS = {'database', 'selected_opportunity', 'unique_active_owner', 'no_restore', 'proposal_identity',
          'no_other_active_plan', 'no_selected_leases', 'usage_ready'}
BASE_GUARDS = {'database', 'selected_opportunity', 'unique_active_owner', 'no_restore', 'proposal_identity'}
PREFIX = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL ROLE tdp_app_owner;\nSET LOCAL statement_timeout='20s';\nSET LOCAL lock_timeout='5s';\n"
NAMESPACE = uuid.UUID('d8a3b36f-eaad-528d-a4a6-f58a7b612714')
_ATTEMPTED = set()
VALIDATION_CODES = {'EVIDENCE_REFERENCE_INVALID', 'MODEL_COVERAGE_INCOMPLETE', 'UNSUPPORTED_COMPANY_CLAIM'}
VALIDATION_REASONS = {'source_missing', 'quote_empty', 'source_quote_mismatch', 'source_kind_mismatch',
    'company_not_verified', 'candidate_quote_mismatch', 'requirement_quote_mismatch', 'numeric_evidence_mismatch',
    'required_ids_mismatch', 'content_ids_mismatch', 'candidate_hash_mismatch', 'duplicate_claim_ids',
    'missing_content_claims', 'unexpected_content_claims', 'declared_claim_uncovered', 'required_content_missing',
    'invalid_finding_reference', 'unsupported_company_claim', 'invalid_scope'}


class TrialRequestError(Exception):
    pass


def require(value, code='PROPOSAL_TRIAL_REQUEST_INVALID'):
    if not value:
        raise TrialRequestError(code)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def uuid_value(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def revision(value):
    return type(value) is int and 0 <= value <= 9007199254740991


def validate_selection(value):
    require(isinstance(value, dict) and set(value) == {'version', 'workspace_id', 'opportunity_id'}
            and type(value.get('version')) is int and value['version'] == 1
            and all(uuid_value(value.get(k)) for k in ('workspace_id', 'opportunity_id'))
            and value['workspace_id'] == auth.access.WORKSPACE, 'PROPOSAL_TRIAL_SELECTION_INVALID')
    return value


def inspection_sql(selection):
    validate_selection(selection)
    w, o = selection['workspace_id'], selection['opportunity_id']
    return PREFIX + f"""
WITH owners AS MATERIALIZED (
 SELECT m.user_id FROM public.memberships m JOIN public.identity_allowlist a
 ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
 WHERE m.workspace_id='{w}' AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner'
), opportunity AS MATERIALIZED (
 SELECT id,revision,archived,decision FROM public.opportunities WHERE workspace_id='{w}' AND id='{o}'
), proposal AS MATERIALIZED (
 SELECT id,revision,active_version_id FROM public.proposals WHERE workspace_id='{w}' AND opportunity_id='{o}'
), plans AS MATERIALIZED (
 SELECT * FROM public.generation_plans WHERE workspace_id='{w}' AND opportunity_id='{o}' AND kind='proposal'
), latest AS MATERIALIZED (
 SELECT * FROM plans ORDER BY created_at DESC,id DESC LIMIT 1
), selected_jobs AS MATERIALIZED (
 SELECT j.id,j.status,j.lease_token,j.lease_until FROM public.jobs j WHERE j.workspace_id='{w}' AND
 (j.entity_id IN (SELECT id FROM plans) OR j.checkpoint->>'issuance_request_id' IN
  (SELECT r.id::text FROM public.proposal_issuance_requests r JOIN plans p ON r.workspace_id=p.workspace_id AND r.plan_id=p.id))
), retry_admission AS MATERIALIZED (
 SELECT to_regprocedure('app_private.assert_generation_retry_usage(public.generation_plans,text)') IS NOT NULL AS modern_guard_installed,
  EXISTS(SELECT 1 FROM public.provider_usage WHERE workspace_id='{w}' AND state='reserved') AS has_reserved,
  EXISTS(SELECT 1 FROM public.provider_usage WHERE workspace_id='{w}' AND state='unknown') AS has_unknown,
  EXISTS(SELECT 1 FROM public.model_routing WHERE workspace_id='{w}' AND enabled) AS legacy_routing_enabled,
  coalesce((SELECT s.enabled AND (s.admitted_after IS NULL OR p.created_at>=s.admitted_after)
   FROM latest p LEFT JOIN public.model_execution_settings s ON s.workspace_id=p.workspace_id),false) AS modern_admission
), queued_model_jobs AS MATERIALIZED (
 SELECT j.* FROM public.jobs j JOIN public.generation_steps step ON step.workspace_id=j.workspace_id AND step.job_id=j.id
 JOIN latest p ON p.workspace_id=j.workspace_id AND p.id=j.entity_id AND p.id=step.plan_id
 WHERE step.status='queued' AND app_private.queue_work_class(j)<>'local'
), model_job_readiness AS MATERIALIZED (
 SELECT j.id,CASE WHEN j.checkpoint->>'model_executor'='2' AND j.checkpoint#>>'{{model_routing,mode}}'='round_robin'
  THEN NOT EXISTS(SELECT 1 FROM public.provider_usage u WHERE u.workspace_id=j.workspace_id AND u.job_id=j.id
   AND app_private.model_usage_blocks_recovery(j,u,now()))
  ELSE a.modern_admission AND NOT(j.checkpoint ? 'model_routing')
   AND NOT EXISTS(SELECT 1 FROM public.provider_usage u WHERE u.workspace_id=j.workspace_id AND u.job_id=j.id)
  END AS ready
 FROM queued_model_jobs j CROSS JOIN retry_admission a
), retry_usage AS MATERIALIZED (
 SELECT a.*,NOT a.has_reserved AND (NOT a.has_unknown OR a.legacy_routing_enabled) AS legacy_ready,
  NOT a.has_reserved AND (NOT a.has_unknown OR a.legacy_routing_enabled OR
   (a.modern_guard_installed AND NOT EXISTS(SELECT 1 FROM model_job_readiness WHERE ready IS NOT TRUE)
    AND (EXISTS(SELECT 1 FROM model_job_readiness) OR a.modern_admission))) AS ready
 FROM retry_admission a
)
SELECT jsonb_build_object('version',1,'kind','proposal_trial_request_proof','observed_at',now(),
 'selection',jsonb_build_object('version',1,'workspace_id','{w}','opportunity_id','{o}'),
 'actor_id',(SELECT user_id FROM owners ORDER BY user_id LIMIT 1),
 'opportunity',(SELECT jsonb_build_object('id',id,'revision',revision) FROM opportunity),
 'proposal',(SELECT jsonb_build_object('id',id,'revision',revision,'active_version_id',active_version_id) FROM proposal LIMIT 1),
 'workspace_evidence_revision',(SELECT evidence_revision FROM public.workspaces WHERE id='{w}'),
 'retry_usage',(SELECT to_jsonb(r)||jsonb_build_object('queued_model_jobs',(SELECT count(*) FROM model_job_readiness),
  'blocked_model_jobs',(SELECT count(*) FROM model_job_readiness WHERE ready IS NOT TRUE)) FROM retry_usage r),
 'plan',(SELECT jsonb_build_object('id',id,'proposal_id',proposal_id,'revision',revision,'status',status,'stage',stage,
  'input_hash',input_hash,'evidence_revision',evidence_revision,'base_version_id',base_version_id,'issuance_request_id',issuance_request_id,
  'current_contract',coalesce(frozen_context->'generated_delivery_version'='3'::jsonb AND frozen_context->'proposal_consistency_version'='1'::jsonb,false)) FROM latest),
 'latest_issuance',(SELECT jsonb_build_object('id',r.id,'plan_id',r.plan_id,'requested_by',r.requested_by,'operation',r.operation,
  'outcome',r.outcome,'accepted_at',r.accepted_at,'deadline_at',r.deadline_at) FROM public.proposal_issuance_requests r
  JOIN latest p ON p.workspace_id=r.workspace_id AND p.id=r.plan_id AND p.issuance_request_id=r.id),
 'guards',jsonb_build_object(
  'database',current_database()='tenderdesk_app' AND (SELECT count(*) FROM public.workspaces)=1,
  'selected_opportunity',(SELECT count(*) FROM opportunity WHERE NOT archived AND decision='shortlisted')=1,
  'unique_active_owner',(SELECT count(*) FROM owners)=1,
  'no_restore',NOT EXISTS(SELECT 1 FROM public.restore_sessions WHERE workspace_id='{w}' AND state IN ('staging','committing')),
  'proposal_identity',(SELECT count(*) FROM proposal)<=1 AND NOT EXISTS(SELECT 1 FROM latest p WHERE NOT EXISTS(SELECT 1 FROM proposal s WHERE s.id=p.proposal_id)),
  'no_other_active_plan',NOT EXISTS(SELECT 1 FROM plans WHERE status IN ('queued','running','blocked') AND id IS DISTINCT FROM (SELECT id FROM latest)),
  'no_selected_leases',NOT EXISTS(SELECT 1 FROM selected_jobs WHERE status='running' OR lease_token IS NOT NULL OR lease_until>now()),
  'usage_ready',(SELECT ready FROM retry_usage)
  ));
ROLLBACK;
"""


def read(database, sql, *, max_bytes=64 * 1024):
    # Unlike the migration helper's five-minute subprocess bound, every read has
    # a 35-second transport bound inside the coordinator's shorter trial budget.
    raw = d.command(['exec', '-i', database.pod, '-n', d.NAMESPACE, '--', 'psql', '-X', '--quiet',
                     '--no-align', '--tuples-only', '--set=ON_ERROR_STOP=1', '--dbname=' + d.DATABASE, '--file=-'],
                    payload=sql, timeout=35)
    require(len(raw.encode()) <= max_bytes, 'PROPOSAL_TRIAL_PROOF_TOO_LARGE')
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        raise TrialRequestError('PROPOSAL_TRIAL_PROOF_INVALID') from None


def validate_proof(proof):
    require(isinstance(proof, dict) and type(proof.get('version')) is int and proof['version'] == 1 and proof.get('kind') == 'proposal_trial_request_proof'
            and isinstance(proof.get('guards'), dict) and set(proof['guards']) == GUARDS
            and all(type(value) is bool for value in proof['guards'].values()),
            'PROPOSAL_TRIAL_PROOF_INVALID')
    validate_selection(proof.get('selection'))
    for name in sorted(BASE_GUARDS):
        require(proof['guards'][name] is True, 'PROPOSAL_TRIAL_PRECONDITION_' + name.upper())
    require(uuid_value(proof.get('actor_id')) and revision(proof.get('workspace_evidence_revision'))
            and isinstance(proof.get('opportunity'), dict)
            and proof['opportunity'].get('id') == proof['selection']['opportunity_id']
            and revision(proof['opportunity'].get('revision')), 'PROPOSAL_TRIAL_PROOF_INVALID')
    proposal, plan = proof.get('proposal'), proof.get('plan')
    if proposal is not None:
        require(isinstance(proposal, dict) and uuid_value(proposal.get('id')) and revision(proposal.get('revision'))
                and (proposal.get('active_version_id') is None or uuid_value(proposal['active_version_id'])), 'PROPOSAL_TRIAL_PROOF_INVALID')
    if plan is not None:
        require(isinstance(plan, dict) and uuid_value(plan.get('id')) and proposal is not None
                and plan.get('proposal_id') == proposal['id'] and revision(plan.get('revision'))
                and revision(plan.get('evidence_revision')) and type(plan.get('current_contract')) is bool
                and plan.get('status') in {'queued', 'running', 'blocked', 'completed', 'failed', 'canceled'}
                and isinstance(plan.get('input_hash'), str) and re.fullmatch('[a-f0-9]{64}', plan['input_hash'])
                and (plan.get('issuance_request_id') is None or uuid_value(plan['issuance_request_id'])), 'PROPOSAL_TRIAL_PROOF_INVALID')
    issuance = proof.get('latest_issuance')
    if issuance is not None:
        require(isinstance(issuance, dict) and plan is not None and issuance.get('id') == plan['issuance_request_id']
                and issuance.get('plan_id') == plan['id'] and uuid_value(issuance.get('requested_by'))
                and issuance.get('operation') in OPERATIONS and issuance.get('outcome') in {'active', 'issued', 'failed'},
                'PROPOSAL_TRIAL_PROOF_INVALID')
    else:
        require(plan is None or plan['issuance_request_id'] is None, 'PROPOSAL_TRIAL_ISSUANCE_MISSING')
    return proof


def inspect(database, selection):
    result = validate_proof(read(database, inspection_sql(selection)))
    require(result['selection'] == selection, 'PROPOSAL_TRIAL_SELECTION_MISMATCH')
    return result


def diagnostic_sql(selection):
    """Metadata only: never return prompts, call keys, remote IDs or credentials."""
    validate_selection(selection)
    w, o = selection['workspace_id'], selection['opportunity_id']
    return PREFIX + f"""
WITH pending AS MATERIALIZED (
 SELECT u.id,u.state,u.error_code,u.created_at,u.updated_at,u.remote_deadline,u.reconciliation_after,
  u.remote_request_id IS NOT NULL AS has_remote_request,u.provider,u.model,u.connection_id,u.model_config_id,
  u.job_id,j.status AS job_status,j.type AS job_type,j.entity_id,j.error_code AS job_error_code,
  j.lease_until,j.lease_token IS NOT NULL AS has_job_lease,j.cancel_requested,j.next_attempt_at,
  j.checkpoint->'model_routing'->>'mode' AS routing_mode,j.checkpoint->>'model_executor' AS model_executor,
  coalesce(p.opportunity_id='{o}'::uuid,false) AS selected_opportunity
 FROM public.provider_usage u LEFT JOIN public.jobs j ON j.workspace_id=u.workspace_id AND j.id=u.job_id
 LEFT JOIN public.generation_plans p ON p.workspace_id=j.workspace_id AND p.id=j.entity_id
 WHERE u.workspace_id='{w}' AND u.state IN ('reserved','unknown')
), bounded AS (SELECT * FROM pending ORDER BY (state='reserved') DESC,created_at,id LIMIT 100),
latest AS MATERIALIZED (
 SELECT id FROM public.generation_plans WHERE workspace_id='{w}' AND opportunity_id='{o}' AND kind='proposal'
 ORDER BY created_at DESC,id DESC LIMIT 1
), selected_jobs AS MATERIALIZED (
 SELECT j.id FROM public.jobs j JOIN latest p ON p.id=j.entity_id WHERE j.workspace_id='{w}'
), invalid_reports AS MATERIALIZED (
 SELECT r.id,t.job_id,r.created_at,r.value FROM app_private.model_graph_results r
 JOIN app_private.model_graph_threads t ON t.id=r.thread_id AND t.workspace_id=r.workspace_id
 JOIN selected_jobs j ON j.id=t.job_id
 WHERE r.workspace_id='{w}' AND r.result_key LIKE 'invalid-report-%'
), reports AS (
 SELECT * FROM invalid_reports ORDER BY created_at DESC,id DESC LIMIT 8
), verifier_attempts AS MATERIALIZED (
 SELECT a.id,a.job_id,a.model,a.model_config_id,a.result_code FROM public.model_attempts a JOIN selected_jobs j ON j.id=a.job_id
 WHERE a.workspace_id='{w}' AND a.operation='verify_grounding' AND a.result_code IN
 ('EVIDENCE_REFERENCE_INVALID','MODEL_COVERAGE_INCOMPLETE','UNSUPPORTED_COMPANY_CLAIM','SUCCEEDED')
), attempts AS (SELECT * FROM verifier_attempts ORDER BY id DESC LIMIT 32)
SELECT jsonb_build_object('version',1,'kind','proposal_trial_usage_diagnostic','observed_at',now(),
 'selection',jsonb_build_object('version',1,'workspace_id','{w}','opportunity_id','{o}'),
 'total',(SELECT count(*) FROM pending),'truncated',(SELECT count(*) FROM pending)>100,
 'reserved_count',(SELECT count(*) FROM pending WHERE state='reserved'),
 'unknown_count',(SELECT count(*) FROM pending WHERE state='unknown'),
 'routing_count',(SELECT count(*) FROM public.model_routing WHERE workspace_id='{w}'),
 'routing_enabled',EXISTS(SELECT 1 FROM public.model_routing WHERE workspace_id='{w}' AND enabled),
 'modern_execution',(SELECT jsonb_build_object('enabled',enabled,'revision',revision,
  'max_parallel_requests',max_parallel_requests,'admitted_after',admitted_after)
  FROM public.model_execution_settings WHERE workspace_id='{w}'),
 'enabled_connection_count',(SELECT count(*) FROM public.model_connections WHERE workspace_id='{w}' AND enabled),
 'enabled_configuration_count',(SELECT count(*) FROM public.model_configurations c JOIN public.model_connections n
   ON n.workspace_id=c.workspace_id AND n.id=c.connection_id WHERE c.workspace_id='{w}' AND c.enabled AND n.enabled),
 'task_route_count',(SELECT count(*) FROM public.model_task_routes WHERE workspace_id='{w}'),
 'selected_latest_plan_created_at',(SELECT max(created_at) FROM public.generation_plans WHERE workspace_id='{w}' AND opportunity_id='{o}' AND kind='proposal'),
 'verifier_diagnostics',jsonb_build_object('plan_id',(SELECT id FROM latest),
  'report_count',(SELECT count(*) FROM invalid_reports),'reports_truncated',(SELECT count(*) FROM invalid_reports)>8,
  'attempt_count',(SELECT count(*) FROM verifier_attempts),'attempts_truncated',(SELECT count(*) FROM verifier_attempts)>32,
  'attempts',coalesce((SELECT jsonb_agg(jsonb_build_object('attempt_id',id::text,'job_id',job_id,
   'model',model,'model_config_id',model_config_id,'code',result_code) ORDER BY id DESC) FROM attempts),'[]'::jsonb),
  'reports',coalesce((SELECT jsonb_agg(jsonb_build_object('report_id',r.id,'job_id',r.job_id,
   'model',r.value#>>'{{producer,model}}','code',r.value->>'code',
   'diagnostics_truncated',coalesce(jsonb_array_length(r.value->'validation_diagnostics'),0)>8
    OR coalesce((r.value->>'omitted_diagnostic_count')::integer,0)>0
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(r.value->'validation_diagnostics','[]')) d
       WHERE jsonb_array_length(coalesce(d->'paths','[]'))>4),
   'diagnostics',coalesce((SELECT jsonb_agg(jsonb_build_object('code',d->>'code','reason',d->>'reason',
     'paths',coalesce((SELECT jsonb_agg(p ORDER BY pn) FROM jsonb_array_elements(d->'paths') WITH ORDINALITY x(p,pn)
       WHERE pn<=4),'[]'::jsonb)) ORDER BY dn)
    FROM jsonb_array_elements(coalesce(r.value->'validation_diagnostics','[]')) WITH ORDINALITY x(d,dn)
    WHERE dn<=8),'[]'::jsonb)) ORDER BY r.created_at DESC,r.id DESC) FROM reports r),'[]'::jsonb)),
 'verifier_routes',coalesce((SELECT jsonb_agg(jsonb_build_object('task',r.task,'revision',r.revision,
  'inherit_default',r.inherit_default,'strategy',r.strategy,'next_position',r.next_position,
  'profile',CASE WHEN r.profile IS NULL OR r.profile='null'::jsonb THEN NULL ELSE jsonb_build_object(
   'revision',r.profile->'revision','max_output_tokens',r.profile->'max_output_tokens',
   'reasoning',r.profile->'reasoning','require_native_strict',r.profile->'require_native_strict') END,
  'models',coalesce((SELECT jsonb_agg(jsonb_build_object('position',ids.n,'id',ids.id,'model',c.model,
    'enabled',c.enabled,'revision',c.revision,'connection_enabled',n.enabled,'connection_revision',n.revision)
    ORDER BY ids.n) FROM unnest(r.model_ids) WITH ORDINALITY ids(id,n)
    LEFT JOIN public.model_configurations c ON c.workspace_id=r.workspace_id AND c.id=ids.id
    LEFT JOIN public.model_connections n ON n.workspace_id=c.workspace_id AND n.id=c.connection_id),'[]'::jsonb))
  ORDER BY r.task) FROM public.model_task_routes r WHERE r.workspace_id='{w}' AND r.task IN ('default','verify_grounding')),'[]'::jsonb),
 'rows',coalesce((SELECT jsonb_agg(to_jsonb(bounded) ORDER BY (state='reserved') DESC,created_at,id) FROM bounded),'[]'::jsonb));
ROLLBACK;
"""


def diagnostic(database, selection):
    value = read(database, diagnostic_sql(selection), max_bytes=256 * 1024)
    require(isinstance(value, dict) and value.get('version') == 1
            and value.get('kind') == 'proposal_trial_usage_diagnostic' and value.get('selection') == selection
            and isinstance(value.get('rows'), list) and len(value['rows']) <= 100
            and all(revision(value.get(k)) for k in ('total', 'reserved_count', 'unknown_count', 'routing_count'))
            and type(value.get('truncated')) is bool and type(value.get('routing_enabled')) is bool,
            'PROPOSAL_TRIAL_USAGE_DIAGNOSTIC_INVALID')
    validate_verifier_diagnostic(value)
    return value


def validate_verifier_diagnostic(value):
    """Reject extra/private fields and malformed projected metadata at readback."""
    code = 'PROPOSAL_TRIAL_USAGE_DIAGNOSTIC_INVALID'
    report = value.get('verifier_diagnostics')
    require(isinstance(report, dict) and set(report) == {'plan_id', 'report_count', 'reports_truncated',
        'attempt_count', 'attempts_truncated', 'attempts', 'reports'}, code)
    require(report['plan_id'] is None or uuid_value(report['plan_id']), code)
    for name, limit in [('reports', 8), ('attempts', 32)]:
        count_key = 'report_count' if name == 'reports' else 'attempt_count'
        require(isinstance(report[name], list) and len(report[name]) <= limit and revision(report[count_key])
                and len(report[name]) == min(report[count_key], limit)
                and type(report[name + '_truncated']) is bool
                and report[name + '_truncated'] == (report[count_key] > limit), code)
    model = lambda text: isinstance(text, str) and re.fullmatch(r'[a-zA-Z0-9._@/:-]{1,120}', text)
    for row in report['attempts']:
        require(isinstance(row, dict) and set(row) == {'attempt_id', 'job_id', 'model', 'model_config_id', 'code'}
                and isinstance(row['attempt_id'], str) and re.fullmatch(r'[1-9][0-9]{0,19}', row['attempt_id'])
                and uuid_value(row['job_id']) and model(row['model'])
                and (row['model_config_id'] is None or uuid_value(row['model_config_id']))
                and row['code'] in VALIDATION_CODES | {'SUCCEEDED'}, code)
    for row in report['reports']:
        require(isinstance(row, dict) and set(row) == {'report_id', 'job_id', 'model', 'code',
            'diagnostics_truncated', 'diagnostics'} and uuid_value(row['report_id']) and uuid_value(row['job_id'])
            and (row['model'] is None or model(row['model'])) and row['code'] in VALIDATION_CODES
            and type(row['diagnostics_truncated']) is bool and isinstance(row['diagnostics'], list)
            and len(row['diagnostics']) <= 8, code)
        for item in row['diagnostics']:
            require(isinstance(item, dict) and set(item) == {'code', 'reason', 'paths'}
                    and item['code'] in VALIDATION_CODES and item['reason'] in VALIDATION_REASONS
                    and isinstance(item['paths'], list) and len(item['paths']) <= 4
                    and all(isinstance(p, str) and len(p) <= 240 and re.fullmatch(
                        r'\$(?:\.[a-z][a-z0-9_]*|\[(?:0|[1-9][0-9]{0,5})\])*', p) for p in item['paths']), code)
    routes = value.get('verifier_routes')
    require(isinstance(routes, list) and len(routes) <= 2, code)
    require(len({r.get('task') for r in routes if isinstance(r, dict)}) == len(routes), code)
    for route in routes:
        require(isinstance(route, dict) and set(route) == {'task', 'revision', 'inherit_default', 'strategy',
                'next_position', 'models', 'profile'} and route['task'] in {'default', 'verify_grounding'}
                and revision(route['revision']) and revision(route['next_position'])
                and type(route['inherit_default']) is bool and route['strategy'] in {'priority', 'round_robin'}
                and isinstance(route['models'], list) and len(route['models']) <= 32, code)
        profile = route['profile']
        require(profile is None or isinstance(profile, dict) and set(profile) == {'revision', 'max_output_tokens',
            'reasoning', 'require_native_strict'} and revision(profile['revision']) and profile['revision'] > 0
            and type(profile['max_output_tokens']) is int and 1024 <= profile['max_output_tokens'] <= 131072
            and profile['reasoning'] in {'none', 'minimal', 'low', 'medium', 'high'}
            and type(profile['require_native_strict']) is bool, code)
        for index, config in enumerate(route['models'], 1):
            require(isinstance(config, dict) and set(config) == {'position', 'id', 'model', 'enabled', 'revision',
                'connection_enabled', 'connection_revision'} and type(config['position']) is int
                and config['position'] == index and uuid_value(config['id']) and model(config['model'])
                and all(type(config[k]) is bool for k in ('enabled', 'connection_enabled'))
                and all(revision(config[k]) for k in ('revision', 'connection_revision')), code)
    settings = value.get('modern_execution')
    require(settings is None or isinstance(settings, dict) and set(settings) == {'enabled', 'revision',
        'max_parallel_requests', 'admitted_after'} and type(settings['enabled']) is bool
        and revision(settings['revision']) and type(settings['max_parallel_requests']) is int
        and 1 <= settings['max_parallel_requests'] <= 4
        and (settings['admitted_after'] is None or isinstance(settings['admitted_after'], str)), code)


def existing_target(proof):
    plan, issuance = proof['plan'], proof['latest_issuance']
    require(plan is not None and issuance is not None, 'PROPOSAL_TRIAL_EXISTING_ISSUANCE_REQUIRED')
    return {k: proof['selection'][k] for k in ('workspace_id', 'opportunity_id')} | {
        'proposal_id': plan['proposal_id'], 'plan_id': plan['id'], 'issuance_request_id': issuance['id'],
        'actor_id': issuance['requested_by'], 'operation': issuance['operation']}


def prepare(proof):
    validate_proof(proof)
    plan, proposal, issuance = proof.get('plan'), proof.get('proposal'), proof.get('latest_issuance')
    envelope = {'version': 1, 'kind': 'proposal_trial_prepared_request', 'proof': proof}
    if plan and (plan['status'] in {'queued', 'running', 'completed'} or issuance and issuance['outcome'] in {'active', 'issued'}):
        require(proof['guards']['no_other_active_plan'] is True, 'PROPOSAL_TRIAL_PRECONDITION_NO_OTHER_ACTIVE_PLAN')
        return envelope | {'mode': 'observe_existing', 'target': existing_target(proof)}
    # The server's legacy workspace usage admission gate applies to retry.
    # Fresh generation retains the worker's capacity and same-request ambiguity
    # guards; historical unknown accounting is neither cleared nor rewritten.
    for name in sorted(GUARDS - {'usage_ready'}):
        require(proof['guards'][name] is True, 'PROPOSAL_TRIAL_PRECONDITION_' + name.upper())
    if plan and plan.get('stage') == 'completed' and issuance:
        raise TrialRequestError('PROPOSAL_RENDER_RETRY_REQUIRED')
    retry = bool(proof['guards']['usage_ready'] and plan and plan['status'] in {'failed', 'canceled', 'blocked'} and plan['current_contract']
                 and plan['evidence_revision'] == proof['workspace_evidence_revision']
                 and plan.get('base_version_id') == proposal.get('active_version_id'))
    if retry:
        operation = 'generation.retry'
        input_value = {'id': plan['id'], 'expected_revision': plan['revision'], 'reason': REASON}
    else:
        require(not plan or plan['status'] in {'failed', 'canceled'}, 'PROPOSAL_TRIAL_CURRENT_RETRY_REQUIRED')
        require(not proposal or proposal['active_version_id'] is None, 'PROPOSAL_TRIAL_EXISTING_VERSION_REQUIRES_REVIEW')
        operation = 'proposal.generate'
        input_value = {'id': proof['selection']['opportunity_id'], 'expected_revision': proof['opportunity']['revision']}
    body = {'commands': [{'operation': operation, 'input': input_value}]}
    # No run ID, runtime image, timestamp or random new key can bypass a prior
    # uncertain attempt for this target and observed predecessor revision.
    identity = [proof['selection']['workspace_id'], proof['selection']['opportunity_id'], operation,
                plan['id'] if plan else None, plan['revision'] if plan else None,
                plan['input_hash'] if plan else None, input_value['expected_revision']]
    identity_hash = digest(identity)
    key = str(uuid.uuid5(NAMESPACE, identity_hash))
    return envelope | {'mode': 'send', 'operation': operation, 'idempotency_key': key,
        'command_key': hashlib.sha256(('batch:' + key + ':1').encode()).hexdigest(),
        'prepared_object': 'diagnostics/proposal-trial-' + identity_hash + '.prepared.bundle',
        'body': body, 'body_sha256': digest(body)}


def validate_prepared(prepared):
    require(isinstance(prepared, dict) and prepared == prepare(prepared.get('proof')), 'PROPOSAL_TRIAL_PREPARED_MISMATCH')
    return prepared


def recheck(database, selection, prepared):
    validate_prepared(prepared)
    fresh = prepare(inspect(database, selection))
    before = dict(prepared['proof']); before.pop('observed_at', None)
    after = dict(fresh['proof']); after.pop('observed_at', None)
    require(before == after and {k: v for k, v in fresh.items() if k != 'proof'} ==
            {k: v for k, v in prepared.items() if k != 'proof'}, 'PROPOSAL_TRIAL_CHANGED_BEFORE_SEND')
    return fresh


def send(client, session, prepared, persist, before_send=None):
    validate_prepared(prepared)
    require(prepared['mode'] == 'send', 'PROPOSAL_TRIAL_OBSERVE_ONLY')
    require(isinstance(session, dict) and session.get('user', {}).get('id') == prepared['proof']['actor_id']
            and isinstance(session.get('access_token'), str) and bool(session['access_token']), 'PROPOSAL_TRIAL_SESSION_MISMATCH')
    require(callable(persist), 'PROPOSAL_TRIAL_PERSISTENCE_REQUIRED')
    require(prepared['prepared_object'] not in _ATTEMPTED, 'PROPOSAL_TRIAL_ALREADY_ATTEMPTED')
    expected = hashlib.sha256(encoded(prepared)).hexdigest()
    persisted = persist(prepared)
    require(isinstance(persisted, str) and hmac.compare_digest(expected, persisted), 'PROPOSAL_TRIAL_PERSISTENCE_READBACK_FAILED')
    validate_prepared(prepared)
    require(hmac.compare_digest(expected, hashlib.sha256(encoded(prepared)).hexdigest()), 'PROPOSAL_TRIAL_PREPARED_CHANGED')
    if before_send is not None:
        before_send()
    require(hmac.compare_digest(expected, hashlib.sha256(encoded(prepared)).hexdigest()), 'PROPOSAL_TRIAL_PREPARED_CHANGED')
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(prepared['proof']['observed_at'])).total_seconds()
    except (ValueError, TypeError, KeyError):
        raise TrialRequestError('PROPOSAL_TRIAL_PROOF_TIME_INVALID') from None
    require(0 <= age <= 120, 'PROPOSAL_TRIAL_PROOF_STALE')
    # Exactly one request. A network failure is unknown, never permission to
    # prepare another key or submit a different command in this invocation.
    _ATTEMPTED.add(prepared['prepared_object'])
    response = client.request('/functions/v1/api/v1/commands', token=session['access_token'], method='POST',
                              data=prepared['body'], headers={'Idempotency-Key': prepared['idempotency_key']})
    error_code = None
    try:
        value = json.loads(response.body)
        candidate = value.get('error', {}).get('code')
        if isinstance(candidate, str) and re.fullmatch('[A-Z][A-Z0-9_]{0,119}', candidate):
            error_code = candidate
    except (ValueError, TypeError, AttributeError):
        pass
    return {'sent': True, 'http_status': response.status, 'accepted': 200 <= response.status < 300,
            'unknown': response.status == 0, 'api_error_code': error_code,
            'response_sha256': hashlib.sha256(response.body).hexdigest()}


def acceptance_sql(prepared):
    validate_prepared(prepared)
    require(prepared['mode'] == 'send', 'PROPOSAL_TRIAL_OBSERVE_ONLY')
    proof, operation = prepared['proof'], prepared['operation']
    w, o = proof['selection']['workspace_id'], proof['selection']['opportunity_id']
    plan_guard = ("AND p.id='" + proof['plan']['id'] + "' AND p.input_hash='" + proof['plan']['input_hash'] + "'") if operation == 'generation.retry' else ''
    return PREFIX + f"""
WITH accepted AS MATERIALIZED (
 SELECT r.*,p.opportunity_id,p.proposal_id,p.issuance_request_id AS current_issuance_id FROM public.proposal_issuance_requests r
 JOIN public.generation_plans p ON p.workspace_id=r.workspace_id AND p.id=r.plan_id
 JOIN public.proposals prop ON prop.workspace_id=p.workspace_id AND prop.id=p.proposal_id AND prop.opportunity_id=p.opportunity_id
 WHERE r.workspace_id='{w}' AND p.opportunity_id='{o}' AND p.kind='proposal'
 AND r.requested_by='{proof['actor_id']}' AND r.operation='{operation}' AND r.idempotency_key='{prepared['command_key']}' {plan_guard}
)
SELECT jsonb_build_object('count',(SELECT count(*) FROM accepted),
 'bound',coalesce((SELECT current_issuance_id=id AND deadline_at=accepted_at+interval '600 seconds' FROM accepted LIMIT 1),false),
 'target',(SELECT jsonb_build_object('workspace_id',workspace_id,'opportunity_id',opportunity_id,'proposal_id',proposal_id,
  'plan_id',plan_id,'issuance_request_id',id,'actor_id',requested_by,'operation',operation) FROM accepted LIMIT 1));
ROLLBACK;
"""


def verify_result(database, prepared):
    result = read(database, acceptance_sql(prepared))
    require(isinstance(result, dict) and result.get('count') == 1 and result.get('bound') is True,
            'PROPOSAL_TRIAL_ACCEPTANCE_UNPROVEN')
    target = result.get('target')
    require(isinstance(target, dict) and set(target) == TARGET_KEYS and target.get('operation') == prepared['operation']
            and all(uuid_value(target.get(k)) for k in TARGET_KEYS - {'operation'})
            and all(target[k] == prepared['proof']['selection'][k] for k in ('workspace_id', 'opportunity_id'))
            and target['actor_id'] == prepared['proof']['actor_id'], 'PROPOSAL_TRIAL_ACCEPTANCE_MISMATCH')
    prior = prepared['proof'].get('plan')
    proposal = prepared['proof'].get('proposal')
    require((proposal is None or target['proposal_id'] == proposal['id'])
            and (prepared['operation'] != 'generation.retry' or target['plan_id'] == prior['id'])
            and (prepared['operation'] != 'proposal.generate' or prior is None or target['plan_id'] != prior['id']),
            'PROPOSAL_TRIAL_ACCEPTANCE_MISMATCH')
    return target
