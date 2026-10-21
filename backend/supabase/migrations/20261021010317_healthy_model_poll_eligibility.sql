-- Healthy accepted requests can be polled by the next minute's scheduler tick.
-- Keep the existing error/Retry-After deferral policy unchanged. A distinct RPC
-- avoids overload ambiguity and older workers retain their original behavior.
create function public.defer_pending_model_request(job_id uuid,lease uuid,reservation uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 -- Reuse the lease, identity, accepted request and deadline checks. Both writes
 -- are one transaction under the original workspace/row locks.
 perform public.defer_model_request(job_id,lease,reservation,null);
 update public.jobs set next_attempt_at=now()+interval '30 seconds'
 where id=job_id;
end $$;
revoke all on function public.defer_pending_model_request(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.defer_pending_model_request(uuid,uuid,uuid) to service_role;
