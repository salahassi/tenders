create function app_private.review_notification_counts(w uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('discoveries',(select count(*) from public.opportunity_discovery d join public.opportunities o on o.id=d.id where d.workspace_id=w and d.inbox_visible and o.decision in ('undecided','deferred')),
 'proposals',(select count(*) from public.proposals p join public.opportunities o on o.id=p.opportunity_id where p.workspace_id=w and not o.archived and p.active_version_id is not null and p.state in ('draft','in_review','changes_requested')))
$$;
revoke all on function app_private.review_notification_counts(uuid) from public,anon,authenticated,service_role;

create function public.automation_notification_tick(transport_ready boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare w uuid;j public.jobs;p public.notification_preferences;counts jsonb;
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
 insert into public.notification_deliveries(workspace_id,recipient_user_id,kind,dedupe_key,notification_id,payload)
 select n.workspace_id,n.recipient_user_id,'processing_failure',n.dedupe_key,n.id,jsonb_build_object('title',n.title,'detail',n.body,'entity_id',n.entity_id)
 from public.notifications n join public.notification_preferences pref on pref.workspace_id=n.workspace_id and pref.user_id=n.recipient_user_id
 where n.workspace_id=w and pref.email_enabled and pref.failure_alerts and n.created_at>=pref.created_at
  and (n.dedupe_key like 'automation-failure:%' or n.dedupe_key like 'assessment-blocked:%')
 on conflict(workspace_id,recipient_user_id,dedupe_key) do nothing;
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

create function public.claim_notification_delivery() returns jsonb language plpgsql security definer set search_path='' as $$
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
 if d.kind='review_digest' then
  counts:=app_private.review_notification_counts(d.workspace_id);
  if (counts->>'discoveries')::int+(counts->>'proposals')::int=0 then update public.notification_deliveries set status='canceled',error_code='REVIEW_INBOX_EMPTY',updated_at=now() where id=d.id;return null;end if;
  update public.notification_deliveries set payload=counts where id=d.id;
 end if;
 update public.notification_deliveries set status='sending',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',started_at=now(),updated_at=now() where id=d.id returning * into d;
 return to_jsonb(d)||jsonb_build_object('recipient',recipient,'language',p.language);
end $$;

create function public.finish_notification_delivery(delivery_id uuid,lease uuid,outcome text,result_code text default null,remote_message_id text default null)
returns void language plpgsql security definer set search_path='' as $$
declare d public.notification_deliveries;state text;
begin
 select * into d from public.notification_deliveries where id=delivery_id for update;
 if d.id is null or d.status<>'sending' or d.lease_token is distinct from lease or d.lease_until<=now() then raise exception 'STALE_LEASE';end if;
 if outcome not in ('sent','retry','failed','unknown') or length(coalesce(result_code,''))>100 or length(coalesce(remote_message_id,''))>300 then raise exception 'INVALID_INPUT';end if;
 state:=case when outcome='sent' then 'sent' when outcome='unknown' then 'delivery_unknown' when outcome='retry' and d.attempts<5 then 'retry_wait' else 'failed' end;
 update public.notification_deliveries set status=state,error_code=result_code,message_id=remote_message_id,
  sent_at=case when state='sent' then now() else null end,
  next_attempt_at=case when state='retry_wait' then now()+make_interval(secs=>least(3600,60*power(2,d.attempts-1))::integer) else 'infinity' end,
  lease_token=null,lease_until=null,updated_at=now() where id=d.id;
 if state in ('failed','delivery_unknown') then
  insert into public.notifications(workspace_id,recipient_user_id,title,body,dedupe_key)
  values(d.workspace_id,d.recipient_user_id,'Email delivery needs attention',coalesce(result_code,'SMTP_DELIVERY_FAILED'),'email-delivery:'||d.id) on conflict do nothing;
 end if;
end $$;
revoke all on function public.automation_notification_tick(boolean),public.claim_notification_delivery(),public.finish_notification_delivery(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.automation_notification_tick(boolean),public.claim_notification_delivery(),public.finish_notification_delivery(uuid,uuid,text,text,text) to service_role;

-- Restore must not start sending mail or revive historical notification deliveries.
create function app_private.pause_notification_restore() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state='committed' and old.state is distinct from new.state then
  update public.notification_preferences set email_enabled=false,revision=revision+1,updated_at=now() where workspace_id=new.workspace_id;
  update public.notification_deliveries set status='canceled',error_code='RESTORE_PAUSED',lease_token=null,lease_until=null,updated_at=now() where workspace_id=new.workspace_id and status in ('queued','retry_wait','sending');
 end if;return new;
end $$;
revoke all on function app_private.pause_notification_restore() from public,anon,authenticated,service_role;
create trigger pause_notification_restore after update of state on public.restore_sessions for each row execute function app_private.pause_notification_restore();
