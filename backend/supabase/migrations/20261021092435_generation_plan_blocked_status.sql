-- A successful or retrying sibling must not hide another blocked step. The
-- normal generation commands update their child job before their parent plan.
-- Keep independent children runnable and preserve ordinary retry/cancel rules.
create function app_private.preserve_generation_plan_blocker()
returns trigger language plpgsql security definer set search_path='' as $$
declare blocked_error text;
begin
 if new.status not in ('queued','running','blocked') then return new;end if;
 select coalesce(nullif(j.error_code,''),'GENERATION_STEP_BLOCKED')
 into blocked_error
 from public.generation_steps s
 join public.jobs j on j.workspace_id=s.workspace_id and j.id=s.job_id
 where s.workspace_id=new.workspace_id and s.plan_id=new.id
  and s.stage=new.stage and s.status='queued'
  and j.status='blocked' and not j.cancel_requested
 order by s.ordinal,s.id limit 1;
 if found then new.status:='blocked';new.error_code:=blocked_error;end if;
 return new;
end $$;
revoke all on function app_private.preserve_generation_plan_blocker()
 from public,anon,authenticated,service_role;

create trigger preserve_generation_plan_blocker
before update of status,error_code,stage on public.generation_plans
for each row execute function app_private.preserve_generation_plan_blocker();

-- Repair the already-masked aggregate only. Lock workspaces in the same order
-- as generation commands, recheck eligibility, and leave all execution state
-- (including child revisions, leases, checkpoints and model usage) untouched.
do $repair$ declare candidate record;repaired public.generation_plans;begin
 for candidate in
  select p.id,p.workspace_id from public.generation_plans p
  where p.status in ('queued','running') and exists(
   select 1 from public.generation_steps s
   join public.jobs j on j.workspace_id=s.workspace_id and j.id=s.job_id
   where s.workspace_id=p.workspace_id and s.plan_id=p.id
    and s.stage=p.stage and s.status='queued'
    and j.status='blocked' and not j.cancel_requested
  ) order by p.workspace_id,p.id
 loop
  perform 1 from public.workspaces where id=candidate.workspace_id for update;
  update public.generation_plans p
   set status='running',revision=p.revision+1,updated_at=now()
   where p.id=candidate.id and p.workspace_id=candidate.workspace_id
    and p.status in ('queued','running') and exists(
     select 1 from public.generation_steps s
     join public.jobs j on j.workspace_id=s.workspace_id and j.id=s.job_id
     where s.workspace_id=p.workspace_id and s.plan_id=p.id
      and s.stage=p.stage and s.status='queued'
      and j.status='blocked' and not j.cancel_requested
    ) returning p.* into repaired;
  if found then
   insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
   values(repaired.workspace_id,repaired.created_by,'generation.status_reconciled',repaired.id,
    'Restored blocked plan visibility from its current blocked step; no jobs or model state changed.',gen_random_uuid());
  end if;
 end loop;
end $repair$;
