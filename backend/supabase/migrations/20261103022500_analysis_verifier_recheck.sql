-- A deliberate, separately budgeted verification of one retained analysis
-- candidate. This never retries its writer or changes historical accounting.
create table app_private.analysis_verifier_rechecks (
 child_job_id uuid primary key references public.jobs(id),
 parent_job_id uuid not null unique references public.jobs(id),
 workspace_id uuid not null references public.workspaces(id),
 plan_id uuid not null references public.generation_plans(id),
 parent_step_id uuid not null unique references public.generation_steps(id),
 child_step_id uuid not null unique references public.generation_steps(id),
 parent_thread_id text not null references app_private.model_graph_threads(id),
 child_thread_id text not null unique check(child_thread_id ~ '^[a-f0-9]{64}$'),
 candidate_id uuid not null references app_private.model_graph_results(id),
 candidate_content_hash text not null check(candidate_content_hash ~ '^[a-f0-9]{64}$'),
 candidate_hash text not null check(candidate_hash ~ '^[a-f0-9]{64}$'),
 graph_input_hash text not null check(graph_input_hash ~ '^[a-f0-9]{64}$'),
 plan_input_hash text not null,
 writer_usage_id uuid not null references public.provider_usage(id),
 writer_attempt_id bigint not null references public.model_attempts(id),
 requested_by uuid not null,
 requested_at timestamptz not null default clock_timestamp(),
 idempotency_key text not null,
 request_hash text not null,
 reason text not null,
 verification_revision integer not null default 4 check(verification_revision=4),
 verifier_limit integer not null default 3 check(verifier_limit=3),
 verifier_repair_limit integer not null default 1 check(verifier_repair_limit=1)
);
alter table app_private.analysis_verifier_rechecks enable row level security;
revoke all on app_private.analysis_verifier_rechecks from public;

-- Check this on every child execution, not only when the Owner requests it.
-- The private lineage remains authoritative even if a job checkpoint is lost.
create function app_private.analysis_recheck_binding(job_id uuid)
returns app_private.analysis_verifier_rechecks language plpgsql security definer set search_path='' as $$
declare r app_private.analysis_verifier_rechecks;j public.jobs;p public.generation_plans;
 candidate app_private.model_graph_results;u public.provider_usage;a public.model_attempts;
begin
 select * into j from public.jobs where id=job_id;
 select * into r from app_private.analysis_verifier_rechecks where child_job_id=job_id;
 if r.child_job_id is null then
  if j.checkpoint ? 'verifier_recheck' then raise exception 'MODEL_RECHECK_IDENTITY_CHANGED';end if;
  return r;
 end if;
 select * into p from public.generation_plans where id=r.plan_id and workspace_id=r.workspace_id;
 if j.workspace_id is distinct from r.workspace_id or j.entity_id is distinct from p.id or j.type is distinct from 'analyze_chunk'
  or j.input_hash is distinct from r.plan_input_hash or p.input_hash is distinct from r.plan_input_hash
  or p.input_hash is distinct from encode(sha256(convert_to(p.frozen_context::text,'UTF8')),'hex')
  or j.checkpoint->'verifier_recheck' is distinct from jsonb_build_object('version',1,'parent_job_id',r.parent_job_id,
   'parent_thread_id',r.parent_thread_id,'candidate_id',r.candidate_id,'candidate_hash',r.candidate_hash,'input_hash',r.graph_input_hash)
  or not exists(select 1 from public.generation_steps child join public.generation_steps parent
   on parent.id=r.parent_step_id and parent.plan_id=child.plan_id and parent.workspace_id=child.workspace_id
   where child.id=r.child_step_id and child.job_id=j.id and child.plan_id=p.id and child.workspace_id=r.workspace_id
    and child.task='analyze_chunk' and child.stage='analysis' and child.input=parent.input and parent.status='split'
    and parent.job_id=r.parent_job_id and parent.task='analyze_chunk' and parent.stage='analysis')
  then raise exception 'MODEL_RECHECK_IDENTITY_CHANGED';end if;
 select * into candidate from app_private.model_graph_results where id=r.candidate_id and thread_id=r.parent_thread_id;
 select * into u from public.provider_usage retained_usage where retained_usage.id=r.writer_usage_id and retained_usage.job_id=r.parent_job_id and retained_usage.workspace_id=r.workspace_id;
 select * into a from public.model_attempts retained_attempt where retained_attempt.id=r.writer_attempt_id and retained_attempt.job_id=r.parent_job_id and retained_attempt.workspace_id=r.workspace_id;
 if candidate.id is null or candidate.result_key<>'candidate-0' or candidate.content_hash<>r.candidate_content_hash
  or candidate.content_hash<>encode(sha256(convert_to(candidate.value::text,'UTF8')),'hex')
  or u.state is distinct from 'settled' or not u.graph_candidate_recorded or u.actual_input is null or u.actual_output is null
  or a.usage_id is distinct from u.id or a.status is distinct from 'succeeded' or not a.sent or a.operation is distinct from 'analyze_chunk'
  or candidate.value#>>'{producer,provider}' is distinct from u.provider
  or candidate.value#>>'{producer,model}' is distinct from u.model
  or candidate.value#>>'{producer,project}' is distinct from u.remote_project_ref
  or candidate.value#>>'{producer,connectionId}' is distinct from u.connection_id::text
  or candidate.value#>>'{producer,modelId}' is distinct from u.model_config_id::text
  or a.provider is distinct from u.provider or a.model is distinct from u.model or a.project_ref is distinct from u.remote_project_ref
  or a.connection_id is distinct from u.connection_id or a.model_config_id is distinct from u.model_config_id
  or a.execution_metadata->>'input_hash' is distinct from u.input_hash
  or a.execution_metadata->>'graph_thread' is distinct from r.parent_thread_id
  or regexp_replace(u.call_key, ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$', '') is distinct from 'step:'||r.parent_step_id||':candidate-0'
  or coalesce(a.execution_metadata->>'prompt_version','') not like 'analyze_chunk.%'
  or not exists(select 1 from app_private.model_graph_threads t where t.id=r.parent_thread_id and t.job_id=r.parent_job_id
   and t.workspace_id=r.workspace_id and t.input_hash=r.graph_input_hash and t.task='analyze_chunk' and t.status='needs_review' and t.result_id is null)
  or exists(select 1 from unnest(array['verification-','verification-repair-']) phase where not exists(
   select 1 from app_private.model_graph_results pin where pin.thread_id=r.parent_thread_id
    and pin.result_key='verification-instructions-'||encode(sha256(convert_to('step:'||r.parent_step_id||':'||phase||r.candidate_hash,'UTF8')),'hex')
    and pin.value->>'version' in ('1','2','3')))
  then raise exception 'MODEL_RECHECK_IDENTITY_CHANGED';end if;
 if exists(select 1 from public.provider_usage x where x.job_id=r.parent_job_id and x.workspace_id=r.workspace_id and
  (x.state='reserved' or (x.state='unknown' and (x.error_code is distinct from 'PROVIDER_BACKGROUND_TERMINATED'
   or nullif(trim(x.remote_request_id),'') is null or nullif(trim(x.remote_project_ref),'') is null or nullif(trim(x.model),'') is null))))
  or exists(select 1 from public.jobs parent where parent.id=r.parent_job_id and
   (parent.status<>'canceled' or parent.lease_token is not null or parent.lease_until is not null))
  then raise exception 'USAGE_REVIEW_REQUIRED';end if;
 if not exists(select 1 from public.memberships m join public.identity_allowlist allowed
  on allowed.workspace_id=m.workspace_id and allowed.user_id=m.user_id and allowed.status='active'
  where m.workspace_id=r.workspace_id and m.user_id=r.requested_by and m.active and m.role='Owner') then raise exception 'ROLE_FORBIDDEN';end if;
 return r;
end $$;
revoke all on function app_private.analysis_recheck_binding(uuid) from public;

create function app_private.recheck_analysis_verifier(payload jsonb,idempotency_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();w uuid;j public.jobs;p public.generation_plans;s public.generation_steps;
 t app_private.model_graph_threads;c app_private.model_graph_results;u public.provider_usage;a public.model_attempts;
 r app_private.analysis_verifier_rechecks;digest text;child uuid;child_step uuid;child_thread text;result jsonb;
begin
 perform app_private.check_keys(payload,array['id','expected_revision','expected_plan_revision','expected_step_revision',
  'parent_thread_id','candidate_id','candidate_content_hash','candidate_hash','writer_usage_id','expected_input_hash','expected_graph_input_hash','reason']);
 if actor is null or idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(payload)>16384
  or length(trim(coalesce(payload->>'reason',''))) not between 1 and 1000
  or coalesce((payload->>'expected_plan_revision')::bigint,0)<1 then raise exception 'INVALID_INPUT';end if;
 select workspace_id into w from public.jobs where id=(payload->>'id')::uuid;
 if w is null or coalesce(app_private.member_role(w),'')<>'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 perform 1 from public.workspaces where id=w for update;
 if coalesce(app_private.member_role(w),'')<>'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 digest:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 select * into r from app_private.analysis_verifier_rechecks where parent_job_id=(payload->>'id')::uuid;
 if r.child_job_id is not null then
  if r.requested_by is distinct from actor or r.idempotency_key<>idempotency_key or r.request_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  return jsonb_build_object('id',r.child_job_id,'step_id',r.child_step_id,'plan_id',r.plan_id,'parent_job_id',r.parent_job_id);
 end if;
 if exists(select 1 from app_private.analysis_verifier_rechecks where workspace_id=w and requested_by=actor and analysis_verifier_rechecks.idempotency_key=recheck_analysis_verifier.idempotency_key)
  then raise exception 'IDEMPOTENCY_CONFLICT';end if;
 select * into j from public.jobs where id=(payload->>'id')::uuid and workspace_id=w for update;
 select * into p from public.generation_plans where id=j.entity_id and workspace_id=w for update;
 select * into s from public.generation_steps where job_id=j.id and plan_id=p.id and workspace_id=w for update;
 -- Sibling completion/failure and evidence refresh advance the shared plan
 -- revision. Bind the selected job/step and all actual plan business state;
 -- retain the inspected plan revision as audit metadata, not a false conflict.
 if j.revision is distinct from (payload->>'expected_revision')::int
  or s.revision is distinct from (payload->>'expected_step_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 if p.kind is distinct from 'proposal' or p.stage is distinct from 'analysis' or p.status not in ('queued','running','blocked')
  or p.id is distinct from (select latest.id from public.generation_plans latest where latest.workspace_id=w and latest.proposal_id=p.proposal_id order by latest.created_at desc,latest.id desc limit 1)
  or p.base_version_id is distinct from (select active_version_id from public.proposals where workspace_id=w and id=p.proposal_id)
  or not exists(select 1 from public.opportunities where workspace_id=w and id=p.opportunity_id and decision='shortlisted' and not archived)
  or s.status is distinct from 'queued' or s.task is distinct from 'analyze_chunk' or s.stage is distinct from 'analysis' or s.repair_count<>0
  or j.type is distinct from 'analyze_chunk' or j.status not in ('blocked','failed') or j.error_code is distinct from 'MODEL_CORRECTION_EXHAUSTED'
  or j.cancel_requested or j.lease_token is not null or j.lease_until is not null or j.checkpoint ? 'verifier_recheck'
  or exists(select 1 from app_private.analysis_verifier_rechecks where child_job_id=j.id)
  then raise exception 'STATE_CONFLICT';end if;
 if j.input_hash is distinct from p.input_hash or p.input_hash is distinct from payload->>'expected_input_hash'
  or p.input_hash is distinct from encode(sha256(convert_to(p.frozen_context::text,'UTF8')),'hex') then raise exception 'STALE_INPUT';end if;
 perform app_private.refresh_proposal_evidence(p.id);
 if exists(select 1 from public.restore_sessions where workspace_id=w and state in ('staging','committing')) then raise exception 'RESTORE_IN_PROGRESS';end if;
 if exists(select 1 from public.provider_usage x where x.job_id=j.id and x.workspace_id=w and
  (x.state='reserved' or (x.state='unknown' and (x.error_code is distinct from 'PROVIDER_BACKGROUND_TERMINATED'
   or nullif(trim(x.remote_request_id),'') is null or nullif(trim(x.remote_project_ref),'') is null or nullif(trim(x.model),'') is null)))) then raise exception 'USAGE_REVIEW_REQUIRED';end if;
 select * into t from app_private.model_graph_threads where id=payload->>'parent_thread_id' and job_id=j.id and workspace_id=w for update;
 select * into c from app_private.model_graph_results where id=(payload->>'candidate_id')::uuid and thread_id=t.id;
 if t.id is null or t.task<>'analyze_chunk' or t.status<>'needs_review' or t.result_id is not null or t.candidate_count<>1
  or t.input_hash is distinct from payload->>'expected_graph_input_hash' or c.id is null or c.result_key<>'candidate-0'
  or c.content_hash is distinct from payload->>'candidate_content_hash'
  or c.content_hash<>encode(sha256(convert_to(c.value::text,'UTF8')),'hex')
  or c.value ? 'local_validation' or jsonb_typeof(c.value->'result') is distinct from 'object'
  or coalesce(payload->>'candidate_hash','') !~ '^[a-f0-9]{64}$'
  or (select candidates from app_private.model_graph_budgets where thread_id=t.id and unit='writer') is distinct from 1
  or exists(select 1 from app_private.model_graph_results where thread_id=t.id and (result_key='accepted' or result_key ~ '^candidate-[1-9]'))
  or not exists(select 1 from app_private.model_graph_results where thread_id=t.id and result_key='invalid-verification-repair-'||(payload->>'candidate_hash')
    and value#>>'{result,checked_candidate_hash}'=payload->>'candidate_hash') then raise exception 'MODEL_RECHECK_IDENTITY_CHANGED';end if;
 select * into u from public.provider_usage where id=(payload->>'writer_usage_id')::uuid and job_id=j.id and workspace_id=w;
 select * into a from public.model_attempts where usage_id=u.id and job_id=j.id and workspace_id=w and operation='analyze_chunk' and status='succeeded' and sent order by id desc limit 1;
 if u.id is null or a.id is null or u.state<>'settled' or not u.graph_candidate_recorded or u.actual_input is null or u.actual_output is null
  or u.connection_id is null or u.model_config_id is null or nullif(trim(u.remote_project_ref),'') is null
  or (select count(distinct usage_id) from public.model_attempts where job_id=j.id and operation='analyze_chunk' and status='succeeded' and sent)<>1
  then raise exception 'MODEL_RECHECK_WRITER_UNSETTLED';end if;
 child:=app_private.enqueue_generation(p,'analyze_chunk',s.input,s.depth);
 select id into child_step from public.generation_steps where job_id=child and workspace_id=w;
 child_thread:=encode(sha256(convert_to(child::text||':step:'||child_step::text||':'||t.input_hash,'UTF8')),'hex');
 update public.generation_steps set status='split',revision=revision+1,updated_at=now() where id=s.id;
 update public.jobs set status='canceled',cancel_requested=true,revision=revision+1,updated_at=now() where id=j.id;
 update public.jobs set checkpoint=checkpoint||jsonb_build_object('verifier_recheck',jsonb_build_object('version',1,'parent_job_id',j.id,
  'parent_thread_id',t.id,'candidate_id',c.id,'candidate_hash',payload->>'candidate_hash','input_hash',t.input_hash)),created_by=actor where id=child;
 insert into app_private.analysis_verifier_rechecks(child_job_id,parent_job_id,workspace_id,plan_id,parent_step_id,child_step_id,parent_thread_id,child_thread_id,
  candidate_id,candidate_content_hash,candidate_hash,graph_input_hash,plan_input_hash,writer_usage_id,writer_attempt_id,requested_by,idempotency_key,request_hash,reason)
 values(child,j.id,w,p.id,s.id,child_step,t.id,child_thread,c.id,c.content_hash,payload->>'candidate_hash',t.input_hash,p.input_hash,u.id,a.id,actor,idempotency_key,digest,payload->>'reason');
 perform app_private.analysis_recheck_binding(child);
 -- A split parent is already excluded by normal completed-step aggregation.
 -- The audit names this action honestly; no truncation/error is fabricated.
 update public.generation_plans set status=case when exists(select 1 from public.jobs where workspace_id=w and entity_id=p.id and status='running') then 'running' else 'queued' end,
  error_code=null,revision=revision+1,updated_at=now() where id=p.id;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,reason,request_id,details)
 values(w,actor,'generation.verifier_recheck','job',child,payload->>'reason',gen_random_uuid(),
  jsonb_build_object('selected_plan_revision',(payload->>'expected_plan_revision')::bigint,'observed_plan_revision',p.revision));
 result:=jsonb_build_object('id',child,'step_id',child_step,'plan_id',p.id,'parent_job_id',j.id);
 return result;
end $$;
revoke all on function app_private.recheck_analysis_verifier(jsonb,text) from public;

-- Preserve the old plan-wide receipt. Only this requested child receives the
-- new timestamp, and all existing source/classification/revocation checks run.
do $$ declare definition text;marker text;replacement text;begin
 select pg_get_functiondef('app_private.check_requested_model_payload(uuid,text,jsonb)'::regprocedure) into definition;
 marker:='requested:=request.plan_id is not null;';
 replacement:=$patch$if exists(select 1 from app_private.analysis_verifier_rechecks where child_job_id=j.id) or j.checkpoint ? 'verifier_recheck' then
   perform app_private.analysis_recheck_binding(j.id);
   select p.id,p.workspace_id,r.requested_by,'job.action',r.idempotency_key,r.requested_at into request
    from app_private.analysis_verifier_rechecks r where r.child_job_id=j.id;
  end if;
  requested:=request.plan_id is not null;$patch$;
 if position(marker in definition)=0 then raise exception 'RECHECK_PROCESSING_GUARD_CHANGED';end if;
 execute replace(definition,marker,replacement);
end $$;

-- Graph writes cannot erase the lineage or manufacture another writer result.
create function app_private.guard_analysis_recheck_graph(job_id uuid,thread_id text,action text,payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare r app_private.analysis_verifier_rechecks;c app_private.model_graph_results;budget_unit text;n integer;cap integer;
begin
 r:=app_private.analysis_recheck_binding(job_id);if r.child_job_id is null then return;end if;
 if thread_id is distinct from r.child_thread_id then raise exception 'MODEL_RECHECK_IDENTITY_CHANGED';end if;
 if action='init' and (payload->>'input_hash' is distinct from r.graph_input_hash or payload->>'task' is distinct from 'analyze_chunk'
  or payload->>'budget_version' is distinct from '2') then raise exception 'MODEL_RECHECK_IDENTITY_CHANGED';end if;
 if action not in ('init','recheck_seed','get','list','put','writes','result_put','result_get','candidate_budget','candidate_received','accept','needs_review','yield')
  then raise exception 'MODEL_RECHECK_WRITER_FORBIDDEN';end if;
 if action in ('candidate_budget','candidate_received') then
  budget_unit:=payload->>'unit';
  cap:=case budget_unit when 'verifier-'||r.candidate_hash then r.verifier_limit when 'verifier-repair-'||r.candidate_hash then r.verifier_repair_limit end;
  if cap is null then raise exception 'MODEL_RECHECK_WRITER_FORBIDDEN';end if;
  select candidates into n from app_private.model_graph_budgets where model_graph_budgets.thread_id=r.child_thread_id and model_graph_budgets.unit=budget_unit;
  if coalesce(n,0)>=cap and not(action='candidate_received' and exists(select 1 from public.provider_usage where id=(payload->>'usage_id')::uuid and provider_usage.job_id=guard_analysis_recheck_graph.job_id and graph_candidate_recorded)) then raise exception 'MODEL_CORRECTION_EXHAUSTED';end if;
  if action='candidate_received' and not exists(select 1 from public.provider_usage receipt where receipt.id=(payload->>'usage_id')::uuid
   and receipt.job_id=guard_analysis_recheck_graph.job_id and regexp_replace(receipt.call_key, ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$', '')=
    'step:'||r.child_step_id||':'||case when budget_unit='verifier-'||r.candidate_hash then 'verification-' else 'verification-repair-' end||r.candidate_hash)
   then raise exception 'MODEL_RECHECK_IDENTITY_CHANGED';end if;
 end if;
 if action='result_put' then
  select * into c from app_private.model_graph_results where id=r.candidate_id;
  if (payload->>'key' like 'candidate-%' and (payload->>'key'<>'candidate-0' or payload->'value' is distinct from c.value))
   or (payload->>'key'='accepted' and payload->'value' is distinct from c.value->'result') then raise exception 'MODEL_RECHECK_WRITER_FORBIDDEN';end if;
  if payload->>'key' like 'verification-instructions-%' and payload#>>'{value,version}' is distinct from '4' then raise exception 'MODEL_RECHECK_IDENTITY_CHANGED';end if;
 end if;
end $$;
revoke all on function app_private.guard_analysis_recheck_graph(uuid,text,text,jsonb) from public;

do $$ declare definition text;marker text;replacement text;begin
 select pg_get_functiondef('public.model_graph_store(uuid,uuid,text,text,jsonb)'::regprocedure) into definition;
 marker:='j:=app_private.model_job(job_id,lease);';
 replacement:=marker||$patch$
 perform app_private.guard_analysis_recheck_graph(job_id,thread_id,action,payload);
 if action='recheck_seed' then
  return (select jsonb_build_object('version',1,'parent_job_id',recheck_lineage.parent_job_id,'parent_thread_id',recheck_lineage.parent_thread_id,
   'candidate_id',recheck_lineage.candidate_id,'candidate_hash',recheck_lineage.candidate_hash,'input_hash',recheck_lineage.graph_input_hash,'value',recheck_candidate.value,'verification_revision',4)
   from app_private.analysis_verifier_rechecks recheck_lineage join app_private.model_graph_results recheck_candidate on recheck_candidate.id=recheck_lineage.candidate_id
   where recheck_lineage.child_job_id=j.id and recheck_lineage.child_thread_id=model_graph_store.thread_id and payload->>'input_hash'=recheck_lineage.graph_input_hash and payload->>'task'='analyze_chunk');
 end if;$patch$;
 if position(marker in definition)=0 then raise exception 'RECHECK_GRAPH_GUARD_CHANGED';end if;
 execute replace(definition,marker,replacement);
end $$;

-- Every provider entry point checks the authoritative lineage before starting
-- an attempt, reserving tokens, or rebinding an accepted remote request.
create function app_private.guard_analysis_recheck_request(job_id uuid,operation text,phase text default null)
returns void language plpgsql security definer set search_path='' as $$
declare r app_private.analysis_verifier_rechecks;
begin
 r:=app_private.analysis_recheck_binding(job_id);if r.child_job_id is null then return;end if;
 if operation is distinct from 'verify_grounding' then raise exception 'MODEL_RECHECK_WRITER_FORBIDDEN';end if;
 if phase is not null and phase not in ('step:'||r.child_step_id||':verification-'||r.candidate_hash,'step:'||r.child_step_id||':verification-repair-'||r.candidate_hash)
  then raise exception 'MODEL_RECHECK_WRITER_FORBIDDEN';end if;
end $$;
revoke all on function app_private.guard_analysis_recheck_request(uuid,text,text) from public;

create function app_private.guard_analysis_recheck_reservation(job_id uuid,lease uuid,call_key text,input_hash text,target_model uuid,target_connection uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r app_private.analysis_verifier_rechecks;phase text;budget_unit text;cap integer;attempt public.model_attempts;
begin
 r:=app_private.analysis_recheck_binding(job_id);if r.child_job_id is null then return;end if;
 phase:=regexp_replace(call_key, ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$', '');
 perform app_private.guard_analysis_recheck_request(job_id,'verify_grounding',phase);
 if call_key is distinct from phase||':'||left(input_hash,16)||':'||(select attempts::text from public.jobs where id=job_id)||':'||target_model::text
  then raise exception 'MODEL_RECHECK_IDENTITY_CHANGED';end if;
 budget_unit:=case when phase='step:'||r.child_step_id||':verification-'||r.candidate_hash then 'verifier-'||r.candidate_hash else 'verifier-repair-'||r.candidate_hash end;
 cap:=case when budget_unit='verifier-'||r.candidate_hash then r.verifier_limit else r.verifier_repair_limit end;
 if coalesce((select candidates from app_private.model_graph_budgets b where b.thread_id=r.child_thread_id and b.unit=budget_unit),0)>=cap
  then raise exception 'MODEL_CORRECTION_EXHAUSTED';end if;
 if not exists(select 1 from app_private.model_graph_results pin where pin.thread_id=r.child_thread_id
   and pin.result_key='verification-instructions-'||encode(sha256(convert_to(phase,'UTF8')),'hex') and pin.value->>'version'='4')
  or not exists(select 1 from app_private.model_graph_results pin where pin.thread_id=r.child_thread_id
   and pin.result_key='semantic-instructions-'||encode(sha256(convert_to(phase,'UTF8')),'hex') and pin.value->>'version'='4')
  or not exists(select 1 from app_private.model_graph_results seeded join app_private.model_graph_results original on original.id=r.candidate_id
   where seeded.thread_id=r.child_thread_id and seeded.result_key='candidate-0' and seeded.value=original.value)
  then raise exception 'MODEL_RECHECK_IDENTITY_CHANGED';end if;
 select * into attempt from public.model_attempts a where a.job_id=guard_analysis_recheck_reservation.job_id and a.lease_token=lease
  and a.model_config_id=target_model and a.connection_id=target_connection and a.operation='verify_grounding' and a.status='running' order by a.id desc limit 1;
 if attempt.id is null or attempt.execution_metadata->>'input_hash' is distinct from input_hash
  or attempt.execution_metadata->>'graph_thread' is distinct from r.child_thread_id
  or attempt.execution_metadata->>'prompt_version' is distinct from 'tenderdesk-grounding-v4-analysis-boundary.evidence-v1.tenderdesk-semantic-fidelity-v1.economy-v1'
  then raise exception 'MODEL_RECHECK_IDENTITY_CHANGED';end if;
 if exists(select 1 from public.provider_usage old_usage where old_usage.job_id=r.parent_job_id and old_usage.input_hash=guard_analysis_recheck_reservation.input_hash)
  then raise exception 'MODEL_RECHECK_IDENTITY_CHANGED';end if;
end $$;
revoke all on function app_private.guard_analysis_recheck_reservation(uuid,uuid,text,text,uuid,uuid) from public;

do $$ declare signature text;definition text;marker text;guard text;begin
 foreach signature in array array[
  'public.prepare_task_model_route(uuid,uuid,text,jsonb,text)',
  'public.start_task_model_attempt(uuid,uuid,uuid,uuid,text)',
  'public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)',
  'public.resume_task_model_request_phase(uuid,uuid,text,jsonb,uuid,uuid,text)',
  'public.resume_task_model_request(uuid,uuid,text,jsonb,uuid,uuid)',
  'public.resume_model_request(uuid,uuid,text,text,jsonb)',
  'public.prepare_model_routing(uuid,uuid,jsonb)',
  'public.model_preflight(uuid,uuid,jsonb)',
  'public.model_preflight_core(uuid,uuid,jsonb)',
  'public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text)',
  'public.start_model_attempt(uuid,uuid,text,text,text,text)'
 ] loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  marker:='j:=app_private.model_job(job_id,lease);';
  if signature like 'public.prepare_task_model_route%' then guard:='perform app_private.guard_analysis_recheck_request(job_id,task_name);';
  elsif signature like 'public.start_task_model_attempt%' then guard:='perform app_private.guard_analysis_recheck_request(job_id,operation_name);';
  elsif signature like 'public.reserve_task_model_call%' then guard:=$guard$perform app_private.guard_analysis_recheck_request(job_id,j.checkpoint#>>'{model_operation,task}',regexp_replace(call_key, ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$', ''));
 perform app_private.guard_analysis_recheck_reservation(job_id,lease,call_key,input_hash,target_model,target_connection);$guard$;
  elsif signature like 'public.resume_task_model_request_phase%' then guard:=$guard$perform app_private.guard_analysis_recheck_request(job_id,j.checkpoint#>>'{model_operation,task}',request_prefix);$guard$;
  else guard:='perform app_private.guard_analysis_recheck_request(job_id,''legacy_or_unscoped'');';end if;
  if position(marker in definition)=0 then
   -- Legacy RPCs predate model_job but all enter their body with BEGIN.
   marker:=E'\nBEGIN\n';if position(marker in definition)=0 then marker:=E'\nbegin\n';end if;
  end if;
  if position(marker in definition)=0 then raise exception 'RECHECK_REQUEST_GUARD_CHANGED';end if;
  execute replace(definition,marker,marker||E'\n '||guard);
 end loop;
end $$;

-- The borrowed writer lives in the parent job. New verifier telemetry must not
-- incorrectly describe the same model configuration as independent merely
-- because this child correctly has no writer attempts of its own.
do $$ declare definition text;marker text;replacement text;begin
 select pg_get_functiondef('public.record_model_request_metadata(bigint,uuid,jsonb)'::regprocedure) into definition;
 marker:='and writer.model_config_id=a.model_config_id) else null end)';
 replacement:=$patch$and writer.model_config_id=a.model_config_id)
    or exists(select 1 from app_private.analysis_verifier_rechecks recheck_lineage
     join public.model_attempts parent_writer on parent_writer.id=recheck_lineage.writer_attempt_id
     where recheck_lineage.child_job_id=j.id and parent_writer.model_config_id=a.model_config_id)
    else null end)$patch$;
 if position(marker in definition)=0 then raise exception 'RECHECK_VERIFIER_METADATA_CHANGED';end if;
 execute replace(definition,marker,replacement);
end $$;

-- Managed PostgreSQL uses tdp_app_* roles; hosted Supabase uses the legacy
-- names. Apply the same private ACL without requiring either deployment's
-- other role family to exist. Existing inherited owner membership is unchanged.
do $$ declare role_name text;signature text;begin
 foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
  if not exists(select 1 from pg_roles where rolname=role_name) then continue;end if;
  execute format('revoke all on app_private.analysis_verifier_rechecks from %I',role_name);
  foreach signature in array array[
   'app_private.analysis_recheck_binding(uuid)',
   'app_private.recheck_analysis_verifier(jsonb,text)',
   'app_private.guard_analysis_recheck_graph(uuid,text,text,jsonb)',
   'app_private.guard_analysis_recheck_request(uuid,text,text)',
   'app_private.guard_analysis_recheck_reservation(uuid,uuid,text,text,uuid,uuid)'
  ] loop execute format('revoke all on function %s from %I',signature,role_name);end loop;
 end loop;
end $$;
