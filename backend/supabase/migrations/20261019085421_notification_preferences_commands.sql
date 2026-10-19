alter function public.app_command(text,jsonb,text) rename to app_command_before_notifications;
revoke all on function public.app_command_before_notifications(text,jsonb,text) from public,anon,authenticated,service_role;
create function public.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
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
  perform app_private.check_keys(input,array['expected_revision','email_enabled','failure_alerts','review_reminders','review_interval_hours','language']);
  if coalesce(input->>'email_enabled','') not in ('true','false') or coalesce(input->>'failure_alerts','') not in ('true','false') or coalesce(input->>'review_reminders','') not in ('true','false')
   or coalesce(input->>'language','') not in ('ar','en') or coalesce((input->>'review_interval_hours')::int,0) not in (6,12,24,48,168) then raise exception 'INVALID_INPUT';end if;
  if coalesce(prefs.revision,0) is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  insert into public.notification_preferences(workspace_id,user_id,email_enabled,failure_alerts,review_reminders,review_interval_hours,language,next_review_at)
  values(w,actor,(input->>'email_enabled')::boolean,(input->>'failure_alerts')::boolean,(input->>'review_reminders')::boolean,(input->>'review_interval_hours')::int,input->>'language',now()+make_interval(hours=>(input->>'review_interval_hours')::int))
  on conflict(workspace_id,user_id) do update set email_enabled=excluded.email_enabled,failure_alerts=excluded.failure_alerts,review_reminders=excluded.review_reminders,
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
