#!/usr/bin/env python3
"""Private, selected commercial candidate/report evidence; never public output."""
import json
import re
import uuid
from datetime import datetime

MAX_BYTES = 2 * 1024 * 1024
SNAPSHOT_BYTES = MAX_BYTES - 512 * 1024
LIMIT = 3
KIND = 'private_commercial_inspection'
DIAGNOSTIC_CODES={'EVIDENCE_REFERENCE_INVALID','MODEL_COVERAGE_INCOMPLETE','UNSUPPORTED_COMPANY_CLAIM'}
DIAGNOSTIC_REASONS={'source_missing','quote_empty','source_quote_mismatch','source_kind_mismatch','company_not_verified',
    'candidate_quote_mismatch','requirement_quote_mismatch','numeric_evidence_mismatch','required_ids_mismatch',
    'content_ids_mismatch','candidate_hash_mismatch','duplicate_claim_ids','missing_content_claims','unexpected_content_claims',
    'declared_claim_uncovered','required_content_missing','invalid_finding_reference','unsupported_company_claim','invalid_scope'}


def sql(selection):
    require(isinstance(selection, dict) and set(selection) == {'version','workspace_id','opportunity_id'}
        and type(selection['version']) is int and selection['version'] == 1
        and valid_uuid(selection['workspace_id']) and valid_uuid(selection['opportunity_id']))
    w, o = selection['workspace_id'], selection['opportunity_id']
    return f"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;SET LOCAL statement_timeout='10s';SET LOCAL lock_timeout='1s';
WITH plan AS MATERIALIZED (
 SELECT id FROM public.generation_plans WHERE workspace_id='{w}' AND opportunity_id='{o}' AND kind='proposal'
 ORDER BY created_at DESC,id DESC LIMIT 1
), job AS MATERIALIZED (
 SELECT j.id,j.status,j.error_code,j.checkpoint,s.repair_count FROM public.jobs j JOIN plan p ON p.id=j.entity_id
 LEFT JOIN public.generation_steps s ON s.job_id=j.id AND s.workspace_id=j.workspace_id AND s.plan_id=p.id
 WHERE j.workspace_id='{w}' AND j.type='plan_commercial' ORDER BY j.created_at DESC,j.id DESC LIMIT 1
), thread AS MATERIALIZED (
 SELECT t.* FROM app_private.model_graph_threads t JOIN job j ON j.id=t.job_id
 WHERE t.workspace_id='{w}' AND t.id=j.checkpoint->>'graph_thread' LIMIT 1
), classified AS MATERIALIZED (
 SELECT r.id,r.result_key,r.created_at,r.value,
  CASE WHEN r.result_key ~ '^candidate-[0-2]$' THEN 'candidate'
   WHEN r.result_key LIKE 'invalid-report-%' THEN 'invalid_report'
   WHEN r.result_key LIKE 'verification-%' AND r.value->'result' ? 'checked_candidate_hash' THEN 'report' END AS category
 FROM app_private.model_graph_results r JOIN thread t ON t.id=r.thread_id WHERE r.workspace_id='{w}'
), ranked AS (
 SELECT *,row_number() OVER(PARTITION BY category ORDER BY created_at DESC,id DESC) AS ordinal
 FROM classified WHERE category IS NOT NULL
), records AS (
 SELECT id,result_key,created_at,category,
  CASE WHEN category='candidate' AND value#>>'{{result,target_task}}'='plan_commercial'
   THEN value#>'{{result,result}}' ELSE value->'result' END AS body,
  CASE WHEN category='invalid_report' THEN value->>'code' ELSE NULL END AS code,
  CASE WHEN category='invalid_report' THEN value->>'verification_key' ELSE NULL END AS verification_key,
  CASE WHEN category='invalid_report' THEN coalesce(value->'validation_diagnostics','[]') ELSE '[]'::jsonb END AS diagnostics
 FROM ranked WHERE ordinal<={LIMIT}
), pins AS (
 SELECT r.result_key,r.value->'version' AS version,coalesce(r.value->'policy',r.value#>'{{partition,policy}}') AS policy
 FROM app_private.model_graph_results r JOIN thread t ON t.id=r.thread_id WHERE r.workspace_id='{w}'
 AND r.result_key ~ '^verification-batches-[a-f0-9]{{64}}$' ORDER BY r.created_at DESC,r.id DESC LIMIT {LIMIT}
), snapshot AS (
 SELECT jsonb_build_object('version',1,'kind','{KIND}','status',CASE WHEN (SELECT id FROM thread) IS NULL THEN 'not_found' ELSE 'available' END,
 'selection',jsonb_build_object('version',1,'workspace_id','{w}','opportunity_id','{o}'),
 'plan_id',(SELECT id FROM plan),'job',(SELECT jsonb_build_object('id',id,'status',status,'error_code',error_code,
  'repair_count',coalesce(repair_count,0),'model_task',checkpoint#>>'{{model_operation,task}}',
  'routing_round',coalesce((checkpoint#>>'{{model_routing,round_attempts}}')::integer,0)) FROM job),
 'thread',(SELECT jsonb_build_object('id',id,'status',status,'candidate_count',candidate_count,'budget_version',budget_version) FROM thread),
 'counts',jsonb_build_object('candidate',(SELECT count(*) FROM classified WHERE category='candidate'),
  'report',(SELECT count(*) FROM classified WHERE category='report'),'invalid_report',(SELECT count(*) FROM classified WHERE category='invalid_report')),
 'records',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'key',result_key,'category',category,
  'created_at',created_at,'body',body,'code',code,'verification_key',verification_key,'diagnostics',diagnostics) ORDER BY created_at DESC,id DESC) FROM records),'[]'::jsonb),
 'pins',coalesce((SELECT jsonb_agg(jsonb_build_object('key',result_key,'version',version,'policy',policy)) FROM pins),'[]'::jsonb)) AS value
)
SELECT CASE WHEN octet_length(value::text)>{SNAPSHOT_BYTES} THEN jsonb_build_object('version',1,'kind','{KIND}',
 'status','oversized','selection',value->'selection','plan_id',value->'plan_id','records',jsonb_build_array()) ELSE value END AS jsonb_build_object
FROM snapshot;
ROLLBACK;
"""


def valid_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError):
        return False


def require(value):
    if not value:
        raise ValueError('PRIVATE_COMMERCIAL_SHAPE_INVALID')


def text(value, maximum=8000):
    return isinstance(value, str) and len(value) <= maximum


def strings(value, maximum=2048):
    return isinstance(value, list) and len(value) <= maximum and all(text(v, 200) for v in value)


def fields(value, expected):
    require(isinstance(value, dict) and set(value) == set(expected.split()))


def references(value):
    require(isinstance(value, list) and len(value) <= 20)
    for ref in value:
        fields(ref, 'id quote'); require(text(ref['id'], 200) and text(ref['quote']))


def commercial(value):
    fields(value, 'lines tasks questions')
    for kind in ('lines', 'tasks', 'questions'):
        require(isinstance(value[kind], list) and len(value[kind]) <= (50 if kind == 'questions' else 100))
    for row in value['lines']:
        fields(row, 'description quantity unit rate_id period_count included_in_base charge_group tax_category requirement_ids section_ids deliverable basis')
        require(all(text(row[k]) for k in ('description', 'unit', 'tax_category', 'deliverable', 'basis'))
            and all(row[k] is None or text(row[k], 100) for k in ('quantity', 'period_count', 'rate_id'))
            and type(row['included_in_base']) is bool and row['charge_group'] in ('one_time', 'recurring', 'optional')
            and strings(row['requirement_ids']) and strings(row['section_ids']))
    for row in value['tasks']:
        fields(row, 'key title predecessors role effort_days allocation duration_days basis')
        require(all(text(row[k]) for k in ('key', 'title', 'role', 'basis')) and strings(row['predecessors'])
            and all(row[k] is None or text(row[k], 100) for k in ('effort_days', 'allocation', 'duration_days')))
    for row in value['questions']:
        fields(row, 'question blocking_level requirement_ids')
        require(text(row['question']) and row['blocking_level'] in ('advisory', 'finalization', 'generation')
            and strings(row['requirement_ids']))


def report(value):
    fields(value, 'checked_candidate_hash reviewed_all_content processed_content_ids claims processed_requirement_ids requirement_checks findings')
    require(text(value['checked_candidate_hash'], 64) and re.fullmatch('[a-f0-9]{64}', value['checked_candidate_hash'])
        and type(value['reviewed_all_content']) is bool and strings(value['processed_content_ids'])
        and strings(value['processed_requirement_ids']) and isinstance(value['claims'], list) and len(value['claims']) <= 2048
        and isinstance(value['requirement_checks'], list) and len(value['requirement_checks']) <= 128
        and isinstance(value['findings'], list) and len(value['findings']) <= 2048)
    for row in value['claims']:
        fields(row, 'id claim candidate_quote kind status source_refs finding')
        require(all(text(row[k]) for k in ('id', 'claim', 'candidate_quote', 'finding'))
            and row['kind'] in ('company_fact', 'tender_fact', 'proposed_solution', 'assumption', 'commercial_commitment')
            and row['status'] in ('supported', 'contradicted', 'insufficient')); references(row['source_refs'])
    for row in value['requirement_checks']:
        fields(row, 'requirement_id status candidate_quote source_refs finding')
        require(all(text(row[k]) for k in ('requirement_id', 'candidate_quote', 'finding'))
            and row['status'] in ('supported', 'contradicted', 'insufficient')); references(row['source_refs'])
    for row in value['findings']:
        fields(row, 'severity code detail claim_ids requirement_ids')
        require(row['severity'] in ('blocking', 'advisory') and text(row['code'], 80) and text(row['detail'])
            and strings(row['claim_ids']) and strings(row['requirement_ids']))


def validate(value, selection):
    require(isinstance(value, dict) and type(value.get('version')) is int and value.get('version') == 1 and value.get('kind') == KIND
        and value.get('selection') == selection and value.get('status') in ('available', 'not_found', 'oversized'))
    if value['status'] == 'oversized':
        fields(value, 'version kind status selection plan_id records'); require(value['records'] == []
            and (value['plan_id'] is None or valid_uuid(value['plan_id'])))
        return value
    fields(value, 'version kind status selection plan_id job thread counts records pins')
    require(value['plan_id'] is None or valid_uuid(value['plan_id']))
    if value['job'] is not None:
        j = value['job']; fields(j, 'id status error_code repair_count model_task routing_round')
        require(valid_uuid(j['id']) and j['status'] in ('queued','running','retry_wait','quota_wait','succeeded','blocked','failed','canceled')
            and (j['error_code'] is None or text(j['error_code'], 120) and re.fullmatch('[A-Z][A-Z0-9_]*',j['error_code']))
            and (j['model_task'] is None or j['model_task'] in ('plan_commercial','repair_result','verify_grounding'))
            and all(type(j[k]) is int and 0 <= j[k] <= 1000000 for k in ('repair_count','routing_round')))
    if value['thread'] is not None:
        t = value['thread']; fields(t, 'id status candidate_count budget_version')
        require(text(t['id'], 64) and re.fullmatch('[a-f0-9]{64}', t['id'])
            and t['status'] in ('running','accepted','needs_review','committed')
            and type(t['candidate_count']) is int and 0 <= t['candidate_count'] <= 3 and t['budget_version'] in (1,2))
    require((value['status']=='not_found') == (value['thread'] is None))
    fields(value['counts'], 'candidate report invalid_report')
    require(all(type(n) is int and 0 <= n <= 100000 for n in value['counts'].values())
        and isinstance(value['records'], list) and len(value['records']) <= LIMIT * 3)
    for row in value['records']:
        fields(row, 'id key category created_at body code verification_key diagnostics')
        require(valid_uuid(row['id']) and text(row['key'], 200) and re.fullmatch('[a-z0-9:_-]+',row['key'])
            and row['category'] in ('candidate','report','invalid_report') and text(row['created_at'], 40))
        require(datetime.fromisoformat(row['created_at'].replace('Z','+00:00')).tzinfo is not None
            and (row['verification_key'] is None or text(row['verification_key'],200)
                and re.fullmatch('[a-z0-9:_-]+',row['verification_key'])))
        if row['category'] == 'candidate': commercial(row['body'])
        else: report(row['body'])
        require(row['code'] is None or text(row['code'], 120) and re.fullmatch('[A-Z][A-Z0-9_]*', row['code']))
        require(isinstance(row['diagnostics'], list) and len(row['diagnostics']) <= 32)
        for item in row['diagnostics']:
            require(isinstance(item, dict) and set(item) <= {'code','reason','paths','evidence_ids','requirement_ids','content_ids','numeric_literals'})
            require(item.get('code') in DIAGNOSTIC_CODES and item.get('reason') in DIAGNOSTIC_REASONS)
            for key, entry in item.items():
                if key in ('code','reason'): continue
                pattern = (r'\$(?:\.[a-z][a-z0-9_]*|\[(?:0|[1-9][0-9]{0,5})\])*' if key=='paths' else
                    r'-?[0-9]+(?:\.[0-9]+)?' if key=='numeric_literals' else r'[A-Za-z0-9][A-Za-z0-9_.:-]*')
                require(isinstance(entry,list) and len(entry)<=16
                    and all(text(v,240 if key=='paths' else 120) and re.fullmatch(pattern,v) for v in entry))
    require(all(sum(r['category']==category for r in value['records'])==min(count,LIMIT)
        for category,count in value['counts'].items()))
    require(isinstance(value['pins'], list) and len(value['pins']) <= LIMIT)
    for pin in value['pins']:
        fields(pin, 'key version policy')
        require(text(pin['key'], 200) and re.fullmatch('verification-batches-[a-f0-9]{64}',pin['key'])
            and type(pin['version']) is int and 1 <= pin['version'] <= 6)
        if pin['policy'] is not None:
            fields(pin['policy'], 'version outputTokens')
            require(pin['policy']['version'] == 2 and type(pin['policy']['outputTokens']) is int
                and 1024 <= pin['policy']['outputTokens'] <= 131072)
    require(len(json.dumps(value, ensure_ascii=False).encode()) <= SNAPSHOT_BYTES)
    return value


def capture(database, selection, request):
    request.validate_selection(selection)
    try:
        return validate(request.read(database, sql(selection), max_bytes=MAX_BYTES), selection)
    except Exception:
        return {'version': 1, 'kind': KIND, 'status': 'unavailable', 'selection': selection}


def fit_report(report):
    """Reserve existing proof/metadata and cap the complete inspect envelope."""
    if 'commercial_snapshot' in report and len(json.dumps(report, ensure_ascii=False, separators=(',',':'),allow_nan=False).encode())>MAX_BYTES:
        report['commercial_snapshot']={'version':1,'kind':KIND,'status':'oversized','selection':report['selection'],
            'plan_id':report['commercial_snapshot'].get('plan_id'),'records':[]}
    if 'commercial_snapshot' in report:
        require(len(json.dumps(report, ensure_ascii=False,separators=(',',':'),allow_nan=False).encode())<=MAX_BYTES)
