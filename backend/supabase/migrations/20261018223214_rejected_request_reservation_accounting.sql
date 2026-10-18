-- Internal reservation accounting, not a claim of measured zero usage.
-- Release only a proven initial generation rejection. Poll failures, accepted
-- remote requests, missing telemetry and uncertain usage retain their reserves.
create function app_private.generation_reservation_rejected(u public.provider_usage)
returns boolean language sql stable security invoker set search_path='' as $$
 select coalesce(u.state='settled' and u.error_code='PROVIDER_QUOTA_WAIT' and u.remote_request_id is null and exists(
  select 1 from public.model_attempts a where a.usage_id=u.id and a.workspace_id=u.workspace_id and a.job_id=u.job_id and a.provider=u.provider
   and a.sent and a.status='failed' and a.request_phase='generation' and a.http_status=429 and a.result_code=u.error_code
 ),false)
$$;
revoke all on function app_private.generation_reservation_rejected(public.provider_usage) from public,anon,authenticated,service_role;

-- Keep the established authority/budget functions and their grants. Guard the
-- exact source before changing just token totals; calls still count as attempts.
do $$ declare r record;definition text;body text;begin
 for r in select * from (values
  ('public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text)','6399e39831598191e0ed1d71bb88c849422ab893a1912569f8cba604b3401405'),
  ('public.workspace_status()','47d0a8e13c79532a41fd48acbf2b12e5818d2446650c76f01d47090bf986a47c')
 ) as expected(signature,body_hash) loop
  select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc where oid=r.signature::regprocedure;
  if encode(sha256(convert_to(body,'UTF8')),'hex')<>r.body_hash then raise exception 'Unexpected model accounting function: %',r.signature;end if;
  definition:=replace(definition,'coalesce(actual_input,reserved_input)','coalesce(actual_input,case when app_private.generation_reservation_rejected(provider_usage) then 0 else reserved_input end)');
  definition:=replace(definition,'coalesce(actual_output,reserved_output)','coalesce(actual_output,case when app_private.generation_reservation_rejected(provider_usage) then 0 else reserved_output end)');
  if r.signature='public.workspace_status()' then
   definition:=replace(definition,'and (actual_input is null or actual_output is null)','and (actual_input is null or actual_output is null) and not app_private.generation_reservation_rejected(provider_usage)');
  end if;
  execute definition;
 end loop;
end $$;

-- Recheck affected waiting jobs under their existing budgets and permissions.
-- No usage values, call counts, evidence, provider order or lease is reset.
update public.jobs j set next_attempt_at=now(),revision=revision+1,updated_at=now()
where j.status='quota_wait' and j.error_code='MODEL_DAILY_QUOTA_WAIT' and not j.cancel_requested
 and (j.type<>'classify_opportunity' or exists(select 1 from public.generation_plans p join public.opportunity_discovery d on d.id=p.opportunity_id and d.workspace_id=p.workspace_id where p.id=j.entity_id and p.workspace_id=j.workspace_id and not d.is_expired))
 and exists(select 1 from public.provider_usage u where u.workspace_id=j.workspace_id and u.application_day=(now() at time zone 'Asia/Riyadh')::date and app_private.generation_reservation_rejected(u));
