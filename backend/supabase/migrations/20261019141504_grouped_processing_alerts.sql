-- Aggregate persistent processing failures per recipient without changing job recovery.
alter table public.notification_preferences add column failure_interval_hours integer not null default 1 check(failure_interval_hours in (1,6,12,24));
create table app_private.notification_failure_items (
 notification_id uuid primary key references public.notifications(id) on delete cascade,
 delivery_id uuid not null references public.notification_deliveries(id) on delete cascade
);
create index notification_failure_items_delivery on app_private.notification_failure_items(delivery_id);
revoke all on app_private.notification_failure_items from public,anon,authenticated;

-- Already-sent/ambiguous mail stays final. Unsent individual alerts join a summary.
update public.notification_deliveries set status='canceled',error_code='ALERT_BATCHED',updated_at=now()
 where kind='processing_failure' and status in ('queued','retry_wait');
create unique index one_pending_failure_summary on public.notification_deliveries(workspace_id,recipient_user_id)
 where kind='processing_failure' and status in ('queued','sending','retry_wait');

create function app_private.current_failure_notifications(w uuid,u uuid)
returns table(notification_id uuid,error_code text,job_type text,job_status text,attempts integer)
language sql stable security definer set search_path='' as $$
 select n.id,coalesce(j.error_code,'MODEL_CONTEXT_TOO_LARGE'),coalesce(j.type,'classify_opportunity'),coalesce(j.status,'blocked'),coalesce(j.attempts,0)
 from public.notifications n left join public.jobs j on j.workspace_id=n.workspace_id and n.dedupe_key='automation-failure:'||j.id
 where n.workspace_id=w and n.recipient_user_id=u and (
  (j.id is not null and not j.cancel_requested and j.status in ('queued','running','retry_wait','quota_wait','blocked','failed')
   and not exists(select 1 from public.generation_plans gp where gp.id=j.entity_id and gp.status in ('canceled','completed')))
  or (n.dedupe_key like 'assessment-blocked:%' and exists(select 1 from public.opportunity_discovery d where d.id=n.entity_id and d.workspace_id=w and d.assessment_state in ('blocked','failed','pending_schedule') and not d.assessment_current))
 )
$$;
revoke all on function app_private.current_failure_notifications(uuid,uuid) from public,anon,authenticated,service_role;

create function app_private.failure_summary_payload(d public.notification_deliveries) returns jsonb
language sql stable security definer set search_path='' as $$
 with current_issues as (
  select f.* from app_private.current_failure_notifications(d.workspace_id,d.recipient_user_id) f
  join app_private.notification_failure_items i on i.notification_id=f.notification_id and i.delivery_id=d.id
 ), grouped as (
  select error_code,job_type,count(*) as count,max(attempts) as max_attempts,
   bool_and(job_status in ('queued','running','retry_wait','quota_wait')) as retrying
  from current_issues group by error_code,job_type order by count(*) desc,error_code,job_type limit 25
 )
 select jsonb_build_object('total',(select count(*) from current_issues),'groups',coalesce((select jsonb_agg(to_jsonb(g)) from grouped g),'[]'::jsonb))
$$;
revoke all on function app_private.failure_summary_payload(public.notification_deliveries) from public,anon,authenticated,service_role;

create or replace function public.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid:=auth.uid();prefs public.notification_preferences;result jsonb;body_hash text;replay app_private.idempotency_records;
begin
 if operation not in ('notification.preferences','notification.test') then return public.app_command_before_notifications(operation,input,idempotency_key);end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;
 if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or input is null or jsonb_typeof(input)<>'object' or pg_column_size(input)>4096 then raise exception 'INVALID_INPUT';end if;
 body_hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and route=operation and method='COMMAND' and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then
  if replay.body_hash<>body_hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;
 end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and route=operation and method='COMMAND' and key=idempotency_key;
 select * into prefs from public.notification_preferences where workspace_id=w and user_id=actor;
 if operation='notification.preferences' then
  perform app_private.check_keys(input,array['expected_revision','email_enabled','failure_alerts','failure_interval_hours','review_reminders','review_interval_hours','language']);
  if coalesce(input->>'email_enabled','') not in ('true','false') or coalesce(input->>'failure_alerts','') not in ('true','false') or coalesce(input->>'review_reminders','') not in ('true','false')
   or coalesce(input->>'language','') not in ('ar','en') or coalesce((input->>'review_interval_hours')::int,0) not in (6,12,24,48,168) then raise exception 'INVALID_INPUT';end if;
  if input ? 'failure_interval_hours' and (jsonb_typeof(input->'failure_interval_hours')<>'number' or coalesce((input->>'failure_interval_hours')::int,0) not in (1,6,12,24)) then raise exception 'INVALID_INPUT';end if;
  if coalesce(prefs.revision,0) is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  insert into public.notification_preferences(workspace_id,user_id,email_enabled,failure_alerts,failure_interval_hours,review_reminders,review_interval_hours,language,next_review_at)
  values(w,actor,(input->>'email_enabled')::boolean,(input->>'failure_alerts')::boolean,coalesce((input->>'failure_interval_hours')::int,prefs.failure_interval_hours,1),(input->>'review_reminders')::boolean,(input->>'review_interval_hours')::int,input->>'language',now()+make_interval(hours=>(input->>'review_interval_hours')::int))
  on conflict(workspace_id,user_id) do update set email_enabled=excluded.email_enabled,failure_alerts=excluded.failure_alerts,failure_interval_hours=excluded.failure_interval_hours,review_reminders=excluded.review_reminders,
   review_interval_hours=excluded.review_interval_hours,language=excluded.language,
   next_review_at=case when notification_preferences.review_interval_hours<>excluded.review_interval_hours or not notification_preferences.email_enabled then excluded.next_review_at else notification_preferences.next_review_at end,
   revision=notification_preferences.revision+1,updated_at=now() returning to_jsonb(notification_preferences.*) into result;
  update public.notification_deliveries set status='canceled',error_code='PREFERENCES_DISABLED',updated_at=now() where workspace_id=w and recipient_user_id=actor and status in ('queued','retry_wait')
   and ((input->>'email_enabled')='false' or (kind='processing_failure' and input->>'failure_alerts'='false') or (kind='review_digest' and input->>'review_reminders'='false'));
 else
  perform app_private.check_keys(input,array[]::text[]);
  if prefs.user_id is null or not prefs.email_enabled then raise exception 'EMAIL_PREFERENCES_DISABLED';end if;
  if exists(select 1 from public.notification_deliveries where workspace_id=w and recipient_user_id=actor and kind='test' and created_at>now()-interval '5 minutes') then raise exception 'EMAIL_TEST_RATE_WAIT';end if;
  insert into public.notification_deliveries(workspace_id,recipient_user_id,kind,dedupe_key) values(w,actor,'test','test:'||idempotency_key) returning to_jsonb(notification_deliveries.*) into result;
 end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,request_id) values(w,actor,operation,actor,gen_random_uuid());
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,body_hash,result);
 return result;
end $$;
revoke all on function public.app_command(text,jsonb,text) from public,anon;
grant execute on function public.app_command(text,jsonb,text) to authenticated;

create or replace function public.notification_settings() returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid:=auth.uid();prefs jsonb;
begin
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;
 if w is null then raise exception 'ACCESS_PENDING';end if;
 select to_jsonb(p) into prefs from public.notification_preferences p where workspace_id=w and user_id=actor;
 return jsonb_build_object('preferences',coalesce(prefs,jsonb_build_object('revision',0,'email_enabled',false,'failure_alerts',true,'failure_interval_hours',1,'review_reminders',true,'review_interval_hours',24,'language','ar')),
  'recipient',(select email from auth.users where id=actor and email_confirmed_at is not null),
  'deliveries',(select coalesce(jsonb_agg(x),'[]') from(select id,kind,status,attempts,error_code,created_at,sent_at,next_attempt_at from public.notification_deliveries where workspace_id=w and recipient_user_id=actor order by created_at desc,id desc limit 20)x));
end $$;
revoke all on function public.notification_settings() from public,anon;
grant execute on function public.notification_settings() to authenticated;

create or replace function public.automation_notification_tick(transport_ready boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare w uuid;j public.jobs;p public.notification_preferences;counts jsonb;batch public.notification_deliveries;ids uuid[];
begin
 select id into w from public.workspaces limit 1;if w is null then return;end if;
 perform 1 from public.workspaces where id=w for update;
 if exists(select 1 from public.restore_sessions where workspace_id=w and state='staging') then return;end if;
 update public.operations set email_transport_ready=transport_ready,email_transport_checked_at=now() where workspace_id=w;
 -- Crashed leases enter the same recovery policy; never revive cancellations or superseded evidence.
 for j in select * from public.jobs where workspace_id=w and status='blocked' and error_code in ('COLLECTION_LEASE_EXPIRED','LEASE_EXPIRED_REVIEW_REQUIRED') and not cancel_requested loop
  perform app_private.recover_processing_job(j.id);
 end loop;
 -- An expired SMTP lease can have been accepted remotely. Do not silently send it twice.
 update public.notification_deliveries set status='delivery_unknown',error_code='SMTP_DELIVERY_UNCONFIRMED',lease_token=null,lease_until=null,updated_at=now() where workspace_id=w and status='sending' and lease_until<now();
 for p in select * from public.notification_preferences where workspace_id=w and email_enabled and failure_alerts for update loop
  select * into batch from public.notification_deliveries where workspace_id=w and recipient_user_id=p.user_id and kind='processing_failure' and status in ('queued','sending','retry_wait') for update;
  if batch.status='sending' then continue;end if;
  if batch.id is null and exists(select 1 from public.notification_deliveries where workspace_id=w and recipient_user_id=p.user_id and kind='processing_failure' and error_code is distinct from 'ALERT_BATCHED' and coalesce(started_at,created_at)>now()-make_interval(hours=>p.failure_interval_hours)) then continue;end if;
  select array_agg(x.notification_id) into ids from (
   select f.notification_id from app_private.current_failure_notifications(w,p.user_id) f join public.notifications n on n.id=f.notification_id
   where n.created_at>=p.created_at
    and not exists(select 1 from app_private.notification_failure_items i where i.notification_id=n.id)
    and not exists(select 1 from public.notification_deliveries old where old.notification_id=n.id and old.error_code is distinct from 'ALERT_BATCHED')
   order by n.created_at,n.id limit 1000
  ) x;
  if coalesce(cardinality(ids),0)=0 then continue;end if;
  if batch.id is null then
   insert into public.notification_deliveries(workspace_id,recipient_user_id,kind,dedupe_key)
   values(w,p.user_id,'processing_failure','failure-summary:'||gen_random_uuid()) returning * into batch;
  end if;
  insert into app_private.notification_failure_items(notification_id,delivery_id) select unnest(ids),batch.id on conflict do nothing;
  update public.notification_deliveries set payload=app_private.failure_summary_payload(batch) where id=batch.id;
 end loop;
 delete from public.notification_deliveries where id in(select d.id from public.notification_deliveries d join public.workspaces ws on ws.id=d.workspace_id where d.workspace_id=w and d.status in ('sent','canceled','failed') and d.updated_at<now()-make_interval(days=>coalesce((ws.settings->>'retention_days')::int,90)) order by d.updated_at limit 500);
 counts:=app_private.review_notification_counts(w);
 for p in select * from public.notification_preferences where workspace_id=w and email_enabled and review_reminders and next_review_at<=now() for update loop
  if (counts->>'discoveries')::int+(counts->>'proposals')::int>0 then
   insert into public.notification_deliveries(workspace_id,recipient_user_id,kind,dedupe_key,payload)
   values(w,p.user_id,'review_digest','review:'||p.user_id||':'||p.next_review_at::text,counts) on conflict do nothing;
  end if;
  update public.notification_preferences set next_review_at=now()+make_interval(hours=>p.review_interval_hours) where workspace_id=w and user_id=p.user_id;
 end loop;
end $$;

create or replace function public.claim_notification_delivery() returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.notification_deliveries;p public.notification_preferences;recipient text;counts jsonb;
begin
 select * into d from public.notification_deliveries where status in ('queued','retry_wait') and next_attempt_at<=now() order by created_at,id for update skip locked limit 1;
 if d.id is null then return null;end if;
 if exists(select 1 from public.restore_sessions where workspace_id=d.workspace_id and state='staging') then return null;end if;
 select * into p from public.notification_preferences where workspace_id=d.workspace_id and user_id=d.recipient_user_id;
 select u.email into recipient from auth.users u join public.memberships m on m.user_id=u.id join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=u.id
 where u.id=d.recipient_user_id and m.workspace_id=d.workspace_id and m.active and a.status='active' and u.email_confirmed_at is not null;
 if recipient is null or not coalesce(p.email_enabled,false) or (d.kind='processing_failure' and not p.failure_alerts) or (d.kind='review_digest' and not p.review_reminders) then
  update public.notification_deliveries set status='canceled',error_code='RECIPIENT_OR_PREFERENCES_UNAVAILABLE',updated_at=now() where id=d.id;return null;
 end if;
 if d.kind='processing_failure' then
  counts:=app_private.failure_summary_payload(d);
  if (counts->>'total')::int=0 then update public.notification_deliveries set status='canceled',error_code='PROCESSING_RECOVERED',updated_at=now() where id=d.id;return null;end if;
  update public.notification_deliveries set payload=counts where id=d.id;
 end if;
 if d.kind='review_digest' then
  counts:=app_private.review_notification_counts(d.workspace_id);
  if (counts->>'discoveries')::int+(counts->>'proposals')::int=0 then update public.notification_deliveries set status='canceled',error_code='REVIEW_INBOX_EMPTY',updated_at=now() where id=d.id;return null;end if;
  update public.notification_deliveries set payload=counts where id=d.id;
 end if;
 update public.notification_deliveries set status='sending',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',started_at=now(),updated_at=now() where id=d.id returning * into d;
 return to_jsonb(d)||jsonb_build_object('recipient',recipient,'language',p.language);
end $$;

revoke all on function public.automation_notification_tick(boolean),public.claim_notification_delivery() from public,anon,authenticated;
grant execute on function public.automation_notification_tick(boolean),public.claim_notification_delivery() to service_role;
