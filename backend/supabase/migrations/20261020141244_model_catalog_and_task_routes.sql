-- Additive catalog. Existing workers and existing runs continue on executor 1.
create table public.model_connections (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 provider text not null check(provider in ('gemini_free','qwen_free','groq_free','mistral_free','cloudflare_free','zai_free','openai','anthropic')),
 label text not null check(length(trim(label)) between 1 and 120),
 credential_alias text not null check(credential_alias ~ '^APP_MODEL_[A-Z0-9_]{1,80}_KEY$'),
 project_ref text not null check(length(project_ref) between 1 and 120),
 enabled boolean not null default true,
 legacy_imported boolean not null default false,
 created_by uuid not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 revision integer not null default 1,
 unique(workspace_id,id), unique(workspace_id,provider,credential_alias,project_ref)
);
create table public.model_configurations (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 connection_id uuid not null,
 label text not null check(length(trim(label)) between 1 and 120),
 model text not null check(model ~ '^[a-zA-Z0-9._@/-]{1,120}$'),
 enabled boolean not null default true,
 capabilities jsonb not null check(jsonb_typeof(capabilities)='object' and pg_column_size(capabilities)<=4096),
 created_by uuid not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 revision integer not null default 1,
 foreign key(workspace_id,connection_id) references public.model_connections(workspace_id,id),
 unique(workspace_id,id),unique(connection_id,model)
);
create index model_configurations_workspace_connection_idx on public.model_configurations(workspace_id,connection_id);
create table public.model_task_routes (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 task text not null check(task in ('default','inspect_source_page','connection_probe','classify_opportunity','summarize_review','analyze_chunk','plan_proposal','draft_section','plan_commercial','review_proposal','verify_grounding','repair_result')),
 model_ids uuid[] not null default '{}' check(cardinality(model_ids)<=32 and array_position(model_ids,null) is null),
 inherit_default boolean not null default true,
 strategy text not null default 'priority' check(strategy in ('priority','round_robin')),
 profile jsonb check(profile is null or (jsonb_typeof(profile)='object' and pg_column_size(profile)<=2048)),
 next_position integer not null default 0 check(next_position>=0),
 created_by uuid not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 revision integer not null default 1, unique(workspace_id,task)
);
create table public.model_execution_settings (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null unique references public.workspaces(id),
 enabled boolean not null default false,
 admitted_after timestamptz,
 created_by uuid not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 revision integer not null default 1
);
-- No browser writes or anonymous grants. Audited Owner commands own mutations.
do $$ declare name text;begin
 foreach name in array array['model_connections','model_configurations','model_task_routes','model_execution_settings'] loop
  execute format('alter table public.%I enable row level security',name);
  execute format('create policy member_read on public.%I for select to authenticated using (app_private.member_role(workspace_id) is not null)',name);
  execute format('revoke all on public.%I from anon,authenticated',name);
  execute format('grant select on public.%I to authenticated',name);
  execute format('grant select,insert,update,delete on public.%I to service_role',name);
 end loop;
end $$;

create function app_private.validate_model_capabilities(value jsonb) returns void
language plpgsql set search_path='' as $$
begin
 perform app_private.check_keys(value,array['revision','output','background','streaming','reasoning','reasoning_values','max_output_tokens']);
 if jsonb_typeof(value) is distinct from 'object' or (value->>'revision')::int is null or (value->>'revision')::int<1
  or coalesce(value->>'output','') not in ('native_strict','schema','validated_json')
  or coalesce(value->>'background','') not in ('true','false') or coalesce(value->>'streaming','') not in ('true','false')
  or coalesce(value->>'reasoning','') not in ('none','effort','gemini_level','qwen_toggle')
  or jsonb_typeof(value->'reasoning_values') is distinct from 'array' then raise exception 'INVALID_INPUT';end if;
 if jsonb_array_length(value->'reasoning_values')>5 or exists(select 1 from jsonb_array_elements_text(value->'reasoning_values') x where x not in ('none','minimal','low','medium','high'))
  or (value->>'max_output_tokens' is not null and (value->>'max_output_tokens')::int not between 1024 and 131072) then raise exception 'INVALID_INPUT';end if;
end $$;
create function app_private.validate_model_profile(value jsonb) returns void
language plpgsql set search_path='' as $$
begin
 if value is null or value='null'::jsonb then return;end if;
 perform app_private.check_keys(value,array['revision','max_output_tokens','reasoning','require_native_strict']);
 if (value->>'revision')::int is null or (value->>'revision')::int<1
  or coalesce((value->>'max_output_tokens')::int,0) not between 1024 and 131072
  or coalesce(value->>'reasoning','') not in ('none','minimal','low','medium','high')
  or coalesce(value->>'require_native_strict','') not in ('true','false') then raise exception 'INVALID_INPUT';end if;
end $$;

alter function public.app_command(text,jsonb,text) rename to app_command_before_model_catalog;
revoke all on function public.app_command_before_model_catalog(text,jsonb,text) from public,anon,authenticated,service_role;
create function public.app_command(operation text,input jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid:=auth.uid();result jsonb;body_hash text;replay app_private.idempotency_records;
 target uuid; current_revision integer; connection public.model_connections; ids uuid[];
begin
 if operation not in ('model.connection.save','model.configuration.save','model.task_route.save','model.execution.configure') then
  return public.app_command_before_model_catalog(operation,input,idempotency_key);
 end if;
 select workspace_id into w from public.memberships where user_id=actor and app_private.member_role(workspace_id) is not null limit 1;
 if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;
 if app_private.member_role(w) is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 if exists(select 1 from public.restore_sessions where workspace_id=w and state in ('staging','committing')) then raise exception 'RESTORE_IN_PROGRESS';end if;
 if input is null or jsonb_typeof(input)<>'object' or pg_column_size(input)>16384 or length(idempotency_key) not between 1 and 200 or idempotency_key is null then raise exception 'INVALID_INPUT';end if;
 body_hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then
  if replay.body_hash<>body_hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;
 end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if coalesce((input->>'expected_revision')::int,-1)<0 then raise exception 'INVALID_INPUT';end if;
 target:=(input->>'id')::uuid;
 case operation
 when 'model.connection.save' then
  perform app_private.check_keys(input,array['id','expected_revision','provider','label','credential_alias','project_ref','enabled']);
  select * into connection from public.model_connections where workspace_id=w and id=target;
  if target is not null and connection.id is null then raise exception 'NOT_FOUND';end if;
  if coalesce(connection.revision,0)<>(input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  -- Account/credential bindings are immutable; a distinct account uses a new connection.
  if connection.id is not null and (connection.provider<>input->>'provider' or connection.credential_alias<>input->>'credential_alias' or connection.project_ref<>input->>'project_ref') then raise exception 'MODEL_IDENTITY_CHANGED';end if;
  insert into public.model_connections(id,workspace_id,provider,label,credential_alias,project_ref,enabled,created_by)
  values(coalesce(target,gen_random_uuid()),w,input->>'provider',input->>'label',input->>'credential_alias',input->>'project_ref',(input->>'enabled')::boolean,actor)
  on conflict(id) do update set label=excluded.label,enabled=excluded.enabled,revision=model_connections.revision+1,updated_at=now()
  returning to_jsonb(model_connections.*) into result;
 when 'model.configuration.save' then
  perform app_private.check_keys(input,array['id','expected_revision','connection_id','label','model','enabled','capabilities']);
  perform app_private.validate_model_capabilities(input->'capabilities');
  select * into connection from public.model_connections where workspace_id=w and id=(input->>'connection_id')::uuid;
  if connection.id is null then raise exception 'NOT_FOUND';end if;
  if input->'capabilities'->>'background'='true' and connection.provider not in ('openai','gemini_free') then raise exception 'MODEL_CAPABILITY_UNSUPPORTED';end if;
  if input->'capabilities'->>'reasoning'='gemini_level' and connection.provider<>'gemini_free'
   or input->'capabilities'->>'reasoning'='qwen_toggle' and connection.provider<>'qwen_free'
   or input->'capabilities'->>'reasoning'='effort' and connection.provider in ('gemini_free','anthropic','cloudflare_free')
   then raise exception 'MODEL_CAPABILITY_UNSUPPORTED';end if;
  select revision into current_revision from public.model_configurations where workspace_id=w and id=target;
  if target is not null and current_revision is null then raise exception 'NOT_FOUND';end if;
  if coalesce(current_revision,0)<>(input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  insert into public.model_configurations(id,workspace_id,connection_id,label,model,enabled,capabilities,created_by)
  values(coalesce(target,gen_random_uuid()),w,connection.id,input->>'label',input->>'model',(input->>'enabled')::boolean,input->'capabilities',actor)
  on conflict(id) do update set connection_id=excluded.connection_id,label=excluded.label,model=excluded.model,enabled=excluded.enabled,
   capabilities=excluded.capabilities,revision=model_configurations.revision+1,updated_at=now()
  returning to_jsonb(model_configurations.*) into result;
  update public.model_connections set legacy_imported=true where id=connection.id;
 when 'model.task_route.save' then
  perform app_private.check_keys(input,array['expected_revision','task','model_ids','inherit_default','strategy','profile']);
  perform app_private.validate_model_profile(input->'profile');
  if jsonb_typeof(input->'model_ids') is distinct from 'array' then raise exception 'INVALID_INPUT';end if;
  ids:=array(select jsonb_array_elements_text(input->'model_ids')::uuid);
  if cardinality(ids)>32 or cardinality(ids)<>(select count(distinct id) from unnest(ids) id)
   or exists(select 1 from unnest(ids) x where not exists(select 1 from public.model_configurations where workspace_id=w and id=x)) then raise exception 'INVALID_INPUT';end if;
  if input->>'task'='default' and (cardinality(ids)=0 or input->>'inherit_default'='true') then raise exception 'INVALID_INPUT';end if;
  select revision into current_revision from public.model_task_routes where workspace_id=w and task=input->>'task';
  if coalesce(current_revision,0)<>(input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  insert into public.model_task_routes(workspace_id,task,model_ids,inherit_default,strategy,profile,created_by)
  values(w,input->>'task',ids,(input->>'inherit_default')::boolean,input->>'strategy',nullif(input->'profile','null'::jsonb),actor)
  on conflict(workspace_id,task) do update set model_ids=excluded.model_ids,inherit_default=excluded.inherit_default,strategy=excluded.strategy,profile=excluded.profile,next_position=0,revision=model_task_routes.revision+1,updated_at=now()
  returning to_jsonb(model_task_routes.*) into result;
 when 'model.execution.configure' then
  perform app_private.check_keys(input,array['expected_revision','enabled']);
  if coalesce(input->>'enabled','') not in ('true','false') then raise exception 'INVALID_INPUT';end if;
  select revision into current_revision from public.model_execution_settings where workspace_id=w;
  if coalesce(current_revision,0)<>(input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  if input->>'enabled'='true' and not exists(select 1 from public.model_task_routes where workspace_id=w and task='default' and cardinality(model_ids)>0) then raise exception 'MODEL_NOT_CONFIGURED';end if;
  insert into public.model_execution_settings(workspace_id,enabled,admitted_after,created_by)
  values(w,(input->>'enabled')::boolean,case when input->>'enabled'='true' then now() end,actor)
  on conflict(workspace_id) do update set enabled=excluded.enabled,
   admitted_after=case when excluded.enabled and not model_execution_settings.enabled then now() else model_execution_settings.admitted_after end,
   revision=model_execution_settings.revision+1,updated_at=now()
  returning to_jsonb(model_execution_settings.*) into result;
 end case;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,request_id)
 values(w,actor,operation,(result->>'id')::uuid,gen_random_uuid());
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result)
 values(w,actor,'COMMAND',operation,idempotency_key,body_hash,result);
 return result;
end $$;
revoke all on function public.app_command(text,jsonb,text) from public,anon;
grant execute on function public.app_command(text,jsonb,text) to authenticated;
revoke all on function app_private.validate_model_capabilities(jsonb),app_private.validate_model_profile(jsonb) from public,anon,authenticated,service_role;

-- Once-only import. Server sends only public model metadata, never credentials.
create function public.import_model_catalog(job_id uuid,lease uuid,server_models jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare j public.jobs;s jsonb;c public.model_connections;m uuid;alias text;ids uuid[];route public.model_routing;
begin
 select * into j from public.jobs where id=job_id;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 if jsonb_typeof(server_models) is distinct from 'array' or jsonb_array_length(server_models)>8 or pg_column_size(server_models)>16384 then raise exception 'INVALID_INPUT';end if;
 for s in select value from jsonb_array_elements(server_models) loop
  perform app_private.check_keys(s,array['provider','model','project_ref','key_configured','capabilities']);
  if coalesce(s->>'model','')='' or coalesce(s->>'project_ref','')='' then continue;end if;
  perform app_private.validate_model_capabilities(s->'capabilities');
  alias:='APP_MODEL_'||case s->>'provider' when 'gemini_free' then 'GEMINI' when 'qwen_free' then 'QWEN' when 'groq_free' then 'GROQ' when 'mistral_free' then 'MISTRAL' when 'zai_free' then 'ZAI' when 'cloudflare_free' then 'CLOUDFLARE' when 'openai' then 'OPENAI' when 'anthropic' then 'CLAUDE' else '' end||'_KEY';
  insert into public.model_connections(workspace_id,provider,label,credential_alias,project_ref,created_by)
   values(j.workspace_id,s->>'provider',s->>'provider',alias,s->>'project_ref',j.created_by)
   on conflict(workspace_id,provider,credential_alias,project_ref) do nothing;
  select * into c from public.model_connections where workspace_id=j.workspace_id and provider=s->>'provider' and credential_alias=alias and project_ref=s->>'project_ref';
  if not c.legacy_imported then
   insert into public.model_configurations(workspace_id,connection_id,label,model,capabilities,created_by)
   values(j.workspace_id,c.id,s->>'model',s->>'model',s->'capabilities',j.created_by) on conflict(connection_id,model) do nothing;
   update public.model_connections set legacy_imported=true where id=c.id;
  end if;
 end loop;
 if not exists(select 1 from public.model_task_routes where workspace_id=j.workspace_id and task='default') then
  select * into route from public.model_routing where workspace_id=j.workspace_id;
  select array_agg(cfg.id order by array_position(route.provider_order,conn.provider),conn.created_at,cfg.id) into ids
   from public.model_configurations cfg join public.model_connections conn on conn.id=cfg.connection_id where cfg.workspace_id=j.workspace_id;
  if cardinality(ids)>0 then
   insert into public.model_task_routes(workspace_id,task,model_ids,inherit_default,strategy,created_by)
    values(j.workspace_id,'default',ids,false,coalesce(route.strategy,'priority'),j.created_by);
  end if;
 end if;
end $$;
revoke all on function public.import_model_catalog(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.import_model_catalog(uuid,uuid,jsonb) to service_role;
