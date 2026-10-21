-- Recovery changes neither received candidate counts nor usage accounting.
-- Only the current service worker lease can read an already-paid response and
-- reopen its unchanged graph for mandatory independent verification.
do $$ declare definition text; fragment text; replacement text;begin
 select pg_get_functiondef('public.model_graph_store(uuid,uuid,text,text,jsonb)'::regprocedure) into definition;
 fragment := $old$ when 'candidate_budget' then$old$;
 replacement := $new$ when 'writer_recovery_candidates' then
  perform app_private.check_keys(payload,array['input_hash','request_prefix']);
  if t.task<>'draft_section' or payload->>'input_hash' !~ '^[a-f0-9]{64}$'
   or length(payload->>'request_prefix') not between 1 and 400
   or right(payload->>'request_prefix',12)<>':candidate-0'
   or public.model_graph_store(job_id,lease,thread_id,'recovery_ready','{}')<>'true'::jsonb then return '[]'::jsonb;end if;
  select coalesce(jsonb_agg(to_jsonb(q)||jsonb_build_object('execution_metadata',coalesce(q.execution_metadata,
   (select a.execution_metadata from public.model_attempts a where a.usage_id=q.id and a.job_id=j.id and a.sent
    and a.execution_metadata->>'input_hash'=q.input_hash and a.execution_metadata->>'graph_thread'=t.id
    order by a.id desc limit 1))) order by q.created_at desc),'[]') into result from (
   select u.* from public.provider_usage u
   where u.job_id=j.id and u.workspace_id=j.workspace_id and u.state='settled' and u.graph_candidate_recorded
    and u.input_hash=payload->>'input_hash'
    and (u.execution_metadata->>'graph_thread'=t.id or (u.execution_metadata is null and exists(
      select 1 from public.model_attempts origin where origin.usage_id=u.id and origin.job_id=j.id and origin.sent
       and origin.execution_metadata->>'input_hash'=u.input_hash and origin.execution_metadata->>'graph_thread'=t.id)))
    and regexp_replace(u.call_key, ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$', '')=payload->>'request_prefix'
    and exists(select 1 from public.model_attempts a where a.usage_id=u.id and a.job_id=j.id
      and a.operation='draft_section' and a.result_code='UNSUPPORTED_COMPANY_CLAIM')
   order by u.created_at desc limit 3
  ) q;return result;
 when 'writer_recovery_resume' then
  perform app_private.check_keys(payload,array['usage_id','input_hash','request_prefix','candidate_id','marker_key']);
  if t.task<>'draft_section' or public.model_graph_store(job_id,lease,thread_id,'recovery_ready','{}')<>'true'::jsonb then return 'false'::jsonb;end if;
  if not exists(select 1 from jsonb_array_elements(public.model_graph_store(job_id,lease,thread_id,'writer_recovery_candidates',
    jsonb_build_object('input_hash',payload->>'input_hash','request_prefix',payload->>'request_prefix'))) u
    where u->>'id'=payload->>'usage_id') then return 'false'::jsonb;end if;
  select * into r from app_private.model_graph_results gr where gr.thread_id=t.id and gr.result_key='candidate-0'
   and gr.id=(payload->>'candidate_id')::uuid and gr.value->>'recovery_usage_id'=payload->>'usage_id';
  if r.id is null or payload->>'marker_key'<>'writer-recovery-'||(payload->>'usage_id') then return 'false'::jsonb;end if;
  if not exists(select 1 from app_private.model_graph_results m where m.thread_id=t.id and m.result_key=payload->>'marker_key'
   and m.value->>'candidate_ref'=r.id::text and m.value->>'usage_id'=payload->>'usage_id'
   and m.value->>'request_input_hash'=payload->>'input_hash' and m.value->>'request_prefix'=payload->>'request_prefix'
   and m.value->>'independent_verification_required'='true' and m.value->>'new_generation_requests'='0'
   and m.value->>'received_candidate_budgets_unchanged'='true'
   and exists(select 1 from app_private.model_graph_results retained where retained.thread_id=t.id
     and retained.id::text=m.value->>'retained_ref' and retained.result_key='invalid-writer-'||(payload->>'usage_id')
     and retained.value->>'usage_id'=payload->>'usage_id' and retained.value->>'task'='draft_section'
     and retained.value->>'request_input_hash'=payload->>'input_hash' and retained.value->>'request_prefix'=payload->>'request_prefix'
     and retained.value->>'code'='UNSUPPORTED_COMPANY_CLAIM' and retained.value->'result'=r.value->'result')) then return 'false'::jsonb;end if;
  update app_private.model_graph_threads set status='running',updated_at=now() where id=t.id;
  return 'true'::jsonb;
 when 'candidate_budget' then$new$;
 if position(fragment in definition)=0 then raise exception 'Unexpected writer recovery guard';end if;
 execute replace(definition,fragment,replacement);
end $$;
