-- Explicit ordinal ordering and one global cursor across interleaved retry rounds.
-- Retrieving an existing provider request is not a new turn in the round robin.
create or replace function public.prepare_model_routing(job_id uuid,lease uuid,server_models jsonb) returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs; route public.model_routing; slot jsonb; profile public.model_settings; entries jsonb:='[]'; checks jsonb:='[]'; ids text[]:=array['gemini_free','qwen_free','mistral_free','groq_free']; provider_id text; pos int; start_pos int; reason text; config jsonb; resuming boolean;
begin
 select * into j from public.jobs where id=job_id;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 select * into route from public.model_routing where workspace_id=j.workspace_id;
 if not coalesce(route.enabled,false) then return;end if;
 if j.checkpoint->'model_routing'->>'lease' = lease::text then return;end if;
 if server_models is null or jsonb_typeof(server_models)<>'array' or jsonb_array_length(server_models)<>4 or pg_column_size(server_models)>8192 then raise exception 'INVALID_INPUT';end if;
 if (select count(distinct s->>'provider') from jsonb_array_elements(server_models) s where s->>'provider'=any(ids))<>4 then raise exception 'INVALID_INPUT';end if;
 resuming:=exists(select 1 from public.provider_usage u where u.job_id=j.id and u.state='reserved' and u.remote_request_id is not null);
 start_pos:=case when resuming then coalesce(((j.checkpoint->'model_routing'->>'next_start')::int+3)%4,route.next_position) else route.next_position end;
 if start_pos not between 0 and 3 then raise exception 'INVALID_INPUT';end if;
 if not resuming then update public.model_routing set next_position=(start_pos+1)%4 where workspace_id=j.workspace_id;end if;
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

create or replace function public.model_preflight(job_id uuid,lease uuid,manifest jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; entry jsonb; providers jsonb:='[]'; pending text;
begin
 select * into j from public.jobs where id=job_id;
 if not exists(select 1 from public.model_routing where workspace_id=j.workspace_id and enabled) then return app_private.manual_model_preflight(job_id,lease,manifest);end if;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 if j.checkpoint->'model_routing'->>'lease' is distinct from lease::text then raise exception 'MODEL_ROUTING_NOT_PREPARED';end if;
 if j.type='model_probe' and manifest is distinct from '[]'::jsonb then raise exception 'INVALID_INPUT';end if;
 select u.provider into pending from public.provider_usage u where u.job_id=j.id and u.remote_request_id is not null and u.state='reserved' order by u.created_at desc limit 1;
 for entry in select value from jsonb_array_elements(j.checkpoint->'model_routing'->'providers') with ordinality as candidates(value,position) order by case when value->>'provider'=pending then 0 else 1 end,position loop
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
