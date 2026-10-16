-- Per-provider model policy with ordered failover (Gemini + Qwen both active).
alter table public.model_settings drop constraint if exists model_settings_workspace_id_key;
alter table public.model_settings
 add column if not exists failover_rank smallint not null default 1
 check (failover_rank between 1 and 10);
alter table public.model_settings
 add constraint model_settings_workspace_provider_key unique (workspace_id, provider);
update public.model_settings
 set failover_rank = case provider when 'gemini_free' then 1 when 'qwen_free' then 2 else 1 end
 where failover_rank is distinct from case provider when 'gemini_free' then 1 when 'qwen_free' then 2 else 1 end;

create or replace function public.model_preflight_core(job_id uuid, lease uuid, manifest jsonb)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; rec public.model_settings; providers jsonb := '[]'::jsonb;
begin
 select * into j from public.jobs where id=job_id;
 if j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then
  raise exception 'STALE_LEASE';
 end if;
 for rec in
  select * from public.model_settings m
  where m.workspace_id=j.workspace_id and m.enabled
  order by m.failover_rank, m.provider
 loop
  if not rec.free_only or not rec.billing_verified or (rec.provider='qwen_free' and not rec.free_quota_only) then
   raise exception 'FREE_ONLY_REQUIRED';
  end if;
  if rec.verified_at<now()-interval '30 days' or rec.quota_ends_at<=now() then
   raise exception 'PROVIDER_VERIFICATION_EXPIRED';
  end if;
  perform app_private.check_model_payload(j.workspace_id, rec.provider, manifest);
  providers := providers || jsonb_build_array(to_jsonb(rec));
 end loop;
 if jsonb_array_length(providers)=0 then raise exception 'MODEL_NOT_CONFIGURED'; end if;
 return jsonb_build_object('providers', providers);
end $$;

create or replace function public.model_preflight(job_id uuid, lease uuid, manifest jsonb)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare pool jsonb; identity jsonb; filtered jsonb := '[]'::jsonb; entry jsonb;
begin
 pool:=public.model_preflight_core(job_id, lease, manifest);
 select p.model_identity into identity
 from public.generation_plans p
 join public.generation_steps s on s.plan_id=p.id
 where s.job_id=model_preflight.job_id;
 if identity is null then return pool; end if;
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

drop function if exists public.reserve_model_call(uuid, uuid, text, text, integer, integer, jsonb);
create function public.reserve_model_call(
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
 day date:=(now() at time zone 'Asia/Riyadh')::date; calls integer; inputs bigint; outputs bigint; settings jsonb;
begin
 if target_provider is null or target_provider not in ('gemini_free','qwen_free') then raise exception 'INVALID_INPUT'; end if;
 select workspace_id into w from public.jobs where id=job_id; perform 1 from public.workspaces where id=w for update;
 select * into j from public.jobs where id=job_id;
 perform public.model_preflight(job_id, lease, manifest);
 select * into m from public.model_settings where workspace_id=w and provider=target_provider and enabled;
 if m.id is null then raise exception 'MODEL_NOT_CONFIGURED'; end if;
 if input_tokens not between 1 and 20000 or output_tokens not between 1 and 8192 then raise exception 'MODEL_CONTEXT_TOO_LARGE'; end if;
 if length(call_key) not between 1 and 200 or input_hash!~'^[0-9a-f]{64}$' then raise exception 'INVALID_INPUT'; end if;
 if exists(select 1 from public.provider_usage p where p.workspace_id=w and p.job_id=reserve_model_call.job_id and p.call_key=reserve_model_call.call_key) then
  raise exception 'MODEL_CALL_ALREADY_RESERVED';
 end if;
 if exists(select 1 from public.provider_usage where workspace_id=w and state in ('reserved','unknown')) then raise exception 'USAGE_REVIEW_REQUIRED'; end if;
 if exists(select 1 from public.provider_usage where workspace_id=w and created_at>now()-interval '1 minute') then raise exception 'MODEL_RATE_WAIT'; end if;
 select count(*),coalesce(sum(coalesce(actual_input,reserved_input)),0),coalesce(sum(coalesce(actual_output,reserved_output)),0)
 into calls,inputs,outputs from public.provider_usage where workspace_id=w and application_day=day;
 select workspaces.settings into settings from public.workspaces where id=w;
 if calls>=least(m.calls_per_day,coalesce((settings->>'daily_call_limit')::int,50))
  or inputs+input_tokens>least(m.input_per_day,coalesce((settings->>'input_token_limit')::int,250000))
  or outputs+output_tokens>least(m.output_per_day,coalesce((settings->>'output_token_limit')::int,50000)) then
  raise exception 'MODEL_DAILY_QUOTA_WAIT';
 end if;
 if (select coalesce(sum(coalesce(actual_input,reserved_input)+coalesce(actual_output,reserved_output)),0)
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

create or replace function public.settle_model_call(reservation uuid,actual_input bigint,actual_output bigint,thinking bigint,error_code text default null)
 returns void language plpgsql security definer set search_path='' as $$
declare u public.provider_usage;
begin
 perform 1 from public.workspaces where id=(select workspace_id from public.provider_usage where id=reservation) for update;
 select * into u from public.provider_usage where id=reservation for update;
 if u.id is null then raise exception 'NOT_FOUND'; end if;
 if u.state='settled' then
  if u.actual_input is distinct from actual_input or u.actual_output is distinct from actual_output or u.thinking_tokens is distinct from thinking then
   raise exception 'IDEMPOTENCY_CONFLICT';
  end if;
  return;
 end if;
 update public.provider_usage set
  actual_input=settle_model_call.actual_input,
  actual_output=settle_model_call.actual_output,
  thinking_tokens=thinking,
  state=case
   when settle_model_call.error_code in ('PROVIDER_QUOTA_WAIT','PROVIDER_REQUEST_REJECTED') then 'settled'
   when settle_model_call.actual_input is null or settle_model_call.actual_output is null then 'unknown'
   else 'settled'
  end,
  error_code=settle_model_call.error_code,
  revision=revision+1,
  updated_at=now()
 where id=reservation;
 if actual_input>u.reserved_input or actual_output>u.reserved_output then
  update public.model_settings set enabled=false,revision=revision+1,updated_at=now()
  where workspace_id=u.workspace_id and provider=u.provider;
 end if;
end $$;

create or replace function app_private.generation_call_cap() returns trigger language plpgsql security definer set search_path='' as $$
declare plan uuid; identity jsonb; existing jsonb; profile public.model_settings;
begin
 select s.plan_id into plan from public.generation_steps s where s.job_id=new.job_id;
 if plan is not null then
  if (select count(*) from public.provider_usage u join public.generation_steps s on s.job_id=u.job_id where s.plan_id=plan)>=300 then
   raise exception 'PLAN_CALL_CAP_REACHED';
  end if;
  select * into profile from public.model_settings where workspace_id=new.workspace_id and provider=new.provider;
  identity:=jsonb_build_object('provider',profile.provider,'model',profile.model,'project_ref',profile.project_ref);
  select model_identity into existing from public.generation_plans where id=plan;
  if existing is not null and existing<>identity then raise exception 'MODEL_IDENTITY_CHANGED'; end if;
  update public.generation_plans set model_identity=identity where id=plan and model_identity is null;
 end if;
 return new;
end $$;

create or replace function app_private.model_policy_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid:=auth.uid();r text;body_hash text;replay app_private.idempotency_records;result jsonb;settings public.model_settings;content jsonb;usage public.provider_usage;target uuid;rank smallint;
begin
 if operation not in ('model.configure','content.authorize','content.revoke','usage.resolve') then return app_private.collection_command(operation,input,idempotency_key);end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;r:=app_private.member_role(w);if r is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(input)>1048576 then raise exception 'INVALID_INPUT';end if;
 body_hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then if replay.body_hash<>body_hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 target:=(input->>'id')::uuid;
 case operation
 when 'model.configure' then
  perform app_private.check_keys(input,array['expected_revision','enabled','provider','model','project_ref','free_only','billing_verified','free_quota_only','quota_ends_at','quota_remaining_tokens','calls_per_day','input_per_day','output_per_day']);
  select * into settings from public.model_settings where workspace_id=w and provider=(input->>'provider') for update;
  if coalesce(settings.revision,0) is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  if (input->>'quota_ends_at')::timestamptz<=now() and (input->>'enabled')::boolean then raise exception 'PROVIDER_QUOTA_EXPIRED';end if;
  rank:=coalesce((input->>'failover_rank')::smallint,case input->>'provider' when 'gemini_free' then 1 when 'qwen_free' then 2 else 1 end);
  insert into public.model_settings(workspace_id,enabled,provider,model,project_ref,free_only,billing_verified,free_quota_only,verified_at,quota_ends_at,quota_remaining_tokens,calls_per_day,input_per_day,output_per_day,failover_rank,created_by)
  values(w,(input->>'enabled')::boolean,input->>'provider',input->>'model',input->>'project_ref',(input->>'free_only')::boolean,(input->>'billing_verified')::boolean,(input->>'free_quota_only')::boolean,now(),(input->>'quota_ends_at')::timestamptz,(input->>'quota_remaining_tokens')::bigint,(input->>'calls_per_day')::int,(input->>'input_per_day')::bigint,(input->>'output_per_day')::bigint,rank,actor)
  on conflict(workspace_id,provider) do update set enabled=excluded.enabled,model=excluded.model,project_ref=excluded.project_ref,free_only=excluded.free_only,billing_verified=excluded.billing_verified,free_quota_only=excluded.free_quota_only,verified_at=now(),quota_ends_at=excluded.quota_ends_at,quota_remaining_tokens=excluded.quota_remaining_tokens,calls_per_day=excluded.calls_per_day,input_per_day=excluded.input_per_day,output_per_day=excluded.output_per_day,failover_rank=excluded.failover_rank,revision=model_settings.revision+1,updated_at=now() returning to_jsonb(model_settings.*) into result;
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

revoke all on function public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text) from public,anon,authenticated;
grant execute on function public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text) to service_role;
