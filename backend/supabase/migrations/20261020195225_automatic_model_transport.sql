-- Observed transport support is scoped to the actual account/model. Reuse the
-- attempt ledger rather than inventing model-name rules or a second config store.
create index model_attempts_background_rejection_idx
 on public.model_attempts(workspace_id,provider,model,project_ref,started_at desc)
 where status='failed' and http_status in (400,422) and provider_error_reason='background_unsupported';

create function public.model_background_allowed(job_id uuid,lease uuid,target_provider text,target_model text,
 target_project text,target_connection uuid default null,target_configuration uuid default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.jobs; entry jsonb; observed_after timestamptz;
begin
 j:=app_private.model_job(job_id,lease);
 select value into entry from jsonb_array_elements(j.checkpoint->'model_routing'->'providers')
 where value->>'provider'=target_provider and value->>'model'=target_model and value->>'project_ref'=target_project
  and (value->>'connection_id')::uuid is not distinct from target_connection
  and (value->>'model_config_id')::uuid is not distinct from target_configuration;
 if entry is null then raise exception 'MODEL_IDENTITY_CHANGED';end if;
 if target_provider not in ('openai','gemini_free') then return false;end if;
 -- An edit affects newly frozen configurations; already accepted work keeps its
 -- own snapshot. Recheck support after one day even if the configuration is unchanged.
 observed_after:=greatest(now()-interval '1 day', (entry->>'verified_at')::timestamptz);
 return not exists(select 1 from public.model_attempts a where a.workspace_id=j.workspace_id
  and a.provider=target_provider and a.model=target_model and a.project_ref=target_project
  and a.connection_id is not distinct from target_connection and a.model_config_id is not distinct from target_configuration
  and a.started_at>=observed_after and a.status='failed' and a.http_status in (400,422)
  and a.provider_error_reason='background_unsupported');
end $$;
revoke all on function public.model_background_allowed(uuid,uuid,text,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.model_background_allowed(uuid,uuid,text,text,text,uuid,uuid) to service_role;
