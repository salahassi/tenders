-- A provider's Retry-After applies to that provider/model, not the entire pool.
create function public.model_retry_windows(job_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs;result jsonb;
begin
 select * into j from public.jobs where id=job_id;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
  select provider,model,project_ref,least(retry_after,now()+interval '1 day') as retry_after from (
   select distinct on (a.provider,a.model,a.project_ref) a.provider,a.model,a.project_ref,a.http_status,a.retry_after
   from public.model_attempts a where a.workspace_id=j.workspace_id and a.sent and a.started_at>now()-interval '1 day'
   order by a.provider,a.model,a.project_ref,a.id desc
  ) last_request where http_status in (413,429,503) and retry_after>now()
 ) x;
 return result;
end $$;
revoke all on function public.model_retry_windows(uuid,uuid) from public,anon,authenticated;
grant execute on function public.model_retry_windows(uuid,uuid) to service_role;

-- Repair old pool-wide delays while retaining each provider's recorded cooldown.
with rescheduled as (
 update public.jobs set next_attempt_at=now()+interval '1 hour',revision=revision+1,updated_at=now()
 where status='retry_wait' and not cancel_requested and error_code='MODEL_ROUND_EXHAUSTED' and next_attempt_at>now()+interval '1 hour'
 returning workspace_id,id,entity_id,type,created_by
), source_schedule as (
 update public.sources s set next_due=now()+interval '1 hour',updated_at=now()
 from rescheduled j where j.type='source_collect' and s.id=j.entity_id and s.workspace_id=j.workspace_id returning s.id
)
insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
select workspace_id,created_by,'job.retry_policy.corrected',id,'Provider-specific Retry-After replaces the previous pool-wide delay.',gen_random_uuid() from rescheduled;
