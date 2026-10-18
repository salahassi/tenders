-- Only a current model assessment can confirm scope, regardless of chosen source.
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
 coalesce(detail.ready and not (a.result ? 'rule_exclusion') and a.evidence_revision=w.evidence_revision and ap.frozen_context->'notice'->'reference'->>'content_hash'=h.notice_hash and not detail.expired and a.routing<>'excluded' and a.result->'scope_decision'->>'status'='in_scope',false) as inbox_visible,detail.expired as is_expired,case when detail.ready then o.notice_evidence->>'status' else 'pending' end as notice_details_status,coalesce((j.checkpoint->'model_routing'->>'round_attempts')::int,j.attempts,0) as assessment_attempts
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
