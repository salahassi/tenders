-- The first Owner is designated through an administrative connection, never
-- by a public first-visitor claim. Only a token hash is stored.
create table app_private.owner_setup (
  singleton boolean primary key default true check(singleton),
  email text not null check(email=lower(trim(email)) and length(email) between 3 and 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  workspace_name text not null check(length(workspace_name) between 1 and 200),
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz
);
alter table app_private.owner_setup enable row level security;
revoke all on app_private.owner_setup from public,anon,authenticated;

create function app_private.prepare_owner_setup(owner_email text,setup_hash text,workspace_name text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(1476521);
  if exists(select 1 from public.workspaces) then raise exception 'BOOTSTRAP_CLOSED'; end if;
  insert into app_private.owner_setup(singleton,email,workspace_name,token_hash,expires_at)
  values(true,lower(trim(owner_email)),workspace_name,setup_hash,now()+interval '24 hours')
  on conflict(singleton) do update set email=excluded.email,workspace_name=excluded.workspace_name,token_hash=excluded.token_hash,expires_at=excluded.expires_at,created_at=now(),accepted_by=null,accepted_at=null;
  return jsonb_build_object('email',lower(trim(owner_email)),'role','Owner','expires_at',now()+interval '24 hours');
end $$;
revoke all on function app_private.prepare_owner_setup(text,text,text) from public,anon,authenticated;
grant execute on function app_private.prepare_owner_setup(text,text,text) to service_role;
create function public.prepare_owner_setup(owner_email text,setup_hash text,workspace_name text) returns jsonb
language sql security invoker set search_path='' as $$select app_private.prepare_owner_setup(owner_email,setup_hash,workspace_name)$$;
revoke all on function public.prepare_owner_setup(text,text,text) from public,anon,authenticated;
grant execute on function public.prepare_owner_setup(text,text,text) to service_role;

-- Used by the API after hashing the 256-bit invitation token. No public
-- database role can enumerate email addresses or read setup-token hashes.
create function app_private.inspect_invitation(invitation_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  select jsonb_build_object('email',s.email,'role','Owner','expires_at',s.expires_at) into result
  from app_private.owner_setup s where s.token_hash=invitation_hash and s.accepted_by is null and s.expires_at>now()
  and not exists(select 1 from public.workspaces);
  if result is not null then return result; end if;
  select jsonb_build_object('email',i.email,'role',i.role,'expires_at',i.expires_at) into result
  from public.workspace_invitations i where i.token_hash=invitation_hash and i.status='pending' and i.expires_at>now()
  and exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id
    where m.workspace_id=i.workspace_id and m.user_id=i.created_by and m.active and m.role='Owner' and a.status='active');
  if result is null then raise exception 'INVITATION_NOT_VALID'; end if;
  return result;
end $$;
revoke all on function app_private.inspect_invitation(text) from public,anon,authenticated;
grant execute on function app_private.inspect_invitation(text) to service_role;
create function public.inspect_invitation(invitation_hash text) returns jsonb
language sql security invoker set search_path='' as $$select app_private.inspect_invitation(invitation_hash)$$;
revoke all on function public.inspect_invitation(text) from public,anon,authenticated;
grant execute on function public.inspect_invitation(text) to service_role;

create function app_private.accept_invitation_or_setup(invitation_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();s app_private.owner_setup;u auth.users;w uuid;
begin
  if actor is null then raise exception 'UNAUTHENTICATED';end if;
  if invitation_token is null or invitation_token !~ '^[a-f0-9]{64}$' then raise exception 'INVITATION_NOT_VALID';end if;
  if not exists(select 1 from app_private.owner_setup where token_hash=encode(sha256(convert_to(invitation_token,'UTF8')),'hex')) then
    return app_private.accept_invitation(invitation_token);
  end if;
  perform pg_advisory_xact_lock(1476521);
  select * into s from app_private.owner_setup where token_hash=encode(sha256(convert_to(invitation_token,'UTF8')),'hex') for update;
  if s.singleton is null then raise exception 'INVITATION_NOT_VALID';end if;
  select * into u from auth.users where id=actor and email_confirmed_at is not null;
  if u.id is null then raise exception 'VERIFIED_USER_REQUIRED';end if;
  if lower(u.email) is distinct from s.email then raise exception 'INVITATION_EMAIL_MISMATCH';end if;
  if s.accepted_by=actor then
    select id into w from public.workspaces where created_by=actor and app_private.member_role(id)='Owner';
    if w is not null then return jsonb_build_object('workspace_id',w,'role','Owner');end if;
  end if;
  if s.accepted_by is not null or s.expires_at<=now() or exists(select 1 from public.workspaces) then raise exception 'INVITATION_NOT_VALID';end if;
  w:=public.bootstrap_workspace(actor,s.workspace_name);
  update app_private.owner_setup set accepted_by=actor,accepted_at=now() where singleton;
  return jsonb_build_object('workspace_id',w,'role','Owner');
end $$;
revoke all on function app_private.accept_invitation_or_setup(text) from public,anon;
grant execute on function app_private.accept_invitation_or_setup(text) to authenticated;
create or replace function public.accept_invitation(invitation_token text) returns jsonb
language sql security invoker set search_path='' as $$select app_private.accept_invitation_or_setup(invitation_token)$$;
revoke all on function public.accept_invitation(text) from public,anon;
grant execute on function public.accept_invitation(text) to authenticated;

-- Invitation administration events are visible only to an Owner.
alter policy audit_read on public.audit_events using(app_private.member_role(workspace_id) is not null and
  (action not like 'membership.%' and action not like 'invitation.%' or app_private.member_role(workspace_id)='Owner'));
