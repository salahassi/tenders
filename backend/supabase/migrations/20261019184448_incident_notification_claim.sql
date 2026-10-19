create or replace function public.claim_notification_delivery() returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.notification_deliveries;p public.notification_preferences;recipient text;counts jsonb;w uuid;active_keys text[];attempted text[];last_send timestamptz;
begin
 -- Match the tick/setting lock order and serialize delivery admission per workspace.
 select workspace_id into w from public.notification_deliveries where status in ('queued','retry_wait') and next_attempt_at<=now() order by created_at,id limit 1;
 if w is null then return null;end if;
 perform 1 from public.workspaces where id=w for update skip locked;
 if not found then return null;end if;
 select * into d from public.notification_deliveries where workspace_id=w and status in ('queued','retry_wait') and next_attempt_at<=now() order by created_at,id for update skip locked limit 1;
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
  select array_agg(value) into active_keys from jsonb_array_elements_text(counts->'incident_keys');
  insert into app_private.notification_failure_state(workspace_id,recipient_user_id,attempted_keys) values(w,p.user_id,app_private.reported_failure_keys(w,p.user_id)) on conflict do nothing;
  select attempted_keys into attempted from app_private.notification_failure_state where workspace_id=w and recipient_user_id=p.user_id for update;
  if d.attempts=0 and active_keys<@attempted then
   update public.notification_deliveries set status='canceled',error_code='INCIDENT_ALREADY_REPORTED',updated_at=now() where id=d.id;return null;
  end if;
  select max(coalesce(sent_at,started_at,created_at)) into last_send from public.notification_deliveries where workspace_id=w and recipient_user_id=p.user_id and kind='processing_failure' and id<>d.id and status in ('sent','sending','delivery_unknown');
  if last_send+make_interval(hours=>p.failure_interval_hours)>now() then
   update public.notification_deliveries set next_attempt_at=last_send+make_interval(hours=>p.failure_interval_hours),updated_at=now() where id=d.id;return null;
  end if;
  update public.notification_deliveries set payload=counts where id=d.id;
  -- Admission is recorded before SMTP. Definite transport failures retry this same
  -- delivery; an ambiguous send is never converted into a new incident email.
  update app_private.notification_failure_state set attempted_keys=active_keys,updated_at=now() where workspace_id=w and recipient_user_id=p.user_id;
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
