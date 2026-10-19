alter table public.operations add column email_transport_ready boolean not null default false, add column email_transport_checked_at timestamptz;

-- User-owned preferences; SMTP credentials and arbitrary recipients never enter this schema.
create table public.notification_preferences (
 workspace_id uuid not null references public.workspaces(id),user_id uuid not null references auth.users(id),
 email_enabled boolean not null default false,failure_alerts boolean not null default true,
 review_reminders boolean not null default true,review_interval_hours integer not null default 24 check(review_interval_hours in (6,12,24,48,168)),
 language text not null default 'ar' check(language in ('ar','en')),
 next_review_at timestamptz not null default(now()+interval '24 hours'),
 revision integer not null default 1,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(workspace_id,user_id)
);
alter table public.notification_preferences enable row level security;
create policy own_preferences on public.notification_preferences for select to authenticated
 using(user_id=(select auth.uid()) and app_private.member_role(workspace_id) is not null);
grant select on public.notification_preferences to authenticated;
revoke all on public.notification_preferences from anon;

create table public.notification_deliveries (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),recipient_user_id uuid not null references auth.users(id),
 kind text not null check(kind in ('processing_failure','review_digest','test')),dedupe_key text not null,
 notification_id uuid references public.notifications(id) on delete set null,payload jsonb not null default '{}' check(pg_column_size(payload)<8192),
 status text not null default 'queued' check(status in ('queued','sending','retry_wait','sent','failed','delivery_unknown','canceled')),
 attempts integer not null default 0 check(attempts>=0),next_attempt_at timestamptz not null default now(),
 lease_token uuid,lease_until timestamptz,started_at timestamptz,sent_at timestamptz,message_id text,error_code text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,recipient_user_id,dedupe_key)
);
alter table public.notification_deliveries enable row level security;
create policy own_deliveries on public.notification_deliveries for select to authenticated
 using(recipient_user_id=(select auth.uid()) and app_private.member_role(workspace_id) is not null);
grant select on public.notification_deliveries to authenticated;
revoke all on public.notification_deliveries from anon;
create index notification_delivery_due on public.notification_deliveries(next_attempt_at) where status in ('queued','retry_wait');
create index notification_delivery_recipient on public.notification_deliveries(workspace_id,recipient_user_id,created_at desc);
create index notification_delivery_notification on public.notification_deliveries(notification_id);
create unique index one_pending_digest on public.notification_deliveries(workspace_id,recipient_user_id)
 where kind='review_digest' and status in ('queued','sending','retry_wait');

create function public.notification_settings() returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid:=auth.uid();prefs jsonb;
begin
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;
 if w is null then raise exception 'ACCESS_PENDING';end if;
 select to_jsonb(p) into prefs from public.notification_preferences p where workspace_id=w and user_id=actor;
 return jsonb_build_object('preferences',coalesce(prefs,jsonb_build_object('revision',0,'email_enabled',false,'failure_alerts',true,'review_reminders',true,'review_interval_hours',24,'language','ar')),
  'recipient',(select email from auth.users where id=actor and email_confirmed_at is not null),
  'deliveries',(select coalesce(jsonb_agg(x),'[]') from(select id,kind,status,attempts,error_code,created_at,sent_at,next_attempt_at from public.notification_deliveries where workspace_id=w and recipient_user_id=actor order by created_at desc,id desc limit 20)x));
end $$;
revoke all on function public.notification_settings() from public,anon;
grant execute on function public.notification_settings() to authenticated;
