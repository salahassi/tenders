-- A newly authorized issuance must have a complete, current delivery contract.
-- Historical paid plans retain their original wire/snapshot; an explicit current
-- successor is required rather than a known impossible 600-second promise.
alter function app_private.app_command(text,jsonb,text) rename to app_command_before_current_issuance_contract;
do $$ declare definition text;begin
 definition:=pg_get_functiondef('app_private.app_command_before_current_issuance_contract(text,jsonb,text)'::regprocedure);
 execute replace(definition,'app_command.','app_command_before_current_issuance_contract.');
end $$;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.generation_plans;proposal public.proposals;opportunity public.opportunities;replay app_private.idempotency_records;digest text;result jsonb;begin
 if operation='generation.retry' then
  select * into p from public.generation_plans where id=(input->>'id')::uuid and kind='proposal';
 elsif operation='job.action' and input->>'action'='retry' then
  select plan.* into p from public.generation_plans plan join public.generation_steps step on step.plan_id=plan.id
   where step.job_id=(app_command.input->>'id')::uuid and plan.kind='proposal';
 elsif operation='proposal.generate' then
  select * into p from public.generation_plans where opportunity_id=(input->>'id')::uuid and kind='proposal' and status in ('queued','running','blocked') order by created_at desc limit 1;
 elsif operation='proposal.regenerate' then
  select * into p from public.generation_plans where proposal_id=(input->>'id')::uuid and kind='proposal' and status in ('queued','running','blocked') order by created_at desc limit 1;
 end if;
 if p.id is not null then
  perform 1 from public.workspaces where id=p.workspace_id for update;
  select * into p from public.generation_plans where id=p.id;
 end if;
 if p.id is not null and app_private.member_role(p.workspace_id) in ('Owner','Editor') then
  -- A replay is the original authorization, never a new deadline or new call.
  select * into replay from app_private.idempotency_records where workspace_id=p.workspace_id and actor_id=auth.uid()
   and method='COMMAND' and route=operation and key=idempotency_key and expires_at>now();
  if replay.key is not null then
   digest:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
   if replay.body_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;
   return replay.result;
  end if;
  if p.frozen_context->'generated_delivery_version' is distinct from '3'::jsonb
   or p.frozen_context->'proposal_consistency_version' is distinct from '1'::jsonb then
   select * into proposal from public.proposals where id=p.proposal_id;
   select * into opportunity from public.opportunities where id=p.opportunity_id;
   raise exception using message='PROPOSAL_CURRENT_CONTRACT_REQUIRED',detail=jsonb_build_object(
    'plan_id',p.id,'expected_plan_revision',p.revision,'preserved_input_hash',p.input_hash,
    'cancel_required',p.status in ('queued','running','blocked'),
    'opportunity_id',p.opportunity_id,'expected_opportunity_revision',opportunity.revision,
    'proposal_id',p.proposal_id,'expected_proposal_revision',proposal.revision,
    'base_version_id',proposal.active_version_id,
    'next_operation',case when proposal.active_version_id is null then 'proposal.generate' else 'proposal.regenerate' end)::text;
  end if;
 end if;
 result:=app_private.app_command_before_current_issuance_contract(operation,input,idempotency_key);
 if operation='generation.cancel' then
  select * into p from public.generation_plans where id=(input->>'id')::uuid;
  if p.issuance_request_id is not null then perform app_private.fail_proposal_issuance(p.issuance_request_id,'GENERATION_CANCELED');end if;
 end if;
 return result;
end $$;
revoke all on function app_private.app_command(text,jsonb,text),app_private.app_command_before_current_issuance_contract(text,jsonb,text) from public;
do $$ declare r text;begin
 foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=r) then
   execute format('revoke all on function app_private.app_command_before_current_issuance_contract(text,jsonb,text) from %I',r);
   execute format('revoke all on function app_private.app_command(text,jsonb,text) from %I',r);
  end if;
 end loop;
 foreach r in array array['authenticated','tdp_app_authenticated'] loop
  if exists(select 1 from pg_roles where rolname=r) then execute format('grant execute on function app_private.app_command(text,jsonb,text) to %I',r);end if;
 end loop;
end $$;
