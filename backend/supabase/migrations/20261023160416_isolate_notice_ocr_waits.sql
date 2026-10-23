-- Waiting for native OCR must not consume the main assessment worker's lease.
-- Check exact current receipts so changed permissions/evidence still reach
-- normal recovery. Cancellation is never held behind OCR.
create function app_private.job_waits_for_notice_ocr(j public.jobs)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(j.type='classify_opportunity' and not j.cancel_requested
  and j.status in ('queued','retry_wait','quota_wait')
  and j.error_code in ('NOTICE_OCR_PENDING','SOURCE_OCR_PENDING')
  and exists(select 1 from app_private.public_notice_ocr_requests r
   where r.workspace_id=j.workspace_id and r.job_id=j.id
    and r.status in ('queued','running') and app_private.notice_ocr_current(r)),false);
$$;
revoke all on function app_private.job_waits_for_notice_ocr(public.jobs) from public,anon,authenticated,service_role;

do $patch$ declare definition text;marker text;begin
 definition:=pg_get_functiondef('app_private.next_fair_job(uuid,boolean)'::regprocedure);
 marker:='and q.next_attempt_at<=now()';
 if position(marker in definition)=0 then raise exception 'Fair queue due guard changed';end if;
 execute replace(definition,marker,marker||E'\n  and not app_private.job_waits_for_notice_ocr(q)');
 definition:=pg_get_functiondef('app_private.wake_backend_queue_checked(uuid,uuid,bigint)'::regprocedure);
 marker:='and q.next_attempt_at<=now()';
 if position(marker in definition)=0 then raise exception 'Queue wake due guard changed';end if;
 execute replace(definition,marker,marker||E'\n  and not app_private.job_waits_for_notice_ocr(q)');
end $patch$;
