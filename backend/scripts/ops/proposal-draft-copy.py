#!/usr/bin/env python3
"""Ordinary DRAFT review copy through one canonical Owner export command.

This does not accept generated issuance, clear review findings, approve content,
or call a model. The coordinator owns credentials, durable encrypted intent,
the absolute run deadline and cleanup. Observation SQL is read-only; canonical
authenticated download GETs may perform normal expiry/audit bookkeeping.
"""
import base64
import hashlib
import hmac
import importlib.util
import io
import json
from pathlib import Path
import re
import sys
import time
import unicodedata
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone

HERE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec); sys.modules[name] = value; spec.loader.exec_module(value)
    return value


REQUEST = module('draft_copy_request', 'proposal-trial-request.py')
files = module('draft_copy_file_primitives', 'proposal-trial-download.py')
encoded, digest, uuid_value, revision = REQUEST.encoded, REQUEST.digest, REQUEST.uuid_value, REQUEST.revision
MAX_BYTES = 256 * 1024
OPERATION = 'export.package.prepare'
NAMESPACE = uuid.UUID('b8f84f5c-cc0b-50c9-9a9b-d30a861252c3')
PRESERVED = ('plans', 'steps', 'jobs', 'versions', 'sections', 'requirements', 'questions', 'usage', 'attempts',
             'graphs', 'results', 'checkpoints', 'budgets', 'review_inputs', 'reviews', 'approvals', 'compliance')
TARGET_KEYS = {'workspace_id', 'opportunity_id', 'proposal_id', 'plan_id', 'proposal_version_id', 'version_revision',
    'version_content_hash', 'actor_id', 'failed_issuance_request_id', 'package_id', 'job_id', 'accepted_at', 'deadline_at',
    'required_volumes', 'review_hash', 'review_finding_count', 'blocking_finding_count', 'preserved'}
_ATTEMPTED = set()


class DraftCopyError(Exception):
    pass


def require(value, code='PROPOSAL_DRAFT_COPY_INVALID'):
    if not value: raise DraftCopyError(code)


def hash_value(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def stamp(value):
    try:
        parsed = datetime.fromisoformat(value)
        require(parsed.tzinfo is not None)
        return parsed
    except (ValueError, TypeError, OverflowError):
        raise DraftCopyError('PROPOSAL_DRAFT_COPY_CLOCK_INVALID') from None


def _footprint(w, o, p, plan):
    plans = f"select id from public.generation_plans where workspace_id='{w}' and opportunity_id='{o}' and id='{plan}' and kind='proposal'"
    versions = f"select id from public.proposal_versions where workspace_id='{w}' and plan_id='{plan}'"
    jobs = f"select id from public.jobs where workspace_id='{w}' and entity_id in ({plans})"
    threads = f"select id from app_private.model_graph_threads where workspace_id='{w}' and job_id in ({jobs})"
    sources = {
        'plans': ('public.generation_plans', f'id in ({plans})'),
        'steps': ('public.generation_steps', f'plan_id in ({plans})'),
        'jobs': ('public.jobs', f'id in ({jobs})'),
        'versions': ('public.proposal_versions', f'id in ({versions})'),
        'sections': ('public.proposal_sections', f'proposal_version_id in ({versions})'),
        'requirements': ('public.requirements', f'plan_id in ({plans})'),
        'questions': ('public.questions', f'proposal_version_id in ({versions})'),
        'usage': ('public.provider_usage', f'job_id in ({jobs})'),
        'attempts': ('public.model_attempts', f'job_id in ({jobs})'),
        'graphs': ('app_private.model_graph_threads', f'id in ({threads})'),
        'results': ('app_private.model_graph_results', f'thread_id in ({threads})'),
        'checkpoints': ('app_private.model_graph_checkpoints', f'thread_id in ({threads})'),
        'budgets': ('app_private.model_graph_budgets', f'thread_id in ({threads})'),
        'review_inputs': ('public.review_inputs', f"workspace_id='{w}' and proposal_id='{p}' and base_version_id in ({versions})"),
        'reviews': ('public.reviews', f'proposal_version_id in ({versions})'),
        'approvals': ('public.approvals', f'proposal_version_id in ({versions})'),
        'compliance': ('public.compliance_responses', f'proposal_version_id in ({versions})'),
    }
    return 'jsonb_build_object(' + ','.join("'" + key + "',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]')::text,'UTF8')),'hex') from " + table + ' x where ' + where + ')' for key, (table, where) in sources.items()) + ')'


def _source_prefix(base):
    target = REQUEST.existing_target(base)
    sql = files.observer.observation_sql(target)
    marker = 'WITH target AS MATERIALIZED ('
    require(sql.count(marker) == 1, 'PROPOSAL_DRAFT_COPY_SQL_CONTRACT_CHANGED')
    return sql.split(marker, 1)[0]


def inspection_sql(base):
    REQUEST.validate_proof(base)
    p, prop, issuance = base['plan'], base['proposal'], base['latest_issuance']
    require(p and prop and issuance and prop['active_version_id'] is not None)
    w, o, actor = base['selection']['workspace_id'], base['selection']['opportunity_id'], base['actor_id']
    footprint = _footprint(w, o, prop['id'], p['id'])
    return _source_prefix(base) + f"""
WITH selected AS MATERIALIZED (
 SELECT p.*,prop.active_version_id,prop.revision AS proposal_revision FROM public.generation_plans p
 JOIN public.proposals prop ON prop.workspace_id=p.workspace_id AND prop.id=p.proposal_id
 WHERE p.workspace_id='{w}' AND p.opportunity_id='{o}' AND p.id='{p['id']}' AND prop.id='{prop['id']}'
), version AS MATERIALIZED (
 SELECT v.* FROM public.proposal_versions v JOIN selected p ON v.workspace_id=p.workspace_id AND v.plan_id=p.id AND v.id=p.active_version_id
), manifest AS MATERIALIZED (
 SELECT coalesce(jsonb_agg(ref order by ref::text),'[]') AS value FROM (SELECT DISTINCT x->'reference' ref
 FROM selected p CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(p.frozen_context->'notice')||coalesce(p.frozen_context->'blocks','[]')||coalesce(p.frozen_context->'knowledge','[]')||coalesce(p.frozen_context->'reviews','[]')||coalesce(p.frozen_context->'rates','[]')) x WHERE x ? 'reference') refs
), binding AS MATERIALIZED (
 SELECT encode(sha256(convert_to(jsonb_build_array(v.id,v.revision,'draft','ordinary-2',app_private.approval_gate('{w}',v.id)-'blockers',manifest.value)::text,'UTF8')),'hex') AS hash
 FROM version v CROSS JOIN manifest
), package AS MATERIALIZED (
 SELECT e.* FROM public.export_packages e JOIN version v ON v.id=e.proposal_version_id AND v.workspace_id=e.workspace_id
 CROSS JOIN binding b WHERE e.mode='draft' AND e.renderer_version='ordinary-2' AND e.binding_hash=b.hash
)
SELECT jsonb_build_object('observed_at',clock_timestamp(),
 'version',(SELECT jsonb_build_object('id',id,'revision',revision,'content_hash',content_hash,'status',status,
  'required_volumes',case when separate_volumes then jsonb_build_array('technical','financial') else jsonb_build_array('combined') end,
  'review_hash',encode(sha256(convert_to(review_result::text,'UTF8')),'hex'),
  'review_finding_count',jsonb_array_length(coalesce(review_result->'findings','[]')),
  'blocking_finding_count',(SELECT count(*) FROM jsonb_array_elements(coalesce(review_result->'findings','[]')) f WHERE f->>'severity'='blocking')) FROM version),
 'preserved',{footprint},
 'existing',(SELECT jsonb_build_object('package_id',id,'job_id',current_job_id,'accepted_at',accepted_at,'deadline_at',deadline_at) FROM package),
 'guards',jsonb_build_object(
  'current_target',(SELECT count(*) FROM selected)=1 AND (SELECT active_version_id='{prop['active_version_id']}'::uuid AND revision={p['revision']} AND proposal_revision={prop['revision']} FROM selected),
  'failed_generated_issuance',EXISTS(SELECT 1 FROM selected p JOIN public.proposal_issuance_requests r ON r.workspace_id=p.workspace_id AND r.plan_id=p.id AND r.id=p.issuance_request_id
   WHERE p.status='failed' AND p.stage='completed' AND p.error_code='GENERATED_DELIVERY_VALIDATION_FAILED' AND r.id='{issuance['id']}' AND r.outcome='failed' AND r.error_code=p.error_code),
  'draft_version',(SELECT status='draft' AND revision>0 FROM version),
  'owner',(SELECT count(*)=1 AND bool_and(m.user_id='{actor}'::uuid) FROM public.memberships m JOIN public.identity_allowlist a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
   WHERE m.workspace_id='{w}' AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner'),
  'sources',current_setting('ops.current_issuance_sources')='passed',
  'unique_package',(SELECT count(*) FROM package)<=1));
ROLLBACK;
"""


def _hashes(value):
    require(isinstance(value, dict) and set(value) == set(PRESERVED) and all(hash_value(v) for v in value.values()))


def _volumes(value):
    require(value in (['combined'], ['technical', 'financial']))


def validate_proof(proof):
    require(isinstance(proof, dict) and set(proof) == {'version', 'kind', 'selection', 'actor_id', 'base', 'copy'}
        and type(proof['version']) is int and proof['version'] == 1 and proof['kind'] == 'proposal_draft_copy_proof')
    base = REQUEST.validate_proof(proof['base'])
    require(proof['selection'] == base['selection'] and proof['actor_id'] == base['actor_id'])
    for key in REQUEST.GUARDS - {'usage_ready'}:
        require(base['guards'][key] is True, 'PROPOSAL_DRAFT_COPY_PRECONDITION_' + key.upper())
    data = proof['copy']; guards = {'current_target', 'failed_generated_issuance', 'draft_version', 'owner', 'sources', 'unique_package'}
    require(isinstance(data, dict) and set(data) == {'observed_at', 'version', 'preserved', 'existing', 'guards'}
        and isinstance(data['guards'], dict) and set(data['guards']) == guards and all(v is True for v in data['guards'].values()), 'PROPOSAL_DRAFT_COPY_PRECONDITION')
    stamp(data['observed_at']); _hashes(data['preserved'])
    v = data['version']
    require(isinstance(v, dict) and set(v) == {'id', 'revision', 'content_hash', 'status', 'required_volumes', 'review_hash', 'review_finding_count', 'blocking_finding_count'}
        and v['id'] == base['proposal']['active_version_id'] and revision(v['revision']) and v['revision'] > 0
        and v['status'] == 'draft' and hash_value(v['content_hash']) and hash_value(v['review_hash'])
        and type(v['review_finding_count']) is int and type(v['blocking_finding_count']) is int
        and 1 <= v['blocking_finding_count'] <= v['review_finding_count'] <= 2048)
    _volumes(v['required_volumes'])
    if data['existing'] is not None:
        e = data['existing']; require(isinstance(e, dict) and set(e) == {'package_id', 'job_id', 'accepted_at', 'deadline_at'}
            and uuid_value(e['package_id']) and uuid_value(e['job_id']) and (stamp(e['deadline_at']) - stamp(e['accepted_at'])).total_seconds() == 600)
    require(len(encoded(proof)) <= MAX_BYTES)
    return proof


def inspect(database, selection, request=REQUEST):
    request.validate_selection(selection)
    base = request.validate_proof(request.read(database, request.inspection_sql(selection)))
    require(base['selection'] == selection)
    data = request.read(database, inspection_sql(base), max_bytes=MAX_BYTES)
    return validate_proof({'version': 1, 'kind': 'proposal_draft_copy_proof', 'selection': selection,
        'actor_id': base['actor_id'], 'base': base, 'copy': data})


def _target(proof, package):
    base, v = proof['base'], proof['copy']['version']
    return {**{key: proof['selection'][key] for key in ('workspace_id', 'opportunity_id')},
        'proposal_id': base['proposal']['id'], 'plan_id': base['plan']['id'], 'proposal_version_id': v['id'],
        'version_revision': v['revision'], 'version_content_hash': v['content_hash'], 'actor_id': proof['actor_id'],
        'failed_issuance_request_id': base['latest_issuance']['id'], **package,
        **{key: v[key] for key in ('required_volumes', 'review_hash', 'review_finding_count', 'blocking_finding_count')},
        'preserved': proof['copy']['preserved']}


def validate_target(target):
    ids = ('workspace_id', 'opportunity_id', 'proposal_id', 'plan_id', 'proposal_version_id', 'actor_id', 'failed_issuance_request_id', 'package_id', 'job_id')
    require(isinstance(target, dict) and set(target) == TARGET_KEYS and all(uuid_value(target[k]) for k in ids)
        and revision(target['version_revision']) and target['version_revision'] > 0 and hash_value(target['version_content_hash'])
        and hash_value(target['review_hash']) and type(target['review_finding_count']) is int and type(target['blocking_finding_count']) is int
        and 1 <= target['blocking_finding_count'] <= target['review_finding_count'] <= 2048
        and (stamp(target['deadline_at']) - stamp(target['accepted_at'])).total_seconds() == 600)
    _hashes(target['preserved']); _volumes(target['required_volumes'])
    return target


def prepare(proof):
    validate_proof(proof)
    value = {'version': 1, 'kind': 'proposal_draft_copy_prepared', 'proof': proof, 'selection': proof['selection'], 'operation': OPERATION}
    if proof['copy']['existing'] is not None:
        return value | {'mode': 'observe_existing', 'target': validate_target(_target(proof, proof['copy']['existing']))}
    v = proof['copy']['version']
    body = {'commands': [{'operation': OPERATION, 'input': {'proposal_version_id': v['id'], 'expected_revision': v['revision'], 'mode': 'draft'}}]}
    identity = digest([proof['selection'], proof['actor_id'], OPERATION, v['id'], v['revision'], v['content_hash'], v['review_hash'], proof['base']['latest_issuance']['id']])
    key = str(uuid.uuid5(NAMESPACE, identity))
    return value | {'mode': 'send', 'body': body, 'body_sha256': digest(body), 'idempotency_key': key,
        'command_key': hashlib.sha256(('batch:' + key + ':1').encode()).hexdigest(),
        'prepared_object': 'diagnostics/proposal-draft-copy-' + identity + '.prepared.bundle'}


def validate_prepared(prepared):
    require(isinstance(prepared, dict) and prepared == prepare(prepared.get('proof')), 'PROPOSAL_DRAFT_COPY_PREPARED_CHANGED')
    return prepared


def recheck(database, selection, prepared):
    validate_prepared(prepared)
    fresh = prepare(inspect(database, selection))
    def stable(value):
        value = json.loads(encoded(value)); value['proof']['base'].pop('observed_at', None); value['proof']['copy'].pop('observed_at', None)
        value['proof']['base'].pop('retry_usage', None)
        value['proof']['base']['guards'].pop('usage_ready', None)
        return value
    require(stable(fresh) == stable(prepared), 'PROPOSAL_DRAFT_COPY_CHANGED_BEFORE_SEND')
    return fresh


def send(client, session, prepared, persist, before_send=None):
    validate_prepared(prepared); require(prepared['mode'] == 'send', 'PROPOSAL_DRAFT_COPY_OBSERVE_ONLY')
    require(isinstance(session, dict) and session.get('user', {}).get('id') == prepared['proof']['actor_id'] and isinstance(session.get('access_token'), str) and session['access_token'], 'PROPOSAL_DRAFT_COPY_SESSION_INVALID')
    require(callable(persist) and prepared['prepared_object'] not in _ATTEMPTED, 'PROPOSAL_DRAFT_COPY_ALREADY_ATTEMPTED')
    expected = hashlib.sha256(encoded(prepared)).hexdigest()
    require(hmac.compare_digest(expected, persist(prepared)), 'PROPOSAL_DRAFT_COPY_PERSISTENCE_UNPROVEN')
    if before_send is not None: before_send()
    validate_prepared(prepared)
    require(hmac.compare_digest(expected, hashlib.sha256(encoded(prepared)).hexdigest()), 'PROPOSAL_DRAFT_COPY_PREPARED_CHANGED')
    age = (datetime.now(timezone.utc) - stamp(prepared['proof']['copy']['observed_at'])).total_seconds()
    require(0 <= age <= 120, 'PROPOSAL_DRAFT_COPY_PROOF_STALE')
    _ATTEMPTED.add(prepared['prepared_object'])
    response = client.request('/functions/v1/api/v1/commands', token=session['access_token'], method='POST', data=prepared['body'], headers={'Idempotency-Key': prepared['idempotency_key']})
    code = None
    try:
        raw = json.loads(response.body).get('error', {}).get('code')
        if isinstance(raw, str) and re.fullmatch('[A-Z][A-Z0-9_]{0,119}', raw): code = raw
    except (ValueError, AttributeError, TypeError): pass
    return {'sent': True, 'accepted': 200 <= response.status < 300, 'unknown': response.status == 0,
        'http_status': response.status, 'api_error_code': code, 'response_sha256': hashlib.sha256(response.body).hexdigest()}


def acceptance_sql(prepared):
    validate_prepared(prepared); require(prepared['mode'] == 'send')
    proof, key = prepared['proof'], prepared['command_key']; w = proof['selection']['workspace_id']; actor = proof['actor_id']; v = proof['copy']['version']
    return REQUEST.PREFIX + f"""
SELECT r.result->>'id' AS package_id FROM app_private.idempotency_records r
 JOIN public.export_packages p ON p.workspace_id=r.workspace_id AND p.id=(r.result->>'id')::uuid
 WHERE r.workspace_id='{w}' AND r.actor_id='{actor}' AND r.method='COMMAND' AND r.route='{OPERATION}' AND r.key='{key}'
 AND r.body_hash=encode(sha256(convert_to(jsonb_build_object('proposal_version_id','{v['id']}','expected_revision',{v['revision']},'mode','draft')::text,'UTF8')),'hex')
 AND p.proposal_version_id='{v['id']}' AND p.version_revision={v['revision']} AND p.mode='draft' AND p.renderer_version='ordinary-2';
ROLLBACK;
"""


def verify_result(database, prepared):
    validate_prepared(prepared)
    # One scalar JSON projection avoids trusting the POST acknowledgement.
    sql = acceptance_sql(prepared).replace("SELECT r.result->>'id' AS package_id", "SELECT jsonb_build_object('package_id',p.id,'job_id',p.current_job_id,'accepted_at',p.accepted_at,'deadline_at',p.deadline_at)")
    package = REQUEST.read(database, sql)
    require(isinstance(package, dict) and set(package) == {'package_id', 'job_id', 'accepted_at', 'deadline_at'}, 'PROPOSAL_DRAFT_COPY_ACCEPTANCE_UNPROVEN')
    target = validate_target(_target(prepared['proof'], package))
    # Independently check exact version/source/history before returning identity.
    sample(database, target)
    return target


def observation_sql(target):
    validate_target(target)
    w, o, prop, p = (target[k] for k in ('workspace_id', 'opportunity_id', 'proposal_id', 'plan_id'))
    base = {'workspace_id': w, 'opportunity_id': o, 'proposal_id': prop, 'plan_id': p,
        'issuance_request_id': target['failed_issuance_request_id'], 'actor_id': target['actor_id'], 'operation': 'generation.retry'}
    sql = files.observer.observation_sql(base); marker = 'WITH target AS MATERIALIZED ('; require(sql.count(marker) == 1)
    prefix = sql.split(marker, 1)[0]
    return prefix + f"""
WITH package AS MATERIALIZED (SELECT * FROM public.export_packages WHERE workspace_id='{w}' AND id='{target['package_id']}'),
 version AS MATERIALIZED (SELECT v.* FROM public.proposal_versions v JOIN public.proposals prop ON prop.workspace_id=v.workspace_id AND prop.id=v.proposal_id AND prop.active_version_id=v.id
 WHERE v.workspace_id='{w}' AND v.id='{target['proposal_version_id']}' AND v.proposal_id='{prop}' AND v.plan_id='{p}'),
 job AS MATERIALIZED (SELECT j.* FROM public.jobs j JOIN package p ON p.current_job_id=j.id AND p.workspace_id=j.workspace_id),
 artifacts AS MATERIALIZED (SELECT s.export_id,s.volume,a.id,coalesce(a.status,'pending') AS status,a.content_hash,a.expected_size,a.original_name,a.mime_type
  FROM public.export_package_volumes s JOIN package p ON p.workspace_id=s.workspace_id AND p.id=s.package_id
  JOIN public.export_requests r ON r.workspace_id=s.workspace_id AND r.id=s.export_id LEFT JOIN public.export_artifacts a ON a.workspace_id=s.workspace_id AND a.id=s.artifact_id)
SELECT jsonb_build_object('observed_at',clock_timestamp(),'preserved',{_footprint(w,o,prop,p)},
 'package',(SELECT jsonb_build_object('id',id,'status',status,'error_code',error_code,'mode',mode,'renderer_version',renderer_version,
  'proposal_version_id',proposal_version_id,'version_revision',version_revision,'current_job_id',current_job_id,'accepted_at',accepted_at,'deadline_at',deadline_at,'required_volumes',required_volumes,'updated_at',updated_at) FROM package),
 'job',(SELECT jsonb_build_object('id',id,'type',type,'entity_id',entity_id,'status',status,'error_code',error_code) FROM job),
 'findings',(SELECT coalesce(review_result->'findings','[]') FROM version),
 'artifacts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY volume),'[]') FROM artifacts a),
 'guards',jsonb_build_object(
  'source',current_setting('ops.current_issuance_sources')='passed',
  'owner',(SELECT count(*)=1 AND bool_and(m.user_id='{target['actor_id']}'::uuid) FROM public.memberships m JOIN public.identity_allowlist a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id WHERE m.workspace_id='{w}' AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner'),
  'version',(SELECT revision={target['version_revision']} AND content_hash='{target['version_content_hash']}' AND status='draft' AND encode(sha256(convert_to(review_result::text,'UTF8')),'hex')='{target['review_hash']}' FROM version),
  'latest_plan',(SELECT id='{p}'::uuid FROM public.generation_plans WHERE workspace_id='{w}' AND opportunity_id='{o}' AND kind='proposal' ORDER BY created_at DESC,id DESC LIMIT 1),
  'failed_issuance',EXISTS(SELECT 1 FROM public.generation_plans p JOIN public.proposal_issuance_requests r ON r.workspace_id=p.workspace_id AND r.plan_id=p.id AND r.id=p.issuance_request_id
   WHERE p.workspace_id='{w}' AND p.id='{p}' AND p.status='failed' AND p.stage='completed' AND p.error_code='GENERATED_DELIVERY_VALIDATION_FAILED'
   AND r.id='{target['failed_issuance_request_id']}' AND r.outcome='failed' AND r.error_code='GENERATED_DELIVERY_VALIDATION_FAILED'),
  'no_restore',NOT EXISTS(SELECT 1 FROM public.restore_sessions WHERE workspace_id='{w}' AND state IN('staging','committing')),
  'snapshot_reviews',NOT EXISTS(SELECT 1 FROM public.export_package_volumes s JOIN package p ON p.workspace_id=s.workspace_id AND p.id=s.package_id JOIN public.export_requests r ON r.workspace_id=s.workspace_id AND r.id=s.export_id CROSS JOIN version v WHERE r.mode<>'draft' OR r.snapshot->'review_result' IS DISTINCT FROM v.review_result)));
ROLLBACK;
"""


def _observation(value, target, previous=None):
    validate_target(target)
    require(isinstance(value, dict) and set(value) == {'observed_at', 'preserved', 'package', 'job', 'findings', 'artifacts', 'guards'})
    require(isinstance(value['guards'], dict) and set(value['guards']) == {'source', 'owner', 'version', 'latest_plan', 'failed_issuance', 'no_restore', 'snapshot_reviews'} and all(v is True for v in value['guards'].values()), 'PROPOSAL_DRAFT_COPY_CURRENTNESS_FAILED')
    require(value['preserved'] == target['preserved'], 'PROPOSAL_DRAFT_COPY_HISTORY_CHANGED')
    package, job = value['package'], value['job']
    require(isinstance(package, dict) and package['id'] == target['package_id'] and package['proposal_version_id'] == target['proposal_version_id']
        and package['version_revision'] == target['version_revision'] and package['mode'] == 'draft' and package['renderer_version'] == 'ordinary-2'
        and package['current_job_id'] == target['job_id'] and package['accepted_at'] == target['accepted_at'] and package['deadline_at'] == target['deadline_at']
        and package['required_volumes'] == target['required_volumes'] and package['status'] in {'preparing', 'ready', 'blocked'})
    require(isinstance(job, dict) and job['id'] == target['job_id'] and job['type'] == 'render_export' and job['entity_id'] == target['package_id'])
    now = stamp(value['observed_at']); require(now >= stamp(target['accepted_at']))
    if previous is not None:
        require(previous.get('target') == target and now >= stamp(previous['sample']['observed_at']), 'PROPOSAL_DRAFT_COPY_CLOCK_CHANGED')
    findings = value['findings']; require(isinstance(findings, list) and len(findings) == target['review_finding_count']
        and sum(f.get('severity') == 'blocking' for f in findings) == target['blocking_finding_count']
        and all(isinstance(f, dict) and isinstance(f.get('detail'), str) and 0 < len(f['detail']) <= 20000 for f in findings))
    artifacts = value['artifacts']; require(isinstance(artifacts, list) and len(artifacts) == len(target['required_volumes']) and sorted(a['volume'] for a in artifacts) == sorted(target['required_volumes']))
    outcome, code = package['status'], package['error_code']
    if outcome == 'ready':
        require(job['status'] == 'succeeded' and stamp(package['updated_at']) <= stamp(target['deadline_at']))
        for artifact in artifacts: _artifact(artifact)
    elif outcome == 'preparing' and now >= stamp(target['deadline_at']): outcome, code = 'blocked', 'EXPORT_ISSUANCE_TIMEOUT'
    elif outcome == 'preparing' and job['status'] in {'failed', 'blocked', 'canceled'}: outcome, code = 'blocked', job['error_code'] or 'EXPORT_RENDER_TERMINATED'
    require(code is None or isinstance(code, str) and re.fullmatch('[A-Z][A-Z0-9_]{0,119}', code))
    return {'version': 1, 'kind': 'proposal_draft_copy_observation', 'target': target, 'outcome': outcome, 'code': code,
        'draft_copy_only': True, 'generated_issuance_passed': False, 'sample': value}


def sample(database, target, previous=None):
    return _observation(REQUEST.read(database, observation_sql(target), max_bytes=MAX_BYTES), target, previous)


def public_receipt(observation):
    require(isinstance(observation, dict) and observation == _observation(observation.get('sample'), observation.get('target')))
    return {'draft_copy': observation['outcome'], 'code': observation['code'], 'draft_copy_only': True,
        'generated_issuance_issued': False, 'approval_granted': False, 'model_calls': 0,
        'artifact_count': len(observation['sample']['artifacts']) if observation['outcome'] == 'ready' else 0,
        'review_finding_count': observation['target']['review_finding_count'], 'blocking_finding_count': observation['target']['blocking_finding_count']}


def _artifact(value):
    require(isinstance(value, dict) and set(value) == {'id', 'export_id', 'volume', 'status', 'content_hash', 'expected_size', 'original_name', 'mime_type'}
        and uuid_value(value['id']) and uuid_value(value['export_id']) and value['volume'] in {'combined', 'technical', 'financial'}
        and value['status'] == 'ready' and hash_value(value['content_hash']) and type(value['expected_size']) is int and 0 < value['expected_size'] <= files.MAX_FILE_BYTES
        and files._safe_name(value['original_name']) and value['mime_type'] == files.DOCX_MIME, 'PROPOSAL_DRAFT_COPY_ARTIFACT_INVALID')
    return value


def download(client, config, session, observation):
    require(public_receipt(observation)['draft_copy'] == 'ready', 'PROPOSAL_DRAFT_COPY_NOT_READY')
    target = observation['target']; files._origin(config.origin)
    require(getattr(client, 'config', None) is config and isinstance(config.anon_key, str) and config.anon_key and not re.search(r'[\r\n]', config.anon_key))
    redirects = [h for h in getattr(client.opener, 'handlers', []) if isinstance(h, urllib.request.HTTPRedirectHandler)]
    require(len(redirects) == 1 and type(redirects[0]).__name__ == 'NoRedirect' and type(redirects[0]).redirect_request is not urllib.request.HTTPRedirectHandler.redirect_request)
    require(isinstance(session, dict) and session.get('user', {}).get('id') == target['actor_id'] and isinstance(session.get('access_token'), str) and session['access_token'] and not re.search(r'[\r\n]', session['access_token']))
    expected = [_artifact(a) for a in observation['sample']['artifacts']]
    require(len({a['id'] for a in expected}) == len(expected) and len({a['original_name'] for a in expected}) == len(expected))
    deadline = time.monotonic() + files.TOTAL_SECONDS; token = session['access_token']
    def get(path, limit=files.MAX_METADATA_BYTES, mime='application/json'):
        return files._get(client, config, token, path, limit, deadline, mime=mime)
    def current():
        bootstrap = json.loads(get('/functions/v1/api/v1/bootstrap'))['data']; member = bootstrap['membership']
        require(bootstrap['workspace']['id'] == target['workspace_id'] and member['workspace_id'] == target['workspace_id'] and member['user_id'] == target['actor_id'] and member['role'] == 'Owner', 'PROPOSAL_DRAFT_COPY_OWNER_CHANGED')
        package = json.loads(get('/functions/v1/api/v1/export-packages/' + target['package_id']))['data']
        require(package['id'] == target['package_id'] and package['mode'] == 'draft' and package['renderer_version'] == 'ordinary-2' and package['proposal_version_id'] == target['proposal_version_id']
            and package['accepted_at'] == target['accepted_at'] and package['deadline_at'] == target['deadline_at'] and package['status'] == 'ready' and package['job']['id'] == target['job_id'] and package['job']['status'] == 'succeeded'
            and sorted(package['artifacts'], key=lambda a:a['id']) == sorted(expected, key=lambda a:a['id']), 'PROPOSAL_DRAFT_COPY_PACKAGE_CHANGED')
    current(); artifacts, all_text = [], ''
    normal = lambda text: re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', text)).strip()
    for artifact in sorted(expected, key=lambda a:a['volume']):
        endpoint = '/functions/v1/api/v1/export-artifacts/' + artifact['id'] + '/download'
        raw = get(endpoint, files.MAX_FILE_BYTES, files.DOCX_MIME)
        require(len(raw) == artifact['expected_size'] and hashlib.sha256(raw).hexdigest() == artifact['content_hash'], 'PROPOSAL_DRAFT_COPY_BYTES_CHANGED')
        structure = files.inspect_docx(raw)
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            document = files._xml(archive, 'word/document.xml')
            text = '\n'.join(''.join(n.text or '' for n in paragraph.iter(files.W+'t')) for paragraph in document.iter(files.W+'p'))
        require(any(normal(label) in normal(text) for label in ('DRAFT — Review before external use', 'مسودة — تُراجع قبل الاستخدام الخارجي')), 'PROPOSAL_DRAFT_COPY_LABEL_MISSING')
        all_text += '\n' + text
        artifacts.append(artifact | {'endpoint': endpoint, 'bytes_base64': base64.b64encode(raw).decode(), 'docx_structure': structure})
    visible = normal(all_text)
    require(all(normal(f['detail']) in visible for f in observation['sample']['findings']), 'PROPOSAL_DRAFT_COPY_FINDING_MISSING')
    current()
    return {'version': 1, 'kind': 'proposal_draft_copy_download', 'target': target, 'passed': True, 'mode': 'draft', 'renderer_version': 'ordinary-2',
        'draft_copy_only': True, 'generated_issuance_passed': False, 'final_approval_changed': False, 'authenticated_download_verified': True,
        'all_review_findings_preserved': True, 'model_calls': 0, 'provider_calls': 0, 'business_commands': 0, 'artifacts': artifacts}
