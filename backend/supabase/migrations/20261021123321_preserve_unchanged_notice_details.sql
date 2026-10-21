-- Fetch provenance can change while every assessment input remains identical.
-- Keep every present/future field except the two explicitly volatile HTTP fields.
create function app_private.notice_context_semantics(value jsonb)
returns jsonb language sql immutable set search_path='' as $$
 select case when jsonb_typeof(value->'notice_evidence')='object' then
  jsonb_set(value,'{notice_evidence}',(value->'notice_evidence')-array['fetched_at','detail_sha256'])
 else value end
$$;
revoke all on function app_private.notice_context_semantics(jsonb) from public,anon,authenticated,service_role;

-- Real attachment/deadline evidence changes use the canonical invalidation
-- trigger, including approval invalidation. HTTP timestamps/HTML alone do not.
create trigger notice_detail_evidence_changed after update of notice_evidence on public.opportunities
for each row when (
 app_private.notice_context_semantics(jsonb_build_object('notice_evidence',old.notice_evidence))
 is distinct from app_private.notice_context_semantics(jsonb_build_object('notice_evidence',new.notice_evidence))
) execute function app_private.invalidate_evidence();

-- Only scheduler-created work may reuse a previous assessment. An explicit
-- opportunity.assess command continues through the model even if inputs match.
do $$ declare definition text;old text;begin
 select pg_get_functiondef('public.schedule_assessment_refresh_before_details()'::regprocedure) into definition;
 old:='perform app_private.enqueue_generation(p,''classify_opportunity'',''{}'');';
 if position(old in definition)=0 then raise exception 'Assessment scheduler enqueue changed';end if;
 execute replace(definition,old,'perform app_private.enqueue_generation(p,''classify_opportunity'',''{"automatic_refresh":true}''::jsonb);');
end $$;

-- Several detail snapshots can have the same notice text (or transaction time)
-- while attachments/deadlines differ. Prefer the saved current evidence, not an
-- arbitrary old snapshot with matching text. Fall back to the newest listing.
do $$ declare definition text;old text;replacement text;begin
 select pg_get_functiondef('public.generation_context(uuid,uuid)'::regprocedure) into definition;
 old:='order by snap.created_at desc limit 1;';
 replacement:=$order$order by (
  app_private.notice_context_semantics(jsonb_build_object('notice_evidence',
   (snap.content->'notice_evidence')||jsonb_build_object('notice_hash',notice_hash)))
  =app_private.notice_context_semantics(jsonb_build_object('notice_evidence',o.notice_evidence))
 ) desc nulls last,snap.created_at desc,snap.id desc limit 1;$order$;
 if position(old in definition)=0 then raise exception 'Detail snapshot lookup changed';end if;
 execute replace(definition,old,replacement);
end $$;

alter function public.complete_notice_details(uuid,uuid,jsonb) rename to complete_notice_details_before_semantic_refresh;
revoke all on function public.complete_notice_details_before_semantic_refresh(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.complete_notice_details(job_id uuid,lease uuid,result jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare ctx jsonb;w uuid;j public.jobs;p public.generation_plans;o public.opportunities;
 metadata jsonb;current_context jsonb;previous public.fit_assessments;previous_plan public.generation_plans;
 version bigint;provider text;manifest jsonb;permitted boolean:=true;has_provider boolean:=false;
 same_details boolean;provenance jsonb;
begin
 select workspace_id into w from public.jobs where id=job_id;
 select evidence_revision into version from public.workspaces where id=w for update;
 ctx:=public.generation_context(job_id,lease);
 if ctx->'detail_source' is null then raise exception 'NOTICE_DETAILS_NOT_REQUIRED';end if;
 select * into j from public.jobs where id=job_id for update;
 select * into p from public.generation_plans where id=j.entity_id and workspace_id=w for update;
 select * into o from public.opportunities where id=p.opportunity_id and workspace_id=w for update;
 metadata:=result->'notice_evidence';
 if result->>'identity_key' is distinct from ctx->'detail_notice'->>'identity_key'
  or result->>'canonical_url' is distinct from ctx->'detail_notice'->>'canonical_url'
  or length(coalesce(result->>'description','')) not between 80 and 50000
  or metadata is null or metadata->>'version' is distinct from '1'
  or coalesce(metadata->>'status','') not in ('read','partial') or pg_column_size(metadata)>32000
 then raise exception 'INVALID_NOTICE_DETAILS';end if;
 metadata:=metadata||jsonb_build_object('notice_hash',app_private.content_record(w,'notice',o.id)->>'content_hash');
 same_details:=coalesce(ctx->'detail_notice'->'notice_evidence'->>'version'='1'
  and app_private.notice_context_semantics(ctx->'detail_notice')=app_private.notice_context_semantics(result)
  and app_private.notice_context_semantics(jsonb_build_object('notice_evidence',o.notice_evidence))
   =app_private.notice_context_semantics(jsonb_build_object('notice_evidence',metadata)),false);
 if not same_details then
  perform public.complete_notice_details_before_semantic_refresh(job_id,lease,result);
  return;
 end if;

 -- No new advertisement snapshot, notification, content hash, or frozen input.
 -- The current fetch still records the latest HTML digest and successful time.
 update public.opportunities set notice_evidence=metadata,assessment_pending=false,
  revision=revision+1,updated_at=now() where id=o.id;
 current_context:=app_private.generation_snapshot(w,o.id,null,null);

 if ctx->'step'->'input'->'automatic_refresh'='true'::jsonb
  and not exists(select 1 from public.provider_usage where provider_usage.job_id=j.id)
  and not exists(select 1 from app_private.model_graph_threads where model_graph_threads.job_id=j.id)
  and app_private.notice_context_semantics(p.frozen_context)=app_private.notice_context_semantics(current_context)
  and exists(select 1 from public.memberships m join public.identity_allowlist a
   on a.workspace_id=m.workspace_id and a.user_id=m.user_id
   where m.workspace_id=w and m.user_id=j.created_by and m.active and m.role in ('Owner','Editor') and a.status='active') then
  select * into previous from public.fit_assessments
   where workspace_id=w and opportunity_id=o.id order by created_at desc,id desc limit 1;
  select * into previous_plan from public.generation_plans where id=previous.plan_id and workspace_id=w;
  if previous.id is not null and previous_plan.status='completed'
   and previous_plan.kind='assessment' and previous_plan.id<>p.id
   and previous.input_hash=previous_plan.input_hash
   and not (previous.result ? 'rule_exclusion')
   and app_private.notice_context_semantics(previous_plan.frozen_context)=app_private.notice_context_semantics(current_context) then
   select jsonb_agg(distinct e->'reference') into manifest from jsonb_array_elements(
    jsonb_build_array(current_context->'notice')||(current_context->'knowledge')) e
    where e->>'kind'='notice' or (e->>'kind'='company' and e->'verified'='true'::jsonb);
   -- Reusing evidence does not revive revoked permission. Check the original
   -- recipients with the same current authorization function as generation.
   for provider in select distinct u.provider from public.provider_usage u
    join public.generation_steps s on s.job_id=u.job_id and s.workspace_id=u.workspace_id
    where s.plan_id=previous_plan.id and u.workspace_id=w and u.state='settled' loop
    has_provider:=true;
    begin perform app_private.check_model_payload(w,provider,manifest);
    exception when raise_exception then
     if sqlerrm='DATA_AUTHORIZATION_REQUIRED' then permitted:=false;else raise;end if;
    end;
   end loop;
   if permitted and has_provider then
    -- A global revision may have advanced for unrelated workspace evidence.
    -- Equality above preserves the original result, citations, time and hashes.
    update public.fit_assessments set evidence_revision=version,revision=revision+1
     where id=previous.id and evidence_revision<>version;
    update public.generation_plans set evidence_revision=version,revision=revision+1,updated_at=now()
     where id=previous_plan.id and evidence_revision<>version;
    provenance:=jsonb_build_object('reason','NOTICE_DETAILS_UNCHANGED',
     'reused_assessment_id',previous.id,'assessment_created_at',previous.created_at,
     'assessment_input_hash',previous.input_hash,'evidence_revision',version);
    update public.generation_steps set status='completed',output=provenance,revision=revision+1,updated_at=now()
     where generation_steps.job_id=j.id and workspace_id=w;
    update public.jobs set status='succeeded',error_code=null,lease_token=null,lease_until=null,
     revision=revision+1,updated_at=now() where id=j.id;
    update public.generation_plans set status='completed',stage='completed',error_code=null,
     revision=revision+1,updated_at=now() where id=p.id;
    insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
     values(w,j.created_by,'assessment.evidence.reused',o.id,provenance::text,gen_random_uuid());
    return;
   end if;
  end if;
 end if;

 -- An assessment already in progress (or an explicit re-evaluation) resumes the
 -- exact same job. Saved paid provider requests and graph budgets stay intact.
 update public.jobs set status='retry_wait',lease_token=null,lease_until=null,
  error_code=case when exists(select 1 from public.provider_usage u where u.job_id=j.id
   and u.state='reserved' and u.remote_request_id is not null and u.remote_deadline>now())
   then 'MODEL_IN_PROGRESS' else error_code end,
  next_attempt_at=greatest(j.next_attempt_at,now()),
  revision=revision+1,updated_at=now() where id=j.id;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
  values(w,j.created_by,'notice.details_unchanged',o.id,
   jsonb_build_object('job_id',j.id,'plan_id',p.id,'detail_url',metadata->>'detail_url')::text,gen_random_uuid());
end $$;
revoke all on function public.complete_notice_details(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.complete_notice_details(uuid,uuid,jsonb) to service_role;
