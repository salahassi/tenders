-- Continue normal due work after cancellation, and schedule one bounded wake
-- for the same healthy accepted remote request. No job/request/usage is mutated.
create function app_private.wake_backend_queue_checked(job_id uuid,lease uuid,expected_revision bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;w uuid;wake_time timestamptz;last_wake timestamptz;delay_ms integer;pending public.provider_usage;remote_poll boolean:=false;eligible_at timestamptz;
begin
 if job_id is null or lease is null then return '{"dispatched":false}'::jsonb;end if;
 select workspace_id into w from public.jobs where id=job_id;
 if w is null then return '{"dispatched":false}'::jsonb;end if;
 perform 1 from public.workspaces where id=w for update;
 select * into j from public.jobs where id=job_id;
 if j.id is null or (j.cancel_requested and j.status<>'canceled') or j.lease_token is not null or j.lease_until is not null
  or (expected_revision is not null and j.revision<>expected_revision) then return '{"dispatched":false}'::jsonb;end if;
 -- Only an HTTP-successful accepted request can use the poll wake. Failures,
 -- unknown/unaccepted reservations and a different callback lease stay on cron.
 if j.status='retry_wait' and j.error_code='MODEL_IN_PROGRESS' and j.checkpoint ? 'model_round' then
  select * into pending from public.provider_usage u where u.workspace_id=w and u.job_id=j.id
   and u.state='reserved' and u.lease_token=lease and u.remote_request_id is not null and u.remote_deadline>now();
  remote_poll:=coalesce(pending.id is not null
   and j.checkpoint->'model_round'->>'input_hash'=pending.input_hash
   and coalesce((j.checkpoint->>'model_executor')::int,1)<=2 and exists(select 1 from public.model_attempts a
   where a.id=(select max(latest.id) from public.model_attempts latest where latest.job_id=j.id and latest.lease_token=lease)
    and a.usage_id=pending.id and a.status='waiting' and a.result_code='MODEL_IN_PROGRESS'
    and a.http_status=200 and a.request_phase in ('generation','poll') and a.retry_after is null)
   -- Match the existing task-reservation uncertainty scope: old unresolved
   -- telemetry is not a workspace-wide active slot. Keep potentially live
   -- ambiguity for this account/model and input/phase, with legacy keys failing
   -- closed at job scope. Every other known reservation still blocks the wake.
   and not exists(select 1 from public.provider_usage u where u.workspace_id=w and u.id<>pending.id and (
    u.state='reserved' or (u.state='unknown' and u.provider=pending.provider
     and u.connection_id is not distinct from pending.connection_id and u.model=pending.model
     and (u.created_at>now()-interval '15 minutes' or u.remote_deadline>now())
     and (u.input_hash=pending.input_hash or (u.job_id=j.id and (
      u.call_key !~ ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$' or pending.call_key !~ ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$' or
      regexp_replace(u.call_key, ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$', '')=
       regexp_replace(pending.call_key, ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$', '')
     ))))
   ))
   and j.next_attempt_at<=clock_timestamp()+interval '60 seconds',false);
 end if;
 if not remote_poll and j.status not in ('succeeded','blocked','failed','canceled') and not coalesce((
  j.status='retry_wait' and j.error_code='MODEL_IN_PROGRESS' and j.next_attempt_at<=now()
  and j.checkpoint ? 'graph_thread' and not (j.checkpoint ? 'model_round')
  and exists(select 1 from public.model_attempts a where a.job_id=j.id and a.lease_token=lease and a.status='succeeded')
  and not exists(select 1 from public.model_attempts a where a.job_id=j.id and a.lease_token=lease and a.status<>'succeeded')
 ),false) then return '{"dispatched":false}'::jsonb;end if;
 if not exists(select 1 from app_private.dispatcher_settings where singleton and enabled)
  or exists(select 1 from public.restore_sessions where workspace_id=w and state='staging')
  or exists(select 1 from public.jobs where workspace_id=w and status='running')
  or (not remote_poll and exists(select 1 from public.provider_usage where workspace_id=w and state='reserved')) then return '{"dispatched":false}'::jsonb;end if;
 if exists(select 1 from app_private.worker_queue_wakes q where q.job_id=j.id and q.job_revision>=j.revision) then return '{"dispatched":false}'::jsonb;end if;
 if not remote_poll and not exists(select 1 from public.jobs q where q.workspace_id=w and not q.cancel_requested
  and (j.status not in ('blocked','failed','canceled') or q.id<>j.id)
  and q.next_attempt_at<=now() and coalesce((q.checkpoint->>'model_executor')::int,1)<=2
  and (q.status='queued' or (q.status='retry_wait' and q.error_code='MODEL_IN_PROGRESS' and not (q.checkpoint ? 'model_round')))
 ) then return '{"dispatched":false}'::jsonb;end if;
 wake_time:=clock_timestamp();
 select max(q.dispatched_at) into last_wake from app_private.worker_queue_wakes q where q.workspace_id=w;
 eligible_at:=greatest(coalesce(last_wake+interval '10 seconds',wake_time),
  case when remote_poll then j.next_attempt_at else wake_time end);
 if eligible_at>wake_time then
  delay_ms:=greatest(1,ceil(extract(epoch from eligible_at-wake_time)*1000)::integer);
  if remote_poll then
   if delay_ms>60000 then return '{"dispatched":false}'::jsonb;end if;
   return jsonb_build_object('dispatched',false,'retry_after_ms',delay_ms,'wait_kind','accepted_remote_poll','job_revision',j.revision);
  end if;
  return jsonb_build_object('dispatched',false,'retry_after_ms',least(10000,delay_ms));
 end if;
 perform app_private.dispatch_backend();
 insert into app_private.worker_queue_wakes(job_id,workspace_id,job_revision,dispatched_at)
 values(j.id,w,j.revision,wake_time)
 on conflict on constraint worker_queue_wakes_pkey do update set job_revision=excluded.job_revision,dispatched_at=excluded.dispatched_at;
 return '{"dispatched":true}'::jsonb;
end $$;

create or replace function public.wake_backend_queue_status(job_id uuid,lease uuid)
returns jsonb language sql security definer set search_path='' as $$
 select app_private.wake_backend_queue_checked(job_id,lease,null);
$$;
create function public.wake_backend_queue_revision(job_id uuid,lease uuid,expected_revision bigint)
returns jsonb language sql security definer set search_path='' as $$
 select case when expected_revision is null then '{"dispatched":false}'::jsonb
  else app_private.wake_backend_queue_checked(job_id,lease,expected_revision) end;
$$;
revoke all on function app_private.wake_backend_queue_checked(uuid,uuid,bigint) from public,anon,authenticated,service_role;
revoke all on function public.wake_backend_queue_status(uuid,uuid),public.wake_backend_queue_revision(uuid,uuid,bigint)
 from public,anon,authenticated;
grant execute on function public.wake_backend_queue_status(uuid,uuid),public.wake_backend_queue_revision(uuid,uuid,bigint)
 to service_role;
