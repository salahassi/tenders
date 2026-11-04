-- Durable local rendering is independent of model work and proposal approval.
-- Snapshot creation reserves no storage: capacity failure must never roll back
-- a saved content unit. The worker reserves the complete immutable volume set.
create table public.proposal_delivery_artifacts (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null,
 snapshot_id uuid not null, job_id uuid not null,
 renderer_version text not null check(renderer_version='1'),
 volume text not null check(volume in ('combined','technical','financial')),
 storage_key text not null unique, original_name text not null,
 mime_type text not null default 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  check(mime_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
 status text not null default 'pending' check(status in ('pending','ready','expired')),
 reserved_bytes bigint not null default 0 check(reserved_bytes between 0 and 10485760),
 expected_size bigint check(expected_size between 1 and 10485760),
 content_hash text check(content_hash ~ '^[a-f0-9]{64}$'),
 created_by uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 revision integer not null default 1 check(revision>0),
 unique(workspace_id,id), unique(workspace_id,snapshot_id,renderer_version,volume),
 foreign key(workspace_id) references public.workspaces(id) deferrable initially immediate,
 foreign key(workspace_id,snapshot_id) references public.proposal_delivery_snapshots(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,job_id) references public.jobs(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,created_by) references public.workspace_actors(workspace_id,id) deferrable initially immediate,
 check((status='pending' and expected_size is null and content_hash is null and reserved_bytes in (0,10485760))
  or (status='ready' and expected_size is not null and content_hash is not null and reserved_bytes=expected_size)
  or (status='expired' and reserved_bytes=0))
);
create index delivery_artifact_job on public.proposal_delivery_artifacts(workspace_id,job_id);
alter table public.proposal_delivery_artifacts enable row level security;
do $role_acl$ declare role_name text;begin
 revoke all on public.proposal_delivery_artifacts from public;
 foreach role_name in array array['anon','tdp_app_anon','authenticated','tdp_app_authenticated'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on public.proposal_delivery_artifacts from '||quote_ident(role_name);end if;
 end loop;
end $role_acl$;
do $role_acl$ declare role_name text;begin
 foreach role_name in array array['service_role','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute 'grant all on public.proposal_delivery_artifacts to '||quote_ident(role_name);end if;
 end loop;
end $role_acl$;

alter function app_private.storage_reserved_bytes(uuid) rename to storage_reserved_bytes_before_delivery;
create function app_private.storage_reserved_bytes(w uuid) returns bigint
language sql stable security definer set search_path='' as $$
 select app_private.storage_reserved_bytes_before_delivery(w)+
  (select coalesce(sum(reserved_bytes),0) from public.proposal_delivery_artifacts where workspace_id=w and status<>'expired')
$$;
create function app_private.guard_delivery_artifact() returns trigger
language plpgsql security definer set search_path='' as $$
declare previous_job public.jobs;next_job public.jobs;begin
 if tg_op='UPDATE' and old.job_id<>new.job_id then
  select * into previous_job from public.jobs where id=old.job_id;
  select * into next_job from public.jobs where id=new.job_id;
  if previous_job.status not in ('blocked','failed','canceled') or previous_job.lease_token is not null or previous_job.lease_until is not null
   or next_job.id is null or next_job.type<>'render_delivery' or next_job.status<>'queued' or next_job.attempts<>0
   or next_job.entity_id<>old.snapshot_id or next_job.workspace_id<>old.workspace_id
   or next_job.input_hash is distinct from (select content_hash from public.proposal_delivery_snapshots where id=old.snapshot_id)
   then raise exception 'DELIVERY_ARTIFACT_IMMUTABLE';end if;
  perform app_private.delivery_actor(old.workspace_id,next_job.created_by,true);
  if (to_jsonb(new)-array['job_id','revision','updated_at','storage_key','status','expected_size','content_hash']) is distinct from
   (to_jsonb(old)-array['job_id','revision','updated_at','storage_key','status','expected_size','content_hash']) then raise exception 'DELIVERY_ARTIFACT_IMMUTABLE';end if;
  if old.status='expired' then
   if new.status<>'pending' or new.reserved_bytes<>0 or new.expected_size is not null or new.content_hash is not null
    or new.storage_key<>old.workspace_id::text||'/deliveries/'||old.snapshot_id::text||'/1/'||new.job_id::text||'/'||old.id::text||'.docx' then raise exception 'DELIVERY_ARTIFACT_IMMUTABLE';end if;
  elsif (old.status,old.storage_key,old.expected_size,old.content_hash) is distinct from (new.status,new.storage_key,new.expected_size,new.content_hash) then raise exception 'DELIVERY_ARTIFACT_IMMUTABLE';end if;
  return new;
 end if;
 if tg_op='UPDATE' and (old.workspace_id,old.snapshot_id,old.job_id,old.renderer_version,old.volume,old.storage_key,old.original_name,old.mime_type,old.created_by,old.created_at)
  is distinct from (new.workspace_id,new.snapshot_id,new.job_id,new.renderer_version,new.volume,new.storage_key,new.original_name,new.mime_type,new.created_by,new.created_at)
  then raise exception 'DELIVERY_ARTIFACT_IMMUTABLE';end if;
 if tg_op='UPDATE' and old.status='ready' and new is distinct from old then raise exception 'DELIVERY_ARTIFACT_IMMUTABLE';end if;
 if new.reserved_bytes>(case when tg_op='UPDATE' then old.reserved_bytes else 0 end) then
  perform 1 from public.workspaces where id=new.workspace_id for update;
  if app_private.storage_reserved_bytes(new.workspace_id)+new.reserved_bytes-(case when tg_op='UPDATE' then old.reserved_bytes else 0 end)>262144000
   then raise exception 'STORAGE_CAP_REACHED';end if;
 end if;return new;
end $$;
create trigger guard_delivery_artifact before insert or update on public.proposal_delivery_artifacts
 for each row execute function app_private.guard_delivery_artifact();

-- Extend the existing job enum without dropping any installed work types.
do $$ declare definition text;begin
 select pg_get_constraintdef(oid) into definition from pg_constraint where conrelid='public.jobs'::regclass and conname='jobs_type_check';
 if position('ARRAY[' in definition)=0 then raise exception 'DELIVERY_JOB_TYPES_CHANGED';end if;
 alter table public.jobs drop constraint jobs_type_check;
 execute 'alter table public.jobs add constraint jobs_type_check '||replace(definition,'ARRAY[','ARRAY[''render_delivery''::text,');
end $$;
create unique index one_delivery_renderer_job on public.jobs(workspace_id,entity_id,(checkpoint->>'delivery_renderer_version'),(coalesce((checkpoint->>'delivery_attempt')::integer,1))) where type='render_delivery';

create function app_private.delivery_volumes(snapshot public.proposal_delivery_snapshots) returns text[]
language sql immutable set search_path='' as $$
 select case when snapshot.payload->'separate_volumes'='true'::jsonb then array['technical','financial'] else array['combined'] end::text[]
$$;
create function app_private.enqueue_delivery_export() returns trigger
language plpgsql security definer set search_path='' as $$
declare render_job uuid;artifact uuid;volume text;begin
 if exists(select 1 from public.restore_sessions where workspace_id=new.workspace_id and state='committing') then return new;end if;
 perform 1 from public.workspaces where id=new.workspace_id for update;
 -- Coalesce only genuinely unstarted work: no lease, no request attempt and no
 -- reserved/ready/ambiguous bytes. Historical snapshots and files stay intact.
 update public.jobs j set status='canceled',cancel_requested=true,error_code='DELIVERY_SUPERSEDED',
  next_attempt_at='infinity',revision=j.revision+1,updated_at=now()
 where j.workspace_id=new.workspace_id and j.type='render_delivery' and j.status='queued'
  and j.attempts=0 and j.lease_token is null and j.lease_until is null
  and exists(select 1 from public.proposal_delivery_snapshots prior_snapshot where prior_snapshot.workspace_id=new.workspace_id and prior_snapshot.id=j.entity_id and prior_snapshot.proposal_id=new.proposal_id and prior_snapshot.ordinal<new.ordinal)
  and exists(select 1 from public.proposal_delivery_artifacts a where a.job_id=j.id)
  and not exists(select 1 from public.proposal_delivery_artifacts a where a.job_id=j.id and (a.status<>'pending' or a.reserved_bytes<>0));
 insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint)
 values(new.workspace_id,'render_delivery',new.id,new.content_hash,'queued',new.created_by,
  '{"model_executor":3,"delivery_renderer_version":"1","delivery_retry_policy":1,"delivery_attempt":1}') returning id into render_job;
 foreach volume in array app_private.delivery_volumes(new) loop
  artifact:=gen_random_uuid();
  insert into public.proposal_delivery_artifacts(id,workspace_id,snapshot_id,job_id,renderer_version,volume,storage_key,original_name,created_by)
  values(artifact,new.workspace_id,new.id,render_job,'1',volume,
   new.workspace_id::text||'/deliveries/'||new.id::text||'/1/'||artifact::text||'.docx',
   'proposal-draft-'||new.ordinal::text||'-'||volume||'.docx',new.created_by);
 end loop;return new;
end $$;
create trigger enqueue_delivery_export after insert on public.proposal_delivery_snapshots
 for each row execute function app_private.enqueue_delivery_export();

create function app_private.delivery_job(job_id uuid,lease uuid,check_sources boolean default true) returns public.jobs
language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.proposal_delivery_snapshots;begin
 select * into j from public.jobs where id=job_id;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 select * into j from public.jobs where id=job_id for update;
 if j.id is null or j.type<>'render_delivery' or j.status<>'running' or j.lease_token is distinct from lease
  or lease is null or j.lease_token is null or j.lease_until is null or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 -- Failure recording may terminally block a corrupt immutable context, but
 -- successful reads/commits always require every pin and current source guard.
 if check_sources then
  select * into s from public.proposal_delivery_snapshots where workspace_id=j.workspace_id and id=j.entity_id;
  if s.id is null or j.input_hash is distinct from s.content_hash or j.checkpoint->>'model_executor' is distinct from '3'
   or j.checkpoint->>'delivery_renderer_version' is distinct from '1' or j.checkpoint->>'delivery_retry_policy' is distinct from '1'
   then raise exception 'DELIVERY_ARTIFACT_INVALID';end if;
  perform app_private.check_delivery_snapshot(s,j.created_by);
 end if;
 return j;
end $$;
create function app_private.check_delivery_volume_set(snapshot public.proposal_delivery_snapshots,job_id uuid) returns void
language plpgsql stable security definer set search_path='' as $$
declare volumes text[];begin
 select array_agg(a.volume order by a.volume) into volumes from public.proposal_delivery_artifacts a
 where a.workspace_id=snapshot.workspace_id and a.snapshot_id=snapshot.id and a.job_id=check_delivery_volume_set.job_id and a.renderer_version='1';
 if volumes is distinct from (select array_agg(v order by v) from unnest(app_private.delivery_volumes(snapshot)) v)
  then raise exception 'DELIVERY_ARTIFACT_INVALID';end if;
end $$;
create function public.delivery_export_context(job_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.proposal_delivery_snapshots;needed bigint;artifacts jsonb;begin
 j:=app_private.delivery_job(job_id,lease);
 select * into s from public.proposal_delivery_snapshots where id=j.entity_id and workspace_id=j.workspace_id;
 perform app_private.check_delivery_volume_set(s,j.id);
 if exists(select 1 from public.proposal_delivery_artifacts where proposal_delivery_artifacts.job_id=j.id and status='expired') then raise exception 'DELIVERY_ARTIFACT_INVALID';end if;
 select coalesce(sum(10485760-reserved_bytes),0) into needed from public.proposal_delivery_artifacts where proposal_delivery_artifacts.job_id=j.id and status='pending';
 if app_private.storage_reserved_bytes(j.workspace_id)+needed>262144000 then raise exception 'STORAGE_CAP_REACHED';end if;
 update public.proposal_delivery_artifacts set reserved_bytes=10485760,revision=revision+1,updated_at=now()
 where proposal_delivery_artifacts.job_id=j.id and status='pending' and reserved_bytes=0;
 select jsonb_agg(to_jsonb(a) order by a.volume) into artifacts from public.proposal_delivery_artifacts a where a.job_id=j.id;
 return jsonb_build_object('snapshot',to_jsonb(s),'artifacts',artifacts,'renderer_version','1','server_now',clock_timestamp(),'lease_until',j.lease_until);
end $$;
create function public.complete_delivery_artifact(job_id uuid,lease uuid,artifact_id uuid,actual_hash text,actual_size bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs;a public.proposal_delivery_artifacts;begin
 j:=app_private.delivery_job(job_id,lease);
 select * into a from public.proposal_delivery_artifacts where id=artifact_id and workspace_id=j.workspace_id and proposal_delivery_artifacts.job_id=j.id for update;
 if a.id is null then raise exception 'NOT_FOUND';end if;
 if actual_hash is null or actual_hash!~'^[a-f0-9]{64}$' or actual_size is null or actual_size not between 1 and 10485760 then raise exception 'DELIVERY_ARTIFACT_INVALID';end if;
 if a.status='ready' then
  if a.content_hash<>actual_hash or a.expected_size<>actual_size then raise exception 'IDEMPOTENCY_CONFLICT';end if;return to_jsonb(a);
 end if;
 if a.status<>'pending' or a.reserved_bytes<>10485760 then raise exception 'DELIVERY_STORAGE_NOT_RESERVED';end if;
 -- The private worker has independently read/validated the stored DOCX bytes.
 -- SQL binds that verification to the current source, actor, lease and artifact.
 update public.proposal_delivery_artifacts set status='ready',expected_size=actual_size,content_hash=actual_hash,reserved_bytes=actual_size,
  revision=revision+1,updated_at=now() where id=a.id returning * into a;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details)
 values(j.workspace_id,j.created_by,'delivery.artifact.ready','proposal_delivery_artifact',a.id,
  jsonb_build_object('snapshot_id',a.snapshot_id,'content_hash',a.content_hash,'size',a.expected_size,'volume',a.volume,'renderer_version',a.renderer_version));
 return to_jsonb(a);
end $$;
create function public.finish_delivery_export(job_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.proposal_delivery_snapshots;begin
 j:=app_private.delivery_job(job_id,lease);
 select * into s from public.proposal_delivery_snapshots where id=j.entity_id;
 perform app_private.check_delivery_volume_set(s,j.id);
 if exists(select 1 from public.proposal_delivery_artifacts where proposal_delivery_artifacts.job_id=j.id and status<>'ready') then raise exception 'DELIVERY_EXPORT_INCOMPLETE';end if;
 update public.jobs set status='succeeded',error_code=null,lease_token=null,lease_until=null,revision=revision+1,updated_at=now()
 where id=j.id returning * into j;return to_jsonb(j);
end $$;
create function public.fail_delivery_export(job_id uuid,lease uuid,error_code text) returns void
language plpgsql security definer set search_path='' as $$
declare j public.jobs;transient boolean;begin
 j:=app_private.delivery_job(job_id,lease,false);
 transient:=error_code in ('DELIVERY_STORAGE_UNAVAILABLE','DELIVERY_RENDER_FAILED','DELIVERY_RENDER_TIMEOUT','DATABASE_TEMPORARY_FAILURE','STORAGE_CAP_REACHED');
 if error_code is null or (not transient and error_code not in ('DELIVERY_ARTIFACT_INVALID','DELIVERY_GAP_INVALID','DELIVERY_RENDERER_UNSUPPORTED',
  'DELIVERY_SOURCE_UNAVAILABLE','ROLE_FORBIDDEN','STALE_INPUT','RESTORE_IN_PROGRESS','DATA_POLICY_BLOCKED',
  'DELIVERY_STORAGE_NOT_RESERVED','DELIVERY_EXPORT_INCOMPLETE','IDEMPOTENCY_CONFLICT',
  'EXPORT_HASH_MISMATCH','EXPORT_SIZE_MISMATCH','EXPORT_INVALID_DOCX','EXPORT_CONTENT_MISMATCH','EXPORT_FORMAT_INVALID','INVALID_EXPORT_ARCHIVE','EXPORT_UNSAFE_CONTENT','EXPORT_METADATA_REVIEW_REQUIRED','EXPORT_FIELDS_MISSING','EXPORT_BLOCKED',
  'EXPORT_PLACEHOLDER_MISMATCH','BUYER_VOLUME_RULE','TECHNICAL_VOLUME_CONTAINS_PRICE'))
  then raise exception 'INVALID_INPUT';end if;
 update public.jobs set status=case when transient and failure_count<5 then 'retry_wait' else 'blocked' end,error_code=fail_delivery_export.error_code,
  failure_count=failure_count+1,next_attempt_at=case when transient and failure_count<5 then now()+make_interval(secs=>least(3600,30*power(2,least(failure_count,7)))::int) else 'infinity'::timestamptz end,
  lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
 -- Reserved/ambiguous bytes are retained; a retry reads the same immutable key.
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details)
 values(j.workspace_id,j.created_by,'delivery.render.pending','job',j.id,
  jsonb_build_object('error_code',error_code,'retryable',transient,'automatic_retry_scheduled',transient and j.failure_count<5,'retry_policy',1,'snapshot_id',j.entity_id));
end $$;

create function public.delivery_package(snapshot_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.proposal_delivery_snapshots;j public.jobs;artifacts jsonb;ready boolean;missing_queue boolean;begin
 select * into s from public.proposal_delivery_snapshots where id=snapshot_id;
 perform app_private.check_delivery_snapshot(s,auth.uid());
 missing_queue:=not exists(select 1 from public.proposal_delivery_artifacts where workspace_id=s.workspace_id and proposal_delivery_artifacts.snapshot_id=s.id)
  and not exists(select 1 from public.jobs where workspace_id=s.workspace_id and type='render_delivery' and entity_id=s.id);
 if missing_queue then
  artifacts:='[]'::jsonb;ready:=false;j.status:='not_queued';j.error_code:='DELIVERY_NOT_QUEUED';
 else
  select * into j from public.jobs where workspace_id=s.workspace_id and id=(select a.job_id from public.proposal_delivery_artifacts a where a.snapshot_id=s.id limit 1);
  perform app_private.check_delivery_volume_set(s,j.id);
 select jsonb_agg(jsonb_build_object('id',a.id,'volume',a.volume,'status',a.status,'content_hash',a.content_hash,
  'expected_size',a.expected_size,'original_name',a.original_name,'mime_type',a.mime_type) order by a.volume),bool_and(a.status='ready')
 into artifacts,ready from public.proposal_delivery_artifacts a where a.job_id=j.id;
 end if;
 return jsonb_build_object('snapshot',jsonb_build_object('id',s.id,'proposal_id',s.proposal_id,'delivery_revision',(select delivery_revision from public.proposals where id=s.proposal_id),'ordinal',s.ordinal,'language',s.payload->>'language',
  'content_state',s.payload->>'content_state','input_state',s.payload->>'input_state','assurance_state',s.payload->>'assurance_state',
  'gap_count',jsonb_array_length(s.payload->'gaps')),
  'status',case when missing_queue then 'blocked' when ready and j.status='succeeded' then 'ready' when j.status in ('blocked','failed','canceled') then 'blocked' else 'preparing' end,
  'artifacts',artifacts,'job',jsonb_build_object('id',j.id,'status',j.status,'error_code',j.error_code,'next_attempt_at',case when isfinite(j.next_attempt_at) then j.next_attempt_at end));
end $$;
create function public.delivery_artifact_context(artifact_id uuid,actor_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.proposal_delivery_artifacts;s public.proposal_delivery_snapshots;begin
 select * into a from public.proposal_delivery_artifacts where id=artifact_id;
 if a.id is null then raise exception 'NOT_FOUND';end if;
 select * into s from public.proposal_delivery_snapshots where id=a.snapshot_id and workspace_id=a.workspace_id;
 perform app_private.check_delivery_snapshot(s,actor_id);
 perform app_private.check_delivery_volume_set(s,a.job_id);
 if a.status<>'ready' or exists(select 1 from public.proposal_delivery_artifacts where job_id=a.job_id and status<>'ready')
  or not exists(select 1 from public.jobs where id=a.job_id and status='succeeded')
  then raise exception 'DELIVERY_EXPORT_INCOMPLETE';end if;
 return jsonb_build_object('artifact',to_jsonb(a),'snapshot',to_jsonb(s));
end $$;
create function public.authorize_delivery_artifact_download(artifact_id uuid,actor_id uuid,actual_hash text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare context jsonb;begin
 context:=public.delivery_artifact_context(artifact_id,actor_id);
 if actual_hash is null or context#>>'{artifact,content_hash}' is distinct from actual_hash then raise exception 'EXPORT_HASH_MISMATCH';end if;
 return (context->'artifact')-'storage_key';
end $$;

-- New workers opt into executor 3. Old workers and their local drain stay <=2.
do $$ declare definition text;marker text;begin
 select pg_get_functiondef('app_private.queue_work_class(public.jobs)'::regprocedure) into definition;
 marker:='j.type = ''advance_plan''::text';
 if position(marker in definition)>0 then execute replace(definition,marker,'j.type = ANY (ARRAY[''advance_plan''::text,''render_delivery''::text])');
 else
  marker:='j.type=''advance_plan''';
  if position(marker in definition)=0 then raise exception 'DELIVERY_QUEUE_CLASS_CHANGED';end if;
  execute replace(definition,marker,'j.type in (''advance_plan'',''render_delivery'')');
 end if;
 select pg_get_functiondef('public.claim_backend_job()'::regprocedure) into definition;
 marker:='update public.jobs set status=case when cancel_requested';
 if position(marker in definition)=0 then raise exception 'DELIVERY_LEASE_RECOVERY_CHANGED';end if;
 execute replace(definition,marker,$new$update public.jobs set status=case when failure_count<5 then 'retry_wait' else 'blocked' end,error_code='DELIVERY_WORKER_RESTARTED',failure_count=failure_count+1,lease_token=null,lease_until=null,next_attempt_at=case when failure_count<5 then now() else 'infinity'::timestamptz end,revision=revision+1,updated_at=now()
  where workspace_id=w and type='render_delivery' and status='running' and lease_until<now() and not cancel_requested;
 $new$||marker);
 select pg_get_functiondef('app_private.recover_processing_job(uuid,timestamptz)'::regprocedure) into definition;
 marker:='select * into j from public.jobs where id=target for update;';
 if position(marker in definition)=0 then raise exception 'DELIVERY_RETRY_POLICY_CHANGED';end if;
 execute replace(definition,marker,marker||' if j.type=''render_delivery'' then return;end if;');
end $$;
create function public.claim_backend_job_v3() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;previous text:=current_setting('app.worker_executor',true);begin
 perform set_config('app.worker_executor','3',true);result:=public.claim_backend_job();
 perform set_config('app.worker_executor',coalesce(previous,''),true);return result;
end $$;
create function public.claim_backend_local_job_v3() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;previous text:=current_setting('app.queue_local_only',true);begin
 perform set_config('app.queue_local_only','true',true);result:=public.claim_backend_job_v3();
 perform set_config('app.queue_local_only',coalesce(previous,''),true);return result;
end $$;

-- An explicit, revision-checked local retry never revives historical actor
-- authority. Immutable bytes survive; only execution ownership changes.
alter function app_private.app_command(text,jsonb,text) rename to app_command_before_delivery_retry;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid:=auth.uid();s public.proposal_delivery_snapshots;p public.proposals;j public.jobs;
 next_job uuid;attempt integer;replay app_private.idempotency_records;digest text;result jsonb;initialize boolean;volume text;artifact uuid;
begin
 if operation<>'delivery.snapshot.retry' then return app_private.app_command_before_delivery_retry(operation,input,idempotency_key);end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;
 perform app_private.delivery_actor(w,actor,true);perform 1 from public.workspaces where id=w for update;
 -- Membership can change while the caller waits for the workspace lock.
 perform app_private.delivery_actor(w,actor,true);
 if exists(select 1 from public.restore_sessions where workspace_id=w and state in ('staging','committing')) then raise exception 'RESTORE_IN_PROGRESS';end if;
 perform app_private.check_keys(input,array['snapshot_id','expected_delivery_revision']);
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(input)>65536 then raise exception 'INVALID_INPUT';end if;
 digest:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into s from public.proposal_delivery_snapshots where workspace_id=w and id=(input->>'snapshot_id')::uuid;
 perform app_private.check_delivery_snapshot(s,actor);
 select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key and expires_at>now();
 if replay.key is not null then if replay.body_hash is distinct from digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 select * into p from public.proposals where workspace_id=w and id=s.proposal_id for update;
 if p.delivery_revision is distinct from (input->>'expected_delivery_revision')::integer then raise exception 'REVISION_CONFLICT';end if;
 -- A snapshot saved before this queue migration has neither rows nor jobs.
 -- Only an explicit current request initializes it; mixed/partial state fails
 -- the normal immutable volume check rather than being guessed or repaired.
 initialize:=not exists(select 1 from public.proposal_delivery_artifacts where workspace_id=w and snapshot_id=s.id)
  and not exists(select 1 from public.jobs where workspace_id=w and type='render_delivery' and entity_id=s.id);
 if initialize then attempt:=1;
 else
  select * into j from public.jobs where workspace_id=w and id=(select a.job_id from public.proposal_delivery_artifacts a where a.snapshot_id=s.id limit 1) for update;
  perform app_private.check_delivery_volume_set(s,j.id);
  if j.id is null or j.status not in ('blocked','failed','canceled') or j.lease_token is not null or j.lease_until is not null then raise exception 'DELIVERY_RETRY_NOT_ALLOWED';end if;
  select coalesce(max(coalesce((checkpoint->>'delivery_attempt')::int,1)),0)+1 into attempt from public.jobs where workspace_id=w and type='render_delivery' and entity_id=s.id;
 end if;
 insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint)
 values(w,'render_delivery',s.id,s.content_hash,'queued',actor,jsonb_build_object('model_executor',3,'delivery_renderer_version','1','delivery_retry_policy',1,'delivery_attempt',attempt)) returning id into next_job;
 if initialize then
  foreach volume in array app_private.delivery_volumes(s) loop
   artifact:=gen_random_uuid();
   insert into public.proposal_delivery_artifacts(id,workspace_id,snapshot_id,job_id,renderer_version,volume,storage_key,original_name,created_by)
   values(artifact,w,s.id,next_job,'1',volume,w::text||'/deliveries/'||s.id::text||'/1/'||artifact::text||'.docx',
    'proposal-draft-'||s.ordinal::text||'-'||volume||'.docx',actor);
  end loop;
 else
 update public.proposal_delivery_artifacts set job_id=next_job,
  storage_key=case when status='expired' then w::text||'/deliveries/'||s.id::text||'/1/'||next_job::text||'/'||id::text||'.docx' else storage_key end,
  expected_size=case when status='expired' then null else expected_size end,
  content_hash=case when status='expired' then null else content_hash end,
  status=case when status='expired' then 'pending' else status end,revision=revision+1,updated_at=now()
 where workspace_id=w and snapshot_id=s.id;
 end if;
 update public.proposals set delivery_revision=delivery_revision+1 where id=p.id;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details)
 values(w,actor,case when initialize then 'delivery.render.initialized' else 'delivery.render.retried' end,'proposal_delivery_snapshot',s.id,jsonb_build_object('previous_job_id',j.id,'job_id',next_job,'delivery_attempt',attempt));
 result:=to_jsonb(s);
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,digest,result);
 return result;
end $$;

-- Versioned wake admission keeps old dispatchers restricted to executor 2.
-- The v3 clone retains the original throttle, revision, restore, lease and
-- accepted-provider-request guards; it adds only local delivery eligibility.
do $$ declare definition text;marker text;begin
 select pg_get_functiondef('app_private.wake_backend_queue_checked(uuid,uuid,bigint)'::regprocedure) into definition;
 definition:=replace(definition,'app_private.wake_backend_queue_checked(', 'app_private.wake_backend_queue_checked_v3(');
 if position('<=2' in definition)=0 then raise exception 'DELIVERY_WAKE_EXECUTOR_CHANGED';end if;
 definition:=replace(definition,'<=2','<=3');
 marker:='ready.type=''advance_plan''';
 if position(marker in definition)=0 then raise exception 'DELIVERY_WAKE_LOCAL_CHANGED';end if;
 definition:=replace(definition,marker,'app_private.queue_work_class(ready)=''local''');
 marker:='(q.status=''retry_wait'' and q.error_code=''MODEL_IN_PROGRESS'' and not (q.checkpoint ? ''model_round''))';
 if position(marker in definition)=0 then raise exception 'DELIVERY_WAKE_ELIGIBILITY_CHANGED';end if;
 definition:=replace(definition,marker,'(q.status=''retry_wait'' and (q.type=''render_delivery'' or (q.error_code=''MODEL_IN_PROGRESS'' and not (q.checkpoint ? ''model_round''))))');
 execute definition;
end $$;
create function public.wake_backend_queue_status_v3(job_id uuid,lease uuid) returns jsonb
language sql security definer set search_path='' as $$
 select app_private.wake_backend_queue_checked_v3(job_id,lease,null)
$$;
create function public.wake_backend_queue_revision_v3(job_id uuid,lease uuid,expected_revision bigint) returns jsonb
language sql security definer set search_path='' as $$
 select case when expected_revision is null then '{"dispatched":false}'::jsonb
  else app_private.wake_backend_queue_checked_v3(job_id,lease,expected_revision) end
$$;

-- Logical backup includes real ready bytes, not pending or imagined files.
alter function app_private.backup_tables() rename to backup_tables_before_delivery_artifacts;
create function app_private.backup_tables() returns text[] language sql immutable set search_path='' as $$
 select app_private.backup_tables_before_delivery_artifacts()||array['proposal_delivery_artifacts']::text[]
$$;
do $$ declare definition text;marker text;begin
 select pg_get_functiondef('public.workspace_backup_manifest()'::regprocedure) into definition;
 marker:='from public.export_artifacts where workspace_id=w and status=''ready'') x;';
 if position(marker in definition)=0 then raise exception 'DELIVERY_BACKUP_FILES_CHANGED';end if;
 execute replace(definition,marker,$new$from public.export_artifacts where workspace_id=w and status='ready'
 union all select jsonb_build_object('key','proposal_delivery_artifacts/'||id,'hash',content_hash,'size',expected_size,'name',original_name,'mime',mime_type)
 from public.proposal_delivery_artifacts where workspace_id=w and status='ready') x;$new$);
 select pg_get_functiondef('public.recovery_file_context(text,uuid)'::regprocedure) into definition;
 marker:='else raise exception ''INVALID_KIND'';end if;';
 if position(marker in definition)=0 then raise exception 'DELIVERY_BACKUP_CONTEXT_CHANGED';end if;
 execute replace(definition,marker,$new$elsif file_kind='proposal_delivery_artifacts' then
 select jsonb_build_object('workspace_id',workspace_id,'storage_key',storage_key,'size',expected_size,'hash',content_hash,'name',original_name,'mime',mime_type)
 into result from public.proposal_delivery_artifacts where workspace_id=w and id=file_id and status='ready';else raise exception 'INVALID_KIND';end if;$new$);
 select pg_get_functiondef('public.begin_workspace_restore(jsonb,boolean)'::regprocedure) into definition;
 marker:='(''documents'',''export_artifacts'')';
 if position(marker in definition)=0 then raise exception 'DELIVERY_RESTORE_MANIFEST_CHANGED';end if;
 execute replace(definition,marker,'(''documents'',''export_artifacts'',''proposal_delivery_artifacts'')');
 select pg_get_functiondef('public.commit_workspace_restore(uuid)'::regprocedure) into definition;
 if position(marker in definition)=0 then raise exception 'DELIVERY_RESTORE_ROWS_CHANGED';end if;
 definition:=replace(definition,marker,'(''documents'',''export_artifacts'',''proposal_delivery_artifacts'')');
 marker:='split_part(r.row_key,''/'',1)=''export_artifacts'' and r.d->>''status''=''ready''';
 if position(marker in definition)=0 then raise exception 'DELIVERY_RESTORE_FILE_CHECK_CHANGED';end if;
 definition:=replace(definition,marker,'split_part(r.row_key,''/'',1) in (''export_artifacts'',''proposal_delivery_artifacts'') and r.d->>''status''=''ready''');
 marker:='elsif t=''export_artifacts'' then';
 if position(marker in definition)=0 then raise exception 'DELIVERY_RESTORE_INSERT_CHANGED';end if;
 execute replace(definition,marker,$new$elsif t='proposal_delivery_artifacts' then
 select * into f from public.restore_files where session_id=s.id and row_key=r.row_key;
 data:=data||jsonb_build_object('storage_key',coalesce(f.storage_key,s.workspace_id::text||'/unavailable/'||(data->>'id')),
  'status',case when f.id is null then 'expired' else 'ready' end,'reserved_bytes',case when f.id is null then 0 else f.expected_size end);
 $new$||marker);
end $$;

-- Purge previews bind the new artifacts and render jobs; ambiguous stored bytes
-- retain their storage reservation until the existing cleanup confirms removal.
alter function app_private.purge_scope(uuid,uuid) rename to purge_scope_before_delivery_artifacts;
create function app_private.purge_scope(w uuid,opp uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;part jsonb;begin
 result:=app_private.purge_scope_before_delivery_artifacts(w,opp);
 select jsonb_build_object('ids',coalesce(jsonb_agg(a.id order by a.id),'[]'),
  'hash',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(a)::text,',' order by a.id),''),'UTF8')),'hex')) into part
 from public.proposal_delivery_artifacts a join public.proposal_delivery_snapshots s on s.workspace_id=a.workspace_id and s.id=a.snapshot_id where s.workspace_id=w and s.opportunity_id=opp;
 result:=result||jsonb_build_object('proposal_delivery_artifacts',part);
 select jsonb_build_object('ids',coalesce(jsonb_agg(j.id order by j.id),'[]'),
  'hash',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(j)::text,',' order by j.id),''),'UTF8')),'hex')) into part
 from public.jobs j where j.workspace_id=w and (j.id in(select value::uuid from jsonb_array_elements_text(result#>'{jobs,ids}'))
  or (j.type='render_delivery' and j.entity_id in(select id from public.proposal_delivery_snapshots where workspace_id=w and opportunity_id=opp)));
 return result||jsonb_build_object('jobs',part);
end $$;
do $$ declare definition text;marker text;begin
 select pg_get_functiondef('public.preview_opportunity_purge(uuid)'::regprocedure) into definition;
 marker:='scope->''export_artifacts''->''ids''))) x;';
 if position(marker in definition)=0 then raise exception 'DELIVERY_PURGE_PREVIEW_CHANGED';end if;
 execute replace(definition,marker,$new$scope->'export_artifacts'->'ids')) union all
 select jsonb_build_object('id',id,'name',original_name,'size',reserved_bytes,'hash',content_hash) from public.proposal_delivery_artifacts
 where reserved_bytes>0 and id in(select value::text::uuid from jsonb_array_elements_text(scope->'proposal_delivery_artifacts'->'ids'))) x;$new$);
 select pg_get_functiondef('public.purge_opportunity(uuid,text,text,text,boolean)'::regprocedure) into definition;
 marker:='scope->''export_artifacts''->''ids'')) on conflict(storage_key) do nothing;';
 if position(marker in definition)=0 then raise exception 'DELIVERY_PURGE_CLEANUP_CHANGED';end if;
 execute replace(definition,marker,$new$scope->'export_artifacts'->'ids')) union all
 select w,storage_key,reserved_bytes,'owner_confirmed_purge' from public.proposal_delivery_artifacts where reserved_bytes>0
 and id in(select value::uuid from jsonb_array_elements_text(scope->'proposal_delivery_artifacts'->'ids')) on conflict(storage_key) do nothing;$new$);
 select pg_get_functiondef('public.claim_storage_cleanup()'::regprocedure) into definition;
 marker:='if exists(select 1 from public.documents where storage_key=r.storage_key';
 if position(marker in definition)=0 then raise exception 'DELIVERY_CLEANUP_REFERENCES_CHANGED';end if;
 execute replace(definition,marker,'if exists(select 1 from public.proposal_delivery_artifacts where storage_key=r.storage_key and status<>''expired'') or exists(select 1 from public.documents where storage_key=r.storage_key');
 select pg_get_functiondef('public.archive_opportunity(uuid,integer,boolean,text)'::regprocedure) into definition;
 marker:='entity_id in(select gp.id from public.generation_plans gp where gp.opportunity_id=o.id)';
 if position(marker in definition)=0 then raise exception 'DELIVERY_ARCHIVE_JOBS_CHANGED';end if;
 execute replace(definition,marker,'(entity_id in(select gp.id from public.generation_plans gp where gp.opportunity_id=o.id) or (type=''render_delivery'' and entity_id in(select ds.id from public.proposal_delivery_snapshots ds where ds.opportunity_id=o.id)))');
end $$;

-- Delivery rows retain their job provenance until an explicit opportunity
-- purge removes both. Routine retention must not fail on that foreign key.
do $$ declare definition text;marker text;begin
 select pg_get_functiondef('public.maintenance_tick()'::regprocedure) into definition;
 marker:='and not exists(select 1 from public.source_runs sr where sr.job_id=j.id)';
 if position(marker in definition)=0 then raise exception 'DELIVERY_RETENTION_CHANGED';end if;
 execute replace(definition,marker,marker||' and not exists(select 1 from public.proposal_delivery_artifacts a where a.job_id=j.id)');
end $$;

-- Functions which expose file paths or commit receipts are service-only. Public
-- metadata uses auth.uid(); a browser-supplied actor UUID grants no authority.
do $$ declare signature text;role_name text;begin
 foreach signature in array array[
  'app_private.app_command_before_delivery_retry(text,jsonb,text)','app_private.app_command(text,jsonb,text)',
  'app_private.storage_reserved_bytes_before_delivery(uuid)','app_private.storage_reserved_bytes(uuid)',
  'app_private.guard_delivery_artifact()','app_private.delivery_volumes(public.proposal_delivery_snapshots)',
  'app_private.enqueue_delivery_export()','app_private.delivery_job(uuid,uuid,boolean)',
  'app_private.check_delivery_volume_set(public.proposal_delivery_snapshots,uuid)',
  'app_private.backup_tables_before_delivery_artifacts()','app_private.backup_tables()',
  'app_private.purge_scope_before_delivery_artifacts(uuid,uuid)','app_private.purge_scope(uuid,uuid)',
  'public.delivery_export_context(uuid,uuid)','public.complete_delivery_artifact(uuid,uuid,uuid,text,bigint)',
  'public.finish_delivery_export(uuid,uuid)','public.fail_delivery_export(uuid,uuid,text)',
  'public.delivery_package(uuid)','public.delivery_artifact_context(uuid,uuid)',
  'public.authorize_delivery_artifact_download(uuid,uuid,text)',
  'public.claim_backend_job_v3()','public.claim_backend_local_job_v3()',
  'app_private.wake_backend_queue_checked_v3(uuid,uuid,bigint)',
  'public.wake_backend_queue_status_v3(uuid,uuid)','public.wake_backend_queue_revision_v3(uuid,uuid,bigint)'] loop
  execute 'revoke all on function '||signature||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function '||signature||' from '||quote_ident(role_name);end if;
  end loop;
 end loop;
end $$;
do $role_acl$ declare role_name text;begin
 foreach role_name in array array['authenticated','tdp_app_authenticated'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute 'grant execute on function app_private.app_command(text,jsonb,text),public.delivery_package(uuid) to '||quote_ident(role_name);end if;
 end loop;
end $role_acl$;
do $role_acl$ declare role_name text;begin
 foreach role_name in array array['service_role','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute 'grant execute on function public.delivery_export_context(uuid,uuid),public.complete_delivery_artifact(uuid,uuid,uuid,text,bigint),
 public.finish_delivery_export(uuid,uuid),public.fail_delivery_export(uuid,uuid,text),
 public.delivery_artifact_context(uuid,uuid),public.authorize_delivery_artifact_download(uuid,uuid,text),
 public.claim_backend_job_v3(),public.claim_backend_local_job_v3(),
 public.wake_backend_queue_status_v3(uuid,uuid),public.wake_backend_queue_revision_v3(uuid,uuid,bigint) to '||quote_ident(role_name);end if;
 end loop;
end $role_acl$;
