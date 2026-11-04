-- Explicit user authorizations own one end-to-end deadline. Identity and usage
-- metadata are additive: historical frozen prompts/reservations are untouched.
create table public.proposal_issuance_requests (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null,
 plan_id uuid not null, requested_by uuid not null, operation text not null,
 idempotency_key text not null, deadline_version integer not null default 1 check(deadline_version=1),
 accepted_at timestamptz not null, deadline_at timestamptz not null,
 outcome text not null default 'active' check(outcome in ('active','issued','failed')),
 error_code text, completed_at timestamptz, issued_snapshot_id uuid,
 unique(workspace_id,id), unique(workspace_id,plan_id,requested_by,operation,idempotency_key),
 foreign key(workspace_id) references public.workspaces(id) deferrable initially immediate,
 foreign key(workspace_id,requested_by) references public.workspace_actors(workspace_id,id) deferrable initially immediate,
 check(deadline_at=accepted_at+interval '600 seconds'),
 check((outcome='active' and completed_at is null and error_code is null and issued_snapshot_id is null)
  or (outcome='failed' and completed_at is not null and error_code is not null and issued_snapshot_id is null)
  or (outcome='issued' and completed_at is not null and completed_at<deadline_at and error_code is null and issued_snapshot_id is not null))
);
create index proposal_issuance_active_deadline on public.proposal_issuance_requests(deadline_at) where outcome='active';
alter table public.proposal_issuance_requests enable row level security;
revoke all on public.proposal_issuance_requests from public;
do $$ declare role_name text;begin foreach role_name in array array['anon','tdp_app_anon','authenticated','tdp_app_authenticated'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on public.proposal_issuance_requests from %I',role_name);end if;
 end loop;end $$;
do $$ declare role_name text;begin foreach role_name in array array['authenticated','tdp_app_authenticated'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('grant select on public.proposal_issuance_requests to %I',role_name);end if;
 end loop;end $$;
do $$ declare role_name text;begin foreach role_name in array array['service_role','tdp_app_service'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('grant all on public.proposal_issuance_requests to %I',role_name);end if;
 end loop;end $$;
do $$ declare role_name text;begin
 foreach role_name in array array['authenticated','tdp_app_authenticated'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then
   execute format('create policy %I on public.proposal_issuance_requests for select to %I using(app_private.member_role(workspace_id) is not null)','issuance_member_read_'||role_name,role_name);
  end if;
 end loop;
end $$;
alter table public.generation_plans add column issuance_request_id uuid;
create view public.proposal_issuance_status with(security_invoker=true) as
 select r.*,case when outcome='active' and deadline_at<=clock_timestamp() then 'failed' else outcome end effective_outcome,
 case when outcome='active' and deadline_at<=clock_timestamp() then 'PROPOSAL_ISSUANCE_TIMEOUT' else error_code end effective_error_code,
 case when outcome='active' and deadline_at<=clock_timestamp() then deadline_at else completed_at end effective_completed_at
 from public.proposal_issuance_requests r;
revoke all on public.proposal_issuance_status from public;
do $$ declare role_name text;begin foreach role_name in array array['anon','tdp_app_anon'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on public.proposal_issuance_status from %I',role_name);end if;
 end loop;end $$;
do $$ declare role_name text;begin foreach role_name in array array['authenticated','tdp_app_authenticated','service_role','tdp_app_service'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('grant select on public.proposal_issuance_status to %I',role_name);end if;
 end loop;end $$;
create function app_private.issuance_identity_immutable() returns trigger language plpgsql set search_path='' as $$begin
 if (to_jsonb(new)-array['outcome','error_code','completed_at','issued_snapshot_id']) is distinct from
    (to_jsonb(old)-array['outcome','error_code','completed_at','issued_snapshot_id'])
  or old.outcome<>'active' and new is distinct from old then raise exception 'ISSUANCE_IDENTITY_IMMUTABLE';end if;
 return new;
end $$;
create trigger issuance_identity_immutable before update on public.proposal_issuance_requests for each row execute function app_private.issuance_identity_immutable();

create function app_private.issuance_deadline_reached(deadline timestamptz,observed_at timestamptz) returns boolean
language sql immutable strict set search_path='' as $$ select observed_at>=deadline $$;
revoke all on function app_private.issuance_deadline_reached(timestamptz,timestamptz) from public;
do $$ declare role_name text;begin foreach role_name in array array['anon','tdp_app_anon','authenticated','tdp_app_authenticated','service_role','tdp_app_service'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on function app_private.issuance_deadline_reached(timestamptz,timestamptz) from %I',role_name);end if;
 end loop;end $$;

create function app_private.fail_proposal_issuance(request_id uuid,error_code text) returns boolean
language plpgsql security definer set search_path='' as $$
declare r public.proposal_issuance_requests;w uuid;begin
 select workspace_id into w from public.proposal_issuance_requests where id=request_id;
 perform 1 from public.workspaces where id=w for update;
 select * into r from public.proposal_issuance_requests where id=request_id for update;
 if r.id is null or r.outcome<>'active' then return false;end if;
 if error_code is null or error_code !~ '^[A-Z][A-Z0-9_]{0,119}$' then raise exception 'INVALID_INPUT';end if;
 update public.proposal_issuance_requests set outcome='failed',error_code=case when app_private.issuance_deadline_reached(r.deadline_at,clock_timestamp()) then 'PROPOSAL_ISSUANCE_TIMEOUT' else fail_proposal_issuance.error_code end,
 completed_at=case when app_private.issuance_deadline_reached(r.deadline_at,clock_timestamp()) then r.deadline_at else clock_timestamp() end where id=r.id;
 -- No provider_usage write: an accepted remote operation retains its exact
 -- reserved/unknown accounting and may be reconciled independently.
 update public.jobs set status='failed',cancel_requested=true,error_code=case when app_private.issuance_deadline_reached(r.deadline_at,clock_timestamp()) then 'PROPOSAL_ISSUANCE_TIMEOUT' else fail_proposal_issuance.error_code end,
 lease_token=null,lease_until=null,next_attempt_at='infinity',revision=revision+1,updated_at=now()
 where workspace_id=r.workspace_id and checkpoint->>'issuance_request_id'=r.id::text and status not in ('succeeded','failed','canceled');
 update public.generation_plans set status='failed',error_code=case when app_private.issuance_deadline_reached(r.deadline_at,clock_timestamp()) then 'PROPOSAL_ISSUANCE_TIMEOUT' else fail_proposal_issuance.error_code end,
 revision=revision+1,updated_at=now() where id=r.plan_id and issuance_request_id=r.id;
 return true;
end $$;
create function app_private.expire_proposal_issuances(target_workspace uuid default null) returns integer language plpgsql security definer set search_path='' as $$
declare r record;n integer:=0;begin
 for r in select id from public.proposal_issuance_requests where outcome='active' and (target_workspace is null or workspace_id=target_workspace) and app_private.issuance_deadline_reached(deadline_at,clock_timestamp()) order by workspace_id,id loop
  if app_private.fail_proposal_issuance(r.id,'PROPOSAL_ISSUANCE_TIMEOUT') then n:=n+1;end if;
 end loop;
 for r in select request.id,terminal.error_code from public.proposal_issuance_requests request
  cross join lateral(select j.error_code from public.jobs j where j.workspace_id=request.workspace_id
   and j.checkpoint->>'issuance_request_id'=request.id::text and j.status in ('blocked','failed')
   and (j.type<>'render_delivery' or exists(select 1 from public.proposal_delivery_snapshots s where s.id=j.entity_id and s.payload->'version'='3'::jsonb))
   order by j.updated_at,j.id limit 1) terminal
  where request.outcome='active' and (target_workspace is null or request.workspace_id=target_workspace)
  order by request.workspace_id,request.id loop
  if app_private.fail_proposal_issuance(r.id,coalesce(r.error_code,'PROPOSAL_ISSUANCE_FAILED')) then n:=n+1;end if;
 end loop;return n;
end $$;
create function app_private.assert_issuance_job(job_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;r public.proposal_issuance_requests;begin
 select * into j from public.jobs where id=job_id;
 if not (j.checkpoint ? 'issuance_request_id') then return;end if;
 -- Waiting for a workspace lock consumes the SAME accepted request deadline.
 -- Re-read after the lock: a pre-lock clock check admits late receipts/reserves.
 perform 1 from public.workspaces where id=j.workspace_id for update;
 select * into j from public.jobs where id=job_id;
 select * into r from public.proposal_issuance_requests where id=(j.checkpoint->>'issuance_request_id')::uuid and workspace_id=j.workspace_id;
 if r.id is null or not(j.entity_id=r.plan_id or (j.type='render_delivery' and exists(select 1 from public.proposal_delivery_snapshots s where s.id=j.entity_id and s.plan_id=r.plan_id and s.workspace_id=r.workspace_id))) then raise exception 'ISSUANCE_IDENTITY_CHANGED';end if;
 if app_private.issuance_deadline_reached(r.deadline_at,clock_timestamp()) then raise exception 'PROPOSAL_ISSUANCE_TIMEOUT';end if;
 if r.outcome<>'active' then raise exception '%',coalesce(r.error_code,'PROPOSAL_ISSUANCE_CLOSED');end if;
end $$;
-- This RPC persists timeout before returning it; throwing after an UPDATE in
-- the same SQL call would roll the terminal state back.
create function public.proposal_issuance_job_state(job_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs;r public.proposal_issuance_requests;begin
 select * into j from public.jobs where id=job_id;
 if j.id is null or lease is null or j.lease_token is distinct from lease or j.status<>'running' then raise exception 'STALE_LEASE';end if;
 if not (j.checkpoint ? 'issuance_request_id') then return null;end if;
 select * into r from public.proposal_issuance_requests where id=(j.checkpoint->>'issuance_request_id')::uuid and workspace_id=j.workspace_id;
 if r.id is null then raise exception 'ISSUANCE_IDENTITY_CHANGED';end if;
 if r.outcome='active' and app_private.issuance_deadline_reached(r.deadline_at,clock_timestamp()) then
  perform app_private.fail_proposal_issuance(r.id,'PROPOSAL_ISSUANCE_TIMEOUT');
  select * into r from public.proposal_issuance_requests where id=r.id;
 end if;
 return jsonb_build_object('id',r.id,'deadline_version',r.deadline_version,'accepted_at',r.accepted_at,'deadline_at',r.deadline_at,'outcome',r.outcome,'error_code',r.error_code);
end $$;

-- New source/repair/consistency contracts require runtime 4. Keep the model
-- execution protocol's independent version 2 pin unchanged.
create function app_private.bind_issuance_job() returns trigger language plpgsql security definer set search_path='' as $$
declare p public.generation_plans;s public.proposal_delivery_snapshots;requires_v4 boolean;begin
 select * into p from public.generation_plans where id=new.entity_id and workspace_id=new.workspace_id;
 if p.id is null and new.type='render_delivery' then
  select * into s from public.proposal_delivery_snapshots where id=new.entity_id and workspace_id=new.workspace_id;
  if tg_op='INSERT' and s.payload->'version'='1'::jsonb
   and current_setting('app.issuance_independent_snapshot',true)=s.id::text then
   new.checkpoint:=(new.checkpoint-array['issuance_request_id','issuance_deadline_version'])||jsonb_build_object('independent_delivery_authorization',jsonb_build_object('version',1,'snapshot_id',s.id,'actor_id',auth.uid(),'operation','delivery.snapshot.retry'));
   return new;
  end if;
  if s.plan_id is not null then select * into p from public.generation_plans where id=s.plan_id and workspace_id=new.workspace_id;end if;
 end if;
 requires_v4:=p.frozen_context->'source_contract_version'='1'::jsonb or p.frozen_context->'repair_contract_version'='1'::jsonb or p.frozen_context->'proposal_consistency_version'='1'::jsonb or new.checkpoint ? 'issuance_request_id' or (tg_op='INSERT' and p.issuance_request_id is not null);
 if coalesce(requires_v4,false) then new.checkpoint:=new.checkpoint||jsonb_build_object('minimum_worker_executor',4);end if;
 if tg_op='UPDATE' and old.checkpoint ? 'issuance_request_id' and not(new.checkpoint ? 'issuance_request_id') then
  new.checkpoint:=new.checkpoint||jsonb_build_object('issuance_request_id',old.checkpoint->'issuance_request_id','issuance_deadline_version',1,'minimum_worker_executor',4);
 end if;
 if tg_op='UPDATE' and old.checkpoint ? 'issuance_request_id' and new.checkpoint->>'issuance_request_id' is distinct from old.checkpoint->>'issuance_request_id'
  and coalesce(current_setting('app.issuance_authorizing',true),'')<>'true' then raise exception 'ISSUANCE_IDENTITY_CHANGED';end if;
 if p.issuance_request_id is not null and not(new.checkpoint ? 'issuance_request_id')
  and (tg_op='INSERT' or coalesce(current_setting('app.issuance_authorizing',true),'')='true') then
  new.checkpoint:=new.checkpoint||jsonb_build_object('issuance_request_id',p.issuance_request_id,'issuance_deadline_version',1);
 end if;
 if tg_op='UPDATE' and new.status in ('running','succeeded') and old.status is distinct from new.status and new.checkpoint ? 'issuance_request_id' then
  perform app_private.assert_issuance_job(old.id);
 end if;
 return new;
end $$;
create trigger bind_issuance_job before insert or update on public.jobs for each row execute function app_private.bind_issuance_job();

create function app_private.admit_proposal_issuance() returns trigger language plpgsql security definer set search_path='' as $$
declare p public.generation_plans;r public.proposal_issuance_requests;target_job uuid;previous text:=current_setting('app.issuance_authorizing',true);begin
 select * into p from public.generation_plans where id=new.plan_id;
 if p.kind<>'proposal' then return new;end if;
 if tg_op='UPDATE' and new.requested_at is not distinct from old.requested_at then return new;end if;
 insert into public.proposal_issuance_requests(workspace_id,plan_id,requested_by,operation,idempotency_key,accepted_at,deadline_at)
 values(new.workspace_id,new.plan_id,new.requested_by,new.operation,new.idempotency_key,transaction_timestamp(),transaction_timestamp()+interval '600 seconds')
 on conflict(workspace_id,plan_id,requested_by,operation,idempotency_key) do nothing returning * into r;
 if r.id is null then return new;end if;
 if p.issuance_request_id is not null then
  update public.proposal_issuance_requests set outcome='failed',error_code='PROPOSAL_ISSUANCE_SUPERSEDED',completed_at=clock_timestamp()
   where id=p.issuance_request_id and outcome='active';
 end if;
 update public.generation_plans set issuance_request_id=r.id where id=p.id;
 if new.operation='job.action' then
  select j.id into target_job from app_private.idempotency_records replay join public.jobs j on j.id=(replay.result->>'id')::uuid
   where replay.workspace_id=new.workspace_id and replay.actor_id=new.requested_by and replay.method='COMMAND'
    and replay.route=new.operation and replay.key=new.idempotency_key and j.entity_id=p.id;
 end if;
 perform set_config('app.issuance_authorizing','true',true);
 -- Initial admission runs after transactional plan/step/snapshot creation.
 -- Explicit retries rebind only the work that the existing command authorized.
 update public.jobs j set checkpoint=j.checkpoint||jsonb_build_object('issuance_request_id',r.id,'issuance_deadline_version',1,'minimum_worker_executor',4)
 where j.workspace_id=p.workspace_id and (target_job is null or j.id=target_job) and j.status in ('queued','retry_wait','quota_wait','blocked') and
 (j.entity_id=p.id or (j.type='render_delivery' and exists(select 1 from public.proposal_delivery_snapshots s where s.id=j.entity_id and s.plan_id=p.id and s.created_at>=transaction_timestamp())));
 perform set_config('app.issuance_authorizing',coalesce(previous,''),true);
 return new;
end $$;
create trigger admit_proposal_issuance after insert or update on app_private.generation_processing_requests for each row execute function app_private.admit_proposal_issuance();

-- Canonical queue selection is used by every worker wrapper, including old
-- workers during an additive migration rollout. No old worker may claim v4 work.
do $$ declare definition text;marker text;begin
 definition:=pg_get_functiondef('app_private.next_fair_job(uuid,boolean)'::regprocedure);
 marker:='coalesce((q.checkpoint->>''model_executor'')::int,1)';
 if position(marker in definition)=0 then raise exception 'ISSUANCE_CLAIM_CONTRACT_CHANGED';end if;
 if position('minimum_worker_executor' in definition)=0 then
  definition:=replace(definition,marker,'greatest(coalesce((q.checkpoint->>''model_executor'')::int,1),coalesce((q.checkpoint->>''minimum_worker_executor'')::int,1))');
 end if;
 marker:='and (not local_only or c.work_class=''local'')';
 if position(marker in definition)=0 then raise exception 'ISSUANCE_QUEUE_SCOPE_CHANGED';end if;
 execute replace(definition,marker,$new$and (not(q.checkpoint ? 'issuance_request_id') or exists(select 1 from public.proposal_issuance_requests request
  where request.id=(q.checkpoint->>'issuance_request_id')::uuid and request.workspace_id=q.workspace_id
   and request.outcome='active' and request.deadline_at>clock_timestamp())) $new$||marker);
 definition:=pg_get_functiondef('public.claim_backend_job()'::regprocedure);
 marker:='perform 1 from public.workspaces where id=w for update;';
 if position(marker in definition)=0 then raise exception 'ISSUANCE_QUEUE_CONTRACT_CHANGED';end if;
 definition:=replace(definition,marker,marker||' perform app_private.expire_proposal_issuances(w);');
 marker:='j.id:=app_private.next_fair_job';
 if position(marker in definition)=0 then raise exception 'ISSUANCE_RECOVERY_CONTRACT_CHANGED';end if;
 execute replace(definition,marker,'perform app_private.expire_proposal_issuances(w); '||marker);
end $$;

-- Gate reads and successful commits; failure/usage reconciliation keeps its
-- original identity and is allowed to record the terminal outcome.
alter function public.generation_context(uuid,uuid) rename to generation_context_before_issuance;
create function public.generation_context(job_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$begin
 perform app_private.assert_issuance_job(job_id);return public.generation_context_before_issuance(job_id,lease);
end $$;
alter function app_private.delivery_job(uuid,uuid,boolean) rename to delivery_job_before_issuance;
create function app_private.delivery_job(job_id uuid,lease uuid,check_sources boolean default true) returns public.jobs language plpgsql security definer set search_path='' as $$begin
 if check_sources then perform app_private.assert_issuance_job(job_id);end if;
 return app_private.delivery_job_before_issuance(job_id,lease,check_sources);
end $$;
alter function public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid) rename to reserve_task_model_call_before_issuance;
create function public.reserve_task_model_call(job_id uuid,lease uuid,call_key text,input_hash text,input_tokens integer,output_tokens integer,manifest jsonb,target_model uuid,target_connection uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform app_private.assert_issuance_job(job_id);
 return public.reserve_task_model_call_before_issuance(job_id,lease,call_key,input_hash,input_tokens,output_tokens,manifest,target_model,target_connection);
end $$;

alter function public.fail_generation(uuid,uuid,text,timestamptz,jsonb) rename to fail_generation_before_issuance;
create function public.fail_generation(job_id uuid,lease uuid,error_code text,retry_after timestamptz default null,split_inputs jsonb default null) returns void
language plpgsql security definer set search_path='' as $$
declare j public.jobs;r public.proposal_issuance_requests;begin
 select * into j from public.jobs where id=job_id;
 if j.checkpoint ? 'issuance_request_id' then
  select * into r from public.proposal_issuance_requests where id=(j.checkpoint->>'issuance_request_id')::uuid and workspace_id=j.workspace_id;
  if r.outcome<>'active' then return;end if;
  if j.lease_token is distinct from lease or lease is null then raise exception 'STALE_LEASE';end if;
  if app_private.issuance_deadline_reached(r.deadline_at,clock_timestamp()) or error_code in ('PROPOSAL_ISSUANCE_TIMEOUT','AI_AGENTS_UNAVAILABLE') then
   perform app_private.fail_proposal_issuance(r.id,error_code);return;
  end if;
 end if;
 perform public.fail_generation_before_issuance(job_id,lease,error_code,retry_after,split_inputs);
 select * into j from public.jobs where id=job_id;
 if r.id is not null and j.status in ('blocked','failed','canceled') then perform app_private.fail_proposal_issuance(r.id,coalesce(j.error_code,error_code));end if;
end $$;
alter function public.fail_delivery_export(uuid,uuid,text) rename to fail_delivery_export_before_issuance;
create function public.fail_delivery_export(job_id uuid,lease uuid,error_code text) returns void
language plpgsql security definer set search_path='' as $$
declare j public.jobs;r public.proposal_issuance_requests;begin
 select * into j from public.jobs where id=job_id;
 if j.checkpoint ? 'issuance_request_id' then
  select * into r from public.proposal_issuance_requests where id=(j.checkpoint->>'issuance_request_id')::uuid and workspace_id=j.workspace_id;
  if r.outcome<>'active' then return;end if;
  if j.lease_token is distinct from lease or lease is null then raise exception 'STALE_LEASE';end if;
  if app_private.issuance_deadline_reached(r.deadline_at,clock_timestamp()) or error_code='PROPOSAL_ISSUANCE_TIMEOUT' then perform app_private.fail_proposal_issuance(r.id,error_code);return;end if;
 end if;
 perform public.fail_delivery_export_before_issuance(job_id,lease,error_code);
 select * into j from public.jobs where id=job_id;
 if r.id is not null and j.status in ('blocked','failed','canceled')
  and exists(select 1 from public.proposal_delivery_snapshots s where s.id=j.entity_id and s.payload->'version'='3'::jsonb)
 then perform app_private.fail_proposal_issuance(r.id,coalesce(j.error_code,error_code));end if;
end $$;

create function app_private.complete_proposal_issuance(request_id uuid,snapshot_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare r public.proposal_issuance_requests;s public.proposal_delivery_snapshots;j public.jobs;w uuid;begin
 select workspace_id into w from public.proposal_issuance_requests where id=request_id;
 perform 1 from public.workspaces where id=w for update;
 select * into r from public.proposal_issuance_requests where id=request_id for update;
 if r.id is null or r.outcome<>'active' then return false;end if;
 if app_private.issuance_deadline_reached(r.deadline_at,clock_timestamp()) then perform app_private.fail_proposal_issuance(r.id,'PROPOSAL_ISSUANCE_TIMEOUT');return false;end if;
 select * into s from public.proposal_delivery_snapshots where id=snapshot_id and workspace_id=r.workspace_id and plan_id=r.plan_id;
 if s.id is null or s.payload->'version' is distinct from '3'::jsonb
  or s.payload->>'content_state' is distinct from 'generated_review_draft'
  or s.payload#>'{generation,machine_validation,passed}' is distinct from 'true'::jsonb
  or s.payload#>>'{generation,machine_validation,policy}' is distinct from 'generated-delivery-v1'
  or not exists(select 1 from public.proposal_versions v join public.generation_plans p on p.id=v.plan_id
   where v.id=(s.payload#>>'{generation,proposal_version_id}')::uuid and v.workspace_id=r.workspace_id and v.plan_id=r.plan_id
    and v.content_hash=s.payload#>>'{generation,version_content_hash}' and p.input_hash=s.payload#>>'{generation,plan_input_hash}'
    and p.id::text=s.payload#>>'{generation,plan_id}' and p.issuance_request_id=r.id)
  then raise exception 'PROPOSAL_ISSUANCE_INCOMPLETE';end if;
 select * into j from public.jobs where workspace_id=r.workspace_id and type='render_delivery' and entity_id=s.id
  and checkpoint->>'issuance_request_id'=r.id::text and status='succeeded' order by created_at desc,id desc limit 1;
 if j.id is null then raise exception 'PROPOSAL_ISSUANCE_INCOMPLETE';end if;
 perform app_private.check_delivery_volume_set(s,j.id);
 if not exists(select 1 from public.proposal_delivery_artifacts where proposal_delivery_artifacts.job_id=j.id)
  or exists(select 1 from public.proposal_delivery_artifacts where proposal_delivery_artifacts.job_id=j.id and status<>'ready') then raise exception 'PROPOSAL_ISSUANCE_INCOMPLETE';end if;
 -- Recheck after all validation work, so equality at 600 seconds cannot commit.
 if app_private.issuance_deadline_reached(r.deadline_at,clock_timestamp()) then perform app_private.fail_proposal_issuance(r.id,'PROPOSAL_ISSUANCE_TIMEOUT');return false;end if;
 update public.proposal_issuance_requests set outcome='issued',completed_at=clock_timestamp(),issued_snapshot_id=s.id where id=r.id;
 update public.jobs set status='canceled',cancel_requested=true,lease_token=null,lease_until=null,revision=revision+1,updated_at=now()
  where workspace_id=r.workspace_id and checkpoint->>'issuance_request_id'=r.id::text and id<>j.id and status in ('queued','running','retry_wait','quota_wait','blocked');
 return true;
end $$;

do $$ declare f regprocedure;role_name text;begin
 foreach f in array array[
 'app_private.issuance_identity_immutable()'::regprocedure,'app_private.fail_proposal_issuance(uuid,text)'::regprocedure,
 'app_private.expire_proposal_issuances(uuid)'::regprocedure,'app_private.assert_issuance_job(uuid)'::regprocedure,
 'app_private.bind_issuance_job()'::regprocedure,'app_private.admit_proposal_issuance()'::regprocedure,
 'app_private.complete_proposal_issuance(uuid,uuid)'::regprocedure,'app_private.delivery_job_before_issuance(uuid,uuid,boolean)'::regprocedure,
 'public.generation_context_before_issuance(uuid,uuid)'::regprocedure,'public.reserve_task_model_call_before_issuance(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)'::regprocedure,
 'public.fail_generation_before_issuance(uuid,uuid,text,timestamptz,jsonb)'::regprocedure,'public.fail_delivery_export_before_issuance(uuid,uuid,text)'::regprocedure,
 'public.proposal_issuance_job_state(uuid,uuid)'::regprocedure,'public.generation_context(uuid,uuid)'::regprocedure,
 'app_private.delivery_job(uuid,uuid,boolean)'::regprocedure,'public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)'::regprocedure,
 'public.fail_generation(uuid,uuid,text,timestamptz,jsonb)'::regprocedure,'public.fail_delivery_export(uuid,uuid,text)'::regprocedure] loop
  execute format('revoke all on function %s from public',f);
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on function %s from %I',f,role_name);end if;
  end loop;
 end loop;
 foreach role_name in array array['service_role','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then
   foreach f in array array['public.proposal_issuance_job_state(uuid,uuid)'::regprocedure,'public.generation_context(uuid,uuid)'::regprocedure,
   'public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)'::regprocedure,
   'public.fail_generation(uuid,uuid,text,timestamptz,jsonb)'::regprocedure,'public.fail_delivery_export(uuid,uuid,text)'::regprocedure] loop
    execute format('grant execute on function %s to %I',f,role_name);
   end loop;
  end if;
 end loop;
end $$;

-- Legacy model routing is still possible for a newly authorized historical
-- plan. Its NEW reservations share the same deadline; settlement remains free.
alter function public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text) rename to reserve_model_call_before_issuance;
create function public.reserve_model_call(job_id uuid,lease uuid,call_key text,input_hash text,input_tokens integer,output_tokens integer,manifest jsonb,target_provider text) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform app_private.assert_issuance_job(job_id);
 return public.reserve_model_call_before_issuance(job_id,lease,call_key,input_hash,input_tokens,output_tokens,manifest,target_provider);
end $$;
revoke all on function public.reserve_model_call_before_issuance(uuid,uuid,text,text,integer,integer,jsonb,text) from public;
do $$ declare role_name text;begin foreach role_name in array array['anon','tdp_app_anon','authenticated','tdp_app_authenticated','service_role','tdp_app_service'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on function public.reserve_model_call_before_issuance(uuid,uuid,text,text,integer,integer,jsonb,text) from %I',role_name);end if;
 end loop;end $$;
revoke all on function public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text) from public;
do $$ declare role_name text;begin foreach role_name in array array['anon','tdp_app_anon','authenticated','tdp_app_authenticated'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on function public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text) from %I',role_name);end if;
 end loop;end $$;
do $$ declare role_name text;begin foreach role_name in array array['service_role','tdp_app_service'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('grant execute on function public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text) to %I',role_name);end if;
 end loop;end $$;

alter function app_private.backup_tables() rename to backup_tables_before_issuance;
create function app_private.backup_tables() returns text[] language sql immutable set search_path='' as $$
 select app_private.backup_tables_before_issuance()||array['proposal_issuance_requests']::text[]
$$;
alter function app_private.purge_scope(uuid,uuid) rename to purge_scope_before_issuance;
create function app_private.purge_scope(w uuid,opp uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;part jsonb;begin
 result:=app_private.purge_scope_before_issuance(w,opp);
 select jsonb_build_object('ids',coalesce(jsonb_agg(r.id order by r.id),'[]'),
  'hash',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(r)::text,',' order by r.id),''),'UTF8')),'hex')) into part
 from public.proposal_issuance_requests r where r.workspace_id=w and exists(select 1 from public.generation_plans p where p.id=r.plan_id and p.opportunity_id=opp);
 return result||jsonb_build_object('proposal_issuance_requests',part);
end $$;
do $$ declare definition text;marker text;begin
 definition:=pg_get_functiondef('public.commit_workspace_restore(uuid)'::regprocedure);
 marker:='if t=''sources'' then';
 if position(marker in definition)=0 then raise exception 'ISSUANCE_RESTORE_CONTRACT_CHANGED';end if;
 execute replace(definition,marker,$new$if t='proposal_issuance_requests' and data->>'outcome'='active' then
 data:=data||jsonb_build_object('outcome','failed','error_code','RESTORE_REQUIRES_REVIEW','completed_at',clock_timestamp(),'issued_snapshot_id',null);
 elsif t='sources' then$new$);
end $$;
revoke all on function app_private.backup_tables_before_issuance(),app_private.backup_tables(),app_private.purge_scope_before_issuance(uuid,uuid),app_private.purge_scope(uuid,uuid) from public;
do $$ declare role_name text;begin foreach role_name in array array['anon','tdp_app_anon','authenticated','tdp_app_authenticated','service_role','tdp_app_service'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on function app_private.backup_tables_before_issuance(),app_private.backup_tables(),app_private.purge_scope_before_issuance(uuid,uuid),app_private.purge_scope(uuid,uuid) from %I',role_name);end if;
 end loop;end $$;

alter function public.maintenance_tick() rename to maintenance_tick_before_issuance;
create function public.maintenance_tick() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;expired integer;begin
 expired:=app_private.expire_proposal_issuances();result:=public.maintenance_tick_before_issuance();
 return result||jsonb_build_object('expired_proposal_issuances',expired);
end $$;
revoke all on function public.maintenance_tick_before_issuance() from public;
do $$ declare role_name text;begin foreach role_name in array array['anon','tdp_app_anon','authenticated','tdp_app_authenticated','service_role','tdp_app_service'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on function public.maintenance_tick_before_issuance() from %I',role_name);end if;
 end loop;end $$;
revoke all on function public.maintenance_tick() from public;
do $$ declare role_name text;begin foreach role_name in array array['anon','tdp_app_anon','authenticated','tdp_app_authenticated'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on function public.maintenance_tick() from %I',role_name);end if;
 end loop;end $$;
do $$ declare role_name text;begin foreach role_name in array array['service_role','tdp_app_service'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('grant execute on function public.maintenance_tick() to %I',role_name);end if;
 end loop;end $$;

alter function public.finish_delivery_export(uuid,uuid) rename to finish_delivery_export_before_issuance;
create function public.finish_delivery_export(job_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;j public.jobs;s public.proposal_delivery_snapshots;issued boolean;begin
 result:=public.finish_delivery_export_before_issuance(job_id,lease);
 select * into j from public.jobs where id=job_id;
 select * into s from public.proposal_delivery_snapshots where id=j.entity_id;
 if j.checkpoint ? 'issuance_request_id' and s.payload->'version'='3'::jsonb then
  issued:=app_private.complete_proposal_issuance((j.checkpoint->>'issuance_request_id')::uuid,s.id);
  result:=result||jsonb_build_object('issuance_outcome',case when issued then 'issued' else 'failed' end);
 end if;
 return result;
end $$;
revoke all on function public.finish_delivery_export_before_issuance(uuid,uuid) from public;
do $$ declare role_name text;begin foreach role_name in array array['anon','tdp_app_anon','authenticated','tdp_app_authenticated','service_role','tdp_app_service'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on function public.finish_delivery_export_before_issuance(uuid,uuid) from %I',role_name);end if;
 end loop;end $$;
revoke all on function public.finish_delivery_export(uuid,uuid) from public;
do $$ declare role_name text;begin foreach role_name in array array['anon','tdp_app_anon','authenticated','tdp_app_authenticated'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on function public.finish_delivery_export(uuid,uuid) from %I',role_name);end if;
 end loop;end $$;
do $$ declare role_name text;begin foreach role_name in array array['service_role','tdp_app_service'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute format('grant execute on function public.finish_delivery_export(uuid,uuid) to %I',role_name);end if;
 end loop;end $$;

-- PL/pgSQL's implicit parameter block has the function's current name. Preserve
-- qualified parameter references after wrapping, including call-key identity.
do $$ declare f regprocedure;definition text;old_name text;new_name text;begin
 foreach f in array array[
  'public.reserve_model_call_before_issuance(uuid,uuid,text,text,integer,integer,jsonb,text)'::regprocedure,
  'public.reserve_task_model_call_before_issuance(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)'::regprocedure,
  'public.generation_context_before_issuance(uuid,uuid)'::regprocedure,
  'app_private.delivery_job_before_issuance(uuid,uuid,boolean)'::regprocedure,
  'public.fail_generation_before_issuance(uuid,uuid,text,timestamptz,jsonb)'::regprocedure,
  'public.fail_delivery_export_before_issuance(uuid,uuid,text)'::regprocedure,
  'public.finish_delivery_export_before_issuance(uuid,uuid)'::regprocedure,
  'public.maintenance_tick_before_issuance()'::regprocedure] loop
  select proname into new_name from pg_proc where oid=f;
  old_name:=replace(new_name,'_before_issuance','');
  definition:=pg_get_functiondef(f);
  execute replace(definition,old_name||'.',new_name||'.');
 end loop;
end $$;

-- A read includes the database observation time; clients must not infer expiry
-- from an unsynchronized browser wall clock.
create function public.proposal_issuance_status_for_plan(plan_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.generation_plans;result jsonb;begin
 select * into p from public.generation_plans where id=plan_id;
 if p.id is null or app_private.member_role(p.workspace_id) is null then raise exception 'NOT_FOUND';end if;
 select to_jsonb(r)||jsonb_build_object('server_now',clock_timestamp()) into result
 from public.proposal_issuance_status r where r.id=p.issuance_request_id and r.workspace_id=p.workspace_id;
 return result;
end $$;
revoke all on function public.proposal_issuance_status_for_plan(uuid) from public;
do $$ declare r text;begin foreach r in array array['authenticated','tdp_app_authenticated'] loop
 if exists(select 1 from pg_roles where rolname=r) then execute format('grant execute on function public.proposal_issuance_status_for_plan(uuid) to %I',r);end if;
end loop;end $$;

create function app_private.authorize_local_issuance_retry(plan_id uuid,job_id uuid,operation text,idempotency_key text) returns uuid
language plpgsql security definer set search_path='' as $$
declare p public.generation_plans;j public.jobs;r public.proposal_issuance_requests;previous text:=current_setting('app.issuance_authorizing',true);begin
 select * into p from public.generation_plans where id=plan_id;
 if p.id is null or coalesce(app_private.member_role(p.workspace_id),'') not in ('Owner','Editor') then raise exception 'ROLE_FORBIDDEN';end if;
 perform 1 from public.workspaces where id=p.workspace_id for update;
 perform app_private.delivery_actor(p.workspace_id,auth.uid(),true);
 select * into j from public.jobs where id=job_id and workspace_id=p.workspace_id;
 if j.status<>'queued' or j.lease_token is not null or j.lease_until is not null
  or not(j.type='prepare_generated_delivery' and j.entity_id=p.id or j.type='render_delivery' and exists(select 1 from public.proposal_delivery_snapshots s
    where s.id=j.entity_id and s.plan_id=p.id and s.payload->'version'='3'::jsonb))
  or p.stage<>'completed' or not exists(select 1 from public.proposals prop join public.proposal_versions v on v.id=prop.active_version_id
    where prop.id=p.proposal_id and v.plan_id=p.id and v.workspace_id=p.workspace_id
     and (j.type='prepare_generated_delivery' and v.id::text=j.checkpoint->>'generated_version_id' and v.content_hash=j.checkpoint->>'generated_version_hash'
      or j.type='render_delivery' and exists(select 1 from public.proposal_delivery_snapshots s where s.id=j.entity_id
       and s.payload#>>'{generation,proposal_version_id}'=v.id::text and s.payload#>>'{generation,version_content_hash}'=v.content_hash)))
 then raise exception 'PROPOSAL_RENDER_RETRY_REQUIRED';end if;
 insert into public.proposal_issuance_requests(workspace_id,plan_id,requested_by,operation,idempotency_key,accepted_at,deadline_at)
 values(p.workspace_id,p.id,auth.uid(),operation,idempotency_key,transaction_timestamp(),transaction_timestamp()+interval '600 seconds')
 on conflict do nothing returning * into r;
 if r.id is null then
  select * into r from public.proposal_issuance_requests q where q.workspace_id=p.workspace_id and q.plan_id=p.id and q.requested_by=auth.uid()
   and q.operation=authorize_local_issuance_retry.operation and q.idempotency_key=authorize_local_issuance_retry.idempotency_key;
  return r.id;
 end if;
 update public.generation_plans set issuance_request_id=r.id,status='completed',error_code=null,revision=revision+1,updated_at=now() where id=p.id;
 perform set_config('app.issuance_authorizing','true',true);
 update public.jobs set checkpoint=checkpoint||jsonb_build_object('issuance_request_id',r.id,'issuance_deadline_version',1,'minimum_worker_executor',4) where id=j.id;
 perform set_config('app.issuance_authorizing',coalesce(previous,''),true);
 if p.issuance_request_id is not null then perform app_private.fail_proposal_issuance(p.issuance_request_id,'PROPOSAL_ISSUANCE_SUPERSEDED');end if;
 return r.id;
end $$;
revoke all on function app_private.authorize_local_issuance_retry(uuid,uuid,text,text) from public;

alter function app_private.app_command(text,jsonb,text) rename to app_command_before_issuance_retry;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;p public.generation_plans;s public.proposal_delivery_snapshots;j public.jobs;request_id uuid;
 replay app_private.idempotency_records;digest text;previous_independent text:=current_setting('app.issuance_independent_snapshot',true);begin
 if operation='generation.retry' then
  select * into p from public.generation_plans where id=(input->>'id')::uuid;
  if p.stage='completed' and p.issuance_request_id is not null and app_private.member_role(p.workspace_id) is not null then raise exception 'PROPOSAL_RENDER_RETRY_REQUIRED';end if;
 end if;
 if operation='job.action' and input->>'action'='retry' then
  select * into j from public.jobs where id=(input->>'id')::uuid and type='prepare_generated_delivery';
  if j.id is not null then
   perform app_private.delivery_actor(j.workspace_id,auth.uid(),true);
   perform 1 from public.workspaces where id=j.workspace_id for update;
   perform app_private.delivery_actor(j.workspace_id,auth.uid(),true);
   perform app_private.check_keys(input,array['id','expected_revision','action','reason']);
   if length(trim(coalesce(input->>'reason','')))=0 or idempotency_key is null or length(idempotency_key) not between 1 and 200 then raise exception 'INVALID_INPUT';end if;
   digest:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
   select * into replay from app_private.idempotency_records where workspace_id=j.workspace_id and actor_id=auth.uid() and method='COMMAND' and route=operation and key=idempotency_key and expires_at>now();
   if replay.key is not null then if replay.body_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
   select * into j from public.jobs where id=j.id for update;
   if j.revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT';end if;
   if j.status not in ('blocked','failed') or j.lease_token is not null or j.lease_until is not null then raise exception 'STATE_CONFLICT';end if;
   -- This is local projection of an accepted immutable version, not a new AI
   -- generation. Unknown historical usage does not block this explicit action.
   update public.jobs set status='queued',cancel_requested=false,error_code=null,next_attempt_at=now(),revision=revision+1,updated_at=now() where id=j.id;
   request_id:=app_private.authorize_local_issuance_retry(j.entity_id,j.id,operation,idempotency_key);
   select to_jsonb(q)||jsonb_build_object('issuance_request_id',request_id) into result from public.jobs q where id=j.id;
   delete from app_private.idempotency_records where workspace_id=j.workspace_id and actor_id=auth.uid() and method='COMMAND' and route=operation and key=idempotency_key;
   insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(j.workspace_id,auth.uid(),'COMMAND',operation,idempotency_key,digest,result);
   insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(j.workspace_id,auth.uid(),'proposal.issuance.retried','job',j.id,jsonb_build_object('issuance_request_id',request_id,'local_projection',true));
   return result;
  end if;
 end if;
 if operation='delivery.snapshot.retry' then
  select * into s from public.proposal_delivery_snapshots where id=(input->>'snapshot_id')::uuid;
  if s.payload->'version'='1'::jsonb then perform set_config('app.issuance_independent_snapshot',s.id::text,true);end if;
 end if;
 result:=app_private.app_command_before_issuance_retry(operation,input,idempotency_key);
 perform set_config('app.issuance_independent_snapshot',coalesce(previous_independent,''),true);
 if operation='delivery.snapshot.retry' then
  select * into s from public.proposal_delivery_snapshots where id=(result->>'id')::uuid;
  if s.payload->'version'='3'::jsonb and s.plan_id is not null then
   select * into j from public.jobs where id=(select a.job_id from public.proposal_delivery_artifacts a where a.snapshot_id=s.id limit 1);
   if not exists(select 1 from public.proposal_issuance_requests r where r.plan_id=s.plan_id and r.workspace_id=s.workspace_id and r.requested_by=auth.uid() and r.operation=app_command.operation and r.idempotency_key=app_command.idempotency_key) then
    request_id:=app_private.authorize_local_issuance_retry(s.plan_id,j.id,operation,idempotency_key);
   end if;
  end if;
 end if;
 return result;
end $$;
revoke all on function app_private.app_command_before_issuance_retry(text,jsonb,text),app_private.app_command(text,jsonb,text) from public;
do $$ declare r text;begin
 foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function app_private.app_command_before_issuance_retry(text,jsonb,text) from %I',r);end if;
 end loop;
 foreach r in array array['authenticated','tdp_app_authenticated'] loop
  if exists(select 1 from pg_roles where rolname=r) then execute format('grant execute on function app_private.app_command(text,jsonb,text) to %I',r);end if;
 end loop;
end $$;
-- Preserve any qualified parameters in the previously installed command body.
do $$ declare definition text;begin
 definition:=pg_get_functiondef('app_private.app_command_before_issuance_retry(text,jsonb,text)'::regprocedure);
 execute replace(definition,'app_command.','app_command_before_issuance_retry.');
end $$;

-- Explicit least privilege also covers installations with custom default ACLs.
do $$ declare role_name text;begin
 foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then
   execute format('revoke all on function app_private.authorize_local_issuance_retry(uuid,uuid,text,text) from %I',role_name);
  end if;
 end loop;
end $$;
