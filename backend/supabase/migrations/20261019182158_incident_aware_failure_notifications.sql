-- Remember reported causes while they remain active, independently of task count.
alter table public.notification_preferences alter column failure_interval_hours set default 24;
create table app_private.notification_failure_state (
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 recipient_user_id uuid not null references auth.users(id) on delete cascade,
 attempted_keys text[] not null default '{}',
 updated_at timestamptz not null default now(),
 primary key(workspace_id,recipient_user_id)
);
alter table app_private.notification_failure_state enable row level security;
revoke all on app_private.notification_failure_state from public,anon,authenticated,service_role;

create function app_private.failure_incident_key(error_code text,job_type text) returns text
language sql immutable set search_path='' as $$
 select case when error_code in ('MODEL_ROUND_EXHAUSTED','PROVIDER_QUOTA_WAIT','MODEL_NETWORK_UNCERTAIN') then 'model_availability'
 else case when job_type like 'source_%' then 'collection:' else 'assessment:' end||error_code end
$$;
revoke all on function app_private.failure_incident_key(text,text) from public,anon,authenticated,service_role;

-- Opting in must not backfill notifications from before the preference existed.
create function app_private.eligible_failure_notifications(w uuid,u uuid)
returns table(notification_id uuid,error_code text,job_type text,job_status text,attempts integer)
language sql stable security definer set search_path='' as $$
 select f.* from app_private.current_failure_notifications(w,u) f
 join public.notifications n on n.id=f.notification_id
 join public.notification_preferences p on p.workspace_id=w and p.user_id=u
 where n.created_at>=p.created_at
$$;
revoke all on function app_private.eligible_failure_notifications(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function app_private.failure_summary_payload(d public.notification_deliveries) returns jsonb
language sql stable security definer set search_path='' as $$
 with current_issues as (
  select * from app_private.eligible_failure_notifications(d.workspace_id,d.recipient_user_id)
 ), grouped as (
  select error_code,job_type,count(*) as count,max(attempts) as max_attempts,
   bool_and(job_status in ('queued','running','retry_wait','quota_wait')) as retrying
  from current_issues group by error_code,job_type order by count(*) desc,error_code,job_type limit 25
 )
 select jsonb_build_object('total',(select count(*) from current_issues),
  'incident_keys',coalesce((select jsonb_agg(k order by k) from (select distinct app_private.failure_incident_key(error_code,job_type) as k from current_issues) keys),'[]'::jsonb),
  'groups',coalesce((select jsonb_agg(to_jsonb(g)) from grouped g),'[]'::jsonb))
$$;

create function app_private.reported_failure_keys(w uuid,u uuid) returns text[]
language sql stable security definer set search_path='' as $$
 select array(select distinct app_private.failure_incident_key(f.error_code,f.job_type)
 from app_private.eligible_failure_notifications(w,u) f
 where exists(select 1 from public.notification_deliveries d where d.workspace_id=w and d.recipient_user_id=u and d.kind='processing_failure'
  and d.status in ('sent','sending','delivery_unknown') and (d.notification_id=f.notification_id or exists(select 1 from app_private.notification_failure_items i where i.notification_id=f.notification_id and i.delivery_id=d.id))) order by 1)
$$;
revoke all on function app_private.reported_failure_keys(uuid,uuid) from public,anon,authenticated,service_role;
-- Carry forward previously sent or ambiguous alerts; upgrading must not replay them.
insert into app_private.notification_failure_state(workspace_id,recipient_user_id,attempted_keys)
select p.workspace_id,p.user_id,app_private.reported_failure_keys(p.workspace_id,p.user_id) from public.notification_preferences p;

