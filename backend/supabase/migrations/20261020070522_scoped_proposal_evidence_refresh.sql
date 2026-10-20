-- Collection/assessment metadata can advance the global evidence counter.
-- Resume a proposal only when every input it actually uses is unchanged;
-- never rewrite its frozen evidence or accept changed company/RFP facts.
create function app_private.refresh_proposal_evidence(plan_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare p public.generation_plans; current_revision bigint; current_context jsonb;
begin
 select * into p from public.generation_plans where id=plan_id;
 select evidence_revision into current_revision from public.workspaces where id=p.workspace_id for update;
 select * into p from public.generation_plans where id=plan_id for update;
 if p.id is null or p.status in ('completed','canceled','failed') then raise exception 'GENERATION_NOT_ACTIVE';end if;
 if p.proposal_id is not null and p.base_version_id is distinct from (select active_version_id from public.proposals where id=p.proposal_id) then raise exception 'STALE_INPUT';end if;
 if p.evidence_revision=current_revision then return;end if;
 if p.kind<>'proposal' then raise exception 'STALE_INPUT';end if;
 current_context:=app_private.generation_snapshot(p.workspace_id,p.opportunity_id,p.proposal_id,p.package_id);
 -- These three fields are consumed only by classify_opportunity, never by a
 -- proposal task. All present/future proposal fields remain in this comparison.
 if (current_context-array['notice_evidence','discovery_scope','discovery_scope_policy'])
    is distinct from (p.frozen_context-array['notice_evidence','discovery_scope','discovery_scope_policy']) then raise exception 'STALE_INPUT';end if;
 update public.generation_plans set evidence_revision=current_revision,revision=revision+1,updated_at=now() where id=p.id;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
 values(p.workspace_id,p.created_by,'generation.evidence.refreshed',p.id,'Workspace evidence changed; the current proposal inputs still exactly match its frozen inputs. Saved work retained.',gen_random_uuid());
end $$;

-- Repair only already-blocked proposal plans whose actual inputs still match.
-- Completed/split steps, counts, authorization and provider waits are retained.
do $recovery$ declare p public.generation_plans;begin
 for p in select g.* from public.generation_plans g join public.workspaces w on w.id=g.workspace_id where g.kind='proposal' and g.status='blocked' and g.error_code='STALE_INPUT' and g.evidence_revision<>w.evidence_revision loop
  begin
   perform app_private.refresh_proposal_evidence(p.id);
  exception when raise_exception then
   if sqlerrm='STALE_INPUT' then continue;else raise;end if;
  end;
  if exists(select 1 from public.jobs where entity_id=p.id and status='running') then continue;end if;
  update public.jobs set status='queued',error_code=null,next_attempt_at=now(),revision=revision+1,updated_at=now()
   where entity_id=p.id and status='blocked' and error_code='STALE_INPUT' and not cancel_requested
   and id in (select job_id from public.generation_steps where plan_id=p.id and status='queued');
  if not found then continue;end if;
  update public.generation_plans set status='queued',error_code=null,revision=revision+1,updated_at=now() where id=p.id;
  insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
   values(p.workspace_id,p.created_by,'generation.retry',p.id,'Recovered unchanged proposal inputs after replacing the global stale-evidence guard.',gen_random_uuid());
 end loop;
end $recovery$;
revoke all on function app_private.refresh_proposal_evidence(uuid) from public,anon,authenticated,service_role;

do $$ declare definition text; fragment text; signature text; scope text;begin
 for signature,scope in select * from (values
  ('public.generation_context_before_details(uuid,uuid)','p.workspace_id'),
  ('app_private.generation_command(text,jsonb,text)','w')
 ) s(signature,scope) loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  fragment:='if p.evidence_revision<>(select evidence_revision from public.workspaces where id='||scope||') then raise exception ''STALE_INPUT'';end if;';
  if position(fragment in definition)=0 then raise exception 'Unexpected generation evidence guard: %',signature;end if;
  execute replace(definition,fragment,'if p.evidence_revision<>(select evidence_revision from public.workspaces where id='||scope||') then perform app_private.refresh_proposal_evidence(p.id);select * into p from public.generation_plans where id=p.id;end if;');
 end loop;
end $$;
