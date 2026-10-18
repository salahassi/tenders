-- Preserve daily/free-provider budgets; allow bounded whole-notice classification after enrichment.
alter table public.provider_usage drop constraint provider_usage_reserved_input_check;
alter table public.provider_usage add constraint provider_usage_reserved_input_check check(reserved_input between 1 and 64000);

create or replace function public.reserve_model_call(
 job_id uuid,
 lease uuid,
 call_key text,
 input_hash text,
 input_tokens integer,
 output_tokens integer,
 manifest jsonb,
 target_provider text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; m public.model_settings; w uuid; u public.provider_usage;
 day date:=(now() at time zone 'Asia/Riyadh')::date; calls integer; inputs bigint; outputs bigint; settings jsonb; pool jsonb; automatic boolean;
begin
 if target_provider is null or target_provider not in (
  'gemini_free','qwen_free','groq_free','mistral_free','cloudflare_free'
 ) then raise exception 'INVALID_INPUT'; end if;
 select workspace_id into w from public.jobs where id=job_id; perform 1 from public.workspaces where id=w for update;
 select * into j from public.jobs where id=job_id;
 pool:=public.model_preflight(job_id, lease, manifest);
 if not exists(select 1 from jsonb_array_elements(pool->'providers') p where p->>'provider'=target_provider) then
  raise exception 'MODEL_IDENTITY_CHANGED';
 end if;
 automatic:=pool->>'routing_mode'='round_robin';
 if coalesce(automatic,false) then
  select * into m from jsonb_populate_record(null::public.model_settings,(select p from jsonb_array_elements(pool->'providers') p where p->>'provider'=target_provider));
 else
  select * into m from public.model_settings where workspace_id=w and provider=target_provider and enabled;
 end if;
 if m.provider is null then raise exception 'MODEL_NOT_CONFIGURED';end if;
 if input_tokens not between 1 and (case when j.type='classify_opportunity' then 64000 else 20000 end) or output_tokens not between 1 and 8192 then raise exception 'MODEL_CONTEXT_TOO_LARGE'; end if;
 if length(call_key) not between 1 and 200 or input_hash!~'^[0-9a-f]{64}$' then raise exception 'INVALID_INPUT'; end if;
 if exists(select 1 from public.provider_usage p where p.workspace_id=w and p.job_id=reserve_model_call.job_id and p.call_key=reserve_model_call.call_key) then
  raise exception 'MODEL_CALL_ALREADY_RESERVED';
 end if;
 -- Automatic routing retains unknown usage, but a different provider may take over.
 if exists(select 1 from public.provider_usage p where p.workspace_id=w and (
  p.state='reserved' or (p.state='unknown' and case when coalesce(automatic,false) then
   p.provider=target_provider and (p.job_id=j.id or p.input_hash=reserve_model_call.input_hash)
  else m.quota_mode<>'provider_managed' or m.provider<>'gemini_free' or p.provider<>m.provider or p.model<>m.model or p.job_id=j.id or p.input_hash=reserve_model_call.input_hash end)
 )) then raise exception 'USAGE_REVIEW_REQUIRED';end if;
 if exists(select 1 from public.provider_usage p where p.workspace_id=w and p.created_at>now()-interval '1 minute'
  and not (p.job_id=j.id and p.provider<>target_provider and
   (coalesce(automatic,false) or (p.state='settled' and p.error_code='PROVIDER_QUOTA_WAIT')))) then raise exception 'MODEL_RATE_WAIT';end if;
 select count(*),coalesce(sum(coalesce(actual_input,reserved_input)),0),coalesce(sum(coalesce(actual_output,reserved_output)),0)
 into calls,inputs,outputs from public.provider_usage where workspace_id=w and application_day=day;
 select workspaces.settings into settings from public.workspaces where id=w;
 if calls>=least(m.calls_per_day,coalesce((settings->>'daily_call_limit')::int,50))
  or inputs+input_tokens>least(m.input_per_day,coalesce((settings->>'input_token_limit')::int,250000))
  or outputs+output_tokens>least(m.output_per_day,coalesce((settings->>'output_token_limit')::int,50000)) then
  raise exception 'MODEL_DAILY_QUOTA_WAIT';
 end if;
 if m.quota_mode='verified_budget' and (select coalesce(sum(coalesce(actual_input,reserved_input)+coalesce(actual_output,reserved_output)),0)
     from public.provider_usage where workspace_id=w and provider=m.provider and model=m.model and created_at>=m.verified_at)
    +input_tokens+output_tokens>m.quota_remaining_tokens then
  raise exception 'PROVIDER_QUOTA_WAIT';
 end if;
 insert into public.provider_usage(
  workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,created_by
 ) values (
  w,job_id,lease,call_key,m.provider,m.model,input_hash,day,m.revision,input_tokens,output_tokens,j.created_by
 ) returning * into u;
 return to_jsonb(u);
end $$;


-- Read pending details before starting new model evaluations. Saved remote GET continuations retain first priority.
create or replace function public.claim_backend_job() returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;j public.jobs;s public.sources;operator_id uuid;
begin
 select id into w from public.workspaces limit 1;if w is null then return null;end if;
 perform 1 from public.workspaces where id=w for update;
 if exists(select 1 from public.restore_sessions where workspace_id=w and state='staging') then return null;end if;
 select m.user_id into operator_id from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=w and m.active and m.role='Owner' and a.status='active' order by m.created_at limit 1;
 update public.operations set last_heartbeat_at=now(),scheduler_enabled=coalesce((select enabled from app_private.dispatcher_settings where singleton),false) where workspace_id=w;
 -- A recorded provider ID makes a GET-only continuation safe after a worker crash.
 update public.jobs pending_job set status='retry_wait',error_code='MODEL_IN_PROGRESS',lease_token=null,lease_until=null,next_attempt_at=now(),revision=pending_job.revision+1,updated_at=now()
 where pending_job.workspace_id=w and pending_job.status='running' and pending_job.lease_until<now() and not pending_job.cancel_requested and exists(select 1 from public.provider_usage u where u.job_id=pending_job.id and u.remote_request_id is not null and u.remote_deadline>now());
 update public.jobs set status=case when cancel_requested then 'canceled' when type like 'source_%' and attempts<4 then 'retry_wait' else 'blocked' end,error_code=case when type like 'source_%' then 'COLLECTION_LEASE_EXPIRED' else 'LEASE_EXPIRED_REVIEW_REQUIRED' end,lease_token=null,lease_until=null,next_attempt_at=now()+interval '1 minute',revision=revision+1,updated_at=now() where workspace_id=w and status='running' and lease_until<now();
 -- Pausing/reconfiguring a source invalidates queued work immediately. A
 -- resumed source gets a fresh revision-bound job, rather than waiting behind
 -- an obsolete job until the next six-hour poll.
 with stale as (
  update public.jobs q set status='canceled',error_code='SOURCE_CONFIGURATION_CHANGED',cancel_requested=true,revision=q.revision+1,updated_at=now()
  where q.workspace_id=w and q.type in ('source_collect','source_candidates') and (q.status in ('queued','retry_wait','quota_wait') or (q.status='blocked' and q.error_code='STALE_INPUT'))
   and exists(select 1 from public.sources src where src.id=q.entity_id and src.workspace_id=w and (src.approval<>'approved' or src.revision::text<>q.input_hash))
  returning q.entity_id
 ) update public.sources src set next_due=now() where src.workspace_id=w and src.approval='approved' and exists(select 1 from stale where stale.entity_id=src.id);
 for s in select * from public.sources where workspace_id=w and approval='approved' and kind<>'manual' and not adapter_required and next_due<=now() and operator_id is not null order by next_due,id loop
  exit when (select count(*) from public.jobs where workspace_id=w and status in ('queued','running','retry_wait','quota_wait','blocked'))>=500;
  if not exists(select 1 from public.jobs where workspace_id=w and entity_id=s.id and type='source_collect' and status in ('queued','running','retry_wait')) then
   insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by) values(w,'source_collect',s.id,s.revision::text,'queued',operator_id);
  end if;
  update public.sources set next_due=now()+make_interval(hours=>s.poll_interval_hours) where id=s.id;
 end loop;
 if exists(select 1 from public.jobs where workspace_id=w and status='running') then return null; end if;
 select * into j from public.jobs where workspace_id=w and status in ('queued','retry_wait','quota_wait') and next_attempt_at<=now() order by case when error_code='MODEL_IN_PROGRESS' then 0 else 1 end,
 case when type='classify_opportunity' and exists(select 1 from public.generation_plans p join public.opportunities o on o.id=p.opportunity_id join public.sources src on src.id=o.source_id where p.id=public.jobs.entity_id and src.adapter_config ? 'official_listing' and (coalesce(o.notice_evidence->>'version','')<>'1' or o.notice_evidence->>'notice_hash' is distinct from app_private.content_record(o.workspace_id,'notice',o.id)->>'content_hash' or (o.notice_evidence->>'fetched_at')::timestamptz<src.last_success_at)) then 0 else 1 end,case when created_at<now()-interval '1 hour' then 0 when type in ('plan_proposal','analyze_chunk','consolidate_requirements','draft_section','plan_commercial','review_proposal','advance_plan') then 1 when type in ('source_collect','source_candidates') then 2 else 3 end,created_at,id for update skip locked limit 1;
 if j.id is null then return null;end if;
 if j.cancel_requested then update public.jobs set status='canceled',revision=revision+1 where id=j.id;return null;end if;
 update public.jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '180 seconds',revision=revision+1,updated_at=now() where id=j.id returning * into j;
 return to_jsonb(j);
end $$;

update public.opportunities o set assessment_pending=true from public.sources s where s.id=o.source_id and s.adapter_config ? 'official_listing' and not o.archived and coalesce(o.notice_evidence->>'version','')<>'1';
