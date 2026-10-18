-- Structured provider rejection diagnostics. No response text or prompts are retained.
alter table public.model_attempts
 add column provider_error_code text,
 add column provider_error_type text,
 add column provider_error_reason text;

create or replace function public.finish_model_attempt(attempt_id bigint,lease uuid,result_code text,sent boolean,usage_id uuid,metadata jsonb) returns void language plpgsql security definer set search_path='' as $$
declare a public.model_attempts;
begin
 select * into a from public.model_attempts where id=attempt_id for update;
 if a.id is null or a.lease_token is distinct from lease then raise exception 'STALE_LEASE';end if;
 if result_code is null or result_code !~ '^[A-Z][A-Z0-9_]{1,100}$' or sent is null or pg_column_size(metadata)>4096 then raise exception 'INVALID_INPUT';end if;
 perform app_private.check_keys(metadata,array['http_status','request_id','response_id','reported_model','finish_reason','request_phase','retry_after','provider_error_code','provider_error_type','provider_error_reason']);
 if exists(select 1 from jsonb_each_text(metadata) e where e.key in ('request_id','response_id','reported_model','finish_reason','request_phase','provider_error_code','provider_error_type','provider_error_reason') and e.value !~ '^[A-Za-z0-9._:/@-]{1,200}$') then raise exception 'INVALID_INPUT';end if;
 if usage_id is not null and not exists(select 1 from public.provider_usage u where u.id=usage_id and u.workspace_id=a.workspace_id and u.job_id=a.job_id and u.provider=a.provider) then raise exception 'MODEL_IDENTITY_CHANGED';end if;
 update public.model_attempts set status=case when finish_model_attempt.result_code='SUCCEEDED' then 'succeeded' when finish_model_attempt.result_code='MODEL_IN_PROGRESS' then 'waiting' when not finish_model_attempt.sent then 'skipped' else 'failed' end,
 result_code=finish_model_attempt.result_code,sent=finish_model_attempt.sent,usage_id=finish_model_attempt.usage_id,finished_at=clock_timestamp(),
 http_status=(metadata->>'http_status')::int,request_id=metadata->>'request_id',response_id=metadata->>'response_id',reported_model=metadata->>'reported_model',finish_reason=metadata->>'finish_reason',request_phase=metadata->>'request_phase',retry_after=(metadata->>'retry_after')::timestamptz,
 provider_error_code=metadata->>'provider_error_code',provider_error_type=metadata->>'provider_error_type',provider_error_reason=metadata->>'provider_error_reason' where id=a.id;
end $$;

create or replace view public.model_activity with(security_invoker=true) as
select a.id::text id,a.workspace_id,a.job_id,a.provider,a.model,a.project_ref,a.operation,a.round_number,a.worker_attempt,
 case when a.status='running' and (j.status<>'running' or j.lease_token is distinct from a.lease_token or j.lease_until<=now()) then 'interrupted' else a.status end status,
 a.result_code,a.sent,coalesce(a.usage_id,u.id) usage_id,a.started_at,a.finished_at,
 case when a.finished_at is not null then round(extract(epoch from a.finished_at-a.started_at)*1000)::bigint end duration_ms,
 a.http_status,a.request_id,a.response_id,a.reported_model,a.finish_reason,a.request_phase,a.retry_after,
 u.actual_input,u.actual_output,u.thinking_tokens,u.reserved_input,u.reserved_output,u.state usage_state,u.remote_request_id,
 p.id plan_id,p.opportunity_id,p.proposal_id,o.title opportunity_title,j.status job_status,j.error_code job_error,j.next_attempt_at,
 -- Keep numeric ordering separate from the lossless text identifier delivered to JS.
 a.id sequence,a.provider_error_code,a.provider_error_type,a.provider_error_reason
from public.model_attempts a join public.jobs j on j.id=a.job_id and j.workspace_id=a.workspace_id
left join public.provider_usage u on u.workspace_id=a.workspace_id and (u.id=a.usage_id or (a.usage_id is null and u.job_id=a.job_id and u.lease_token=a.lease_token and u.provider=a.provider))
left join public.generation_steps s on s.job_id=j.id and s.workspace_id=a.workspace_id
left join public.generation_plans p on p.id=coalesce(s.plan_id,case when j.type<>'model_probe' then j.entity_id end) and p.workspace_id=a.workspace_id
left join public.opportunities o on o.id=p.opportunity_id and o.workspace_id=a.workspace_id;
grant select on public.model_activity to authenticated,service_role;

