-- Detect completed accepted requests promptly, then back off while still pending.
-- Only this healthy-poll entrypoint changes; errors and Retry-After retain the
-- existing defer_model_request policy. No request, lease, usage or budget resets.
do $patch$ declare body text;definition text;expected text;replacement text;begin
 select p.prosrc,pg_get_functiondef(p.oid) into body,definition from pg_proc p
 where p.oid='public.defer_pending_model_request(uuid,uuid,uuid)'::regprocedure;
 expected:=$old$
begin
 -- Reuse the lease, identity, accepted request and deadline checks. Both writes
 -- are one transaction under the original workspace/row locks.
 perform public.defer_model_request(job_id,lease,reservation,null);
 update public.jobs set next_attempt_at=now()+interval '30 seconds'
 where id=job_id;
end $old$;
 if body is distinct from expected then raise exception 'HEALTHY_POLL_POLICY_CHANGED';end if;
 replacement:=$new$
declare pending public.provider_usage;latest public.model_attempts;completed_polls integer;delay_seconds integer:=30;
begin
 -- Keep the existing accepted-request identity, lease, cancellation and remote
 -- deadline checks under the same workspace and reservation locks.
 perform public.defer_model_request(job_id,lease,reservation,null);
 select * into pending from public.provider_usage where id=reservation;
 select * into latest from public.model_attempts a
 where a.workspace_id=pending.workspace_id and a.job_id=defer_pending_model_request.job_id and a.lease_token=lease
 order by a.id desc limit 1;
 -- Historical clients without an exact healthy receipt retain the prior cadence.
 -- A generation receipt is healthy too, but it is not a completed poll.
 if latest.usage_id=reservation and latest.provider=pending.provider and latest.model=pending.model
  and latest.connection_id is not distinct from pending.connection_id
  and latest.model_config_id is not distinct from pending.model_config_id
  and latest.status='waiting' and latest.result_code='MODEL_IN_PROGRESS'
  and latest.http_status=200 and latest.request_phase in ('generation','poll')
  and latest.retry_after is null and latest.finished_at is not null then
  select count(*) into completed_polls from (
   select 1 from public.model_attempts a
   where a.workspace_id=pending.workspace_id and a.job_id=pending.job_id and a.usage_id=reservation
    and a.provider=pending.provider and a.model=pending.model
    and a.connection_id is not distinct from pending.connection_id
    and a.model_config_id is not distinct from pending.model_config_id
    and a.request_phase='poll' and a.status='waiting' and a.result_code='MODEL_IN_PROGRESS'
    and a.http_status=200 and a.retry_after is null and a.finished_at is not null
   limit 3
  ) completed;
  delay_seconds:=case completed_polls when 0 then 5 when 1 then 10 when 2 then 15 else 30 end;
 end if;
 -- A shorter wake cannot extend the accepted request's original remote lifetime.
 update public.jobs set next_attempt_at=least(now()+make_interval(secs=>delay_seconds),pending.remote_deadline)
 where id=job_id;
end $new$;
 execute replace(definition,body,replacement);
end $patch$;
