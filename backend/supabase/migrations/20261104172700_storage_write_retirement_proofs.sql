-- Endpoint-local retirement state. In particular, these key fences have NO
-- workspace/artifact/cleanup foreign key: deletion and tenant backup/restore
-- must never revive an old signed upload key. Whole-cluster recovery must retain
-- this operational state or invalidate the old upload credentials separately.
create table app_private.storage_retirement_batches(
 operation_nonce uuid primary key,workspace_id uuid not null,actor_id uuid not null,
 scope jsonb not null,scope_sha256 text not null check(scope_sha256~'^[a-f0-9]{64}$'),
 state text not null default 'prepared' check(state in ('prepared','complete')),
 evidence jsonb,created_at timestamptz not null default clock_timestamp(),completed_at timestamptz
);
create table app_private.storage_retirement_keys(
 bucket_id text not null check(bucket_id='tenderdesk-private'),storage_key text not null,
 workspace_id uuid not null,intent_id uuid not null,operation_nonce uuid not null,
 retirement_nonce uuid not null,created_at timestamptz not null default clock_timestamp(),
 primary key(bucket_id,storage_key)
);
revoke all on app_private.storage_retirement_batches,app_private.storage_retirement_keys from public;
alter table app_private.storage_retirement_batches enable row level security;
alter table app_private.storage_retirement_keys enable row level security;

-- Installed on storage.objects only by the separately reviewed operational
-- helper, after checking the actual table owner and privileges. Application
-- migrations do not assume authority over a managed Storage schema.
create function public.guard_retired_storage_write() returns trigger
language plpgsql security definer set search_path='' as $$begin
 if exists(select 1 from app_private.storage_retirement_keys k where k.bucket_id=new.bucket_id and
  (k.storage_key=new.name or exists(select 1 from unnest(array['/','-$v-','.info']) separator
   where left(new.name,length(k.storage_key||separator))=k.storage_key||separator
    or left(k.storage_key,length(new.name||separator))=new.name||separator)))
 then raise exception 'STORAGE_KEY_RETIRED';end if;
 return new;
end$$;
revoke all on function public.guard_retired_storage_write() from public;

create function app_private.check_storage_retirement_reference(w uuid,key text) returns void
language plpgsql security definer set search_path='' as $$begin
 if exists(select 1 from public.documents where workspace_id=w and storage_key=key and status<>'expired')
  or exists(select 1 from public.export_artifacts where workspace_id=w and storage_key=key and status<>'expired')
  or exists(select 1 from public.proposal_delivery_artifacts where workspace_id=w and storage_key=key and status<>'expired')
  or exists(select 1 from public.export_package_volumes where workspace_id=w and storage_key=key and reserved_bytes>0)
  or exists(select 1 from public.restore_files f join public.restore_sessions s on s.id=f.session_id
   where f.workspace_id=w and f.storage_key=key and s.state in ('staging','committing'))
 then raise exception 'ACTIVE_REFERENCE_FOUND';end if;
 -- Application metadata can contain a physical alias even when Storage has no
 -- object row. Reject all known distinct aliases, across workspaces, before
 -- committing a permanent fence. The runner additionally checks Storage's
 -- all-version census using the separately observed Storage-owner authority.
 if exists(select 1 from (
  select storage_key from public.storage_write_intents union select storage_key from public.storage_cleanup_queue
  union select storage_key from public.documents union select storage_key from public.export_artifacts
  union select storage_key from public.proposal_delivery_artifacts union select storage_key from public.export_package_volumes
  union select storage_key from public.restore_files
 ) other_key cross join unnest(array['/','-$v-','.info']) separator
 where other_key.storage_key<>key and (left(other_key.storage_key,length(key||separator))=key||separator
  or left(key,length(other_key.storage_key||separator))=other_key.storage_key||separator))
 then raise exception 'STORAGE_RETIREMENT_NAMESPACE_COLLISION';end if;
end$$;

create function app_private.prepare_storage_write_retirement(actor_id uuid,operation_nonce uuid,selection jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare i public.storage_write_intents;item jsonb;w uuid;scope jsonb:='[]';digest text;b app_private.storage_retirement_batches;saved_selection jsonb;ordered_selection jsonb;begin
 if actor_id is null or operation_nonce is null or jsonb_typeof(selection) is distinct from 'array'
  or jsonb_array_length(selection) not between 1 and 25 or pg_column_size(selection)>65536 then raise exception 'INVALID_INPUT';end if;
 if (select count(distinct value->>'id') from jsonb_array_elements(selection))<>jsonb_array_length(selection) then raise exception 'INVALID_INPUT';end if;
 select workspace_id into w from public.storage_write_intents where id=(selection->0->>'id')::uuid;
 perform app_private.delivery_actor(w,actor_id);
 perform 1 from public.workspaces where id=w for update;
 perform app_private.delivery_actor(w,actor_id);
 if not exists(select 1 from public.memberships where workspace_id=w and user_id=actor_id and active and role='Owner') then raise exception 'ROLE_FORBIDDEN';end if;
 if not exists(select 1 from pg_trigger where tgrelid=to_regclass('storage.objects')
  and tgname='tenderdesk_retired_storage_write' and tgenabled='O' and tgtype=23
  and tgfoid='public.guard_retired_storage_write()'::regprocedure)
 then raise exception 'STORAGE_RETIREMENT_FENCE_REQUIRED';end if;
 for item in select value from jsonb_array_elements(selection) loop
  perform app_private.check_keys(item,array['id','storage_key','retirement_nonce','revision']);
 end loop;
 select jsonb_agg(value order by value->>'id') into ordered_selection from jsonb_array_elements(selection);
 select * into b from app_private.storage_retirement_batches where storage_retirement_batches.operation_nonce=prepare_storage_write_retirement.operation_nonce for update;
 if b.operation_nonce is not null then
  select jsonb_agg(jsonb_build_object('id',value->'id','storage_key',value->'storage_key',
   'retirement_nonce',value->'retirement_nonce','revision',value->'revision') order by value->>'id') into saved_selection from jsonb_array_elements(b.scope);
  if b.workspace_id is distinct from w or b.actor_id is distinct from actor_id or saved_selection is distinct from ordered_selection
   then raise exception 'STORAGE_RETIREMENT_NONCE_CONFLICT';end if;
  -- The live revision advances when completion commits. Replaying its exact
  -- original request returns that saved receipt after current Owner checks.
  if b.state='prepared' then
   for item in select value from jsonb_array_elements(b.scope) loop perform app_private.check_storage_retirement_reference(w,item->>'storage_key');end loop;
  end if;
  return to_jsonb(b);
 end if;
 for item in select value from jsonb_array_elements(selection) order by value->>'id' loop
  perform app_private.check_keys(item,array['id','storage_key','retirement_nonce','revision']);
  select * into i from public.storage_write_intents where id=(item->>'id')::uuid and workspace_id=w for update;
  if i.id is null or i.storage_key is distinct from item->>'storage_key' or i.retirement_nonce is distinct from (item->>'retirement_nonce')::uuid
   or i.revision is distinct from (item->>'revision')::integer then raise exception 'REVISION_CONFLICT';end if;
  if i.state not in ('unknown','legacy_unfenced','observed') then raise exception 'STORAGE_RETIREMENT_NOT_UNCERTAIN';end if;
  perform app_private.check_storage_retirement_reference(w,i.storage_key);
  scope:=scope||jsonb_build_array(jsonb_build_object('id',i.id,'workspace_id',i.workspace_id,'storage_key',i.storage_key,
   'state',i.state,'expected_hash',i.expected_hash,'expected_size',i.expected_size,'started_at',i.started_at,'observed_at',i.observed_at,
   'retirement_nonce',i.retirement_nonce,'revision',i.revision,'send_closed_at',i.send_closed_at));
 end loop;
 digest:=encode(sha256(convert_to(scope::text,'UTF8')),'hex');
 insert into app_private.storage_retirement_batches(operation_nonce,workspace_id,actor_id,scope,scope_sha256)
 values(operation_nonce,w,actor_id,scope,digest) returning * into b;
 for item in select value from jsonb_array_elements(scope) loop
  if exists(select 1 from app_private.storage_retirement_keys k where k.bucket_id='tenderdesk-private' and k.storage_key=item->>'storage_key'
   and (k.workspace_id is distinct from w or k.intent_id is distinct from (item->>'id')::uuid
    or k.operation_nonce is distinct from prepare_storage_write_retirement.operation_nonce)) then raise exception 'STORAGE_RETIREMENT_KEY_CONFLICT';end if;
  insert into app_private.storage_retirement_keys(bucket_id,storage_key,workspace_id,intent_id,operation_nonce,retirement_nonce)
   values('tenderdesk-private',item->>'storage_key',w,(item->>'id')::uuid,operation_nonce,(item->>'retirement_nonce')::uuid)
   on conflict(bucket_id,storage_key) do nothing;
 end loop;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details)
 values(w,actor_id,'storage.retirement.prepared','storage_retirement',operation_nonce,jsonb_build_object('scope_sha256',digest,'key_count',jsonb_array_length(scope)));
 return to_jsonb(b);
end$$;

-- Physical/process observations are supplied only by the reviewed direct-owner
-- runner. SQL cannot inspect a remote PVC or prove a kubelet has stopped a
-- process. It checks the exact saved scope, current actor/reference state, the
-- installed permanent fence and the bounded evidence contract before releasing
-- any existing reservation. There is deliberately no public/API-role RPC.
create function app_private.finish_storage_write_retirement(actor_id uuid,operation_nonce uuid,evidence jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b app_private.storage_retirement_batches;i public.storage_write_intents;
 item jsonb;proof jsonb;workload jsonb;pod jsonb;container jsonb;w uuid;released bigint:=0;amount bigint;begin
 select workspace_id into w from app_private.storage_retirement_batches where storage_retirement_batches.operation_nonce=finish_storage_write_retirement.operation_nonce;
 perform app_private.delivery_actor(w,actor_id);
 perform 1 from public.workspaces where id=w for update;
 perform app_private.delivery_actor(w,actor_id);
 if not exists(select 1 from public.memberships where workspace_id=w and user_id=actor_id and active and role='Owner') then raise exception 'ROLE_FORBIDDEN';end if;
 select * into b from app_private.storage_retirement_batches where storage_retirement_batches.operation_nonce=finish_storage_write_retirement.operation_nonce for update;
 if b.actor_id is distinct from actor_id then raise exception 'STORAGE_RETIREMENT_NONCE_CONFLICT';end if;
 if b.state='complete' then
  if b.evidence is distinct from evidence then raise exception 'STORAGE_RETIREMENT_EVIDENCE_CONFLICT';end if;
  return to_jsonb(b);
 end if;
 if not exists(select 1 from pg_trigger where tgrelid=to_regclass('storage.objects')
  and tgname='tenderdesk_retired_storage_write' and tgenabled='O' and tgtype=23
  and tgfoid='public.guard_retired_storage_write()'::regprocedure) then raise exception 'STORAGE_RETIREMENT_FENCE_REQUIRED';end if;
 perform app_private.check_keys(evidence,array['version','operation_nonce','scope_sha256','source_revision','run_id','run_attempt','namespace_uid','cluster_id','storage_image','physical_helper_sha256','fence_sha256','quiescence','keys']);
 if evidence->'version' is distinct from '1'::jsonb or evidence->>'operation_nonce' is distinct from operation_nonce::text
  or evidence->>'scope_sha256' is distinct from b.scope_sha256
  or coalesce(evidence->>'source_revision','')!~'^[a-f0-9]{40}$'
  or coalesce(evidence->>'run_id','')!~'^[0-9]{1,20}$' or coalesce(evidence->>'run_attempt','')!~'^[0-9]{1,6}$'
  or coalesce(evidence->>'namespace_uid','')!~'^[a-f0-9-]{36}$'
  or evidence->>'cluster_id' is distinct from 'a6093a76-a2d6-47fd-8697-579d41ed316f'
  or evidence->>'storage_image' is distinct from 'docker.io/supabase/storage-api:v1.81.0@sha256:92c5fe87ba5291915d0c21ca530ece9a58e13cc76a36a6c84fc69121a8dde799'
  or coalesce(evidence->>'physical_helper_sha256','')!~'^[a-f0-9]{64}$' or coalesce(evidence->>'fence_sha256','')!~'^[a-f0-9]{64}$'
  or jsonb_typeof(evidence->'quiescence') is distinct from 'array' or jsonb_array_length(evidence->'quiescence')<>3
  or jsonb_typeof(evidence->'keys') is distinct from 'array' or jsonb_array_length(evidence->'keys')<>jsonb_array_length(b.scope)
  or pg_column_size(evidence)>262144 then raise exception 'STORAGE_RETIREMENT_PROOF_INVALID';end if;
 if evidence->>'fence_sha256' is distinct from (select encode(sha256(convert_to(
  pg_get_functiondef('public.guard_retired_storage_write()'::regprocedure)||pg_get_triggerdef(oid),'UTF8')),'hex')
  from pg_trigger where tgrelid='storage.objects'::regclass and tgname='tenderdesk_retired_storage_write')
  then raise exception 'STORAGE_RETIREMENT_FENCE_CHANGED';end if;
 if (select array_agg(value->>'name' order by value->>'name') from jsonb_array_elements(evidence->'quiescence')) is distinct from array['gateway','storage','worker']::text[] then raise exception 'STORAGE_RETIREMENT_PROOF_INVALID';end if;
 for workload in select value from jsonb_array_elements(evidence->'quiescence') loop
  perform app_private.check_keys(workload,array['name','deployment_uid','image','original_replicas','pods']);
  if coalesce(workload->>'deployment_uid','')!~'^[a-f0-9-]{36}$' or coalesce(workload->>'image','')!~'@sha256:[a-f0-9]{64}$'
   or (workload->>'name'='storage' and workload->>'image' is distinct from evidence->>'storage_image')
   or coalesce(workload->>'original_replicas','')!~'^[1-9][0-9]?$' or jsonb_typeof(workload->'pods') is distinct from 'array'
   or jsonb_array_length(workload->'pods') not between 1 and 100 then raise exception 'STORAGE_RETIREMENT_PROOF_INVALID';end if;
  for pod in select value from jsonb_array_elements(workload->'pods') loop
   perform app_private.check_keys(pod,array['uid','containers']);
   if coalesce(pod->>'uid','')!~'^[a-f0-9-]{36}$' or jsonb_typeof(pod->'containers') is distinct from 'array'
    or jsonb_array_length(pod->'containers') not between 1 and 10 then raise exception 'STORAGE_RETIREMENT_PROOF_INVALID';end if;
   for container in select value from jsonb_array_elements(pod->'containers') loop
    perform app_private.check_keys(container,array['name','container_id','finished_at','exit_code']);
    if coalesce(container->>'name','')!~'^[a-z0-9-]{1,63}$' or coalesce(container->>'container_id','')!~'^(containerd|docker|cri-o)://[a-f0-9]{64}$'
     or nullif(container->>'finished_at','') is null or (container->>'finished_at')::timestamptz<b.created_at
     or (container->>'finished_at')::timestamptz>clock_timestamp()
     or jsonb_typeof(container->'exit_code') is distinct from 'number' then raise exception 'STORAGE_RETIREMENT_PROOF_INVALID';end if;
   end loop;
  end loop;
 end loop;
 if (select count(distinct value->>'id') from jsonb_array_elements(evidence->'keys'))<>jsonb_array_length(b.scope) then raise exception 'STORAGE_RETIREMENT_PROOF_INVALID';end if;
 for item in select value from jsonb_array_elements(b.scope) order by value->>'id' loop
  select value into proof from jsonb_array_elements(evidence->'keys') where value->>'id'=item->>'id';
  perform app_private.check_keys(proof,array['id','retirement_nonce','storage_key_sha256','before_manifest_sha256','after_manifest_sha256','remaining_count','metadata_remaining','removed_count','removed_bytes']);
  if proof is null or proof->>'retirement_nonce' is distinct from item->>'retirement_nonce'
   or proof->>'storage_key_sha256' is distinct from encode(sha256(convert_to(item->>'storage_key','UTF8')),'hex')
   or coalesce(proof->>'before_manifest_sha256','')!~'^[a-f0-9]{64}$' or coalesce(proof->>'after_manifest_sha256','')!~'^[a-f0-9]{64}$'
   or proof->'remaining_count' is distinct from '0'::jsonb or proof->'metadata_remaining' is distinct from '0'::jsonb
   or jsonb_typeof(proof->'removed_count') is distinct from 'number' or (proof->>'removed_count')::integer not between 0 and 256
   or jsonb_typeof(proof->'removed_bytes') is distinct from 'number' or (proof->>'removed_bytes')::bigint not between 0 and 262144000
   then raise exception 'STORAGE_RETIREMENT_PROOF_INVALID';end if;
  if not exists(select 1 from app_private.storage_retirement_keys k where k.bucket_id='tenderdesk-private'
   and k.storage_key=item->>'storage_key' and k.workspace_id=w and k.intent_id=(item->>'id')::uuid
   and k.operation_nonce=finish_storage_write_retirement.operation_nonce and k.retirement_nonce=(item->>'retirement_nonce')::uuid)
   then raise exception 'STORAGE_RETIREMENT_FENCE_REQUIRED';end if;
  select * into i from public.storage_write_intents where id=(item->>'id')::uuid and workspace_id=w for update;
  if i.id is null or i.storage_key is distinct from item->>'storage_key' or i.retirement_nonce is distinct from (item->>'retirement_nonce')::uuid
   or i.expected_hash is distinct from item->>'expected_hash' or i.expected_size is distinct from (item->>'expected_size')::bigint
   or i.started_at is distinct from (item->>'started_at')::timestamptz or i.send_closed_at is distinct from (item->>'send_closed_at')::timestamptz
   or not ((i.revision=(item->>'revision')::integer and i.state=item->>'state' and i.observed_at is not distinct from (item->>'observed_at')::timestamptz)
    -- One positive read may settle a pending single PUT while the runner is
    -- stopping workers. It cannot authorize another send or alter identity.
    or (item->>'state'='unknown' and i.state='observed' and i.revision=(item->>'revision')::integer+1 and item->>'observed_at' is null and i.observed_at is not null))
   then raise exception 'REVISION_CONFLICT';end if;
  perform app_private.check_storage_retirement_reference(w,i.storage_key);
  select coalesce(sum(estimated_size),0) into amount from public.storage_cleanup_queue where workspace_id=w and storage_key=i.storage_key and status<>'done';
  released:=released+amount;
  update public.storage_write_intents set state='quiesced',send_closed_at=coalesce(send_closed_at,clock_timestamp()),
   retirement_receipt=jsonb_build_object('operation_nonce',operation_nonce,'scope_sha256',b.scope_sha256,'proof',proof),
   revision=revision+1,updated_at=clock_timestamp() where id=i.id;
  update public.storage_cleanup_queue set status='done',lease_token=null,lease_until=null,error_code=null,updated_at=clock_timestamp()
   where workspace_id=w and storage_key=i.storage_key and status<>'done';
  update public.restore_files set status='removed' where workspace_id=w and storage_key=i.storage_key and status<>'removed';
 end loop;
 update app_private.storage_retirement_batches set state='complete',evidence=finish_storage_write_retirement.evidence,completed_at=clock_timestamp()
  where storage_retirement_batches.operation_nonce=finish_storage_write_retirement.operation_nonce returning * into b;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details)
 values(w,actor_id,'storage.retirement.completed','storage_retirement',operation_nonce,jsonb_build_object('scope_sha256',b.scope_sha256,'released_reserved_bytes',released,'key_count',jsonb_array_length(b.scope)));
 return to_jsonb(b);
end$$;

-- No public RPC or direct API-role grant exposes retirement preparation or its
-- physical proof. Managed service roles may inherit the application owner;
-- this private schema is not exposed by PostgREST. The runner uses an explicitly
-- reviewed owner-bound direct connection, whose authority is checked separately.
do $$declare role_name text;signature text;begin
 foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then
   execute format('revoke all on app_private.storage_retirement_batches,app_private.storage_retirement_keys from %I',role_name);
   foreach signature in array array['public.guard_retired_storage_write()',
    'app_private.check_storage_retirement_reference(uuid,text)',
    'app_private.prepare_storage_write_retirement(uuid,uuid,jsonb)',
    'app_private.finish_storage_write_retirement(uuid,uuid,jsonb)'] loop
    execute format('revoke all on function %s from public,%I',signature,role_name);
   end loop;
  end if;
 end loop;
end$$;
