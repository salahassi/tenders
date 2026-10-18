-- Public detail retrieval is a durable, leased step before classification.
-- Metadata records what was actually read; it never confirms an RFP package.
alter table public.opportunities add column notice_evidence jsonb not null default '{}' check(pg_column_size(notice_evidence)<=32768);
alter function app_private.generation_snapshot(uuid,uuid,uuid,uuid) rename to generation_snapshot_before_details;
revoke all on function app_private.generation_snapshot_before_details(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
create function app_private.generation_snapshot(w uuid,opp uuid,proposal uuid,package uuid) returns jsonb language sql security definer set search_path='' as $$
 select app_private.generation_snapshot_before_details(w,opp,proposal,package)||jsonb_build_object('notice_evidence',notice_evidence) from public.opportunities where workspace_id=w and id=opp
$$;
revoke all on function app_private.generation_snapshot(uuid,uuid,uuid,uuid) from public,anon,authenticated;

alter function public.generation_context(uuid,uuid) rename to generation_context_before_details;
revoke all on function public.generation_context_before_details(uuid,uuid) from public,anon,authenticated,service_role;
create function public.generation_context(job_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;o public.opportunities;s public.sources;item jsonb;notice_hash text;
begin
 ctx:=public.generation_context_before_details(job_id,lease);
 if ctx->'step'->>'task'<>'classify_opportunity' then return ctx;end if;
 select * into o from public.opportunities where id=(ctx->'plan'->>'opportunity_id')::uuid;
 notice_hash:=app_private.content_record(o.workspace_id,'notice',o.id)->>'content_hash';
 if ctx->'plan'->'frozen_context'->'notice'->'reference'->>'content_hash' is distinct from notice_hash then raise exception 'STALE_INPUT';end if;
 select * into s from public.sources where workspace_id=o.workspace_id and id=o.source_id;
 if not coalesce(s.adapter_config ? 'official_listing',false) or (o.notice_evidence->>'version'='1' and o.notice_evidence->>'notice_hash'=notice_hash and coalesce((o.notice_evidence->>'fetched_at')::timestamptz>=s.last_success_at,true)) then return ctx;end if;
 if s.approval<>'approved' or s.policy_checked_at is null then raise exception 'SOURCE_PERMISSION_REQUIRED';end if;
 select snap.content||jsonb_build_object('identity_key',l.identity_key) into item from public.opportunity_source_links l join public.advertisement_snapshots snap on snap.source_link_id=l.id and snap.workspace_id=l.workspace_id
 where l.workspace_id=o.workspace_id and l.opportunity_id=o.id and l.source_id=s.id and snap.content->>'title'=o.title and snap.content->>'description'=o.description and snap.content->>'canonical_url'=o.canonical_url order by snap.created_at desc limit 1;
 if item is null then raise exception 'NOTICE_SOURCE_EVIDENCE_CHANGED';end if;
 return ctx||jsonb_build_object('detail_source',to_jsonb(s),'detail_notice',item);
end $$;
revoke all on function public.generation_context(uuid,uuid) from public,anon,authenticated;
grant execute on function public.generation_context(uuid,uuid) to service_role;

create function public.complete_notice_details(job_id uuid,lease uuid,result jsonb) returns void language plpgsql security definer set search_path='' as $$
declare ctx jsonb;w uuid;s public.sources;o uuid;j public.jobs;metadata jsonb;closing timestamptz;zone text;
begin
 select workspace_id into w from public.jobs where id=job_id;perform 1 from public.workspaces where id=w for update;
 ctx:=public.generation_context(job_id,lease);
 if ctx->'detail_source' is null then raise exception 'NOTICE_DETAILS_NOT_REQUIRED';end if;
 select * into j from public.jobs where id=job_id for update;
 select * into s from public.sources where id=(ctx->'detail_source'->>'id')::uuid and workspace_id=w;
 metadata:=result->'notice_evidence';
 if result->>'identity_key' is distinct from ctx->'detail_notice'->>'identity_key' or result->>'canonical_url' is distinct from ctx->'detail_notice'->>'canonical_url'
  or length(coalesce(result->>'description','')) not between 80 and 50000 or metadata is null or metadata->>'version' is distinct from '1' or coalesce(metadata->>'status','') not in ('read','partial') or pg_column_size(metadata)>32000 then raise exception 'INVALID_NOTICE_DETAILS';end if;
 update public.jobs set status='canceled',error_code='NOTICE_DETAILS_REFRESHED',lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
 update public.generation_plans set status='canceled',error_code='NOTICE_DETAILS_REFRESHED',revision=revision+1,updated_at=now() where id=j.entity_id;
 o:=app_private.ingest_notice(w,s,result,j.created_by);
 zone:=metadata->'deadline'->>'timezone';
 if zone in ('Asia/Hebron','Asia/Amman') and metadata->'deadline'->>'local' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00$' then closing:=(metadata->'deadline'->>'local')::timestamp at time zone zone;end if;
 metadata:=metadata||jsonb_build_object('notice_hash',app_private.content_record(w,'notice',o)->>'content_hash');
 update public.opportunities set notice_evidence=metadata,deadline_at=coalesce(closing,deadline_at),deadline_timezone=case when closing is not null then zone else deadline_timezone end,assessment_pending=true,revision=revision+1,updated_at=now() where id=o and workspace_id=w;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id) values(w,j.created_by,'notice.details_collected',o,jsonb_build_object('detail_url',metadata->>'detail_url','status',metadata->>'status','attachments',jsonb_array_length(metadata->'attachments'))::text,gen_random_uuid());
end $$;
revoke all on function public.complete_notice_details(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.complete_notice_details(uuid,uuid,jsonb) to service_role;

create function public.fail_notice_details(job_id uuid,lease uuid,error_code text) returns void language plpgsql security definer set search_path='' as $$
declare ctx jsonb;j public.jobs;state text;w uuid;
begin
 select workspace_id into w from public.jobs where id=job_id;perform 1 from public.workspaces where id=w for update;
 ctx:=public.generation_context(job_id,lease);select * into j from public.jobs where id=job_id;
 state:=case when error_code in ('SOURCE_TEMPORARY_FAILURE','SOURCE_TIMEOUT') then 'retry_wait' else 'blocked' end;
 update public.jobs set status=state,error_code=fail_notice_details.error_code,lease_token=null,lease_until=null,next_attempt_at=case when state='retry_wait' then now()+make_interval(secs=>least(3600,60*power(2,least(j.attempts,6)))::int) else 'infinity' end,revision=revision+1,updated_at=now() where id=j.id;
 update public.generation_plans set status=case when state='blocked' then 'blocked' else 'running' end,error_code=fail_notice_details.error_code,revision=revision+1,updated_at=now() where id=j.entity_id;
end $$;
revoke all on function public.fail_notice_details(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fail_notice_details(uuid,uuid,text) to service_role;

-- Re-read details after a successful source poll, even when listing text/ETag is unchanged.
alter function public.schedule_assessment_refresh() rename to schedule_assessment_refresh_before_details;
revoke all on function public.schedule_assessment_refresh_before_details() from public,anon,authenticated,service_role;
create function public.schedule_assessment_refresh() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 update public.opportunities o set assessment_pending=true from public.sources s where s.workspace_id=o.workspace_id and s.id=o.source_id and s.approval='approved' and s.adapter_config ? 'official_listing' and not o.archived and (o.notice_evidence->>'fetched_at')::timestamptz<s.last_success_at;
 return public.schedule_assessment_refresh_before_details();
end $$;
revoke all on function public.schedule_assessment_refresh() from public,anon,authenticated;
grant execute on function public.schedule_assessment_refresh() to service_role;

-- Existing listing-only assessments are superseded without changing human decisions.
update public.jobs set cancel_requested=true,status=case when status='running' then status else 'canceled' end,revision=revision+1,updated_at=now()
where entity_id in(select p.id from public.generation_plans p join public.opportunities o on o.id=p.opportunity_id join public.sources s on s.id=o.source_id where s.adapter_config ? 'official_listing' and p.kind='assessment' and p.status in ('queued','running','blocked')) and status not in ('succeeded','failed','canceled');
update public.generation_plans p set status='canceled',error_code='NOTICE_DETAILS_REQUIRED',revision=p.revision+1,updated_at=now() from public.opportunities o join public.sources s on s.id=o.source_id where p.opportunity_id=o.id and s.adapter_config ? 'official_listing' and p.kind='assessment' and p.status in ('queued','running','blocked');
update public.opportunities o set assessment_pending=true from public.sources s where s.id=o.source_id and s.adapter_config ? 'official_listing' and not o.archived;

create or replace view public.opportunity_discovery with(security_invoker=true) as
select o.id,o.workspace_id,o.created_at,o.revision,
 a.id as assessment_id,
 coalesce(detail.ready and not (a.result ? 'rule_exclusion') and a.evidence_revision=w.evidence_revision and ap.frozen_context->'notice'->'reference'->>'content_hash'=h.notice_hash,false) as assessment_current,
 a.routing,
 case
  when p.evidence_revision=w.evidence_revision and p.frozen_context->'notice'->'reference'->>'content_hash'=h.notice_hash
   and p.status in ('queued','running') and j.status in ('queued','running','retry_wait','quota_wait') and not j.cancel_requested then j.status
  when detail.ready and not (a.result ? 'rule_exclusion') and a.evidence_revision=w.evidence_revision and ap.frozen_context->'notice'->'reference'->>'content_hash'=h.notice_hash then 'assessed'
  when p.evidence_revision=w.evidence_revision and p.frozen_context->'notice'->'reference'->>'content_hash'=h.notice_hash and p.status in ('blocked','failed') then p.status
  when o.assessment_pending then 'pending_schedule'
  else 'not_started' end as assessment_state,
 case when p.status in ('blocked','failed') then p.error_code else j.error_code end as assessment_error,
 j.next_attempt_at,
 coalesce(detail.ready and not (a.result ? 'rule_exclusion') and a.evidence_revision=w.evidence_revision and ap.frozen_context->'notice'->'reference'->>'content_hash'=h.notice_hash and not detail.expired and a.routing<>'excluded' and (w.discovery_policy->>'scope'<>'software_services' or a.result->'scope_decision'->>'status'='in_scope'),false) as inbox_visible,detail.expired as is_expired,case when detail.ready then o.notice_evidence->>'status' else 'pending' end as notice_details_status
from public.opportunities o join public.workspaces w on w.id=o.workspace_id
cross join lateral(select encode(sha256(convert_to(o.title||E'\n'||o.description||E'\n'||o.buyer||E'\n'||o.reference,'UTF8')),'hex') notice_hash) h
left join public.sources src on src.id=o.source_id and src.workspace_id=o.workspace_id
cross join lateral(select
 (not coalesce(src.adapter_config ? 'official_listing',false) or coalesce(o.notice_evidence->>'version'='1' and o.notice_evidence->>'notice_hash'=h.notice_hash,false)) ready,
 coalesce(o.deadline_at<=now(),(o.notice_evidence->'deadline'->>'date') ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' and (o.notice_evidence->'deadline'->>'date') < to_char(now() at time zone case when o.notice_evidence->'deadline'->>'timezone'='Asia/Amman' then 'Asia/Amman' else 'Asia/Hebron' end,'YYYY-MM-DD'),false) expired
) detail
left join lateral(select f.* from public.fit_assessments f where f.workspace_id=o.workspace_id and f.opportunity_id=o.id order by f.created_at desc,f.id desc limit 1) a on true
left join public.generation_plans ap on ap.id=a.plan_id and ap.workspace_id=o.workspace_id
left join lateral(select gp.* from public.generation_plans gp where gp.workspace_id=o.workspace_id and gp.opportunity_id=o.id and gp.kind='assessment' order by gp.created_at desc,gp.id desc limit 1) p on true
left join lateral(select jb.* from public.jobs jb where jb.workspace_id=o.workspace_id and jb.entity_id=p.id order by case when jb.status in ('queued','running','retry_wait','quota_wait') then 0 when jb.status='blocked' then 1 else 2 end,jb.created_at desc,jb.id desc limit 1) j on true
where not o.archived;
