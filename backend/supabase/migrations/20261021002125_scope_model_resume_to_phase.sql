-- A request belongs to one durable graph phase, not every operation in its job.
-- Changed input within the SAME phase still fails closed; unresolved requests
-- from earlier phases remain in the usage ledger for GET-only reconciliation.
create function public.resume_task_model_request_phase(job_id uuid,lease uuid,input_hash text,manifest jsonb,target_model uuid,target_connection uuid,request_prefix text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;pool jsonb;entry jsonb;u public.provider_usage;
begin
 j:=app_private.model_job(job_id,lease);pool:=public.task_model_preflight(job_id,lease,manifest);
 if request_prefix is null or length(request_prefix) not between 1 and 400 then raise exception 'INVALID_INPUT';end if;
 select value into entry from jsonb_array_elements(pool->'providers') where value->>'model_config_id'=target_model::text and value->>'connection_id'=target_connection::text;
 if entry is null then raise exception 'MODEL_IDENTITY_CHANGED';end if;
 select * into u from public.provider_usage p where p.job_id=j.id and p.connection_id=target_connection and p.model_config_id=target_model and p.remote_request_id is not null
  and regexp_replace(p.call_key, ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$', '')=request_prefix
  and p.error_code is distinct from 'PROVIDER_BACKGROUND_FAILED'
  order by (p.state='reserved') desc,(p.state='unknown') desc,(p.input_hash=resume_task_model_request_phase.input_hash) desc,p.created_at desc limit 1 for update;
 if u.id is null then return null;end if;
 if u.state='settled' and (u.error_code='PROVIDER_REQUEST_REJECTED' or u.input_hash<>resume_task_model_request_phase.input_hash) then return null;end if;
 if u.input_hash<>resume_task_model_request_phase.input_hash or u.model<>entry->>'model' or u.provider<>entry->>'provider' or u.remote_project_ref<>entry->>'project_ref' then raise exception 'MODEL_IDENTITY_CHANGED';end if;
 update public.provider_usage set lease_token=lease,revision=revision+1,updated_at=now() where id=u.id returning * into u;
 return to_jsonb(u);
end $$;
revoke all on function public.resume_task_model_request_phase(uuid,uuid,text,jsonb,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.resume_task_model_request_phase(uuid,uuid,text,jsonb,uuid,uuid,text) to service_role;

-- A provider's explicit terminal failure is different from an ambiguous GET
-- rejection. Keep unreported tokens unknown, but do not poll it forever.
do $$ declare definition text;begin
 select pg_get_functiondef('public.claim_abandoned_model_request()'::regprocedure) into definition;
 definition:=replace(definition,'p.state=''unknown''','p.state=''unknown'' and p.error_code is distinct from ''PROVIDER_BACKGROUND_FAILED''');
 execute definition;
 select pg_get_functiondef('public.model_background_allowed(uuid,uuid,text,text,text,uuid,uuid)'::regprocedure) into definition;
 definition:=replace(definition,'a.provider_error_reason=''background_unsupported'');',
  $replacement$a.provider_error_reason='background_unsupported') and not exists (
   select 1 from public.provider_usage u where u.workspace_id=j.workspace_id and u.provider=target_provider
   and u.model=target_model and u.remote_project_ref=target_project
   and u.connection_id is not distinct from target_connection and u.model_config_id is not distinct from target_configuration
   and u.updated_at>=observed_after and u.error_code='PROVIDER_BACKGROUND_FAILED');$replacement$);
 execute definition;
end $$;
