-- Cloudflare participates in the same automatic routing as every other provider.
-- Preserve the owner's strategy, cursor and relative order; append the added slot.
alter table public.model_routing drop constraint model_routing_next_position_check;
alter table public.model_routing add constraint model_routing_next_position_check check(next_position between 0 and 7);
alter table public.model_routing drop constraint model_routing_provider_order_check;
alter table public.model_routing alter column provider_order set default array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free']::text[];
update public.model_routing set provider_order=array_append(provider_order,'cloudflare_free'),revision=revision+1,updated_at=now();
alter table public.model_routing add constraint model_routing_provider_order_check check(array_length(provider_order,1)=8 and provider_order @> array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free']::text[] and provider_order <@ array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free']::text[] and array_position(provider_order,null) is null);
alter table public.model_routing drop constraint model_routing_free_providers_check;
alter table public.model_routing add constraint model_routing_free_providers_check check(free_providers <@ array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free']::text[] and array_position(free_providers,null) is null);


create or replace function public.prepare_model_routing_before_activity(job_id uuid,lease uuid,server_models jsonb) returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs; route public.model_routing; slot jsonb; profile public.model_settings; entries jsonb:='[]'; checks jsonb:='[]'; ids text[]:=array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free']; provider_id text; pos int; start_pos int; reason text; config jsonb; resuming boolean; provider_count int;
begin
 select * into j from public.jobs where id=job_id;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 select * into route from public.model_routing where workspace_id=j.workspace_id;
 if not coalesce(route.enabled,false) then return;end if;
 if j.checkpoint->'model_routing'->>'lease' = lease::text then return;end if;
 if server_models is null or jsonb_typeof(server_models)<>'array' or jsonb_array_length(server_models) not in (4,5,7,8) or pg_column_size(server_models)>8192 then raise exception 'INVALID_INPUT';end if;
 -- Accept previous workers without changing the saved eight-provider order.
 ids:=array(select item from unnest(route.provider_order) with ordinality as ordered(item,pos) where exists(select 1 from jsonb_array_elements(server_models) s where s->>'provider'=item) order by ordered.pos);
 provider_count:=coalesce(array_length(ids,1),0);
 if provider_count<>jsonb_array_length(server_models) then raise exception 'INVALID_INPUT';end if;
 if (select count(distinct s->>'provider') from jsonb_array_elements(server_models) s where s->>'provider'=any(ids))<>provider_count then raise exception 'INVALID_INPUT';end if;
 resuming:=exists(select 1 from public.provider_usage u where u.job_id=j.id and u.state='reserved' and u.remote_request_id is not null);
 start_pos:=case when resuming then coalesce((j.checkpoint->'model_routing'->>'start_position')::int,((j.checkpoint->'model_routing'->>'next_start')::int+3)%4,route.next_position) else case when route.strategy='priority' then 0 else route.next_position end end % provider_count;
 if start_pos not between 0 and provider_count-1 then raise exception 'INVALID_INPUT';end if;
 if not resuming and route.strategy='round_robin' then update public.model_routing set next_position=(start_pos+1)%provider_count where workspace_id=j.workspace_id;end if;
 for pos in 0..provider_count-1 loop
  provider_id:=ids[((start_pos+pos)%provider_count)+1];
  select value into slot from jsonb_array_elements(server_models) where value->>'provider'=provider_id;
  perform app_private.check_keys(slot,array['provider','model','project_ref','key_configured','free_tier_confirmed']);
  select * into profile from public.model_settings where workspace_id=j.workspace_id and provider=provider_id;
  reason:=null;
  if slot->>'key_configured' is distinct from 'true' or coalesce(slot->>'model','') !~ '^[a-zA-Z0-9._@/-]{1,120}$' or length(coalesce(slot->>'project_ref','')) not between 1 and 120 then reason:='MODEL_NOT_CONFIGURED';
  elsif profile.id is not null and profile.project_ref<>slot->>'project_ref' then reason:='MODEL_IDENTITY_CHANGED';
  elsif exists(select 1 from public.provider_usage u where u.workspace_id=j.workspace_id and u.provider=provider_id and (u.actual_input>u.reserved_input or u.actual_output>u.reserved_output) and u.created_at>=coalesce(profile.verified_at,route.updated_at)) then reason:='MODEL_BUDGET_EXCEEDED';
  end if;
  if reason is not null then checks:=checks||jsonb_build_array(jsonb_build_object('provider',provider_id,'code',reason,'sent',false,'model',slot->>'model','project_ref',slot->>'project_ref','key_configured',slot->'key_configured'));continue;end if;
  config:=jsonb_build_object('enabled',true,'automatic',true,'provider',provider_id,'model',slot->>'model','project_ref',slot->>'project_ref','free_only',false,'billing_verified',false,'free_quota_only',false,'verified_at',coalesce(profile.verified_at,route.updated_at),'quota_mode','provider_managed','quota_ends_at',null,'quota_remaining_tokens',null,'revision',coalesce(profile.revision,route.revision),'calls_per_day',coalesce(profile.calls_per_day,50),'input_per_day',coalesce(profile.input_per_day,250000),'output_per_day',coalesce(profile.output_per_day,50000));
  entries:=entries||jsonb_build_array(config);
 end loop;
 update public.jobs set checkpoint=checkpoint||jsonb_build_object('model_routing',jsonb_build_object('lease',lease,'mode','round_robin','strategy',route.strategy,'provider_order',to_jsonb(ids),'start_position',start_pos,'provider_count',provider_count,'next_start',(start_pos+1)%provider_count,'round_attempts',coalesce((j.checkpoint->'model_routing'->>'round_attempts')::int,0)+case when resuming then 0 else 1 end,'providers',entries,'checks',checks)),revision=revision+1,updated_at=now() where id=j.id;
end $$;

create or replace function public.record_model_attempt(job_id uuid,lease uuid,provider_id text,result_code text,sent boolean) returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;
begin
 select * into j from public.jobs where id=job_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 if provider_id not in ('gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free') or result_code is null or result_code !~ '^[A-Z][A-Z0-9_]{1,100}$' or sent is null then raise exception 'INVALID_INPUT';end if;
 if j.checkpoint->'model_routing'->>'mode' is distinct from 'round_robin' then return;end if;
 if jsonb_array_length(j.checkpoint->'model_routing'->'checks')>=17 then raise exception 'MODEL_ROUND_EXHAUSTED';end if;
 update public.jobs set checkpoint=jsonb_set(checkpoint,'{model_routing,checks}',checkpoint->'model_routing'->'checks'||jsonb_build_array(jsonb_build_object('provider',provider_id,'code',result_code,'sent',sent))),revision=revision+1,updated_at=now() where id=j.id;
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
  perform app_private.check_keys(input,array['enabled','expected_revision','free_providers','provider_order','strategy']);
  if coalesce(input->>'enabled','') not in ('true','false') or coalesce((input->>'expected_revision')::int,-1)<0 then raise exception 'INVALID_INPUT';end if;
  if input ? 'free_providers' and (jsonb_typeof(input->'free_providers') is distinct from 'array' or jsonb_array_length(input->'free_providers')>8 or exists(select 1 from jsonb_array_elements_text(input->'free_providers') p where p is null or not p=any(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free']::text[]))) then raise exception 'INVALID_INPUT';end if;
  if input ? 'strategy' and coalesce(input->>'strategy','') not in ('priority','round_robin') then raise exception 'INVALID_INPUT';end if;
  -- Normalize the previous five-provider UI during rolling publication.
  if jsonb_typeof(input->'provider_order')='array' and jsonb_array_length(input->'provider_order')=5 and input->'provider_order' @> to_jsonb(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free']::text[]) then input:=jsonb_set(input,'{provider_order}',(input->'provider_order')||'["openai","anthropic"]'::jsonb);end if;
  -- Accept the previous seven-provider client during rolling publication.
  if jsonb_typeof(input->'provider_order')='array' and jsonb_array_length(input->'provider_order')=7 and input->'provider_order' @> to_jsonb(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic']::text[]) then input:=jsonb_set(input,'{provider_order}',(input->'provider_order')||'["cloudflare_free"]'::jsonb);end if;
  if input ? 'provider_order' and (jsonb_typeof(input->'provider_order') is distinct from 'array' or jsonb_array_length(input->'provider_order')<>8 or not (input->'provider_order' @> to_jsonb(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free']::text[])) or not (to_jsonb(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free']::text[]) @> (input->'provider_order'))) then raise exception 'INVALID_INPUT';end if;
  select * into routing_config from public.model_routing where workspace_id=w;
  if coalesce(routing_config.revision,0) is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  insert into public.model_routing(workspace_id,enabled,created_by,free_providers,provider_order,strategy) values(w,(input->>'enabled')::boolean,actor,case when input ? 'free_providers' then array(select jsonb_array_elements_text(input->'free_providers')) else coalesce(routing_config.free_providers,'{}'::text[]) end,case when input ? 'provider_order' then array(select jsonb_array_elements_text(input->'provider_order')) else coalesce(routing_config.provider_order,array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free']::text[]) end,coalesce(input->>'strategy',routing_config.strategy,'priority'))
  on conflict(workspace_id) do update set enabled=excluded.enabled,free_providers=excluded.free_providers,provider_order=excluded.provider_order,strategy=excluded.strategy,next_position=case when model_routing.provider_order is distinct from excluded.provider_order or model_routing.strategy is distinct from excluded.strategy then 0 else model_routing.next_position end,created_by=actor,revision=model_routing.revision+1,updated_at=now() returning to_jsonb(model_routing.*) into result;
 when 'model.configure' then
  perform app_private.check_keys(input,array['expected_revision','enabled','provider','model','project_ref','free_only','billing_verified','free_quota_only','quota_ends_at','quota_remaining_tokens','calls_per_day','input_per_day','output_per_day','failover_rank','quota_mode']);
  select * into settings from public.model_settings where workspace_id=w and provider=(input->>'provider') for update;
  if coalesce(settings.revision,0) is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  if coalesce(input->>'quota_mode','verified_budget')='verified_budget' and (input->>'quota_ends_at')::timestamptz<=now() and (input->>'enabled')::boolean then raise exception 'PROVIDER_QUOTA_EXPIRED';end if;
  rank:=coalesce((input->>'failover_rank')::smallint,case input->>'provider'
   when 'gemini_free' then 1 when 'qwen_free' then 2 when 'groq_free' then 3
   when 'mistral_free' then 4 when 'cloudflare_free' then 5 when 'zai_free' then 6 when 'openai' then 7 when 'anthropic' then 8 else 1 end);
  insert into public.model_settings(workspace_id,enabled,provider,model,project_ref,free_only,billing_verified,free_quota_only,verified_at,quota_ends_at,quota_remaining_tokens,calls_per_day,input_per_day,output_per_day,failover_rank,quota_mode,created_by)
  values(w,(input->>'enabled')::boolean,input->>'provider',input->>'model',input->>'project_ref',(input->>'free_only')::boolean,(input->>'billing_verified')::boolean,(input->>'free_quota_only')::boolean,now(),(input->>'quota_ends_at')::timestamptz,(input->>'quota_remaining_tokens')::bigint,(input->>'calls_per_day')::int,(input->>'input_per_day')::bigint,(input->>'output_per_day')::bigint,rank,coalesce(input->>'quota_mode','verified_budget'),actor)
  on conflict(workspace_id,provider) do update set enabled=excluded.enabled,model=excluded.model,project_ref=excluded.project_ref,free_only=excluded.free_only,billing_verified=excluded.billing_verified,free_quota_only=excluded.free_quota_only,verified_at=now(),quota_ends_at=excluded.quota_ends_at,quota_remaining_tokens=excluded.quota_remaining_tokens,calls_per_day=excluded.calls_per_day,input_per_day=excluded.input_per_day,output_per_day=excluded.output_per_day,failover_rank=excluded.failover_rank,quota_mode=excluded.quota_mode,revision=model_settings.revision+1,updated_at=now() returning to_jsonb(model_settings.*) into result;
 when 'model.probe' then
  perform app_private.check_keys(input,array['provider']);
  if input ? 'provider' and (coalesce(input->>'provider','') not in ('gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free') or not exists(select 1 from public.model_routing where workspace_id=w and enabled)) then raise exception 'INVALID_INPUT';end if;
  if not exists(select 1 from public.model_settings where workspace_id=w and provider='gemini_free' and enabled) and not exists(select 1 from public.model_routing where workspace_id=w and enabled) then raise exception 'MODEL_NOT_CONFIGURED'; end if;
  select to_jsonb(j) into result from public.jobs j where j.workspace_id=w and j.type='model_probe' and (j.checkpoint->>'probe_provider') is not distinct from (input->>'provider') and j.status in ('queued','running','retry_wait','quota_wait') order by j.created_at limit 1;
  if result is null then
   if (select count(*) from public.jobs where workspace_id=w and status in ('queued','running','retry_wait','quota_wait','blocked'))>=500 then raise exception 'JOB_CAP_REACHED'; end if;
   insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint)
    values(w,'model_probe',w,encode(sha256(convert_to('tenderdesk-connection-probe-v1','UTF8')),'hex'),'queued',actor,jsonb_strip_nulls(jsonb_build_object('probe_provider',input->>'provider')))
    returning to_jsonb(jobs.*) into result;
  end if;
 when 'content.authorize' then
  perform app_private.check_keys(input,array['entity_kind','entity_id','content_hash','provider','attestation']);
  content:=app_private.content_record(w,input->>'entity_kind',(input->>'entity_id')::uuid);
  if content->>'content_hash'<>input->>'content_hash' then raise exception 'STALE_INPUT';end if;
  if content->>'content' ~* '(confidential|strictly private|سري للغاية|سرية|password[[:space:]]*[:=]|api[_ -]?key[[:space:]]*[:=]|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|-----BEGIN .*PRIVATE KEY)' then raise exception 'DATA_POLICY_BLOCKED';end if;
  insert into public.content_authorizations(workspace_id,entity_kind,entity_id,content_hash,provider,attestation,created_by) values(w,input->>'entity_kind',(input->>'entity_id')::uuid,input->>'content_hash',input->>'provider',input->>'attestation',actor)
  on conflict(workspace_id,entity_kind,entity_id,content_hash,provider) do update set revoked_at=null,authorization_basis='explicit',created_by=actor,created_at=now(),revision=content_authorizations.revision+1 returning to_jsonb(content_authorizations.*) into result;
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

revoke all on function public.prepare_model_routing_before_activity(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
