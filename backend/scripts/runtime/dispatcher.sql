-- Apply as the application schema owner after the restored application schema.
-- psql variable service_role is the selected, prefixed service identity.
-- No worker credential is stored in this outbox or returned through its RPCs.
create table if not exists app_private.k8s_dispatch_queue (
 singleton boolean primary key default true check (singleton),
 generation bigint not null default 0 check (generation>=0),
 acknowledged_generation bigint not null default 0,
 lease_generation bigint,
 lease_token uuid,
 lease_until timestamptz,
 next_attempt_at timestamptz not null default '-infinity',
 last_periodic_at timestamptz not null default '-infinity',
 failures integer not null default 0 check (failures>=0),
 check (acknowledged_generation<=generation)
);
alter table app_private.k8s_dispatch_queue enable row level security;
revoke all on app_private.k8s_dispatch_queue from public;
insert into app_private.k8s_dispatch_queue(singleton) values(true)
on conflict(singleton) do nothing;

create or replace function app_private.dispatch_backend()
returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from app_private.dispatcher_settings where singleton and enabled)
 then return;end if;
 -- This write commits together with the existing guarded queue wake receipt.
 -- A process crash or a missed notification cannot discard pending dispatch.
 update app_private.k8s_dispatch_queue set generation=generation+1
 where singleton;
 perform pg_notify('tenderdesk_dispatch','wake');
end $$;
revoke all on function app_private.dispatch_backend() from public;

create or replace function public.configure_dispatcher(
 project_url text,collection_hosts text[] default '{}'
) returns void language plpgsql security definer set search_path='' as $$
begin
 if project_url!~'^https://[a-zA-Z0-9][a-zA-Z0-9.-]*(:[0-9]{1,5})?$'
 or exists(select 1 from unnest(collection_hosts) h where h!~'^[a-z0-9.-]+\.[a-z]{2,}$')
 then raise exception 'INVALID_DISPATCH_CONFIGURATION';end if;
 -- The deployer inserts the secret hash from the Kubernetes worker Secret.
 -- Configuration never generates a different credential or needs Vault/net.
 if not exists(select 1 from app_private.dispatcher_settings
  where singleton and secret_hash~'^[a-f0-9]{64}$')
 then raise exception 'DISPATCH_SECRET_MISSING';end if;
 update app_private.dispatcher_settings d set project_url=configure_dispatcher.project_url,
  collection_hosts=configure_dispatcher.collection_hosts,enabled=true where d.singleton;
 update public.operations set scheduler_enabled=true;
 perform app_private.dispatch_backend();
end $$;
revoke all on function public.configure_dispatcher(text,text[]) from public;

create or replace function public.k8s_claim_dispatch()
returns jsonb language plpgsql security definer set search_path='' as $$
declare q app_private.k8s_dispatch_queue;now_at timestamptz:=clock_timestamp();
begin
 if not exists(select 1 from app_private.dispatcher_settings where singleton and enabled)
 then return null;end if;
 select * into q from app_private.k8s_dispatch_queue where singleton for update;
 if not found then raise exception 'DISPATCH_OUTBOX_MISSING';end if;
 -- Recovery dispatch remains periodic even if no immediate event survived.
 if q.last_periodic_at<=now_at-interval '60 seconds' then
  update app_private.k8s_dispatch_queue set generation=generation+1,last_periodic_at=now_at
  where singleton returning * into q;
 end if;
 if q.generation<=q.acknowledged_generation or q.next_attempt_at>now_at
 or q.lease_until>now_at then return null;end if;
 update app_private.k8s_dispatch_queue set lease_generation=generation,
  lease_token=gen_random_uuid(),lease_until=now_at+interval '180 seconds'
 where singleton returning * into q;
 return jsonb_build_object('lease',q.lease_token,'generation',q.lease_generation);
end $$;
revoke all on function public.k8s_claim_dispatch() from public;
grant execute on function public.k8s_claim_dispatch() to :"service_role";

create or replace function public.k8s_finish_dispatch(
 dispatch_lease uuid,dispatch_generation bigint,succeeded boolean
) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if dispatch_lease is null or dispatch_generation is null or succeeded is null
 then return false;end if;
 update app_private.k8s_dispatch_queue q set
  acknowledged_generation=case when succeeded
   then greatest(q.acknowledged_generation,dispatch_generation)
   else q.acknowledged_generation end,
  failures=case when succeeded then 0 else least(q.failures+1,10) end,
  next_attempt_at=case when succeeded then '-infinity'::timestamptz
   else clock_timestamp()+make_interval(secs=>least(60,power(2,least(q.failures+1,6))::integer)) end,
  lease_token=null,lease_generation=null,lease_until=null
 where q.singleton and q.lease_token=dispatch_lease
  and q.lease_generation=dispatch_generation and q.lease_until>clock_timestamp();
 if not found then return false;end if;
 if succeeded then update app_private.dispatcher_settings
  set last_dispatch_at=clock_timestamp() where singleton;end if;
 return true;
end $$;
revoke all on function public.k8s_finish_dispatch(uuid,bigint,boolean) from public;
grant execute on function public.k8s_finish_dispatch(uuid,bigint,boolean) to :"service_role";
