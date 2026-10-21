-- A paid, safe, schema-valid writer result can require content correction.
-- This transition clears only its completed request round; it grants no new
-- candidate allowance and never marks the invalid candidate accepted.
create function app_private.writer_validation_handoff(job_id uuid,lease uuid,thread_id text,payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;t app_private.model_graph_threads;r app_private.model_graph_results;
 retained app_private.model_graph_results;marker app_private.model_graph_results;
 u public.provider_usage;a public.model_attempts;v jsonb;pool jsonb;entry jsonb;
begin
 j:=app_private.model_job(job_id,lease);
 perform app_private.check_keys(payload,array['candidate_id','candidate_key','manifest']);
 select * into t from app_private.model_graph_threads gt where gt.id=thread_id and gt.job_id=j.id and gt.workspace_id=j.workspace_id for update;
 if t.id is null or t.status not in ('running','needs_review') or t.task='connection_probe'
  or jsonb_typeof(payload->'manifest') is distinct from 'array'
  or coalesce(payload->>'candidate_key','') !~ '^candidate-[012]$' then return 'false'::jsonb;end if;
 select * into r from app_private.model_graph_results gr where gr.thread_id=t.id and gr.id=(payload->>'candidate_id')::uuid
  and gr.result_key=payload->>'candidate_key';
 v:=r.value->'local_validation';
 if r.id is null or v->>'version' is distinct from '1'
  or coalesce(v->>'code','') not in ('EVIDENCE_REFERENCE_INVALID','MODEL_COVERAGE_INCOMPLETE','UNSUPPORTED_COMPANY_CLAIM')
  or jsonb_typeof(v->'diagnostics') is distinct from 'array' or jsonb_array_length(v->'diagnostics') not between 1 and 32
  or coalesce(v->>'request_input_hash','') !~ '^[a-f0-9]{64}$'
  or coalesce(v->>'request_prefix','') not like '%:'||(payload->>'candidate_key')
  or v->>'task' is distinct from (case when payload->>'candidate_key'='candidate-0' then t.task else 'repair_result' end)
  then return 'false'::jsonb;end if;
 select * into retained from app_private.model_graph_results gr where gr.thread_id=t.id
  and gr.result_key='invalid-writer-'||(v->>'usage_id');
 if retained.id is null or retained.value->'result' is distinct from r.value->'result'
  or retained.value->'producer' is distinct from r.value->'producer'
  or retained.value->>'usage_id' is distinct from v->>'usage_id'
  or retained.value->>'request_input_hash' is distinct from v->>'request_input_hash'
  or retained.value->>'request_prefix' is distinct from v->>'request_prefix'
  or retained.value->>'task' is distinct from v->>'task'
  or retained.value->>'code' is distinct from v->>'code' then return 'false'::jsonb;end if;
 select * into u from public.provider_usage pu where pu.id=(v->>'usage_id')::uuid and pu.workspace_id=j.workspace_id and pu.job_id=j.id;
 select * into a from public.model_attempts ma where ma.id=(v->>'attempt_id')::bigint and ma.workspace_id=j.workspace_id and ma.job_id=j.id for update;
 if u.id is null or a.id is null or u.state<>'settled' or not u.graph_candidate_recorded
  or u.input_hash is distinct from v->>'request_input_hash'
  or (u.execution_metadata is not null and (
    u.execution_metadata->>'input_hash' is distinct from u.input_hash
    or u.execution_metadata->>'graph_thread' is distinct from t.id
    or u.execution_metadata->>'prompt_version' is distinct from a.execution_metadata->>'prompt_version'))
  or a.execution_metadata->>'input_hash' is distinct from u.input_hash
  or a.execution_metadata->>'graph_thread' is distinct from t.id
  or a.operation is distinct from v->>'task'
  or coalesce(a.execution_metadata->>'prompt_version','') not like '%.tenderdesk-semantic-fidelity-v1'
  or a.model_config_id is distinct from u.model_config_id or a.connection_id is distinct from u.connection_id
  or a.provider is distinct from u.provider or a.model is distinct from u.model
  or a.lease_token is distinct from u.lease_token
  or (a.usage_id is not null and a.usage_id<>u.id)
  or left(u.call_key,length(v->>'request_prefix')+1) is distinct from (v->>'request_prefix')||':'
  then return 'false'::jsonb;end if;
 select * into marker from app_private.model_graph_results gr where gr.thread_id=t.id and gr.result_key='writer-validation-handoff-'||u.id::text;
 if a.status not in ('running','waiting','failed')
  or (a.status='failed' and a.result_code is distinct from v->>'code')
  or (j.checkpoint->'model_round' is not null and j.checkpoint->'model_round'->>'input_hash' is distinct from u.input_hash)
  or exists(select 1 from public.provider_usage other where other.workspace_id=j.workspace_id and other.job_id=j.id
    and (other.state='reserved' or (other.state='unknown' and (other.input_hash=u.input_hash
      or left(other.call_key,length(v->>'request_prefix')+1)=(v->>'request_prefix')||':'))))
  then return 'false'::jsonb;end if;
 pool:=public.task_model_preflight(job_id,lease,payload->'manifest');
 if pool->>'pending_model_config_id' is not null then return 'false'::jsonb;end if;
 select value into entry from jsonb_array_elements(pool->'providers') where value->>'provider'=u.provider
  and value->>'model'=u.model and value->>'model_config_id'=u.model_config_id::text
  and value->>'connection_id'=u.connection_id::text;
 if entry is null then return 'false'::jsonb;end if;
 if marker.id is not null then
  return to_jsonb(marker.value->>'candidate_id'=r.id::text and marker.value->>'request_input_hash'=u.input_hash);
 end if;
 -- Normal delivery has already finished this exact attempt. Crash replay may
 -- finish it now, preserving its original telemetry and paid usage identity.
 update public.model_attempts set status='failed',result_code=v->>'code',usage_id=u.id,
  finished_at=coalesce(finished_at,clock_timestamp()),provider_error_reason='response_evidence_invalid'
  where id=a.id;
 update public.jobs set checkpoint=checkpoint-'model_round' where id=j.id;
 perform public.model_graph_store(job_id,lease,thread_id,'result_put',jsonb_build_object(
  'key','writer-validation-handoff-'||u.id::text,'value',jsonb_build_object(
   'version',1,'candidate_id',r.id,'usage_id',u.id,'attempt_id',a.id,
   'request_input_hash',u.input_hash,'code',v->>'code','received_candidate_budgets_unchanged',true)));
 return 'true'::jsonb;
end $$;
revoke all on function app_private.writer_validation_handoff(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;

do $$ declare definition text;fragment text;replacement text;begin
 select pg_get_functiondef('public.model_graph_store(uuid,uuid,text,text,jsonb)'::regprocedure) into definition;
 fragment:=$old$ when 'candidate_budget' then$old$;
 replacement:=$new$ when 'writer_validation_handoff' then
  return app_private.writer_validation_handoff(job_id,lease,thread_id,payload);
 when 'candidate_budget' then$new$;
 if position(fragment in definition)=0 then raise exception 'Unexpected writer validation handoff guard';end if;
 execute replace(definition,fragment,replacement);
end $$;
