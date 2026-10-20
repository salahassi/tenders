-- An occupied workspace request slot is a short local wait, not a provider outage.
do $patch$ declare definition text; marker text; begin
 select pg_get_functiondef('public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)'::regprocedure) into definition;
 marker := 'if exists(select 1 from public.provider_usage p where p.workspace_id=j.workspace_id and (p.state=''reserved'' or';
 if position(marker in definition)=0 then raise exception 'Task reservation guard changed';end if;
 execute replace(definition,marker,$guard$if exists(select 1 from public.provider_usage p where p.workspace_id=j.workspace_id and p.state='reserved') then raise exception 'MODEL_RATE_WAIT';end if;
 $guard$||marker);
end $patch$;

-- Wake only local-only capacity waits; never shorten a provider's Retry-After.
update public.jobs j set next_attempt_at=now()+interval '1 minute',error_code='MODEL_RATE_WAIT',revision=revision+1,updated_at=now()
where j.status in ('retry_wait','quota_wait') and j.error_code='MODEL_ROUND_EXHAUSTED'
and exists(select 1 from public.model_attempts a where a.job_id=j.id
 and a.id=(select max(id) from public.model_attempts where job_id=j.id)
 and a.result_code='USAGE_REVIEW_REQUIRED'
 and not exists(select 1 from public.model_attempts b where b.job_id=j.id and b.lease_token=a.lease_token and b.http_status is not null));
