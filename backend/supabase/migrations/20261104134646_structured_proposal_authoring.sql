-- Authorized structured response authoring. No provider reservation, inferred
-- staffing, automatic commercial approval or legacy-assurance upgrade.
create table public.proposal_authoring_sessions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,
 opportunity_id uuid not null,proposal_id uuid not null,base_snapshot_id uuid not null,
 predecessor_id uuid,current_revision_id uuid,responsible_actor_id uuid,expected_delivery_revision integer not null check(expected_delivery_revision>=0),
 source_change_reason text,revision integer not null default 1 check(revision>0),
 created_by uuid not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),
 foreign key(workspace_id) references public.workspaces(id) deferrable initially immediate,
 foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,proposal_id) references public.proposals(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,base_snapshot_id) references public.proposal_delivery_snapshots(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,predecessor_id) references public.proposal_authoring_sessions(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,created_by) references public.workspace_actors(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,responsible_actor_id) references public.workspace_actors(workspace_id,id) deferrable initially immediate
);
create table public.proposal_authoring_revisions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,session_id uuid not null,
 ordinal integer not null check(ordinal>0),body jsonb not null check(jsonb_typeof(body)='object' and pg_column_size(body)<=2097152),
 body_hash text not null check(body_hash=encode(sha256(convert_to(body::text,'UTF8')),'hex')),
 predecessor_revision_id uuid,created_by uuid not null,created_at timestamptz not null default now(),
 revision integer not null default 1 check(revision=1),unique(workspace_id,id),unique(workspace_id,session_id,ordinal),
 foreign key(workspace_id,session_id) references public.proposal_authoring_sessions(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,predecessor_revision_id) references public.proposal_authoring_revisions(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,created_by) references public.workspace_actors(workspace_id,id) deferrable initially immediate
);
alter table public.proposal_authoring_sessions add foreign key(workspace_id,current_revision_id) references public.proposal_authoring_revisions(workspace_id,id) deferrable initially immediate;
create table public.proposal_authoring_reviews (
 id uuid primary key,workspace_id uuid not null,session_id uuid not null,authoring_revision_id uuid not null,
 context_hash text not null,reviewed_input_hash text not null,review jsonb not null,report jsonb not null,
 snapshot_id uuid not null,created_by uuid not null,created_at timestamptz not null default now(),revision integer not null default 1 check(revision=1),
 unique(workspace_id,id),
 foreign key(workspace_id,session_id) references public.proposal_authoring_sessions(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,authoring_revision_id) references public.proposal_authoring_revisions(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,snapshot_id) references public.proposal_delivery_snapshots(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,created_by) references public.workspace_actors(workspace_id,id) deferrable initially immediate,
 check(reviewed_input_hash ~ '^[a-f0-9]{64}$' and report->>'input_hash'=reviewed_input_hash)
);
create index authoring_proposal on public.proposal_authoring_sessions(workspace_id,proposal_id);
create index authoring_base on public.proposal_authoring_sessions(workspace_id,base_snapshot_id);
create index authoring_reviews_session on public.proposal_authoring_reviews(workspace_id,session_id);
create trigger authoring_revision_immutable before update on public.proposal_authoring_revisions for each row execute function app_private.delivery_snapshot_immutable();
create trigger authoring_review_immutable before update on public.proposal_authoring_reviews for each row execute function app_private.delivery_snapshot_immutable();
do $$declare t text;role_name text;begin foreach t in array array['proposal_authoring_sessions','proposal_authoring_revisions','proposal_authoring_reviews'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public',t);
 foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop if exists(select 1 from pg_roles where rolname=role_name) then
 execute format('revoke all on public.%I from %I',t,role_name);
 if role_name in ('service_role','tdp_app_service') then execute format('grant all on public.%I to %I',t,role_name);end if;end if;end loop;
 end loop;end $$;

-- New authoring requires current extraction leaves. Historical draft reads keep
-- their original source pins and are deliberately unaffected by this check.
create function app_private.check_authoring_sources(s public.proposal_delivery_snapshots,actor uuid) returns void
language plpgsql stable security definer set search_path='' as $$declare ref jsonb;leaf uuid;current_input jsonb;current_documents jsonb;saved_documents jsonb;begin
 perform app_private.check_delivery_snapshot(s,actor);perform app_private.delivery_actor(s.workspace_id,actor,true);
 current_input:=app_private.delivery_input(s.workspace_id,s.opportunity_id);
 select coalesce(jsonb_agg(x->>'document_id' order by x->>'document_id'),'[]') into current_documents from jsonb_array_elements(current_input#>'{input_materials,documents}') x;
 select coalesce(jsonb_agg(x->>'document_id' order by x->>'document_id'),'[]') into saved_documents from jsonb_array_elements(coalesce(s.payload#>'{input_materials,documents}','[]')) x;
 if current_documents is distinct from saved_documents then raise exception 'AUTHORING_SOURCE_CHANGED';end if;
 for ref in select value from jsonb_array_elements(s.source_manifest) loop
  if ref->>'entity_kind'='document' and to_regprocedure('app_private.current_document_extraction(uuid,uuid)') is not null then
   execute 'select app_private.current_document_extraction($1,$2)' into leaf using s.workspace_id,(ref->>'entity_id')::uuid;
   if leaf is distinct from (ref->>'entity_id')::uuid then raise exception 'AUTHORING_SOURCE_CHANGED';end if;
  end if;
 end loop;
end $$;
create function app_private.authoring_context(session_id uuid,actor_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a public.proposal_authoring_sessions;r public.proposal_authoring_revisions;s public.proposal_delivery_snapshots;req jsonb;requirements jsonb;sources jsonb:='[]';span jsonb;ref jsonb;body jsonb;manifest jsonb;reuse jsonb;k public.knowledge_items;record jsonb;catalog jsonb;missing jsonb:='[]';entry jsonb;begin
 select * into a from public.proposal_authoring_sessions where id=session_id;
 if a.id is null then raise exception 'NOT_FOUND';end if;
 select * into s from public.proposal_delivery_snapshots where workspace_id=a.workspace_id and id=a.base_snapshot_id;
 perform app_private.check_authoring_sources(s,actor_id);
 if a.source_change_reason is not null then raise exception 'AUTHORING_SOURCE_CHANGED';end if;
 select * into r from public.proposal_authoring_revisions where workspace_id=a.workspace_id and id=a.current_revision_id;
 body:=r.body;manifest:=s.source_manifest;
 for reuse in select value from jsonb_array_elements(body->'reuse') loop
  select * into k from public.knowledge_items where workspace_id=a.workspace_id and id=(reuse->>'source_id')::uuid and enabled and verified and (expiry_date is null or expiry_date>=current_date);
  record:=app_private.content_record(a.workspace_id,'knowledge',k.id);
  if k.id is null or record->>'content_hash' is distinct from reuse->>'content_hash' or position(reuse->>'quote' in record->>'content')=0 then raise exception 'AUTHORING_REUSE_UNVERIFIED';end if;
  ref:=jsonb_build_object('entity_kind','knowledge','entity_id',k.id,'content_hash',record->>'content_hash');
  if not manifest @> jsonb_build_array(ref) then manifest:=manifest||jsonb_build_array(ref);end if;
  sources:=sources||jsonb_build_array(jsonb_build_object('id',k.id,'text',record->>'content','reference',ref,'verified',true,'kind','knowledge'));
 end loop;
 if jsonb_array_length(body->'requirements')>0 then
  requirements:=app_private.source_obligation_inventory(a.workspace_id,a.opportunity_id,array(select (value->>'id')::uuid from jsonb_array_elements(body->'requirements')));
  if requirements is distinct from body->'requirements' then raise exception 'SOURCE_SEMANTICS_STALE';end if;
  for req in select value from jsonb_array_elements(requirements) loop
   if not app_private.check_source_semantics(a.workspace_id,req->'source_semantics',req->'source_refs') then raise exception 'SOURCE_SEMANTICS_STALE';end if;
   for span in select value from jsonb_array_elements((select rr.spans from public.source_obligation_reviews rr where rr.workspace_id=a.workspace_id and rr.review_id=(req->>'id')::uuid order by rr.revision desc limit 1)) loop
    ref:=jsonb_build_object('entity_kind',span->>'entity_kind','entity_id',span->>'entity_id','content_hash',span->>'content_hash');
    if not s.source_manifest @> jsonb_build_array(ref) then raise exception 'AUTHORING_SOURCE_OUT_OF_SCOPE';end if;
    sources:=sources||jsonb_build_array(jsonb_build_object('id',span->>'id','text',span->>'quote','reference',ref));
   end loop;
  end loop;
 end if;
 catalog:=app_private.source_review_evidence(a.workspace_id,a.opportunity_id,app_private.source_review_sources(a.workspace_id,a.opportunity_id));
 for entry in select value from jsonb_array_elements(catalog->'reviews') loop
  req:=app_private.source_obligation_inventory(a.workspace_id,a.opportunity_id,array[(entry->>'id')::uuid])->0;
  if req->>'mandatory'='true' and not exists(select 1 from jsonb_array_elements(body->'requirements') x where x->>'id'=req->>'id') then missing:=missing||jsonb_build_array(req->>'id');end if;
 end loop;
 return jsonb_build_object('inventory_missing_ids',missing,'session',to_jsonb(a),'revision',to_jsonb(r),'snapshot',to_jsonb(s),'sources',sources,'source_manifest',manifest,
  'context_hash',encode(sha256(convert_to(jsonb_build_object('revision',r.body_hash,'session_revision',a.revision,'snapshot',s.content_hash)::text,'UTF8')),'hex'));
end $$;
create function public.proposal_authoring_context(session_id uuid,actor_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$select app_private.authoring_context(session_id,actor_id)$$;

-- All mutations use an authenticated API actor, a serialized workspace lock,
-- exact optimistic revision and an idempotency receipt. No browser grants a role.
create function public.proposal_authoring_command(actor_id uuid,operation text,input jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w uuid;a public.proposal_authoring_sessions;r public.proposal_authoring_revisions;s public.proposal_delivery_snapshots;p public.proposals;
 prior public.proposal_authoring_sessions;old_r public.proposal_authoring_revisions;body jsonb;required jsonb;reuse jsonb;k public.knowledge_items;
 digest text;replay app_private.idempotency_records;result jsonb;nextordinal integer;
begin
 if operation not in ('open','save','claim','refresh') then raise exception 'INVALID_INPUT';end if;
 if operation='open' then select * into s from public.proposal_delivery_snapshots where id=(input->>'snapshot_id')::uuid;w:=s.workspace_id;
 else select * into a from public.proposal_authoring_sessions where id=(input->>'session_id')::uuid;w:=a.workspace_id;end if;
 if w is null then raise exception 'NOT_FOUND';end if;
 perform app_private.delivery_actor(w,actor_id,true);perform 1 from public.workspaces where id=w for update;perform app_private.delivery_actor(w,actor_id,true);
 if exists(select 1 from public.restore_sessions where workspace_id=w and state in ('staging','committing')) then raise exception 'RESTORE_IN_PROGRESS';end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(input)>2097152 then raise exception 'INVALID_INPUT';end if;
 digest:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=w and idempotency_records.actor_id=proposal_authoring_command.actor_id and method='COMMAND' and route='proposal.authoring.'||operation and key=idempotency_key and expires_at>now();
 if replay.key is not null then
  if replay.body_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  perform app_private.authoring_context((replay.result#>>'{session,id}')::uuid,actor_id);return replay.result;
 end if;
 if operation in ('open','refresh') then
  if operation='open' then
   perform app_private.check_keys(input,array['snapshot_id','expected_delivery_revision']);
   select * into p from public.proposals where workspace_id=w and id=s.proposal_id for update;
   if p.active_delivery_snapshot_id is distinct from s.id or p.delivery_revision is distinct from (input->>'expected_delivery_revision')::int then raise exception 'REVISION_CONFLICT';end if;
   -- Reopening the same current source does not discard saved work.
   select * into a from public.proposal_authoring_sessions where workspace_id=w and (base_snapshot_id=s.id or id::text=s.payload#>>'{authoring,session_id}') and source_change_reason is null order by created_at desc,id desc limit 1;
  else
   perform app_private.check_keys(input,array['session_id','expected_revision','expected_delivery_revision']);
   select * into prior from public.proposal_authoring_sessions where id=a.id for update;
   if prior.revision is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
   select * into p from public.proposals where workspace_id=w and id=prior.proposal_id for update;
   if p.delivery_revision is distinct from (input->>'expected_delivery_revision')::int then raise exception 'REVISION_CONFLICT';end if;
   s:=app_private.publish_delivery_snapshot(p.id,null,actor_id);
   select * into old_r from public.proposal_authoring_revisions where id=prior.current_revision_id;
   a:=null;
  end if;
  perform app_private.check_authoring_sources(s,actor_id);
  if a.id is null then
   insert into public.proposal_authoring_sessions(workspace_id,opportunity_id,proposal_id,base_snapshot_id,predecessor_id,expected_delivery_revision,created_by)
   values(w,s.opportunity_id,s.proposal_id,s.id,prior.id,(select delivery_revision from public.proposals where id=s.proposal_id),actor_id) returning * into a;
   body:=jsonb_build_object('version',1,'requirements','[]'::jsonb,'sections','[]'::jsonb,'fulfillment','[]'::jsonb,'confirmed_shared_decisions','[]'::jsonb,'pending_inputs','[]'::jsonb,'reuse','[]'::jsonb);
   if old_r.id is null and exists(select 1 from jsonb_array_elements(s.payload->'sections') x where x->>'kind'='accepted_unit') then
    body:=body||jsonb_build_object('sections',(select coalesce(jsonb_agg(jsonb_build_object('key',x->>'section_key','title',x->>'title','volume',x->>'volume','content_blocks',(select jsonb_agg(b) from jsonb_array_elements(x->'content_blocks') b where b->>'type'<>'placeholder'),'requirement_ids','[]'::jsonb,'evidence_refs','[]'::jsonb,'company_claims','[]'::jsonb,'assumptions','[]'::jsonb,'questions','[]'::jsonb)),'[]') from jsonb_array_elements(s.payload->'sections') x where x->>'kind'='accepted_unit'),
     'pending_inputs',jsonb_build_array(jsonb_build_object('id','legacy-response-review','question','Previously accepted text is retained with its original snapshot provenance. Bind it to current reviewed obligations and review it before claiming substantive completion.','required_for','substantive_completion','requirement_ids','[]'::jsonb)));
   end if;
   if old_r.id is not null then
    body:=body||jsonb_build_object('sections',(select coalesce(jsonb_agg(value||'{"requirement_ids":[],"evidence_refs":[],"company_claims":[]}'::jsonb),'[]') from jsonb_array_elements(old_r.body->'sections')),
     'pending_inputs',jsonb_build_array(jsonb_build_object('id','changed-source-review','question','Source extraction changed. Retained authored content requires new requirement bindings and current-source review.','required_for','substantive_completion','requirement_ids','[]'::jsonb)));
   end if;
   insert into public.proposal_authoring_revisions(workspace_id,session_id,ordinal,body,body_hash,predecessor_revision_id,created_by)
   values(w,a.id,1,body,encode(sha256(convert_to(body::text,'UTF8')),'hex'),old_r.id,actor_id) returning * into r;
   update public.proposal_authoring_sessions set current_revision_id=r.id where id=a.id;
  end if;
 else
  select * into a from public.proposal_authoring_sessions where id=a.id for update;
  if a.revision is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  perform app_private.authoring_context(a.id,actor_id);
  if operation='claim' then
   perform app_private.check_keys(input,array['session_id','expected_revision','note']);
   if length(trim(input->>'note')) not between 1 and 3000 then raise exception 'INVALID_INPUT';end if;
   update public.proposal_authoring_sessions set responsible_actor_id=actor_id,revision=revision+1,updated_at=now() where id=a.id;
  else
   perform app_private.check_keys(input,array['session_id','expected_revision','body']);body:=input->'body';
   if body->>'version' is distinct from '1' or jsonb_typeof(body->'requirements') is distinct from 'array' or jsonb_typeof(body->'sections') is distinct from 'array' then raise exception 'INVALID_INPUT';end if;
   if jsonb_array_length(body->'requirements')>0 then
    required:=app_private.source_obligation_inventory(w,a.opportunity_id,array(select (value->>'id')::uuid from jsonb_array_elements(body->'requirements')));
    body:=jsonb_set(body,'{requirements}',required);
   end if;
   for reuse in select value from jsonb_array_elements(body->'reuse') loop
    select * into k from public.knowledge_items where workspace_id=w and id=(reuse->>'source_id')::uuid and enabled and verified and (expiry_date is null or expiry_date>=current_date);
    if k.id is null or (app_private.content_record(w,'knowledge',k.id)->>'content_hash') is distinct from reuse->>'content_hash'
     or position(reuse->>'quote' in app_private.content_record(w,'knowledge',k.id)->>'content')=0 then raise exception 'AUTHORING_REUSE_UNVERIFIED';end if;
    if length(trim(reuse->>'fit_reason'))<1 then raise exception 'AUTHORING_REUSE_FIT_REQUIRED';end if;
   end loop;
   select coalesce(max(ordinal),0)+1 into nextordinal from public.proposal_authoring_revisions where session_id=a.id;
   insert into public.proposal_authoring_revisions(workspace_id,session_id,ordinal,body,body_hash,created_by)
   values(w,a.id,nextordinal,body,encode(sha256(convert_to(body::text,'UTF8')),'hex'),actor_id) returning * into r;
   update public.proposal_authoring_sessions set current_revision_id=r.id,revision=revision+1,updated_at=now() where id=a.id;
   update public.approvals set invalidated_at=now(),revision=revision+1 where workspace_id=w and proposal_version_id in (select id from public.proposal_versions where workspace_id=w and proposal_id=a.proposal_id) and invalidated_at is null;
   update public.proposal_versions set status='draft',revision=revision+1,updated_at=now() where workspace_id=w and proposal_id=a.proposal_id and status='approved';
   update public.proposals set state='draft',revision=revision+1,updated_at=now() where id=a.proposal_id;
  end if;
 end if;
 result:=app_private.authoring_context(a.id,actor_id);
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(w,actor_id,'proposal.authoring.'||operation,'proposal_authoring_session',a.id,jsonb_build_object('revision_id',result#>>'{revision,id}','body_hash',result#>>'{revision,body_hash}','predecessor_id',prior.id));
 delete from app_private.idempotency_records where workspace_id=w and idempotency_records.actor_id=proposal_authoring_command.actor_id and method='COMMAND' and route='proposal.authoring.'||operation and key=idempotency_key;
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor_id,'COMMAND','proposal.authoring.'||operation,idempotency_key,digest,result);
 return result;
end $$;

-- Only the trusted API validator can publish authoring content or review status.
-- The commit rechecks the saved body, current actor/sources and exact revision
-- after acquiring the workspace lock; a stale validator cannot overwrite edits.
create function public.publish_authored_delivery(actor_id uuid,session_id uuid,expected_revision integer,expected_context_hash text,payload jsonb,review jsonb default null,idempotency_key text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.proposal_authoring_sessions;p public.proposals;s public.proposal_delivery_snapshots;base public.proposal_delivery_snapshots;ctx jsonb;digest text;replay app_private.idempotency_records;operation text;nextordinal integer;begin
 select * into a from public.proposal_authoring_sessions where id=session_id;
 if a.id is null then raise exception 'NOT_FOUND';end if;
 perform app_private.delivery_actor(a.workspace_id,actor_id,true);perform 1 from public.workspaces where id=a.workspace_id for update;perform app_private.delivery_actor(a.workspace_id,actor_id,true);
 ctx:=app_private.authoring_context(a.id,actor_id);operation:=case when review is null then 'proposal.authoring.publish' else 'proposal.authoring.review' end;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 then raise exception 'INVALID_INPUT';end if;
 digest:=encode(sha256(convert_to(jsonb_build_object('expected_revision',expected_revision,'context_hash',expected_context_hash,'payload',payload,'review',review)::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=a.workspace_id and idempotency_records.actor_id=publish_authored_delivery.actor_id and method='COMMAND' and route=operation and key=idempotency_key and expires_at>now();
 if replay.key is not null then if replay.body_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 if (ctx#>>'{session,revision}')::int is distinct from expected_revision or ctx->>'context_hash' is distinct from expected_context_hash then raise exception 'REVISION_CONFLICT';end if;
 select * into base from public.proposal_delivery_snapshots where id=a.base_snapshot_id;
 if payload->>'version' is distinct from '2' or payload->>'approval_state' is distinct from 'draft' or payload->'source_manifest' is distinct from ctx->'source_manifest'
  or payload#>>'{authoring,revision_id}' is distinct from ctx#>>'{revision,id}' or payload#>>'{authoring,body_hash}' is distinct from ctx#>>'{revision,body_hash}' or payload#>>'{authoring,session_id}' is distinct from a.id::text then raise exception 'AUTHORING_PUBLICATION_INVALID';end if;
 if review is null and (payload->>'substantive_complete'<>'false' or payload#>>'{authoring,review_id}' is not null or payload->>'assurance_state'<>'unreviewed') then raise exception 'AUTHORING_REVIEW_REQUIRED';end if;
 if review is not null and (payload#>>'{authoring,review_id}' is null or payload#>>'{authoring,report,input_hash}' is null or payload->>'assurance_state'<>'human_reviewed') then raise exception 'AUTHORING_REVIEW_REQUIRED';end if;
 if payload->>'substantive_complete'='true' and (jsonb_array_length(ctx->'inventory_missing_ids')>0 or payload#>>'{authoring,report,substantive_complete}'<>'true' or jsonb_array_length(payload#>'{authoring,report,coverage}')=0
  or exists(select 1 from jsonb_array_elements(payload->'gaps') g where g->>'required_for'='substantive_completion')) then raise exception 'AUTHORING_RESPONSE_INCOMPLETE';end if;
 select * into p from public.proposals where id=a.proposal_id for update;
 if p.delivery_revision is distinct from (ctx#>>'{session,expected_delivery_revision}')::integer then raise exception 'AUTHORING_DELIVERY_CHANGED';end if;
 select coalesce(max(ordinal),0)+1 into nextordinal from public.proposal_delivery_snapshots where workspace_id=a.workspace_id and proposal_id=p.id;
 insert into public.proposal_delivery_snapshots(workspace_id,opportunity_id,proposal_id,base_version_id,ordinal,content_hash,source_manifest,payload,created_by)
 values(a.workspace_id,a.opportunity_id,p.id,p.active_version_id,nextordinal,encode(sha256(convert_to(payload::text,'UTF8')),'hex'),ctx->'source_manifest',payload,actor_id) returning * into s;
 update public.proposals set active_delivery_snapshot_id=s.id,delivery_revision=delivery_revision+1 where id=p.id;
 update public.proposal_authoring_sessions set expected_delivery_revision=p.delivery_revision+1 where id=a.id;
 if review is not null then insert into public.proposal_authoring_reviews(id,workspace_id,session_id,authoring_revision_id,context_hash,reviewed_input_hash,review,report,snapshot_id,created_by)
 values((payload#>>'{authoring,review_id}')::uuid,a.workspace_id,a.id,(ctx#>>'{revision,id}')::uuid,expected_context_hash,payload#>>'{authoring,report,input_hash}',review,payload#>'{authoring,report}',s.id,actor_id);end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(a.workspace_id,actor_id,operation,'proposal_authoring_session',a.id,jsonb_build_object('snapshot_id',s.id,'revision_id',ctx#>>'{revision,id}','substantive_complete',payload->'substantive_complete','review_id',payload#>'{authoring,review_id}'));
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(a.workspace_id,actor_id,'COMMAND',operation,idempotency_key,digest,to_jsonb(s));
 return to_jsonb(s);
end $$;

create function app_private.document_ocr_published(documentuuid uuid,actoruuid uuid) returns void
language plpgsql security definer set search_path='' as $$declare parent uuid;w uuid;begin
 select d.workspace_id,d.ocr_parent_document_id into w,parent from public.documents d where d.id=documentuuid;
 perform app_private.delivery_actor(w,actoruuid,true);
 update public.proposal_authoring_sessions a set source_change_reason='OCR_SOURCE_SUCCESSOR',revision=revision+1,updated_at=now()
 where a.workspace_id=w and a.source_change_reason is null and exists(select 1 from public.proposal_delivery_snapshots s where s.id=a.base_snapshot_id and s.source_manifest @> jsonb_build_array(jsonb_build_object('entity_kind','document','entity_id',parent)));
end $$;

alter function app_private.backup_tables() rename to backup_tables_before_authoring;
create function app_private.backup_tables() returns text[] language sql immutable set search_path='' as $$select app_private.backup_tables_before_authoring()||array['proposal_authoring_sessions','proposal_authoring_revisions','proposal_authoring_reviews']::text[]$$;
alter function app_private.purge_scope(uuid,uuid) rename to purge_scope_before_authoring;
create function app_private.purge_scope(w uuid,opp uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$declare result jsonb;part jsonb;t text;begin
 result:=app_private.purge_scope_before_authoring(w,opp);
 foreach t in array array['proposal_authoring_sessions','proposal_authoring_revisions','proposal_authoring_reviews'] loop
  execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(x.id order by x.id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by x.id),''''),''UTF8'')),''hex'')) from public.%I x where x.workspace_id=$1 and %s',t,case when t='proposal_authoring_sessions' then 'x.opportunity_id=$2' else 'x.session_id in (select id from public.proposal_authoring_sessions where workspace_id=$1 and opportunity_id=$2)' end) into part using w,opp;
  result:=result||jsonb_build_object(t,part);
 end loop;return result;
end $$;
do $$declare signature text;role_name text;begin foreach signature in array array[
 'app_private.check_authoring_sources(public.proposal_delivery_snapshots,uuid)','app_private.authoring_context(uuid,uuid)','public.proposal_authoring_context(uuid,uuid)',
 'public.proposal_authoring_command(uuid,text,jsonb,text)','public.publish_authored_delivery(uuid,uuid,integer,text,jsonb,jsonb,text)','app_private.document_ocr_published(uuid,uuid)',
 'app_private.backup_tables_before_authoring()','app_private.backup_tables()','app_private.purge_scope_before_authoring(uuid,uuid)','app_private.purge_scope(uuid,uuid)'] loop
 execute 'revoke all on function '||signature||' from public';
 foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function '||signature||' from '||quote_ident(role_name);end if;end loop;
 end loop;end $$;
do $$declare r text;begin foreach r in array array['service_role','tdp_app_service'] loop if exists(select 1 from pg_roles where rolname=r) then execute 'grant execute on function public.proposal_authoring_context(uuid,uuid),public.proposal_authoring_command(uuid,text,jsonb,text),public.publish_authored_delivery(uuid,uuid,integer,text,jsonb,jsonb,text) to '||quote_ident(r);end if;end loop;end $$;

-- Additive renderer/executor routing: version 1 keeps identical bytes, paths,
-- queue pins and policy. Only new authored payloads select renderer 2/executor 4.
do $$declare c record;begin
 for c in select conname from pg_constraint where conrelid='public.proposal_delivery_snapshots'::regclass and contype='c' and pg_get_constraintdef(oid) like '%substantive_complete%' loop execute format('alter table public.proposal_delivery_snapshots drop constraint %I',c.conname);end loop;
end $$;
alter table public.proposal_delivery_snapshots add constraint delivery_payload_assurance_version check(
 payload->>'approval_state'='draft' and ((payload->'version'='1'::jsonb and payload->'substantive_complete'='false'::jsonb)
 or (payload->'version'='2'::jsonb and payload->>'content_state' in ('authored_draft','substantive_draft')
 and payload->'substantive_complete'=to_jsonb(payload->>'content_state'='substantive_draft')
 and (payload->'substantive_complete'='false'::jsonb or (payload->>'assurance_state'='human_reviewed' and payload#>>'{authoring,review_id}' is not null)))));
alter table public.proposal_delivery_artifacts drop constraint proposal_delivery_artifacts_renderer_version_check;
alter table public.proposal_delivery_artifacts add constraint proposal_delivery_artifacts_renderer_version_check check(renderer_version in ('1','2'));
create function app_private.delivery_renderer(s public.proposal_delivery_snapshots) returns text language sql immutable set search_path='' as $$select case s.payload->>'version' when '1' then '1' when '2' then '2' end$$;
create function app_private.delivery_executor(s public.proposal_delivery_snapshots) returns integer language sql immutable set search_path='' as $$select case s.payload->>'version' when '1' then 3 when '2' then 4 end$$;
do $$declare definition text;signature text;marker text;next text;begin
 for signature,marker,next in values
 ('app_private.guard_delivery_artifact()',$m$||'/1/'||new.job_id$m$,$m$||'/'||old.renderer_version||'/'||new.job_id$m$),
 ('app_private.enqueue_delivery_export()',$m$'{"model_executor":3,"delivery_renderer_version":"1","delivery_retry_policy":1,"delivery_attempt":1}'$m$,$m$jsonb_build_object('model_executor',app_private.delivery_executor(new),'delivery_renderer_version',app_private.delivery_renderer(new),'delivery_retry_policy',1,'delivery_attempt',1)$m$),
 ('app_private.enqueue_delivery_export()',$m$render_job,'1',volume$m$,$m$render_job,app_private.delivery_renderer(new),volume$m$),
 ('app_private.enqueue_delivery_export()',$m$||'/1/'||artifact$m$,$m$||'/'||app_private.delivery_renderer(new)||'/'||artifact$m$),
 ('app_private.delivery_job(uuid,uuid,boolean)',$m$j.checkpoint->>'model_executor' is distinct from '3'$m$,$m$j.checkpoint->>'model_executor' is distinct from app_private.delivery_executor(s)::text$m$),
 ('app_private.delivery_job(uuid,uuid,boolean)',$m$j.checkpoint->>'delivery_renderer_version' is distinct from '1'$m$,$m$j.checkpoint->>'delivery_renderer_version' is distinct from app_private.delivery_renderer(s)$m$),
 ('app_private.check_delivery_volume_set(public.proposal_delivery_snapshots,uuid)',$m$a.renderer_version='1'$m$,$m$a.renderer_version=app_private.delivery_renderer(snapshot)$m$),
 ('public.delivery_export_context(uuid,uuid)',$m$'renderer_version','1'$m$,$m$'renderer_version',app_private.delivery_renderer(s)$m$),
 ('public.delivery_package(uuid)',$m$'content_state',s.payload->>'content_state'$m$,$m$'substantive_complete',s.payload->'substantive_complete','authoring',s.payload->'authoring','content_state',s.payload->>'content_state'$m$)
 loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  if position(marker in definition)=0 then raise exception 'AUTHORING_RENDERER_MIGRATION_CHANGED: %',signature;end if;
  execute replace(definition,marker,next);
 end loop;
 -- Authority may already wrap the command dispatcher. Update the precise
 -- existing retry implementation rather than replacing that wrapper.
 select pg_get_functiondef(p.oid) into definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='app_private' and p.proname like 'app_command%' and p.prosrc like '%if operation<>''delivery.snapshot.retry''%' limit 1;
 if definition is null then raise exception 'AUTHORING_RETRY_MIGRATION_CHANGED';end if;
 definition:=replace(definition,$m$'model_executor',3,'delivery_renderer_version','1'$m$,$m$'model_executor',app_private.delivery_executor(s),'delivery_renderer_version',app_private.delivery_renderer(s)$m$);
 definition:=replace(definition,$m$next_job,'1',volume$m$,$m$next_job,app_private.delivery_renderer(s),volume$m$);
 definition:=replace(definition,$m$||'/1/'||$m$,$m$||'/'||app_private.delivery_renderer(s)||'/'||$m$);
 execute definition;
end $$;
create function public.claim_backend_job_v4() returns jsonb language plpgsql security definer set search_path='' as $$declare result jsonb;previous text:=current_setting('app.worker_executor',true);begin
 perform set_config('app.worker_executor','4',true);result:=public.claim_backend_job();perform set_config('app.worker_executor',coalesce(previous,''),true);return result;end $$;
create function public.claim_backend_local_job_v4() returns jsonb language plpgsql security definer set search_path='' as $$declare result jsonb;previous text:=current_setting('app.queue_local_only',true);begin
 perform set_config('app.queue_local_only','true',true);result:=public.claim_backend_job_v4();perform set_config('app.queue_local_only',coalesce(previous,''),true);return result;end $$;
do $$declare definition text;begin
 select pg_get_functiondef('app_private.wake_backend_queue_checked_v3(uuid,uuid,bigint)'::regprocedure) into definition;
 if position('<=3' in definition)=0 then raise exception 'AUTHORING_WAKE_EXECUTOR_CHANGED';end if;
 execute replace(replace(definition,'app_private.wake_backend_queue_checked_v3(','app_private.wake_backend_queue_checked_v4('),'<=3','<=4');
end $$;
create function public.wake_backend_queue_status_v4(job_id uuid,lease uuid) returns jsonb language sql security definer set search_path='' as $$select app_private.wake_backend_queue_checked_v4(job_id,lease,null)$$;
create function public.wake_backend_queue_revision_v4(job_id uuid,lease uuid,expected_revision bigint) returns jsonb language sql security definer set search_path='' as $$select case when expected_revision is null then '{"dispatched":false}'::jsonb else app_private.wake_backend_queue_checked_v4(job_id,lease,expected_revision) end$$;
do $$declare signature text;r text;begin foreach signature in array array['app_private.delivery_renderer(public.proposal_delivery_snapshots)','app_private.delivery_executor(public.proposal_delivery_snapshots)','app_private.wake_backend_queue_checked_v4(uuid,uuid,bigint)','public.claim_backend_job_v4()','public.claim_backend_local_job_v4()','public.wake_backend_queue_status_v4(uuid,uuid)','public.wake_backend_queue_revision_v4(uuid,uuid,bigint)'] loop
 execute 'revoke all on function '||signature||' from public';
 foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop if exists(select 1 from pg_roles where rolname=r) then
 execute 'revoke all on function '||signature||' from '||quote_ident(r);
 if r in ('service_role','tdp_app_service') and signature like 'public.%' then execute 'grant execute on function '||signature||' to '||quote_ident(r);end if;end if;end loop;end loop;end $$;

-- Accepted AI siblings remain durable, but background progress cannot replace
-- an explicitly authored delivery selected by the current user.
alter function app_private.publish_delivery_snapshot(uuid,uuid,uuid,text) rename to publish_delivery_snapshot_before_authoring;
create function app_private.publish_delivery_snapshot(proposal uuid,plan uuid,actor uuid,intake_failure text default null) returns public.proposal_delivery_snapshots
language plpgsql security definer set search_path='' as $$declare p public.proposals;before public.proposal_delivery_snapshots;result public.proposal_delivery_snapshots;begin
 select * into p from public.proposals where id=proposal;
 perform 1 from public.workspaces where id=p.workspace_id for update;
 select * into p from public.proposals where id=proposal for update;
 select * into before from public.proposal_delivery_snapshots where id=p.active_delivery_snapshot_id;
 result:=app_private.publish_delivery_snapshot_before_authoring(proposal,plan,actor,intake_failure);
 if plan is not null and before.payload->>'version'='2' then
  update public.proposals set active_delivery_snapshot_id=before.id,delivery_revision=p.delivery_revision where id=p.id;
  insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(p.workspace_id,actor,'proposal.authoring.selection_preserved','proposal',p.id,jsonb_build_object('selected_snapshot_id',before.id,'progress_snapshot_id',result.id));
 end if;return result;
end $$;
do $$declare signature text;r text;begin foreach signature in array array['app_private.publish_delivery_snapshot(uuid,uuid,uuid,text)','app_private.publish_delivery_snapshot_before_authoring(uuid,uuid,uuid,text)'] loop
 execute 'revoke all on function '||signature||' from public';foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop if exists(select 1 from pg_roles where rolname=r) then execute 'revoke all on function '||signature||' from '||quote_ident(r);end if;end loop;end loop;end $$;

-- Metadata-only recovery remains available when old source text is stale.
create function public.proposal_authoring_status(snapshot_id uuid,actor_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$declare s public.proposal_delivery_snapshots;a public.proposal_authoring_sessions;p public.proposals;begin
 select * into s from public.proposal_delivery_snapshots where id=snapshot_id;
 if s.id is null then raise exception 'NOT_FOUND';end if;perform app_private.delivery_actor(s.workspace_id,actor_id,true);
 if not exists(select 1 from public.opportunities where workspace_id=s.workspace_id and id=s.opportunity_id and not archived) then raise exception 'NOT_FOUND';end if;
 select * into a from public.proposal_authoring_sessions where workspace_id=s.workspace_id and (base_snapshot_id=s.id or id::text=s.payload#>>'{authoring,session_id}') order by created_at desc,id desc limit 1;
 select * into p from public.proposals where id=s.proposal_id;
 return jsonb_build_object('session_id',a.id,'revision',a.revision,'delivery_revision',p.delivery_revision,'source_change_reason',a.source_change_reason);
end $$;
revoke all on function public.proposal_authoring_status(uuid,uuid) from public;
do $$declare r text;begin foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop if exists(select 1 from pg_roles where rolname=r) then execute 'revoke all on function public.proposal_authoring_status(uuid,uuid) from '||quote_ident(r);if r in ('service_role','tdp_app_service') then execute 'grant execute on function public.proposal_authoring_status(uuid,uuid) to '||quote_ident(r);end if;end if;end loop;end $$;
