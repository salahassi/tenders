-- Bound accepted background requests independently of short worker leases.
-- Defaults retain serial behavior until an Owner changes the runtime limit.
alter table public.model_execution_settings
 add column max_parallel_requests integer not null default 1
 check(max_parallel_requests between 1 and 4);

create function app_private.model_request_limit(workspace uuid) returns integer
language sql stable security definer set search_path='' as $$
 select coalesce((select max_parallel_requests from public.model_execution_settings
  where workspace_id=workspace),1);
$$;
revoke all on function app_private.model_request_limit(uuid) from public,anon,authenticated,service_role;

do $patch$ declare definition text;marker text;begin
 select pg_get_functiondef('public.app_command(text,jsonb,text)'::regprocedure) into definition;
 marker := 'perform app_private.check_keys(input,array[''expected_revision'',''enabled'']);';
 if position(marker in definition)=0 then raise exception 'Execution command validation changed';end if;
 definition:=replace(definition,marker,$sql$perform app_private.check_keys(input,array['expected_revision','enabled','max_parallel_requests']);
  if input ? 'max_parallel_requests' and (
   jsonb_typeof(input->'max_parallel_requests') is distinct from 'number'
   or (input->>'max_parallel_requests') !~ '^[1-4]$'
  ) then raise exception 'INVALID_INPUT';end if;$sql$);
 marker := 'insert into public.model_execution_settings(workspace_id,enabled,admitted_after,created_by)';
 if position(marker in definition)=0 then raise exception 'Execution command insert changed';end if;
 definition:=replace(definition,marker,'insert into public.model_execution_settings(workspace_id,enabled,admitted_after,created_by,max_parallel_requests)');
 marker := 'values(w,(input->>''enabled'')::boolean,case when input->>''enabled''=''true'' then now() end,actor)';
 if position(marker in definition)=0 then raise exception 'Execution command values changed';end if;
 definition:=replace(definition,marker,$sql$values(w,(input->>'enabled')::boolean,case when input->>'enabled'='true' then now() end,actor,
   coalesce((input->>'max_parallel_requests')::integer,app_private.model_request_limit(w)))$sql$);
 marker := 'on conflict(workspace_id) do update set enabled=excluded.enabled,';
 if position(marker in definition)=0 then raise exception 'Execution command update changed';end if;
 definition:=replace(definition,marker,marker||'max_parallel_requests=excluded.max_parallel_requests,');
 execute definition;

 select pg_get_functiondef('public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)'::regprocedure) into definition;
 marker := 'if exists(select 1 from public.provider_usage p where p.workspace_id=j.workspace_id and p.state=''reserved'') then raise exception ''MODEL_RATE_WAIT'';end if;';
 if position(marker in definition)=0 then raise exception 'Task capacity guard changed';end if;
 -- model_job holds the workspace lock before counting and inserting. Same-job
 -- reservations remain exclusive even when two different jobs can be pending.
 definition:=replace(definition,marker,$sql$if exists(select 1 from public.provider_usage p where p.job_id=j.id and p.state='reserved')
  or (select count(*) from public.provider_usage p where p.workspace_id=j.workspace_id and p.state='reserved')
    >=app_private.model_request_limit(j.workspace_id) then raise exception 'MODEL_RATE_WAIT';end if;$sql$);
 marker := 'p.workspace_id=j.workspace_id and (p.state=''reserved'' or';
 if position(marker in definition)=0 then raise exception 'Task uncertainty guard changed';end if;
 -- Active capacity is handled above. Preserve the exact account/model/input/
 -- phase uncertainty guard below, without turning old unknown usage into slots.
 definition:=replace(definition,marker,'p.workspace_id=j.workspace_id and (false or');
 execute definition;

 select pg_get_functiondef('app_private.wake_backend_queue_checked(uuid,uuid,bigint)'::regprocedure) into definition;
 marker := 'u.state=''reserved'' or (u.state=''unknown'' and u.provider=pending.provider';
 if position(marker in definition)=0 then raise exception 'Accepted poll guard changed';end if;
 -- Accepted requests must remain pollable when the limit is reduced. Another
 -- job's known request does not make this request ambiguous; a duplicate on
 -- this job and the original unknown-usage guard still block unsafe wakes.
 definition:=replace(definition,marker,'(u.state=''reserved'' and u.job_id=j.id) or (u.state=''unknown'' and u.provider=pending.provider');
 marker := '(not remote_poll and exists(select 1 from public.provider_usage where workspace_id=w and state=''reserved''))';
 if position(marker in definition)=0 then raise exception 'Queue wake capacity guard changed';end if;
 definition:=replace(definition,marker,$sql$(not remote_poll and (select count(*) from public.provider_usage where workspace_id=w and state='reserved')
   >=app_private.model_request_limit(w))$sql$);
 execute definition;
end $patch$;

-- No running job, accepted request, frozen prompt, usage record, lease, attempt
-- count or graph budget is rewritten by this migration. Worker leases remain
-- serialized; the limit applies to requests waiting at providers.
