-- A rejected GET does not establish the cost of an already accepted generation.
do $patch$ declare definition text; marker text; begin
 select pg_get_functiondef('public.settle_model_call(uuid,bigint,bigint,bigint,text)'::regprocedure) into definition;
 marker := 'state=case';
 if position(marker in definition)=0 then raise exception 'Settlement definition changed';end if;
 execute replace(definition,marker,marker || $case$
   when u.remote_request_id is not null and (settle_model_call.actual_input is null or settle_model_call.actual_output is null) then 'unknown'
 $case$);
end $patch$;

-- Correct only accepted requests with unmeasured usage; retain all IDs/errors.
update public.provider_usage set state='unknown',revision=revision+1,updated_at=now()
where state='settled' and remote_request_id is not null
and (actual_input is null or actual_output is null);

-- Reconcile a failed poll even if its job has moved to another provider.
-- This still retrieves at most one existing request per tick, throttled to 5 min.
do $patch$ declare definition text; marker text; begin
 select pg_get_functiondef('public.claim_abandoned_model_request()'::regprocedure) into definition;
 marker := 'j.status in (''canceled'',''blocked'',''failed'')';
 if position(marker in definition)=0 then raise exception 'Reconciliation definition changed';end if;
 definition:=replace(definition,marker,$condition$(j.status in ('canceled','blocked','failed') or (j.status<>'running' and p.error_code in ('PROVIDER_REQUEST_INVALID','PROVIDER_AUTH_FAILED','PROVIDER_QUOTA_WAIT','MODEL_NETWORK_UNCERTAIN')))$condition$);
 definition:=replace(definition,'''id'',u.id,','''id'',u.id,''job_status'',(select status from public.jobs where id=u.job_id),');
 execute definition;
end $patch$;

-- Failed retrieval is a failed attempt, although it sends no new generation.
do $patch$ declare definition text; marker text; begin
 select pg_get_functiondef('public.finish_model_attempt(bigint,uuid,text,boolean,uuid,jsonb)'::regprocedure) into definition;
 marker := 'when not finish_model_attempt.sent then ''skipped''';
 if position(marker in definition)=0 then raise exception 'Attempt outcome definition changed';end if;
 execute replace(definition,marker,'when metadata->>''request_phase''=''poll'' then ''failed'' '||marker);
end $patch$;
update public.model_attempts set status='failed' where status='skipped' and request_phase='poll';
