-- The first Owner proves identity by setting a password on the pre-created
-- account. No separate invitation click is required.
create function app_private.claim_designated_owner() returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();u auth.users;s app_private.owner_setup;w uuid;
begin
  if actor is null then raise exception 'UNAUTHENTICATED';end if;
  perform pg_advisory_xact_lock(1476521);
  select * into u from auth.users where id=actor and email_confirmed_at is not null;
  if u.id is null then raise exception 'VERIFIED_USER_REQUIRED';end if;
  select * into s from app_private.owner_setup where singleton for update;
  if s.singleton is null or lower(u.email) is distinct from s.email then raise exception 'ACCESS_PENDING';end if;
  select m.workspace_id into w from public.memberships m
    where m.user_id=actor and m.role='Owner' and m.active
    and app_private.member_role(m.workspace_id)='Owner' limit 1;
  if w is not null then
    update app_private.owner_setup set accepted_by=actor,accepted_at=coalesce(accepted_at,now()) where singleton and accepted_by is null;
    return jsonb_build_object('workspace_id',w,'role','Owner');
  end if;
  if exists(select 1 from public.workspaces) then raise exception 'ACCESS_PENDING';end if;
  w:=public.bootstrap_workspace(actor,s.workspace_name);
  update app_private.owner_setup set accepted_by=actor,accepted_at=now() where singleton;
  return jsonb_build_object('workspace_id',w,'role','Owner');
end $$;
revoke all on function app_private.claim_designated_owner() from public,anon;
grant execute on function app_private.claim_designated_owner() to authenticated;
create function public.claim_designated_owner() returns jsonb
language sql security invoker set search_path='' as $$select app_private.claim_designated_owner()$$;
revoke all on function public.claim_designated_owner() from public,anon;
grant execute on function public.claim_designated_owner() to authenticated;
