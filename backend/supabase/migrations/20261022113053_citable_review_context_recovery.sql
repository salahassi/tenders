-- Replace only an exhausted review whose old request lacked citable draft
-- context. This is a new, explicitly versioned input; retain every old receipt.
create function public.reprepare_blocked_proposal_review(target_job uuid,actor uuid,expected_revision integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.generation_steps;p public.generation_plans;new_job uuid;
begin
 select * into j from public.jobs where id=target_job;
 if j.id is null then raise exception 'NOT_FOUND';end if;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 select * into j from public.jobs where id=target_job for update;
 if not exists(select 1 from public.memberships where workspace_id=j.workspace_id and user_id=actor and role='Owner' and active) then raise exception 'FORBIDDEN';end if;
 if j.revision<>expected_revision then raise exception 'REVISION_CONFLICT';end if;
 select * into s from public.generation_steps where job_id=j.id;
 select * into p from public.generation_plans where id=s.plan_id for update;
 if p.id is null or p.kind<>'proposal' or p.workflow_version<>3 or p.status not in ('running','blocked')
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
