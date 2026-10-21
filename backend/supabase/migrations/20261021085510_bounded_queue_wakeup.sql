-- Wake the existing dispatcher after useful work releases its lease. This does
-- not claim jobs, change their order/timing, or replace the minute cron fallback.
create table app_private.worker_queue_wakes (
 job_id uuid primary key references public.jobs(id) on delete cascade,
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 job_revision integer not null,
 dispatched_at timestamptz not null
);
create index worker_queue_wakes_workspace_time on app_private.worker_queue_wakes(workspace_id,dispatched_at desc);
alter table app_private.worker_queue_wakes enable row level security;
revoke all on app_private.worker_queue_wakes from public,anon,authenticated,service_role;

create function public.wake_backend_queue(job_id uuid,lease uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare j public.jobs;w uuid;wake_time timestamptz;
begin
 if job_id is null or lease is null then return false;end if;
 select workspace_id into w from public.jobs where id=job_id;
 if w is null then return false;end if;
 -- The same workspace lock used by claiming/reservation serializes wake checks
 -- with lease acquisition and concurrent completion callbacks.
 perform 1 from public.workspaces where id=w for update;
 select * into j from public.jobs where id=job_id;
 if j.id is null or j.cancel_requested or j.lease_token is not null or j.lease_until is not null then return false;end if;
 if j.status<>'succeeded' and not coalesce((
  j.status='retry_wait' and j.error_code='MODEL_IN_PROGRESS' and j.next_attempt_at<=now()
  and j.checkpoint ? 'graph_thread' and not (j.checkpoint ? 'model_round')
  -- Only a successfully settled phase may wake its local graph continuation.
  -- Provider waits, failed rounds and capacity waits keep their existing retry.
  and exists(select 1 from public.model_attempts a where a.job_id=j.id and a.lease_token=lease and a.status='succeeded')
  and not exists(select 1 from public.model_attempts a where a.job_id=j.id and a.lease_token=lease and a.status<>'succeeded')
 ),false) then return false;end if;
 if not exists(select 1 from app_private.dispatcher_settings where singleton and enabled)
  or exists(select 1 from public.restore_sessions where workspace_id=w and state='staging')
  or exists(select 1 from public.jobs where workspace_id=w and status='running')
  or exists(select 1 from public.provider_usage where workspace_id=w and state='reserved') then return false;end if;
 if exists(select 1 from app_private.worker_queue_wakes q where q.job_id=j.id and q.job_revision>=j.revision) then return false;end if;
 wake_time:=clock_timestamp();
 if exists(select 1 from app_private.worker_queue_wakes q where q.workspace_id=w and q.dispatched_at>wake_time-interval '10 seconds') then return false;end if;
 if not exists(select 1 from public.jobs q where q.workspace_id=w and not q.cancel_requested
  and q.next_attempt_at<=now() and coalesce((q.checkpoint->>'model_executor')::int,1)<=2
  and (q.status='queued' or (q.status='retry_wait' and q.error_code='MODEL_IN_PROGRESS' and not (q.checkpoint ? 'model_round')))
 ) then return false;end if;
 -- Existing dispatcher owns the URL, Vault credential and HTTP invocation.
 -- An error rolls back the receipt; the caller keeps completed work intact.
 perform app_private.dispatch_backend();
 insert into app_private.worker_queue_wakes(job_id,workspace_id,job_revision,dispatched_at)
 values(j.id,w,j.revision,wake_time)
 on conflict on constraint worker_queue_wakes_pkey do update set job_revision=excluded.job_revision,dispatched_at=excluded.dispatched_at;
 return true;
end $$;
revoke all on function public.wake_backend_queue(uuid,uuid) from public,anon,authenticated;
grant execute on function public.wake_backend_queue(uuid,uuid) to service_role;
