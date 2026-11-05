-- Storage API cancellation is not remote write settlement. This metadata is
-- local operational state, like storage_cleanup_queue, not a portable backup
-- artifact. Restore creates new private keys with unproven write provenance;
-- neither send authorization nor a source-host retirement proof is restored.
create table public.storage_write_intents(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
 storage_key text not null unique,state text not null check(state in ('unstarted','unknown','observed','legacy_unfenced','quiesced')),
 expected_hash text check(expected_hash~'^[a-f0-9]{64}$'),expected_size bigint check(expected_size between 1 and 10485760),
 started_at timestamptz,observed_at timestamptz,send_closed_at timestamptz,retirement_nonce uuid not null default gen_random_uuid(),
 retirement_receipt jsonb,created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp(),
 revision integer not null default 1 check(revision>0),unique(workspace_id,id),
 check(state not in ('unknown','observed') or (expected_hash is not null and expected_size is not null)),
 check(state<>'quiesced' or retirement_receipt is not null)
);
alter table public.storage_write_intents enable row level security;
revoke all on public.storage_write_intents from public;
create index storage_write_intents_unresolved on public.storage_write_intents(workspace_id,state) where state in ('unknown','legacy_unfenced');

-- Existing keys may have had several overlapping PUTs before this policy.
-- A later positive read does not settle all those historical requests.
insert into public.storage_write_intents(workspace_id,storage_key,state)
 select workspace_id,storage_key,'legacy_unfenced' from public.proposal_delivery_artifacts
 union select workspace_id,storage_key,'legacy_unfenced' from public.export_package_volumes
 union select workspace_id,storage_key,'legacy_unfenced' from public.storage_cleanup_queue
 on conflict(storage_key) do nothing;

create function app_private.register_storage_write_intent() returns trigger
language plpgsql security definer set search_path='' as $$declare initial_state text;begin
 if tg_op='UPDATE' and new.storage_key=old.storage_key then return new;end if;
 initial_state:=case when tg_table_name='storage_cleanup_queue' or exists(select 1 from public.restore_sessions where workspace_id=new.workspace_id and state='committing') then 'legacy_unfenced' else 'unstarted' end;
 insert into public.storage_write_intents(workspace_id,storage_key,state) values(new.workspace_id,new.storage_key,initial_state) on conflict(storage_key) do nothing;
 if not exists(select 1 from public.storage_write_intents i where i.storage_key=new.storage_key and i.workspace_id=new.workspace_id) then raise exception 'STORAGE_WRITE_WORKSPACE_MISMATCH';end if;
 return new;
end$$;
create trigger register_delivery_storage_write after insert or update of storage_key on public.proposal_delivery_artifacts for each row execute function app_private.register_storage_write_intent();
create trigger register_export_storage_write after insert or update of storage_key on public.export_package_volumes for each row execute function app_private.register_storage_write_intent();
-- No untracked browser upload, OCR copy, restore upload or old cleanup key is
-- silently treated as settled. They require a real quiescence reconciliation.
create trigger register_cleanup_storage_write after insert on public.storage_cleanup_queue for each row execute function app_private.register_storage_write_intent();

-- A long transaction's now() must not extend a lease after a workspace wait.
-- The canonical guard is shared by send, artifact completion and final commit.
do $$declare definition text;marker text:='j:=app_private.delivery_job_before_generated_current(job_id,lease,check_sources);';begin
 select pg_get_functiondef('app_private.delivery_job(uuid,uuid,boolean)'::regprocedure) into definition;
 if position(marker in definition)=0 then raise exception 'STORAGE_WRITE_DELIVERY_GUARD_CHANGED';end if;
 execute replace(definition,marker,marker||' if lease is null or j.lease_token is null or j.lease_until is null or j.lease_until<=clock_timestamp() then raise exception ''STALE_LEASE'';end if;');
end$$;

create function public.begin_render_storage_write(job_id uuid,lease uuid,storage_key text,expected_hash text,expected_size bigint) returns jsonb
language plpgsql security definer set search_path='' as $$declare j public.jobs;i public.storage_write_intents;key text:=storage_key;digest text:=expected_hash;size bigint:=expected_size;begin
 select * into j from public.jobs where id=job_id;
 if j.type='render_delivery' then
  j:=app_private.delivery_job(job_id,lease);
  if not exists(select 1 from public.proposal_delivery_artifacts a where a.workspace_id=j.workspace_id and a.job_id=j.id and a.storage_key=key and a.status='pending' and a.reserved_bytes=10485760) then raise exception 'DELIVERY_STORAGE_NOT_RESERVED';end if;
 elsif j.type='render_export' then
  j:=app_private.export_package_job(job_id,lease);
  if not exists(select 1 from public.export_package_volumes s where s.workspace_id=j.workspace_id and s.package_id=j.entity_id and s.storage_key=key and s.artifact_id is null and s.reserved_bytes=10485760) then raise exception 'EXPORT_PACKAGE_INVALID';end if;
 else raise exception 'NOT_FOUND';end if;
 if digest is null or digest!~'^[a-f0-9]{64}$' or size is null or size not between 1 and 10485760 then raise exception 'INVALID_INPUT';end if;
 select * into i from public.storage_write_intents where storage_write_intents.storage_key=key and workspace_id=j.workspace_id for update;
 if i.id is null then raise exception 'STORAGE_WRITE_PROVENANCE_REQUIRED';end if;
 if i.state<>'unstarted' or i.send_closed_at is not null then return jsonb_build_object('send',false,'state',i.state,'intent_id',i.id);end if;
 update public.storage_write_intents set state='unknown',expected_hash=digest,expected_size=size,started_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() where id=i.id;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(j.workspace_id,j.created_by,'storage.write.authorized','storage_write_intent',i.id,jsonb_build_object('job_id',j.id,'hash',digest,'size',size));
 -- This permission is deliberately not replayed, even after a lost RPC reply.
 return jsonb_build_object('send',true,'state','unknown','intent_id',i.id);
end$$;

create function app_private.observe_render_storage_write(key text,digest text,size bigint) returns void
language plpgsql security definer set search_path='' as $$declare i public.storage_write_intents;begin
 select * into i from public.storage_write_intents where storage_key=key for update;
 if i.id is null then raise exception 'STORAGE_WRITE_PROVENANCE_REQUIRED';end if;
 if i.state in ('unknown','observed') then
  if (i.expected_hash,i.expected_size) is distinct from (digest,size) then raise exception 'ARTIFACT_MISMATCH';end if;
  if i.state='unknown' then update public.storage_write_intents set state='observed',observed_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() where id=i.id;end if;
 elsif i.state='unstarted' then
  -- A positive object without our one-time authorization may be historical or
  -- an external write. It can still pass content validation, but not settlement.
  update public.storage_write_intents set state='legacy_unfenced',revision=revision+1,updated_at=clock_timestamp() where id=i.id;
 end if;
end$$;

-- Preserve current authority/deadline/source/capacity wrappers. Add only the
-- upload state to private context, and bind observed bytes to exact receipts.
alter function public.delivery_export_context(uuid,uuid) rename to delivery_export_context_before_storage_intents;
create function public.delivery_export_context(job_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare c jsonb;begin
 c:=public.delivery_export_context_before_storage_intents(job_id,lease);
 return jsonb_set(c,'{artifacts}',(select coalesce(jsonb_agg(a||jsonb_build_object('write_state',coalesce(i.state,'legacy_unfenced')) order by a->>'volume'),'[]') from jsonb_array_elements(c->'artifacts') a left join public.storage_write_intents i on i.storage_key=a->>'storage_key'));
end$$;
alter function public.export_render_context(uuid,uuid) rename to export_render_context_before_storage_intents;
create function public.export_render_context(job_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare c jsonb;begin
 c:=public.export_render_context_before_storage_intents(job_id,lease);
 return jsonb_set(c,'{volumes}',(select coalesce(jsonb_agg(a||jsonb_build_object('write_state',coalesce(i.state,'legacy_unfenced')) order by a->>'volume'),'[]') from jsonb_array_elements(c->'volumes') a left join public.storage_write_intents i on i.storage_key=a->>'storage_key'));
end$$;
alter function public.complete_delivery_artifact(uuid,uuid,uuid,text,bigint) rename to complete_delivery_artifact_before_storage_intents;
create function public.complete_delivery_artifact(job_id uuid,lease uuid,artifact_id uuid,actual_hash text,actual_size bigint) returns jsonb language plpgsql security definer set search_path='' as $$declare r jsonb;begin
 r:=public.complete_delivery_artifact_before_storage_intents(job_id,lease,artifact_id,actual_hash,actual_size);
 perform app_private.observe_render_storage_write(r->>'storage_key',actual_hash,actual_size);return r;
end$$;
alter function public.complete_export_package_volume(uuid,uuid,uuid,text,bigint) rename to complete_export_package_volume_before_storage_intents;
create function public.complete_export_package_volume(job_id uuid,lease uuid,slot_id uuid,actual_hash text,actual_size bigint) returns jsonb language plpgsql security definer set search_path='' as $$declare r jsonb;begin
 r:=public.complete_export_package_volume_before_storage_intents(job_id,lease,slot_id,actual_hash,actual_size);
 perform app_private.observe_render_storage_write(r->>'storage_key',actual_hash,actual_size);return r;
end$$;
-- Renamed PL/pgSQL functions may use their implicit block label for parameters.
do $$declare name text;definition text;begin
 foreach name in array array['delivery_export_context','export_render_context','complete_delivery_artifact','complete_export_package_volume'] loop
  select pg_get_functiondef(p.oid) into definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=name||'_before_storage_intents';
  execute replace(definition,name||'.',name||'_before_storage_intents.');
 end loop;
end$$;

alter table public.storage_cleanup_queue add column delete_receipt jsonb check(delete_receipt is null or pg_column_size(delete_receipt)<=2048);
create function public.storage_cleanup_context(cleanup_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare c public.storage_cleanup_queue;i public.storage_write_intents;begin
 select * into c from public.storage_cleanup_queue where id=cleanup_id;
 perform 1 from public.workspaces where id=c.workspace_id for update;
 select * into c from public.storage_cleanup_queue where id=cleanup_id for update;
 if c.id is null or lease is null or c.status<>'running' or c.lease_token is null or c.lease_token is distinct from lease or c.lease_until is null or c.lease_until<=clock_timestamp() then raise exception 'STALE_LEASE';end if;
 select * into i from public.storage_write_intents where storage_key=c.storage_key and workspace_id=c.workspace_id for update;
 if i.id is null then raise exception 'STORAGE_WRITE_PROVENANCE_REQUIRED';end if;
 if exists(select 1 from public.documents where workspace_id=c.workspace_id and storage_key=c.storage_key and status<>'expired')
  or exists(select 1 from public.proposal_delivery_artifacts where workspace_id=c.workspace_id and storage_key=c.storage_key and status<>'expired')
  or exists(select 1 from public.export_artifacts where workspace_id=c.workspace_id and storage_key=c.storage_key and status<>'expired')
  or exists(select 1 from public.export_package_volumes where workspace_id=c.workspace_id and storage_key=c.storage_key and reserved_bytes>0)
  or exists(select 1 from public.restore_files f join public.restore_sessions r on r.id=f.session_id where f.workspace_id=c.workspace_id and f.storage_key=c.storage_key and r.state in ('staging','committing')) then raise exception 'ACTIVE_REFERENCE_FOUND';end if;
 if i.state='unstarted' and i.send_closed_at is null then
  update public.storage_write_intents set send_closed_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() where id=i.id returning * into i;
 end if;
 return jsonb_build_object('storage_key',c.storage_key,'write_state',i.state,'expected_hash',i.expected_hash,'expected_size',i.expected_size,
  'can_delete',i.state in ('unstarted','observed','quiesced'),'delete_required',i.state='observed');
end$$;
create function public.observe_cleanup_storage_write(cleanup_id uuid,lease uuid,actual_hash text,actual_size bigint) returns jsonb language plpgsql security definer set search_path='' as $$declare c jsonb;begin
 c:=public.storage_cleanup_context(cleanup_id,lease);
 if c->>'write_state'<>'unknown' then raise exception 'STORAGE_WRITE_RECONCILIATION_REQUIRED';end if;
 perform app_private.observe_render_storage_write(c->>'storage_key',actual_hash,actual_size);
 return public.storage_cleanup_context(cleanup_id,lease);
end$$;
create function public.defer_storage_cleanup(cleanup_id uuid,lease uuid) returns void language plpgsql security definer set search_path='' as $$declare c jsonb;begin
 c:=public.storage_cleanup_context(cleanup_id,lease);
 if c->>'write_state' not in ('unknown','legacy_unfenced','observed') then raise exception 'STORAGE_WRITE_RECONCILIATION_REQUIRED';end if;
 update public.storage_cleanup_queue set status=case when c->>'write_state' in ('legacy_unfenced','observed') then 'blocked' else 'pending' end,
  error_code=case when c->>'write_state'='legacy_unfenced' then 'STORAGE_QUIESCENCE_REQUIRED' when c->>'write_state'='observed' then 'STORAGE_DELETE_SETTLEMENT_REQUIRED' else 'STORAGE_UPLOAD_OUTCOME_UNKNOWN' end,
  eligible_at=clock_timestamp()+interval '1 minute',attempts=case when c->>'write_state'='observed' then attempts else greatest(attempts-1,0) end,lease_token=null,lease_until=null,updated_at=clock_timestamp() where id=cleanup_id;
end$$;
create function public.record_storage_cleanup_deletion(cleanup_id uuid,lease uuid,storage_key text,object_id uuid,object_version text) returns void language plpgsql security definer set search_path='' as $$declare c jsonb;key text:=storage_key;begin
 c:=public.storage_cleanup_context(cleanup_id,lease);
 if c->>'write_state'<>'observed' or c->>'storage_key' is distinct from key or object_id is null or object_version is null or length(object_version) not between 1 and 200 then raise exception 'STORAGE_DELETE_RECEIPT_REQUIRED';end if;
 update public.storage_cleanup_queue set delete_receipt=jsonb_build_object('version',1,'lease',lease,'object_id',object_id,'object_version',object_version,'key_hash',encode(sha256(convert_to(key,'UTF8')),'hex'),'recorded_at',clock_timestamp()) where id=cleanup_id;
end$$;
alter function public.complete_storage_cleanup(uuid,uuid,boolean) rename to complete_storage_cleanup_before_storage_intents;
create function public.complete_storage_cleanup(cleanup_id uuid,lease uuid,succeeded boolean) returns void language plpgsql security definer set search_path='' as $$declare c jsonb;begin
 c:=public.storage_cleanup_context(cleanup_id,lease);
 if succeeded is true and (c->>'can_delete')::boolean is distinct from true then raise exception 'STORAGE_WRITE_RECONCILIATION_REQUIRED';end if;
 if succeeded is true and c->>'write_state'='observed' and not exists(select 1 from public.storage_cleanup_queue q where q.id=cleanup_id and q.delete_receipt->>'lease'=lease::text) then raise exception 'STORAGE_DELETE_RECEIPT_REQUIRED';end if;
 perform public.complete_storage_cleanup_before_storage_intents(cleanup_id,lease,succeeded);
end$$;

-- Explicit snapshot retry rotates only uncertain pending keys, keeping old bytes
-- fully accounted in cleanup. Ready siblings and immutable history are retained.
alter function app_private.app_command(text,jsonb,text) rename to app_command_before_storage_intents;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$declare a public.proposal_delivery_artifacts;w uuid;actor uuid:=auth.uid();begin
 if operation='delivery.snapshot.retry' then
  select workspace_id into w from public.proposal_delivery_snapshots where id=(input->>'snapshot_id')::uuid;
  perform app_private.delivery_actor(w,actor,true);
  perform 1 from public.workspaces where id=w for update;
  perform app_private.delivery_actor(w,actor,true);
  -- Delegate every live replay before rotating anything. Its canonical checks
  -- still enforce source/actor currentness and body identity before returning.
  if exists(select 1 from app_private.idempotency_records r where r.workspace_id=w and r.actor_id=actor and r.method='COMMAND' and r.route=operation and r.key=idempotency_key and r.expires_at>now()) then
   return app_private.app_command_before_storage_intents(operation,input,idempotency_key);
  end if;
  for a in select art.* from public.proposal_delivery_artifacts art join public.jobs j on j.id=art.job_id join public.storage_write_intents i on i.storage_key=art.storage_key
   where art.workspace_id=w and art.snapshot_id=(input->>'snapshot_id')::uuid and art.status='pending' and art.reserved_bytes>0 and i.state in ('unknown','legacy_unfenced') and j.status in ('blocked','failed','canceled') and j.lease_token is null for update of art loop
   insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values(w,a.storage_key,a.reserved_bytes,'uncertain_delivery_retry') on conflict(storage_key) do nothing;
   update public.proposal_delivery_artifacts set status='expired',reserved_bytes=0,revision=revision+1,updated_at=clock_timestamp() where id=a.id;
  end loop;
 end if;
 return app_private.app_command_before_storage_intents(operation,input,idempotency_key);
end$$;

-- A missing legacy ready object does not settle other historical writes to
-- that key. Preserve its existing allowance in cleanup, without inventing bytes.
alter function public.report_export_package_artifact_failure(uuid,uuid,uuid,integer,text,text,text,bigint) rename to report_export_package_artifact_failure_before_storage_intents;
create function public.report_export_package_artifact_failure(artifact_id uuid,actor_id uuid,package_id uuid,expected_revision integer,expected_hash text,expected_storage_key text,error_code text,actual_size bigint default null) returns jsonb
language plpgsql security definer set search_path='' as $$declare a public.export_artifacts;r jsonb;begin
 select * into a from public.export_artifacts where id=artifact_id;
 perform 1 from public.workspaces where id=a.workspace_id for update;
 select * into a from public.export_artifacts where id=artifact_id;
 r:=public.report_export_package_artifact_failure_before_storage_intents(artifact_id,actor_id,package_id,expected_revision,expected_hash,expected_storage_key,error_code,actual_size);
 if r->'invalidated'='true'::jsonb and error_code='EXPORT_ARTIFACT_MISSING' and not exists(select 1 from public.storage_write_intents i where i.storage_key=a.storage_key and i.workspace_id=a.workspace_id and i.state in ('unstarted','observed','quiesced')) then
  insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values(a.workspace_id,a.storage_key,a.expected_size,'missing_export_unsettled_write') on conflict(storage_key) do nothing;
 end if;return r;
end$$;

-- Counts expose why quota is retained without exposing private object keys.
-- Already-done historical cleanup is a census, not inferred physical usage.
alter function public.workspace_status() rename to workspace_status_before_storage_intents;
create function public.workspace_status() returns jsonb language plpgsql security definer set search_path='' as $$declare r jsonb;w uuid;held bigint;begin
 r:=public.workspace_status_before_storage_intents();
 select m.workspace_id into w from public.memberships m where m.user_id=auth.uid() and app_private.member_role(m.workspace_id) is not null limit 1;
 select coalesce(sum(bytes),0) into held from(
  select c.estimated_size bytes from public.storage_cleanup_queue c join public.storage_write_intents i using(storage_key) where c.workspace_id=w and c.status<>'done' and (i.state in ('unknown','legacy_unfenced') or (i.state='observed' and c.error_code in ('STORAGE_DELETE_FAILED','STORAGE_DELETE_SETTLEMENT_REQUIRED','CLEANUP_LEASE_EXPIRED')))
  union all select a.reserved_bytes from public.proposal_delivery_artifacts a join public.storage_write_intents i using(storage_key) where a.workspace_id=w and a.status<>'expired' and i.state in ('unknown','legacy_unfenced')
  union all select s.reserved_bytes from public.export_package_volumes s join public.storage_write_intents i using(storage_key) where s.workspace_id=w and i.state in ('unknown','legacy_unfenced')
 ) holds;
 return r||jsonb_build_object('storage_write_uncertainty',jsonb_build_object(
  'unsettled_keys',(select count(*) from public.storage_write_intents where workspace_id=w and state='unknown'),
  'held_bytes',held,
  'quiescence_required_keys',(select count(*) from public.storage_write_intents i where i.workspace_id=w and (i.state='legacy_unfenced' and not exists(select 1 from public.storage_cleanup_queue c where c.storage_key=i.storage_key and c.status='done') or (i.state='observed' and exists(select 1 from public.storage_cleanup_queue c where c.storage_key=i.storage_key and c.status<>'done' and c.error_code='STORAGE_DELETE_SETTLEMENT_REQUIRED')))),
  'historical_inventory_keys',(select count(*) from public.storage_write_intents i join public.storage_cleanup_queue c using(storage_key) where i.workspace_id=w and i.state='legacy_unfenced' and c.status='done')));
end$$;

-- No browser access to private paths or operational settlement. Actual observed
-- receipts use service RPCs; quiescence retirement is a separate reviewed tool.
do $workspace_status_permissions$declare role_name text;signature text;old_service_acl aclitem[];old_owner oid;grant_row record;begin
 -- Preserve only service EXECUTE grants explicitly held by the predecessor.
 -- Snapshot before revoking its direct access; the predecessor stays private.
 select proacl,proowner into old_service_acl,old_owner from pg_proc where oid='public.workspace_status_before_storage_intents()'::regprocedure;
 if exists(select 1 from aclexplode(coalesce(old_service_acl,acldefault('f',old_owner))) a
  join pg_roles r on r.oid=a.grantee where r.rolname in ('service_role','tdp_app_service') and a.grantor<>old_owner)
 then raise exception 'LEGACY_CONTEXT_SERVICE_GRANTOR_UNSUPPORTED';end if;

 foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute format('revoke all on public.storage_write_intents from %I',role_name);end if;
 end loop;
 foreach signature in array array[
  'app_private.register_storage_write_intent()','app_private.observe_render_storage_write(text,text,bigint)',
  'app_private.app_command_before_storage_intents(text,jsonb,text)','app_private.app_command(text,jsonb,text)',
  'public.delivery_export_context_before_storage_intents(uuid,uuid)','public.export_render_context_before_storage_intents(uuid,uuid)',
  'public.complete_delivery_artifact_before_storage_intents(uuid,uuid,uuid,text,bigint)','public.complete_export_package_volume_before_storage_intents(uuid,uuid,uuid,text,bigint)',
  'public.complete_storage_cleanup_before_storage_intents(uuid,uuid,boolean)',
  'public.report_export_package_artifact_failure_before_storage_intents(uuid,uuid,uuid,integer,text,text,text,bigint)',
  'public.report_export_package_artifact_failure(uuid,uuid,uuid,integer,text,text,text,bigint)',
  'public.workspace_status_before_storage_intents()','public.workspace_status()',
  'public.begin_render_storage_write(uuid,uuid,text,text,bigint)','public.delivery_export_context(uuid,uuid)','public.export_render_context(uuid,uuid)',
  'public.complete_delivery_artifact(uuid,uuid,uuid,text,bigint)','public.complete_export_package_volume(uuid,uuid,uuid,text,bigint)',
  'public.record_storage_cleanup_deletion(uuid,uuid,text,uuid,text)','public.storage_cleanup_context(uuid,uuid)','public.observe_cleanup_storage_write(uuid,uuid,text,bigint)','public.defer_storage_cleanup(uuid,uuid)','public.complete_storage_cleanup(uuid,uuid,boolean)'] loop
  execute 'revoke all on function '||signature||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function '||signature||' from '||quote_ident(role_name);end if;
  end loop;
  if signature like 'public.%' and signature not like '%before_storage_intents%' and signature<>'public.workspace_status()' then
   foreach role_name in array array['service_role','tdp_app_service'] loop
    if exists(select 1 from pg_roles where rolname=role_name) then execute 'grant execute on function '||signature||' to '||quote_ident(role_name);end if;
   end loop;
  end if;
 end loop;
-- Preserve the established authenticated canonical command entrypoint.
 foreach role_name in array array['authenticated','tdp_app_authenticated'] loop if exists(select 1 from pg_roles roles where roles.rolname=role_name) then execute 'grant execute on function app_private.app_command(text,jsonb,text),public.workspace_status() to '||quote_ident(role_name);end if;end loop;

 -- Restore these exact existing grants only on the canonical checked wrapper.
 for grant_row in select r.rolname,a.is_grantable
  from unnest(coalesce(old_service_acl,acldefault('f',old_owner))) with ordinality old_acl(value,position)
  cross join lateral aclexplode(array[old_acl.value]) a join pg_roles r on r.oid=a.grantee
  where r.rolname in ('service_role','tdp_app_service') and a.privilege_type='EXECUTE' order by old_acl.position loop
  execute format('grant execute on function public.workspace_status() to %I%s',grant_row.rolname,
   case when grant_row.is_grantable then ' with grant option' else '' end);
 end loop;
end $workspace_status_permissions$;
