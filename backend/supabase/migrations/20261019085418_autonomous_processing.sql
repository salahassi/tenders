-- Automatic processing follows provider responses, not application token budgets.
-- Historical/manual policies and measured usage remain available during rollout.
alter table public.jobs add column failure_count integer not null default 0 check(failure_count>=0);
do $patch$ declare body text;definition text;begin
 select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc where oid='public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex')<>'aced166c2c13ac1924d4711a47f646564fd26c0b4bbc39fd918788c655e2af65' then raise exception 'Unexpected automation function: public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text)';end if;
 execute replace(definition,body,$new$
declare j public.jobs; m public.model_settings; w uuid; u public.provider_usage;
 day date:=(now() at time zone 'Asia/Riyadh')::date; calls integer; inputs bigint; outputs bigint; settings jsonb; pool jsonb; automatic boolean;
begin
 if target_provider is null or target_provider not in (
  'gemini_free','qwen_free','groq_free','mistral_free','cloudflare_free','zai_free','openai','anthropic'
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
   p.provider=target_provider and (p.job_id=j.id or p.input_hash=reserve_model_call.input_hash) and (p.created_at>now()-interval '15 minutes' or p.remote_deadline>now())
  else m.quota_mode<>'provider_managed' or m.provider<>'gemini_free' or p.provider<>m.provider or p.model<>m.model or p.job_id=j.id or p.input_hash=reserve_model_call.input_hash end)
 )) then raise exception 'USAGE_REVIEW_REQUIRED';end if;
 if not coalesce(automatic,false) and exists(select 1 from public.provider_usage p where p.workspace_id=w and p.created_at>now()-interval '1 minute'
  and not (p.job_id=j.id and p.provider<>target_provider and
   (coalesce(automatic,false) or (p.state='settled' and p.error_code='PROVIDER_QUOTA_WAIT')))) then raise exception 'MODEL_RATE_WAIT';end if;
 if not coalesce(automatic,false) then
 select count(*),coalesce(sum(coalesce(actual_input,case when app_private.generation_reservation_rejected(provider_usage) then 0 else reserved_input end)),0),coalesce(sum(coalesce(actual_output,case when app_private.generation_reservation_rejected(provider_usage) then 0 else reserved_output end)),0)
 into calls,inputs,outputs from public.provider_usage where workspace_id=w and application_day=day;
 select workspaces.settings into settings from public.workspaces where id=w;
 if calls>=least(m.calls_per_day,coalesce((settings->>'daily_call_limit')::int,50))
  or inputs+input_tokens>least(m.input_per_day,coalesce((settings->>'input_token_limit')::int,250000))
  or outputs+output_tokens>least(m.output_per_day,coalesce((settings->>'output_token_limit')::int,50000)) then
  raise exception 'MODEL_DAILY_QUOTA_WAIT';
 end if;
 if m.quota_mode='verified_budget' and (select coalesce(sum(coalesce(actual_input,case when app_private.generation_reservation_rejected(provider_usage) then 0 else reserved_input end)+coalesce(actual_output,case when app_private.generation_reservation_rejected(provider_usage) then 0 else reserved_output end)),0)
     from public.provider_usage where workspace_id=w and provider=m.provider and model=m.model and created_at>=m.verified_at)
    +input_tokens+output_tokens>m.quota_remaining_tokens then
  raise exception 'PROVIDER_QUOTA_WAIT';
 end if;
 end if;
 insert into public.provider_usage(
  workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,created_by
 ) values (
  w,job_id,lease,call_key,m.provider,m.model,input_hash,day,m.revision,input_tokens,output_tokens,j.created_by
 ) returning * into u;
 return to_jsonb(u);
end $new$);
end $patch$;
do $patch$ declare body text;definition text;begin
 select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc where oid='public.settle_model_call(uuid,bigint,bigint,bigint,text)'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex')<>'b1a56ba9141fc9fa021a7c1992549d79bd6cd33b60c90ceffdc8a051c6177c6e' then raise exception 'Unexpected automation function: public.settle_model_call(uuid,bigint,bigint,bigint,text)';end if;
 execute replace(definition,body,$new$
declare u public.provider_usage;
begin
 perform 1 from public.workspaces where id=(select workspace_id from public.provider_usage where id=reservation) for update;
 select * into u from public.provider_usage where id=reservation for update;
 if u.id is null then raise exception 'NOT_FOUND'; end if;
 if u.state='settled' then
  if u.actual_input is distinct from actual_input or u.actual_output is distinct from actual_output or u.thinking_tokens is distinct from thinking then
   raise exception 'IDEMPOTENCY_CONFLICT';
  end if;
  return;
 end if;
 update public.provider_usage set
  actual_input=settle_model_call.actual_input,
  actual_output=settle_model_call.actual_output,
  thinking_tokens=thinking,
  state=case
   when settle_model_call.error_code in ('PROVIDER_QUOTA_WAIT','PROVIDER_REQUEST_REJECTED','PROVIDER_AUTH_FAILED','PROVIDER_MODEL_NOT_FOUND','PROVIDER_REQUEST_INVALID') then 'settled'
   when settle_model_call.actual_input is null or settle_model_call.actual_output is null then 'unknown'
   else 'settled'
  end,
  error_code=settle_model_call.error_code,
  revision=revision+1,
  updated_at=now()
 where id=reservation;
 if not exists(select 1 from public.model_routing where workspace_id=u.workspace_id and enabled) and (actual_input>u.reserved_input or actual_output>u.reserved_output) then
  update public.model_settings set enabled=false,revision=revision+1,updated_at=now()
  where workspace_id=u.workspace_id and provider=u.provider;
 end if;
end $new$);
end $patch$;
do $patch$ declare body text;definition text;begin
 select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc where oid='app_private.generation_call_cap()'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex')<>'76f23a575b7335a0f5eb68d69076113e400c8c3a66445f8d485d8536fb3e6271' then raise exception 'Unexpected automation function: app_private.generation_call_cap()';end if;
 execute replace(definition,body,$new$
declare plan uuid; identity jsonb; existing jsonb; profile public.model_settings;
begin
 select s.plan_id into plan from public.generation_steps s where s.job_id=new.job_id;
 if exists(select 1 from public.model_routing where workspace_id=new.workspace_id and enabled) then return new;end if;
 if plan is not null then
  if (select count(*) from public.provider_usage u join public.generation_steps s on s.job_id=u.job_id where s.plan_id=plan and not (u.state='settled' and coalesce(u.error_code,'')='PROVIDER_QUOTA_WAIT'))>=300 then
   raise exception 'PLAN_CALL_CAP_REACHED';
  end if;
  if exists(select 1 from public.model_routing where workspace_id=new.workspace_id and enabled) then
   return new;
  end if;
  select * into profile from public.model_settings where workspace_id=new.workspace_id and provider=new.provider;
  identity:=jsonb_build_object('provider',profile.provider,'model',profile.model,'project_ref',profile.project_ref);
  select model_identity into existing from public.generation_plans where id=plan;
  if existing is not null and existing<>identity and exists (
   select 1 from public.provider_usage u join public.generation_steps s on s.job_id=u.job_id
   where s.plan_id=plan and not (u.state='settled' and coalesce(u.error_code,'') in
    ('PROVIDER_QUOTA_WAIT','PROVIDER_REQUEST_REJECTED','PROVIDER_AUTH_FAILED','PROVIDER_MODEL_NOT_FOUND','PROVIDER_REQUEST_INVALID'))
  ) then raise exception 'MODEL_IDENTITY_CHANGED'; end if;
  update public.generation_plans set model_identity=identity where id=plan;
 end if;
 return new;
end $new$);
end $patch$;
do $patch$ declare body text;definition text;begin
 select prosrc,pg_get_functiondef(oid) into body,definition from pg_proc where oid='public.claim_backend_job()'::regprocedure;
 if encode(sha256(convert_to(body,'UTF8')),'hex')<>'8b0edb04c2f4a845a8afdf8028ffca3607c57300c0497a68180576a2ff90b919' then raise exception 'Unexpected automation function: public.claim_backend_job()';end if;
 execute replace(definition,body,$new$
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
  if not exists(select 1 from public.jobs where workspace_id=w and entity_id=s.id and type='source_collect' and status in ('queued','running','retry_wait','quota_wait')) then
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
end $new$);
end $patch$;
do $patch$ declare definition text;fragment text;begin
 select pg_get_functiondef('public.prepare_model_routing_before_activity(uuid,uuid,jsonb)'::regprocedure) into definition;
 fragment:=$old$  elsif exists(select 1 from public.provider_usage u where u.workspace_id=j.workspace_id and u.provider=provider_id and (u.actual_input>u.reserved_input or u.actual_output>u.reserved_output) and u.created_at>=coalesce(profile.verified_at,route.updated_at)) then reason:='MODEL_BUDGET_EXCEEDED';$old$;
 if position(fragment in definition)=0 then raise exception 'Unexpected routing budget guard';end if;
 execute replace(definition,fragment,'');
end $patch$;

-- Recovery counts actual failed rounds separately from successful detail reads/polls.
create function app_private.recover_processing_job(target uuid,provider_retry timestamptz default null)
returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;retryable boolean;delay_seconds integer;next_time timestamptz;entity uuid;
begin
 select * into j from public.jobs where id=target for update;
 if j.id is null or j.cancel_requested or j.status not in ('retry_wait','quota_wait','blocked','failed') then return;end if;
 if j.error_code in ('MODEL_IN_PROGRESS','MODEL_RATE_WAIT') then return;end if;
 if j.type not like 'source_%' and not exists(select 1 from public.model_routing where workspace_id=j.workspace_id and enabled) then return;end if;
 retryable:=j.error_code=any(array[
 'MODEL_ROUND_EXHAUSTED','MODEL_DAILY_QUOTA_WAIT','PROVIDER_QUOTA_WAIT','MODEL_NOT_CONFIGURED',
 'MODEL_NETWORK_UNCERTAIN','MODEL_RESULT_EXPIRED','USAGE_REVIEW_REQUIRED','USAGE_UNKNOWN',
 'PROVIDER_AUTH_FAILED','PROVIDER_MODEL_NOT_FOUND','PROVIDER_REQUEST_INVALID','PROVIDER_REQUEST_REJECTED',
 'MODEL_OUTPUT_INVALID','MODEL_OUTPUT_TRUNCATED','MODEL_OUTPUT_TOO_LARGE','MODEL_COVERAGE_INCOMPLETE',
 'EVIDENCE_REFERENCE_INVALID','UNSUPPORTED_COMPANY_CLAIM','TOKEN_COUNT_UNAVAILABLE','GENERATION_HANDLER_FAILED',
 'SOURCE_TEMPORARY_FAILURE','SOURCE_TIMEOUT','SOURCE_QUOTA_WAIT','SOURCE_UNAVAILABLE','SOURCE_EMPTY','SOURCE_SCHEMA_CHANGED',
 'COLLECTION_LEASE_EXPIRED','LEASE_EXPIRED_REVIEW_REQUIRED'
 ]);
 j.failure_count:=j.failure_count+1;
 delay_seconds:=case when j.failure_count>=4 then 3600 else (60*power(2,j.failure_count-1))::integer end;
 next_time:=greatest(now()+make_interval(secs=>delay_seconds),case when provider_retry is not null and isfinite(provider_retry) then least(provider_retry,now()+interval '1 day') else now() end);
 update public.jobs set failure_count=j.failure_count,status=case when retryable then 'retry_wait' else status end,
 next_attempt_at=case when retryable then next_time else next_attempt_at end,revision=revision+1,updated_at=now() where id=j.id;
 if retryable then
  update public.generation_plans set status='running',revision=revision+1,updated_at=now() where id=j.entity_id and workspace_id=j.workspace_id and status in ('queued','running','blocked');
  if j.type in ('source_collect','source_candidates') then
   update public.sources set health='unavailable',next_due=next_time,updated_at=now() where id=j.entity_id and workspace_id=j.workspace_id;
  end if;
 end if;
 if not retryable or j.failure_count>=4 then
  select coalesce(p.opportunity_id,j.entity_id) into entity from (select 1) x left join public.generation_plans p on p.id=j.entity_id;
  perform app_private.notify_members(j.workspace_id,'automation-failure:'||j.id,
   case when j.type like 'source_%' then 'Source collection needs attention' else 'Assessment or generation needs attention' end,
   coalesce(j.error_code,'UNKNOWN_ERROR')||'. Failed attempts: '||j.failure_count||case when retryable then '. Automatic retries continue.' else '. Configuration or evidence needs attention.' end,entity,j.created_by);
 end if;
end $$;
revoke all on function app_private.recover_processing_job(uuid,timestamptz) from public,anon,authenticated,service_role;

alter function public.fail_generation(uuid,uuid,text,timestamptz,jsonb) rename to fail_generation_before_automation;
revoke all on function public.fail_generation_before_automation(uuid,uuid,text,timestamptz,jsonb) from public,anon,authenticated,service_role;
create function public.fail_generation(job_id uuid,lease uuid,error_code text,retry_after timestamptz default null,split_inputs jsonb default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.fail_generation_before_automation(job_id,lease,error_code,retry_after,split_inputs);
 perform app_private.recover_processing_job(job_id,retry_after);
end $$;
alter function public.fail_collection(uuid,uuid,text,timestamptz) rename to fail_collection_before_automation;
revoke all on function public.fail_collection_before_automation(uuid,uuid,text,timestamptz) from public,anon,authenticated,service_role;
create function public.fail_collection(job_id uuid,lease uuid,error_code text,retry_after timestamptz default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.fail_collection_before_automation(job_id,lease,error_code,retry_after);
 perform app_private.recover_processing_job(job_id,retry_after);
end $$;
alter function public.fail_notice_details(uuid,uuid,text) rename to fail_notice_details_before_automation;
revoke all on function public.fail_notice_details_before_automation(uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.fail_notice_details(job_id uuid,lease uuid,error_code text)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.fail_notice_details_before_automation(job_id,lease,error_code);
 perform app_private.recover_processing_job(job_id);
end $$;
revoke all on function public.fail_generation(uuid,uuid,text,timestamptz,jsonb),public.fail_collection(uuid,uuid,text,timestamptz),public.fail_notice_details(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fail_generation(uuid,uuid,text,timestamptz,jsonb),public.fail_collection(uuid,uuid,text,timestamptz),public.fail_notice_details(uuid,uuid,text) to service_role;

-- Resume existing internal-budget waits without changing measured usage or consent.
update public.jobs j set status='retry_wait',next_attempt_at=now(),revision=revision+1,updated_at=now()
where status='quota_wait' and error_code='MODEL_DAILY_QUOTA_WAIT' and not cancel_requested
 and exists(select 1 from public.model_routing r where r.workspace_id=j.workspace_id and r.enabled);

-- Preserve qualified argument references in renamed implementation functions.
do $$ declare name text;definition text;begin
 foreach name in array array['fail_generation','fail_notice_details'] loop
  select pg_get_functiondef(p.oid) into definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=name||'_before_automation';
  execute replace(definition,name||'.error_code',name||'_before_automation.error_code');
 end loop;
end $$;

alter function public.finish_backend_job(uuid,uuid,text,text) rename to finish_backend_job_before_automation;
revoke all on function public.finish_backend_job_before_automation(uuid,uuid,text,text) from public,anon,authenticated,service_role;
create function public.finish_backend_job(job_id uuid,lease uuid,result_status text,result_error text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.finish_backend_job_before_automation(job_id,lease,result_status,result_error);
 if exists(select 1 from public.jobs where id=job_id and type='model_probe') then perform app_private.recover_processing_job(job_id);end if;
end $$;
revoke all on function public.finish_backend_job(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.finish_backend_job(uuid,uuid,text,text) to service_role;

do $$ declare definition text;fragment text;begin
 select pg_get_functiondef('public.prepare_model_routing_before_activity(uuid,uuid,jsonb)'::regprocedure) into definition;
 fragment:=$old$  elsif profile.id is not null and profile.project_ref<>slot->>'project_ref' then reason:='MODEL_IDENTITY_CHANGED';$old$;
 if position(fragment in definition)=0 then raise exception 'Unexpected routing identity guard';end if;
 execute replace(definition,fragment,'');
end $$;

-- A validated automatic probe can succeed even when usage is unreported.
-- Only the private worker can record a successful model attempt.
do $$ declare definition text;old_fragment text;begin
 select pg_get_functiondef('public.finish_backend_job_before_automation(uuid,uuid,text,text)'::regprocedure) into definition;
 old_fragment:='u.state=''settled'' and u.error_code is null and u.actual_input is not null and u.actual_output is not null';
 if position(old_fragment in definition)=0 then raise exception 'Unexpected probe completion guard';end if;
 execute replace(definition,old_fragment,$new$u.error_code is null and ((u.state='settled' and u.actual_input is not null and u.actual_output is not null) or (exists(select 1 from public.model_routing r where r.workspace_id=j.workspace_id and r.enabled) and exists(select 1 from public.model_attempts a where a.usage_id=u.id and a.job_id=j.id and a.lease_token=lease and a.status='succeeded')))$new$);
end $$;

alter function public.workspace_status() rename to workspace_status_before_automation;
revoke all on function public.workspace_status_before_automation() from public,anon,authenticated,service_role;
create function public.workspace_status() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;w uuid;automatic boolean;
begin
 result:=public.workspace_status_before_automation();
 select m.workspace_id into w from public.memberships m where m.user_id=auth.uid() and app_private.member_role(m.workspace_id) is not null limit 1;
 if w is null then raise exception 'ACCESS_PENDING';end if;
 select coalesce(bool_or(enabled),false) into automatic from public.model_routing where workspace_id=w;
 if automatic then
  result:=result||jsonb_build_object('input_tokens_today',(select coalesce(sum(actual_input),0)::text from public.provider_usage where workspace_id=w and application_day=(now() at time zone 'Asia/Riyadh')::date),
   'output_tokens_today',(select coalesce(sum(actual_output),0)::text from public.provider_usage where workspace_id=w and application_day=(now() at time zone 'Asia/Riyadh')::date));
 end if;
 return result||jsonb_build_object('automatic_usage_reporting_only',automatic);
end $$;
revoke all on function public.workspace_status() from public,anon;
grant execute on function public.workspace_status() to authenticated;
