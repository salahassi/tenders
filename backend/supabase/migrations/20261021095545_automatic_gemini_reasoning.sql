-- Optional Gemini thinking controls are observed per account, model revision,
-- API transport and requested level. No model-name table or paid probe is used.
create index model_attempts_reasoning_rejection_idx
 on public.model_attempts(workspace_id,provider,model,project_ref,started_at desc)
 where status='failed' and http_status in (400,422) and provider_error_reason='reasoning_unsupported';

create function public.model_reasoning_allowed(job_id uuid,lease uuid,target_provider text,target_model text,
 target_project text,target_transport text,target_level text,target_connection uuid default null,target_configuration uuid default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.jobs;entry jsonb;
begin
 j:=app_private.model_job(job_id,lease);
 if target_transport not in ('generate_content:v1beta','interactions:v1beta:2026-05-20')
  or target_level not in ('minimal','low','medium','high') then raise exception 'INVALID_INPUT';end if;
 select value into entry from jsonb_array_elements(j.checkpoint->'model_routing'->'providers')
 where value->>'provider'=target_provider and value->>'model'=target_model and value->>'project_ref'=target_project
  and (value->>'connection_id')::uuid is not distinct from target_connection
  and (value->>'model_config_id')::uuid is not distinct from target_configuration;
 if entry is null then raise exception 'MODEL_IDENTITY_CHANGED';end if;
 if target_provider<>'gemini_free' then return false;end if;
 return not exists(select 1 from public.model_attempts a join public.provider_usage u on u.id=a.usage_id
  where a.workspace_id=j.workspace_id and a.provider=target_provider and a.model=target_model and a.project_ref=target_project
  and a.connection_id is not distinct from target_connection and a.model_config_id is not distinct from target_configuration
  and u.settings_revision=(entry->>'revision')::integer
  and a.execution_metadata->'reasoning_control'->>'transport'=target_transport
  and a.execution_metadata->'reasoning_control'->>'requested'=target_level
  and a.execution_metadata->'reasoning_control'->>'effective'=target_level
  and a.status='failed' and a.http_status in (400,422) and a.request_phase='generation'
  and a.provider_error_reason='reasoning_unsupported');
end $$;
revoke all on function public.model_reasoning_allowed(uuid,uuid,text,text,text,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.model_reasoning_allowed(uuid,uuid,text,text,text,text,text,uuid,uuid) to service_role;

do $$ declare definition text;fragment text;begin
 select pg_get_functiondef('public.record_model_request_metadata(bigint,uuid,jsonb)'::regprocedure) into definition;
 fragment := $old$'route_revision','profile','capabilities'$old$;
 if position(fragment in definition)=0 then raise exception 'Unexpected request metadata allowlist';end if;
 definition:=replace(definition,fragment,fragment||',''reasoning_control''');
 fragment := $old$perform app_private.validate_model_capabilities(metadata->'capabilities');$old$;
 if position(fragment in definition)=0 then raise exception 'Unexpected request capabilities validation';end if;
 definition:=replace(definition,fragment,fragment||$new$
 if metadata ? 'reasoning_control' then
  if jsonb_typeof(metadata->'reasoning_control') is distinct from 'object' then raise exception 'INVALID_INPUT';end if;
  perform app_private.check_keys(metadata->'reasoning_control',array['transport','requested','effective']);
  if coalesce(metadata->'reasoning_control'->>'transport','') not in ('generate_content:v1beta','interactions:v1beta:2026-05-20')
   or coalesce(metadata->'reasoning_control'->>'requested','') not in ('none','minimal','low','medium','high')
   or coalesce(metadata->'reasoning_control'->>'effective','') not in ('none','minimal','low','medium','high') then raise exception 'INVALID_INPUT';end if;
 end if;
 $new$);
 execute definition;
 -- Old accepted requests already have their original request metadata on the
 -- sending attempt. Return it for GET-only resumption without rewriting it.
 select pg_get_functiondef('public.resume_task_model_request_phase(uuid,uuid,text,jsonb,uuid,uuid,text)'::regprocedure) into definition;
 fragment := 'return to_jsonb(u);';
 if position(fragment in definition)=0 then raise exception 'Unexpected request resume metadata';end if;
 definition:=replace(definition,fragment,$new$return to_jsonb(u)||jsonb_build_object('execution_metadata',coalesce(u.execution_metadata,
  (select a.execution_metadata from public.model_attempts a where a.usage_id=u.id and a.job_id=j.id and a.sent
   and a.request_phase='generation' and a.execution_metadata is not null order by a.id limit 1)));$new$);
 execute definition;
end $$;
