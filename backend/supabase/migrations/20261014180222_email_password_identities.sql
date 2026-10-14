-- The owner's final choice is email/password with invitations only.
-- Creating an Auth identity never grants application membership.
alter table public.identity_allowlist drop constraint identity_allowlist_provider_check;
alter table public.identity_allowlist add constraint identity_allowlist_provider_check check(provider='email');
create or replace function public.bootstrap_workspace(owner_user_id uuid,workspace_name text) returns uuid
language plpgsql security definer set search_path='' as $$
declare w uuid;u auth.users;provider_identity text;identity_provider text;
begin
  perform pg_advisory_xact_lock(1476521);
  if exists(select 1 from public.workspaces) then raise exception 'BOOTSTRAP_CLOSED'; end if;
  select * into u from auth.users where id=owner_user_id and email_confirmed_at is not null;
  if u.id is null then raise exception 'VERIFIED_USER_REQUIRED'; end if;
  select provider,coalesce(identity_data->>'sub',u.id::text) into identity_provider,provider_identity from auth.identities where user_id=owner_user_id and provider='email' limit 1;
  if provider_identity is null then raise exception 'SUPPORTED_IDENTITY_REQUIRED'; end if;
  insert into public.workspaces(name,created_by) values(workspace_name,owner_user_id) returning id into w;
  insert into public.identity_allowlist(workspace_id,provider,provider_user_id,verified_email,user_id,role,created_by) values(w,identity_provider,provider_identity,u.email,owner_user_id,'Owner',owner_user_id);
  insert into public.memberships(workspace_id,user_id,role,created_by) values(w,owner_user_id,'Owner',owner_user_id);
  insert into public.operations(workspace_id) values(w);
  insert into public.audit_events(workspace_id,actor_id,action,request_id) values(w,owner_user_id,'workspace.bootstrapped',gen_random_uuid());
  return w;
end $$;
revoke all on function public.bootstrap_workspace(uuid,text) from public,anon,authenticated;
grant execute on function public.bootstrap_workspace(uuid,text) to service_role;
