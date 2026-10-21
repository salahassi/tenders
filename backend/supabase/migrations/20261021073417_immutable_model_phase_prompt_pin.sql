-- Prompt upgrades must never change the identity of an already-started phase.
-- Include accepted, unknown and settled calls: a worker can crash after usage
-- settlement but before saving its result. A saved round may have no usage yet.
create function public.model_phase_started(job_id uuid,lease uuid,request_prefix text,legacy_input_hash text)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.jobs;
begin
 j:=app_private.model_job(job_id,lease);
 if request_prefix is null or length(request_prefix) not between 1 and 400
  or legacy_input_hash is null or legacy_input_hash !~ '^[a-f0-9]{64}$' then raise exception 'INVALID_INPUT';end if;
 return coalesce(j.checkpoint->'model_round'->>'input_hash'=legacy_input_hash,false)
  or exists(select 1 from public.provider_usage u where u.workspace_id=j.workspace_id and u.job_id=j.id
   and regexp_replace(u.call_key, ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$', '')=request_prefix);
end $$;
revoke all on function public.model_phase_started(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.model_phase_started(uuid,uuid,text,text) to service_role;
