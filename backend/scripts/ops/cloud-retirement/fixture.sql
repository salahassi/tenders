-- Installed only after nonce/database-comment guards in the isolated drill.
-- Business rows, reservations, intents and cleanup allowances are created by
-- canonical application commands/RPCs. These helpers only bootstrap the actual
-- authenticated Owner and read back this fixture's private operational state.
BEGIN;
SET LOCAL ROLE __OWNER__;
DO $$BEGIN
 if current_database()<>__DATABASE_LITERAL__ or
  (select shobj_description(oid,'pg_database') from pg_database where datname=current_database())
   is distinct from __DATABASE_COMMENT_LITERAL__
 then raise exception 'RETIREMENT_FIXTURE_DATABASE_GUARD';end if;
END$$;
create table app_private.retirement_fixture_identity (
 singleton boolean primary key default true check(singleton),
 actor_id uuid not null,other_user_id uuid not null,workspace_id uuid not null
);
revoke all on app_private.retirement_fixture_identity from public;
create function app_private.check_retirement_fixture() returns void
language plpgsql security definer set search_path='' as $$begin
 if current_database()<>__DATABASE_LITERAL__ or
  (select shobj_description(oid,'pg_database') from pg_database where datname=current_database())
   is distinct from __DATABASE_COMMENT_LITERAL__
 then raise exception 'RETIREMENT_FIXTURE_DATABASE_GUARD';end if;
end$$;
revoke all on function app_private.check_retirement_fixture() from public;

create function public.retirement_fixture_users(source_user uuid,target_user uuid) returns jsonb
language plpgsql security definer set search_path='' as $$declare w uuid;begin
 perform app_private.check_retirement_fixture();
 if exists(select 1 from app_private.retirement_fixture_identity)
  or exists(select 1 from public.workspaces) or source_user is null or target_user is null or source_user=target_user
  or (select count(*) from auth.users)<>2
  or (select count(*) from auth.users where id in(source_user,target_user)
   and email like '%@example.invalid' and email_confirmed_at is not null)<>2
 then raise exception 'RETIREMENT_FIXTURE_IDENTITY_INVALID';end if;
 w:=public.bootstrap_workspace(source_user,'Isolated storage retirement qualification');
 insert into app_private.retirement_fixture_identity(actor_id,other_user_id,workspace_id)
 values(source_user,target_user,w);
 return jsonb_build_object('actor_id',source_user,'workspace_id',w);
end$$;
revoke all on function public.retirement_fixture_users(uuid,uuid) from public;
grant execute on function public.retirement_fixture_users(uuid,uuid) to __SERVICE__;

create function public.retirement_fixture_selection(storage_key text,expected_hash text,expected_size bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f app_private.retirement_fixture_identity;i public.storage_write_intents;c public.storage_cleanup_queue;begin
 perform app_private.check_retirement_fixture();
 select * into strict f from app_private.retirement_fixture_identity where singleton;
 if (select count(*) from public.workspaces)<>1 or
  not exists(select 1 from public.memberships where workspace_id=f.workspace_id and user_id=f.actor_id and active and role='Owner')
  or exists(select 1 from public.provider_usage) or expected_size is distinct from 16384::bigint
  or expected_hash is null or expected_hash!~'^[a-f0-9]{64}$'
 then raise exception 'RETIREMENT_FIXTURE_IDENTITY_INVALID';end if;
 select * into strict i from public.storage_write_intents x
  where x.workspace_id=f.workspace_id and x.storage_key=retirement_fixture_selection.storage_key;
 select * into strict c from public.storage_cleanup_queue x
  where x.workspace_id=f.workspace_id and x.storage_key=i.storage_key;
 if (select count(*) from public.storage_write_intents)<>1
  or (select count(*) from public.storage_cleanup_queue)<>1
  or i.state<>'unknown' or i.expected_hash is distinct from retirement_fixture_selection.expected_hash
  or i.expected_size is distinct from retirement_fixture_selection.expected_size
  or i.send_closed_at is not null or c.status<>'pending' or c.estimated_size<>10485760
  or c.reason<>'owner_confirmed_purge'
 then raise exception 'RETIREMENT_FIXTURE_CANONICAL_STATE_INVALID';end if;
 perform app_private.check_storage_retirement_reference(f.workspace_id,i.storage_key);
 return jsonb_build_object('actor_id',f.actor_id,'workspace_id',f.workspace_id,
  'selection',jsonb_build_array(jsonb_build_object('id',i.id,'storage_key',i.storage_key,
   'retirement_nonce',i.retirement_nonce,'revision',i.revision)),
  'expected_hash',i.expected_hash,'expected_size',i.expected_size);
end$$;
revoke all on function public.retirement_fixture_selection(text,text,bigint) from public;
grant execute on function public.retirement_fixture_selection(text,text,bigint) to __SERVICE__;

create function public.retirement_fixture_status(storage_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f app_private.retirement_fixture_identity;i public.storage_write_intents;c public.storage_cleanup_queue;begin
 perform app_private.check_retirement_fixture();
 select * into strict f from app_private.retirement_fixture_identity where singleton;
 select * into strict i from public.storage_write_intents x
  where x.workspace_id=f.workspace_id and x.storage_key=retirement_fixture_status.storage_key;
 select * into strict c from public.storage_cleanup_queue x
  where x.workspace_id=f.workspace_id and x.storage_key=i.storage_key;
 return jsonb_build_object('intent_state',i.state,'intent_revision',i.revision,
  'send_closed',i.send_closed_at is not null,'cleanup_status',c.status,'estimated_size',c.estimated_size,
  'fence_count',(select count(*) from app_private.storage_retirement_keys k
   where k.workspace_id=f.workspace_id and k.intent_id=i.id and k.storage_key=i.storage_key),
  'completed_batch_count',(select count(*) from app_private.storage_retirement_batches b
   join app_private.storage_retirement_keys k on k.operation_nonce=b.operation_nonce
   where k.intent_id=i.id and k.storage_key=i.storage_key and b.state='complete'),
  'completion_audit_count',(select count(*) from public.audit_events a
   join app_private.storage_retirement_keys k on k.operation_nonce=a.entity_id
   where a.workspace_id=f.workspace_id and a.action='storage.retirement.completed'
    and k.intent_id=i.id and k.storage_key=i.storage_key),
  'provider_usage_count',(select count(*) from public.provider_usage));
end$$;
revoke all on function public.retirement_fixture_status(text) from public;
grant execute on function public.retirement_fixture_status(text) to __SERVICE__;
NOTIFY pgrst,'reload schema';
COMMIT;
