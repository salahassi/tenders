-- Share a provider/model outage across jobs when the provider omits Retry-After.
-- A healthy model stays usable, and an accepted remote result can still be polled.
create or replace function public.model_retry_windows(job_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs;result jsonb;
begin
 select * into j from public.jobs where id=job_id;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 with requests as (
  select a.* from public.model_attempts a where a.workspace_id=j.workspace_id and a.started_at>now()-interval '1 day'
   and (a.sent or a.http_status is not null) and a.status not in ('running','waiting')
 ), latest as (
  select distinct on (provider,model,project_ref) * from requests order by provider,model,project_ref,id desc
 ), waits as (
  select l.provider,l.model,l.project_ref,greatest(
   case when l.http_status in (413,429,503) then l.retry_after end,
   case when l.http_status=429 or l.http_status>=500 or (l.http_status is null and l.result_code='MODEL_NETWORK_UNCERTAIN') then
    l.started_at+make_interval(secs=>least(3600,60*power(2,least(6,(
     select count(*) from requests a where a.provider=l.provider and a.model=l.model and a.project_ref=l.project_ref
      and a.id>coalesce((select max(ok.id) from requests ok where ok.provider=l.provider and ok.model=l.model and ok.project_ref=l.project_ref
       and not (coalesce(ok.http_status=429 or ok.http_status>=500,false) or (ok.http_status is null and ok.result_code='MODEL_NETWORK_UNCERTAIN'))),0)
    )::int-1)))::int)
   end
  ) as retry_after
  from latest l
 )
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (select provider,model,project_ref,least(retry_after,now()+interval '1 day') as retry_after from waits where retry_after>now()) x;
 return result;
end $$;
revoke all on function public.model_retry_windows(uuid,uuid) from public,anon,authenticated;
grant execute on function public.model_retry_windows(uuid,uuid) to service_role;
