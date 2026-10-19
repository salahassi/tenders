create or replace function public.automation_notification_tick(transport_ready boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare w uuid;j public.jobs;p public.notification_preferences;counts jsonb;batch public.notification_deliveries;active_keys text[];attempted text[];last_send timestamptz;
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
  select coalesce(array_agg(distinct app_private.failure_incident_key(f.error_code,f.job_type)),'{}'::text[]) into active_keys from app_private.eligible_failure_notifications(w,p.user_id) f;
  insert into app_private.notification_failure_state(workspace_id,recipient_user_id,attempted_keys) values(w,p.user_id,app_private.reported_failure_keys(w,p.user_id)) on conflict do nothing;
  update app_private.notification_failure_state s set attempted_keys=array(select k from unnest(s.attempted_keys) k where k=any(active_keys)),updated_at=now()
   where s.workspace_id=w and s.recipient_user_id=p.user_id returning attempted_keys into attempted;
  select * into batch from public.notification_deliveries where workspace_id=w and recipient_user_id=p.user_id and kind='processing_failure' and status in ('queued','sending','retry_wait') for update;
  if batch.status='sending' then continue;end if;
  if cardinality(active_keys)=0 or (active_keys<@attempted and coalesce(batch.attempts,0)=0) then
   if batch.id is not null then update public.notification_deliveries set status='canceled',error_code=case when cardinality(active_keys)=0 then 'PROCESSING_RECOVERED' else 'INCIDENT_ALREADY_REPORTED' end,updated_at=now() where id=batch.id;end if;
   continue;
  end if;
  if batch.id is null then
   select max(coalesce(sent_at,started_at,created_at)) into last_send from public.notification_deliveries where workspace_id=w and recipient_user_id=p.user_id and kind='processing_failure' and status in ('sent','sending','delivery_unknown');
   insert into public.notification_deliveries(workspace_id,recipient_user_id,kind,dedupe_key,next_attempt_at)
   values(w,p.user_id,'processing_failure','failure-summary:'||gen_random_uuid(),greatest(now(),last_send+make_interval(hours=>p.failure_interval_hours))) returning * into batch;
  end if;
  -- Keep the actual snapshot current; previously reported causes may remain as context.
  update public.notification_deliveries set payload=app_private.failure_summary_payload(batch) where id=batch.id;
  insert into app_private.notification_failure_items(notification_id,delivery_id)
   select f.notification_id,batch.id from app_private.eligible_failure_notifications(w,p.user_id) f on conflict do nothing;
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


