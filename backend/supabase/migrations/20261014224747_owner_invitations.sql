-- Invitations confer no access until a verified, matching identity accepts.
create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  email text not null check(email=lower(trim(email)) and length(email) between 3 and 254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  role text not null check(role in ('Owner','Editor','Reviewer')),
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check(status in ('pending','accepted','revoked','expired')),
  expires_at timestamptz not null default (now()+interval '7 days'),
  created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  accepted_by uuid references auth.users(id),accepted_at timestamptz,revision integer not null default 1
);
create unique index invitations_pending_email on public.workspace_invitations(workspace_id,email) where status='pending';
create index invitations_workspace on public.workspace_invitations(workspace_id,id);
alter table public.workspace_invitations enable row level security;
revoke all on public.workspace_invitations from anon,authenticated;
grant select on public.workspace_invitations to authenticated;
grant all on public.workspace_invitations to service_role;
create policy owner_read on public.workspace_invitations for select to authenticated using(app_private.member_role(workspace_id)='Owner');
create view public.workspace_members with (security_invoker=true) as
select distinct on(m.user_id) m.user_id as id,m.workspace_id,m.role,m.active,m.revision,a.verified_email as email
from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id and a.status=case when m.active then 'active' else 'inactive' end order by m.user_id,a.updated_at desc;
revoke all on public.workspace_members from anon;
grant select on public.workspace_members to authenticated,service_role;

create function app_private.invitation_command(operation text,input jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();w uuid;body_hash text;replay app_private.idempotency_records;result jsonb;target uuid;
begin
  select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id)='Owner' limit 1;
  if w is null then raise exception 'ROLE_FORBIDDEN'; end if;
  perform 1 from public.workspaces where id=w for update;
  if app_private.member_role(w) is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN'; end if;
  if idempotency_key is null or length(idempotency_key) not between 1 and 200 then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  body_hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
  select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key for update;
  if replay.key is not null and replay.expires_at>now() then
    if replay.body_hash is distinct from body_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return replay.result;
  end if;
  delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
  if operation='invitation.create' then
    perform app_private.check_keys(input,array['email','role','token_hash']);
    update public.workspace_invitations set status='expired',revision=revision+1,updated_at=now() where workspace_id=w and status='pending' and expires_at<=now();
    if (select count(*) from public.workspace_invitations where workspace_id=w and status='pending')>=100 then raise exception 'INVITATION_CAP_REACHED'; end if;
    if exists(select 1 from public.workspace_invitations where workspace_id=w and email=lower(trim(input->>'email')) and status='pending') then raise exception 'INVITATION_ALREADY_PENDING'; end if;
    if exists(select 1 from public.identity_allowlist where workspace_id=w and lower(verified_email)=lower(trim(input->>'email')) and status='active') then raise exception 'MEMBER_ALREADY_ACTIVE'; end if;
    insert into public.workspace_invitations(workspace_id,email,role,token_hash,created_by) values(w,lower(trim(input->>'email')),input->>'role',input->>'token_hash',actor) returning to_jsonb(workspace_invitations.*)-'token_hash' into result;
    target:=(result->>'id')::uuid;
  elsif operation='invitation.revoke' then
    perform app_private.check_keys(input,array['id','expected_revision']);target:=(input->>'id')::uuid;
    update public.workspace_invitations set status='revoked',revision=revision+1,updated_at=now() where workspace_id=w and id=target and status='pending' and revision=(input->>'expected_revision')::integer returning to_jsonb(workspace_invitations.*)-'token_hash' into result;
    if result is null then raise exception 'REVISION_CONFLICT'; end if;
  else raise exception 'COMMAND_NOT_IMPLEMENTED';end if;
  insert into public.audit_events(workspace_id,actor_id,action,entity_id,request_id) values(w,actor,operation,target,gen_random_uuid());
  insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,body_hash,result);
  return result;
end $$;
revoke all on function app_private.invitation_command(text,jsonb,text) from public,anon;
grant execute on function app_private.invitation_command(text,jsonb,text) to authenticated;
create function public.invitation_command(operation text,input jsonb,idempotency_key text) returns jsonb
language sql security invoker set search_path='' as $$select app_private.invitation_command(operation,input,idempotency_key)$$;
revoke all on function public.invitation_command(text,jsonb,text) from public,anon;
grant execute on function public.invitation_command(text,jsonb,text) to authenticated;

create function app_private.accept_invitation(invitation_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();u auth.users;inv public.workspace_invitations;provider_name text;provider_id text;w uuid;
begin
  if actor is null then raise exception 'UNAUTHENTICATED';end if;
  if invitation_token is null or invitation_token !~ '^[a-f0-9]{64}$' then raise exception 'INVITATION_NOT_VALID';end if;
  select * into u from auth.users where id=actor and email_confirmed_at is not null;
  if u.id is null then raise exception 'VERIFIED_USER_REQUIRED';end if;
  select workspace_id into w from public.workspace_invitations where token_hash=encode(sha256(convert_to(invitation_token,'UTF8')),'hex');
  if w is null then raise exception 'INVITATION_NOT_VALID';end if;
  perform 1 from public.workspaces where id=w for update;
  select * into inv from public.workspace_invitations where workspace_id=w and token_hash=encode(sha256(convert_to(invitation_token,'UTF8')),'hex') for update;
  if inv.email<>lower(u.email) then raise exception 'INVITATION_EMAIL_MISMATCH';end if;
  if inv.status='accepted' and inv.accepted_by=actor and app_private.member_role(w) is not null then return jsonb_build_object('workspace_id',w,'role',app_private.member_role(w));end if;
  if inv.status<>'pending' or inv.expires_at<=now() then raise exception 'INVITATION_NOT_VALID';end if;
  -- Revoking the inviting Owner also invalidates their outstanding invitations.
  if not exists(select 1 from public.memberships where workspace_id=w and user_id=inv.created_by and active and role='Owner') then raise exception 'INVITATION_NOT_VALID';end if;
  if exists(select 1 from public.memberships where user_id=actor and workspace_id<>w and active) then raise exception 'WORKSPACE_MISMATCH';end if;
  select provider,coalesce(identity_data->>'sub',actor::text) into provider_name,provider_id from auth.identities where user_id=actor and provider='email' limit 1;
  if provider_id is null then raise exception 'SUPPORTED_IDENTITY_REQUIRED';end if;
  if not exists(select 1 from public.memberships where workspace_id=w and user_id=actor and active)
    and (select count(*) from public.memberships where workspace_id=w and active)>=5 then raise exception 'USER_CAP_REACHED';end if;
  insert into public.memberships(workspace_id,user_id,role,created_by) values(w,actor,inv.role,inv.created_by)
    on conflict(workspace_id,user_id) do update set role=excluded.role,active=true,revision=memberships.revision+1,updated_at=now();
  update public.identity_allowlist set status='inactive',revision=revision+1,updated_at=now() where workspace_id=w and user_id=actor;
  insert into public.identity_allowlist(workspace_id,provider,provider_user_id,verified_email,user_id,role,created_by) values(w,provider_name,provider_id,u.email,actor,inv.role,inv.created_by)
    on conflict(workspace_id,provider,provider_user_id) do update set role=excluded.role,status='active',verified_email=excluded.verified_email,revision=identity_allowlist.revision+1,updated_at=now();
  update public.workspace_invitations set status='accepted',accepted_by=actor,accepted_at=now(),revision=revision+1,updated_at=now() where id=inv.id;
  insert into public.audit_events(workspace_id,actor_id,action,entity_id,request_id) values(w,actor,'membership.invitation_accepted',inv.id,gen_random_uuid());
  return jsonb_build_object('workspace_id',w,'role',inv.role);
end $$;
revoke all on function app_private.accept_invitation(text) from public,anon;
grant execute on function app_private.accept_invitation(text) to authenticated;
create function public.accept_invitation(invitation_token text) returns jsonb
language sql security invoker set search_path='' as $$select app_private.accept_invitation(invitation_token)$$;
revoke all on function public.accept_invitation(text) from public,anon;
grant execute on function public.accept_invitation(text) to authenticated;
