-- Backward-compatible rollout. Saved remote requests and v1/v2 planning output
-- are immutable; only newly admitted plans use the compact structure/detail path.
-- Legacy routing and task routing must accept the same application ceiling.
do $patch$ declare r record;definition text;begin
 for r in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname like 'reserve%model%' loop
  definition:=pg_get_functiondef(r.oid);
  if position('output_tokens not between 1 and 8192' in definition)>0 then
   execute replace(definition,'output_tokens not between 1 and 8192','output_tokens not between 1 and 40000');
  end if;
 end loop;
end $patch$;
alter table public.generation_plans drop constraint generation_plans_workflow_version_check;
alter table public.generation_plans add constraint generation_plans_workflow_version_check check(workflow_version in (1,2,3));
alter table public.generation_plans drop constraint generation_plans_stage_check;
alter table public.generation_plans add constraint generation_plans_stage_check
 check(stage in ('assessment','analysis','planning','detailing','drafting','commercial','synthesis','review','reconciliation','completed'));

create or replace function app_private.admit_proposal_workflow() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.kind='proposal' and exists(select 1 from app_private.proposal_workflow_admission
  where singleton and enabled and (trial_opportunity_id is null or trial_opportunity_id=new.opportunity_id))
  and exists(select 1 from public.model_execution_settings where workspace_id=new.workspace_id and enabled)
  and not exists(select 1 from public.restore_sessions where workspace_id=new.workspace_id and state='staging') then
  new.workflow_version:=3;
  new.execution_policy:=jsonb_build_object('version',3,'planning_revision',3,
   'verification_output_tokens',coalesce((select (profile->>'max_output_tokens')::integer from public.model_task_routes where workspace_id=new.workspace_id and task='verify_grounding'),40000),
   'draft_output_tokens',coalesce((select (profile->>'max_output_tokens')::integer from public.model_task_routes where workspace_id=new.workspace_id and task='draft_section'),40000),
   'review_output_tokens',coalesce((select (profile->>'max_output_tokens')::integer from public.model_task_routes where workspace_id=new.workspace_id and task='review_proposal'),40000),
   'commercial_output_tokens',coalesce((select (profile->>'max_output_tokens')::integer from public.model_task_routes where workspace_id=new.workspace_id and task='plan_commercial'),40000));
 end if;
 return new;
end $$;
revoke all on function app_private.admit_proposal_workflow() from public,anon,authenticated,service_role;

do $patch$ declare definition text;marker text;begin
 select pg_get_functiondef('public.advance_generation(uuid,uuid,text,jsonb,jsonb,jsonb)'::regprocedure) into definition;
 marker:='when ''planning'' then ''drafting''';
 if position(marker in definition)=0 then raise exception 'Generation stages changed';end if;
 definition:=replace(definition,marker,'when ''planning'' then case when p.workflow_version=3 then ''detailing'' else ''drafting'' end when ''detailing'' then ''drafting''');
 definition:=replace(definition,'when p.workflow_version=2 then','when p.workflow_version>=2 then');
 execute definition;
end $patch$;

-- Independent allowances for new graphs: up to 3 received generation results
-- and 2 received content corrections, with a 5-result aggregate ceiling. Polls
-- and replay of the same receipt never spend another allowance. Old graphs
-- keep the exact budget policy under which their work was accepted.
alter table app_private.model_graph_threads add column budget_version integer not null default 1 check(budget_version in (1,2));
do $patch$ declare definition text;marker text;replacement text;begin
 select pg_get_functiondef('public.model_graph_store(uuid,uuid,text,text,jsonb)'::regprocedure) into definition;
 marker:='array[''input_hash'',''task'',''graph_version'']';
 if position(marker in definition)=0 then raise exception 'Graph init changed';end if;
 definition:=replace(definition,marker,'array[''input_hash'',''task'',''graph_version'',''budget_version'']');
 marker:='values(thread_id,j.workspace_id,j.id,payload->>''input_hash'',payload->>''task'') on conflict(id) do nothing;';
 if position(marker in definition)=0 then raise exception 'Graph insertion changed';end if;
 definition:=replace(definition,'(id,workspace_id,job_id,input_hash,task)', '(id,workspace_id,job_id,input_hash,task,budget_version)');
 definition:=replace(definition,marker,'values(thread_id,j.workspace_id,j.id,payload->>''input_hash'',payload->>''task'',coalesce((payload->>''budget_version'')::integer,1)) on conflict(id) do nothing;');
 marker:=$old$ when 'candidate_budget' then$old$;
 replacement:=$new$ when 'candidate_budget' then
  budget_unit:=coalesce(payload->>'unit','writer');
  if t.budget_version=2 and budget_unit in ('writer','writer-repair') then
   if (select coalesce(sum(b.candidates),0) from app_private.model_graph_budgets b where b.thread_id=t.id and b.unit in ('writer','writer-repair'))>=5 then
    raise exception 'MODEL_OPERATION_BUDGET_EXHAUSTED';
   end if;
   select candidates into candidate_total from app_private.model_graph_budgets b where b.thread_id=t.id and b.unit=budget_unit;
   if budget_unit='writer-repair' and coalesce(candidate_total,0)>=2 then raise exception 'MODEL_CORRECTION_EXHAUSTED';end if;
   if budget_unit='writer' and coalesce(candidate_total,0)>=3 then raise exception 'MODEL_GENERATION_ATTEMPTS_EXHAUSTED';end if;
  end if;
$new$;
 if position(marker in definition)=0 then raise exception 'Graph budget changed';end if;
 definition:=replace(definition,marker,replacement);
 marker:=$old$  if coalesce(candidate_total,0)>=3 then raise exception 'MODEL_CORRECTION_EXHAUSTED';end if;
  update public.provider_usage$old$;
 replacement:=$new$  if t.budget_version=2 and budget_unit in ('writer','writer-repair') then
   if (select coalesce(sum(b.candidates),0) from app_private.model_graph_budgets b where b.thread_id=t.id and b.unit in ('writer','writer-repair'))>=5 then raise exception 'MODEL_OPERATION_BUDGET_EXHAUSTED';end if;
   if budget_unit='writer-repair' and coalesce(candidate_total,0)>=2 then raise exception 'MODEL_CORRECTION_EXHAUSTED';end if;
  end if;
  if coalesce(candidate_total,0)>=3 then raise exception 'MODEL_CORRECTION_EXHAUSTED';end if;
  update public.provider_usage$new$;
 if position(marker in definition)=0 then raise exception 'Graph receipt changed';end if;
 definition:=replace(definition,marker,replacement);
 execute definition;
end $patch$;

-- Both pinned prompt revisions retain the same semantic validation contract.
-- A version suffix must not prevent handing a paid candidate to correction.
do $patch$ declare definition text;marker text;begin
 select pg_get_functiondef('app_private.writer_validation_handoff(uuid,uuid,text,jsonb)'::regprocedure) into definition;
 marker:=$old$coalesce(a.execution_metadata->>'prompt_version','') not like '%.tenderdesk-semantic-fidelity-v1'$old$;
 if position(marker in definition)=0 then raise exception 'Writer handoff prompt guard changed';end if;
 execute replace(definition,marker,$new$coalesce(a.execution_metadata->>'prompt_version','') !~ '\.tenderdesk-semantic-fidelity-v1(\.economy-v1)?$'$new$);
end $patch$;

-- Explicit operator recovery for a failed planning-only trial. Completed
-- analysis, paid receipts, old graph budgets and audit history stay intact.
create function public.upgrade_blocked_proposal_planning(target_plan uuid,actor uuid,expected_revision integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare p public.generation_plans;new_job uuid;
begin
 select * into p from public.generation_plans where id=target_plan;
 if p.id is null then raise exception 'NOT_FOUND';end if;
 perform 1 from public.workspaces where id=p.workspace_id for update;
 select * into p from public.generation_plans where id=target_plan for update;
 if not exists(select 1 from public.memberships where workspace_id=p.workspace_id and user_id=actor and role='Owner' and active) then raise exception 'FORBIDDEN';end if;
 if p.revision<>expected_revision then raise exception 'REVISION_CONFLICT';end if;
 if p.base_version_id is distinct from (select active_version_id from public.proposals where id=p.proposal_id) then raise exception 'STALE_INPUT';end if;
 if p.evidence_revision<>(select evidence_revision from public.workspaces where id=p.workspace_id) then
  perform app_private.refresh_proposal_evidence(p.id);
  select * into p from public.generation_plans where id=target_plan;
 end if;
 if p.kind<>'proposal' or p.workflow_version<>2 or p.stage<>'planning' or p.status<>'blocked'
  or exists(select 1 from public.generation_steps where plan_id=p.id and stage='planning' and status='completed' and task='plan_proposal')
  or exists(select 1 from public.jobs where entity_id=p.id and status='running')
  or exists(select 1 from public.provider_usage where job_id in(select job_id from public.generation_steps where plan_id=p.id) and state in ('reserved','unknown')) then raise exception 'PLANNING_UPGRADE_NOT_SAFE';end if;
 update public.jobs set status='canceled',cancel_requested=true,error_code='PLANNING_SUPERSEDED',lease_token=null,lease_until=null,revision=revision+1,updated_at=now()
  where id in(select job_id from public.generation_steps where plan_id=p.id and stage='planning' and status='queued');
 update public.generation_steps set status='split',revision=revision+1,updated_at=now() where plan_id=p.id and stage='planning' and status='queued';
 update public.generation_plans set workflow_version=3,status='running',error_code=null,
  execution_policy=jsonb_build_object('version',3,'planning_revision',3,'verification_output_tokens',40000,'draft_output_tokens',40000,'review_output_tokens',40000,'commercial_output_tokens',40000),
  revision=revision+1,updated_at=now() where id=p.id returning * into p;
 new_job:=app_private.enqueue_generation(p,'plan_proposal','{"workflow_version":3,"planning_phase":"structure","id_aliases_version":1,"requirement_scope":"all","requirement_ids":[]}');
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details)
 values(p.workspace_id,actor,'proposal.planning.upgrade','generation_plan',p.id,jsonb_build_object('workflow_version',3,'preserved_analysis',true,'preserved_usage',true));
 return new_job;
end $$;
revoke all on function public.upgrade_blocked_proposal_planning(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.upgrade_blocked_proposal_planning(uuid,uuid,integer) to service_role;
