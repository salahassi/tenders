-- Extend the existing provider pool with OpenRouter and QwenCloud Singapore.
-- This migration is still local; neither provider has been deployed or activated.
-- Preserve configured order/cursor, grants and data-sharing permission.
alter table public.model_routing drop constraint model_routing_next_position_check;
alter table public.model_routing add constraint model_routing_next_position_check check(next_position between 0 and 9);
alter table public.model_routing drop constraint model_routing_provider_order_check;
alter table public.model_routing alter column provider_order set default array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter','qwencloud']::text[];
update public.model_routing set provider_order=provider_order||array(select id from unnest(array['openrouter','qwencloud']) id where not(id=any(provider_order))),revision=revision+1,updated_at=now() where not(provider_order @> array['openrouter','qwencloud']);
alter table public.model_routing add constraint model_routing_provider_order_check check(array_length(provider_order,1)=10 and provider_order @> array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter','qwencloud']::text[] and provider_order <@ array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter','qwencloud']::text[] and array_position(provider_order,null) is null);
alter table public.model_routing drop constraint model_routing_free_providers_check;
alter table public.model_routing add constraint model_routing_free_providers_check check(free_providers <@ array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter','qwencloud']::text[] and array_position(free_providers,null) is null);
alter table public.model_settings drop constraint model_settings_provider_check;
alter table public.model_settings add constraint model_settings_provider_check check(provider in ('gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter','qwencloud'));
alter table public.content_authorizations drop constraint content_authorizations_provider_check;
alter table public.content_authorizations add constraint content_authorizations_provider_check check(provider in ('gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter','qwencloud'));
alter table public.model_connections drop constraint model_connections_provider_check;
alter table public.model_connections add constraint model_connections_provider_check check(provider in ('gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter','qwencloud'));

-- Guard the existing function version and preserve its grants/security attributes.
do $patch$ declare body text; definition text; begin
select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc where oid='app_private.model_policy_command(text, jsonb, text)'::regprocedure;
if encode(sha256(convert_to(body,'UTF8')),'hex')='904550ba4ec1979470142848aa0283d7018e23bd6fd4b2b4db9d6cd54f1ef798' then return;end if;
if encode(sha256(convert_to(body,'UTF8')),'hex')<>'0d239e0a0e5f9e8ec19836665a68baeb5d22ca452c7cc71c5527741d0b7d9090' then raise exception 'Unexpected provider function version: app_private.model_policy_command(text, jsonb, text)';end if;
execute replace(definition,body,$body$
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
  if input ? 'free_providers' and (jsonb_typeof(input->'free_providers') is distinct from 'array' or jsonb_array_length(input->'free_providers')>10 or exists(select 1 from jsonb_array_elements_text(input->'free_providers') p where p is null or not p=any(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter','qwencloud']::text[]))) then raise exception 'INVALID_INPUT';end if;
  if input ? 'strategy' and coalesce(input->>'strategy','') not in ('priority','round_robin') then raise exception 'INVALID_INPUT';end if;
  -- Normalize the previous five-provider UI during rolling publication.
  if jsonb_typeof(input->'provider_order')='array' and jsonb_array_length(input->'provider_order')=5 and input->'provider_order' @> to_jsonb(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free']::text[]) then input:=jsonb_set(input,'{provider_order}',(input->'provider_order')||'["openai","anthropic"]'::jsonb);end if;
  -- Accept the previous seven-provider client during rolling publication.
  if jsonb_typeof(input->'provider_order')='array' and jsonb_array_length(input->'provider_order')=7 and input->'provider_order' @> to_jsonb(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic']::text[]) then input:=jsonb_set(input,'{provider_order}',(input->'provider_order')||'["cloudflare_free"]'::jsonb);end if;
  -- Normalize previous complete clients before the existing revision/idempotency checks.
  if jsonb_typeof(input->'provider_order')='array' and jsonb_array_length(input->'provider_order')=8 and input->'provider_order' @> to_jsonb(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free']::text[]) then input:=jsonb_set(input,'{provider_order}',(input->'provider_order')||'["openrouter","qwencloud"]'::jsonb);end if;
  if jsonb_typeof(input->'provider_order')='array' and jsonb_array_length(input->'provider_order')=9 and input->'provider_order' @> to_jsonb(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter']::text[]) then input:=jsonb_set(input,'{provider_order}',(input->'provider_order')||'["qwencloud"]'::jsonb);end if;
  if input ? 'provider_order' and (jsonb_typeof(input->'provider_order') is distinct from 'array' or jsonb_array_length(input->'provider_order')<>10 or not (input->'provider_order' @> to_jsonb(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter','qwencloud']::text[])) or not (to_jsonb(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter','qwencloud']::text[]) @> (input->'provider_order'))) then raise exception 'INVALID_INPUT';end if;
  select * into routing_config from public.model_routing where workspace_id=w;
  if coalesce(routing_config.revision,0) is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  insert into public.model_routing(workspace_id,enabled,created_by,free_providers,provider_order,strategy) values(w,(input->>'enabled')::boolean,actor,case when input ? 'free_providers' then array(select jsonb_array_elements_text(input->'free_providers')) else coalesce(routing_config.free_providers,'{}'::text[]) end,case when input ? 'provider_order' then array(select jsonb_array_elements_text(input->'provider_order')) else coalesce(routing_config.provider_order,array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter','qwencloud']::text[]) end,coalesce(input->>'strategy',routing_config.strategy,'priority'))
  on conflict(workspace_id) do update set enabled=excluded.enabled,free_providers=excluded.free_providers,provider_order=excluded.provider_order,strategy=excluded.strategy,next_position=case when model_routing.provider_order is distinct from excluded.provider_order or model_routing.strategy is distinct from excluded.strategy then 0 else model_routing.next_position end,created_by=actor,revision=model_routing.revision+1,updated_at=now() returning to_jsonb(model_routing.*) into result;
 when 'model.configure' then
  perform app_private.check_keys(input,array['expected_revision','enabled','provider','model','project_ref','free_only','billing_verified','free_quota_only','quota_ends_at','quota_remaining_tokens','calls_per_day','input_per_day','output_per_day','failover_rank','quota_mode']);
  select * into settings from public.model_settings where workspace_id=w and provider=(input->>'provider') for update;
  if coalesce(settings.revision,0) is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  if coalesce(input->>'quota_mode','verified_budget')='verified_budget' and (input->>'quota_ends_at')::timestamptz<=now() and (input->>'enabled')::boolean then raise exception 'PROVIDER_QUOTA_EXPIRED';end if;
  rank:=coalesce((input->>'failover_rank')::smallint,case input->>'provider'
   when 'gemini_free' then 1 when 'qwen_free' then 2 when 'groq_free' then 3
   when 'mistral_free' then 4 when 'cloudflare_free' then 5 when 'zai_free' then 6 when 'openai' then 7 when 'anthropic' then 8 when 'openrouter' then 9 when 'qwencloud' then 10 else 1 end);
  insert into public.model_settings(workspace_id,enabled,provider,model,project_ref,free_only,billing_verified,free_quota_only,verified_at,quota_ends_at,quota_remaining_tokens,calls_per_day,input_per_day,output_per_day,failover_rank,quota_mode,created_by)
  values(w,(input->>'enabled')::boolean,input->>'provider',input->>'model',input->>'project_ref',(input->>'free_only')::boolean,(input->>'billing_verified')::boolean,(input->>'free_quota_only')::boolean,now(),(input->>'quota_ends_at')::timestamptz,(input->>'quota_remaining_tokens')::bigint,(input->>'calls_per_day')::int,(input->>'input_per_day')::bigint,(input->>'output_per_day')::bigint,rank,coalesce(input->>'quota_mode','verified_budget'),actor)
  on conflict(workspace_id,provider) do update set enabled=excluded.enabled,model=excluded.model,project_ref=excluded.project_ref,free_only=excluded.free_only,billing_verified=excluded.billing_verified,free_quota_only=excluded.free_quota_only,verified_at=now(),quota_ends_at=excluded.quota_ends_at,quota_remaining_tokens=excluded.quota_remaining_tokens,calls_per_day=excluded.calls_per_day,input_per_day=excluded.input_per_day,output_per_day=excluded.output_per_day,failover_rank=excluded.failover_rank,quota_mode=excluded.quota_mode,revision=model_settings.revision+1,updated_at=now() returning to_jsonb(model_settings.*) into result;
 when 'model.probe' then
  perform app_private.check_keys(input,array['provider']);
  if input ? 'provider' and (coalesce(input->>'provider','') not in ('gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter','qwencloud') or not exists(select 1 from public.model_routing where workspace_id=w and enabled)) then raise exception 'INVALID_INPUT';end if;
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
  perform app_private.assert_business_content(content->>'content');
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
end $body$);
end $patch$;

-- Guard the existing function version and preserve its grants/security attributes.
do $patch$ declare body text; definition text; begin
select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc where oid='public.reserve_model_call(uuid, uuid, text, text, integer, integer, jsonb, text)'::regprocedure;
if encode(sha256(convert_to(body,'UTF8')),'hex')='994a17b615d1a91d13804e2bf330a917d9746faa6616992bead695103b304704' then return;end if;
if encode(sha256(convert_to(body,'UTF8')),'hex')<>'25f6aa18b2f5f08b2e720aac1012f395a0ce589bb8724aed88aee38775dfe397' then raise exception 'Unexpected provider function version: public.reserve_model_call(uuid, uuid, text, text, integer, integer, jsonb, text)';end if;
execute replace(definition,body,$body$
declare j public.jobs; m public.model_settings; w uuid; u public.provider_usage;
 day date:=(now() at time zone 'Asia/Riyadh')::date; calls integer; inputs bigint; outputs bigint; settings jsonb; pool jsonb; automatic boolean;
begin
 if target_provider is null or target_provider not in (
  'gemini_free','qwen_free','groq_free','mistral_free','cloudflare_free','zai_free','openai','anthropic','openrouter','qwencloud'
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
 if input_tokens not between 1 and (case when j.type='classify_opportunity' then 64000 else 20000 end) or output_tokens not between 1 and 40000 then raise exception 'MODEL_CONTEXT_TOO_LARGE'; end if;
 if length(call_key) not between 1 and 200 or input_hash!~'^[0-9a-f]{64}$' then raise exception 'INVALID_INPUT'; end if;
 if exists(select 1 from public.provider_usage p where p.workspace_id=w and p.job_id=reserve_model_call.job_id and p.call_key=reserve_model_call.call_key) then
  raise exception 'MODEL_CALL_ALREADY_RESERVED';
 end if;
 -- Automatic routing retains unknown usage, but a different provider may take over.
 if exists(select 1 from public.provider_usage p where p.workspace_id=w and (
  p.state='reserved' or (p.state='unknown' and case when coalesce(automatic,false) then
   p.provider=target_provider and (p.job_id=j.id or p.input_hash=reserve_model_call.input_hash) and (p.created_at>now()-interval '15 minutes' or p.remote_deadline>now())
  else m.quota_mode<>'provider_managed' or m.provider<>'gemini_free' or p.provider<>m.provider or p.model<>m.model or p.job_id=j.id or p.input_hash=reserve_model_call.input_hash end)
 )) then raise exception 'USAGE_REVIEW_REQUIRED';end if;
 if not coalesce(automatic,false) and exists(select 1 from public.provider_usage p where p.workspace_id=w and p.created_at>now()-interval '1 minute'
  and not (p.job_id=j.id and p.provider<>target_provider and
   (coalesce(automatic,false) or (p.state='settled' and p.error_code='PROVIDER_QUOTA_WAIT')))) then raise exception 'MODEL_RATE_WAIT';end if;
 if not coalesce(automatic,false) then
 select count(*),coalesce(sum(coalesce(actual_input,case when app_private.generation_reservation_rejected(provider_usage) then 0 else reserved_input end)),0),coalesce(sum(coalesce(actual_output,case when app_private.generation_reservation_rejected(provider_usage) then 0 else reserved_output end)),0)
 into calls,inputs,outputs from public.provider_usage where workspace_id=w and application_day=day;
 select workspaces.settings into settings from public.workspaces where id=w;
 if calls>=least(m.calls_per_day,coalesce((settings->>'daily_call_limit')::int,50))
  or inputs+input_tokens>least(m.input_per_day,coalesce((settings->>'input_token_limit')::int,250000))
  or outputs+output_tokens>least(m.output_per_day,coalesce((settings->>'output_token_limit')::int,50000)) then
  raise exception 'MODEL_DAILY_QUOTA_WAIT';
 end if;
 if m.quota_mode='verified_budget' and (select coalesce(sum(coalesce(actual_input,case when app_private.generation_reservation_rejected(provider_usage) then 0 else reserved_input end)+coalesce(actual_output,case when app_private.generation_reservation_rejected(provider_usage) then 0 else reserved_output end)),0)
     from public.provider_usage where workspace_id=w and provider=m.provider and model=m.model and created_at>=m.verified_at)
    +input_tokens+output_tokens>m.quota_remaining_tokens then
  raise exception 'PROVIDER_QUOTA_WAIT';
 end if;
 end if;
 insert into public.provider_usage(
  workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,created_by
 ) values (
  w,job_id,lease,call_key,m.provider,m.model,input_hash,day,m.revision,input_tokens,output_tokens,j.created_by
 ) returning * into u;
 return to_jsonb(u);
end $body$);
end $patch$;

-- Guard the existing function version and preserve its grants/security attributes.
do $patch$ declare body text; definition text; begin
select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc where oid='public.prepare_model_routing_before_activity(uuid, uuid, jsonb)'::regprocedure;
if encode(sha256(convert_to(body,'UTF8')),'hex')='639ca641de9222a5f6c68c1f11a55e52757b4f88fd55c7f0069ccee0a9b0071c' then return;end if;
if encode(sha256(convert_to(body,'UTF8')),'hex')<>'20666e8e221b20901b035ef21a3d6ad6bd4fbae308cf4aae2f2fdf4b10c46354' then raise exception 'Unexpected provider function version: public.prepare_model_routing_before_activity(uuid, uuid, jsonb)';end if;
execute replace(definition,body,$body$
declare j public.jobs; route public.model_routing; slot jsonb; profile public.model_settings; entries jsonb:='[]'; checks jsonb:='[]'; ids text[]:=array['gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter','qwencloud']; provider_id text; pos int; start_pos int; reason text; config jsonb; resuming boolean; provider_count int;
begin
 select * into j from public.jobs where id=job_id;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 select * into route from public.model_routing where workspace_id=j.workspace_id;
 if not coalesce(route.enabled,false) then return;end if;
 if j.checkpoint->'model_routing'->>'lease' = lease::text then return;end if;
 if server_models is null or jsonb_typeof(server_models)<>'array' or jsonb_array_length(server_models) not in (4,5,7,8,9,10) or pg_column_size(server_models)>8192 then raise exception 'INVALID_INPUT';end if;
 -- Accept previous workers without changing the saved eight-provider order.
 ids:=array(select item from unnest(route.provider_order) with ordinality as ordered(item,pos) where exists(select 1 from jsonb_array_elements(server_models) s where s->>'provider'=item) order by ordered.pos);
 provider_count:=coalesce(array_length(ids,1),0);
 if provider_count<>jsonb_array_length(server_models) then raise exception 'INVALID_INPUT';end if;
 if (select count(distinct s->>'provider') from jsonb_array_elements(server_models) s where s->>'provider'=any(ids))<>provider_count then raise exception 'INVALID_INPUT';end if;
 resuming:=j.checkpoint ? 'model_round' or exists(select 1 from public.provider_usage u where u.job_id=j.id and u.state='reserved' and u.remote_request_id is not null);
 start_pos:=case when resuming then coalesce((j.checkpoint->'model_routing'->>'start_position')::int,((j.checkpoint->'model_routing'->>'next_start')::int+3)%4,route.next_position) else case when route.strategy='priority' then 0 else route.next_position end end % provider_count;
 if start_pos not between 0 and provider_count-1 then raise exception 'INVALID_INPUT';end if;
 if not resuming and route.strategy='round_robin' then update public.model_routing set next_position=(start_pos+1)%provider_count where workspace_id=j.workspace_id;end if;
 for pos in 0..provider_count-1 loop
  provider_id:=ids[((start_pos+pos)%provider_count)+1];
  select value into slot from jsonb_array_elements(server_models) where value->>'provider'=provider_id;
  perform app_private.check_keys(slot,array['provider','model','project_ref','key_configured','free_tier_confirmed']);
  select * into profile from public.model_settings where workspace_id=j.workspace_id and provider=provider_id;
  reason:=null;
  if slot->>'key_configured' is distinct from 'true' or coalesce(slot->>'model','') !~ '^[a-zA-Z0-9._@/:-]{1,120}$' or length(coalesce(slot->>'project_ref','')) not between 1 and 120 then reason:='MODEL_NOT_CONFIGURED';


  end if;
  if reason is not null then checks:=checks||jsonb_build_array(jsonb_build_object('provider',provider_id,'code',reason,'sent',false,'model',slot->>'model','project_ref',slot->>'project_ref','key_configured',slot->'key_configured'));continue;end if;
  config:=jsonb_build_object('enabled',true,'automatic',true,'provider',provider_id,'model',slot->>'model','project_ref',slot->>'project_ref','free_only',false,'billing_verified',false,'free_quota_only',false,'verified_at',coalesce(profile.verified_at,route.updated_at),'quota_mode','provider_managed','quota_ends_at',null,'quota_remaining_tokens',null,'revision',coalesce(profile.revision,route.revision),'calls_per_day',coalesce(profile.calls_per_day,50),'input_per_day',coalesce(profile.input_per_day,250000),'output_per_day',coalesce(profile.output_per_day,50000));
  entries:=entries||jsonb_build_array(config);
 end loop;
 update public.jobs set checkpoint=checkpoint||jsonb_build_object('model_routing',jsonb_build_object('lease',lease,'mode','round_robin','strategy',route.strategy,'provider_order',to_jsonb(ids),'start_position',start_pos,'provider_count',provider_count,'next_start',(start_pos+1)%provider_count,'round_attempts',coalesce((j.checkpoint->'model_routing'->>'round_attempts')::int,0)+case when resuming then 0 else 1 end,'providers',entries,'checks',checks)),revision=revision+1,updated_at=now() where id=j.id;
end $body$);
end $patch$;

-- Guard the existing function version and preserve its grants/security attributes.
do $patch$ declare body text; definition text; begin
select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc where oid='public.app_command_before_browser(text, jsonb, text)'::regprocedure;
if encode(sha256(convert_to(body,'UTF8')),'hex')='e53f7039c08a485edd8392fb2401f412b06d152f000c747ee3eacd6e5259407e' then return;end if;
if encode(sha256(convert_to(body,'UTF8')),'hex')<>'08673bf3dd5468855e8973f8c1e80cc9c9172d99e84201e13ff59c7049a4b1b3' then raise exception 'Unexpected provider function version: public.app_command_before_browser(text, jsonb, text)';end if;
execute replace(definition,body,$body$
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
   or input->'capabilities'->>'reasoning'='qwen_toggle' and connection.provider not in ('qwen_free','qwencloud')
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
  perform app_private.check_keys(input,array['expected_revision','enabled','max_parallel_requests']);
  if input ? 'max_parallel_requests' and (
   jsonb_typeof(input->'max_parallel_requests') is distinct from 'number'
   or (input->>'max_parallel_requests') !~ '^[1-4]$'
  ) then raise exception 'INVALID_INPUT';end if;
  if coalesce(input->>'enabled','') not in ('true','false') then raise exception 'INVALID_INPUT';end if;
  select revision into current_revision from public.model_execution_settings where workspace_id=w;
  if coalesce(current_revision,0)<>(input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  if input->>'enabled'='true' and not exists(select 1 from public.model_task_routes where workspace_id=w and task='default' and cardinality(model_ids)>0) then raise exception 'MODEL_NOT_CONFIGURED';end if;
  insert into public.model_execution_settings(workspace_id,enabled,admitted_after,created_by,max_parallel_requests)
  values(w,(input->>'enabled')::boolean,case when input->>'enabled'='true' then now() end,actor,
   coalesce((input->>'max_parallel_requests')::integer,app_private.model_request_limit(w)))
  on conflict(workspace_id) do update set enabled=excluded.enabled,max_parallel_requests=excluded.max_parallel_requests,
   admitted_after=case when excluded.enabled and not model_execution_settings.enabled then now() else model_execution_settings.admitted_after end,
   revision=model_execution_settings.revision+1,updated_at=now()
  returning to_jsonb(model_execution_settings.*) into result;
 end case;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,request_id)
 values(w,actor,operation,(result->>'id')::uuid,gen_random_uuid());
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result)
 values(w,actor,'COMMAND',operation,idempotency_key,body_hash,result);
 return result;
end $body$);
end $patch$;

-- Guard the existing function version and preserve its grants/security attributes.
do $patch$ declare body text; definition text; begin
select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc where oid='app_private.app_command_before_source_discovery(text, jsonb, text)'::regprocedure;
if encode(sha256(convert_to(body,'UTF8')),'hex')='2e4b385753115a0307eb4b02ab6a69c957f521d4b11d8ff1ef70755378605db7' then return;end if;
if encode(sha256(convert_to(body,'UTF8')),'hex')<>'87eba09fc5949dbe29605e4ded74a0be7f23add57cd07a86aecb6bda0723c179' then raise exception 'Unexpected provider function version: app_private.app_command_before_source_discovery(text, jsonb, text)';end if;
execute replace(definition,body,$body$
declare w uuid;actor uuid:=auth.uid();body_hash text;replay app_private.idempotency_records;result jsonb;policy jsonb;scope_changed boolean;scope_policy jsonb;
begin
 if operation<>'discovery.configure' then
  result:=app_private.discovery_previous_command(operation,input,idempotency_key);
  if operation='content.authorize' then
   update public.opportunities o set assessment_pending=true where o.workspace_id=(result->>'workspace_id')::uuid and not o.archived
    and (input->>'entity_kind'='knowledge' or (input->>'entity_kind'='notice' and o.id=(input->>'entity_id')::uuid))
    and exists(select 1 from public.generation_plans p where p.opportunity_id=o.id and p.kind='assessment' and p.status='blocked' and p.error_code='DATA_AUTHORIZATION_REQUIRED');
  end if;return result;
 end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;
 if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;
 if app_private.member_role(w) is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 if exists(select 1 from public.restore_sessions where workspace_id=w and state='staging') then raise exception 'RESTORE_IN_PROGRESS';end if;
 perform app_private.check_keys(input,array['expected_revision','scope','auto_public_notices','providers','auto_company_knowledge','include_keywords','exclude_keywords']);
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(input)>16384
  or coalesce(input->>'auto_public_notices','') not in ('true','false')
  or jsonb_typeof(input->'providers') is distinct from 'array' then raise exception 'INVALID_INPUT';end if;
 if input ? 'auto_company_knowledge' and coalesce(input->>'auto_company_knowledge','') not in ('true','false') then raise exception 'INVALID_INPUT';end if;
 if jsonb_array_length(input->'providers')>10 or exists(select 1 from jsonb_array_elements_text(input->'providers') p where p not in ('gemini_free','qwen_free','mistral_free','groq_free','cloudflare_free','zai_free','openai','anthropic','openrouter','qwencloud'))
  or ((input->>'auto_public_notices')::boolean or coalesce((input->>'auto_company_knowledge')::boolean,false)) and jsonb_array_length(input->'providers')=0 then raise exception 'INVALID_INPUT';end if;
 scope_policy:=app_private.discovery_scope(input);
 body_hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then if replay.body_hash<>body_hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 select app_private.discovery_scope(discovery_policy) is distinct from scope_policy into scope_changed from public.workspaces where id=w;
 policy:=(input-'expected_revision')||scope_policy||jsonb_build_object('auto_company_knowledge',coalesce(input->'auto_company_knowledge',(select discovery_policy->'auto_company_knowledge' from public.workspaces where id=w),'false'::jsonb),'approved_by',actor,'approved_at',now());
 update public.workspaces set discovery_policy=policy,evidence_revision=evidence_revision+case when scope_changed then 1 else 0 end,revision=revision+1,updated_at=now() where id=w and revision=(input->>'expected_revision')::int returning to_jsonb(workspaces.*) into result;
 if result is null then raise exception 'REVISION_CONFLICT';end if;
 update public.opportunities o set assessment_pending=true where workspace_id=w and not archived and (scope_changed or exists(select 1 from public.generation_plans p where p.opportunity_id=o.id and p.kind='assessment' and p.status='blocked' and p.error_code='DATA_AUTHORIZATION_REQUIRED'));
 update public.approvals set invalidated_at=coalesce(invalidated_at,now()) where workspace_id=w and scope_changed;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id) values(w,actor,operation,w,policy::text,gen_random_uuid());
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,body_hash,result);
 return result;
end $body$);
end $patch$;

-- Guard the existing function version and preserve its grants/security attributes.
do $patch$ declare body text; definition text; begin
select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc where oid='public.record_model_attempt(uuid, uuid, text, text, boolean)'::regprocedure;
if encode(sha256(convert_to(body,'UTF8')),'hex')='0d7299cb3a6ed0dec65c01a719d0ddbbfced720390b4448a4e2348d8ca66c820' then return;end if;
if encode(sha256(convert_to(body,'UTF8')),'hex')<>'a9b98aa8f04a3292512909a6c753e57e59acc639bb200beb4abbec1ba008c450' then raise exception 'Unexpected provider function version: public.record_model_attempt(uuid, uuid, text, text, boolean)';end if;
execute replace(definition,body,$body$
declare j public.jobs;
begin
 select * into j from public.jobs where id=job_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 if provider_id not in ('gemini_free','qwen_free','mistral_free','groq_free','zai_free','openai','anthropic','cloudflare_free','openrouter','qwencloud') or result_code is null or result_code !~ '^[A-Z][A-Z0-9_]{1,100}$' or sent is null then raise exception 'INVALID_INPUT';end if;
 if j.checkpoint->'model_routing'->>'mode' is distinct from 'round_robin' then return;end if;
 if jsonb_array_length(j.checkpoint->'model_routing'->'checks')>=21 then raise exception 'MODEL_ROUND_EXHAUSTED';end if;
 update public.jobs set checkpoint=jsonb_set(checkpoint,'{model_routing,checks}',checkpoint->'model_routing'->'checks'||jsonb_build_array(jsonb_build_object('provider',provider_id,'code',result_code,'sent',sent))),revision=revision+1,updated_at=now() where id=j.id;
end $body$);
end $patch$;

-- Guard the existing function version and preserve its grants/security attributes.
do $patch$ declare body text; definition text; begin
select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc where oid='public.start_model_attempt(uuid, uuid, text, text, text, text)'::regprocedure;
if encode(sha256(convert_to(body,'UTF8')),'hex')='4357f380b250c346ff0ab5ab38f03a0077c3a4e96c5a87db15cca714ad77d21c' then return;end if;
if encode(sha256(convert_to(body,'UTF8')),'hex')<>'f34165367b6ed533ca4c6eb74321d915c0c93d58d84656771917b2d929f893f3' then raise exception 'Unexpected provider function version: public.start_model_attempt(uuid, uuid, text, text, text, text)';end if;
execute replace(definition,body,$body$
declare j public.jobs; result bigint;
begin
 select * into j from public.jobs where id=job_id;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 if provider_id not in ('gemini_free','qwen_free','mistral_free','groq_free','zai_free','cloudflare_free','openai','anthropic','openrouter','qwencloud') or length(model_name)>120 or length(project_name)>120 or operation_name !~ '^[a-z_]{1,80}$' then raise exception 'INVALID_INPUT';end if;
 insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,project_ref,operation,round_number,worker_attempt,status)
 values(j.workspace_id,j.id,lease,provider_id,model_name,project_name,operation_name,coalesce((j.checkpoint->'model_routing'->>'round_attempts')::int,j.attempts),j.attempts,'running')
 on conflict on constraint model_attempts_job_lease_provider_key do update set model=excluded.model,project_ref=excluded.project_ref returning id into result;
 return result;
end $body$);
end $patch$;

-- Guard the existing function version and preserve its grants/security attributes.
do $patch$ declare body text; definition text; begin
select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc where oid='public.save_model_round(uuid, uuid, jsonb, boolean)'::regprocedure;
if encode(sha256(convert_to(body,'UTF8')),'hex')='87311e5e6cbfaed3eeef8c986856949f61fc2335b0fded5023a4710542f0319f' then return;end if;
if encode(sha256(convert_to(body,'UTF8')),'hex')<>'a0225a48c5d2e114d6a5017c7bd7f50efa636a542536467b97a05681a9d8305a' then raise exception 'Unexpected provider function version: public.save_model_round(uuid, uuid, jsonb, boolean)';end if;
execute replace(definition,body,$body$
declare j public.jobs; item jsonb;
begin
 select * into j from public.jobs where id=job_id;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 select * into j from public.jobs where id=job_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 if release_job is null or (progress is null and release_job) then raise exception 'INVALID_INPUT';end if;
 if progress is not null then
  perform app_private.check_keys(progress,array['input_hash','remaining','output_error','retry_windows']);
  if pg_column_size(progress)>8192 or coalesce(progress->>'input_hash','') !~ '^[a-f0-9]{64}$'
   or jsonb_typeof(progress->'remaining') is distinct from 'array'
   or jsonb_typeof(progress->'retry_windows') is distinct from 'array' then raise exception 'INVALID_INPUT';end if;
  if jsonb_array_length(progress->'remaining') not between 1 and 10 or jsonb_array_length(progress->'retry_windows')>10
   or (progress->>'output_error' is not null and progress->>'output_error' not in ('MODEL_OUTPUT_INVALID','MODEL_OUTPUT_TRUNCATED','MODEL_OUTPUT_TOO_LARGE','MODEL_COVERAGE_INCOMPLETE','EVIDENCE_REFERENCE_INVALID','UNSUPPORTED_COMPANY_CLAIM'))
   or (select count(distinct e->>'provider') from jsonb_array_elements(progress->'remaining') e)<>jsonb_array_length(progress->'remaining') then raise exception 'INVALID_INPUT';end if;
  for item in select value from jsonb_array_elements(progress->'remaining') loop
   perform app_private.check_keys(item,array['provider','model','project_ref']);
   if not exists(select 1 from jsonb_array_elements(j.checkpoint->'model_routing'->'providers') p where p->>'provider'=item->>'provider' and p->>'model'=item->>'model' and p->>'project_ref'=item->>'project_ref') then raise exception 'MODEL_IDENTITY_CHANGED';end if;
  end loop;
  for item in select value from jsonb_array_elements(progress->'retry_windows') loop
   if item<>'null'::jsonb and (jsonb_typeof(item)<>'string' or not isfinite((item#>>'{}')::timestamptz)) then raise exception 'INVALID_INPUT';end if;
  end loop;
 end if;
 -- Releasing between providers is distinct from an accepted remote request;
 -- that request must use defer_model_request so it remains GET-only on resume.
 if release_job and exists(select 1 from public.provider_usage u where u.job_id=j.id and u.state='reserved') then raise exception 'MODEL_CALL_ALREADY_RESERVED';end if;
 update public.jobs set checkpoint=case when progress is null then checkpoint-'model_round' else jsonb_set(checkpoint,'{model_round}',progress) end,
  status=case when release_job then 'retry_wait' else status end,
  error_code=case when release_job then 'MODEL_IN_PROGRESS' else error_code end,
  next_attempt_at=case when release_job then now() else next_attempt_at end,
  lease_token=case when release_job then null else lease_token end,
  lease_until=case when release_job then null else lease_until end,
  revision=revision+1,updated_at=now() where id=j.id;
end $body$);
end $patch$;

-- Guard the existing function version and preserve its grants/security attributes.
do $patch$ declare body text; definition text; begin
select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc where oid='public.import_model_catalog(uuid, uuid, jsonb)'::regprocedure;
if encode(sha256(convert_to(body,'UTF8')),'hex')='8dcf71c6f111f2566e33f463138ba06ed03eb3d07a57da668c517b603f6d342c' then return;end if;
if encode(sha256(convert_to(body,'UTF8')),'hex')<>'2a8f7a71dda41d2417bf5c28e8c1817eb2d0b5cdc058bd27e1d0f8c5f993bb4b' then raise exception 'Unexpected provider function version: public.import_model_catalog(uuid, uuid, jsonb)';end if;
execute replace(definition,body,$body$
declare j public.jobs;s jsonb;c public.model_connections;m uuid;alias text;ids uuid[];route public.model_routing;
begin
 select * into j from public.jobs where id=job_id;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 if jsonb_typeof(server_models) is distinct from 'array' or jsonb_array_length(server_models)>10 or pg_column_size(server_models)>16384 then raise exception 'INVALID_INPUT';end if;
 for s in select value from jsonb_array_elements(server_models) loop
  perform app_private.check_keys(s,array['provider','model','project_ref','key_configured','capabilities']);
  if coalesce(s->>'model','')='' or coalesce(s->>'project_ref','')='' then continue;end if;
  perform app_private.validate_model_capabilities(s->'capabilities');
  alias:='APP_MODEL_'||case s->>'provider' when 'gemini_free' then 'GEMINI' when 'qwen_free' then 'QWEN' when 'groq_free' then 'GROQ' when 'mistral_free' then 'MISTRAL' when 'zai_free' then 'ZAI' when 'cloudflare_free' then 'CLOUDFLARE' when 'openai' then 'OPENAI' when 'anthropic' then 'CLAUDE' when 'openrouter' then 'OPENROUTER' when 'qwencloud' then 'QWENCLOUD' else '' end||'_KEY';
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
end $body$);
end $patch$;

-- OpenRouter model variants use colon suffixes, including :free.
alter table public.model_settings drop constraint model_settings_model_check;
alter table public.model_settings add constraint model_settings_model_check check(model ~ '^[a-zA-Z0-9._@/:-]{1,120}$');

-- OpenRouter model variants use colon suffixes, including :free.
alter table public.model_configurations drop constraint model_configurations_model_check;
alter table public.model_configurations add constraint model_configurations_model_check check(model ~ '^[a-zA-Z0-9._@/:-]{1,120}$');
