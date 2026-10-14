-- User-facing RPCs run as the caller. The internal transactional routine
-- retains its explicit auth.uid(), active-membership, identity and role checks.
alter function public.app_command(text,jsonb,text) set schema app_private;
create function public.app_command(operation text,input jsonb,idempotency_key text) returns jsonb
language sql security invoker set search_path='' as $$
  select app_private.app_command(operation,input,idempotency_key)
$$;
revoke all on function public.app_command(text,jsonb,text) from public,anon;
grant execute on function public.app_command(text,jsonb,text) to authenticated;
revoke all on function app_private.app_command(text,jsonb,text) from public,anon;
grant execute on function app_private.app_command(text,jsonb,text) to authenticated;
alter function public.current_membership() security invoker;

-- Some fresh hosted projects install this event-trigger helper in public.
-- Event-trigger execution does not need client RPC execution privileges.
do $$ begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public,anon,authenticated';
  end if;
end $$;
