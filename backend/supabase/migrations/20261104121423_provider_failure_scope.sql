-- Fixed, non-sensitive provider scope; no historical attempt is rewritten.
alter table public.model_attempts add column provider_error_scope text
 check(provider_error_scope in ('model','connection','project','account','unknown'));
CREATE OR REPLACE FUNCTION public.finish_model_attempt(attempt_id bigint, lease uuid, result_code text, sent boolean, usage_id uuid, metadata jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.model_attempts;
begin
 select * into a from public.model_attempts where id=attempt_id for update;
 if a.id is null or a.lease_token is distinct from lease then raise exception 'STALE_LEASE';end if;
 if result_code is null or result_code !~ '^[A-Z][A-Z0-9_]{1,100}$' or sent is null or pg_column_size(metadata)>4096 then raise exception 'INVALID_INPUT';end if;
 perform app_private.check_keys(metadata,array['http_status','request_id','response_id','reported_model','finish_reason','request_phase','retry_after','provider_error_code','provider_error_type','provider_error_reason','provider_error_scope']);
 if exists(select 1 from jsonb_each_text(metadata) e where e.key in ('request_id','response_id','reported_model','finish_reason','request_phase','provider_error_code','provider_error_type','provider_error_reason') and e.value !~ '^[A-Za-z0-9._:/@-]{1,200}$') then raise exception 'INVALID_INPUT';end if;
 if usage_id is not null and not exists(select 1 from public.provider_usage u where u.id=usage_id and u.workspace_id=a.workspace_id and u.job_id=a.job_id and u.provider=a.provider and u.model=a.model and u.connection_id is not distinct from a.connection_id and u.model_config_id is not distinct from a.model_config_id) then raise exception 'MODEL_IDENTITY_CHANGED';end if;
 update public.model_attempts set status=case when finish_model_attempt.result_code='SUCCEEDED' then 'succeeded' when finish_model_attempt.result_code='MODEL_IN_PROGRESS' then 'waiting' when metadata->>'request_phase'='poll' then 'failed' when not finish_model_attempt.sent then 'skipped' else 'failed' end,
 result_code=finish_model_attempt.result_code,sent=finish_model_attempt.sent,usage_id=finish_model_attempt.usage_id,finished_at=clock_timestamp(),
 http_status=(metadata->>'http_status')::int,request_id=metadata->>'request_id',response_id=metadata->>'response_id',reported_model=metadata->>'reported_model',finish_reason=metadata->>'finish_reason',request_phase=metadata->>'request_phase',retry_after=(metadata->>'retry_after')::timestamptz,
 provider_error_code=metadata->>'provider_error_code',provider_error_type=metadata->>'provider_error_type',provider_error_reason=metadata->>'provider_error_reason',provider_error_scope=metadata->>'provider_error_scope' where id=a.id;
end $function$;


-- Same backoff as existing model admission. Unknown quota scope is deliberately
-- conservative: the catalog has no provider-account identifier to prove isolation.
create function app_private.provider_failure_windows(w uuid)
returns table(provider text,model text,project_ref text,connection_id uuid,scope text,retry_after timestamptz)
language sql stable set search_path='' as $$
 with failures as (
  select a.*,case when a.provider_error_scope='project' and coalesce(a.project_ref,'')='' then 'unknown'
   when a.provider_error_scope is not null then a.provider_error_scope
   when lower(a.provider_error_code) in ('insufficient_balance','credit_balance_exhausted') or lower(a.provider_error_code) ~ '^account_(quota|rate_limit)_exceeded$' then 'account'
   when lower(a.provider_error_code) ~ '^model_(quota|rate_limit)_exceeded$' then 'model'
   when lower(a.provider_error_code) ~ '^project_(quota|rate_limit)_exceeded$' then case when coalesce(a.project_ref,'')<>'' then 'project' else 'unknown' end
   when lower(a.provider_error_code) in ('insufficient_quota','rate_limit_exceeded','resource_exhausted') then 'unknown'
   when a.http_status=429 or a.result_code='PROVIDER_QUOTA_WAIT' or a.provider_error_reason in ('usage_limit','insufficient_balance','rate_limit','concurrency_limit','account_rate_restriction','subscription_expired') then 'unknown'
   when a.result_code='PROVIDER_AUTH_FAILED' then 'connection' else 'model' end as failure_scope
  from public.model_attempts a where a.workspace_id=w and a.started_at>now()-interval '1 day' and a.status='failed'
   and (a.http_status=429 or a.http_status>=500 or (a.http_status=413 and a.retry_after is not null) or a.result_code in ('PROVIDER_QUOTA_WAIT','PROVIDER_AUTH_FAILED','MODEL_NETWORK_UNCERTAIN')
    or lower(a.provider_error_code) ~ '^(insufficient_quota|insufficient_balance|credit_balance_exhausted|(model|project|account)_quota_exceeded|(model|project|account)_rate_limit_exceeded|rate_limit_exceeded|resource_exhausted)$'
    or a.provider_error_reason in ('usage_limit','insufficient_balance','rate_limit','concurrency_limit','account_rate_restriction','subscription_expired'))
   -- Only successful generation establishes fresh-admission health. Polls and
   -- later invalid/permission-rejected requests cannot erase a quota cooldown.
   and not exists(select 1 from public.model_attempts ok where ok.workspace_id=w and ok.provider=a.provider
    and ok.model=a.model and ok.project_ref=a.project_ref and ok.connection_id is not distinct from a.connection_id
    and ok.status='succeeded' and ok.request_phase is distinct from 'poll' and ok.id>a.id)
 ), latest as (
  select distinct on(provider,model,project_ref,connection_id,failure_scope) failures.*,
   max(retry_after) over(partition by provider,model,project_ref,connection_id,failure_scope) explicit_retry_after
  from failures order by provider,model,project_ref,connection_id,failure_scope,id desc
 ), waits as (
  select l.*,greatest(l.explicit_retry_after,l.started_at+make_interval(secs=>least(3600,60*power(2,least(6,greatest(0,(
    select count(*)-1 from public.model_attempts a where a.workspace_id=w and a.provider=l.provider and a.model=l.model
     and a.project_ref=l.project_ref and a.connection_id is not distinct from l.connection_id and a.status='failed'
     and a.http_status is not distinct from l.http_status and a.id>coalesce((select max(ok.id) from public.model_attempts ok
      where ok.workspace_id=w and ok.provider=l.provider and ok.model=l.model and ok.project_ref=l.project_ref
       and ok.connection_id is not distinct from l.connection_id and ok.status='succeeded' and ok.request_phase is distinct from 'poll'),0)
   )::int))))::int)) as until_at from latest l
 )
 select provider,model,project_ref,connection_id,failure_scope,least(until_at,now()+interval '1 day') from waits where until_at>now();
$$;
revoke all on function app_private.provider_failure_windows(uuid) from public,anon,authenticated,service_role;

create or replace function public.task_model_retry_windows(job_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs;result jsonb;
begin
 j:=app_private.model_job(job_id,lease);
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
  select (e->>'model_config_id')::uuid model_config_id,(e->>'connection_id')::uuid connection_id,max(w.retry_after) retry_after
  from jsonb_array_elements(coalesce(j.checkpoint#>'{model_routing,providers}','[]')) e
  join app_private.provider_failure_windows(j.workspace_id) w on w.provider=e->>'provider' and (
   (w.scope in ('unknown','account')) or
   (w.scope='project' and w.project_ref<>'' and w.project_ref=coalesce(e->>'project_ref','')) or
   (w.scope='connection' and (w.connection_id=(e->>'connection_id')::uuid or (w.connection_id is null and w.project_ref=coalesce(e->>'project_ref','')))) or
   (w.scope='model' and w.model=e->>'model' and (w.connection_id=(e->>'connection_id')::uuid or (w.connection_id is null and w.project_ref=coalesce(e->>'project_ref','')))))
  group by e->>'model_config_id',e->>'connection_id'
 ) x;
 return result;
end $$;
create or replace function public.model_retry_windows(job_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs;result jsonb;
begin
 j:=app_private.model_job(job_id,lease);
 -- Preserve the legacy read contract before a route has been frozen. Once it
 -- exists, expand proven scopes over that immutable snapshot, never live edits.
 if jsonb_array_length(coalesce(j.checkpoint#>'{model_routing,providers}','[]'))=0 then
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
   select w.provider,w.model,w.project_ref,max(w.retry_after) retry_after
   from app_private.provider_failure_windows(j.workspace_id) w group by w.provider,w.model,w.project_ref
  ) x;
  return result;
 end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
  select e->>'provider' provider,e->>'model' model,e->>'project_ref' project_ref,max(w.retry_after) retry_after
  from jsonb_array_elements(coalesce(j.checkpoint#>'{model_routing,providers}','[]')) e
  join app_private.provider_failure_windows(j.workspace_id) w on w.provider=e->>'provider' and (
   w.scope in ('unknown','account') or
   (w.scope in ('project','connection') and w.project_ref=coalesce(e->>'project_ref','')) or
   (w.scope='model' and w.model=e->>'model' and w.project_ref=coalesce(e->>'project_ref','')))
  group by e->>'provider',e->>'model',e->>'project_ref'
 ) x;
 return result;
end $$;
-- Appending a field preserves existing view column identities and RLS behavior.
create or replace view public.model_activity with(security_invoker=true) as
select a.id::text id,a.workspace_id,a.job_id,a.provider,a.model,a.project_ref,a.operation,a.round_number,a.worker_attempt,
 case when a.status='running' and (j.status<>'running' or j.lease_token is distinct from a.lease_token or j.lease_until<=now()) then 'interrupted' else a.status end status,
 a.result_code,a.sent,coalesce(a.usage_id,u.id) usage_id,a.started_at,a.finished_at,
 case when a.finished_at is not null then round(extract(epoch from a.finished_at-a.started_at)*1000)::bigint end duration_ms,
 a.http_status,a.request_id,a.response_id,a.reported_model,a.finish_reason,a.request_phase,a.retry_after,
 u.actual_input,u.actual_output,u.thinking_tokens,u.reserved_input,u.reserved_output,u.state usage_state,u.remote_request_id,
 p.id plan_id,p.opportunity_id,p.proposal_id,o.title opportunity_title,j.status job_status,j.error_code job_error,j.next_attempt_at,
 -- Keep numeric ordering separate from the lossless text identifier delivered to JS.
 a.id sequence,a.provider_error_code,a.provider_error_type,a.provider_error_reason,
 a.connection_id,a.model_config_id,a.execution_metadata,a.provider_error_scope
from public.model_attempts a join public.jobs j on j.id=a.job_id and j.workspace_id=a.workspace_id
left join public.provider_usage u on u.workspace_id=a.workspace_id and (u.id=a.usage_id or (a.usage_id is null and u.job_id=a.job_id and u.lease_token=a.lease_token and u.provider=a.provider and u.model=a.model and u.connection_id is not distinct from a.connection_id and u.model_config_id is not distinct from a.model_config_id))
left join public.generation_steps s on s.job_id=j.id and s.workspace_id=a.workspace_id
left join public.generation_plans p on p.id=coalesce(s.plan_id,case when j.type<>'model_probe' then j.entity_id end) and p.workspace_id=a.workspace_id
left join public.opportunities o on o.id=p.opportunity_id and o.workspace_id=a.workspace_id;
