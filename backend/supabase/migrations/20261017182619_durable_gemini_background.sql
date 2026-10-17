-- Persist provider request identity so polling never creates another generation.
alter table public.provider_usage add column remote_request_id text, add column remote_deadline timestamptz;
alter table public.provider_usage add constraint provider_usage_remote_request_check check (
 (remote_request_id is null and remote_deadline is null) or
 (provider='gemini_free' and remote_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' and remote_deadline is not null)
);

create function public.resume_model_request(job_id uuid,lease uuid,input_hash text,target_provider text,manifest jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;u public.provider_usage;pool jsonb;
begin
 select * into j from public.jobs where id=job_id;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 if input_hash is null or input_hash !~ '^[0-9a-f]{64}$' or target_provider is distinct from 'gemini_free' then raise exception 'INVALID_INPUT';end if;
 pool:=public.model_preflight(job_id,lease,manifest);
 select * into u from public.provider_usage p where p.job_id=j.id and p.remote_request_id is not null order by (p.state='reserved') desc,(p.state='unknown') desc,(p.input_hash=resume_model_request.input_hash) desc,p.created_at desc,p.id desc limit 1 for update;
 if u.id is null then return null;end if;
 -- A measured prior result may have led to an explicitly bounded repair prompt.
 if u.state='settled' and u.input_hash<>resume_model_request.input_hash then return null;end if;
 if u.input_hash<>resume_model_request.input_hash or u.provider<>target_provider or not exists(select 1 from jsonb_array_elements(pool->'providers') m where m->>'provider'=u.provider and m->>'model'=u.model) then raise exception 'MODEL_IDENTITY_CHANGED';end if;

 update public.provider_usage set lease_token=lease,revision=revision+1,updated_at=now() where id=u.id returning * into u;
 return to_jsonb(u);
end $$;

create function public.checkpoint_model_request(job_id uuid,lease uuid,reservation uuid,remote_id text)
returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;u public.provider_usage;
begin
 select * into j from public.jobs where id=job_id;perform 1 from public.workspaces where id=j.workspace_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 select * into u from public.provider_usage where id=reservation for update;
 if u.id is null or u.job_id<>j.id or u.lease_token is distinct from lease or u.provider<>'gemini_free' or u.state<>'reserved' then raise exception 'MODEL_CALL_ALREADY_RESERVED';end if;
 if remote_id is null or remote_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' then raise exception 'INVALID_INPUT';end if;
 if u.remote_request_id is not null and u.remote_request_id<>remote_id then raise exception 'IDEMPOTENCY_CONFLICT';end if;
 update public.provider_usage set remote_request_id=remote_id,remote_deadline=coalesce(remote_deadline,now()+interval '23 hours'),revision=revision+1,updated_at=now() where id=u.id;
end $$;

create function public.defer_model_request(job_id uuid,lease uuid,reservation uuid,retry_after timestamptz default null)
returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;u public.provider_usage;
begin
 select * into j from public.jobs where id=job_id;perform 1 from public.workspaces where id=j.workspace_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 select * into u from public.provider_usage where id=reservation for update;
 if u.id is null or u.job_id<>j.id or u.lease_token is distinct from lease or u.remote_request_id is null then raise exception 'MODEL_CALL_ALREADY_RESERVED';end if;
 if u.remote_deadline<=now() then raise exception 'MODEL_RESULT_EXPIRED';end if;
 update public.jobs set status='retry_wait',error_code='MODEL_IN_PROGRESS',next_attempt_at=case when retry_after is not null and isfinite(retry_after) then greatest(now()+interval '1 minute',least(retry_after,now()+interval '1 hour')) else now()+interval '1 minute' end,lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
end $$;

revoke all on function public.resume_model_request(uuid,uuid,text,text,jsonb),public.checkpoint_model_request(uuid,uuid,uuid,text),public.defer_model_request(uuid,uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.resume_model_request(uuid,uuid,text,text,jsonb),public.checkpoint_model_request(uuid,uuid,uuid,text),public.defer_model_request(uuid,uuid,uuid,timestamptz) to service_role;

create or replace function app_private.retain_abandoned_usage() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='canceled' or (old.status='running' and (new.status<>'running' or new.lease_token is distinct from old.lease_token)) then
 update public.provider_usage set state='unknown',error_code='LEASE_ENDED_WITHOUT_USAGE',revision=revision+1,updated_at=now()
 where job_id=old.id and (lease_token=old.lease_token or (new.status='canceled' and remote_request_id is not null)) and state='reserved'
 and not (remote_request_id is not null and remote_deadline>now() and new.status='retry_wait' and new.error_code='MODEL_IN_PROGRESS');
 end if;return new;
end $$;

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
 for s in select * from public.sources where workspace_id=w and approval='approved' and kind<>'manual' and not adapter_required and next_due<=now() and operator_id is not null order by next_due,id loop
  exit when (select count(*) from public.jobs where workspace_id=w and status in ('queued','running','retry_wait','quota_wait','blocked'))>=500;
  if not exists(select 1 from public.jobs where workspace_id=w and entity_id=s.id and type='source_collect' and status in ('queued','running','retry_wait')) then
   insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by) values(w,'source_collect',s.id,s.revision::text,'queued',operator_id);
  end if;
  update public.sources set next_due=now()+make_interval(hours=>s.poll_interval_hours) where id=s.id;
 end loop;
 if exists(select 1 from public.jobs where workspace_id=w and status='running') then return null; end if;
 select * into j from public.jobs where workspace_id=w and status in ('queued','retry_wait','quota_wait') and next_attempt_at<=now() order by case when error_code='MODEL_IN_PROGRESS' then 0 else 1 end,case when created_at<now()-interval '1 hour' then 0 when type in ('plan_proposal','analyze_chunk','draft_section') then 1 else 2 end,created_at,id for update skip locked limit 1;
 if j.id is null then return null;end if;
 if j.cancel_requested then update public.jobs set status='canceled',revision=revision+1 where id=j.id;return null;end if;
 update public.jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '180 seconds',revision=revision+1,updated_at=now() where id=j.id returning * into j;
 return to_jsonb(j);
end $$;
