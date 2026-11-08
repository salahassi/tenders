-- Whole-plan resume predates task-model routing. Do not let unrelated old
-- unknown usage turn the disabled legacy router into a global execution lock.
-- This is admission only: reservation retains account/model/input/phase guards.
create function app_private.assert_generation_retry_usage(p public.generation_plans,operation_key text)
returns void language plpgsql set search_path='' as $$
declare j public.jobs;settings public.model_execution_settings;modern_admission boolean;model_step boolean:=false;begin
 if exists(select 1 from public.provider_usage u where u.workspace_id=p.workspace_id and u.state='reserved') then raise exception 'USAGE_REVIEW_REQUIRED';end if;
 if not exists(select 1 from public.provider_usage u where u.workspace_id=p.workspace_id and u.state='unknown')
  or exists(select 1 from public.model_routing where workspace_id=p.workspace_id and enabled) then return;end if;
 select * into settings from public.model_execution_settings where workspace_id=p.workspace_id;
 modern_admission:=coalesce(settings.enabled,false) and (settings.admitted_after is null or p.created_at>=settings.admitted_after);
 for j in select jobs.* from public.jobs jobs join public.generation_steps step on step.job_id=jobs.id and step.workspace_id=jobs.workspace_id
  where jobs.workspace_id=p.workspace_id and jobs.entity_id=p.id and step.plan_id=p.id and step.status='queued'
   and app_private.queue_work_class(jobs)<>'local'
 loop
  model_step:=true;
  -- Existing catalog operations retain their frozen route even when settings
  -- later change. Fresh operations must satisfy the actual router's cutoff and
  -- must not silently reinterpret an old manual checkpoint or paid request.
  if j.checkpoint->>'model_executor'='2' and j.checkpoint#>>'{model_routing,mode}'='round_robin' then
   if exists(select 1 from public.provider_usage u where u.workspace_id=p.workspace_id and u.job_id=j.id
    and app_private.model_usage_blocks_recovery(j,u,now())) then raise exception 'USAGE_REVIEW_REQUIRED';end if;
   perform app_private.record_model_usage_recovery(j,'generation_retry',operation_key);
  elsif not(modern_admission
   and not(j.checkpoint ? 'model_routing')
   and not exists(select 1 from public.provider_usage u where u.workspace_id=p.workspace_id and u.job_id=j.id)) then
   raise exception 'USAGE_REVIEW_REQUIRED';
  end if;
 end loop;
 -- An isolated stage transition can enqueue future model work. It must not
 -- turn an otherwise manual/obsolete plan into an automatic continuation.
 if not model_step and not modern_admission then raise exception 'USAGE_REVIEW_REQUIRED';end if;
end $$;
do $acl$ declare role_name text;begin
 revoke all on function app_private.assert_generation_retry_usage(public.generation_plans,text) from public;
 foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on function app_private.assert_generation_retry_usage(public.generation_plans,text) from %I',role_name);end if;
 end loop;
end $acl$;

-- Replace only the old admission predicate, beneath all canonical membership,
-- revision, current-contract, evidence, source and idempotency wrappers.
do $patch$ declare definition text;old_guard text;begin
 select pg_get_functiondef('app_private.generation_command(text,jsonb,text)'::regprocedure) into definition;
 old_guard:=$old$if exists(select 1 from public.provider_usage where workspace_id=w and (
  state='reserved' or (state='unknown' and not exists(select 1 from public.model_routing where workspace_id=w and enabled))
 )) then raise exception 'USAGE_REVIEW_REQUIRED';end if;$old$;
 if position(old_guard in definition)=0 then raise exception 'GENERATION_RETRY_USAGE_GUARD_CHANGED';end if;
 execute replace(definition,old_guard,'perform app_private.assert_generation_retry_usage(p,idempotency_key);');
end $patch$;
