-- Install readers before admitting the new workflow. Existing paid plans keep
-- version 1, their frozen inputs and every accepted remote request.
alter table public.generation_plans
 add column workflow_version integer not null default 1 check(workflow_version in (1,2)),
 add column execution_policy jsonb not null default '{}' check(pg_column_size(execution_policy)<=4096);
create table app_private.proposal_workflow_admission (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 trial_opportunity_id uuid references public.opportunities(id)
);
insert into app_private.proposal_workflow_admission(singleton) values(true);
revoke all on app_private.proposal_workflow_admission from public,anon,authenticated,service_role;

create function app_private.admit_proposal_workflow() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.kind='proposal' and exists(select 1 from app_private.proposal_workflow_admission
  where singleton and enabled and (trial_opportunity_id is null or trial_opportunity_id=new.opportunity_id))
  and exists(select 1 from public.model_execution_settings where workspace_id=new.workspace_id and enabled)
  and not exists(select 1 from public.restore_sessions where workspace_id=new.workspace_id and state='staging') then
  new.workflow_version:=2;
  new.execution_policy:=jsonb_build_object('version',2,
   'verification_output_tokens',coalesce((select (profile->>'max_output_tokens')::integer from public.model_task_routes where workspace_id=new.workspace_id and task='verify_grounding'),16384),
   'draft_output_tokens',coalesce((select (profile->>'max_output_tokens')::integer from public.model_task_routes where workspace_id=new.workspace_id and task='draft_section'),16384),
   'review_output_tokens',coalesce((select (profile->>'max_output_tokens')::integer from public.model_task_routes where workspace_id=new.workspace_id and task='review_proposal'),16384),
   'commercial_output_tokens',coalesce((select (profile->>'max_output_tokens')::integer from public.model_task_routes where workspace_id=new.workspace_id and task='plan_commercial'),8192));
 end if;
 return new;
end $$;
revoke all on function app_private.admit_proposal_workflow() from public,anon,authenticated,service_role;
create trigger admit_proposal_workflow before insert on public.generation_plans
 for each row execute function app_private.admit_proposal_workflow();

alter table public.generation_plans drop constraint generation_plans_stage_check;
alter table public.generation_plans add constraint generation_plans_stage_check
 check(stage in ('assessment','analysis','planning','drafting','commercial','synthesis','review','reconciliation','completed'));

do $patch$ declare definition text;marker text;begin
 select pg_get_functiondef('public.advance_generation(uuid,uuid,text,jsonb,jsonb,jsonb)'::regprocedure) into definition;
 marker:='when ''commercial'' then ''review'' when ''review'' then ''completed''';
 if position(marker in definition)=0 then raise exception 'Generation stages changed';end if;
 definition:=replace(definition,marker,'when ''commercial'' then case when p.workflow_version=2 then ''synthesis'' else ''review'' end when ''synthesis'' then ''review'' when ''review'' then case when p.workflow_version=2 then ''reconciliation'' else ''completed'' end when ''reconciliation'' then ''completed''');
 execute definition;
end $patch$;
