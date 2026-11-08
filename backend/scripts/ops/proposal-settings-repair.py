#!/usr/bin/env python3
"""One reviewed Owner batch for the diagnosed verifier route and capacity.

No provider/model edits, SQL writes, job resets or generation commands. Existing
job catalog snapshots retain their routes. The coordinator owns authentication,
activation, encrypted intent/readback, runtime checks and cleanup.
"""
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
SPEC = importlib.util.spec_from_file_location('settings_repair_request', HERE / 'proposal-trial-request.py')
request = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = request
SPEC.loader.exec_module(request)
NAMESPACE = uuid.UUID('3ff987f3-93e9-5fc1-adba-5ebfb5958552')
TARGET_MODEL = 'gpt-6.1-sol'
GUARDS = {'database', 'unique_owner', 'no_restore', 'no_reserved', 'no_active_issuance',
          'selected_failed_plan', 'successful_verifier', 'enabled_target'}
PROTECTED = ('model_connections', 'model_configurations', 'model_settings', 'model_routing', 'other_routes')
_ATTEMPTED = set()
encoded, digest = request.encoded, request.digest


def require(value, code):
    if not value:
        raise RuntimeError('PROPOSAL_SETTINGS_' + code)


def anchor_from_report(report):
    require(isinstance(report, dict) and report.get('version') == 1
            and report.get('kind') == 'proposal_trial_report' and report.get('mode') == 'inspect'
            and report.get('cleanup_verified') is True and not report.get('failure_code'), 'DIAGNOSTIC_REQUIRED')
    selection = request.validate_selection(report.get('selection'))
    diagnostic = report.get('admission_diagnostic', {})
    prior = report.get('proof', {})
    require(diagnostic.get('kind') == 'proposal_trial_usage_diagnostic' and diagnostic.get('selection') == selection
            and prior.get('selection') == selection and prior.get('plan', {}).get('status') == 'failed', 'DIAGNOSTIC_TARGET')
    verifier = diagnostic.get('verifier_diagnostics', {})
    require(verifier.get('plan_id') == prior['plan']['id'] and request.uuid_value(verifier.get('plan_id')),
            'DIAGNOSTIC_PLAN')
    successes = [row for row in verifier.get('attempts', [])
                 if row.get('code') == 'SUCCEEDED' and row.get('model') == TARGET_MODEL]
    require(successes and len({(row.get('model_config_id'), row.get('model')) for row in successes}) == 1,
            'UNIQUE_PROVEN_MODEL_REQUIRED')
    row = successes[0]
    anchor = {name: row.get(name) for name in ('attempt_id', 'job_id', 'model_config_id', 'model')}
    anchor['plan_id'] = verifier['plan_id']
    validate_anchor(anchor)
    configured = [model for route in diagnostic.get('verifier_routes', []) for model in route.get('models', [])
                  if model.get('id') == anchor['model_config_id'] and model.get('model') == anchor['model']
                  and model.get('enabled') is True and model.get('connection_enabled') is True]
    require(configured, 'PROVEN_MODEL_NOT_CONFIGURED')
    return selection, anchor


def validate_anchor(value):
    require(isinstance(value, dict) and set(value) == {'attempt_id', 'job_id', 'model_config_id', 'model', 'plan_id'}
            and all(request.uuid_value(value.get(k)) for k in ('job_id', 'model_config_id', 'plan_id'))
            and isinstance(value['attempt_id'], str) and re.fullmatch('[1-9][0-9]{0,18}', value['attempt_id'])
            and value['model'] == TARGET_MODEL,
            'ANCHOR_INVALID')


def sql_json(value):
    return "'" + encoded(value).decode().replace("'", "''") + "'::jsonb"


def inspection_sql(selection, anchor):
    request.validate_selection(selection)
    validate_anchor(anchor)
    w, o = selection['workspace_id'], selection['opportunity_id']
    protected = []
    for name in PROTECTED:
        table = 'model_task_routes' if name == 'other_routes' else name
        extra = " AND task<>'verify_grounding'" if name == 'other_routes' else ''
        protected.append("'" + name + "',(SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text,'UTF8')),'hex') FROM public."
                         + table + " t WHERE workspace_id='" + w + "'" + extra + ")")
    return request.PREFIX + f"""
WITH owners AS MATERIALIZED (
 SELECT m.user_id FROM public.memberships m JOIN public.identity_allowlist a
 ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
 WHERE m.workspace_id='{w}' AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner'
), latest AS MATERIALIZED (
 SELECT id,status,revision,error_code FROM public.generation_plans
 WHERE workspace_id='{w}' AND opportunity_id='{o}' AND kind='proposal' ORDER BY created_at DESC,id DESC LIMIT 1
), target AS MATERIALIZED (
 SELECT c.id,c.connection_id,c.model,c.revision,c.enabled,c.capabilities,n.provider,
  n.revision AS connection_revision,n.enabled AS connection_enabled
 FROM public.model_configurations c JOIN public.model_connections n ON n.workspace_id=c.workspace_id AND n.id=c.connection_id
 WHERE c.workspace_id='{w}' AND c.id='{anchor['model_config_id']}'
)
SELECT jsonb_build_object('version',1,'kind','proposal_settings_repair_proof','observed_at',now(),
 'selection',{sql_json(selection)},'anchor',{sql_json(anchor)},'actor_id',(SELECT user_id FROM owners LIMIT 1),
 'plan',(SELECT to_jsonb(p) FROM latest p),'target',(SELECT to_jsonb(t) FROM target t),
 'route',(SELECT to_jsonb(r) FROM public.model_task_routes r WHERE workspace_id='{w}' AND task='verify_grounding'),
 'default_route',(SELECT to_jsonb(r) FROM public.model_task_routes r WHERE workspace_id='{w}' AND task='default'),
 'settings',(SELECT to_jsonb(s) FROM public.model_execution_settings s WHERE workspace_id='{w}'),
 'protected',jsonb_build_object({','.join(protected)}),
 'saved_catalog_count',(SELECT count(*) FROM public.jobs WHERE workspace_id='{w}' AND checkpoint ? 'model_catalog_snapshot'),
 'guards',jsonb_build_object('database',current_database()='tenderdesk_app','unique_owner',(SELECT count(*) FROM owners)=1,
  'no_restore',NOT EXISTS(SELECT 1 FROM public.restore_sessions WHERE workspace_id='{w}' AND state IN ('staging','committing')),
  'no_reserved',NOT EXISTS(SELECT 1 FROM public.provider_usage WHERE workspace_id='{w}' AND state='reserved'),
  'no_active_issuance',NOT EXISTS(SELECT 1 FROM public.proposal_issuance_requests WHERE workspace_id='{w}' AND outcome='active'),
  'selected_failed_plan',EXISTS(SELECT 1 FROM latest WHERE id='{anchor['plan_id']}' AND status='failed'
    AND error_code='PROPOSAL_ISSUANCE_TIMEOUT'),
  'enabled_target',EXISTS(SELECT 1 FROM target WHERE enabled AND connection_enabled AND model='{anchor['model']}'),
  'successful_verifier',EXISTS(SELECT 1 FROM public.model_attempts a JOIN public.jobs j ON j.workspace_id=a.workspace_id AND j.id=a.job_id
    JOIN target t ON t.id=a.model_config_id AND t.connection_id=a.connection_id AND t.provider=a.provider AND t.model=a.model
    WHERE a.workspace_id='{w}' AND a.id={anchor['attempt_id']} AND a.job_id='{anchor['job_id']}'
    AND j.entity_id='{anchor['plan_id']}' AND a.operation='verify_grounding' AND a.status='succeeded' AND a.result_code='SUCCEEDED')));
ROLLBACK;
"""


def validate_profile(value):
    require(value is None or isinstance(value, dict) and set(value) == {'revision', 'max_output_tokens', 'reasoning', 'require_native_strict'}
            and request.revision(value['revision']) and value['revision'] > 0
            and type(value['max_output_tokens']) is int and 1024 <= value['max_output_tokens'] <= 131072
            and value['reasoning'] in {'none', 'minimal', 'low', 'medium', 'high'}
            and type(value['require_native_strict']) is bool, 'PROFILE_INVALID')


def validate_proof(proof, *, before=True):
    require(isinstance(proof, dict) and proof.get('version') == 1 and proof.get('kind') == 'proposal_settings_repair_proof'
            and isinstance(proof.get('guards'), dict) and set(proof['guards']) == GUARDS
            and all(type(v) is bool for v in proof['guards'].values()), 'PROOF_INVALID')
    request.validate_selection(proof.get('selection'))
    validate_anchor(proof.get('anchor'))
    require(request.uuid_value(proof.get('actor_id')) and isinstance(proof.get('observed_at'), str)
            and isinstance(proof.get('protected'), dict) and set(proof['protected']) == set(PROTECTED)
            and all(isinstance(v, str) and re.fullmatch('[a-f0-9]{64}', v) for v in proof['protected'].values()), 'PROOF_INVALID')
    if before:
        for name in GUARDS:
            require(proof['guards'][name] is True, 'PRECONDITION_' + name.upper())
    w = proof['selection']['workspace_id']
    for name, task in (('route', 'verify_grounding'), ('default_route', 'default')):
        row = proof.get(name)
        require(isinstance(row, dict) and row.get('workspace_id') == w and row.get('task') == task
                and request.uuid_value(row.get('id')) and request.revision(row.get('revision'))
                and row.get('strategy') in {'priority', 'round_robin'} and type(row.get('inherit_default')) is bool
                and isinstance(row.get('model_ids'), list) and len(row['model_ids']) <= 32
                and all(request.uuid_value(value) for value in row['model_ids']), 'ROUTE_INVALID')
        validate_profile(row.get('profile'))
    settings = proof.get('settings')
    require(isinstance(settings, dict) and settings.get('workspace_id') == w and request.uuid_value(settings.get('id'))
            and request.revision(settings.get('revision')) and settings.get('enabled') is True
            and type(settings.get('max_parallel_requests')) is int and settings['max_parallel_requests'] in {2, 4},
            'EXECUTION_SCOPE_CHANGED')
    target = proof.get('target')
    require(isinstance(target, dict) and target.get('id') == proof['anchor']['model_config_id']
            and target.get('model') == proof['anchor']['model'] and target.get('enabled') is True
            and target.get('connection_enabled') is True and request.uuid_value(target.get('connection_id'))
            and request.revision(target.get('revision')) and request.revision(target.get('connection_revision')),
            'TARGET_CHANGED')
    require(proof['default_route']['model_ids'] and target['id'] in
            (proof['route']['model_ids'] + proof['default_route']['model_ids']), 'TARGET_NOT_IN_CURRENT_ROUTE')
    return proof


def inspect(database, selection, anchor):
    proof = request.read(database, inspection_sql(selection, anchor))
    require(proof.get('selection') == selection and proof.get('anchor') == anchor, 'INSPECTION_TARGET_CHANGED')
    return validate_proof(proof)


def prepare(proof, diagnostic_sha256):
    validate_proof(proof)
    require(isinstance(diagnostic_sha256, str) and re.fullmatch('[a-f0-9]{64}', diagnostic_sha256), 'DIAGNOSTIC_HASH')
    route, settings = proof['route'], proof['settings']
    target = proof['target']['id']
    require(route['model_ids'] != [target] or route['inherit_default'] is not False or settings['max_parallel_requests'] != 4,
            'ALREADY_REPAIRED')
    commands = []
    if route['model_ids'] != [target] or route['inherit_default'] is not False:
        commands.append({'operation': 'model.task_route.save', 'input': {
            'expected_revision': route['revision'], 'task': 'verify_grounding', 'model_ids': [target],
            'inherit_default': False, 'strategy': route['strategy'], 'profile': route['profile']}})
    if settings['max_parallel_requests'] == 2:
        commands.append({'operation': 'model.execution.configure', 'input': {
            'expected_revision': settings['revision'], 'enabled': True, 'max_parallel_requests': 4}})
    body = {'commands': commands}
    # Stable across diagnostic clocks, workflow runs and retries. Existing
    # encrypted intent refuses a second send even if acknowledgement is lost.
    identity = digest([proof['selection'], proof['actor_id'], body])
    key = str(uuid.uuid5(NAMESPACE, identity))
    return {'version': 1, 'kind': 'proposal_settings_prepared_request', 'proof': proof,
        'diagnostic_sha256': diagnostic_sha256, 'body': body, 'body_sha256': digest(body), 'idempotency_key': key,
        'command_keys': [hashlib.sha256(('batch:' + key + ':' + str(i + 1)).encode()).hexdigest() for i in range(len(commands))],
        'prepared_object': 'diagnostics/proposal-settings-' + identity + '.prepared.bundle'}


def plan(database, incoming):
    selection, anchor = anchor_from_report(incoming)
    proof = inspect(database, selection, anchor)
    diagnostic = incoming['admission_diagnostic']
    observed_settings = {k: proof['settings'][k] for k in ('enabled', 'revision', 'max_parallel_requests', 'admitted_after')}
    require(observed_settings == diagnostic.get('modern_execution'), 'DIAGNOSTIC_SETTINGS_CHANGED')
    for name in ('route', 'default_route'):
        row = proof[name]
        match = [value for value in diagnostic.get('verifier_routes', []) if value.get('task') == row['task']]
        require(len(match) == 1 and all(match[0].get(k) == row[k] for k in
            ('revision', 'inherit_default', 'strategy', 'profile', 'next_position'))
            and [m['id'] for m in match[0]['models']] == row['model_ids'], 'DIAGNOSTIC_ROUTE_CHANGED')
    models = [model for route in diagnostic['verifier_routes'] for model in route['models']
              if model['id'] == proof['target']['id']]
    require(models and all(all(model.get(k) == proof['target'][k] for k in
        ('model', 'enabled', 'revision', 'connection_enabled', 'connection_revision')) for model in models),
        'DIAGNOSTIC_TARGET_CHANGED')
    return prepare(proof, digest(incoming))


def validate_prepared(prepared):
    require(isinstance(prepared, dict) and prepared == prepare(prepared.get('proof'), prepared.get('diagnostic_sha256')),
            'PREPARED_CHANGED')
    return prepared


def compare_fresh(prepared, fresh):
    validate_proof(fresh)
    require({k: v for k, v in fresh.items() if k != 'observed_at'} ==
            {k: v for k, v in prepared['proof'].items() if k != 'observed_at'}, 'CHANGED_BEFORE_SEND')
    return fresh


def recheck(database, prepared):
    validate_prepared(prepared)
    return compare_fresh(prepared, inspect(database, prepared['proof']['selection'], prepared['proof']['anchor']))


def send(client, session, prepared, persist, before_send=None):
    validate_prepared(prepared)
    require(session.get('user', {}).get('id') == prepared['proof']['actor_id'] and session.get('access_token'), 'SESSION_MISMATCH')
    require(callable(persist) and callable(before_send), 'DURABLE_RECHECK_REQUIRED')
    require(prepared['prepared_object'] not in _ATTEMPTED, 'ALREADY_ATTEMPTED')
    expected = hashlib.sha256(encoded(prepared)).hexdigest()
    persisted = persist(prepared)
    require(isinstance(persisted, str) and hmac.compare_digest(expected, persisted), 'INTENT_READBACK_FAILED')
    fresh = before_send()
    require(hashlib.sha256(encoded(prepared)).hexdigest() == expected, 'PREPARED_CHANGED')
    compare_fresh(prepared, fresh)
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(fresh['observed_at'])).total_seconds()
    except (ValueError, TypeError):
        raise RuntimeError('PROPOSAL_SETTINGS_FRESH_TIME_INVALID') from None
    require(0 <= age <= 120, 'FRESH_PROOF_STALE')
    _ATTEMPTED.add(prepared['prepared_object'])
    response = client.request('/functions/v1/api/v1/commands', token=session['access_token'], method='POST',
        data=prepared['body'], headers={'Idempotency-Key': prepared['idempotency_key']})
    return {'sent': True, 'http_status': response.status, 'accepted': 200 <= response.status < 300,
            'unknown': response.status == 0, 'response_sha256': hashlib.sha256(response.body).hexdigest()}


def acceptance_sql(prepared):
    validate_prepared(prepared)
    proof = prepared['proof']
    w, actor = proof['selection']['workspace_id'], proof['actor_id']
    commands = prepared['body']['commands']
    bindings = ','.join('(' + str(i) + ',' + sql_json(command) + ", '" + prepared['command_keys'][i] + "')"
                        for i, command in enumerate(commands))
    return request.PREFIX + f"""
WITH expected(ordinal,command,key) AS (VALUES {bindings}), accepted AS (
 SELECT e.ordinal,r.result FROM expected e JOIN app_private.idempotency_records r
 ON r.workspace_id='{w}' AND r.actor_id='{actor}' AND r.method='COMMAND' AND r.route=e.command->>'operation' AND r.key=e.key
 AND r.body_hash=encode(sha256(convert_to((e.command->'input')::text,'UTF8')),'hex')
)
SELECT jsonb_build_object('count',(SELECT count(*) FROM accepted),
 'batch',EXISTS(SELECT 1 FROM app_private.command_batch_receipts WHERE workspace_id='{w}' AND actor_id='{actor}'
  AND idempotency_key='{prepared['idempotency_key']}' AND state='ready' AND result_count={len(commands)}
  AND body_hash=encode(sha256(convert_to(({sql_json(commands)})::text,'UTF8')),'hex')),
 'results',coalesce((SELECT jsonb_agg(result ORDER BY ordinal) FROM accepted),'[]'::jsonb));
ROLLBACK;
"""


def verify_result(database, prepared):
    validate_prepared(prepared)
    accepted = request.read(database, acceptance_sql(prepared))
    commands = prepared['body']['commands']
    require(accepted.get('count') == len(commands) and accepted.get('batch') is True
            and len(accepted.get('results', [])) == len(commands), 'ACCEPTANCE_UNPROVEN')
    before = prepared['proof']
    after = request.read(database, inspection_sql(before['selection'], before['anchor']))
    validate_proof(after, before=False)
    require(after['selection'] == before['selection'] and after['anchor'] == before['anchor']
            and after['actor_id'] == before['actor_id'] and after['protected'] == before['protected']
            and after['plan'] == before['plan'] and after['default_route'] == before['default_route']
            and after['target'] == before['target'] and after['saved_catalog_count'] == before['saved_catalog_count'],
            'PRESERVED_STATE_CHANGED')
    expected = {'route': dict(before['route']), 'settings': dict(before['settings'])}
    for command, result in zip(commands, accepted['results']):
        name = 'route' if command['operation'] == 'model.task_route.save' else 'settings'
        changes = ({'model_ids': [before['target']['id']], 'inherit_default': False, 'next_position': 0} if name == 'route'
                   else {'max_parallel_requests': 4})
        expected[name].update(changes, revision=before[name]['revision'] + 1)
        require(result == after[name], 'COMMAND_READBACK_CHANGED')
    for name in ('route', 'settings'):
        actual = dict(after[name]); expected[name].pop('updated_at', None); actual.pop('updated_at', None)
        require(actual == expected[name], 'SETTING_READBACK_CHANGED')
    return {'accepted': True, 'command_count': len(commands), 'route': after['route'], 'settings': after['settings'],
            'protected_configuration_unchanged': True, 'saved_catalog_count': after['saved_catalog_count'],
            'existing_job_catalogs_retargeted': False, 'generation_requested': False}
