-- Transport framing only: retain the existing command/input limits and execute
-- every command atomically. Never construct or return a full batch JSONB array.
-- Endpoint-local idempotency data is not a portable workspace backup/approval.
create table app_private.command_batch_receipts (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 actor_id uuid not null,
 idempotency_key text not null check(length(idempotency_key) between 1 and 200),
 body_hash text not null check(body_hash~'^[a-f0-9]{64}$'),
 result_count integer not null check(result_count between 1 and 100),
 state text not null default 'building' check(state in ('building','ready','purged')),
 manifest jsonb,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default(now()+interval '24 hours'),
 unique(workspace_id,actor_id,idempotency_key),
 check(manifest is null or pg_column_size(manifest)<=65536)
);
create index command_batch_expiry on app_private.command_batch_receipts(workspace_id,expires_at);
create table app_private.command_batch_results (
 receipt_id uuid not null references app_private.command_batch_receipts(id) on delete cascade,
 ordinal integer not null check(ordinal between 0 and 99),
 byte_length integer not null check(byte_length>0),
 chunk_count integer not null check(chunk_count>0),
 sha256 text not null check(sha256~'^[a-f0-9]{64}$'),
 primary key(receipt_id,ordinal),
 check(chunk_count=(byte_length::bigint+262143)/262144)
);
create table app_private.command_batch_chunks (
 receipt_id uuid not null,
 result_ordinal integer not null,
 chunk_index integer not null check(chunk_index>=0),
 data bytea not null check(octet_length(data) between 1 and 262144),
 sha256 text not null check(sha256~'^[a-f0-9]{64}$'),
 primary key(receipt_id,result_ordinal,chunk_index),
 foreign key(receipt_id,result_ordinal) references app_private.command_batch_results(receipt_id,ordinal) on delete cascade
);

create function app_private.command_batch_access(receipt_id uuid)
returns app_private.command_batch_receipts language plpgsql security definer set search_path='' as $$
declare b app_private.command_batch_receipts;actor uuid:=auth.uid();
begin
 if actor is null then raise exception 'UNAUTHENTICATED';end if;
 select * into b from app_private.command_batch_receipts r where r.id=receipt_id and r.actor_id=actor;
 if b.id is null then raise exception 'BATCH_RESULT_NOT_FOUND';end if;
 -- Serialize each bounded read against canonical membership changes and purge.
 perform 1 from public.workspaces where id=b.workspace_id for share;
 if app_private.member_role(b.workspace_id) is null then raise exception 'ROLE_FORBIDDEN';end if;
 select * into b from app_private.command_batch_receipts r where r.id=receipt_id and r.actor_id=actor;
 if b.id is null then raise exception 'BATCH_RESULT_NOT_FOUND';end if;
 if b.expires_at<=clock_timestamp() then raise exception 'BATCH_RESULT_EXPIRED';end if;
 if b.state='purged' then raise exception 'BATCH_RESULT_PURGED';end if;
 if b.state<>'ready' or b.manifest is null then raise exception 'BATCH_RESULT_UNAVAILABLE';end if;
 return b;
end $$;

create function public.app_batch_prepare(commands jsonb,idempotency_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();w uuid;digest text;b app_private.command_batch_receipts;
 legacy_hash text;item jsonb;value jsonb;bytes bytea;part bytea;ordinal integer:=0;
count integer;index integer;length integer;parts integer;descriptors jsonb;response_manifest jsonb;
begin
 if actor is null then raise exception 'UNAUTHENTICATED';end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;
 if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;
 if app_private.member_role(w) is null then raise exception 'ACCESS_PENDING';end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 then raise exception 'IDEMPOTENCY_KEY_REQUIRED';end if;
 if commands is null or jsonb_typeof(commands)<>'array' or jsonb_array_length(commands) not between 1 and 100 or pg_column_size(commands)>1048576 then raise exception 'INVALID_INPUT';end if;
 digest:=encode(sha256(convert_to(commands::text,'UTF8')),'hex');
 select * into b from app_private.command_batch_receipts r where r.workspace_id=w and r.actor_id=actor and r.idempotency_key=app_batch_prepare.idempotency_key for update;
 if b.id is not null then
  if b.body_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  -- While a completed receipt still exists, an expired response is an explicit
  -- stale-result error, never an implicit repeat of business commands. The
  -- existing24h maintenance boundary removes this endpoint cache as before.
  b:=app_private.command_batch_access(b.id);
  return b.manifest;
 end if;
 -- Legacy saved aggregate is authoritative. Do not detoast it, infer it from
 -- child command receipts, rewrite/delete it, or repeat any committed command.
 -- A separately qualified normalization path must complete before deployment.
 select r.body_hash into legacy_hash from app_private.idempotency_records r
  where r.workspace_id=w and r.actor_id=actor and r.method='BATCH' and r.route='commands' and r.key=app_batch_prepare.idempotency_key;
 if found then
  if legacy_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  raise exception 'BATCH_LEGACY_NORMALIZATION_REQUIRED';
 end if;
 count:=jsonb_array_length(commands);
 insert into app_private.command_batch_receipts(workspace_id,actor_id,idempotency_key,body_hash,result_count)
 values(w,actor,idempotency_key,digest,count) returning * into b;
 for item in select element from jsonb_array_elements(commands) element loop
  perform app_private.check_keys(item,array['operation','input']);
  if not(item ? 'operation' and item ? 'input') then raise exception 'INVALID_INPUT';end if;
  value:=coalesce(public.app_command(item->>'operation',item->'input',encode(sha256(convert_to('batch:'||idempotency_key||':'||(ordinal+1)::text,'UTF8')),'hex')),'null'::jsonb);
  bytes:=convert_to(value::text,'UTF8');
  length:=octet_length(bytes);parts:=((length::bigint+262143)/262144)::integer;
  insert into app_private.command_batch_results(receipt_id,ordinal,byte_length,chunk_count,sha256)
   values(b.id,ordinal,length,parts,encode(sha256(bytes),'hex'));
  for index in 0..parts-1 loop
   part:=substring(bytes from index*262144+1 for 262144);
   insert into app_private.command_batch_chunks(receipt_id,result_ordinal,chunk_index,data,sha256)
    values(b.id,ordinal,index,part,encode(sha256(part),'hex'));
  end loop;
  -- Release each individual result before the next command. Only descriptors
  -- (at most the existing100 commands) are ever aggregated below.
  value:=null;bytes:=null;part:=null;ordinal:=ordinal+1;
 end loop;
 select jsonb_agg(jsonb_build_object('ordinal',r.ordinal,'byte_length',r.byte_length,'chunk_count',r.chunk_count,'sha256',r.sha256) order by r.ordinal)
  into descriptors from app_private.command_batch_results r where r.receipt_id=b.id;
 response_manifest:=jsonb_build_object('version',1,'chunk_bytes',262144,'receipt_id',b.id,'result_count',count,'results',descriptors);
 update app_private.command_batch_receipts r set state='ready',manifest=response_manifest where r.id=b.id and r.state='building';
 if not found then raise exception 'BATCH_RESULT_PURGED';end if;
 return response_manifest;
end $$;

create function public.app_batch_result_chunk(receipt_id uuid,result_ordinal integer,chunk_index integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b app_private.command_batch_receipts;r app_private.command_batch_results;c app_private.command_batch_chunks;expected integer;
begin
 b:=app_private.command_batch_access(receipt_id);
 if result_ordinal is null or result_ordinal<0 or result_ordinal>=b.result_count or chunk_index is null or chunk_index<0 then raise exception 'INVALID_INPUT';end if;
 select * into r from app_private.command_batch_results x where x.receipt_id=b.id and x.ordinal=app_batch_result_chunk.result_ordinal;
 if r.receipt_id is null then raise exception 'BATCH_RESULT_UNAVAILABLE';end if;
 if chunk_index>=r.chunk_count then raise exception 'INVALID_INPUT';end if;
 select * into c from app_private.command_batch_chunks x where x.receipt_id=b.id and x.result_ordinal=app_batch_result_chunk.result_ordinal and x.chunk_index=app_batch_result_chunk.chunk_index;
 expected:=least(262144,r.byte_length-chunk_index*262144);
 if c.receipt_id is null or octet_length(c.data)<>expected or encode(sha256(c.data),'hex')<>c.sha256 then raise exception 'BATCH_RESULT_UNAVAILABLE';end if;
 return jsonb_build_object('version',1,'receipt_id',b.id,'result_ordinal',result_ordinal,'chunk_index',chunk_index,
  'byte_length',octet_length(c.data),'sha256',c.sha256,'data_base64',replace(replace(encode(c.data,'base64'),E'\n',''),E'\r',''));
end $$;

-- The former scalar RPC must never remain an exposed OOM fallback. The release
-- must fence/drain old API command requests during this explicit transport
-- cutover. Preserve the exact existing function owners/ACLs by replacement.
create or replace function app_private.apply_batch(commands jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$begin raise exception 'TRANSPORT_UPGRADE_REQUIRED';end $$;
create or replace function public.app_batch(commands jsonb,idempotency_key text) returns jsonb
language sql security invoker set search_path='' as $$select app_private.apply_batch(commands,idempotency_key)$$;

-- A function replacement does not cancel an already-entered old PL/pgSQL body.
-- Under the release's early ACCESS EXCLUSIVE table lock, install an INSERT-only
-- backstop: a cached old invocation's final receipt write aborts its entire
-- transaction. Existing authoritative receipts, purge UPDATEs and retention
-- DELETEs are untouched. Admission fencing/drain is still a release prerequisite.
create function app_private.reject_legacy_batch_insert() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.method='BATCH' and new.route='commands' then raise exception 'TRANSPORT_UPGRADE_REQUIRED';end if;
 return new;
end $$;
create trigger reject_legacy_batch_insert before insert on app_private.idempotency_records
for each row when(new.method='BATCH' and new.route='commands') execute function app_private.reject_legacy_batch_insert();

-- Preserve the existing purge predicate: canonical UUID text occurring in a
-- result. Inspect at most one chunk plus35 bytes of its immediate successor,
-- never reconstruct a result/aggregate or invalidate unrelated receipts.
create function app_private.invalidate_command_batches_for_purge(w uuid,all_ids uuid[]) returns void
language plpgsql security definer set search_path='' as $$
begin
 with matching as materialized (
  select distinct c.receipt_id from app_private.command_batch_chunks c
  join app_private.command_batch_receipts b on b.id=c.receipt_id
  where b.workspace_id=w and b.state<>'purged' and exists(
   select 1 from unnest(all_ids) deleted where position(convert_to(deleted::text,'UTF8') in
    c.data||coalesce((select substring(n.data from 1 for 35) from app_private.command_batch_chunks n
     where n.receipt_id=c.receipt_id and n.result_ordinal=c.result_ordinal and n.chunk_index=c.chunk_index+1),''::bytea))>0)
 ), changed as (
  update app_private.command_batch_receipts b set state='purged' where b.id in(select receipt_id from matching) returning b.id
 ) delete from app_private.command_batch_results r where r.receipt_id in(select id from changed);
end $$;
do $$declare definition text;marker text;begin
 select pg_get_functiondef('public.purge_opportunity(uuid,text,text,text,boolean)'::regprocedure) into definition;
 marker:='select coalesce(array_agg(deleted.value::uuid),''{}'') into all_ids from jsonb_each(scope) item cross join lateral jsonb_array_elements_text(item.value->''ids'') deleted;';
 if position(marker in definition)=0 then raise exception 'BATCH_PURGE_BOUNDARY_CHANGED';end if;
 execute replace(definition,marker,marker||' perform app_private.invalidate_command_batches_for_purge(w,all_ids);');
end $$;

-- Match existing24h idempotency retention under the existing workspace lock.
do $$declare definition text;marker text;begin
 select pg_get_functiondef('public.maintenance_tick_before_issuance()'::regprocedure) into definition;
 marker:='delete from app_private.idempotency_records where workspace_id=w and expires_at<now();';
 if position(marker in definition)=0 then raise exception 'BATCH_RETENTION_BOUNDARY_CHANGED';end if;
 execute replace(definition,marker,marker||' delete from app_private.command_batch_receipts where workspace_id=w and expires_at<now();');
end $$;

do $$declare t text;r text;signature text;begin
 foreach t in array array['command_batch_receipts','command_batch_results','command_batch_chunks'] loop
  execute format('alter table app_private.%I enable row level security',t);
  execute format('revoke all on app_private.%I from public',t);
  foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on app_private.%I from %I',t,r);end if;
  end loop;
 end loop;
 foreach signature in array array['app_private.command_batch_access(uuid)','app_private.invalidate_command_batches_for_purge(uuid,uuid[])','app_private.reject_legacy_batch_insert()',
  'public.app_batch_prepare(jsonb,text)','public.app_batch_result_chunk(uuid,integer,integer)'] loop
  execute 'revoke all on function '||signature||' from public';
  foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',signature,r);end if;
  end loop;
 end loop;
 foreach r in array array['authenticated','tdp_app_authenticated'] loop
  if exists(select 1 from pg_roles where rolname=r) then
   execute format('grant execute on function public.app_batch_prepare(jsonb,text),public.app_batch_result_chunk(uuid,integer,integer) to %I',r);
  end if;
 end loop;
end $$;
