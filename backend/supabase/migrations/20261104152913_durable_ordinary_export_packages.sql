-- Ordinary draft/final exports retain canonical export authorization, snapshots
-- and artifact rows; a local leased job owns the complete required volume set.
create table public.export_packages(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) deferrable initially immediate,
 opportunity_id uuid not null,proposal_id uuid not null,proposal_version_id uuid not null,version_revision integer not null,
 mode text not null check(mode in ('draft','final')),renderer_version text not null default 'ordinary-2' check(renderer_version='ordinary-2'),
 binding_hash text not null check(binding_hash~'^[a-f0-9]{64}$'),source_manifest jsonb not null,input_materials jsonb not null,
 required_volumes text[] not null check(required_volumes in (array['combined']::text[],array['technical','financial']::text[])),
 status text not null default 'preparing' check(status in ('preparing','ready','blocked')),error_code text,current_job_id uuid,
 accepted_at timestamptz not null,deadline_at timestamptz not null,revision integer not null default 1,
 created_by uuid not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,proposal_version_id,mode,renderer_version,binding_hash),
 foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,proposal_id) references public.proposals(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,proposal_version_id) references public.proposal_versions(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,created_by) references public.workspace_actors(workspace_id,id) deferrable initially immediate,
 check(deadline_at=accepted_at+interval '600 seconds')
);
create table public.export_package_volumes(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) deferrable initially immediate,package_id uuid not null,
 export_id uuid not null,volume text not null check(volume in ('combined','technical','financial')),
 storage_key text not null unique,artifact_id uuid,reserved_bytes bigint not null default 10485760 check(reserved_bytes in (0,10485760)),
 revision integer not null default 1,created_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,package_id,volume),unique(workspace_id,export_id),
 foreign key(workspace_id,package_id) references public.export_packages(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,export_id) references public.export_requests(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,artifact_id) references public.export_artifacts(workspace_id,id) deferrable initially immediate
);
create function app_private.guard_export_package_identity() returns trigger language plpgsql set search_path='' as $$begin
 if TG_TABLE_NAME='export_packages' then
  if (to_jsonb(new)-array['status','error_code','current_job_id','accepted_at','deadline_at','revision','updated_at']) is distinct from (to_jsonb(old)-array['status','error_code','current_job_id','accepted_at','deadline_at','revision','updated_at']) then raise exception 'EXPORT_PACKAGE_IMMUTABLE';end if;
 else
  if (to_jsonb(new)-array['artifact_id','reserved_bytes','storage_key','revision']) is distinct from (to_jsonb(old)-array['artifact_id','reserved_bytes','storage_key','revision']) then raise exception 'EXPORT_PACKAGE_IMMUTABLE';end if;
  if new.storage_key<>old.storage_key and (old.reserved_bytes<>0 or (old.artifact_id is not null and exists(select 1 from public.export_artifacts where id=old.artifact_id and status='ready'))) then raise exception 'EXPORT_PACKAGE_IMMUTABLE';end if;
  if old.artifact_id is not null and new.artifact_id is distinct from old.artifact_id and exists(select 1 from public.export_artifacts where id=old.artifact_id and status='ready') then raise exception 'EXPORT_PACKAGE_IMMUTABLE';end if;
 end if;return new;
end $$;
create trigger export_package_identity before update on public.export_packages for each row execute function app_private.guard_export_package_identity();
create trigger export_package_volume_identity before update on public.export_package_volumes for each row execute function app_private.guard_export_package_identity();
create function app_private.guard_packaged_export_request() returns trigger language plpgsql set search_path='' as $$begin
 if exists(select 1 from public.export_package_volumes where export_id=old.id) and
 (to_jsonb(new)-array['expires_at','revision']) is distinct from (to_jsonb(old)-array['expires_at','revision']) then raise exception 'EXPORT_PACKAGE_IMMUTABLE';end if;return new;
end $$;
create trigger packaged_export_request_identity before update on public.export_requests for each row execute function app_private.guard_packaged_export_request();
create index export_packages_deadline on public.export_packages(workspace_id,deadline_at) where status='preparing';
create index export_packages_opportunity on public.export_packages(workspace_id,opportunity_id);
create index export_package_volume_package on public.export_package_volumes(workspace_id,package_id);
alter function app_private.storage_reserved_bytes(uuid) rename to storage_reserved_bytes_before_export_packages;
create function app_private.storage_reserved_bytes(w uuid) returns bigint language sql stable security definer set search_path='' as $$select app_private.storage_reserved_bytes_before_export_packages(w)+coalesce((select sum(reserved_bytes) from public.export_package_volumes where workspace_id=w),0)$$;

create function app_private.check_export_package(p public.export_packages,actor uuid,check_expiry boolean default true) returns void language plpgsql security definer set search_path='' as $$
declare v public.proposal_versions;g public.generation_plans;r public.export_requests;ref jsonb;requirement public.requirements;actual_documents jsonb;saved_documents jsonb;begin
 if p.id is null then raise exception 'NOT_FOUND';end if;
 perform app_private.delivery_actor(p.workspace_id,actor);
 if exists(select 1 from public.restore_sessions where workspace_id=p.workspace_id and state in ('staging','committing')) then raise exception 'RESTORE_IN_PROGRESS';end if;
 select * into v from public.proposal_versions where workspace_id=p.workspace_id and id=p.proposal_version_id;
 select * into g from public.generation_plans where workspace_id=p.workspace_id and id=v.plan_id;
 if v.id is null or v.revision<>p.version_revision then raise exception 'STALE_INPUT';end if;
 if not exists(select 1 from public.opportunities where id=p.opportunity_id and workspace_id=p.workspace_id and not archived) then raise exception 'NOT_FOUND';end if;
 perform app_private.check_delivery_sources(p.workspace_id,p.source_manifest);perform app_private.check_delivery_materials(p.workspace_id,p.input_materials);
 select coalesce(jsonb_agg(x->>'document_id' order by x->>'document_id'),'[]') into actual_documents from jsonb_array_elements(app_private.delivery_input(p.workspace_id,p.opportunity_id)#>'{input_materials,documents}') x;
 select coalesce(jsonb_agg(x->>'document_id' order by x->>'document_id'),'[]') into saved_documents from jsonb_array_elements(coalesce(p.input_materials->'documents','[]')) x;
 if actual_documents is distinct from saved_documents then raise exception 'STALE_INPUT';end if;
 if to_regprocedure('app_private.current_document_extraction(uuid,uuid)') is not null then
  for ref in select value from jsonb_array_elements(p.source_manifest) where value->>'entity_kind'='document' loop
   if app_private.current_document_extraction(p.workspace_id,(ref->>'entity_id')::uuid) is distinct from (ref->>'entity_id')::uuid then raise exception 'STALE_INPUT';end if;
  end loop;
 end if;
 for requirement in select * from public.requirements where workspace_id=p.workspace_id and plan_id=g.id loop
  if requirement.source_semantics->>'review_status'='confirmed' and not app_private.check_source_semantics(p.workspace_id,requirement.source_semantics,requirement.source_refs) then raise exception 'STALE_INPUT';end if;
 end loop;
 if (select array_agg(volume order by volume) from public.export_package_volumes where package_id=p.id) is distinct from (select array_agg(x order by x) from unnest(p.required_volumes) x) then raise exception 'EXPORT_PACKAGE_INVALID';end if;
 for r in select e.* from public.export_requests e join public.export_package_volumes s on s.workspace_id=e.workspace_id and s.export_id=e.id where s.package_id=p.id loop
  perform app_private.check_export(r,actor,check_expiry);
  if r.proposal_version_id<>p.proposal_version_id or r.mode<>p.mode or r.snapshot->>'export_renderer_version' is distinct from p.renderer_version or r.binding is distinct from app_private.approval_gate(p.workspace_id,p.proposal_version_id)-'blockers' then raise exception 'STALE_EXPORT_APPROVAL';end if;
 end loop;
end $$;

alter table public.storage_cleanup_queue add column eligible_at timestamptz not null default clock_timestamp();

-- Once a required attempt ends, ambiguous uploaded bytes transfer their entire
-- reservation to the existing deletion queue. Retry uses a new private key for
-- any such slot, so delayed cleanup cannot delete a successor upload.
create function app_private.release_export_package_slots(package_id uuid) returns void language plpgsql security definer set search_path='' as $$begin
 insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason,eligible_at)
 select workspace_id,storage_key,reserved_bytes,'terminal_export_package',clock_timestamp()+interval '1 minute' from public.export_package_volumes
 where export_package_volumes.package_id=release_export_package_slots.package_id and artifact_id is null and reserved_bytes>0 on conflict(storage_key) do nothing;
 update public.export_package_volumes set reserved_bytes=0,revision=revision+1 where export_package_volumes.package_id=release_export_package_slots.package_id and artifact_id is null and reserved_bytes>0;
end $$;
create function app_private.expire_export_packages(w uuid default null) returns integer language plpgsql security definer set search_path='' as $$declare p public.export_packages;j public.jobs;n integer:=0;code text;begin
 for p in select * from public.export_packages where status in ('preparing','ready') and (w is null or workspace_id=w) order by workspace_id,id loop
  perform 1 from public.workspaces where id=p.workspace_id for update;
  select * into p from public.export_packages where id=p.id for update;
  select * into j from public.jobs where id=p.current_job_id;
  code:=null;
  if p.status='preparing' then
   if p.deadline_at<=clock_timestamp() then code:='EXPORT_ISSUANCE_TIMEOUT';
   elsif j.status in ('failed','blocked','canceled') then code:=coalesce(j.error_code,'EXPORT_RENDER_TERMINATED');
   elsif not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=p.workspace_id and m.user_id=j.created_by and m.active and a.status='active' and (p.mode='draft' or m.role='Owner')) then code:='ROLE_FORBIDDEN';end if;
  elsif p.status='ready' and exists(select 1 from public.export_package_volumes s left join public.export_artifacts a on a.id=s.artifact_id where s.package_id=p.id and (a.id is null or a.status<>'ready')) then code:='EXPORT_PACKAGE_BYTES_UNAVAILABLE';end if;
  if code is null then continue;end if;
  update public.export_packages set status='blocked',error_code=code,revision=revision+1,updated_at=now() where id=p.id;
  update public.jobs set status='failed',error_code=code,cancel_requested=true,lease_token=null,lease_until=null,next_attempt_at='infinity',revision=revision+1,updated_at=now() where id=p.current_job_id and status not in ('succeeded','failed','canceled');
  perform app_private.release_export_package_slots(p.id);n:=n+1;
 end loop;return n;
end $$;
create function app_private.export_package_metadata(p public.export_packages) returns jsonb language sql volatile security definer set search_path='' as $$
 select jsonb_build_object('id',p.id,'revision',p.revision,'status',p.status,'error_code',p.error_code,'mode',p.mode,'proposal_version_id',p.proposal_version_id,'renderer_version',p.renderer_version,'accepted_at',p.accepted_at,'deadline_at',p.deadline_at,'server_now',clock_timestamp(),
 'artifacts',coalesce((select jsonb_agg(jsonb_build_object('id',s.artifact_id,'export_id',s.export_id,'volume',s.volume,'status',coalesce(a.status,'pending'),'content_hash',a.content_hash,'expected_size',a.expected_size,'original_name',a.original_name,'mime_type',a.mime_type) order by s.volume) from public.export_package_volumes s left join public.export_artifacts a on a.id=s.artifact_id where s.package_id=p.id),'[]'),
 'job',(select jsonb_build_object('id',j.id,'status',j.status,'error_code',j.error_code,'next_attempt_at',j.next_attempt_at) from public.jobs j where j.id=p.current_job_id))
$$;
create function public.export_package_context(package_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare p public.export_packages;begin
 select * into p from public.export_packages where id=package_id;perform app_private.delivery_actor(p.workspace_id,auth.uid());
 perform app_private.expire_export_packages(p.workspace_id);select * into p from public.export_packages where id=package_id;
 perform app_private.check_export_package(p,auth.uid(),false);return app_private.export_package_metadata(p);
end $$;

-- All package commands run through the same authenticated command envelope.
alter function app_private.app_command(text,jsonb,text) rename to app_command_before_export_package;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid:=auth.uid();v public.proposal_versions;prop public.proposals;g public.generation_plans;p public.export_packages;r jsonb;gate jsonb;sources jsonb;manifest jsonb;identity text;digest text;replay app_private.idempotency_records;result jsonb;volume text;slot uuid;job uuid;accepted timestamptz;needed bigint;actor_role text;begin
 if operation not in ('export.package.prepare','export.package.retry') then return app_private.app_command_before_export_package(operation,input,idempotency_key);end if;
 if operation='export.package.prepare' then
  perform app_private.check_keys(input,array['proposal_version_id','expected_revision','mode']);
  select * into v from public.proposal_versions where id=(input->>'proposal_version_id')::uuid;w:=v.workspace_id;
 else perform app_private.check_keys(input,array['id','expected_revision']);select * into p from public.export_packages where id=(input->>'id')::uuid;w:=p.workspace_id;end if;
 perform app_private.delivery_actor(w,actor);perform 1 from public.workspaces where id=w for update;perform app_private.delivery_actor(w,actor);perform app_private.expire_export_packages(w);
 select role into actor_role from public.memberships where workspace_id=w and user_id=actor and active;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(input)>65536 then raise exception 'INVALID_INPUT';end if;
 digest:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records x where x.workspace_id=w and x.actor_id=actor and x.method='COMMAND' and x.route=operation and x.key=idempotency_key and x.expires_at>now();
 if replay.key is not null then
  if replay.body_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  select * into p from public.export_packages where id=(replay.result->>'id')::uuid;perform app_private.check_export_package(p,actor,false);return replay.result;
 end if;
 delete from app_private.idempotency_records x where x.workspace_id=w and x.actor_id=actor and x.method='COMMAND' and x.route=operation and x.key=idempotency_key and x.expires_at<=now();
 if operation='export.package.prepare' then
  select * into v from public.proposal_versions where id=(input->>'proposal_version_id')::uuid;
  if v.revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT';end if;
  if coalesce(input->>'mode','') not in ('draft','final') then raise exception 'INVALID_INPUT';end if;
  if input->>'mode'='final' and actor_role<>'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
  select * into prop from public.proposals where id=v.proposal_id;select * into g from public.generation_plans where id=v.plan_id;
  if g.id is null then raise exception 'GENERATION_CONTEXT_REQUIRED';end if;
  sources:=jsonb_build_array(g.frozen_context->'notice')||coalesce(g.frozen_context->'blocks','[]')||coalesce(g.frozen_context->'knowledge','[]')||coalesce(g.frozen_context->'reviews','[]')||coalesce(g.frozen_context->'rates','[]');
  select coalesce(jsonb_agg(ref order by ref::text),'[]') into manifest from(select distinct x->'reference' ref from jsonb_array_elements(sources) x where x ? 'reference') refs;
  gate:=app_private.approval_gate(w,v.id);
  identity:=encode(sha256(convert_to(jsonb_build_array(v.id,v.revision,input->>'mode','ordinary-2',gate-'blockers',manifest)::text,'UTF8')),'hex');
  select * into p from public.export_packages where workspace_id=w and proposal_version_id=v.id and mode=input->>'mode' and renderer_version='ordinary-2' and binding_hash=identity;
  if p.id is not null then
   perform app_private.check_export_package(p,actor,false);
   update public.export_requests set expires_at=clock_timestamp()+interval '15 minutes',revision=revision+1 where id in(select export_id from public.export_package_volumes where package_id=p.id);
  else
   needed:=10485760*(case when v.separate_volumes then 2 else 1 end);
   if app_private.storage_reserved_bytes(w)+needed>262144000 then raise exception 'STORAGE_CAP_REACHED';end if;
   accepted:=clock_timestamp();
   insert into public.export_packages(workspace_id,opportunity_id,proposal_id,proposal_version_id,version_revision,mode,binding_hash,source_manifest,input_materials,required_volumes,accepted_at,deadline_at,created_by)
   values(w,prop.opportunity_id,prop.id,v.id,v.revision,input->>'mode',identity,manifest,coalesce(g.frozen_context->'input_materials','{}'),case when v.separate_volumes then array['technical','financial'] else array['combined'] end,accepted,accepted+interval '600 seconds',actor) returning * into p;
   foreach volume in array p.required_volumes loop
    r:=app_private.app_command_before_export_package('export.prepare',jsonb_build_object('proposal_version_id',v.id,'expected_revision',v.revision,'mode',p.mode,'volume',volume),encode(sha256(convert_to('export-package:'||p.id::text||':'||volume,'UTF8')),'hex'));
    update public.export_requests set snapshot=snapshot||jsonb_build_object('export_renderer_version','ordinary-2') where id=(r->>'id')::uuid;
    slot:=gen_random_uuid();insert into public.export_package_volumes(id,workspace_id,package_id,export_id,volume,storage_key) values(slot,w,p.id,(r->>'id')::uuid,volume,w::text||'/exports/packages/'||p.id::text||'/'||slot::text||'.docx');
   end loop;
   perform app_private.check_export_package(p,actor);
   insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint) values(w,'render_export',p.id,p.binding_hash,'queued',actor,jsonb_build_object('model_executor',4,'minimum_worker_executor',4,'export_renderer_version','ordinary-2','export_accepted_at',p.accepted_at,'export_deadline_at',p.deadline_at,'export_attempt',1)) returning id into job;
   update public.export_packages set current_job_id=job where id=p.id returning * into p;
  end if;
 else
  select * into p from public.export_packages where id=(input->>'id')::uuid for update;
  perform app_private.check_export_package(p,actor,false);
  if p.mode='final' and actor_role<>'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
  if p.revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT';end if;
  if p.status<>'blocked' or exists(select 1 from public.jobs where id=p.current_job_id and ((status not in ('failed','blocked','canceled') and not(status='succeeded' and p.error_code in ('EXPORT_RESTORED_REVIEW_REQUIRED','EXPORT_PACKAGE_BYTES_UNAVAILABLE'))) or lease_token is not null)) then raise exception 'EXPORT_RETRY_NOT_ALLOWED';end if;
  update public.export_package_volumes s set artifact_id=null,revision=revision+1 where package_id=p.id and artifact_id is not null and not exists(select 1 from public.export_artifacts a where a.id=s.artifact_id and a.status='ready');
  select count(*)*10485760 into needed from public.export_package_volumes where package_id=p.id and artifact_id is null;
  if app_private.storage_reserved_bytes(w)+needed>262144000 then raise exception 'STORAGE_CAP_REACHED';end if;
  update public.export_package_volumes set storage_key=w::text||'/exports/packages/'||p.id::text||'/'||gen_random_uuid()::text||'/'||id::text||'.docx',reserved_bytes=10485760,revision=revision+1 where package_id=p.id and artifact_id is null;
  accepted:=clock_timestamp();
  insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint) values(w,'render_export',p.id,p.binding_hash,'queued',actor,jsonb_build_object('model_executor',4,'minimum_worker_executor',4,'export_renderer_version','ordinary-2','export_accepted_at',accepted,'export_deadline_at',accepted+interval '600 seconds','export_attempt',(select count(*)+1 from public.jobs where type='render_export' and entity_id=p.id))) returning id into job;
  update public.export_packages set current_job_id=job,status='preparing',error_code=null,accepted_at=accepted,deadline_at=accepted+interval '600 seconds',revision=revision+1,updated_at=now() where id=p.id returning * into p;
  update public.export_requests set expires_at=accepted+interval '15 minutes',revision=revision+1 where id in(select export_id from public.export_package_volumes where package_id=p.id);
 end if;
 result:=app_private.export_package_metadata(p);
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,digest,result);
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(w,actor,operation,'export_package',p.id,jsonb_build_object('version_id',p.proposal_version_id,'mode',p.mode,'job_id',p.current_job_id,'binding_hash',p.binding_hash,'deadline_at',p.deadline_at));
 return result;
end $$;

create function app_private.export_package_job(job_id uuid,lease uuid,check_sources boolean default true) returns public.jobs language plpgsql security definer set search_path='' as $$
declare j public.jobs;p public.export_packages;actor_role text;begin
 select * into j from public.jobs where id=job_id;perform 1 from public.workspaces where id=j.workspace_id for update;select * into j from public.jobs where id=job_id for update;
 if j.id is null or j.type<>'render_export' or j.status<>'running' or lease is null or j.lease_token is distinct from lease or j.lease_until is null or j.lease_until<=clock_timestamp() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 select * into p from public.export_packages where workspace_id=j.workspace_id and id=j.entity_id;
 if p.id is null or p.current_job_id is distinct from j.id or j.input_hash<>p.binding_hash or j.checkpoint->>'export_renderer_version'<>'ordinary-2' then raise exception 'EXPORT_PACKAGE_INVALID';end if;
 if check_sources then
  if p.deadline_at<=clock_timestamp() or p.status<>'preparing' then raise exception 'EXPORT_ISSUANCE_TIMEOUT';end if;
  perform app_private.delivery_actor(p.workspace_id,j.created_by);perform app_private.check_export_package(p,j.created_by);
  select role into actor_role from public.memberships where workspace_id=p.workspace_id and user_id=j.created_by and active;
  if p.mode='final' and actor_role<>'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 end if;return j;
end $$;
create function public.export_render_context(job_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;p public.export_packages;volumes jsonb;begin
 j:=app_private.export_package_job(job_id,lease);select * into p from public.export_packages where id=j.entity_id;
 select jsonb_agg(to_jsonb(s)||jsonb_build_object('request',to_jsonb(r),'artifact',case when a.id is null then null else to_jsonb(a) end) order by s.volume) into volumes
 from public.export_package_volumes s join public.export_requests r on r.workspace_id=s.workspace_id and r.id=s.export_id left join public.export_artifacts a on a.workspace_id=s.workspace_id and a.id=s.artifact_id where s.package_id=p.id;
 return jsonb_build_object('package',to_jsonb(p),'volumes',volumes,'renderer_version',p.renderer_version,'server_now',clock_timestamp());
end $$;
create function public.complete_export_package_volume(job_id uuid,lease uuid,slot_id uuid,actual_hash text,actual_size bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;p public.export_packages;s public.export_package_volumes;r public.export_requests;a public.export_artifacts;begin
 j:=app_private.export_package_job(job_id,lease);select * into p from public.export_packages where id=j.entity_id;
 select * into s from public.export_package_volumes where workspace_id=j.workspace_id and id=slot_id and package_id=p.id for update;
 if s.id is null or actual_hash is null or actual_hash!~'^[a-f0-9]{64}$' or actual_size is null or actual_size not between 1 and 10485760 then raise exception 'ARTIFACT_MISMATCH';end if;
 if s.artifact_id is not null then
  select * into a from public.export_artifacts where id=s.artifact_id and workspace_id=j.workspace_id;
  if a.status<>'ready' or a.storage_key<>s.storage_key or a.content_hash<>actual_hash or a.expected_size<>actual_size then raise exception 'ARTIFACT_MISMATCH';end if;return to_jsonb(a);
 end if;
 if s.reserved_bytes<>10485760 then raise exception 'EXPORT_RESERVATION_REQUIRED';end if;
 select * into r from public.export_requests where id=s.export_id;
 -- This transfers accounting after independently verified readback; no fake
 -- expected hash/size is persisted before the actual immutable bytes exist.
 update public.export_package_volumes set reserved_bytes=0 where id=s.id;
 if app_private.storage_reserved_bytes(j.workspace_id)+actual_size>262144000 then raise exception 'STORAGE_CAP_REACHED';end if;
 insert into public.export_artifacts(workspace_id,export_id,kind,original_name,mime_type,expected_size,content_hash,storage_key,status,verification,created_by,verified_at)
 values(j.workspace_id,r.id,'generated','proposal_v'||(r.snapshot->>'ordinal')||'_'||r.volume||'_'||r.mode||'.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',actual_size,actual_hash,s.storage_key,'ready','generated_content',j.created_by,clock_timestamp()) returning * into a;
 if p.deadline_at<=clock_timestamp() then raise exception 'EXPORT_ISSUANCE_TIMEOUT';end if;
 update public.export_package_volumes set artifact_id=a.id,revision=revision+1 where id=s.id;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(j.workspace_id,j.created_by,'export.completed','export_artifact',a.id,jsonb_build_object('package_id',p.id,'hash',actual_hash,'version_id',r.proposal_version_id,'mode',r.mode,'verification','generated_content'));
 return to_jsonb(a);
end $$;
create function public.finish_export_package(job_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare j public.jobs;p public.export_packages;begin
 j:=app_private.export_package_job(job_id,lease);select * into p from public.export_packages where id=j.entity_id for update;
 if exists(select 1 from public.export_package_volumes s left join public.export_artifacts a on a.id=s.artifact_id where s.package_id=p.id and (a.id is null or a.status<>'ready' or a.storage_key<>s.storage_key)) then raise exception 'EXPORT_PACKAGE_INCOMPLETE';end if;
 if p.deadline_at<=clock_timestamp() then raise exception 'EXPORT_ISSUANCE_TIMEOUT';end if;
 update public.jobs set status='succeeded',lease_token=null,lease_until=null,error_code=null,revision=revision+1,updated_at=now() where id=j.id;
 update public.export_packages set status='ready',error_code=null,revision=revision+1,updated_at=now() where id=p.id returning * into p;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(j.workspace_id,j.created_by,'export.package.completed','export_package',p.id,jsonb_build_object('job_id',j.id,'mode',p.mode,'binding_hash',p.binding_hash));
 return app_private.export_package_metadata(p);
end $$;
create function public.fail_export_package(job_id uuid,lease uuid,error_code text) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;p public.export_packages;retry boolean;code text;begin
 select * into j from public.jobs where id=job_id;perform 1 from public.workspaces where id=j.workspace_id for update;select * into j from public.jobs where id=job_id for update;select * into p from public.export_packages where id=j.entity_id;
 if p.id is not null and p.status='blocked' and p.current_job_id=j.id and j.status in ('failed','blocked','canceled') then return app_private.export_package_metadata(p);end if;
 j:=app_private.export_package_job(job_id,lease,false);
 if error_code is null or error_code!~'^[A-Z][A-Z0-9_]{0,119}$' then raise exception 'INVALID_INPUT';end if;
 code:=case when p.deadline_at<=clock_timestamp() then 'EXPORT_ISSUANCE_TIMEOUT' else error_code end;
 retry:=code in ('DELIVERY_RENDER_TIMEOUT','DELIVERY_STORAGE_UNAVAILABLE','DELIVERY_RENDER_FAILED') and j.failure_count<5 and p.deadline_at>clock_timestamp()+interval '2 seconds';
 update public.jobs set status=case when retry then 'retry_wait' else 'failed' end,error_code=code,failure_count=failure_count+1,lease_token=null,lease_until=null,next_attempt_at=case when retry then clock_timestamp()+interval '1 second' else 'infinity' end,revision=revision+1,updated_at=now() where id=j.id;
 update public.export_packages set status=case when retry then 'preparing' else 'blocked' end,error_code=code,revision=revision+1,updated_at=now() where id=p.id returning * into p;
 if not retry then perform app_private.release_export_package_slots(p.id);end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(j.workspace_id,j.created_by,'export.package.failed','export_package',p.id,jsonb_build_object('job_id',j.id,'error_code',code,'retrying',retry));return app_private.export_package_metadata(p);
end $$;

create function app_private.check_export_package_download(artifact uuid,actor uuid) returns void language plpgsql security definer set search_path='' as $$declare p public.export_packages;begin
 select pack.* into p from public.export_packages pack join public.export_package_volumes s on s.package_id=pack.id where s.artifact_id=artifact;
 if p.id is null then return;end if;
 perform app_private.check_export_package(p,actor);
 if p.status<>'ready' or not exists(select 1 from public.jobs where id=p.current_job_id and status='succeeded') or exists(select 1 from public.export_package_volumes s left join public.export_artifacts a on a.id=s.artifact_id where s.package_id=p.id and (a.id is null or a.status<>'ready' or a.storage_key<>s.storage_key)) then raise exception 'EXPORT_PACKAGE_INCOMPLETE';end if;
end $$;
alter function public.artifact_context(uuid) rename to artifact_context_before_export_package;
create function public.artifact_context(artifact_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare result jsonb;p public.export_packages;begin
 result:=public.artifact_context_before_export_package(artifact_id);perform app_private.check_export_package_download(artifact_id,auth.uid());
 select pack.* into p from public.export_packages pack join public.export_package_volumes s on s.package_id=pack.id where s.artifact_id=$1;
 if p.id is not null then result:=result||jsonb_build_object('package',jsonb_build_object('id',p.id,'revision',p.revision));end if;return result;
end $$;
alter function public.authorize_artifact_download(uuid,uuid,text) rename to authorize_artifact_download_before_export_package;
create function public.authorize_artifact_download(artifact_id uuid,actor_id uuid,actual_hash text) returns jsonb language plpgsql security definer set search_path='' as $$declare w uuid;begin
 select workspace_id into w from public.export_artifacts where id=artifact_id;
 -- Currentness must be checked after any workspace-lock wait, not before the
 -- legacy delegate acquires that lock. The lock remains held through its check.
 perform 1 from public.workspaces where id=w for update;
 perform app_private.check_export_package_download(artifact_id,actor_id);return public.authorize_artifact_download_before_export_package(artifact_id,actor_id,actual_hash);
end $$;

-- Definitive service-observed absence or byte mismatch invalidates only the
-- exact current package artifact. Transient storage errors never enter here.
create function public.report_export_package_artifact_failure(artifact_id uuid,actor_id uuid,package_id uuid,expected_revision integer,expected_hash text,expected_storage_key text,error_code text,actual_size bigint default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.export_packages;s public.export_package_volumes;a public.export_artifacts;begin
 select * into p from public.export_packages where id=package_id;
 perform app_private.delivery_actor(p.workspace_id,actor_id);perform 1 from public.workspaces where id=p.workspace_id for update;
 select * into p from public.export_packages where id=package_id for update;
 perform app_private.check_export_package(p,actor_id);
 if error_code not in ('EXPORT_ARTIFACT_MISSING','ARTIFACT_MISMATCH') or expected_hash is null or expected_hash!~'^[a-f0-9]{64}$' or expected_storage_key is null or expected_revision is null
 or (error_code='EXPORT_ARTIFACT_MISSING' and actual_size is not null) or (error_code='ARTIFACT_MISMATCH' and (actual_size is null or actual_size<0)) then raise exception 'INVALID_INPUT';end if;
 select * into s from public.export_package_volumes where export_package_volumes.package_id=p.id and export_package_volumes.artifact_id=$1;
 select * into a from public.export_artifacts where id=artifact_id and workspace_id=p.workspace_id;
 if p.status<>'ready' or p.revision<>expected_revision or s.id is null or a.status<>'ready' or a.content_hash is distinct from expected_hash or a.storage_key is distinct from expected_storage_key or s.storage_key is distinct from expected_storage_key then return jsonb_build_object('invalidated',false);end if;
 update public.export_artifacts set status='expired',revision=revision+1 where id=a.id;
 if error_code='ARTIFACT_MISMATCH' then
  insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values(p.workspace_id,a.storage_key,greatest(a.expected_size,actual_size),'invalid_export_package_bytes') on conflict(storage_key) do nothing;
 end if;
 update public.export_packages set status='blocked',error_code='EXPORT_PACKAGE_BYTES_UNAVAILABLE',revision=revision+1,updated_at=now() where id=p.id;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(p.workspace_id,actor_id,'export.package.artifact_invalidated','export_artifact',a.id,jsonb_build_object('package_id',p.id,'expected_hash',expected_hash,'error_code',error_code,'actual_size',actual_size));
 return jsonb_build_object('invalidated',true);
end $$;

-- Calendar request counts do not substitute for actual atomic capacity checks.
do $$declare f record;definition text;marker text:='if (select count(*) from public.export_requests where workspace_id=w and created_at>now()-interval ''1 day'')>=100 then raise exception ''EXPORT_DAILY_CAP_REACHED'';end if;';n integer:=0;begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.prokind='f' loop
  definition:=pg_get_functiondef(f.oid);if position(marker in definition)>0 then execute replace(definition,marker,'');n:=n+1;end if;
 end loop;if n<>1 then raise exception 'EXPORT_PACKAGE_CALENDAR_CAP_CHANGED';end if;
end $$;

-- Additive executor-4 local work, bounded lease recovery, and independent
-- request expiration. Old workers cannot claim the new renderer protocol.
do $$declare definition text;marker text;begin
 select pg_get_constraintdef(oid) into definition from pg_constraint where conrelid='public.jobs'::regclass and conname='jobs_type_check';
 if position('ARRAY[' in definition)=0 then raise exception 'EXPORT_PACKAGE_JOB_TYPES_CHANGED';end if;
 alter table public.jobs drop constraint jobs_type_check;execute 'alter table public.jobs add constraint jobs_type_check '||replace(definition,'ARRAY[','ARRAY[''render_export''::text,');
 select pg_get_functiondef('app_private.queue_work_class(public.jobs)'::regprocedure) into definition;
 marker:='j.type=''prepare_generated_delivery''';if position(marker in definition)=0 then raise exception 'EXPORT_PACKAGE_WORK_CLASS_CHANGED';end if;
 execute replace(definition,marker,'j.type in (''prepare_generated_delivery'',''render_export'')');
 select pg_get_functiondef('public.claim_backend_job()'::regprocedure) into definition;
 marker:='type in (''render_delivery'',''prepare_generated_delivery'')';if position(marker in definition)=0 then raise exception 'EXPORT_PACKAGE_LEASE_RECOVERY_CHANGED';end if;
 definition:=replace(definition,marker,'type in (''render_delivery'',''prepare_generated_delivery'',''render_export'')');
 marker:='j.id:=app_private.next_fair_job';if position(marker in definition)=0 then raise exception 'EXPORT_PACKAGE_DEADLINE_CLAIM_CHANGED';end if;
 execute replace(definition,marker,'perform app_private.expire_export_packages(w); '||marker);
 select pg_get_functiondef('app_private.recover_processing_job(uuid,timestamptz)'::regprocedure) into definition;
 marker:='j.type in (''render_delivery'',''prepare_generated_delivery'')';if position(marker in definition)=0 then raise exception 'EXPORT_PACKAGE_MODEL_RECOVERY_CHANGED';end if;
 execute replace(definition,marker,'j.type in (''render_delivery'',''prepare_generated_delivery'',''render_export'')');
end $$;

alter function app_private.backup_tables() rename to backup_tables_before_export_packages;
create function app_private.backup_tables() returns text[] language sql immutable set search_path='' as $$select app_private.backup_tables_before_export_packages()||array['export_packages','export_package_volumes']::text[]$$;
alter function app_private.purge_scope(uuid,uuid) rename to purge_scope_before_export_packages;
create function app_private.purge_scope(w uuid,opp uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$declare result jsonb;part jsonb;t text;begin
 result:=app_private.purge_scope_before_export_packages(w,opp);
 foreach t in array array['export_packages','export_package_volumes'] loop
  execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(x.id order by x.id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by x.id),''''),''UTF8'')),''hex'')) from public.%I x where x.workspace_id=$1 and %s',t,case when t='export_packages' then 'x.opportunity_id=$2' else 'x.package_id in(select id from public.export_packages where workspace_id=$1 and opportunity_id=$2)' end) into part using w,opp;
  result:=result||jsonb_build_object(t,part);
 end loop;
 select jsonb_build_object('ids',coalesce(jsonb_agg(j.id order by j.id),'[]'),'hash',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(j)::text,',' order by j.id),''),'UTF8')),'hex')) into part from public.jobs j
 where j.workspace_id=w and (j.id in(select value::uuid from jsonb_array_elements_text(result#>'{jobs,ids}')) or (j.type='render_export' and j.entity_id in(select id from public.export_packages where workspace_id=w and opportunity_id=opp)));
 return result||jsonb_build_object('jobs',part);
end $$;
do $$declare definition text;marker text;begin
 select pg_get_functiondef('public.commit_workspace_restore(uuid)'::regprocedure) into definition;
 marker:='elsif t=''export_artifacts'' then';if position(marker in definition)=0 then raise exception 'EXPORT_PACKAGE_RESTORE_CHANGED';end if;
 execute replace(definition,marker,$new$elsif t='export_packages' then
 data:=data||jsonb_build_object('status','blocked','error_code','EXPORT_RESTORED_REVIEW_REQUIRED');
 elsif t='export_package_volumes' then
 data:=data||jsonb_build_object('reserved_bytes',0,'storage_key',coalesce((select a.storage_key from public.export_artifacts a where a.workspace_id=s.workspace_id and a.id=(data->>'artifact_id')::uuid),s.workspace_id::text||'/unavailable/export-package/'||(data->>'id')));
 $new$||marker);
 select pg_get_functiondef('public.preview_opportunity_purge(uuid)'::regprocedure) into definition;
 marker:='scope->''proposal_delivery_artifacts''->''ids''))) x;';if position(marker in definition)=0 then raise exception 'EXPORT_PACKAGE_PURGE_PREVIEW_CHANGED';end if;
 execute replace(definition,marker,$new$scope->'proposal_delivery_artifacts'->'ids')) union all
 select jsonb_build_object('id',id,'name','Unconfirmed export package upload','size',reserved_bytes,'hash',null) from public.export_package_volumes
 where reserved_bytes>0 and artifact_id is null and id in(select value::uuid from jsonb_array_elements_text(scope->'export_package_volumes'->'ids'))) x;$new$);
 select pg_get_functiondef('public.purge_opportunity(uuid,text,text,text,boolean)'::regprocedure) into definition;
 marker:='scope->''proposal_delivery_artifacts''->''ids'')) on conflict(storage_key) do nothing;';if position(marker in definition)=0 then raise exception 'EXPORT_PACKAGE_PURGE_CLEANUP_CHANGED';end if;
 execute replace(definition,marker,$new$scope->'proposal_delivery_artifacts'->'ids')) union all
 select w,storage_key,reserved_bytes,'owner_confirmed_purge' from public.export_package_volumes where reserved_bytes>0 and artifact_id is null
 and id in(select value::uuid from jsonb_array_elements_text(scope->'export_package_volumes'->'ids')) on conflict(storage_key) do nothing;$new$);
 select pg_get_functiondef('public.archive_opportunity(uuid,integer,boolean,text)'::regprocedure) into definition;
 marker:='entity_id in(select gp.id from public.generation_plans gp where gp.opportunity_id=o.id)';if position(marker in definition)=0 then raise exception 'EXPORT_PACKAGE_ARCHIVE_CHANGED';end if;
 execute replace(definition,marker,'('||marker||' or (type=''render_export'' and entity_id in(select pack.id from public.export_packages pack where pack.opportunity_id=o.id)))');
 select pg_get_functiondef('public.claim_storage_cleanup()'::regprocedure) into definition;
 marker:='where workspace_id=w and status=''pending'' order by created_at';if position(marker in definition)=0 then raise exception 'EXPORT_PACKAGE_CLEANUP_DEFER_CHANGED';end if;
 definition:=replace(definition,marker,'where workspace_id=w and status=''pending'' and eligible_at<=clock_timestamp() order by created_at');
 marker:='exists(select 1 from public.documents where storage_key=r.storage_key';if position(marker in definition)=0 then raise exception 'EXPORT_PACKAGE_CLEANUP_REFERENCE_CHANGED';end if;
 execute replace(definition,marker,'exists(select 1 from public.export_package_volumes where storage_key=r.storage_key and reserved_bytes>0) or exists(select 1 from public.documents where storage_key=r.storage_key');
 select pg_get_functiondef('public.maintenance_tick()'::regprocedure) into definition;
 -- Existing maintenance may be a deadline wrapper. Expiration is also in claim;
 -- invoke our independent package expiry in the public maintenance entry point.
end $$;
alter function public.maintenance_tick() rename to maintenance_tick_before_export_packages;
create function public.maintenance_tick() returns jsonb language plpgsql security definer set search_path='' as $$declare expired integer;result jsonb;begin expired:=app_private.expire_export_packages();result:=public.maintenance_tick_before_export_packages();return result||jsonb_build_object('expired_export_packages',expired);end $$;

-- New public tables are member-readable only through their RPC metadata. The
-- canonical API computes actor identity; arbitrary browser UUIDs grant no access.
do $$declare t text;r text;signature text;begin
 foreach t in array array['export_packages','export_package_volumes'] loop
  execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public',t);
  foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop if exists(select 1 from pg_roles where rolname=r) then
   execute format('revoke all on public.%I from %I',t,r);if r in ('service_role','tdp_app_service') then execute format('grant all on public.%I to %I',t,r);end if;
  end if;end loop;
 end loop;
 foreach signature in array array[
 'app_private.guard_packaged_export_request()','app_private.guard_export_package_identity()','app_private.storage_reserved_bytes_before_export_packages(uuid)','app_private.storage_reserved_bytes(uuid)','app_private.check_export_package(public.export_packages,uuid,boolean)',
 'app_private.release_export_package_slots(uuid)','app_private.expire_export_packages(uuid)','app_private.export_package_metadata(public.export_packages)',
 'app_private.app_command_before_export_package(text,jsonb,text)','app_private.app_command(text,jsonb,text)','app_private.export_package_job(uuid,uuid,boolean)',
 'app_private.check_export_package_download(uuid,uuid)','app_private.backup_tables_before_export_packages()','app_private.backup_tables()','app_private.purge_scope_before_export_packages(uuid,uuid)','app_private.purge_scope(uuid,uuid)',
 'public.export_package_context(uuid)','public.export_render_context(uuid,uuid)','public.complete_export_package_volume(uuid,uuid,uuid,text,bigint)','public.finish_export_package(uuid,uuid)','public.fail_export_package(uuid,uuid,text)',
 'public.report_export_package_artifact_failure(uuid,uuid,uuid,integer,text,text,text,bigint)','public.artifact_context_before_export_package(uuid)','public.artifact_context(uuid)','public.authorize_artifact_download_before_export_package(uuid,uuid,text)','public.authorize_artifact_download(uuid,uuid,text)',
 'public.maintenance_tick_before_export_packages()','public.maintenance_tick()'] loop
  execute 'revoke all on function '||signature||' from public';
  foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop if exists(select 1 from pg_roles where rolname=r) then execute 'revoke all on function '||signature||' from '||quote_ident(r);end if;end loop;
 end loop;
 foreach r in array array['authenticated','tdp_app_authenticated'] loop if exists(select 1 from pg_roles where rolname=r) then execute 'grant execute on function app_private.app_command(text,jsonb,text),public.export_package_context(uuid),public.artifact_context(uuid) to '||quote_ident(r);end if;end loop;
 foreach r in array array['service_role','tdp_app_service'] loop if exists(select 1 from pg_roles where rolname=r) then execute 'grant execute on function public.export_render_context(uuid,uuid),public.complete_export_package_volume(uuid,uuid,uuid,text,bigint),public.finish_export_package(uuid,uuid),public.fail_export_package(uuid,uuid,text),public.authorize_artifact_download(uuid,uuid,text),public.report_export_package_artifact_failure(uuid,uuid,uuid,integer,text,text,text,bigint),public.maintenance_tick() to '||quote_ident(r);end if;end loop;
end $$;
