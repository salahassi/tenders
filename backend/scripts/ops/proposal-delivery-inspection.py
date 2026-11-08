#!/usr/bin/env python3
"""Private receipt-link diagnosis for one failed current generated delivery.

The default report contains identifiers, counts and booleans only. Optional
prospective context uses the exact existing SELECT projection with decoded
saved references; it neither leases work nor accepts or changes any result.
"""
import hashlib
import json
from pathlib import Path
import re
import uuid

ROOT=Path(__file__).resolve().parents[3]
KIND='private_generated_delivery_receipt_inspection'
LIMIT=128
MAX_CHECKPOINT=262_144
MAX_BYTES=1_750_000
CONTEXT_BYTES=1_250_000
SOURCE=ROOT/'backend/supabase/migrations/20261104143632_generated_review_delivery.sql'
SOURCE_SHA256='8da4bdcbd534b04f62d157bbd49d2aa2a5e0224cdfd7fdd19f18682653dfeeaa'
BOOL_FIELDS=('graph_accepted','accepted_found','accepted_matches_output','accepted_hash_bound','checkpoint_found',
 'checkpoint_data_present','direct_report_ref_present','decoded_report_ref_present','direct_report_exists',
 'decoded_report_exists','direct_report_hash_bound','decoded_report_hash_bound','direct_coverage_eligible',
 'decoded_coverage_eligible','direct_receipt_eligible','decoded_receipt_eligible')
TASKS={'analyze_chunk','classify_opportunity','summarize_review','consolidate_requirements','plan_proposal','draft_section','plan_commercial','review_proposal','advance_plan'}
DECODE_STATUS={'missing','unsupported','oversized','malformed','decoded','reference_missing'}


def require(value):
    if not value:raise ValueError('PRIVATE_DELIVERY_INSPECTION_INVALID')


def valid_uuid(value):
    try:return isinstance(value,str) and str(uuid.UUID(value))==value
    except(ValueError,TypeError):return False


def projection():
    raw=SOURCE.read_bytes();require(hashlib.sha256(raw).hexdigest()==SOURCE_SHA256)
    text=raw.decode();start="create function public.generated_delivery_context(job_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$"
    require(text.count(start)==1)
    body=text.split(start)[1].split('\nend $$;',1)[0].split(';begin\n',1)[1]
    marker=' j:=app_private.generated_delivery_job(job_id,lease);'
    require(body.count(marker)==1);body=body.replace(marker," perform app_private.delivery_actor(j.workspace_id,j.created_by,true);")
    marker=' select * into p from public.generation_plans where workspace_id=j.workspace_id and id=j.entity_id;'
    require(body.count(marker)==1)
    body=body.replace(marker,marker+"\n p.status:='completed';p.error_code:=NULL; -- Local prospective values only; stored failed state remains in metadata.")
    marker="last_state.checkpoint#>>'{channel_values,reportRef}'"
    require(body.count(marker)==1)
    body=body.replace(marker,"(select x->>'ref' from jsonb_array_elements(decoded_refs) x where x->>'step_id'=s.id::text)")
    marker=" return context||jsonb_build_object('context_hash',encode(sha256(convert_to(context::text,'UTF8')),'hex'));"
    require(body.count(marker)==1)
    return body.replace(marker," context:=context||jsonb_build_object('context_hash',encode(sha256(convert_to(context::text,'UTF8')),'hex'));\n perform app_private.assert_plan_source_resolution(p.id);")


def sql(selection,proof,*,include_context=False):
    require(type(include_context) is bool and isinstance(selection,dict) and set(selection)=={'version','workspace_id','opportunity_id'}
        and type(selection['version']) is int and selection['version']==1 and valid_uuid(selection['workspace_id']) and valid_uuid(selection['opportunity_id']))
    require(isinstance(proof,dict) and valid_uuid(proof.get('actor_id')) and isinstance(proof.get('plan'),dict)
        and valid_uuid(proof['plan'].get('id')) and isinstance(proof.get('proposal'),dict)
        and valid_uuid(proof['proposal'].get('id')) and valid_uuid(proof['proposal'].get('active_version_id')))
    w,o,actor,plan,version=selection['workspace_id'],selection['opportunity_id'],proof['actor_id'],proof['plan']['id'],proof['proposal']['active_version_id']
    context_sql="context_status:='not_requested';"
    if include_context:
        context_sql="""IF source_current AND count_steps<=__LIMIT__ THEN
 BEGIN
 __PROJECTION__
 IF octet_length(context::text)>__CONTEXT_BYTES__ THEN context:=NULL;context_status:='oversized';
 ELSE context_status:='available';END IF;
 EXCEPTION WHEN OTHERS THEN context:=NULL;context_status:='source_guard_failed';END;
 ELSE context_status:='source_guard_failed';END IF;""".replace('__PROJECTION__',projection()).replace('__LIMIT__',str(LIMIT)).replace('__CONTEXT_BYTES__',str(CONTEXT_BYTES))
    return f"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;SET LOCAL statement_timeout='10s';SET LOCAL lock_timeout='1s';
DO $delivery_inspection$
DECLARE j public.jobs;p public.generation_plans;v public.proposal_versions;prop public.proposals;issuance public.proposal_issuance_requests;
 inspected_step record;decoded jsonb;decoded_bytes bytea;encoded text;direct_ref text;decoded_ref text;decode_status text;
 direct_report jsonb;decoded_report jsonb;rows jsonb:='[]';decoded_refs jsonb:='[]';result jsonb;row_value jsonb;
 count_steps bigint;source_current boolean:=false;context_status text:='not_requested';
 sections jsonb;requirements jsonb;steps jsonb;receipts jsonb;sources jsonb;manifest jsonb;context jsonb;
 ref jsonb;requirement jsonb;current_documents jsonb;saved_documents jsonb;
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'PRIVATE_DELIVERY_DATABASE';END IF;
 IF (SELECT count(*) FROM public.memberships m JOIN public.identity_allowlist a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
  WHERE m.workspace_id='{w}' AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner')<>1
  OR NOT EXISTS(SELECT 1 FROM public.memberships m JOIN public.identity_allowlist a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
   WHERE m.workspace_id='{w}' AND m.user_id='{actor}' AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner')
  OR EXISTS(SELECT 1 FROM public.restore_sessions WHERE workspace_id='{w}' AND state IN('staging','committing'))
 THEN RAISE EXCEPTION 'PRIVATE_DELIVERY_SELECTION';END IF;
 SELECT * INTO p FROM public.generation_plans WHERE workspace_id='{w}' AND opportunity_id='{o}' AND kind='proposal'
 ORDER BY created_at DESC,id DESC LIMIT 1;
 IF p.id IS DISTINCT FROM '{plan}'::uuid OR NOT EXISTS(SELECT 1 FROM public.opportunities WHERE workspace_id='{w}' AND id='{o}' AND NOT archived)
 THEN RAISE EXCEPTION 'PRIVATE_DELIVERY_SELECTION';END IF;
 SELECT * INTO prop FROM public.proposals WHERE workspace_id='{w}' AND id=p.proposal_id AND opportunity_id='{o}';
 SELECT * INTO v FROM public.proposal_versions WHERE workspace_id='{w}' AND id='{version}' AND plan_id=p.id;
 SELECT * INTO j FROM public.jobs WHERE workspace_id='{w}' AND entity_id=p.id AND type='prepare_generated_delivery'
  AND checkpoint->>'generated_version_id'=v.id::text AND checkpoint->>'issuance_request_id'=p.issuance_request_id::text
 ORDER BY created_at DESC,id DESC LIMIT 1;
 result:=jsonb_build_object('version',1,'kind','{KIND}','selection',jsonb_build_object('version',1,'workspace_id','{w}','opportunity_id','{o}'),
  'status','not_found','plan_id',p.id,'version_id',v.id,'prepare_job_id',j.id,
  'stored_plan_status',p.status,'stored_plan_stage',p.stage,'stored_plan_error_code',p.error_code);
 IF j.id IS NOT NULL THEN
  SELECT * INTO issuance FROM public.proposal_issuance_requests WHERE workspace_id='{w}' AND id=p.issuance_request_id AND plan_id=p.id;
  IF j.status<>'failed' OR j.error_code IS DISTINCT FROM 'GENERATED_DELIVERY_VALIDATION_FAILED' OR j.lease_token IS NOT NULL OR j.lease_until IS NOT NULL
   OR p.status<>'failed' OR p.stage<>'completed' OR p.error_code IS DISTINCT FROM 'GENERATED_DELIVERY_VALIDATION_FAILED'
   OR issuance.id IS NULL OR issuance.outcome IS DISTINCT FROM 'failed' OR issuance.error_code IS DISTINCT FROM j.error_code
   OR issuance.requested_by IS DISTINCT FROM '{actor}'::uuid OR p.frozen_context->>'generated_delivery_version' IS DISTINCT FROM '3'
   OR v.id IS NULL OR prop.active_version_id IS DISTINCT FROM v.id OR v.content_hash IS DISTINCT FROM j.checkpoint->>'generated_version_hash'
   OR p.input_hash IS DISTINCT FROM j.input_hash THEN RAISE EXCEPTION 'PRIVATE_DELIVERY_SELECTION';END IF;
  BEGIN PERFORM app_private.assert_plan_source_resolution(p.id);source_current:=true;
  EXCEPTION WHEN OTHERS THEN source_current:=false;END;
  SELECT count(*) INTO count_steps FROM public.generation_steps WHERE workspace_id='{w}' AND plan_id=p.id AND status='completed';
  FOR inspected_step IN
   SELECT s.id,s.job_id,s.task,s.ordinal,g.id AS graph_id,g.status AS graph_status,
    accepted.id AS accepted_id,accepted.value=s.output AS accepted_matches_output,
    accepted.content_hash=encode(sha256(convert_to(accepted.value::text,'UTF8')),'hex') AS accepted_hash_bound,
    checkpoint.checkpoint_id,checkpoint.checkpoint
   FROM public.generation_steps s
   LEFT JOIN public.jobs source_job ON source_job.id=s.job_id AND source_job.workspace_id=s.workspace_id
   LEFT JOIN app_private.model_graph_threads g ON g.workspace_id=s.workspace_id AND g.job_id=s.job_id AND g.id=source_job.checkpoint->>'graph_thread'
   LEFT JOIN app_private.model_graph_results accepted ON accepted.id=g.result_id AND accepted.thread_id=g.id
   LEFT JOIN LATERAL(SELECT checkpoint_id,checkpoint FROM app_private.model_graph_checkpoints WHERE thread_id=g.id AND namespace='' ORDER BY checkpoint_id DESC LIMIT 1) checkpoint ON true
   WHERE s.workspace_id='{w}' AND s.plan_id=p.id AND s.status='completed' ORDER BY s.ordinal,s.id LIMIT {LIMIT}
  LOOP
   direct_ref:=inspected_step.checkpoint#>>'{{channel_values,reportRef}}';decoded_ref:=NULL;decoded:=NULL;encoded:=inspected_step.checkpoint->>'data';
   decode_status:=CASE WHEN inspected_step.checkpoint_id IS NULL THEN 'missing' ELSE 'unsupported' END;
   IF inspected_step.checkpoint->>'type'='json' AND jsonb_typeof(inspected_step.checkpoint->'data')='string' AND inspected_step.checkpoint-ARRAY['type','data']='{{}}'::jsonb THEN
    decode_status:='oversized';
    IF octet_length(inspected_step.checkpoint::text)<={MAX_CHECKPOINT} AND length(encoded) BETWEEN 1 AND {MAX_CHECKPOINT} THEN
     decode_status:='malformed';
     BEGIN
      IF length(encoded)%4=0 AND encoded ~ '^[A-Za-z0-9+/]*={{0,2}}$' THEN
       decoded_bytes:=decode(encoded,'base64');
       IF replace(encode(decoded_bytes,'base64'),E'\\n','')=encoded THEN
        decoded:=convert_from(decoded_bytes,'UTF8')::jsonb;
        decode_status:='reference_missing';
        IF jsonb_typeof(decoded)='object' AND jsonb_typeof(decoded->'channel_values')='object'
         AND jsonb_typeof(decoded#>'{{channel_values,reportRef}}')='string'
         AND decoded#>>'{{channel_values,reportRef}}' ~ '^[a-f0-9]{{8}}-[a-f0-9]{{4}}-[a-f0-9]{{4}}-[a-f0-9]{{4}}-[a-f0-9]{{12}}$'
        THEN decoded_ref:=decoded#>>'{{channel_values,reportRef}}';decode_status:='decoded';END IF;
       END IF;
      END IF;
     EXCEPTION WHEN data_exception THEN decode_status:='malformed';decoded_ref:=NULL;END;
    END IF;
   END IF;
   SELECT jsonb_build_object('hash_bound',checked.content_hash=encode(sha256(convert_to(checked.value::text,'UTF8')),'hex'),
     'coverage_eligible',coalesce(checked.value->>'coverage','')<>'repair_only') INTO direct_report
    FROM app_private.model_graph_results checked WHERE checked.thread_id=inspected_step.graph_id AND checked.id::text=direct_ref;
   SELECT jsonb_build_object('hash_bound',checked.content_hash=encode(sha256(convert_to(checked.value::text,'UTF8')),'hex'),
     'coverage_eligible',coalesce(checked.value->>'coverage','')<>'repair_only') INTO decoded_report
    FROM app_private.model_graph_results checked WHERE checked.thread_id=inspected_step.graph_id AND checked.id::text=decoded_ref;
   row_value:=jsonb_build_object('step_id',inspected_step.id,'job_id',inspected_step.job_id,'task',inspected_step.task,'ordinal',inspected_step.ordinal,
    'graph_accepted',coalesce(inspected_step.graph_status IN('accepted','committed'),false),'accepted_found',inspected_step.accepted_id IS NOT NULL,
    'accepted_matches_output',coalesce(inspected_step.accepted_matches_output,false),'accepted_hash_bound',coalesce(inspected_step.accepted_hash_bound,false),
    'checkpoint_found',inspected_step.checkpoint_id IS NOT NULL,'checkpoint_type',CASE WHEN inspected_step.checkpoint->>'type'='json' THEN 'json' WHEN inspected_step.checkpoint->>'type' IS NULL THEN 'absent' ELSE 'unsupported' END,
    'checkpoint_data_present',jsonb_typeof(inspected_step.checkpoint->'data') IS NOT DISTINCT FROM 'string',
    'checkpoint_bytes',coalesce(octet_length(inspected_step.checkpoint::text),0),'decode_status',decode_status,
    'direct_report_ref_present',coalesce(length(direct_ref)>0,false),'decoded_report_ref_present',decoded_ref IS NOT NULL,
    'direct_report_exists',direct_report IS NOT NULL,'decoded_report_exists',decoded_report IS NOT NULL,
    'direct_report_hash_bound',coalesce((direct_report->>'hash_bound')::boolean,false),'decoded_report_hash_bound',coalesce((decoded_report->>'hash_bound')::boolean,false),
    'direct_coverage_eligible',coalesce((direct_report->>'coverage_eligible')::boolean,false),'decoded_coverage_eligible',coalesce((decoded_report->>'coverage_eligible')::boolean,false),
    'direct_receipt_eligible',coalesce(inspected_step.graph_status IN('accepted','committed') AND inspected_step.accepted_matches_output AND (direct_report->>'coverage_eligible')::boolean,false),
    'decoded_receipt_eligible',coalesce(inspected_step.graph_status IN('accepted','committed') AND inspected_step.accepted_matches_output AND (decoded_report->>'coverage_eligible')::boolean,false));
   rows:=rows||jsonb_build_array(row_value);
   IF decoded_ref IS NOT NULL THEN decoded_refs:=decoded_refs||jsonb_build_array(jsonb_build_object('step_id',inspected_step.id,'ref',decoded_ref));END IF;
  END LOOP;
  {context_sql}
  result:=result||jsonb_build_object('status','available','workflow_version',p.workflow_version,
   'source_resolution_version',CASE WHEN p.frozen_context->'source_resolution_version'='1'::jsonb THEN 1 ELSE NULL END,
   'source_resolution_current',source_current,'requirements_count',(SELECT count(*) FROM public.requirements WHERE workspace_id='{w}' AND plan_id=p.id),
   'completed_steps',count_steps,'truncated',count_steps>{LIMIT},'steps',rows,
   'task_counts',(SELECT coalesce(jsonb_object_agg(task,n),'{{}}'::jsonb) FROM (SELECT task,count(*) n FROM public.generation_steps WHERE workspace_id='{w}' AND plan_id=p.id AND status='completed' GROUP BY task) grouped),
   'receipt_counts',(SELECT jsonb_object_agg(key,(SELECT count(*) FROM jsonb_array_elements(rows) x WHERE (x->>key)::boolean)) FROM unnest(ARRAY[{','.join(chr(39)+key+chr(39) for key in BOOL_FIELDS)}]) key),
   'context_status',context_status,
   'prospective_context',context);
 END IF;
 PERFORM set_config('tenderdesk.delivery_inspection',result::text,true);
END $delivery_inspection$;
SELECT current_setting('tenderdesk.delivery_inspection')::jsonb;
ROLLBACK;
"""


def validate(value,selection,*,include_context=False):
    require(isinstance(value,dict) and value.get('version')==1 and type(value['version']) is int and value.get('kind')==KIND
        and value.get('selection')==selection and value.get('status') in ('available','not_found'))
    base={'version','kind','selection','status','plan_id','version_id','prepare_job_id','stored_plan_status','stored_plan_stage','stored_plan_error_code'}
    require(valid_uuid(value.get('plan_id')) and all(value.get(k) is None or valid_uuid(value[k]) for k in ('version_id','prepare_job_id')))
    require(value.get('stored_plan_status') in ('queued','running','blocked','completed','failed','canceled')
        and value.get('stored_plan_stage') in ('analysis','planning','detailing','drafting','commercial','synthesis','review','reconciliation','completed')
        and (value.get('stored_plan_error_code') is None or isinstance(value['stored_plan_error_code'],str)
            and re.fullmatch('[A-Z][A-Z0-9_]{0,119}',value['stored_plan_error_code'])))
    if value['status']=='not_found':require(set(value)==base);return value
    require(value['stored_plan_status']=='failed' and value['stored_plan_stage']=='completed'
        and value['stored_plan_error_code']=='GENERATED_DELIVERY_VALIDATION_FAILED')
    require(set(value)==base|{'workflow_version','source_resolution_version','source_resolution_current','requirements_count',
        'completed_steps','truncated','steps','task_counts','receipt_counts','context_status','prospective_context'})
    require(all(type(value[k]) is int and 0<=value[k]<=1_000_000 for k in ('workflow_version','requirements_count','completed_steps'))
        and value['source_resolution_version'] in (None,1) and type(value['source_resolution_current']) is bool
        and type(value['truncated']) is bool and value['truncated']==(value['completed_steps']>LIMIT)
        and isinstance(value['steps'],list) and len(value['steps'])==min(value['completed_steps'],LIMIT))
    for row in value['steps']:
        require(isinstance(row,dict) and set(row)==set(BOOL_FIELDS)|{'step_id','job_id','task','ordinal','checkpoint_type','checkpoint_bytes','decode_status'}
            and valid_uuid(row['step_id']) and valid_uuid(row['job_id']) and row['task'] in TASKS
            and type(row['ordinal']) is int and row['ordinal']>=0 and type(row['checkpoint_bytes']) is int and row['checkpoint_bytes']>=0
            and row['checkpoint_type'] in ('json','absent','unsupported') and row['decode_status'] in DECODE_STATUS
            and all(type(row[k]) is bool for k in BOOL_FIELDS))
    require(isinstance(value['task_counts'],dict) and set(value['task_counts'])<=TASKS
        and all(type(v) is int and v>0 for v in value['task_counts'].values())
        and sum(value['task_counts'].values())==value['completed_steps']
        and isinstance(value['receipt_counts'],dict) and set(value['receipt_counts'])==set(BOOL_FIELDS)
        and all(type(v) is int and v==sum(row[k] for row in value['steps']) for k,v in value['receipt_counts'].items()))
    require(value['context_status'] in (('not_requested',) if not include_context else ('available','oversized','source_guard_failed')))
    if value['context_status']=='available':
        require(isinstance(value['prospective_context'],dict) and value['source_resolution_current'] and not value['truncated']
            and len(json.dumps(value['prospective_context'],ensure_ascii=False).encode())<=CONTEXT_BYTES)
    else:require(value['prospective_context'] is None)
    require(len(json.dumps(value,ensure_ascii=False).encode())<=MAX_BYTES)
    return value


def capture(database,selection,request,proof,*,include_context=False):
    request.validate_selection(selection)
    try:
        request.validate_proof(proof)
        return validate(request.read(database,sql(selection,proof,include_context=include_context),max_bytes=MAX_BYTES),selection,include_context=include_context)
    except Exception:
        return {'version':1,'kind':KIND,'status':'unavailable','selection':selection}
