-- Operational permission is deliberately not copied by business backup/restore.
alter table public.workspaces add column discovery_policy jsonb not null default '{"scope":"all","auto_public_notices":false,"providers":[]}'::jsonb
 check(jsonb_typeof(discovery_policy)='object' and discovery_policy->>'scope' in ('all','software_services') and pg_column_size(discovery_policy)<4096);

alter function app_private.generation_snapshot(uuid,uuid,uuid,uuid) rename to generation_snapshot_before_discovery;
revoke all on function app_private.generation_snapshot_before_discovery(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
create function app_private.generation_snapshot(w uuid,opp uuid,proposal uuid,package uuid) returns jsonb language sql security definer set search_path='' as $$
 select app_private.generation_snapshot_before_discovery(w,opp,proposal,package)||jsonb_build_object('discovery_scope',discovery_policy->>'scope') from public.workspaces where id=w
$$;
revoke all on function app_private.generation_snapshot(uuid,uuid,uuid,uuid) from public,anon,authenticated;

-- The provenance check compares every outbound notice field with a retained collector snapshot.
-- Merely assigning a public source to a manual/private notice grants no permission.
create function app_private.authorize_public_notice(w uuid,ref jsonb,provider text) returns void language plpgsql security definer set search_path='' as $$
declare policy jsonb;content jsonb;actor uuid;
begin
 select discovery_policy into policy from public.workspaces where id=w;
 actor:=(policy->>'approved_by')::uuid;
 if ref->>'entity_kind'<>'notice' or policy->'auto_public_notices' is distinct from 'true'::jsonb or not (policy->'providers' ? provider) or actor is null then return;end if;
 if not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=w and m.user_id=actor and m.active and m.role='Owner' and a.status='active') then return;end if;
 -- Any exact explicit revocation wins over automatic approval, including after configuration changes.
 if exists(select 1 from public.content_authorizations a where a.workspace_id=w and a.entity_kind='notice' and a.entity_id=(ref->>'entity_id')::uuid and a.content_hash=ref->>'content_hash' and a.provider=authorize_public_notice.provider) then return;end if;
 if not exists(
  select 1 from public.opportunities o
  join public.opportunity_source_links l on l.workspace_id=o.workspace_id and l.opportunity_id=o.id
  join public.sources s on s.workspace_id=l.workspace_id and s.id=l.source_id
  join public.advertisement_snapshots snap on snap.workspace_id=l.workspace_id and snap.source_link_id=l.id
  where o.workspace_id=w and o.id=(ref->>'entity_id')::uuid and not o.archived and s.approval='approved' and s.kind<>'manual' and s.policy_checked_at is not null
   and o.title=coalesce(snap.content->>'title','') and o.description=coalesce(snap.content->>'description','')
   and o.buyer=coalesce(snap.content->>'buyer','') and o.reference=coalesce(snap.content->>'reference','')
   and o.canonical_url=snap.content->>'canonical_url'
 ) then return;end if;
 content:=app_private.content_record(w,'notice',(ref->>'entity_id')::uuid);
 if content->>'content_hash' is distinct from ref->>'content_hash' then raise exception 'STALE_INPUT';end if;
 perform app_private.assert_business_content(content->>'content');
 insert into public.content_authorizations(workspace_id,entity_kind,entity_id,content_hash,provider,attestation,created_by)
 values(w,'notice',(ref->>'entity_id')::uuid,ref->>'content_hash',provider,'nonconfidential_nonpersonal',actor) on conflict do nothing;
 if found then insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
 values(w,actor,'discovery.authorize_public_notice',(ref->>'entity_id')::uuid,'Approved collector snapshot; exact hash; provider '||provider,gen_random_uuid());end if;
end $$;
revoke all on function app_private.authorize_public_notice(uuid,jsonb,text) from public,anon,authenticated;
create or replace function app_private.check_model_payload(w uuid,provider text,manifest jsonb) returns void language plpgsql security definer set search_path='' as $$
declare ref jsonb;content jsonb;
begin
 if jsonb_typeof(manifest) is distinct from 'array' or jsonb_array_length(manifest) not between 1 and 300 then raise exception 'DATA_AUTHORIZATION_REQUIRED';end if;
 for ref in select value from jsonb_array_elements(manifest) loop
  content:=app_private.content_record(w,ref->>'entity_kind',(ref->>'entity_id')::uuid);
  if content->>'content_hash' is distinct from ref->>'content_hash' then raise exception 'STALE_INPUT';end if;
  perform app_private.authorize_public_notice(w,ref,provider);
  if not exists(select 1 from public.content_authorizations a where a.workspace_id=w and a.entity_kind=ref->>'entity_kind' and a.entity_id=(ref->>'entity_id')::uuid and a.content_hash=ref->>'content_hash' and a.provider=check_model_payload.provider and a.revoked_at is null) then raise exception 'DATA_AUTHORIZATION_REQUIRED';end if;
 end loop;
end $$;

alter function app_private.app_command(text,jsonb,text) rename to discovery_previous_command;
revoke all on function app_private.discovery_previous_command(text,jsonb,text) from public,anon,authenticated,service_role;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid:=auth.uid();body_hash text;replay app_private.idempotency_records;result jsonb;policy jsonb;
begin
 if operation<>'discovery.configure' then
  result:=app_private.discovery_previous_command(operation,input,idempotency_key);
  if operation='content.authorize' then
   update public.opportunities o set assessment_pending=true where o.workspace_id=(result->>'workspace_id')::uuid and not o.archived
    and (input->>'entity_kind'='knowledge' or (input->>'entity_kind'='notice' and o.id=(input->>'entity_id')::uuid))
    and exists(select 1 from public.generation_plans p where p.opportunity_id=o.id and p.kind='assessment' and p.status='blocked' and p.error_code='DATA_AUTHORIZATION_REQUIRED');
  end if;return result;
 end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;
 if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;
 if app_private.member_role(w) is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 if exists(select 1 from public.restore_sessions where workspace_id=w and state='staging') then raise exception 'RESTORE_IN_PROGRESS';end if;
 perform app_private.check_keys(input,array['expected_revision','scope','auto_public_notices','providers']);
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(input)>4096
  or coalesce(input->>'scope','') not in ('all','software_services') or coalesce(input->>'auto_public_notices','') not in ('true','false')
  or jsonb_typeof(input->'providers') is distinct from 'array' then raise exception 'INVALID_INPUT';end if;
 if jsonb_array_length(input->'providers')>5 or exists(select 1 from jsonb_array_elements_text(input->'providers') p where p not in ('gemini_free','qwen_free','mistral_free','groq_free','cloudflare_free'))
  or (input->>'auto_public_notices')::boolean and jsonb_array_length(input->'providers')=0 then raise exception 'INVALID_INPUT';end if;
 body_hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then if replay.body_hash<>body_hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 policy:=(input-'expected_revision')||jsonb_build_object('approved_by',actor,'approved_at',now());
 update public.workspaces set discovery_policy=policy,evidence_revision=evidence_revision+1,revision=revision+1,updated_at=now() where id=w and revision=(input->>'expected_revision')::int returning to_jsonb(workspaces.*) into result;
 if result is null then raise exception 'REVISION_CONFLICT';end if;
 update public.opportunities set assessment_pending=true where workspace_id=w and not archived;
 update public.approvals set invalidated_at=coalesce(invalidated_at,now()) where workspace_id=w;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id) values(w,actor,operation,w,policy::text,gen_random_uuid());
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,body_hash,result);
 return result;
end $$;
revoke all on function app_private.app_command(text,jsonb,text) from public,anon;grant execute on function app_private.app_command(text,jsonb,text) to authenticated;

-- Compact RLS-preserving progress surface: no frozen business content is exposed by this view.
create view public.opportunity_discovery with(security_invoker=true) as
select o.id,o.workspace_id,o.created_at,o.revision,
 a.id as assessment_id,
 coalesce(a.evidence_revision=w.evidence_revision and ap.frozen_context->'notice'->'reference'->>'content_hash'=h.notice_hash,false) as assessment_current,
 a.routing,
 case
  when p.evidence_revision=w.evidence_revision and p.frozen_context->'notice'->'reference'->>'content_hash'=h.notice_hash
   and p.status in ('queued','running') and j.status in ('queued','running','retry_wait','quota_wait') and not j.cancel_requested then j.status
  when a.evidence_revision=w.evidence_revision and ap.frozen_context->'notice'->'reference'->>'content_hash'=h.notice_hash then 'assessed'
  when p.evidence_revision=w.evidence_revision and p.frozen_context->'notice'->'reference'->>'content_hash'=h.notice_hash and p.status in ('blocked','failed') then p.status
  when o.assessment_pending then 'pending_schedule'
  else 'not_started' end as assessment_state,
 case when p.status in ('blocked','failed') then p.error_code else j.error_code end as assessment_error,
 j.next_attempt_at,
 coalesce(a.evidence_revision=w.evidence_revision and ap.frozen_context->'notice'->'reference'->>'content_hash'=h.notice_hash and a.routing<>'excluded',false) as inbox_visible
from public.opportunities o join public.workspaces w on w.id=o.workspace_id
cross join lateral(select encode(sha256(convert_to(o.title||E'\n'||o.description||E'\n'||o.buyer||E'\n'||o.reference,'UTF8')),'hex') notice_hash) h
left join lateral(select f.* from public.fit_assessments f where f.workspace_id=o.workspace_id and f.opportunity_id=o.id order by f.created_at desc,f.id desc limit 1) a on true
left join public.generation_plans ap on ap.id=a.plan_id and ap.workspace_id=o.workspace_id
left join lateral(select gp.* from public.generation_plans gp where gp.workspace_id=o.workspace_id and gp.opportunity_id=o.id and gp.kind='assessment' order by gp.created_at desc,gp.id desc limit 1) p on true
left join lateral(select jb.* from public.jobs jb where jb.workspace_id=o.workspace_id and jb.entity_id=p.id order by case when jb.status in ('queued','running','retry_wait','quota_wait') then 0 when jb.status='blocked' then 1 else 2 end,jb.created_at desc,jb.id desc limit 1) j on true
where not o.archived;
grant select on public.opportunity_discovery to authenticated,service_role;
create index generation_plans_discovery on public.generation_plans(workspace_id,opportunity_id,created_at desc,id desc) where kind='assessment';
create index fit_assessments_discovery on public.fit_assessments(workspace_id,opportunity_id,created_at desc,id desc);
create index jobs_discovery on public.jobs(workspace_id,entity_id,created_at desc,id desc);

create or replace function public.schedule_assessment_refresh() returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid;o public.opportunities;p public.generation_plans;context jsonb;version bigint;n integer:=0;existing public.generation_plans;notice_hash text;manifest jsonb;provider text;
begin
 select id,evidence_revision into w,version from public.workspaces limit 1;if w is null then return jsonb_build_object('scheduled',0);end if;
 perform 1 from public.workspaces where id=w for update;
 if not exists(select 1 from public.model_settings where workspace_id=w and enabled) or exists(select 1 from public.restore_sessions where workspace_id=w and state='staging') then return jsonb_build_object('scheduled',0);end if;
 select m.user_id into actor from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=w and m.active and m.role='Owner' and a.status='active' order by m.created_at limit 1;
 if actor is null then return jsonb_build_object('scheduled',0);end if;
 update public.opportunities pending_opp set assessment_pending=true where pending_opp.workspace_id=w and not pending_opp.archived and exists(select 1 from public.generation_plans active_plan where active_plan.opportunity_id=pending_opp.id and active_plan.kind='assessment' and active_plan.status in ('queued','running','blocked') and (active_plan.evidence_revision<>version or active_plan.frozen_context->'notice'->'reference'->>'content_hash' is distinct from app_private.content_record(w,'notice',pending_opp.id)->>'content_hash'));
 for o in select * from public.opportunities where workspace_id=w and assessment_pending and not archived order by updated_at,id limit 20 loop
 if (select count(*) from public.jobs where workspace_id=w and status in ('queued','running','retry_wait','quota_wait','blocked'))>=480 then exit;end if;
 notice_hash:=app_private.content_record(w,'notice',o.id)->>'content_hash';
 select * into existing from public.generation_plans where opportunity_id=o.id and kind='assessment' and status in ('queued','running','blocked') and evidence_revision=version and frozen_context->'notice'->'reference'->>'content_hash'=notice_hash order by created_at desc,id desc limit 1;
 if existing.id is not null then
  if existing.status='blocked' and existing.error_code='DATA_AUTHORIZATION_REQUIRED' then
   begin
    select m.provider into provider from public.model_settings m where m.workspace_id=w and m.enabled order by m.failover_rank limit 1;
    select jsonb_agg(e->'reference') into manifest from jsonb_array_elements(jsonb_build_array(existing.frozen_context->'notice')||(existing.frozen_context->'knowledge')) e;
    perform app_private.check_model_payload(w,provider,manifest);
    update public.jobs set status='queued',error_code=null,next_attempt_at=now(),revision=revision+1,updated_at=now() where entity_id=existing.id and status='blocked' and error_code='DATA_AUTHORIZATION_REQUIRED' and not cancel_requested;
    if found then update public.generation_plans set status='queued',error_code=null,revision=revision+1,updated_at=now() where id=existing.id;n:=n+1;end if;
   exception when raise_exception then null;
   end;
  end if;
  update public.opportunities set assessment_pending=false where id=o.id;continue;
 end if;
 update public.jobs set cancel_requested=true,status=case when status='running' then status else 'canceled' end,revision=revision+1,updated_at=now() where entity_id in(select id from public.generation_plans where opportunity_id=o.id and kind='assessment' and status in ('queued','running','blocked')) and status not in ('succeeded','failed','canceled');
 update public.generation_plans set status='canceled',error_code='REASSESSMENT_SUPERSEDED',revision=revision+1,updated_at=now() where opportunity_id=o.id and kind='assessment' and status in ('queued','running','blocked');
 begin
 context:=app_private.generation_snapshot(w,o.id,null,null);
 insert into public.generation_plans(workspace_id,opportunity_id,kind,stage,evidence_revision,input_hash,frozen_context,created_by) values(w,o.id,'assessment','assessment',version,encode(sha256(convert_to(context::text,'UTF8')),'hex'),context,actor) returning * into p;
 perform app_private.enqueue_generation(p,'classify_opportunity','{}');n:=n+1;
 exception when check_violation or raise_exception then perform app_private.notify_members(w,'assessment-blocked:'||o.id||':'||version,'Assessment needs attention','The evidence exceeds the generation boundary. Review the company profile and request assessment again.',o.id,actor);
 end;
 update public.opportunities set assessment_pending=false where id=o.id;
 end loop;return jsonb_build_object('scheduled',n);
end $$;
revoke all on function public.schedule_assessment_refresh() from public,anon,authenticated;grant execute on function public.schedule_assessment_refresh() to service_role;

-- A discovery notification also waits for assessment. Physical exclusions stay in history.
alter function app_private.notify_members(uuid,text,text,text,uuid,uuid) rename to notify_members_before_discovery;
revoke all on function app_private.notify_members_before_discovery(uuid,text,text,text,uuid,uuid) from public,anon,authenticated,service_role;
create function app_private.notify_members(w uuid,event_key text,title text,body text,entity uuid,actor uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if event_key like 'notice:%' then return;end if;
 if event_key like 'assessment:%' and exists(select 1 from public.fit_assessments f where f.workspace_id=w and f.plan_id::text=substring(event_key from 12) and f.routing='excluded') then return;end if;
 perform app_private.notify_members_before_discovery(w,event_key,title,body,entity,actor);
end $$;
revoke all on function app_private.notify_members(uuid,text,text,text,uuid,uuid) from public,anon,authenticated;

create function app_private.reset_discovery_on_restore() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.restore_origin is distinct from old.restore_origin then
  new.discovery_policy:='{"scope":"all","auto_public_notices":false,"providers":[]}'::jsonb;
 end if;
 return new;
end $$;
revoke all on function app_private.reset_discovery_on_restore() from public,anon,authenticated;
create trigger reset_discovery_on_restore before update of restore_origin on public.workspaces for each row execute function app_private.reset_discovery_on_restore();
