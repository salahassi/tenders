-- Owner-authorized automatic routing; provider enable toggles remain separate.
create table public.model_routing (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null unique references public.workspaces(id),
 enabled boolean not null default false,
 next_position integer not null default 0 check(next_position between 0 and 3),
 revision integer not null default 1,
 updated_at timestamptz not null default now(),
 created_by uuid not null references auth.users(id)
);
alter table public.model_routing enable row level security;
revoke all on public.model_routing from public,anon,authenticated;
grant select on public.model_routing to authenticated;
grant all on public.model_routing to service_role;
create policy owner_read on public.model_routing for select to authenticated using(app_private.member_role(workspace_id)='Owner');

-- No API keys enter this RPC or the database. Only service-derived configuration metadata.
create function public.prepare_model_routing(job_id uuid,lease uuid,server_models jsonb) returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs; route public.model_routing; slot jsonb; profile public.model_settings; entries jsonb:='[]'; checks jsonb:='[]'; ids text[]:=array['gemini_free','qwen_free','mistral_free','groq_free']; provider_id text; pos int; start_pos int; reason text; config jsonb;
begin
 select * into j from public.jobs where id=job_id;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 select * into route from public.model_routing where workspace_id=j.workspace_id;
 if not coalesce(route.enabled,false) then return;end if;
 if j.checkpoint->'model_routing'->>'lease' = lease::text then return;end if;
 if server_models is null or jsonb_typeof(server_models)<>'array' or jsonb_array_length(server_models)<>4 or pg_column_size(server_models)>8192 then raise exception 'INVALID_INPUT';end if;
 if (select count(distinct s->>'provider') from jsonb_array_elements(server_models) s where s->>'provider'=any(ids))<>4 then raise exception 'INVALID_INPUT';end if;
 start_pos:=coalesce((j.checkpoint->'model_routing'->>'next_start')::int,route.next_position);
 if start_pos not between 0 and 3 then raise exception 'INVALID_INPUT';end if;
 update public.model_routing set next_position=(start_pos+1)%4 where workspace_id=j.workspace_id;
 for pos in 0..3 loop
  provider_id:=ids[((start_pos+pos)%4)+1];
  select value into slot from jsonb_array_elements(server_models) where value->>'provider'=provider_id;
  perform app_private.check_keys(slot,array['provider','model','project_ref','key_configured','free_tier_confirmed']);
  select * into profile from public.model_settings where workspace_id=j.workspace_id and provider=provider_id;
  reason:=null;
  if slot->>'key_configured' is distinct from 'true' or coalesce(slot->>'model','') !~ '^[a-zA-Z0-9._@/-]{1,120}$' or length(coalesce(slot->>'project_ref','')) not between 1 and 120 then reason:='MODEL_NOT_CONFIGURED';
  elsif not (coalesce((slot->>'free_tier_confirmed')::boolean,false) or (coalesce(profile.billing_verified,false) and profile.free_only and (provider_id<>'qwen_free' or profile.free_quota_only))) then reason:='FREE_ONLY_REQUIRED';
  elsif profile.id is not null and (profile.model<>slot->>'model' or profile.project_ref<>slot->>'project_ref') then reason:='MODEL_IDENTITY_CHANGED';
  elsif exists(select 1 from public.provider_usage u where u.workspace_id=j.workspace_id and u.provider=provider_id and (u.actual_input>u.reserved_input or u.actual_output>u.reserved_output) and u.created_at>=coalesce(profile.verified_at,route.updated_at)) then reason:='MODEL_BUDGET_EXCEEDED';
  end if;
  if reason is not null then checks:=checks||jsonb_build_array(jsonb_build_object('provider',provider_id,'code',reason,'sent',false));continue;end if;
  config:=jsonb_build_object('enabled',true,'automatic',true,'provider',provider_id,'model',slot->>'model','project_ref',slot->>'project_ref','free_only',true,'billing_verified',coalesce(profile.billing_verified,false),'free_quota_only',provider_id='qwen_free','verified_at',coalesce(profile.verified_at,route.updated_at),'quota_mode','provider_managed','quota_ends_at',null,'quota_remaining_tokens',null,'revision',coalesce(profile.revision,route.revision),'calls_per_day',coalesce(profile.calls_per_day,50),'input_per_day',coalesce(profile.input_per_day,250000),'output_per_day',coalesce(profile.output_per_day,50000));
  entries:=entries||jsonb_build_array(config);
 end loop;
 update public.jobs set checkpoint=checkpoint||jsonb_build_object('model_routing',jsonb_build_object('lease',lease,'mode','round_robin','next_start',(start_pos+1)%4,'providers',entries,'checks',checks)),revision=revision+1,updated_at=now() where id=j.id;
end $$;
revoke all on function public.prepare_model_routing(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_model_routing(uuid,uuid,jsonb) to service_role;

create function public.record_model_attempt(job_id uuid,lease uuid,provider_id text,result_code text,sent boolean) returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;
begin
 select * into j from public.jobs where id=job_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 if provider_id not in ('gemini_free','qwen_free','mistral_free','groq_free') or result_code is null or result_code !~ '^[A-Z][A-Z0-9_]{1,100}$' or sent is null then raise exception 'INVALID_INPUT';end if;
 if j.checkpoint->'model_routing'->>'mode' is distinct from 'round_robin' then return;end if;
 if jsonb_array_length(j.checkpoint->'model_routing'->'checks')>=12 then raise exception 'MODEL_ROUND_EXHAUSTED';end if;
 update public.jobs set checkpoint=jsonb_set(checkpoint,'{model_routing,checks}',checkpoint->'model_routing'->'checks'||jsonb_build_array(jsonb_build_object('provider',provider_id,'code',result_code,'sent',sent))),revision=revision+1,updated_at=now() where id=j.id;
end $$;
revoke all on function public.record_model_attempt(uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.record_model_attempt(uuid,uuid,text,text,boolean) to service_role;

create or replace function app_private.manual_model_preflight(job_id uuid, lease uuid, manifest jsonb)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare pool jsonb; identity jsonb; filtered jsonb := '[]'::jsonb; entry jsonb;
begin
 pool:=public.model_preflight_core(job_id, lease, manifest);
 select p.model_identity into identity
 from public.generation_plans p
 join public.generation_steps s on s.plan_id=p.id
 where s.job_id=manual_model_preflight.job_id;
 if identity is null or not exists (
  select 1 from public.provider_usage u
  join public.generation_steps s on s.job_id=u.job_id
  join public.generation_steps current_step on current_step.plan_id=s.plan_id
  where current_step.job_id=manual_model_preflight.job_id
    and not (u.state='settled' and coalesce(u.error_code,'') in
      ('PROVIDER_QUOTA_WAIT','PROVIDER_REQUEST_REJECTED','PROVIDER_AUTH_FAILED','PROVIDER_MODEL_NOT_FOUND','PROVIDER_REQUEST_INVALID'))
 ) then return pool; end if;
 for entry in select * from jsonb_array_elements(pool->'providers')
 loop
  if identity=jsonb_build_object(
    'provider', entry->>'provider',
    'model', entry->>'model',
    'project_ref', entry->>'project_ref'
  ) then
   filtered := filtered || jsonb_build_array(entry);
  end if;
 end loop;
 if jsonb_array_length(filtered)=0 then raise exception 'MODEL_IDENTITY_CHANGED'; end if;
 return jsonb_build_object('providers', filtered);
end $$;


revoke all on function app_private.manual_model_preflight(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create or replace function public.model_preflight(job_id uuid,lease uuid,manifest jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; entry jsonb; providers jsonb:='[]'; pending text;
begin
 select * into j from public.jobs where id=job_id;
 if not exists(select 1 from public.model_routing where workspace_id=j.workspace_id and enabled) then return app_private.manual_model_preflight(job_id,lease,manifest);end if;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 if j.checkpoint->'model_routing'->>'lease' is distinct from lease::text then raise exception 'MODEL_ROUTING_NOT_PREPARED';end if;
 if j.type='model_probe' and manifest is distinct from '[]'::jsonb then raise exception 'INVALID_INPUT';end if;
 select u.provider into pending from public.provider_usage u where u.job_id=j.id and u.remote_request_id is not null and u.state='reserved' order by u.created_at desc limit 1;
 for entry in select value from jsonb_array_elements(j.checkpoint->'model_routing'->'providers') order by case when value->>'provider'=pending then 0 else 1 end loop
  if j.type<>'model_probe' then
   begin perform app_private.check_model_payload(j.workspace_id,entry->>'provider',manifest);
   exception when raise_exception then
    if sqlerrm='DATA_AUTHORIZATION_REQUIRED' then continue;else raise;end if;
   end;
  end if;
  providers:=providers||jsonb_build_array(entry);
 end loop;
 if j.type<>'model_probe' and jsonb_array_length(providers)=0 and jsonb_array_length(j.checkpoint->'model_routing'->'providers')>0 then raise exception 'DATA_AUTHORIZATION_REQUIRED';end if;
 return jsonb_build_object('providers',providers,'routing_mode','round_robin');
end $$;
revoke all on function public.model_preflight(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.model_preflight(uuid,uuid,jsonb) to service_role;

create or replace function public.reserve_model_call(
 job_id uuid,
 lease uuid,
 call_key text,
 input_hash text,
 input_tokens integer,
 output_tokens integer,
 manifest jsonb,
 target_provider text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; m public.model_settings; w uuid; u public.provider_usage;
 day date:=(now() at time zone 'Asia/Riyadh')::date; calls integer; inputs bigint; outputs bigint; settings jsonb; pool jsonb; automatic boolean;
begin
 if target_provider is null or target_provider not in (
  'gemini_free','qwen_free','groq_free','mistral_free','cloudflare_free'
 ) then raise exception 'INVALID_INPUT'; end if;
 select workspace_id into w from public.jobs where id=job_id; perform 1 from public.workspaces where id=w for update;
 select * into j from public.jobs where id=job_id;
 pool:=public.model_preflight(job_id, lease, manifest);
 if not exists(select 1 from jsonb_array_elements(pool->'providers') p where p->>'provider'=target_provider) then
  raise exception 'MODEL_IDENTITY_CHANGED';
 end if;
 automatic:=pool->>'routing_mode'='round_robin';
 if coalesce(automatic,false) then
  select * into m from jsonb_populate_record(null::public.model_settings,(select p from jsonb_array_elements(pool->'providers') p where p->>'provider'=target_provider));
 else
  select * into m from public.model_settings where workspace_id=w and provider=target_provider and enabled;
 end if;
 if m.provider is null then raise exception 'MODEL_NOT_CONFIGURED';end if;
 if input_tokens not between 1 and 20000 or output_tokens not between 1 and 8192 then raise exception 'MODEL_CONTEXT_TOO_LARGE'; end if;
 if length(call_key) not between 1 and 200 or input_hash!~'^[0-9a-f]{64}$' then raise exception 'INVALID_INPUT'; end if;
 if exists(select 1 from public.provider_usage p where p.workspace_id=w and p.job_id=reserve_model_call.job_id and p.call_key=reserve_model_call.call_key) then
  raise exception 'MODEL_CALL_ALREADY_RESERVED';
 end if;
 -- Automatic routing retains unknown usage, but a different provider may take over.
 if exists(select 1 from public.provider_usage p where p.workspace_id=w and (
  p.state='reserved' or (p.state='unknown' and case when coalesce(automatic,false) then
   p.provider=target_provider and (p.job_id=j.id or p.input_hash=reserve_model_call.input_hash)
  else m.quota_mode<>'provider_managed' or m.provider<>'gemini_free' or p.provider<>m.provider or p.model<>m.model or p.job_id=j.id or p.input_hash=reserve_model_call.input_hash end)
 )) then raise exception 'USAGE_REVIEW_REQUIRED';end if;
 if exists(select 1 from public.provider_usage p where p.workspace_id=w and p.created_at>now()-interval '1 minute'
  and not (p.job_id=j.id and p.provider<>target_provider and
   (coalesce(automatic,false) or (p.state='settled' and p.error_code='PROVIDER_QUOTA_WAIT')))) then raise exception 'MODEL_RATE_WAIT';end if;
 select count(*),coalesce(sum(coalesce(actual_input,reserved_input)),0),coalesce(sum(coalesce(actual_output,reserved_output)),0)
 into calls,inputs,outputs from public.provider_usage where workspace_id=w and application_day=day;
 select workspaces.settings into settings from public.workspaces where id=w;
 if calls>=least(m.calls_per_day,coalesce((settings->>'daily_call_limit')::int,50))
  or inputs+input_tokens>least(m.input_per_day,coalesce((settings->>'input_token_limit')::int,250000))
  or outputs+output_tokens>least(m.output_per_day,coalesce((settings->>'output_token_limit')::int,50000)) then
  raise exception 'MODEL_DAILY_QUOTA_WAIT';
 end if;
 if m.quota_mode='verified_budget' and (select coalesce(sum(coalesce(actual_input,reserved_input)+coalesce(actual_output,reserved_output)),0)
     from public.provider_usage where workspace_id=w and provider=m.provider and model=m.model and created_at>=m.verified_at)
    +input_tokens+output_tokens>m.quota_remaining_tokens then
  raise exception 'PROVIDER_QUOTA_WAIT';
 end if;
 insert into public.provider_usage(
  workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,created_by
 ) values (
  w,job_id,lease,call_key,m.provider,m.model,input_hash,day,m.revision,input_tokens,output_tokens,j.created_by
 ) returning * into u;
 return to_jsonb(u);
end $$;

create or replace function app_private.generation_call_cap() returns trigger language plpgsql security definer set search_path='' as $$
declare plan uuid; identity jsonb; existing jsonb; profile public.model_settings;
begin
 select s.plan_id into plan from public.generation_steps s where s.job_id=new.job_id;
 if plan is not null then
  if (select count(*) from public.provider_usage u join public.generation_steps s on s.job_id=u.job_id where s.plan_id=plan and not (u.state='settled' and coalesce(u.error_code,'')='PROVIDER_QUOTA_WAIT'))>=300 then
   raise exception 'PLAN_CALL_CAP_REACHED';
  end if;
  if exists(select 1 from public.model_routing where workspace_id=new.workspace_id and enabled) then
   return new;
  end if;
  select * into profile from public.model_settings where workspace_id=new.workspace_id and provider=new.provider;
  identity:=jsonb_build_object('provider',profile.provider,'model',profile.model,'project_ref',profile.project_ref);
  select model_identity into existing from public.generation_plans where id=plan;
  if existing is not null and existing<>identity and exists (
   select 1 from public.provider_usage u join public.generation_steps s on s.job_id=u.job_id
   where s.plan_id=plan and not (u.state='settled' and coalesce(u.error_code,'') in
    ('PROVIDER_QUOTA_WAIT','PROVIDER_REQUEST_REJECTED','PROVIDER_AUTH_FAILED','PROVIDER_MODEL_NOT_FOUND','PROVIDER_REQUEST_INVALID'))
  ) then raise exception 'MODEL_IDENTITY_CHANGED'; end if;
  update public.generation_plans set model_identity=identity where id=plan;
 end if;
 return new;
end $$;


create or replace function public.fail_generation(job_id uuid,lease uuid,error_code text,retry_after timestamptz default null,split_inputs jsonb default null) returns void language plpgsql security definer set search_path='' as $$
declare w uuid;j public.jobs;p public.generation_plans;s public.generation_steps;state text:='blocked';next_time timestamptz:='infinity';item jsonb;
begin
 select workspace_id into w from public.jobs where id=job_id;perform 1 from public.workspaces where id=w for update;select * into j from public.jobs where id=job_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() then raise exception 'STALE_LEASE';end if;
 select * into s from public.generation_steps where generation_steps.job_id=j.id;select * into p from public.generation_plans where id=s.plan_id;
 if j.cancel_requested or p.status='canceled' then state:='canceled';
 elsif split_inputs is not null and s.depth<8 and jsonb_array_length(split_inputs)=2 and error_code in ('MODEL_CONTEXT_TOO_LARGE','MODEL_OUTPUT_TRUNCATED') then
 if (select count(*) from public.generation_steps where plan_id=p.id)+2>300 then error_code:='PLAN_JOB_CAP_REACHED';else
 for item in select value from jsonb_array_elements(split_inputs) loop perform app_private.enqueue_generation(p,s.task,item,s.depth+1);end loop;
 update public.generation_steps set status='split',revision=revision+1,updated_at=now() where id=s.id;state:='succeeded';end if;
 elsif error_code in ('MODEL_OUTPUT_INVALID','EVIDENCE_REFERENCE_INVALID','MODEL_COVERAGE_INCOMPLETE','UNSUPPORTED_COMPANY_CLAIM') and s.repair_count=0 then
 update public.generation_steps set repair_count=1,revision=revision+1 where id=s.id;state:='retry_wait';next_time:=now()+interval '1 minute';
 elsif error_code in ('MODEL_RATE_WAIT','MODEL_DAILY_QUOTA_WAIT','PROVIDER_QUOTA_WAIT','MODEL_ROUND_EXHAUSTED') then
 state:='quota_wait';next_time:=case when error_code='MODEL_RATE_WAIT' then now()+interval '1 minute' when error_code='MODEL_DAILY_QUOTA_WAIT' then ((now() at time zone 'Asia/Riyadh')::date+1)::timestamp at time zone 'Asia/Riyadh' else
  case when retry_after is not null and isfinite(retry_after)
   then greatest(now()+interval '1 minute',least(retry_after,now()+interval '1 day'))
   else now()+make_interval(secs=>least(3600,60*power(2,least(greatest(j.attempts-1,0),6)))::int)
  end end;
 end if;
 update public.jobs set status=state,error_code=case when state='succeeded' then null else fail_generation.error_code end,next_attempt_at=next_time,lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
 update public.generation_plans set status=case when state='canceled' then 'canceled' when state='blocked' then 'blocked' else 'running' end,error_code=case when state='succeeded' then null else fail_generation.error_code end,revision=revision+1,updated_at=now() where id=p.id;
 if state='blocked' and p.id is not null then perform app_private.notify_members(w,'plan-blocked:'||p.id||':'||error_code,'Generation needs attention',error_code,p.opportunity_id,p.created_by);end if;
end $$;

create or replace function app_private.model_policy_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid:=auth.uid();r text;body_hash text;replay app_private.idempotency_records;result jsonb;settings public.model_settings;content jsonb;usage public.provider_usage;target uuid;rank smallint;routing_config public.model_routing;
begin
 if operation not in ('model.configure','model.probe','model.routing','content.authorize','content.revoke','usage.resolve') then return app_private.collection_command(operation,input,idempotency_key);end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;r:=app_private.member_role(w);if r is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(input)>1048576 then raise exception 'INVALID_INPUT';end if;
 body_hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then if replay.body_hash<>body_hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 target:=(input->>'id')::uuid;
 case operation
 when 'model.routing' then
  perform app_private.check_keys(input,array['enabled','expected_revision']);
  if coalesce(input->>'enabled','') not in ('true','false') or coalesce((input->>'expected_revision')::int,-1)<0 then raise exception 'INVALID_INPUT';end if;
  select * into routing_config from public.model_routing where workspace_id=w;
  if coalesce(routing_config.revision,0) is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  insert into public.model_routing(workspace_id,enabled,created_by) values(w,(input->>'enabled')::boolean,actor)
  on conflict(workspace_id) do update set enabled=excluded.enabled,revision=model_routing.revision+1,updated_at=now() returning to_jsonb(model_routing.*) into result;
 when 'model.configure' then
  perform app_private.check_keys(input,array['expected_revision','enabled','provider','model','project_ref','free_only','billing_verified','free_quota_only','quota_ends_at','quota_remaining_tokens','calls_per_day','input_per_day','output_per_day','failover_rank','quota_mode']);
  select * into settings from public.model_settings where workspace_id=w and provider=(input->>'provider') for update;
  if coalesce(settings.revision,0) is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  if coalesce(input->>'quota_mode','verified_budget')='verified_budget' and (input->>'quota_ends_at')::timestamptz<=now() and (input->>'enabled')::boolean then raise exception 'PROVIDER_QUOTA_EXPIRED';end if;
  rank:=coalesce((input->>'failover_rank')::smallint,case input->>'provider'
   when 'gemini_free' then 1 when 'qwen_free' then 2 when 'groq_free' then 3
   when 'mistral_free' then 4 when 'cloudflare_free' then 5 else 1 end);
  insert into public.model_settings(workspace_id,enabled,provider,model,project_ref,free_only,billing_verified,free_quota_only,verified_at,quota_ends_at,quota_remaining_tokens,calls_per_day,input_per_day,output_per_day,failover_rank,quota_mode,created_by)
  values(w,(input->>'enabled')::boolean,input->>'provider',input->>'model',input->>'project_ref',(input->>'free_only')::boolean,(input->>'billing_verified')::boolean,(input->>'free_quota_only')::boolean,now(),(input->>'quota_ends_at')::timestamptz,(input->>'quota_remaining_tokens')::bigint,(input->>'calls_per_day')::int,(input->>'input_per_day')::bigint,(input->>'output_per_day')::bigint,rank,coalesce(input->>'quota_mode','verified_budget'),actor)
  on conflict(workspace_id,provider) do update set enabled=excluded.enabled,model=excluded.model,project_ref=excluded.project_ref,free_only=excluded.free_only,billing_verified=excluded.billing_verified,free_quota_only=excluded.free_quota_only,verified_at=now(),quota_ends_at=excluded.quota_ends_at,quota_remaining_tokens=excluded.quota_remaining_tokens,calls_per_day=excluded.calls_per_day,input_per_day=excluded.input_per_day,output_per_day=excluded.output_per_day,failover_rank=excluded.failover_rank,quota_mode=excluded.quota_mode,revision=model_settings.revision+1,updated_at=now() returning to_jsonb(model_settings.*) into result;
 when 'model.probe' then
  perform app_private.check_keys(input,array[]::text[]);
  if not exists(select 1 from public.model_settings where workspace_id=w and provider='gemini_free' and enabled) and not exists(select 1 from public.model_routing where workspace_id=w and enabled) then raise exception 'MODEL_NOT_CONFIGURED'; end if;
  select to_jsonb(j) into result from public.jobs j where j.workspace_id=w and j.type='model_probe' and j.status in ('queued','running','retry_wait','quota_wait') order by j.created_at limit 1;
  if result is null then
   if (select count(*) from public.jobs where workspace_id=w and status in ('queued','running','retry_wait','quota_wait','blocked'))>=500 then raise exception 'JOB_CAP_REACHED'; end if;
   insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by)
    values(w,'model_probe',w,encode(sha256(convert_to('tenderdesk-connection-probe-v1','UTF8')),'hex'),'queued',actor)
    returning to_jsonb(jobs.*) into result;
  end if;
 when 'content.authorize' then
  perform app_private.check_keys(input,array['entity_kind','entity_id','content_hash','provider','attestation']);
  content:=app_private.content_record(w,input->>'entity_kind',(input->>'entity_id')::uuid);
  if content->>'content_hash'<>input->>'content_hash' then raise exception 'STALE_INPUT';end if;
  if content->>'content' ~* '(confidential|strictly private|سري للغاية|سرية|password[[:space:]]*[:=]|api[_ -]?key[[:space:]]*[:=]|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|-----BEGIN .*PRIVATE KEY)' then raise exception 'DATA_POLICY_BLOCKED';end if;
  insert into public.content_authorizations(workspace_id,entity_kind,entity_id,content_hash,provider,attestation,created_by) values(w,input->>'entity_kind',(input->>'entity_id')::uuid,input->>'content_hash',input->>'provider',input->>'attestation',actor)
  on conflict(workspace_id,entity_kind,entity_id,content_hash,provider) do update set revoked_at=null,created_by=actor,created_at=now(),revision=content_authorizations.revision+1 returning to_jsonb(content_authorizations.*) into result;
 when 'content.revoke' then
  perform app_private.check_keys(input,array['id','expected_revision']);
  update public.content_authorizations set revoked_at=now(),revision=revision+1 where workspace_id=w and id=target and revision=(input->>'expected_revision')::int returning to_jsonb(content_authorizations.*) into result;if result is null then raise exception 'REVISION_CONFLICT';end if;
 when 'usage.resolve' then
  perform app_private.check_keys(input,array['id','expected_revision','actual_input','actual_output','thinking_tokens','reason']);
  if length(trim(coalesce(input->>'reason','')))<10 then raise exception 'PROVIDER_USAGE_EVIDENCE_REQUIRED';end if;
  select * into usage from public.provider_usage where workspace_id=w and id=target for update;
  if usage.id is null or usage.revision is distinct from (input->>'expected_revision')::int or usage.state<>'unknown' then raise exception 'REVISION_CONFLICT';end if;
  if (input->>'actual_input')::bigint>usage.reserved_input or (input->>'actual_output')::bigint>usage.reserved_output then
   update public.model_settings set enabled=false,revision=revision+1,updated_at=now() where workspace_id=w and provider=usage.provider;
  end if;
  update public.provider_usage set actual_input=(input->>'actual_input')::bigint,actual_output=(input->>'actual_output')::bigint,thinking_tokens=(input->>'thinking_tokens')::bigint,state='settled',error_code='OWNER_USAGE_RECONCILIATION',revision=revision+1,updated_at=now() where id=target returning to_jsonb(provider_usage.*) into result;
 end case;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id) values(w,actor,operation,coalesce(target,(result->>'id')::uuid),coalesce(input->>'reason',''),gen_random_uuid());
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,body_hash,result);return result;
end $$;


create or replace function public.finish_backend_job(job_id uuid,lease uuid,result_status text,result_error text) returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;w uuid;
begin
 select workspace_id into w from public.jobs where id=job_id;perform 1 from public.workspaces where id=w for update;
 select * into j from public.jobs where id=job_id for update;
 if j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() then raise exception 'STALE_LEASE';end if;
 if result_status not in ('succeeded','retry_wait','quota_wait','blocked','failed','canceled') then raise exception 'INVALID_INPUT';end if;
 if result_status='succeeded' and not (
  (j.type='model_probe' and exists(select 1 from public.provider_usage u where u.job_id=j.id and u.lease_token=lease and u.state='settled' and u.error_code is null and u.actual_input is not null and u.actual_output is not null))
  or (j.type<>'model_probe' and exists(select 1 from public.source_runs where source_runs.job_id=j.id and status='succeeded'))
 ) then raise exception 'HANDLER_NOT_IMPLEMENTED';end if;
 if result_status='retry_wait' and j.attempts>=4 then result_status:='failed';end if;
 update public.jobs set status=case when cancel_requested then 'canceled' else result_status end,error_code=result_error,checkpoint=case when j.type='model_probe' and result_status='succeeded' and not j.cancel_requested then checkpoint||jsonb_build_object('result','ready','checked_at',now()) else checkpoint end,lease_token=null,lease_until=null,next_attempt_at=case when result_status='retry_wait' then now()+make_interval(secs=> (case j.attempts when 1 then 60 when 2 then 300 else 1800 end)*(0.8+random()*0.4)) when result_status='quota_wait' then 'infinity'::timestamptz else next_attempt_at end,revision=revision+1,updated_at=now() where id=job_id;
 if result_status in ('blocked','failed','quota_wait') and not j.cancel_requested then perform app_private.notify_members(w,'job:'||j.id||':'||result_status,'Processing needs attention',coalesce(result_error,'Unknown failure'),j.entity_id,j.created_by);end if;
end $$;

-- Recovery never reactivates external providers implicitly.
create function app_private.pause_restored_model_routing() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state='committed' and old.state is distinct from new.state then update public.model_routing set enabled=false,revision=revision+1,updated_at=now() where workspace_id=new.workspace_id;end if;
 return new;
end $$;
revoke all on function app_private.pause_restored_model_routing() from public,anon,authenticated,service_role;
create trigger pause_restored_model_routing after update of state on public.restore_sessions for each row execute function app_private.pause_restored_model_routing();
