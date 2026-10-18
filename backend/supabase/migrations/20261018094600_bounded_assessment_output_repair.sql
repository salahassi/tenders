-- Preserve one bounded repair for measured invalid/truncated output after provider failover.
create or replace function public.fail_generation(job_id uuid,lease uuid,error_code text,retry_after timestamptz default null,split_inputs jsonb default null) returns void language plpgsql security definer set search_path='' as $$
declare w uuid;j public.jobs;p public.generation_plans;s public.generation_steps;state text:='blocked';next_time timestamptz:='infinity';item jsonb;
begin
 select workspace_id into w from public.jobs where id=job_id;perform 1 from public.workspaces where id=w for update;select * into j from public.jobs where id=job_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() then raise exception 'STALE_LEASE';end if;
 select * into s from public.generation_steps where generation_steps.job_id=j.id;select * into p from public.generation_plans where id=s.plan_id;
 if j.cancel_requested or p.status='canceled' then state:='canceled';
 elsif split_inputs is not null and s.depth<8 and jsonb_array_length(split_inputs)=2 and error_code in ('MODEL_CONTEXT_TOO_LARGE','MODEL_OUTPUT_TRUNCATED') then
 if (select count(*) from public.generation_steps where plan_id=p.id)+2>300 then error_code:='PLAN_JOB_CAP_REACHED';else
 for item in select value from jsonb_array_elements(split_inputs) loop perform app_private.enqueue_generation(p,s.task,item,s.depth+1);end loop;
 update public.generation_steps set status='split',revision=revision+1,updated_at=now() where id=s.id;state:='succeeded';end if;
 elsif error_code in ('MODEL_OUTPUT_INVALID','MODEL_OUTPUT_TRUNCATED','EVIDENCE_REFERENCE_INVALID','MODEL_COVERAGE_INCOMPLETE','UNSUPPORTED_COMPANY_CLAIM') and s.repair_count=0 then
 update public.generation_steps set repair_count=1,revision=revision+1 where id=s.id;state:='retry_wait';next_time:=now()+interval '1 minute';
 elsif error_code in ('MODEL_RATE_WAIT','MODEL_DAILY_QUOTA_WAIT','PROVIDER_QUOTA_WAIT','MODEL_ROUND_EXHAUSTED') then
 state:='quota_wait';next_time:=case when error_code='MODEL_RATE_WAIT' then now()+interval '1 minute' when error_code='MODEL_DAILY_QUOTA_WAIT' then ((now() at time zone 'Asia/Riyadh')::date+1)::timestamp at time zone 'Asia/Riyadh' else
  case when retry_after is not null and isfinite(retry_after)
   then greatest(now()+interval '1 minute',least(retry_after,now()+interval '1 day'))
   else now()+make_interval(secs=>least(3600,60*power(2,least(greatest(j.attempts-1,0),6)))::int)
  end end;
 end if;
 update public.jobs set status=state,error_code=case when state='succeeded' then null else fail_generation.error_code end,next_attempt_at=next_time,lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
 update public.generation_plans set status=case when state='canceled' then 'canceled' when state='blocked' then 'blocked' else 'running' end,error_code=case when state='succeeded' then null else fail_generation.error_code end,revision=revision+1,updated_at=now() where id=p.id;
 if state='blocked' and p.id is not null then perform app_private.notify_members(w,'plan-blocked:'||p.id||':'||error_code,'Generation needs attention',error_code,p.opportunity_id,p.created_by);end if;
end $$;
