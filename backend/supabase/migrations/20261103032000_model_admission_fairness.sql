-- Accepted-request polls must not consume the next business class's turn to
-- start model work when a provider slot becomes free. Keep the original six
-- local/poll/business slots and their owner/deadline/source ordering intact.
create table app_private.queue_model_admission_state (
 workspace_id uuid primary key references public.workspaces(id) on delete cascade,
 next_class text not null default 'proposal' check(next_class in ('proposal','background')),
 dispatch_count bigint not null default 0 check(dispatch_count>=0)
);
alter table app_private.queue_model_admission_state enable row level security;
revoke all on app_private.queue_model_admission_state from public;
do $$ declare role_name text;begin
 foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then
   execute format('revoke all on app_private.queue_model_admission_state from %I',role_name);
  end if;
 end loop;
end $$;

do $patch$ declare definition text;marker text;replacement text;predicate text;predicate_start integer;predicate_end integer;
 class_join text;admission_join text;begin
 select pg_get_functiondef('app_private.next_fair_job(uuid,boolean)'::regprocedure) into definition;
 marker:=';capacity boolean;';
 if position(marker in definition)=0 then raise exception 'MODEL_ADMISSION_DECLARATION_CHANGED';end if;
 definition:=replace(definition,marker,';capacity boolean;admission app_private.queue_model_admission_state;');
 marker:='select * into scheduler from app_private.queue_dispatch_state where workspace_id=workspace for update;';
 replacement:=marker||$new$
 insert into app_private.queue_model_admission_state(workspace_id) values(workspace) on conflict do nothing;
 select * into admission from app_private.queue_model_admission_state where workspace_id=workspace for update;$new$;
 if position(marker in definition)=0 then raise exception 'MODEL_ADMISSION_STATE_LOCK_CHANGED';end if;
 definition:=replace(definition,marker,replacement);
 class_join:='cross join lateral (select app_private.queue_work_class(q) work_class) c';
 admission_join:=$new$cross join lateral (select c.work_class in ('proposal','background')
  and q.type not in ('source_collect','source_candidates') and not q.cancel_requested
  and not app_private.queue_needs_notice_details(q) requires_capacity) model_admission$new$;
 if position(class_join in definition)=0 then raise exception 'MODEL_ADMISSION_CLASS_CHANGED';end if;
 -- Derive both eligibility checks from the exact installed predicate, retaining
 -- later OCR/executor/dependency refinements rather than reimplementing them.
 -- Legitimate claims already hold the workspace lock before this function. The
 -- preference CTE takes no extra job locks; an unrelated row lock can therefore
 -- defer selection conservatively without consuming either admission turn.
 predicate_start:=position(' where q.workspace_id=workspace' in definition);
 predicate_end:=position(' order by slot.distance,' in definition);
 if predicate_start=0 or predicate_end<=predicate_start then raise exception 'MODEL_ADMISSION_ELIGIBILITY_CHANGED';end if;
 predicate:=substring(definition from predicate_start for predicate_end-predicate_start);
 if position('not app_private.job_waits_for_notice_ocr(q)' in predicate)=0
  or position('q.next_attempt_at<=now()' in predicate)=0
  or position('(capacity or c.work_class in (''local'',''poll'')' in predicate)=0
  or position('s.status not in (''completed'',''split'')' in predicate)=0
  then raise exception 'MODEL_ADMISSION_REQUIRED_GUARD_MISSING';end if;
 marker:=' select q.id,q.entity_id,c.work_class,slot.distance into chosen';
 replacement:=' with eligible_model_classes as materialized ('||E'\n select distinct c.work_class from public.jobs q\n '||class_join||E'\n '||admission_join||E'\n'||predicate||
  $new$ and model_admission.requires_capacity
 )
 select q.id,q.entity_id,c.work_class,slot.distance,model_admission.requires_capacity into chosen$new$;
 if position(marker in definition)=0 then raise exception 'MODEL_ADMISSION_SELECTION_CHANGED';end if;
 definition:=replace(definition,marker,replacement);
 -- Only the original selection needs this join: the CTE already has it.
 marker:=class_join||E'\n cross join lateral (select min(';
 replacement:=class_join||E'\n '||admission_join||E'\n cross join lateral (select min(';
 if position(marker in definition)=0 then raise exception 'MODEL_ADMISSION_SLOT_JOIN_CHANGED';end if;
 definition:=replace(definition,marker,replacement);
 marker:=' order by slot.distance,';
 replacement:=$new$ and (not model_admission.requires_capacity or c.work_class=admission.next_class
   or not exists(select 1 from eligible_model_classes eligible where eligible.work_class=admission.next_class))
 order by slot.distance,$new$;
 definition:=replace(definition,marker,replacement);
 marker:=' if chosen.id is null then return null;end if;';
 replacement:=marker||$new$
 if capacity and not local_only and chosen.requires_capacity then
  update app_private.queue_model_admission_state set
   next_class=case chosen.work_class when 'proposal' then 'background' else 'proposal' end,
   dispatch_count=dispatch_count+1 where workspace_id=workspace;
 end if;$new$;
 if position(marker in definition)=0 then raise exception 'MODEL_ADMISSION_COMMIT_CHANGED';end if;
 execute replace(definition,marker,replacement);
end $patch$;
