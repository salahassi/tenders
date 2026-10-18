-- Reconcile existing background requests after evidence refresh cancels a plan.
-- The worker only retrieves measured usage; canceled outputs never become assessments.
alter table public.provider_usage add column reconciliation_after timestamptz;

create function public.claim_abandoned_model_request()
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.provider_usage;
begin
 select p.* into u from public.provider_usage p join public.jobs j on j.id=p.job_id
 where p.provider='gemini_free' and p.state='unknown' and p.remote_request_id is not null
 and p.remote_deadline>now() and j.status in ('canceled','blocked','failed')
 and (p.reconciliation_after is null or p.reconciliation_after<=now())
 order by p.created_at,p.id for update of p skip locked limit 1;
 if u.id is null then return null;end if;
 update public.provider_usage set reconciliation_after=now()+interval '5 minutes',revision=revision+1,updated_at=now() where id=u.id;
 return jsonb_build_object('id',u.id,'model',u.model,'remote_request_id',u.remote_request_id);
end $$;
revoke all on function public.claim_abandoned_model_request() from public,anon,authenticated;
grant execute on function public.claim_abandoned_model_request() to service_role;
