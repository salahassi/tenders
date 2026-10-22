-- Classification consumes the full notice, verified company evidence and scope.
-- Proposal templates/rates and HTTP fetch provenance are not assessment inputs.
create function app_private.assessment_input_semantics(value jsonb)
returns jsonb language sql immutable set search_path='' as $$
 select jsonb_set(app_private.notice_context_semantics(value-array['template','rates','blocks','reviews']),'{knowledge}',
  coalesce((select jsonb_agg(item order by item->>'id')
   from jsonb_array_elements(value->'knowledge') item
   where item->>'kind'='company' and item->'verified'='true'::jsonb),'[]'::jsonb))
$$;
revoke all on function app_private.assessment_input_semantics(jsonb) from public,anon,authenticated,service_role;

-- Exposes only equality, never the private generation snapshot. The invoker view
-- retains table RLS; a direct call also requires membership for browser roles.
create function app_private.assessment_inputs_current(plan_id uuid)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare p public.generation_plans;current_context jsonb;
begin
 select * into p from public.generation_plans where id=plan_id;
 if p.id is null or p.kind<>'assessment' then return false;end if;
 if coalesce(current_setting('role',true),'none') not in ('none','service_role')
  and app_private.member_role(p.workspace_id) is null then return false;end if;
 current_context:=app_private.generation_snapshot(p.workspace_id,p.opportunity_id,null,null);
 return coalesce(app_private.assessment_input_semantics(p.frozen_context)
  =app_private.assessment_input_semantics(current_context),false);
exception when raise_exception then
 if sqlerrm='GENERATION_CONTEXT_CAP_REACHED' then return false;end if;
 raise;
end $$;
revoke all on function app_private.assessment_inputs_current(uuid) from public,anon;
grant execute on function app_private.assessment_inputs_current(uuid) to authenticated,service_role;

-- A saved assessment may continue after an unrelated workspace evidence edit.
-- Preserve its frozen input/hash, graph checkpoints, reservations and limits.
do $$ declare definition text;old text;replacement text;begin
 select pg_get_functiondef('app_private.refresh_proposal_evidence(uuid)'::regprocedure) into definition;
 old:='if p.kind<>''proposal'' then raise exception ''STALE_INPUT'';end if;';
 replacement:=$body$
 if p.kind='assessment' then
  if not app_private.assessment_inputs_current(p.id) then raise exception 'STALE_INPUT';end if;
  update public.generation_plans set evidence_revision=current_revision,revision=revision+1,updated_at=now() where id=p.id;
  insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
   values(p.workspace_id,p.created_by,'assessment.evidence.refreshed',p.id,
    'Workspace evidence changed; all consumed assessment inputs still match the saved snapshot. Saved work retained.',gen_random_uuid());
  return;
 end if;
 if p.kind<>'proposal' then raise exception 'STALE_INPUT';end if;
 $body$;
 if position(old in definition)=0 then raise exception 'Scoped generation evidence guard changed';end if;
 execute replace(definition,old,replacement);
end $$;

-- The newest completed result can become stale too. Queue it when its actual
-- inputs change; never supersede saved model work for an unrelated revision.
do $$ declare definition text;old text;replacement text;begin
 select pg_get_functiondef('public.schedule_assessment_refresh_before_details()'::regprocedure) into definition;
 old:=$old$update public.opportunities pending_opp set assessment_pending=true where pending_opp.workspace_id=w and not pending_opp.archived and exists(select 1 from public.generation_plans active_plan where active_plan.opportunity_id=pending_opp.id and active_plan.kind='assessment' and active_plan.status in ('queued','running','blocked') and (active_plan.evidence_revision<>version or active_plan.frozen_context->'notice'->'reference'->>'content_hash' is distinct from app_private.content_record(w,'notice',pending_opp.id)->>'content_hash'));$old$;
 replacement:=$body$
 update public.opportunities pending_opp set assessment_pending=true
 where pending_opp.workspace_id=w and not pending_opp.archived and pending_opp.decision<>'declined'
  and not exists(select 1 from public.sources rejected where rejected.workspace_id=w
   and rejected.id=pending_opp.source_id and rejected.approval='rejected')
  and exists(select 1 from public.generation_plans latest_plan
   where latest_plan.id=(select candidate.id from public.generation_plans candidate
    where candidate.workspace_id=w and candidate.opportunity_id=pending_opp.id and candidate.kind='assessment'
    order by candidate.created_at desc,candidate.id desc limit 1)
   and latest_plan.status in ('queued','running','blocked','completed')
   and not app_private.assessment_inputs_current(latest_plan.id));
 $body$;
 if position(old in definition)=0 then raise exception 'Assessment stale queue guard changed';end if;
 definition:=replace(definition,old,replacement);
 old:='notice_hash:=app_private.content_record(w,''notice'',o.id)->>''content_hash'';';
 replacement:=old||$body$
 -- Inert/unverified/style edits may set the broad pending flag. A completed
 -- current result needs no new model pass unless a public-detail poll is due.
 if exists(select 1 from public.opportunity_discovery d where d.id=o.id
   and d.workspace_id=w and d.assessment_current and d.assessment_state='assessed')
  and not exists(select 1 from public.sources detail_source where detail_source.id=o.source_id
   and detail_source.workspace_id=w and detail_source.approval='approved'
   and (detail_source.adapter_config ? 'official_listing' or detail_source.adapter_config->'automatic'='true'::jsonb)
   and (coalesce(o.notice_evidence->>'version','')<>'1'
    or o.notice_evidence->>'notice_hash' is distinct from notice_hash
    or (o.notice_evidence->>'fetched_at')::timestamptz<detail_source.last_success_at)) then
  update public.opportunities set assessment_pending=false where id=o.id;
  continue;
 end if;
 $body$;
 if position(old in definition)=0 then raise exception 'Assessment notice hash lookup changed';end if;
 definition:=replace(definition,old,replacement);
 old:='for o in select * from public.opportunities where workspace_id=w and assessment_pending and not archived order by updated_at,id limit 20 loop';
 replacement:=$body$for o in select * from public.opportunities candidate where workspace_id=w
  and assessment_pending and not archived and decision<>'declined'
  and not exists(select 1 from public.sources rejected where rejected.workspace_id=w
   and rejected.id=candidate.source_id and rejected.approval='rejected')
  order by updated_at,id limit 20 loop$body$;
 if position(old in definition)=0 then raise exception 'Assessment pending loop changed';end if;
 definition:=replace(definition,old,replacement);
 old:=$old$status in ('queued','running','blocked') and evidence_revision=version and frozen_context->'notice'->'reference'->>'content_hash'=notice_hash order by created_at desc,id desc limit 1;$old$;
 replacement:=$body$status in ('queued','running','blocked') and app_private.assessment_inputs_current(id) order by created_at desc,id desc limit 1;$body$;
 if position(old in definition)=0 then raise exception 'Assessment existing-work guard changed';end if;
 definition:=replace(definition,old,replacement);
 old:='if existing.id is not null then';
 replacement:=$body$if existing.id is not null then
  if existing.evidence_revision<>version then
   perform app_private.refresh_proposal_evidence(existing.id);
   select * into existing from public.generation_plans where id=existing.id;
  end if;$body$;
 if position(old in definition)=0 then raise exception 'Assessment existing-work branch changed';end if;
 execute replace(definition,old,replacement);
end $$;

-- Evaluate the two relevant snapshots once per notice, independently of the
-- workspace-wide approval revision. Keep all view columns and invoker RLS.
create or replace view public.opportunity_discovery with(security_invoker=true) as
select o.id,o.workspace_id,o.created_at,o.revision,
 a.id as assessment_id,
 coalesce(detail.ready and not (a.result ? 'rule_exclusion') and ac.current_inputs
  and a.input_hash=ap.input_hash and ap.status='completed',false) as assessment_current,
 a.routing,
 case
  when pc.current_inputs and p.status in ('queued','running')
   and j.status in ('queued','running','retry_wait','quota_wait') and not j.cancel_requested then j.status
  when detail.ready and not (a.result ? 'rule_exclusion') and ac.current_inputs
   and a.input_hash=ap.input_hash and ap.status='completed' then 'assessed'
  when pc.current_inputs and p.status in ('blocked','failed') then p.status
  when o.assessment_pending or (p.status='completed' and not pc.current_inputs) then 'pending_schedule'
  else 'not_started' end as assessment_state,
 case when p.status in ('blocked','failed') then p.error_code else j.error_code end as assessment_error,
 j.next_attempt_at,
 coalesce(detail.ready and not (a.result ? 'rule_exclusion') and ac.current_inputs
  and a.input_hash=ap.input_hash and ap.status='completed' and not detail.expired
  and a.routing<>'excluded' and a.result->'scope_decision'->>'status'='in_scope',false) as inbox_visible,
 detail.expired as is_expired,case when detail.ready then o.notice_evidence->>'status' else 'pending' end as notice_details_status,
 coalesce((j.checkpoint->'model_routing'->>'round_attempts')::int,j.attempts,0) as assessment_attempts
from public.opportunities o join public.workspaces w on w.id=o.workspace_id
cross join lateral(select encode(sha256(convert_to(o.title||E'\n'||o.description||E'\n'||o.buyer||E'\n'||o.reference,'UTF8')),'hex') notice_hash) h
left join public.sources src on src.id=o.source_id and src.workspace_id=o.workspace_id
cross join lateral(select
 (not coalesce(src.adapter_config ? 'official_listing' or src.adapter_config->'automatic'='true'::jsonb,false)
  or coalesce(o.notice_evidence->>'version'='1' and o.notice_evidence->>'notice_hash'=h.notice_hash,false)) ready,
 coalesce(o.deadline_at<=now(),(o.notice_evidence->'deadline'->>'date') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
  and (o.notice_evidence->'deadline'->>'date') < to_char(now() at time zone
   case when o.notice_evidence->'deadline'->>'timezone'='Asia/Amman' then 'Asia/Amman' else 'Asia/Hebron' end,'YYYY-MM-DD'),false) expired
) detail
left join lateral(select f.* from public.fit_assessments f where f.workspace_id=o.workspace_id and f.opportunity_id=o.id order by f.created_at desc,f.id desc limit 1) a on true
left join public.generation_plans ap on ap.id=a.plan_id and ap.workspace_id=o.workspace_id
left join lateral(select gp.* from public.generation_plans gp where gp.workspace_id=o.workspace_id and gp.opportunity_id=o.id and gp.kind='assessment' order by gp.created_at desc,gp.id desc limit 1) p on true
cross join lateral(select app_private.assessment_inputs_current(p.id) current_inputs offset 0) pc
cross join lateral(select case when ap.id=p.id then pc.current_inputs else app_private.assessment_inputs_current(ap.id) end current_inputs offset 0) ac
left join lateral(select jb.* from public.jobs jb where jb.workspace_id=o.workspace_id and jb.entity_id=p.id order by case when jb.status in ('queued','running','retry_wait','quota_wait') then 0 when jb.status='blocked' then 1 else 2 end,jb.created_at desc,jb.id desc limit 1) j on true
where not o.archived;
