-- Per-request limits are independent of obsolete daily application quotas.
alter table public.provider_usage drop constraint provider_usage_reserved_output_check;
alter table public.provider_usage add constraint provider_usage_reserved_output_check check(reserved_output between 1 and 131072);
alter table public.provider_usage drop constraint provider_usage_reserved_input_check;
alter table public.provider_usage add constraint provider_usage_reserved_input_check check(reserved_input between 1 and 2000000);
alter table public.provider_usage add column connection_id uuid, add column model_config_id uuid,
 add column execution_metadata jsonb,
 add foreign key(workspace_id,connection_id) references public.model_connections(workspace_id,id),
 add foreign key(workspace_id,model_config_id) references public.model_configurations(workspace_id,id);
alter table public.model_attempts add column connection_id uuid, add column model_config_id uuid,
 add column execution_metadata jsonb,
 add foreign key(workspace_id,connection_id) references public.model_connections(workspace_id,id),
 add foreign key(workspace_id,model_config_id) references public.model_configurations(workspace_id,id);
create index provider_usage_target_idx on public.provider_usage(workspace_id,model_config_id,job_id);
create index provider_usage_connection_idx on public.provider_usage(workspace_id,connection_id);
create index model_attempts_target_idx on public.model_attempts(workspace_id,model_config_id,started_at desc);
create index model_attempts_connection_idx on public.model_attempts(workspace_id,connection_id,started_at desc);
-- Retain the constraint name for old-worker ON CONFLICT statements.
alter table public.model_attempts drop constraint model_attempts_job_lease_provider_key;
alter table public.model_attempts add constraint model_attempts_job_lease_provider_key
 unique nulls not distinct(job_id,lease_token,provider,model,project_ref,operation,connection_id,model_config_id);

create function app_private.model_job(job_id uuid,lease uuid) returns public.jobs
language plpgsql security definer set search_path='' as $$
declare j public.jobs;
begin
 select * into j from public.jobs where id=job_id;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 select * into j from public.jobs where id=job_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 return j;
end $$;

create function public.prepare_task_model_route(job_id uuid,lease uuid,task_name text,default_profile jsonb,route_task text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.jobs;settings public.model_execution_settings;r public.model_task_routes;fallback public.model_task_routes;
 target_ids uuid[];target_id uuid;entry jsonb;providers jsonb:='[]';offset_pos int:=0;effective_profile jsonb;operation_started timestamptz;catalog jsonb;continued boolean:=false;route_name text:=coalesce(route_task,task_name);
begin
 j:=app_private.model_job(job_id,lease);
 perform app_private.validate_model_profile(default_profile);
 if j.checkpoint->>'model_executor'='2' and j.checkpoint->'model_operation'->>'task'=task_name then
  if j.checkpoint->'model_routing'->>'lease' is distinct from lease::text and not (j.checkpoint ? 'model_round')
   and not exists(select 1 from public.provider_usage u where u.job_id=j.id and state='reserved' and remote_request_id is not null) then
   j.checkpoint:=jsonb_set(jsonb_set(j.checkpoint,'{model_routing,checks}','[]'),
    '{model_routing,round_attempts}',to_jsonb(coalesce((j.checkpoint->'model_routing'->>'round_attempts')::int,0)+1));
  end if;
  update public.jobs set checkpoint=jsonb_set(j.checkpoint,'{model_routing,lease}',to_jsonb(lease::text)) where id=j.id;
  return true;
 end if;
 continued:=j.checkpoint->>'model_executor'='2';
 if continued and (j.checkpoint ? 'model_round' or exists(select 1 from public.provider_usage u where u.job_id=j.id and u.state='reserved')) then raise exception 'MODEL_IN_PROGRESS';end if;
 select * into settings from public.model_execution_settings where workspace_id=j.workspace_id;
 select p.created_at into operation_started from public.generation_steps s join public.generation_plans p on p.id=s.plan_id where s.job_id=j.id;
 if not coalesce(continued,false) and (not coalesce(settings.enabled,false) or coalesce(operation_started,j.created_at)<settings.admitted_after
  or j.checkpoint ? 'model_routing' or exists(select 1 from public.provider_usage u where u.job_id=j.id)) then return false;end if;
 catalog:=j.checkpoint->'model_catalog_snapshot';
 if catalog is null then
  select jsonb_build_object('routes',(select coalesce(jsonb_agg(to_jsonb(tr)),'[]') from public.model_task_routes tr where tr.workspace_id=j.workspace_id),
   'models',(select coalesce(jsonb_agg(jsonb_build_object('provider',conn.provider,'model',cfg.model,'project_ref',conn.project_ref,
    'connection_id',conn.id,'model_config_id',cfg.id,'credential_alias',conn.credential_alias,'capabilities',cfg.capabilities,
    'revision',cfg.revision,'enabled',cfg.enabled and conn.enabled,'automatic',true,'quota_mode','provider_managed','verified_at',cfg.updated_at,
    'quota_ends_at',null,'free_only',false,'billing_verified',false,'free_quota_only',false)),'[]')
    from public.model_configurations cfg join public.model_connections conn on conn.id=cfg.connection_id where cfg.workspace_id=j.workspace_id)) into catalog;
  if pg_column_size(catalog)>131072 then raise exception 'MODEL_CATALOG_TOO_LARGE';end if;
 end if;
 if exists(select 1 from jsonb_array_elements(catalog->'routes') where value->>'task'=task_name) then route_name:=task_name;end if;
 select * into r from jsonb_populate_record(null::public.model_task_routes,(select value from jsonb_array_elements(catalog->'routes') where value->>'task'=route_name));
 select * into fallback from jsonb_populate_record(null::public.model_task_routes,(select value from jsonb_array_elements(catalog->'routes') where value->>'task'='default'));
 target_ids:=coalesce(r.model_ids,'{}')||case when r.id is null or r.inherit_default then coalesce(fallback.model_ids,'{}') else '{}'::uuid[] end;
 -- Preserve first occurrence and deduplicate only identical connection/model configurations.
 target_ids:=array(select x from unnest(target_ids) with ordinality a(x,pos) group by x order by min(pos));
 if cardinality(target_ids)=0 then raise exception 'MODEL_NOT_CONFIGURED';end if;
 if cardinality(target_ids)>32 then raise exception 'INVALID_INPUT';end if;
 effective_profile:=coalesce(r.profile,fallback.profile,default_profile);
 if coalesce(r.strategy,fallback.strategy)='round_robin' then
  offset_pos:=coalesce(r.next_position,fallback.next_position,0)%cardinality(target_ids);
  update public.model_task_routes set next_position=(offset_pos+1)%cardinality(target_ids) where id=coalesce(r.id,fallback.id);
 end if;
 for target_id in select x from unnest(target_ids) with ordinality a(x,pos) order by (pos-1+cardinality(target_ids)-offset_pos)%cardinality(target_ids) loop
  select value||jsonb_build_object('profile',effective_profile,'route_revision',coalesce(r.revision,fallback.revision)) into entry
   from jsonb_array_elements(catalog->'models') where value->>'model_config_id'=target_id::text;
  if entry is null then raise exception 'MODEL_IDENTITY_CHANGED';end if;
  providers:=providers||jsonb_build_array(entry);
 end loop;
 update public.jobs set checkpoint=checkpoint||jsonb_build_object('model_executor',2,'model_catalog_snapshot',catalog,
  'model_operation',jsonb_build_object('task',task_name,'route_id',coalesce(r.id,fallback.id),'route_revision',coalesce(r.revision,fallback.revision),'profile',effective_profile),
  'model_routing',jsonb_build_object('lease',lease,'mode','round_robin','strategy',coalesce(r.strategy,fallback.strategy),'providers',providers,'checks','[]'::jsonb,'round_attempts',1)),
  revision=revision+1,updated_at=now() where id=j.id;
 return true;
end $$;

create function public.task_model_preflight(job_id uuid,lease uuid,manifest jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs;entry jsonb;providers jsonb:='[]';pending uuid;
begin
 j:=app_private.model_job(job_id,lease);
 if j.checkpoint->>'model_executor' is distinct from '2' then raise exception 'MODEL_ROUTING_NOT_PREPARED';end if;
 if j.type='model_probe' and manifest<>'[]'::jsonb then raise exception 'INVALID_INPUT';end if;
 select model_config_id into pending from public.provider_usage u where u.job_id=j.id and state='reserved' and remote_request_id is not null order by created_at desc limit 1;
 for entry in select value from jsonb_array_elements(j.checkpoint->'model_routing'->'providers') with ordinality a(value,pos)
  order by case when value->>'model_config_id'=pending::text then 0 else 1 end,pos loop
  if j.type='model_probe' and j.checkpoint ? 'probe_provider' and entry->>'provider'<>j.checkpoint->>'probe_provider' then continue;end if;
  if j.type<>'model_probe' then
   begin perform app_private.check_model_payload(j.workspace_id,entry->>'provider',manifest);
   exception when raise_exception then if sqlerrm='DATA_AUTHORIZATION_REQUIRED' then continue;else raise;end if;end;
  end if;
  -- Frozen identity survives edits. Disabling either record blocks new sends;
  -- an already accepted request remains pollable with current data permission.
  entry:=jsonb_set(entry,'{enabled}',to_jsonb(coalesce((
   select m.enabled and c.enabled from public.model_configurations m join public.model_connections c on c.id=(entry->>'connection_id')::uuid
   where m.workspace_id=j.workspace_id and m.id=(entry->>'model_config_id')::uuid),false) or coalesce(pending::text=entry->>'model_config_id',false)));
  providers:=providers||jsonb_build_array(entry);
 end loop;
 if j.type<>'model_probe' and jsonb_array_length(providers)=0 and jsonb_array_length(j.checkpoint->'model_routing'->'providers')>0 then raise exception 'DATA_AUTHORIZATION_REQUIRED';end if;
 return jsonb_build_object('providers',providers,'routing_mode','round_robin','executor_version',2,'pending_model_config_id',pending);
end $$;

create function public.reserve_task_model_call(job_id uuid,lease uuid,call_key text,input_hash text,input_tokens integer,output_tokens integer,
 manifest jsonb,target_model uuid,target_connection uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs;pool jsonb;entry jsonb;u public.provider_usage;
begin
 j:=app_private.model_job(job_id,lease);
 pool:=public.task_model_preflight(job_id,lease,manifest);
 select value into entry from jsonb_array_elements(pool->'providers')
  where value->>'model_config_id'=target_model::text and value->>'connection_id'=target_connection::text and value->>'enabled'='true';
 if entry is null then raise exception 'MODEL_NOT_CONFIGURED';end if;
 if input_tokens not between 1 and 2000000 or output_tokens not between 1 and 131072 then raise exception 'MODEL_CONTEXT_TOO_LARGE';end if;
 if call_key is null or length(call_key) not between 1 and 200 or input_hash is null or input_hash !~ '^[0-9a-f]{64}$' then raise exception 'INVALID_INPUT';end if;
 if exists(select 1 from public.provider_usage p where p.job_id=j.id and p.call_key=reserve_task_model_call.call_key) then raise exception 'MODEL_CALL_ALREADY_RESERVED';end if;
 if exists(select 1 from public.provider_usage p where p.workspace_id=j.workspace_id and (p.state='reserved' or
  (p.state='unknown' and p.connection_id=target_connection and p.model=entry->>'model' and
   (p.job_id=j.id or p.input_hash=reserve_task_model_call.input_hash) and (p.created_at>now()-interval '15 minutes' or p.remote_deadline>now()))))
  then raise exception 'USAGE_REVIEW_REQUIRED';end if;
 insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,
  reserved_input,reserved_output,created_by,connection_id,model_config_id,remote_project_ref)
 values(j.workspace_id,j.id,lease,call_key,entry->>'provider',entry->>'model',input_hash,(now() at time zone 'Asia/Riyadh')::date,(entry->>'revision')::int,
  input_tokens,output_tokens,j.created_by,target_connection,target_model,entry->>'project_ref') returning * into u;
 return to_jsonb(u);
end $$;

create function public.resume_task_model_request(job_id uuid,lease uuid,input_hash text,manifest jsonb,target_model uuid,target_connection uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;pool jsonb;entry jsonb;u public.provider_usage;
begin
 j:=app_private.model_job(job_id,lease);pool:=public.task_model_preflight(job_id,lease,manifest);
 select value into entry from jsonb_array_elements(pool->'providers') where value->>'model_config_id'=target_model::text and value->>'connection_id'=target_connection::text;
 if entry is null then raise exception 'MODEL_IDENTITY_CHANGED';end if;
 select * into u from public.provider_usage p where p.job_id=j.id and p.connection_id=target_connection and p.model_config_id=target_model and p.remote_request_id is not null
  order by (p.state='reserved') desc,(p.state='unknown') desc,(p.input_hash=resume_task_model_request.input_hash) desc,p.created_at desc limit 1 for update;
 if u.id is null then return null;end if;
 if u.state='settled' and (u.error_code='PROVIDER_REQUEST_REJECTED' or u.input_hash<>resume_task_model_request.input_hash) then return null;end if;
 if u.input_hash<>resume_task_model_request.input_hash or u.model<>entry->>'model' or u.provider<>entry->>'provider' or u.remote_project_ref<>entry->>'project_ref' then raise exception 'MODEL_IDENTITY_CHANGED';end if;
 update public.provider_usage set lease_token=lease,revision=revision+1,updated_at=now() where id=u.id returning * into u;
 return to_jsonb(u);
end $$;

create function public.start_task_model_attempt(job_id uuid,lease uuid,target_model uuid,target_connection uuid,operation_name text)
returns bigint language plpgsql security definer set search_path='' as $$
declare j public.jobs;entry jsonb;result bigint;
begin
 j:=app_private.model_job(job_id,lease);
 select value into entry from jsonb_array_elements(j.checkpoint->'model_routing'->'providers') where value->>'model_config_id'=target_model::text and value->>'connection_id'=target_connection::text;
 if entry is null or operation_name is distinct from j.checkpoint->'model_operation'->>'task' then raise exception 'MODEL_IDENTITY_CHANGED';end if;
 insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,project_ref,operation,round_number,worker_attempt,status,connection_id,model_config_id)
 values(j.workspace_id,j.id,lease,entry->>'provider',entry->>'model',entry->>'project_ref',operation_name,coalesce((j.checkpoint->'model_routing'->>'round_attempts')::int,1),j.attempts,'running',target_connection,target_model)
 on conflict on constraint model_attempts_job_lease_provider_key do update set operation=excluded.operation returning id into result;
 return result;
end $$;

create function public.save_task_model_round(job_id uuid,lease uuid,progress jsonb,release_job boolean default false)
returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;item jsonb;
begin
 j:=app_private.model_job(job_id,lease);
 if progress is not null then
  perform app_private.check_keys(progress,array['input_hash','remaining','output_error','retry_windows']);
  if pg_column_size(progress)>32768 or coalesce(progress->>'input_hash','') !~ '^[a-f0-9]{64}$' or jsonb_typeof(progress->'remaining') is distinct from 'array'
   or jsonb_array_length(progress->'remaining') not between 1 and 32 or jsonb_typeof(progress->'retry_windows') is distinct from 'array'
   or jsonb_array_length(progress->'retry_windows')>32 then raise exception 'INVALID_INPUT';end if;
  for item in select value from jsonb_array_elements(progress->'remaining') loop
   perform app_private.check_keys(item,array['provider','model','project_ref','model_config_id','connection_id']);
   if not exists(select 1 from jsonb_array_elements(j.checkpoint->'model_routing'->'providers') p where
    p->>'provider'=item->>'provider' and p->>'model'=item->>'model' and p->>'project_ref'=item->>'project_ref' and p->>'model_config_id'=item->>'model_config_id' and p->>'connection_id'=item->>'connection_id')
    then raise exception 'MODEL_IDENTITY_CHANGED';end if;
  end loop;
 end if;
 if release_job and (progress is null or exists(select 1 from public.provider_usage u where u.job_id=j.id and state='reserved')) then raise exception 'MODEL_CALL_ALREADY_RESERVED';end if;
 update public.jobs set checkpoint=case when progress is null then checkpoint-'model_round' else jsonb_set(checkpoint,'{model_round}',progress) end,
  status=case when release_job then 'retry_wait' else status end,error_code=case when release_job then 'MODEL_IN_PROGRESS' else error_code end,
  next_attempt_at=case when release_job then now() else next_attempt_at end,
  lease_token=case when release_job then null else lease_token end,lease_until=case when release_job then null else lease_until end,revision=revision+1,updated_at=now() where id=j.id;
end $$;

create function public.record_task_model_attempt(job_id uuid,lease uuid,target_model uuid,result_code text,sent boolean)
returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;entry jsonb;
begin
 j:=app_private.model_job(job_id,lease);
 select value into entry from jsonb_array_elements(j.checkpoint->'model_routing'->'providers') where value->>'model_config_id'=target_model::text;
 if entry is null or result_code is null or result_code !~ '^[A-Z][A-Z0-9_]{1,100}$' or sent is null then raise exception 'INVALID_INPUT';end if;
 update public.jobs set checkpoint=jsonb_set(checkpoint,'{model_routing,checks}',
  coalesce(checkpoint->'model_routing'->'checks','[]')||jsonb_build_array(jsonb_build_object('provider',entry->>'provider','model',entry->>'model','model_config_id',target_model,'code',result_code,'sent',sent))),
  revision=revision+1,updated_at=now() where id=j.id;
end $$;

create function public.task_model_retry_windows(job_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs;result jsonb;
begin
 j:=app_private.model_job(job_id,lease);
 -- Unknown 429 scope is conservatively account-wide. Sibling models cannot
 -- evade account limits; accepted requests still take the polling path.
 with latest as (
  select distinct on (connection_id,model_config_id) * from public.model_attempts
  where workspace_id=j.workspace_id and connection_id is not null and started_at>now()-interval '1 day' and status in ('succeeded','failed')
  order by connection_id,model_config_id,id desc
 ), waits as (
  select connection_id,model_config_id,provider,project_ref,http_status,
   greatest(retry_after,started_at+interval '1 minute' * least(60,power(2,least(6,greatest(0,(select count(*)-1 from public.model_attempts failures where failures.workspace_id=j.workspace_id and failures.connection_id=latest.connection_id and failures.model_config_id=latest.model_config_id and failures.status='failed' and failures.http_status=latest.http_status and failures.started_at>coalesce((select max(success.started_at) from public.model_attempts success where success.workspace_id=j.workspace_id and success.connection_id=latest.connection_id and success.model_config_id=latest.model_config_id and success.status='succeeded'),now()-interval '1 day'))))))) as until_at
  from latest where http_status=429 or http_status>=500 or result_code='MODEL_NETWORK_UNCERTAIN'
 )
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
  select m.id as model_config_id,c.id as connection_id,max(w.until_at) as retry_after
   from public.model_configurations m join public.model_connections c on c.id=m.connection_id
   join waits w on (w.connection_id=c.id or (w.http_status=429 and w.provider=c.provider and w.project_ref=c.project_ref))
     and (w.http_status=429 or w.model_config_id=m.id)
   where m.workspace_id=j.workspace_id and w.until_at>now() group by m.id,c.id
 ) x;
 return result;
end $$;

revoke all on function app_private.model_job(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.prepare_task_model_route(uuid,uuid,text,jsonb,text),public.task_model_preflight(uuid,uuid,jsonb),
 public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid),
 public.resume_task_model_request(uuid,uuid,text,jsonb,uuid,uuid),public.start_task_model_attempt(uuid,uuid,uuid,uuid,text),
 public.save_task_model_round(uuid,uuid,jsonb,boolean),public.record_task_model_attempt(uuid,uuid,uuid,text,boolean),
 public.task_model_retry_windows(uuid,uuid) from public,anon,authenticated;
grant execute on function public.prepare_task_model_route(uuid,uuid,text,jsonb,text),public.task_model_preflight(uuid,uuid,jsonb),
 public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid),
 public.resume_task_model_request(uuid,uuid,text,jsonb,uuid,uuid),public.start_task_model_attempt(uuid,uuid,uuid,uuid,text),
 public.save_task_model_round(uuid,uuid,jsonb,boolean),public.record_task_model_attempt(uuid,uuid,uuid,text,boolean),
 public.task_model_retry_windows(uuid,uuid) to service_role;

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
 a.connection_id,a.model_config_id,a.execution_metadata
from public.model_attempts a join public.jobs j on j.id=a.job_id and j.workspace_id=a.workspace_id
left join public.provider_usage u on u.workspace_id=a.workspace_id and (u.id=a.usage_id or (a.usage_id is null and u.job_id=a.job_id and u.lease_token=a.lease_token and u.provider=a.provider and u.model=a.model and u.connection_id is not distinct from a.connection_id and u.model_config_id is not distinct from a.model_config_id))
left join public.generation_steps s on s.job_id=j.id and s.workspace_id=a.workspace_id
left join public.generation_plans p on p.id=coalesce(s.plan_id,case when j.type<>'model_probe' then j.entity_id end) and p.workspace_id=a.workspace_id
left join public.opportunities o on o.id=p.opportunity_id and o.workspace_id=a.workspace_id;
grant select on public.model_activity to authenticated,service_role;

create function public.record_model_request_metadata(attempt_id bigint,lease uuid,metadata jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare a public.model_attempts;j public.jobs;
begin
 select * into a from public.model_attempts where id=attempt_id;
 j:=app_private.model_job(a.job_id,lease);
 if a.lease_token is distinct from lease then raise exception 'STALE_LEASE';end if;
 perform app_private.check_keys(metadata,array['contract_version','schema_version','prompt_version','input_hash','route_revision','profile','capabilities']);
 if pg_column_size(metadata)>8192 or metadata->>'contract_version' is distinct from '1' or coalesce(metadata->>'input_hash','') !~ '^[0-9a-f]{64}$'
  or coalesce(metadata->>'schema_version','') !~ '^[0-9]{1,5}$' or coalesce(metadata->>'prompt_version','') !~ '^[a-zA-Z0-9._-]{1,100}$'
  then raise exception 'INVALID_INPUT';end if;
 perform app_private.validate_model_profile(metadata->'profile');
 perform app_private.validate_model_capabilities(metadata->'capabilities');
 update public.model_attempts set execution_metadata=metadata||jsonb_build_object('graph_thread',j.checkpoint->>'graph_thread',
  'operation',a.operation,'executor_version',j.checkpoint->'model_executor',
  'same_model_verification',case when a.operation='verify_grounding' then exists(select 1 from public.model_attempts writer
    where writer.job_id=j.id and writer.operation not in ('verify_grounding','connection_probe') and writer.status='succeeded'
    and writer.model_config_id=a.model_config_id) else null end) where id=a.id;
end $$;
revoke all on function public.record_model_request_metadata(bigint,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_model_request_metadata(bigint,uuid,jsonb) to service_role;

do $$ declare definition text;old_guard text;begin
 select pg_get_functiondef('public.finish_model_attempt(bigint,uuid,text,boolean,uuid,jsonb)'::regprocedure) into definition;
 old_guard:='u.job_id=a.job_id and u.provider=a.provider';
 if position(old_guard in definition)=0 then raise exception 'Unexpected attempt identity guard';end if;
 execute replace(definition,old_guard,old_guard||' and u.model=a.model and u.connection_id is not distinct from a.connection_id and u.model_config_id is not distinct from a.model_config_id');
end $$;


-- Reconciliation must use the same connection and actual model as the original
-- request, even after the configured default model has changed.
do $$ declare definition text;begin
 select pg_get_functiondef('public.claim_abandoned_model_request()'::regprocedure) into definition;
 definition:=replace(definition,'''remote_request_id'',u.remote_request_id)',
  '''remote_request_id'',u.remote_request_id,''connection_id'',u.connection_id,''model_config_id'',u.model_config_id,''credential_alias'',(select credential_alias from public.model_connections where id=u.connection_id))');
 execute definition;
end $$;
