-- Apply as the application schema owner after the application schema is ready.
-- psql variable auth_role selects the prefixed Auth migration/runtime role.
-- Auth settings, enabled together:
--   GOTRUE_DISABLE_SIGNUP=false
--   GOTRUE_HOOK_BEFORE_USER_CREATED_ENABLED=true
--   GOTRUE_HOOK_BEFORE_USER_CREATED_URI=pg-functions://postgres/app_private/before_user_created
-- The URI host is Auth's conventional identifier; the configured database URL
-- still selects the target logical database. A missing/broken hook denies signup.
-- Sources checked against Auth v2.197.0 and the current Supabase Auth Hook docs:
--   internal/conf/configuration.go; internal/api/signup.go;
--   internal/hooks/v0hooks/v0hooks.go; internal/hooks/hookspgfunc/hookspgfunc.go.

create or replace function app_private.before_user_created(event jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare email_value text:=lower(btrim(event->'user'->>'email'));
begin
 -- user_metadata is deliberately ignored. No browser-supplied role, workspace
 -- or approval can authorize an account. Email is only an admission filter;
 -- verified email plus the actual invitation token still confer membership
 -- through the existing accept_invitation transaction.
 if email_value is not null and length(email_value) between 3 and 254
 and coalesce(event->'user'->>'phone','')=''
 and event->'user'->>'is_anonymous'='false'
 and event->'user'->'app_metadata'->>'provider'='email'
 and exists(
  select 1 from public.workspace_invitations i
  where i.email=email_value and i.status='pending' and i.expires_at>now()
  and exists(
   select 1 from public.memberships m
   join public.identity_allowlist a
    on a.workspace_id=m.workspace_id and a.user_id=m.user_id
   where m.workspace_id=i.workspace_id and m.user_id=i.created_by
    and m.active and m.role='Owner' and a.status='active'
  )
 ) then return '{}'::jsonb;end if;
 return jsonb_build_object('error',jsonb_build_object(
  'http_code',403,'message','A valid Owner-issued invitation is required.'
 ));
end $$;
revoke all on function app_private.before_user_created(jsonb) from public;
grant usage on schema app_private to :"auth_role";
grant execute on function app_private.before_user_created(jsonb) to :"auth_role";
