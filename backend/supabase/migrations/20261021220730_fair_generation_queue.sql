-- Durable class/owner fairness. Work remains on the existing leased jobs queue.
create table app_private.queue_dispatch_state (
 workspace_id uuid primary key references public.workspaces(id) on delete cascade,
 cursor bigint not null default 0,
 dispatch_count bigint not null default 0
);
create table app_private.queue_owner_service (
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 work_class text not null check(work_class in ('local','poll','proposal','background')),
 entity_id uuid not null,
 last_dispatch bigint not null,
 primary key(workspace_id,work_class,entity_id)
);
revoke all on app_private.queue_dispatch_state,app_private.queue_owner_service from public,anon,authenticated,service_role;

create function app_private.queue_work_class(j public.jobs) returns text
language sql stable security definer set search_path='' as $$
 select case when j.type='advance_plan' then 'local'
 when j.error_code='MODEL_IN_PROGRESS' and exists(
  select 1 from public.provider_usage u where u.workspace_id=j.workspace_id and u.job_id=j.id
   and u.state='reserved' and u.remote_request_id is not null
 ) then 'poll'
 when exists(select 1 from public.generation_plans p where p.id=j.entity_id and p.workspace_id=j.workspace_id and p.kind='proposal') then 'proposal'
 when exists(select 1 from public.generation_plans p where p.id=j.entity_id and p.workspace_id=j.workspace_id) then 'background'
 -- Compatibility for non-plan probes and historical jobs. An owning plan,
 -- when present, always determines the business class before this fallback.
 when j.type in ('analyze_chunk','summarize_review','plan_proposal','draft_section','plan_commercial','review_proposal','model_probe') then 'proposal'
 else 'background' end;
$$;
revoke all on function app_private.queue_work_class(public.jobs) from public,anon,authenticated,service_role;

create function app_private.queue_needs_notice_details(j public.jobs) returns boolean
language sql stable security definer set search_path='' as $$
 select j.type='classify_opportunity' and exists(
  select 1 from public.generation_plans p join public.opportunities o on o.id=p.opportunity_id
  join public.sources s on s.id=o.source_id where p.id=j.entity_id and p.workspace_id=j.workspace_id
  and (s.adapter_config ? 'official_listing' or s.adapter_config->'automatic'='true'::jsonb)
  and (coalesce(o.notice_evidence->>'version','')<>'1'
   or o.notice_evidence->>'notice_hash' is distinct from app_private.content_record(o.workspace_id,'notice',o.id)->>'content_hash'
   or (o.notice_evidence->>'fetched_at')::timestamptz<s.last_success_at));
$$;
revoke all on function app_private.queue_needs_notice_details(public.jobs) from public,anon,authenticated,service_role;

create function app_private.next_fair_job(workspace uuid,local_only boolean default false) returns uuid
language plpgsql security definer set search_path='' as $$
declare scheduler app_private.queue_dispatch_state;chosen record;slots text[]:=array['local','poll','proposal','local','poll','background'];capacity boolean;
begin
 -- Caller holds the workspace lock; service order commits with the job lease.
 insert into app_private.queue_dispatch_state(workspace_id) values(workspace) on conflict do nothing;
 select * into scheduler from app_private.queue_dispatch_state where workspace_id=workspace for update;
 capacity:=(select count(*) from public.provider_usage where workspace_id=workspace and state='reserved')<app_private.model_request_limit(workspace);
 select q.id,q.entity_id,c.work_class,slot.distance into chosen
 from public.jobs q
 cross join lateral (select app_private.queue_work_class(q) work_class) c
 cross join lateral (select min((n-1-scheduler.cursor%6+6)%6) distance from generate_subscripts(slots,1) n where slots[n]=c.work_class) slot
 left join app_private.queue_owner_service served on served.workspace_id=workspace and served.work_class=c.work_class and served.entity_id=q.entity_id
 where q.workspace_id=workspace and q.status in ('queued','retry_wait','quota_wait') and q.next_attempt_at<=now()
  and coalesce((q.checkpoint->>'model_executor')::int,1)<=coalesce(nullif(current_setting('app.worker_executor',true),'')::int,1)
  and (not local_only or c.work_class='local')
  and (capacity or c.work_class in ('local','poll') or q.type in ('source_collect','source_candidates') or q.cancel_requested or app_private.queue_needs_notice_details(q))
  and (q.type<>'advance_plan' or not exists(select 1 from public.generation_plans p join public.generation_steps s on s.plan_id=p.id
   where p.id=q.entity_id and s.stage=p.stage and s.task<>'advance_plan' and s.status not in ('completed','split')))
 order by slot.distance,
  coalesce(served.last_dispatch,-1),
  case when q.type in ('source_collect','source_candidates') then 0 else 1 end,
  case when app_private.queue_needs_notice_details(q) then 0 else 1 end,
  -- Within a serviced owner, accepted deadlines and oldest eligible work win.
  case when c.work_class='poll' then (select min(u.remote_deadline) from public.provider_usage u where u.job_id=q.id and u.state='reserved') end,
  q.next_attempt_at,q.created_at,q.id
 for update of q skip locked limit 1;
 if chosen.id is null then return null;end if;
 update app_private.queue_dispatch_state set
  cursor=case when local_only then cursor else cursor+chosen.distance+1 end,
  dispatch_count=dispatch_count+1 where workspace_id=workspace;
 insert into app_private.queue_owner_service(workspace_id,work_class,entity_id,last_dispatch)
 values(workspace,chosen.work_class,chosen.entity_id,scheduler.dispatch_count+1)
 on conflict(workspace_id,work_class,entity_id) do update set last_dispatch=excluded.last_dispatch;
 return chosen.id;
end $$;
revoke all on function app_private.next_fair_job(uuid,boolean) from public,anon,authenticated,service_role;

do $patch$ declare definition text;start_at integer;end_at integer;marker text;begin
 select pg_get_functiondef('public.claim_backend_job()'::regprocedure) into definition;
 start_at:=position(' select coalesce((select recent.type' in definition);
 end_at:=position(' if j.id is null then return null;end if;' in definition);
 if start_at=0 or end_at<=start_at then raise exception 'Queue selection changed';end if;
 definition:=substring(definition from 1 for start_at-1)||$sql$
 j.id:=app_private.next_fair_job(w,coalesce(current_setting('app.queue_local_only',true),'')='true');
 select * into j from public.jobs where id=j.id;
$sql$||substring(definition from end_at);
 execute definition;

 select pg_get_functiondef('app_private.wake_backend_queue_checked(uuid,uuid,bigint)'::regprocedure) into definition;
 marker:=$sql$(not remote_poll and (select count(*) from public.provider_usage where workspace_id=w and state='reserved')
   >=app_private.model_request_limit(w))$sql$;
 if position(marker in definition)=0 then raise exception 'Queue capacity wake guard changed';end if;
 definition:=replace(definition,marker,$sql$(not remote_poll and (select count(*) from public.provider_usage where workspace_id=w and state='reserved')
   >=app_private.model_request_limit(w) and not exists(select 1 from public.jobs ready
    where ready.workspace_id=w and ready.type='advance_plan' and not ready.cancel_requested
     and ready.status in ('queued','retry_wait','quota_wait') and ready.next_attempt_at<=now()
     and coalesce((ready.checkpoint->>'model_executor')::int,1)<=2))$sql$);
 execute definition;
end $patch$;

-- Bounded local continuation uses the same recovery, dependency and lease checks.
create function public.claim_backend_local_job() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;previous text:=current_setting('app.queue_local_only',true);
begin
 perform set_config('app.queue_local_only','true',true);
 result:=public.claim_backend_job_v2();
 perform set_config('app.queue_local_only',coalesce(previous,''),true);
 return result;
end $$;
revoke all on function public.claim_backend_local_job() from public,anon,authenticated;
grant execute on function public.claim_backend_local_job() to service_role;
