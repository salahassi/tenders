-- Explicit extension schemas preserve the empty search_path of this admin-only function.
-- The hosted activation exposed pg_net installation relying on a default schema.
create or replace function public.configure_dispatcher(project_url text,collection_hosts text[] default '{}') returns void language plpgsql security definer set search_path='' as $$
declare secret text:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');secret_id uuid;
begin
 if project_url!~'^https://[a-z0-9]+\.supabase\.co$' or exists(select 1 from unnest(collection_hosts) h where h!~'^[a-z0-9.-]+\.[a-z]{2,}$') then raise exception 'INVALID_DISPATCH_CONFIGURATION';end if;
 execute 'create extension if not exists pg_cron with schema pg_catalog';
 execute 'create extension if not exists pg_net with schema extensions';
 execute 'create extension if not exists supabase_vault with schema vault';
 select id into secret_id from vault.decrypted_secrets where name='tenderdesk_worker';
 if secret_id is null then perform vault.create_secret(secret,'tenderdesk_worker');else perform vault.update_secret(secret_id,secret);end if;
 insert into app_private.dispatcher_settings(singleton,project_url,secret_hash,collection_hosts,enabled) values(true,project_url,encode(sha256(convert_to(secret,'UTF8')),'hex'),collection_hosts,true)
 on conflict(singleton) do update set project_url=excluded.project_url,secret_hash=excluded.secret_hash,collection_hosts=excluded.collection_hosts,enabled=true;
 perform cron.schedule('tenderdesk-dispatch','* * * * *','select app_private.dispatch_backend()');
 update public.operations set scheduler_enabled=true;
end $$;
revoke all on function public.configure_dispatcher(text,text[]) from public,anon,authenticated,service_role;

-- Evaluate the session identity once without changing recipient/member authorization.
alter policy recipient_read on public.notifications using(
 app_private.member_role(workspace_id) is not null and recipient_user_id=(select auth.uid())
);
