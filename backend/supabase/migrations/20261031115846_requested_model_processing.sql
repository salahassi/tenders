-- Requesting a workflow authorizes its selected tender inputs. There is no
-- second, provider-by-provider review for the same authenticated request.
-- Automatic collection and Company Knowledge retain their existing policies.
create table app_private.generation_processing_requests (
 plan_id uuid primary key,
 workspace_id uuid not null references public.workspaces(id),
 requested_by uuid not null,
 operation text not null check(operation in ('opportunity.assess','proposal.generate','proposal.regenerate','generation.retry','job.action')),
 idempotency_key text not null,
 requested_at timestamptz not null,
 foreign key(workspace_id,plan_id) references public.generation_plans(workspace_id,id) on delete cascade
);
alter table app_private.generation_processing_requests enable row level security;
revoke all on app_private.generation_processing_requests from public;

-- These three historical actions are emitted by authenticated interactive
-- commands. Historical generation.retry is deliberately excluded: an automatic
-- evidence refresh also used that audit name in older releases.
insert into app_private.generation_processing_requests(plan_id,workspace_id,requested_by,operation,idempotency_key,requested_at)
select distinct on (p.id) p.id,p.workspace_id,a.actor_id,a.action,'historical:'||a.id::text,a.created_at
from public.generation_plans p
join public.audit_events a on a.workspace_id=p.workspace_id and a.entity_id=p.id
join public.memberships m on m.workspace_id=p.workspace_id and m.user_id=a.actor_id and m.active and m.role in ('Owner','Editor')
join public.identity_allowlist allowed on allowed.workspace_id=m.workspace_id and allowed.user_id=m.user_id and allowed.status='active'
where a.action in ('opportunity.assess','proposal.generate','proposal.regenerate')
order by p.id,a.created_at desc,a.id desc;

alter function app_private.app_command(text,jsonb,text) rename to processing_previous_command;
revoke all on function app_private.processing_previous_command(text,jsonb,text) from public;
do $$ declare r text;begin
 foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function app_private.processing_previous_command(text,jsonb,text) from %I',r);end if;
 end loop;
end $$;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare payload alias for $2;result jsonb;p public.generation_plans;actor uuid:=auth.uid();replayed_workspaces uuid[];
begin
 -- The existing command remains authoritative for Auth, membership, roles,
 -- revisions, hashes, idempotency, usage reconciliation and state transitions.
 select array_agg(workspace_id) into replayed_workspaces from app_private.idempotency_records
  where actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key and expires_at>now();
 result:=app_private.processing_previous_command(operation,payload,idempotency_key);
 if operation in ('opportunity.assess','proposal.generate','proposal.regenerate','generation.retry') then
  select * into p from public.generation_plans where id=(result->>'id')::uuid;
 elsif operation='job.action' and payload->>'action'='retry' then
  select plan.* into p from public.generation_plans plan join public.generation_steps step
   on step.workspace_id=plan.workspace_id and step.plan_id=plan.id where step.job_id=(payload->>'id')::uuid;
 else return result;end if;
 if p.id is null or p.workspace_id=any(coalesce(replayed_workspaces,'{}')) then return result;end if;
 if coalesce(app_private.member_role(p.workspace_id),'') not in ('Owner','Editor') then raise exception 'ROLE_FORBIDDEN';end if;
 insert into app_private.generation_processing_requests(plan_id,workspace_id,requested_by,operation,idempotency_key,requested_at)
 values(p.id,p.workspace_id,actor,operation,idempotency_key,clock_timestamp())
 on conflict(plan_id) do update set requested_by=excluded.requested_by,operation=excluded.operation,
  idempotency_key=excluded.idempotency_key,requested_at=excluded.requested_at
 where generation_processing_requests.requested_by is distinct from excluded.requested_by
  or generation_processing_requests.operation is distinct from excluded.operation
  or generation_processing_requests.idempotency_key is distinct from excluded.idempotency_key;
 return result;
end $$;
revoke all on function app_private.app_command(text,jsonb,text) from public;
do $$ declare r text;begin
 foreach r in array array['authenticated','tdp_app_authenticated'] loop
  if exists(select 1 from pg_roles where rolname=r) then execute format('grant execute on function app_private.app_command(text,jsonb,text) to %I',r);end if;
 end loop;
end $$;

create function app_private.check_requested_model_payload(job_id uuid,provider text,manifest jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare j public.jobs;p public.generation_plans;request app_private.generation_processing_requests;
 ref jsonb;content jsonb;selected boolean;requested boolean:=false;
begin
 select * into j from public.jobs where id=job_id;
 if j.id is null or j.status<>'running' or j.lease_until<=now() or j.lease_token is null or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 if jsonb_typeof(manifest) is distinct from 'array' then raise exception 'DATA_AUTHORIZATION_REQUIRED';end if;
 if jsonb_array_length(manifest) not between 1 and 300 then raise exception 'DATA_AUTHORIZATION_REQUIRED';end if;
 select plan.* into p from public.generation_plans plan join public.generation_steps step
  on step.workspace_id=plan.workspace_id and step.plan_id=plan.id
  where step.job_id=j.id and step.workspace_id=j.workspace_id and plan.id=j.entity_id and plan.input_hash=j.input_hash;
 if p.id is not null and p.status in ('queued','running','blocked') then
  select r.* into request from app_private.generation_processing_requests r
   join public.memberships m on m.workspace_id=r.workspace_id and m.user_id=r.requested_by and m.active and m.role in ('Owner','Editor')
   join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id and a.status='active'
   where r.plan_id=p.id and r.workspace_id=p.workspace_id;
  requested:=request.plan_id is not null;
 end if;
 for ref in select value from jsonb_array_elements(manifest) loop
  if not requested or ref->>'entity_kind' not in ('notice','review','document','knowledge','rate') then
   perform app_private.check_model_payload(j.workspace_id,provider,jsonb_build_array(ref));
   continue;
  end if;
  content:=app_private.content_record(j.workspace_id,ref->>'entity_kind',(ref->>'entity_id')::uuid);
  if content->>'content_hash' is distinct from ref->>'content_hash' then raise exception 'STALE_INPUT';end if;
  perform app_private.assert_business_content(content->>'content');
  selected:=false;
  if requested then
   if ref->>'entity_kind'='notice' then
    selected:=p.opportunity_id=(ref->>'entity_id')::uuid and p.frozen_context#>'{notice,reference}' @> ref;
   elsif ref->>'entity_kind'='review' then
    selected:=exists(select 1 from jsonb_array_elements(coalesce(p.frozen_context->'reviews','[]')) e
      where e->'reference' @> ref)
     and exists(select 1 from public.review_inputs r where r.workspace_id=j.workspace_id and r.id=(ref->>'entity_id')::uuid and r.proposal_id=p.proposal_id);
   elsif ref->>'entity_kind'='knowledge' then
    selected:=exists(select 1 from jsonb_array_elements(coalesce(p.frozen_context->'knowledge','[]')) e
      where e->>'kind'='style' and e->'reference' @> ref)
     and exists(select 1 from public.knowledge_items k where k.workspace_id=j.workspace_id and k.id=(ref->>'entity_id')::uuid
      and k.category='previous_proposal' and k.enabled and (k.expiry_date is null or k.expiry_date>=current_date));
   elsif ref->>'entity_kind'='rate' then
    selected:=exists(select 1 from jsonb_array_elements(coalesce(p.frozen_context->'rates','[]')) e where e->'reference' @> ref)
     and exists(select 1 from public.rate_catalog r where r.workspace_id=j.workspace_id and r.id=(ref->>'entity_id')::uuid
      and r.approved and r.public_approved and r.valid_from<=current_date and r.valid_until>=current_date);
   elsif ref->>'entity_kind'='document' then
    selected:=exists(select 1 from public.documents d where d.workspace_id=j.workspace_id and d.id=(ref->>'entity_id')::uuid and (
      (d.kind='rfp' and d.opportunity_id=p.opportunity_id and exists(
        select 1 from jsonb_array_elements(coalesce(p.frozen_context->'blocks','[]')) e where e->'reference' @> ref))
      or (d.kind='review' and exists(select 1 from public.review_inputs r where r.workspace_id=d.workspace_id and r.id=d.review_input_id and r.proposal_id=p.proposal_id)
       and exists(select 1 from jsonb_array_elements(coalesce(p.frozen_context->'reviews','[]')) e where e->'reference' @> ref))
      or (d.kind='company' and exists(select 1 from public.knowledge_items k where k.workspace_id=d.workspace_id and k.id=d.knowledge_item_id
        and k.category='previous_proposal' and k.enabled and (k.expiry_date is null or k.expiry_date>=current_date))
       and exists(select 1 from jsonb_array_elements(coalesce(p.frozen_context->'knowledge','[]')) e where e->>'kind'='style' and e->'reference' @> ref))));
   end if;
  end if;
  -- A later explicit revocation still wins until an authorized new request.
  if selected and not exists(select 1 from public.content_authorizations a
    where a.workspace_id=j.workspace_id and a.entity_kind=ref->>'entity_kind'
     and a.entity_id=(ref->>'entity_id')::uuid and a.content_hash=ref->>'content_hash'
     and a.provider=check_requested_model_payload.provider and a.revoked_at>=request.requested_at) then
   continue;
  end if;
  perform app_private.check_model_payload(j.workspace_id,provider,jsonb_build_array(ref));
 end loop;
end $$;
revoke all on function app_private.check_requested_model_payload(uuid,text,jsonb) from public;

-- Every supported execution path already validates its exact current lease.
-- Replace only its content check; provider identities, quota/usage accounting,
-- polling, graph budgets and routing order remain unchanged.
do $$ declare signature text;definition text;fragment text;replacement text;begin
 foreach signature in array array[
  'public.task_model_preflight(uuid,uuid,jsonb)',
  'public.model_preflight(uuid,uuid,jsonb)',
  'public.model_preflight_core(uuid,uuid,jsonb)'
 ] loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  fragment:='app_private.check_model_payload(j.workspace_id,';
  replacement:='app_private.check_requested_model_payload(j.id,';
  if position(fragment in definition)=0 then raise exception 'REQUESTED_PROCESSING_PREFLIGHT_MISMATCH';end if;
  execute replace(definition,fragment,replacement);
 end loop;
end $$;
