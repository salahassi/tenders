-- Immutable selection history for already-paid initial candidates that were
-- rejected by a corrected application guard. This grants no writer allowance.
create table app_private.model_writer_recovery_choices (
 thread_id text not null references app_private.model_graph_threads(id) on delete cascade,
 ordinal integer not null check(ordinal between 1 and 2),
 usage_id uuid not null references public.provider_usage(id),
 candidate_id uuid not null references app_private.model_graph_results(id) on delete cascade,
 candidate_hash text not null check(candidate_hash ~ '^[a-f0-9]{64}$'),
 candidate_content_hash text not null,
 previous_candidate_id uuid not null references app_private.model_graph_results(id) on delete cascade,
 previous_candidate_hash text not null check(previous_candidate_hash ~ '^[a-f0-9]{64}$'),
 previous_hash_derivation text not null default 'persisted_candidate_json',
 legacy_marker_hash text,
 previous_report_id uuid not null references app_private.model_graph_results(id) on delete cascade,
 previous_report_hash text not null check(previous_report_hash ~ '^[a-f0-9]{64}$'),
 request_input_hash text not null check(request_input_hash ~ '^[a-f0-9]{64}$'),
 request_prefix text not null,
 evidence_hash text not null check(evidence_hash ~ '^[a-f0-9]{64}$'),
 required_ids_hash text not null check(required_ids_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),resumed_at timestamptz,
 primary key(thread_id,ordinal),unique(thread_id,usage_id),
 unique(thread_id,candidate_content_hash),unique(thread_id,previous_candidate_id),
 unique(candidate_id)
);
alter table app_private.model_writer_recovery_choices enable row level security;
revoke all on app_private.model_writer_recovery_choices from public,anon,authenticated,service_role;

create function app_private.alternate_paid_writer(job_id uuid,lease uuid,thread_id text,action text,payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;t app_private.model_graph_threads;selected app_private.model_writer_recovery_choices;
 previous app_private.model_graph_results;candidate app_private.model_graph_results;report app_private.model_graph_results;
 initial app_private.model_graph_results;retained app_private.model_graph_results;marker app_private.model_graph_results;
 latest app_private.model_writer_recovery_choices;usage jsonb;pool jsonb;entry jsonb;result jsonb;candidate_digest text;
begin
 j:=app_private.model_job(job_id,lease);
 select gt.* into t from app_private.model_graph_threads gt where gt.id=thread_id and gt.job_id=j.id and gt.workspace_id=j.workspace_id for update;
 if t.id is null or t.task<>'draft_section' then return 'false'::jsonb;end if;
 if action='writer_alternative_selections' then
  perform app_private.check_keys(payload,array[]::text[]);
  select coalesce(jsonb_agg(to_jsonb(s) order by s.ordinal),'[]') into result
   from app_private.model_writer_recovery_choices s where s.thread_id=t.id;return result;
 end if;
 if public.model_graph_store(job_id,lease,thread_id,'recovery_ready','{}')<>'true'::jsonb
  or exists(select 1 from app_private.model_graph_results gr where gr.thread_id=t.id and gr.result_key='accepted') then return 'false'::jsonb;end if;
 select * into latest from app_private.model_writer_recovery_choices s where s.thread_id=t.id order by s.ordinal desc limit 1;
 if action='writer_alternative_resume' then
  perform app_private.check_keys(payload,array['usage_id','candidate_id','manifest']);
  if latest.usage_id is distinct from (payload->>'usage_id')::uuid or latest.candidate_id is distinct from (payload->>'candidate_id')::uuid then return 'false'::jsonb;end if;
  select value into usage from jsonb_array_elements(public.model_graph_store(job_id,lease,thread_id,'writer_recovery_candidates',
   jsonb_build_object('input_hash',latest.request_input_hash,'request_prefix',latest.request_prefix))) where value->>'id'=latest.usage_id::text;
  if usage is null then return 'false'::jsonb;end if;
  pool:=public.task_model_preflight(job_id,lease,payload->'manifest');
  if pool->>'pending_model_config_id' is not null then return 'false'::jsonb;end if;
  select value into entry from jsonb_array_elements(pool->'providers') where value->>'provider'=usage->>'provider'
   and value->>'model'=usage->>'model' and value->>'model_config_id'=usage->>'model_config_id'
   and value->>'connection_id'=usage->>'connection_id' and value->>'project_ref'=usage->>'remote_project_ref';
  if entry is null then return 'false'::jsonb;end if;
  update app_private.model_writer_recovery_choices set resumed_at=coalesce(resumed_at,now()) where candidate_id=latest.candidate_id;
  update app_private.model_graph_threads set status='running',updated_at=now() where id=t.id;
  return 'true'::jsonb;
 end if;
 if action<>'writer_alternative_select' then raise exception 'INVALID_INPUT';end if;
 perform app_private.check_keys(payload,array['usage_id','input_hash','request_prefix','candidate_id','candidate_hash',
  'previous_candidate_id','previous_candidate_hash','previous_report_id','previous_report_hash','evidence_hash','required_ids_hash','manifest']);
 if exists(select 1 from unnest(array['candidate_hash','previous_candidate_hash','previous_report_hash','evidence_hash','required_ids_hash']) key
  where coalesce(payload->>key,'') !~ '^[a-f0-9]{64}$') then return 'false'::jsonb;end if;
 if exists(select 1 from unnest(array['usage_id','input_hash','request_prefix','candidate_id','previous_candidate_id','previous_report_id']) key
  where jsonb_typeof(payload->key) is distinct from 'string' or length(payload->>key)=0)
  or jsonb_typeof(payload->'manifest') is distinct from 'array' then return 'false'::jsonb;end if;
 pool:=public.task_model_preflight(job_id,lease,payload->'manifest');
 if pool->>'pending_model_config_id' is not null then return 'false'::jsonb;end if;
 select value into usage from jsonb_array_elements(public.model_graph_store(job_id,lease,thread_id,'writer_recovery_candidates',
   jsonb_build_object('input_hash',payload->>'input_hash','request_prefix',payload->>'request_prefix')))
  where value->>'id'=payload->>'usage_id';
 if usage is null then return 'false'::jsonb;end if;
 pool:=public.task_model_preflight(job_id,lease,payload->'manifest');
 if pool->>'pending_model_config_id' is not null then return 'false'::jsonb;end if;
 select value into entry from jsonb_array_elements(pool->'providers') where value->>'provider'=usage->>'provider'
  and value->>'model'=usage->>'model' and value->>'model_config_id'=usage->>'model_config_id'
  and value->>'connection_id'=usage->>'connection_id' and value->>'project_ref'=usage->>'remote_project_ref';
 if entry is null then return 'false'::jsonb;end if;
 select * into previous from app_private.model_graph_results gr where gr.thread_id=t.id and gr.id=(payload->>'previous_candidate_id')::uuid;
 select * into candidate from app_private.model_graph_results gr where gr.thread_id=t.id and gr.id=(payload->>'candidate_id')::uuid;
 select * into initial from app_private.model_graph_results gr where gr.thread_id=t.id and gr.result_key='candidate-0';
 if previous.id is null or candidate.id is null or initial.value->>'recovery_usage_id' is null
  or candidate.result_key is distinct from 'paid-writer-alternative-'||(payload->>'usage_id')
  or candidate.value->>'recovery_usage_id' is distinct from payload->>'usage_id'
  or candidate.value->'result'=previous.value->'result' or candidate.value->'result'=initial.value->'result'
  or payload->>'usage_id'=initial.value->>'recovery_usage_id' then return 'false'::jsonb;end if;
 select * into marker from app_private.model_graph_results gr where gr.thread_id=t.id
  and gr.result_key='writer-recovery-'||(initial.value->>'recovery_usage_id')
  and gr.value->>'candidate_ref'=initial.id::text and gr.value->>'usage_id'=initial.value->>'recovery_usage_id'
  and gr.value->>'new_generation_requests'='0' and gr.value->>'received_candidate_budgets_unchanged'='true'
  and gr.value->>'independent_verification_required'='true';
 if marker.id is null then return 'false'::jsonb;end if;
 if not exists(select 1 from app_private.model_graph_results gr where gr.thread_id=t.id
  and gr.id::text=marker.value->>'retained_ref' and gr.result_key='invalid-writer-'||(initial.value->>'recovery_usage_id')
  and gr.value->>'usage_id'=initial.value->>'recovery_usage_id' and gr.value->>'task'='draft_section'
  and gr.value->>'code'='UNSUPPORTED_COMPANY_CLAIM' and gr.value->>'request_input_hash'=marker.value->>'request_input_hash'
  and gr.value->>'request_prefix'=marker.value->>'request_prefix' and gr.value->'result'=initial.value->'result'
  and gr.value->'producer'=initial.value->'producer') then return 'false'::jsonb;end if;
 select * into selected from app_private.model_writer_recovery_choices s where s.thread_id=t.id and s.previous_candidate_id=previous.id;
 if selected.candidate_id is not null then
  return to_jsonb(selected.candidate_id=candidate.id and selected.usage_id=(payload->>'usage_id')::uuid
   and selected.previous_candidate_hash=payload->>'previous_candidate_hash'
   and selected.previous_report_id=(payload->>'previous_report_id')::uuid and selected.candidate_hash=payload->>'candidate_hash'
   and selected.previous_report_hash=payload->>'previous_report_hash' and selected.evidence_hash=payload->>'evidence_hash'
   and selected.required_ids_hash=payload->>'required_ids_hash' and selected.request_input_hash=payload->>'input_hash'
   and selected.request_prefix=payload->>'request_prefix');
 end if;
 if coalesce(latest.ordinal,0)>=2
  or (latest.candidate_id is null and previous.id<>initial.id)
  or (latest.candidate_id is not null and (previous.id<>latest.candidate_id or latest.candidate_hash<>payload->>'previous_candidate_hash'))
  then return 'false'::jsonb;end if;
 select * into report from app_private.model_graph_results gr where gr.thread_id=t.id
  and gr.result_key in ('invalid-verification-repair-'||(payload->>'previous_candidate_hash'),
    'invalid-verification-'||(payload->>'previous_candidate_hash'),'verification-'||(payload->>'previous_candidate_hash'))
  order by case when gr.result_key like 'invalid-verification-repair-%' then 0
   when gr.result_key like 'invalid-verification-%' then 1 else 2 end limit 1;
 if report.id is null or report.id<>(payload->>'previous_report_id')::uuid or report.value->>'coverage'='repair_only'
  or report.value->'result'->>'checked_candidate_hash' is distinct from payload->>'previous_candidate_hash'
  or report.value->'result'->>'reviewed_all_content' is distinct from 'true' then return 'false'::jsonb;end if;
 -- A structurally complete latest report must contain a real defect. The worker
 -- validates all content/evidence/requirements before this transition as well.
 if not exists(select 1 from jsonb_array_elements(report.value->'result'->'claims') c
   where c->>'status'<>'supported' and not(c->>'kind'='assumption' and c->>'status'='insufficient'))
  and not exists(select 1 from jsonb_array_elements(report.value->'result'->'requirement_checks') c where c->>'status'<>'supported')
  and not exists(select 1 from jsonb_array_elements(report.value->'result'->'findings') f where f->>'severity'='blocking') then return 'false'::jsonb;end if;
 select * into retained from app_private.model_graph_results gr where gr.thread_id=t.id and gr.result_key='invalid-writer-'||(payload->>'usage_id');
 if retained.id is null or retained.value->>'usage_id' is distinct from payload->>'usage_id' or retained.value->>'task' is distinct from 'draft_section'
  or retained.value->>'code' is distinct from 'UNSUPPORTED_COMPANY_CLAIM' or retained.value->>'request_prefix' is distinct from payload->>'request_prefix'
  or retained.value->>'request_input_hash' is distinct from payload->>'input_hash' or retained.value->'result' is distinct from candidate.value->'result'
  or retained.value->'producer' is distinct from candidate.value->'producer'
  or retained.value->'producer'->>'provider' is distinct from usage->>'provider' or retained.value->'producer'->>'model' is distinct from usage->>'model'
  or retained.value->'producer'->>'connectionId' is distinct from usage->>'connection_id' or retained.value->'producer'->>'modelId' is distinct from usage->>'model_config_id'
  or retained.value->'producer'->>'project' is distinct from usage->>'remote_project_ref' then return 'false'::jsonb;end if;
 candidate_digest:=encode(sha256(convert_to((candidate.value->'result')::text,'UTF8')),'hex');
 if exists(select 1 from app_private.model_writer_recovery_choices s where s.thread_id=t.id
   and (s.usage_id=(payload->>'usage_id')::uuid or s.candidate_content_hash=candidate_digest)) then return 'false'::jsonb;end if;
 insert into app_private.model_writer_recovery_choices(thread_id,ordinal,usage_id,candidate_id,candidate_hash,candidate_content_hash,
  previous_candidate_id,previous_candidate_hash,legacy_marker_hash,previous_report_id,previous_report_hash,request_input_hash,request_prefix,evidence_hash,required_ids_hash)
 values(t.id,coalesce(latest.ordinal,0)+1,(payload->>'usage_id')::uuid,candidate.id,payload->>'candidate_hash',candidate_digest,
  previous.id,payload->>'previous_candidate_hash',case when previous.id=initial.id then marker.value->>'candidate_hash' end,report.id,payload->>'previous_report_hash',payload->>'input_hash',payload->>'request_prefix',payload->>'evidence_hash',payload->>'required_ids_hash');
 return 'true'::jsonb;
end $$;
revoke all on function app_private.alternate_paid_writer(uuid,uuid,text,text,jsonb) from public,anon,authenticated,service_role;

do $$ declare definition text;fragment text;replacement text;begin
 select pg_get_functiondef('public.model_graph_store(uuid,uuid,text,text,jsonb)'::regprocedure) into definition;
 fragment:=$old$ when 'candidate_budget' then$old$;
 replacement:=$new$ when 'writer_alternative_selections','writer_alternative_select','writer_alternative_resume' then
  return app_private.alternate_paid_writer(job_id,lease,thread_id,action,payload);
 when 'candidate_budget' then$new$;
 if position(fragment in definition)=0 then raise exception 'Unexpected alternate writer guard';end if;
 execute replace(definition,fragment,replacement);
end $$;
