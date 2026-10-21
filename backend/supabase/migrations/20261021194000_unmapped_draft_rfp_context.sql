-- Replace only an unpublished, completed general section whose original request
-- omitted RFP context. Its old paid job, graph, usage and full step snapshot remain
-- available. A new job gets a distinct request identity; no old budget is reset.
create function app_private.replace_unmapped_draft_context(step_id uuid, expected_revision integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare s public.generation_steps; p public.generation_plans; j public.jobs; replacement uuid;
begin
 select * into s from public.generation_steps where id=step_id;
 if s.id is null then raise exception 'NOT_FOUND';end if;
 select * into p from public.generation_plans where id=s.plan_id for update;
 select * into s from public.generation_steps where id=step_id for update;
 select * into j from public.jobs where id=s.job_id for update;
 if s.revision is distinct from expected_revision then raise exception 'REVISION_CONFLICT';end if;
 if p.kind<>'proposal' or p.stage<>'drafting' or p.status<>'running'
   or s.task<>'draft_section' or s.stage<>'drafting' or s.status<>'completed' or s.output is null
   or s.input->'requirement_ids' is distinct from '[]'::jsonb
   or s.input->'section'->'requirement_ids' is distinct from '[]'::jsonb
   or s.input ? 'rfp_context_version'
   or j.status<>'succeeded' or j.cancel_requested or j.lease_token is not null
   or not exists(select 1 from jsonb_array_elements(p.frozen_context->'blocks') b where length(trim(b->>'text'))>0)
   or exists(select 1 from public.proposal_versions v where v.plan_id=p.id)
   or exists(select 1 from public.generation_steps x where x.plan_id=p.id and
     (x.stage in ('commercial','review') or (x.stage='drafting' and x.task='advance_plan')))
   or exists(select 1 from public.provider_usage u where u.job_id=j.id and u.state in ('reserved','unknown'))
 then raise exception 'UNMAPPED_CONTEXT_REPLACEMENT_NOT_ALLOWED';end if;
 if (select count(*) from public.jobs where workspace_id=p.workspace_id and status in ('queued','running','retry_wait','quota_wait','blocked'))>=500
 then raise exception 'QUEUE_CAP_REACHED';end if;
 insert into public.jobs(workspace_id,type,entity_id,input_hash,status,checkpoint,created_by)
 values(p.workspace_id,s.task,p.id,p.input_hash,'queued',jsonb_build_object('rfp_context_replaces_job',j.id),p.created_by)
 returning id into replacement;
 update public.jobs set checkpoint=checkpoint||jsonb_build_object('rfp_context_replacement',
   jsonb_build_object('job_id',replacement,'step_snapshot',to_jsonb(s))),revision=revision+1,updated_at=now() where id=j.id;
 update public.generation_steps set job_id=replacement,input=input||'{"rfp_context_version":1}'::jsonb,
   output=null,status='queued',repair_count=0,revision=revision+1,updated_at=now() where id=s.id;
 update public.generation_plans set revision=revision+1,updated_at=now() where id=p.id;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
 values(p.workspace_id,p.created_by,'generation.unmapped_context_replaced',s.id,
   'General section requeued with the frozen RFP context; previous paid job retained: '||j.id::text,replacement);
 return replacement;
end $$;
revoke all on function app_private.replace_unmapped_draft_context(uuid,integer) from public,anon,authenticated,service_role;
