-- Only an outstanding accepted request needs poll-first scheduling. Graph
-- checkpoints and saved failover rounds also use MODEL_IN_PROGRESS but have no
-- remote work to settle; they must yield to the existing source/interactive
-- fairness rules between requests. Preserve leases, locks and retry eligibility.
do $patch$ declare definition text; marker text; begin
 select pg_get_functiondef('public.claim_backend_job()'::regprocedure) into definition;
 marker := 'order by case when error_code=''MODEL_IN_PROGRESS'' then 0 else 1 end,';
 if position(marker in definition)=0 then raise exception 'Claim ordering changed';end if;
 execute replace(definition,marker,$priority$order by case when error_code='MODEL_IN_PROGRESS' and exists(
  select 1 from public.provider_usage pending
  where pending.workspace_id=public.jobs.workspace_id and pending.job_id=public.jobs.id
   and pending.state='reserved' and pending.remote_request_id is not null
 ) then 0 else 1 end,$priority$);
end $patch$;
