-- New writes use the source-resolution-capable worker. Existing queued rows,
-- model protocol pins, accepted clocks and provider accounting are not rewritten.
-- This trigger sorts after the existing per-contract triggers, which may still
-- select historical minimum4 for their immutable wire format.
create function app_private.guard_current_worker_capability() returns trigger
language plpgsql security definer set search_path='' as $$begin
 if tg_op='INSERT' then
  new.checkpoint:=new.checkpoint||jsonb_build_object('minimum_worker_executor',greatest(5,coalesce((new.checkpoint->>'minimum_worker_executor')::integer,1)));
 elsif coalesce((old.checkpoint->>'minimum_worker_executor')::integer,1)>=5 then
  new.checkpoint:=new.checkpoint||jsonb_build_object('minimum_worker_executor',greatest((old.checkpoint->>'minimum_worker_executor')::integer,coalesce((new.checkpoint->>'minimum_worker_executor')::integer,1)));
 end if;
 return new;
end$$;
create trigger zzzz_current_worker_capability before insert or update on public.jobs
 for each row execute function app_private.guard_current_worker_capability();

create function public.claim_backend_job_v5() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;previous text:=current_setting('app.worker_executor',true);begin
 perform set_config('app.worker_executor','5',true);
 result:=public.claim_backend_job();
 perform set_config('app.worker_executor',coalesce(previous,''),true);return result;
end$$;
create function public.claim_backend_local_job_v5() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;previous text:=current_setting('app.queue_local_only',true);begin
 perform set_config('app.queue_local_only','true',true);
 result:=public.claim_backend_job_v5();
 perform set_config('app.queue_local_only',coalesce(previous,''),true);return result;
end$$;

-- Wake admission is advisory but must respect the same floor as real claims.
-- Preserve existing eligibility, render lanes, throttle and remote-poll guards.
do $$declare definition text;signature text;marker text;alias_name text;begin
 foreach signature in array array[
  'app_private.wake_backend_queue_checked(uuid,uuid,bigint)',
  'app_private.wake_backend_queue_checked_v3(uuid,uuid,bigint)',
  'app_private.wake_backend_queue_checked_v4(uuid,uuid,bigint)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  foreach alias_name in array array['q','j','ready'] loop
   marker:='coalesce(('||alias_name||'.checkpoint->>''model_executor'')::int,1)';
   if position(marker in definition)=0 then raise exception 'WORKER_FIVE_WAKE_FLOOR_CHANGED: %',alias_name;end if;
   definition:=replace(definition,marker,'greatest('||marker||',coalesce(('||alias_name||'.checkpoint->>''minimum_worker_executor'')::int,1))');
  end loop;
  execute definition;
 end loop;
 definition:=pg_get_functiondef('app_private.wake_backend_queue_checked_v4(uuid,uuid,bigint)'::regprocedure);
 if position('<=4' in definition)=0 then raise exception 'WORKER_FIVE_WAKE_CAPABILITY_CHANGED';end if;
 execute replace(replace(definition,'app_private.wake_backend_queue_checked_v4(','app_private.wake_backend_queue_checked_v5('),'<=4','<=5');
end$$;
create function public.wake_backend_queue_status_v5(job_id uuid,lease uuid) returns jsonb
language sql security definer set search_path='' as $$select app_private.wake_backend_queue_checked_v5(job_id,lease,null)$$;
create function public.wake_backend_queue_revision_v5(job_id uuid,lease uuid,expected_revision bigint) returns jsonb
language sql security definer set search_path='' as $$select case when expected_revision is null then '{"dispatched":false}'::jsonb else app_private.wake_backend_queue_checked_v5(job_id,lease,expected_revision) end$$;

do $$declare signature text;r text;begin
 foreach signature in array array[
  'app_private.guard_current_worker_capability()',
  'app_private.wake_backend_queue_checked_v5(uuid,uuid,bigint)',
  'public.claim_backend_job_v5()','public.claim_backend_local_job_v5()',
  'public.wake_backend_queue_status_v5(uuid,uuid)','public.wake_backend_queue_revision_v5(uuid,uuid,bigint)'] loop
  execute 'revoke all on function '||signature||' from public';
  foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=r) then
    execute 'revoke all on function '||signature||' from '||quote_ident(r);
    if r in ('service_role','tdp_app_service') and signature like 'public.%' then
     execute 'grant execute on function '||signature||' to '||quote_ident(r);
    end if;
   end if;
  end loop;
 end loop;
end$$;
