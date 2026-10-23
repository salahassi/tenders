-- Recover only deterministic assembly after all model work has finished.
-- A changed notice stays historical evidence: do not rebase inputs, reset work,
-- or make the recovered draft eligible for final approval.
create function app_private.saved_proposal_assembly_ready(p public.generation_plans)
returns boolean language sql stable set search_path='' as $$
 select coalesce(
  p.kind='proposal' and p.status in ('queued','running','blocked')
  and ((p.workflow_version=1 and p.stage='review')
    or (p.workflow_version in (2,3) and p.stage='reconciliation'))
  and jsonb_array_length(p.frozen_context->'blocks')>0
  and exists(select 1 from public.opportunities o where o.id=p.opportunity_id
    and o.workspace_id=p.workspace_id and not o.archived and o.decision='shortlisted')
  and exists(select 1 from public.generation_steps s where s.plan_id=p.id
    and s.task='draft_section' and s.status='completed')
  and exists(select 1 from public.generation_steps s where s.plan_id=p.id
    and s.task='review_proposal' and s.stage=p.stage and s.status='completed')
  and (select count(*) from public.generation_steps s where s.plan_id=p.id and s.status='queued')=1
  and exists(select 1 from public.generation_steps s join public.jobs j on j.id=s.job_id
    where s.plan_id=p.id and s.stage=p.stage and s.task='advance_plan' and s.status='queued'
     and j.workspace_id=p.workspace_id and j.entity_id=p.id and j.type='advance_plan'
     and not j.cancel_requested and j.status in ('queued','running','blocked','retry_wait'))
  and not exists(select 1 from public.generation_steps s join public.jobs j on j.id=s.job_id
    where s.plan_id=p.id and s.task<>'advance_plan'
     and j.status in ('queued','running','retry_wait','quota_wait'))
  and not exists(select 1 from public.generation_plans newer
    where newer.workspace_id=p.workspace_id and newer.opportunity_id=p.opportunity_id
     and newer.kind=p.kind and newer.created_at>p.created_at
     and newer.status in ('queued','running','blocked','completed')),
 false);
$$;
revoke all on function app_private.saved_proposal_assembly_ready(public.generation_plans)
 from public,anon,authenticated,service_role;

do $patch$ declare definition text;marker text;replacement text;begin
 select pg_get_functiondef('app_private.refresh_proposal_evidence(uuid)'::regprocedure) into definition;
 marker:=$old$if (current_context-array['notice_evidence','discovery_scope','discovery_scope_policy'])
    is distinct from (p.frozen_context-array['notice_evidence','discovery_scope','discovery_scope_policy']) then raise exception 'STALE_INPUT';end if;$old$;
 replacement:=$new$if (current_context-array['notice_evidence','discovery_scope','discovery_scope_policy'])
    is distinct from (p.frozen_context-array['notice_evidence','discovery_scope','discovery_scope_policy']) then
  if (current_context-array['notice','notice_evidence','discovery_scope','discovery_scope_policy'])
     = (p.frozen_context-array['notice','notice_evidence','discovery_scope','discovery_scope_policy'])
    and current_context->'notice'->'reference'->>'entity_id'=p.frozen_context->'notice'->'reference'->>'entity_id'
    and app_private.saved_proposal_assembly_ready(p) then
   -- Keep evidence_revision, input_hash and frozen_context exactly as saved.
   -- Only the last local assembly may proceed; its output remains a stale draft.
   return;
  end if;
  raise exception 'STALE_INPUT';
 end if;$new$;
 if position(marker in definition)=0 then raise exception 'Proposal evidence comparison changed';end if;
 execute replace(definition,marker,replacement);

 select pg_get_functiondef('public.advance_generation(uuid,uuid,text,jsonb,jsonb,jsonb)'::regprocedure) into definition;
 marker:=$old$ update public.generation_steps set status='completed',output=jsonb_build_object('next_stage',next_stage),revision=revision+1,updated_at=now() where id=s.id;$old$;
 replacement:=$new$
 if p.kind='proposal' and next_stage='completed'
   and p.evidence_revision<>(select evidence_revision from public.workspaces where id=w) then
  if not app_private.saved_proposal_assembly_ready(p) then raise exception 'STALE_INPUT';end if;
  final_result:=jsonb_set(final_result,'{questions}',coalesce(final_result->'questions','[]'::jsonb)||jsonb_build_array(jsonb_build_object(
   'question',case when p.frozen_context->>'language'='ar'
    then 'استُعيدت هذه المسودة من العمل المحفوظ اعتماداً على نسخة الإعلان السابقة. راجع تفاصيل الإعلان الحالية وأعد توليد نسخة محدثة قبل الاعتماد النهائي.'
    else 'This draft was recovered from saved work using the earlier notice. Review the current notice and regenerate an updated version before final approval.' end,
   'blocking_level','finalization','reason','NOTICE_CHANGED_AFTER_DRAFTING')));
  final_result:=jsonb_set(final_result,'{review}',coalesce(final_result->'review','{}'::jsonb)||jsonb_build_object(
   'saved_notice_recovery',jsonb_build_object('version',1,
    'frozen_notice_hash',p.frozen_context->'notice'->'reference'->>'content_hash',
    'observed_notice_hash',app_private.content_record(w,'notice',p.opportunity_id)->>'content_hash',
    'evidence_revision',p.evidence_revision)));
 end if;
$new$||marker;
 if position(marker in definition)=0 then raise exception 'Generation assembly transition changed';end if;
 definition:=replace(definition,marker,replacement);
 marker:=$old$ update public.proposals set active_version_id=v,state='draft',revision=revision+1,updated_at=now() where id=p.proposal_id;$old$;
 replacement:=$new$
 if final_result->'review' ? 'saved_notice_recovery' then
  insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details)
  values(w,p.created_by,'generation.saved_draft.recovered','generation_plan',p.id,
   (final_result->'review'->'saved_notice_recovery')||jsonb_build_object('proposal_version_id',v,
    'preserved_completed_steps',true,'preserved_input_snapshot',true,'final_approval_requires_regeneration',true));
 end if;
$new$||marker;
 if position(marker in definition)=0 then raise exception 'Generation version activation changed';end if;
 execute replace(definition,marker,replacement);

 select pg_get_functiondef('app_private.approval_gate(uuid,uuid)'::regprocedure) into definition;
 marker:=$old$if v.evidence_revision is distinct from (select evidence_revision from public.workspaces where id=w) then errors:=errors||'"Supporting evidence changed; regenerate the proposal."'::jsonb;end if;$old$;
 replacement:=marker||$new$
 if v.review_result ? 'saved_notice_recovery' then
  errors:=errors||'"Recovered draft uses an earlier notice; regenerate with current evidence before approval."'::jsonb;
 end if;
$new$;
 if position(marker in definition)=0 then raise exception 'Approval evidence guard changed';end if;
 execute replace(definition,marker,replacement);
end $patch$;
