-- A queued targeted probe must never fall back to another identity after routing changes.
create or replace function public.model_preflight(job_id uuid,lease uuid,manifest jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; entry jsonb; providers jsonb:='[]'; pending text;
begin
 select * into j from public.jobs where id=job_id;
 if not exists(select 1 from public.model_routing where workspace_id=j.workspace_id and enabled) then
  if j.type='model_probe' and j.checkpoint ? 'probe_provider' then raise exception 'MODEL_NOT_CONFIGURED';end if;
  return app_private.manual_model_preflight(job_id,lease,manifest);
 end if;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 if j.checkpoint->'model_routing'->>'lease' is distinct from lease::text then raise exception 'MODEL_ROUTING_NOT_PREPARED';end if;
 if j.type='model_probe' and manifest is distinct from '[]'::jsonb then raise exception 'INVALID_INPUT';end if;
 select u.provider into pending from public.provider_usage u where u.job_id=j.id and u.remote_request_id is not null and u.state='reserved' order by u.created_at desc limit 1;
 for entry in select value from jsonb_array_elements(j.checkpoint->'model_routing'->'providers') with ordinality as candidates(value,position) order by case when value->>'provider'=pending then 0 else 1 end,position loop
  if j.type='model_probe' and j.checkpoint ? 'probe_provider' and entry->>'provider' is distinct from j.checkpoint->>'probe_provider' then continue;end if;
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
