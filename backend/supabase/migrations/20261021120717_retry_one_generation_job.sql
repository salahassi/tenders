-- A per-job UI retry must not restart its entire generation plan. Existing
-- provider reservation serialization still decides when queued work may send.
create function app_private.retry_generation_job(payload jsonb,idempotency_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();w uuid;j public.jobs;p public.generation_plans;
 replay app_private.idempotency_records;body_hash text;result jsonb;
begin
 perform app_private.check_keys(payload,array['id','expected_revision','action','reason']);
 if payload->>'action' is distinct from 'retry' or idempotency_key is null
  or length(idempotency_key) not between 1 and 200 or pg_column_size(payload)>1048576 then raise exception 'INVALID_INPUT';end if;
 if length(trim(coalesce(payload->>'reason','')))=0 then raise exception 'REASON_REQUIRED';end if;
 select workspace_id into w from public.jobs where id=(payload->>'id')::uuid;
 if w is null or coalesce(app_private.member_role(w),'') not in ('Owner','Editor') then raise exception 'ROLE_FORBIDDEN';end if;
 perform 1 from public.workspaces where id=w for update;
 if coalesce(app_private.member_role(w),'') not in ('Owner','Editor') then raise exception 'ROLE_FORBIDDEN';end if;
 body_hash:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor
  and method='COMMAND' and route='job.action' and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then
  if replay.body_hash<>body_hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  return replay.result;
 end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor
  and method='COMMAND' and route='job.action' and key=idempotency_key;
 select * into p from public.generation_plans where workspace_id=w
  and id=(select entity_id from public.jobs where workspace_id=w and id=(payload->>'id')::uuid) for update;
 select * into j from public.jobs where workspace_id=w and id=(payload->>'id')::uuid for update;
 if j.id is null or j.revision is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 if p.id is null then raise exception 'NOT_FOUND';end if;
 if p.status not in ('queued','running','blocked') then
  -- Canceled/terminal plans retain the existing explicit whole-plan resume
  -- behavior and all of that command's usage/evidence/state checks.
  result:=app_private.generation_command('generation.retry',jsonb_build_object(
   'id',p.id,'expected_revision',p.revision,'reason',payload->>'reason'),idempotency_key);
 else
  if j.status not in ('blocked','failed') or j.cancel_requested or not exists(
   select 1 from public.generation_steps s where s.workspace_id=w and s.plan_id=p.id
    and s.job_id=j.id and s.status='queued' and s.stage=p.stage) then raise exception 'STATE_CONFLICT';end if;
  if j.input_hash is distinct from p.input_hash or (p.proposal_id is not null and p.base_version_id is distinct from
   (select active_version_id from public.proposals where workspace_id=w and id=p.proposal_id)) then raise exception 'STALE_INPUT';end if;
  if p.evidence_revision<>(select evidence_revision from public.workspaces where id=w) then
   perform app_private.refresh_proposal_evidence(p.id);
   select * into p from public.generation_plans where id=p.id;
  end if;
  if exists(select 1 from public.provider_usage u where u.workspace_id=w and u.job_id=j.id
   and u.state in ('reserved','unknown')) then raise exception 'USAGE_REVIEW_REQUIRED';end if;
  update public.jobs set status='queued',cancel_requested=false,error_code=null,next_attempt_at=now(),
   lease_token=null,lease_until=null,revision=revision+1,updated_at=now()
   where workspace_id=w and id=j.id returning to_jsonb(jobs.*) into result;
  update public.generation_plans set status=case when exists(select 1 from public.jobs sibling
   where sibling.workspace_id=w and sibling.entity_id=p.id and sibling.status='running') then 'running' else 'queued' end,
   error_code=null,revision=revision+1,updated_at=now() where id=p.id;
 end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
  values(w,actor,'job.action',j.id,payload->>'reason',gen_random_uuid());
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result)
  values(w,actor,'COMMAND','job.action',idempotency_key,body_hash,result);
 return result;
end $$;
revoke all on function app_private.retry_generation_job(jsonb,text) from public,anon,authenticated,service_role;

do $$ declare definition text;fragment text;replacement text;begin
 select pg_get_functiondef('app_private.generation_command(text,jsonb,text)'::regprocedure) into definition;
 fragment := $old$if operation='job.action' and exists(select 1 from public.generation_steps where job_id=(payload->>'id')::uuid) then$old$;
 replacement := fragment||$new$
 if payload->>'action'='retry' then return app_private.retry_generation_job(payload,idempotency_key);end if;$new$;
 if position(fragment in definition)=0 then raise exception 'Unexpected generation job command';end if;
 execute replace(definition,fragment,replacement);
end $$;
