-- A local model-capacity wait must not permanently block source collection.
do $patch$ declare definition text; marker text; begin
 select pg_get_functiondef('public.fail_collection_before_automation(uuid,uuid,text,timestamptz)'::regprocedure) into definition;
 marker := 'when error_code=''SOURCE_TEMPORARY_FAILURE'' then ''retry_wait''';
 if position(marker in definition)=0 then raise exception 'Collection failure state changed';end if;
 execute replace(definition,marker,'when error_code in (''SOURCE_TEMPORARY_FAILURE'',''MODEL_RATE_WAIT'') then ''retry_wait''');
end $patch$;

do $patch$ declare definition text; marker text; begin
 select pg_get_functiondef('app_private.recover_processing_job(uuid,timestamptz)'::regprocedure) into definition;
 marker := 'if j.error_code in (''MODEL_IN_PROGRESS'',''MODEL_RATE_WAIT'') then return;end if;';
 if position(marker in definition)=0 then raise exception 'Processing recovery guard changed';end if;
 execute replace(definition,marker,$guard$
 if j.error_code='MODEL_IN_PROGRESS' then return;end if;
 if j.error_code='MODEL_RATE_WAIT' then
  next_time:=greatest(now()+interval '1 minute',case when provider_retry is not null and isfinite(provider_retry) then provider_retry else now() end);
  update public.jobs set status='retry_wait',next_attempt_at=next_time,lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
  if j.type in ('source_collect','source_candidates') then
   update public.sources set health='unavailable',next_due=next_time,updated_at=now() where id=j.entity_id and workspace_id=j.workspace_id;
  end if;
  return;
 end if;
 $guard$);
end $patch$;

-- Repair only inactive, non-canceled local-capacity failures. Do not clear usage,
-- content, attempts or provider waits, and do not emit an outage email for them.
do $repair$ declare j public.jobs; begin
 for j in select * from public.jobs where status='blocked' and error_code='MODEL_RATE_WAIT' and not cancel_requested and lease_token is null loop
  perform app_private.recover_processing_job(j.id);
  insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,reason,request_id)
  values(j.workspace_id,j.created_by,'automation.capacity_recovered','job',j.id,'Restored automatic retry for a local model-capacity wait; retained evidence, attempts and usage.',gen_random_uuid());
 end loop;
end $repair$;
