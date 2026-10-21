-- Report a bounded cooldown only after every other wake guard passes. Workers
-- may wait outside the released job lease and retry once; the retry executes
-- these same guards again. Older workers keep the boolean RPC contract.
create function public.wake_backend_queue_status(job_id uuid,lease uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;w uuid;wake_time timestamptz;last_wake timestamptz;delay_ms integer;
begin
 if job_id is null or lease is null then return '{"dispatched":false}'::jsonb;end if;
 select workspace_id into w from public.jobs where id=job_id;
 if w is null then return '{"dispatched":false}'::jsonb;end if;
 perform 1 from public.workspaces where id=w for update;
 select * into j from public.jobs where id=job_id;
 if j.id is null or j.cancel_requested or j.lease_token is not null or j.lease_until is not null then return '{"dispatched":false}'::jsonb;end if;
 if j.status not in ('succeeded','blocked','failed') and not coalesce((
  j.status='retry_wait' and j.error_code='MODEL_IN_PROGRESS' and j.next_attempt_at<=now()
  and j.checkpoint ? 'graph_thread' and not (j.checkpoint ? 'model_round')
  and exists(select 1 from public.model_attempts a where a.job_id=j.id and a.lease_token=lease and a.status='succeeded')
  and not exists(select 1 from public.model_attempts a where a.job_id=j.id and a.lease_token=lease and a.status<>'succeeded')
 ),false) then return '{"dispatched":false}'::jsonb;end if;
 if not exists(select 1 from app_private.dispatcher_settings where singleton and enabled)
  or exists(select 1 from public.restore_sessions where workspace_id=w and state='staging')
  or exists(select 1 from public.jobs where workspace_id=w and status='running')
  or exists(select 1 from public.provider_usage where workspace_id=w and state='reserved') then return '{"dispatched":false}'::jsonb;end if;
 if exists(select 1 from app_private.worker_queue_wakes q where q.job_id=j.id and q.job_revision>=j.revision) then return '{"dispatched":false}'::jsonb;end if;
 if not exists(select 1 from public.jobs q where q.workspace_id=w and not q.cancel_requested
  and (j.status not in ('blocked','failed') or q.id<>j.id)
  and q.next_attempt_at<=now() and coalesce((q.checkpoint->>'model_executor')::int,1)<=2
  and (q.status='queued' or (q.status='retry_wait' and q.error_code='MODEL_IN_PROGRESS' and not (q.checkpoint ? 'model_round')))
 ) then return '{"dispatched":false}'::jsonb;end if;
 wake_time:=clock_timestamp();
 select max(q.dispatched_at) into last_wake from app_private.worker_queue_wakes q where q.workspace_id=w;
 if last_wake>wake_time-interval '10 seconds' then
  delay_ms:=least(10000,greatest(1,ceil(extract(epoch from last_wake+interval '10 seconds'-wake_time)*1000)::integer));
  return jsonb_build_object('dispatched',false,'retry_after_ms',delay_ms);
 end if;
 perform app_private.dispatch_backend();
 insert into app_private.worker_queue_wakes(job_id,workspace_id,job_revision,dispatched_at)
 values(j.id,w,j.revision,wake_time)
 on conflict on constraint worker_queue_wakes_pkey do update set job_revision=excluded.job_revision,dispatched_at=excluded.dispatched_at;
 return '{"dispatched":true}'::jsonb;
end $$;

create or replace function public.wake_backend_queue(job_id uuid,lease uuid)
returns boolean language sql security definer set search_path='' as $$
 select coalesce((public.wake_backend_queue_status(job_id,lease)->>'dispatched')::boolean,false);
$$;
revoke all on function public.wake_backend_queue_status(uuid,uuid),public.wake_backend_queue(uuid,uuid)
 from public,anon,authenticated;
grant execute on function public.wake_backend_queue_status(uuid,uuid),public.wake_backend_queue(uuid,uuid)
 to service_role;
