-- Continue every saved generation stage before routine assessments; recover already-blocked stale source jobs.
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
 select * into j from public.jobs where workspace_id=w and status in ('queued','retry_wait','quota_wait') and next_attempt_at<=now() order by case when error_code='MODEL_IN_PROGRESS' then 0 else 1 end,case when created_at<now()-interval '1 hour' then 0 when type in ('plan_proposal','analyze_chunk','consolidate_requirements','draft_section','plan_commercial','review_proposal','advance_plan') then 1 when type in ('source_collect','source_candidates') then 2 else 3 end,created_at,id for update skip locked limit 1;
 if j.id is null then return null;end if;
 if j.cancel_requested then update public.jobs set status='canceled',revision=revision+1 where id=j.id;return null;end if;
 update public.jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '180 seconds',revision=revision+1,updated_at=now() where id=j.id returning * into j;
 return to_jsonb(j);
end $$;
