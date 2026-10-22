-- Replace only an exhausted review whose old request lacked citable draft
-- context. This is a new, explicitly versioned input; retain every old receipt.
create or replace function public.reprepare_blocked_proposal_review(target_job uuid,actor uuid,expected_revision integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.generation_steps;p public.generation_plans;new_job uuid;
begin
 select * into j from public.jobs where id=target_job;
 if j.id is null then raise exception 'NOT_FOUND';end if;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 select * into j from public.jobs where id=target_job for update;
 if not exists(select 1 from public.memberships where workspace_id=j.workspace_id and user_id=actor and role in ('Owner','Editor') and active and exists(select 1 from public.identity_allowlist a where a.workspace_id=j.workspace_id and a.user_id=actor and a.status='active')) then raise exception 'FORBIDDEN';end if;
 if j.revision<>expected_revision then raise exception 'REVISION_CONFLICT';end if;
 select * into s from public.generation_steps where job_id=j.id;
 select * into p from public.generation_plans where id=s.plan_id for update;
 if p.id is null or p.kind<>'proposal' or p.workflow_version not in (1,2,3) or p.status not in ('running','blocked')
  or p.stage not in ('review','reconciliation') or s.stage<>p.stage or s.task<>'review_proposal' or s.status<>'queued'
  or s.input->>'review_source_version'='1' or j.status<>'blocked' or j.cancel_requested
  or j.error_code<>'MODEL_CORRECTION_EXHAUSTED'
  or exists(select 1 from public.provider_usage where job_id=j.id and state in ('reserved','unknown')) then raise exception 'REVIEW_REPREPARE_NOT_SAFE';end if;
 if p.evidence_revision<>(select evidence_revision from public.workspaces where id=p.workspace_id)
  or p.base_version_id is distinct from (select active_version_id from public.proposals where id=p.proposal_id) then raise exception 'STALE_INPUT';end if;
 update public.jobs set status='canceled',cancel_requested=true,error_code='REVIEW_CONTEXT_SUPERSEDED',lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
 update public.generation_steps set status='split',revision=revision+1,updated_at=now() where id=s.id;
 update public.generation_plans set status='running',error_code=null,revision=revision+1,updated_at=now() where id=p.id returning * into p;
 new_job:=app_private.enqueue_generation(p,'review_proposal',s.input||'{"review_scope_version":1,"review_source_version":1}'::jsonb,s.depth);
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details)
 values(p.workspace_id,actor,'proposal.review.reprepare','generation_plan',p.id,jsonb_build_object('previous_job_id',j.id,'new_job_id',new_job,'review_source_version',1,'preserved_completed_steps',true,'preserved_usage_and_budgets',true));
 return new_job;
end $$;
revoke all on function public.reprepare_blocked_proposal_review(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.reprepare_blocked_proposal_review(uuid,uuid,integer) to service_role;

-- The public resume command must replace the obsolete review input once rather
-- than requeue the same exhausted graph. Every completed step/receipt is retained.
do $patch$ declare definition text;marker text;replacement text;begin
 select pg_get_functiondef('app_private.generation_command(text,jsonb,text)'::regprocedure) into definition;
 marker:=$old$ update public.jobs set status='queued',cancel_requested=false,error_code=null,next_attempt_at=now(),revision=revision+1,updated_at=now() where entity_id=p.id and id in (select job_id from public.generation_steps where plan_id=p.id and status='queued');$old$;
 replacement:=$new$
 if exists(select 1 from public.generation_plans newer where newer.workspace_id=p.workspace_id and newer.opportunity_id=p.opportunity_id and newer.kind=p.kind and newer.created_at>p.created_at and newer.status in ('queued','running','blocked','completed')) then raise exception 'GENERATION_SUPERSEDED';end if;
 for job_record in select jobs.* from public.jobs jobs join public.generation_steps step on step.job_id=jobs.id
  where step.plan_id=p.id and step.stage=p.stage and step.task='review_proposal' and step.status='queued'
   and step.input->>'review_source_version' is distinct from '1' and jobs.status='blocked' and jobs.error_code='MODEL_CORRECTION_EXHAUSTED'
 loop
  perform public.reprepare_blocked_proposal_review(job_record.id,actor,job_record.revision);
 end loop;
 update public.jobs set status='queued',cancel_requested=false,error_code=null,next_attempt_at=now(),revision=revision+1,updated_at=now() where entity_id=p.id and id in (select job_id from public.generation_steps where plan_id=p.id and status='queued');$new$;
 if position(marker in definition)=0 then raise exception 'Generation resume guard changed';end if;
 execute replace(definition,marker,replacement);
end $patch$;
