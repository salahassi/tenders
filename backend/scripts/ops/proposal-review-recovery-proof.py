#!/usr/bin/env python3
"""Bounded read-only preflight for the canonical missing-review recovery.

The private SQL predicate binds saved evidence/history, never Owner authority.
The coordinator still obtains a genuine current Owner session and submits one
ordinary generation.retry command with its original idempotency rules.
"""
import json
import re
import uuid

ERROR = 'GENERATED_DELIVERY_VALIDATION_FAILED'
KIND = 'proposal_whole_review_recovery_proof'
FUNCTION = 'app_private.legacy_review_recovery_proof(uuid)'
MAX_BYTES = 64 * 1024
PROOF_KEYS = {'plan_id', 'workspace_id', 'original_base_version_id', 'input_hash', 'frozen_context_hash',
    'last_ordinal', 'predecessor_version_id', 'predecessor_version_hash', 'predecessor_sections_hash',
    'predecessor_proposal_revision', 'predecessor_projection_job_id', 'predecessor_projection_job_hash',
    'saved_history', 'section_keys'}
HISTORY_HASHES = {'steps_hash', 'jobs_hash', 'graphs_hash', 'receipts_hash', 'results_hash', 'budgets_hash', 'usage_hash', 'attempts_hash'}


class RecoveryProofError(Exception):
    pass


def require(value, code='PROPOSAL_TRIAL_REVIEW_RECOVERY_INVALID'):
    if not value:
        raise RecoveryProofError(code)


def uuid_value(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def hash_value(value):
    return isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value) is not None


def selected(proof):
    plan, proposal, issuance = proof.get('plan'), proof.get('proposal'), proof.get('latest_issuance')
    return bool(plan and proposal and issuance and plan['status'] == 'failed' and plan['stage'] == 'completed'
        and plan['current_contract'] and proposal['active_version_id'] is not None and issuance['outcome'] == 'failed')


def sql(proof, prefix):
    require(selected(proof))
    plan, proposal, issuance = proof['plan'], proof['proposal'], proof['latest_issuance']
    w, o, actor = proof['selection']['workspace_id'], proof['selection']['opportunity_id'], proof['actor_id']
    require(all(uuid_value(value) for value in (w, o, actor, plan['id'], proposal['id'], proposal['active_version_id'], issuance['id']))
        and hash_value(plan['input_hash']) and type(plan['revision']) is int)
    return prefix + f"""
DO $review_recovery_preflight$
DECLARE value jsonb;result jsonb;code text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.generation_plans p JOIN public.proposals prop
  ON prop.workspace_id=p.workspace_id AND prop.id=p.proposal_id AND prop.opportunity_id=p.opportunity_id
  WHERE p.workspace_id='{w}' AND p.opportunity_id='{o}' AND p.id='{plan['id']}' AND p.proposal_id='{proposal['id']}'
  AND p.kind='proposal' AND p.revision={plan['revision']} AND p.input_hash='{plan['input_hash']}'
  AND p.status='failed' AND p.stage='completed' AND p.error_code='{ERROR}'
  AND p.issuance_request_id='{issuance['id']}' AND prop.active_version_id='{proposal['active_version_id']}')
  OR (SELECT count(*) FROM public.memberships m JOIN public.identity_allowlist a
   ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id WHERE m.workspace_id='{w}'
   AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner')<>1
  OR NOT EXISTS(SELECT 1 FROM public.memberships m JOIN public.identity_allowlist a
   ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id WHERE m.workspace_id='{w}' AND m.user_id='{actor}'
   AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner')
 THEN RAISE EXCEPTION 'PROPOSAL_TRIAL_REVIEW_RECOVERY_CHANGED';END IF;
 IF to_regprocedure('{FUNCTION}') IS NULL THEN
  result:=jsonb_build_object('status','not_installed','code',NULL,'proof',NULL);
 ELSE
  BEGIN
   EXECUTE 'SELECT app_private.legacy_review_recovery_proof($1)' INTO value USING '{plan['id']}'::uuid;
   IF value IS NULL THEN result:=jsonb_build_object('status','not_eligible','code',NULL,'proof',NULL);
   ELSIF octet_length(value::text)>48000 THEN result:=jsonb_build_object('status','oversized','code',NULL,'proof',NULL);
   ELSE result:=jsonb_build_object('status','ready','code',NULL,'proof',value);END IF;
  EXCEPTION WHEN OTHERS THEN
   code:=CASE WHEN SQLERRM IN('GENERATION_BUSY','USAGE_REVIEW_REQUIRED','STALE_INPUT','ROLE_FORBIDDEN',
    'RESTORE_IN_PROGRESS','DELIVERY_SOURCE_UNAVAILABLE','SOURCE_OBLIGATION_RESOLUTION_REQUIRED')
    THEN SQLERRM ELSE 'REVIEW_RECOVERY_PROOF_REJECTED' END;
   result:=jsonb_build_object('status','rejected','code',code,'proof',NULL);
  END;
 END IF;
 PERFORM set_config('ops.proposal_review_recovery',
  (jsonb_build_object('version',1,'kind','{KIND}','actor_id','{actor}')||result)::text,true);
END $review_recovery_preflight$;
SELECT current_setting('ops.proposal_review_recovery')::jsonb;
ROLLBACK;
"""


def validate(value, proof):
    require(isinstance(value, dict) and set(value) == {'version', 'kind', 'actor_id', 'status', 'code', 'proof'}
        and type(value['version']) is int and value['version'] == 1 and value['kind'] == KIND
        and value['actor_id'] == proof['actor_id'] and value['status'] in {'ready', 'not_installed', 'not_eligible', 'oversized', 'rejected'}
        and (value['code'] is None or isinstance(value['code'], str) and re.fullmatch('[A-Z][A-Z0-9_]{0,119}', value['code']))
        and len(json.dumps(value, ensure_ascii=False).encode()) <= MAX_BYTES)
    data = value['proof']
    if value['status'] != 'ready':
        require(data is None and (value['status'] == 'rejected') == (value['code'] is not None))
        return value
    require(value['code'] is None and selected(proof) and isinstance(data, dict) and set(data) == PROOF_KEYS)
    require(data['plan_id'] == proof['plan']['id'] and data['workspace_id'] == proof['selection']['workspace_id']
        and data['input_hash'] == proof['plan']['input_hash']
        and data['original_base_version_id'] == proof['plan'].get('base_version_id')
        and (data['original_base_version_id'] is None or uuid_value(data['original_base_version_id']))
        and data['predecessor_version_id'] == proof['proposal']['active_version_id']
        and data['predecessor_proposal_revision'] == proof['proposal']['revision']
        and type(data['predecessor_proposal_revision']) is int and 0 <= data['predecessor_proposal_revision'] <= 9007199254740991
        and uuid_value(data['predecessor_projection_job_id'])
        and all(hash_value(data[key]) for key in ('frozen_context_hash', 'predecessor_version_hash', 'predecessor_sections_hash', 'predecessor_projection_job_hash'))
        and type(data['last_ordinal']) is int and 1 <= data['last_ordinal'] <= 298)
    history = data['saved_history']
    require(isinstance(history, dict) and set(history) == HISTORY_HASHES | {'step_count', 'accepted_count', 'receipts_complete'}
        and all(hash_value(history[key]) for key in HISTORY_HASHES) and history['receipts_complete'] is True
        and type(history['step_count']) is int and type(history['accepted_count']) is int
        and 1 <= history['accepted_count'] <= history['step_count'] <= 300)
    keys = data['section_keys']
    require(isinstance(keys, list) and 1 <= len(keys) <= 2000 and all(isinstance(key, str) and 1 <= len(key) <= 200
        and key.strip() and not re.search('[\\x00-\\x1f\\x7f]', key) for key in keys)
        and len(set(keys)) == len(keys))
    return value


def ready(proof):
    return proof.get('whole_review_recovery', {}).get('status') == 'ready'


def acceptance_guard(proof, command_key):
    value = validate(proof.get('whole_review_recovery'), proof)
    require(value['status'] == 'ready')
    data = value['proof']
    import hashlib
    key_hash = hashlib.sha256(command_key.encode()).hexdigest()
    prior_base = "NULL::uuid" if data['original_base_version_id'] is None else "'" + data['original_base_version_id'] + "'::uuid"
    history = json.dumps(data['saved_history'], separators=(',', ':')).replace("'", "''")
    sections = json.dumps(data['section_keys'], ensure_ascii=False, separators=(',', ':')).replace("'", "''")
    return f"""AND EXISTS(SELECT 1 FROM app_private.legacy_zero_inventory_review_lineage l
 JOIN public.jobs review_job ON review_job.workspace_id=l.workspace_id AND review_job.id=l.review_job_id
 JOIN public.generation_steps review_step ON review_step.workspace_id=l.workspace_id AND review_step.id=l.review_step_id
  AND review_step.job_id=review_job.id AND review_step.plan_id=l.plan_id
 WHERE l.workspace_id=p.workspace_id AND l.plan_id=p.id AND l.recovery_version=1
 AND l.issuance_request_id=r.id AND l.authorized_by=r.requested_by AND l.operation=r.operation
 AND l.idempotency_key_hash='{key_hash}' AND l.input_hash='{data['input_hash']}'
 AND l.frozen_context_hash='{data['frozen_context_hash']}' AND l.original_last_ordinal={data['last_ordinal']}
 AND l.original_base_version_id IS NOT DISTINCT FROM {prior_base} AND l.saved_history='{history}'::jsonb
 AND l.predecessor_version_id='{data['predecessor_version_id']}' AND l.predecessor_version_hash='{data['predecessor_version_hash']}'
 AND l.predecessor_sections_hash='{data['predecessor_sections_hash']}' AND l.predecessor_proposal_revision={data['predecessor_proposal_revision']}
 AND l.predecessor_projection_job_id='{data['predecessor_projection_job_id']}'
 AND l.predecessor_projection_job_hash='{data['predecessor_projection_job_hash']}'
 AND review_job.type='review_proposal' AND review_job.entity_id=p.id AND review_job.input_hash=p.input_hash
 AND review_job.checkpoint->'minimum_worker_executor'='7'::jsonb
 AND review_step.task='review_proposal' AND review_step.input->'legacy_zero_inventory_review_version'='1'::jsonb
 AND review_step.input->'section_keys'='{sections}'::jsonb
 AND review_step.input->'review_scope_version'='1'::jsonb AND review_step.input->'review_source_version'='1'::jsonb
 AND review_step.input->'coherence_review'='true'::jsonb
 AND l.review_input_hash=encode(sha256(convert_to(review_step.input::text,'UTF8')),'hex')
 AND review_step.input->'requirement_ids'='[]'::jsonb)"""
