-- Exact source identity and explicitly reviewed meaning. Source kind/filename,
-- document precedence and model confidence never establish buyer authority.
create table public.source_authority_decisions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),opportunity_id uuid not null,
 entity_kind text not null check(entity_kind in ('document','notice')),entity_id uuid not null,content_hash text not null check(content_hash~'^[a-f0-9]{64}$'),
 revision integer not null check(revision>0),role text not null check(role in ('buyer_rfp','buyer_addendum','supplier_proposal','company_evidence','reference','unknown')),
 status text not null check(status in ('confirmed','revoked')),supersedes jsonb,precedence integer not null check(precedence between 0 and 1000),
 reason text not null check(length(trim(reason)) between 1 and 3000),created_by uuid not null,created_at timestamptz not null default now(),
 unique(workspace_id,opportunity_id,entity_kind,entity_id,content_hash,revision),
 foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id),check(status<>'confirmed' or role<>'unknown')
);
create table public.source_obligation_reviews (
 id uuid primary key default gen_random_uuid(),review_id uuid not null default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),opportunity_id uuid not null,
 revision integer not null check(revision>0),spans jsonb not null check(jsonb_typeof(spans)='array' and jsonb_array_length(spans) between 1 and 8),semantics jsonb not null,
 status text not null check(status in ('confirmed','revoked')),supersedes_review_id uuid,
 reason text not null check(length(trim(reason)) between 1 and 3000),created_by uuid not null,created_at timestamptz not null default now(),
 unique(workspace_id,review_id,revision),foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id),check(review_id is distinct from supersedes_review_id)
);
create index source_authority_current on public.source_authority_decisions(workspace_id,opportunity_id,entity_kind,entity_id,content_hash,revision desc);
create index source_review_current on public.source_obligation_reviews(workspace_id,opportunity_id,review_id,revision desc);
create function app_private.immutable_source_review() returns trigger language plpgsql set search_path='' as $$begin raise exception 'SOURCE_REVIEW_IMMUTABLE';end$$;
create trigger source_authority_immutable before update or delete on public.source_authority_decisions for each row execute function app_private.immutable_source_review();
create trigger source_obligation_immutable before update or delete on public.source_obligation_reviews for each row execute function app_private.immutable_source_review();
create trigger source_authority_changed after insert on public.source_authority_decisions for each row execute function app_private.invalidate_evidence();
create trigger source_obligation_changed after insert on public.source_obligation_reviews for each row execute function app_private.invalidate_evidence();

create function app_private.source_authority(w uuid,opp uuid,kind text,entity uuid,hash text) returns jsonb
language plpgsql stable security definer set search_path='' as $$declare d public.source_authority_decisions;begin
 select * into d from public.source_authority_decisions where workspace_id=w and opportunity_id=opp and entity_kind=kind and entity_id=entity and content_hash=hash order by revision desc limit 1;
 return jsonb_build_object('version',1,'decision_id',d.id,'revision',coalesce(d.revision,0),'role',coalesce(d.role,'unknown'),'status',coalesce(d.status,'unconfirmed'),'supersedes',d.supersedes,'precedence',coalesce(d.precedence,0));
end$$;
-- Legacy deployments without OCR have no successor state. If OCR columns exist,
-- the canonical publication resolver is required; never guess currentness.
create function app_private.source_document_current(w uuid,document_id uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$declare current_id uuid;begin
 if to_regprocedure('app_private.current_document_extraction(uuid,uuid)') is null then
  if exists(select 1 from pg_attribute where attrelid='public.documents'::regclass and attname='ocr_parent_document_id' and not attisdropped) then raise exception 'SOURCE_CURRENTNESS_REQUIRED';end if;
  return true;
 end if;
 execute 'select app_private.current_document_extraction($1,$2)' into current_id using w,document_id;
 return current_id is not distinct from document_id;
end$$;
create function app_private.source_review_sources(w uuid,opp uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$declare result jsonb;notice jsonb;begin
 if not exists(select 1 from public.opportunities where workspace_id=w and id=opp and not archived) then raise exception 'NOT_FOUND';end if;
 notice:=app_private.content_record(w,'notice',opp);
 select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'text',b.text,'kind','rfp','verified',false,'block_hash',encode(sha256(convert_to(b.text,'UTF8')),'hex'),
  'extraction_version',coalesce(to_jsonb(d)->>'extraction_version','native-v1'),'locator',b.locator,
  'reference',jsonb_build_object('entity_kind','document','entity_id',d.id,'content_hash',d.extraction_hash),
  'authority',app_private.source_authority(w,opp,'document',d.id,d.extraction_hash)) order by d.id,b.ordinal),'[]') into result
 from public.documents d join public.document_blocks b on b.workspace_id=d.workspace_id and b.document_id=d.id
 where d.workspace_id=w and d.opportunity_id=opp and d.kind='rfp' and d.status in ('ready','partial') and not d.archived and app_private.source_document_current(w,d.id);
 return jsonb_build_array(jsonb_build_object('id',opp,'text',notice->>'content','kind','notice','verified',false,'block_hash',notice->>'content_hash','extraction_version','notice-v1','locator','{}'::jsonb,
 'reference',notice-'content'-'title','authority',app_private.source_authority(w,opp,'notice',opp,notice->>'content_hash')))||result;
end$$;
create function app_private.source_span_from_block(source jsonb,start_at integer,end_at integer) returns jsonb
language plpgsql immutable set search_path='' as $$declare ref jsonb:=source->'reference';span_id text;begin
 if start_at is null or end_at is null or start_at<0 or end_at<=start_at or end_at>length(source->>'text') or end_at-start_at>12000 then raise exception 'SOURCE_SPAN_RANGE_INVALID';end if;
 span_id:='S1:'||(source->>'id')||':'||start_at||':'||end_at||':'||left(ref->>'content_hash',16)||':'||(source->>'extraction_version');
 return jsonb_build_object('version',1,'id',span_id,'entity_kind',ref->>'entity_kind','entity_id',ref->>'entity_id','content_hash',ref->>'content_hash','extraction_version',source->>'extraction_version',
 'block_id',source->>'id','block_hash',source->>'block_hash','coordinate','unicode_code_point','start',start_at,'end',end_at,'quote',substring(source->>'text' from start_at+1 for end_at-start_at),'locator',coalesce(nullif(source->'locator','null'::jsonb),'{}'::jsonb),'authority',source->'authority');
end$$;
create function app_private.resolve_source_span(w uuid,opp uuid,span jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$declare source jsonb;resolved jsonb;begin
 if span is null or jsonb_typeof(span)<>'object' or span->'version' is distinct from '1'::jsonb then raise exception 'SOURCE_SPAN_INVALID';end if;
 select value into source from jsonb_array_elements(app_private.source_review_sources(w,opp)) where value->>'id'=span->>'block_id';
 if source is null then raise exception 'SOURCE_SPAN_STALE';end if;
 resolved:=app_private.source_span_from_block(source,(span->>'start')::integer,(span->>'end')::integer);
 if resolved is distinct from span then raise exception 'SOURCE_SPAN_STALE';end if;
 return resolved;
end$$;
create function app_private.valid_obligation_tuple(s jsonb) returns boolean language plpgsql immutable set search_path='' as $$declare field text;item jsonb;begin
 if s is null or jsonb_typeof(s)<>'object' or (select count(*) from jsonb_object_keys(s))<>8 or not s ?& array['modality','actor','negated','conditions','exceptions','consequences','quantities','dates'] then return false;end if;
 if coalesce(s->>'modality','') not in ('required','permitted','prohibited','informational','unknown') or jsonb_typeof(s->'actor') not in ('string','null') or (jsonb_typeof(s->'actor')='string' and length(s->>'actor') not between 1 and 1000) or jsonb_typeof(s->'negated') not in ('boolean','null') then return false;end if;
 foreach field in array array['conditions','exceptions','consequences','quantities','dates'] loop
  if jsonb_typeof(s->field)<>'array' or jsonb_array_length(s->field)>32 then return false;end if;
  for item in select value from jsonb_array_elements(s->field) loop
   if field in ('conditions','exceptions','consequences') then
    if jsonb_typeof(item)<>'string' or length(item#>>'{}') not between 1 and 3000 then return false;end if;
   elsif field='quantities' then
    if jsonb_typeof(item)<>'object' or (select count(*) from jsonb_object_keys(item))<>3 or not item ?& array['value','unit','currency'] or jsonb_typeof(item->'value')<>'string' or length(item->>'value') not between 1 and 200 or jsonb_typeof(item->'unit')<>'string' or length(item->>'unit') not between 1 and 200 or jsonb_typeof(item->'currency') not in ('string','null') or (jsonb_typeof(item->'currency')='string' and length(item->>'currency') not between 1 and 100) then return false;end if;
   else
    if jsonb_typeof(item)<>'object' or (select count(*) from jsonb_object_keys(item))<>2 or not item ?& array['value','event'] or jsonb_typeof(item->'value')<>'string' or length(item->>'value') not between 1 and 200 or jsonb_typeof(item->'event')<>'string' or length(item->>'event') not between 1 and 1000 then return false;end if;
   end if;
  end loop;
 end loop;return true;
exception when others then return false;end$$;
create function app_private.source_semantics_for_review(r public.source_obligation_reviews) returns jsonb language plpgsql stable set search_path='' as $$declare role text;status text;ids jsonb;begin
 select jsonb_agg(value->'id' order by n) into ids from jsonb_array_elements(r.spans) with ordinality e(value,n);
 if exists(select 1 from jsonb_array_elements(r.spans) s where s#>>'{authority,status}'='revoked') then role:='unknown';status:='revoked';
 elsif exists(select 1 from jsonb_array_elements(r.spans) s where s#>>'{authority,status}' is distinct from 'confirmed' or s#>>'{authority,role}'='unknown') then role:='unknown';status:='unconfirmed';
 elsif not exists(select 1 from jsonb_array_elements(r.spans) s where s#>>'{authority,role}' not in ('buyer_rfp','buyer_addendum')) then status:='confirmed';role:=case when exists(select 1 from jsonb_array_elements(r.spans) s where s#>>'{authority,role}'='buyer_addendum') then 'buyer_addendum' else 'buyer_rfp' end;
 elsif (select count(distinct s#>>'{authority,role}') from jsonb_array_elements(r.spans) s)=1 then role:=r.spans#>>'{0,authority,role}';status:='confirmed';
 else role:='unknown';status:='unconfirmed';end if;
 return r.semantics||jsonb_build_object('version',1,'source_span_ids',ids,'authority_role',role,'authority_status',status,'review_status','confirmed','review_id',r.review_id);
end$$;
create function app_private.source_obligation_inventory(w uuid,opportunity uuid,review_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$declare result jsonb:='[]';rid uuid;r public.source_obligation_reviews;s jsonb;semantics jsonb;refs jsonb;body text;begin
 if review_ids is null or cardinality(review_ids)>1000 or cardinality(review_ids)<>(select count(distinct x) from unnest(review_ids) x) then raise exception 'INVALID_SOURCE_INVENTORY';end if;
 foreach rid in array review_ids loop
  select * into r from public.source_obligation_reviews where workspace_id=w and opportunity_id=opportunity and review_id=rid order by revision desc limit 1;
  if r.id is null or r.status<>'confirmed' then raise exception 'SOURCE_SEMANTICS_REVIEW_REQUIRED';end if;
  if exists(select 1 from (select distinct on(review_id) * from public.source_obligation_reviews where workspace_id=w and opportunity_id=opportunity order by review_id,revision desc) x where x.status='confirmed' and x.supersedes_review_id=rid) then raise exception 'SOURCE_OBLIGATION_SUPERSEDED';end if;
  for s in select value from jsonb_array_elements(r.spans) loop perform app_private.resolve_source_span(w,opportunity,s);end loop;
  semantics:=app_private.source_semantics_for_review(r);
  select jsonb_agg(jsonb_build_object('id',value->>'id','quote',value->>'quote') order by n),string_agg(value->>'quote',E'\n[Separate source passage]\n' order by n) into refs,body from jsonb_array_elements(r.spans) with ordinality e(value,n);
  result:=result||jsonb_build_array(jsonb_build_object('id',rid,'text',body,'mandatory',(semantics->>'authority_status'='confirmed' and semantics->>'authority_role' in ('buyer_rfp','buyer_addendum') and semantics->>'modality' in ('required','prohibited')),'source_refs',refs,'source_semantics',semantics,'source_review_reason',r.reason));
 end loop;return result;
end$$;
create function app_private.check_source_semantics(w uuid,semantics jsonb,refs jsonb) returns boolean
language plpgsql stable security definer set search_path='' as $$declare r public.source_obligation_reviews;derived jsonb;begin
 if $2->>'review_status' is distinct from 'confirmed' or coalesce($2->>'modality','unknown')='unknown' or $2->'negated'='null'::jsonb or ($2->'actor'='null'::jsonb and $2->>'modality'<>'informational' and not ($2->>'authority_status'='confirmed' and $2->>'authority_role' in ('reference','supplier_proposal','company_evidence'))) or semantics->'version' is distinct from '1'::jsonb or nullif(semantics->>'review_id','') is null then return false;end if;
 select * into r from public.source_obligation_reviews where workspace_id=w and review_id=($2->>'review_id')::uuid order by revision desc limit 1;
 if r.id is null then return false;end if;
 derived:=app_private.source_obligation_inventory(w,r.opportunity_id,array[r.review_id])->0;
 return derived->'source_semantics'=semantics and derived->'source_refs'=refs;
exception when others then return false;end$$;
create function app_private.source_review_evidence(w uuid,opp uuid,sources jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$declare spans jsonb:='[]';reviews jsonb:='[]';source jsonb;r public.source_obligation_reviews;s jsonb;start_at integer;usable boolean;begin
 for source in select value from jsonb_array_elements(sources) loop
  start_at:=0;while start_at<length(source->>'text') loop
   spans:=spans||jsonb_build_array(app_private.source_span_from_block(source,start_at,least(start_at+1400,length(source->>'text'))));start_at:=start_at+1400;
  end loop;
 end loop;
 for r in select distinct on(review_id) * from public.source_obligation_reviews where workspace_id=w and opportunity_id=opp order by review_id,revision desc loop
  if r.status<>'confirmed' then continue;end if;
  begin
   perform app_private.source_obligation_inventory(w,opp,array[r.review_id]);
   usable:=true;
   for s in select value from jsonb_array_elements(r.spans) loop
    if not exists(select 1 from jsonb_array_elements(sources) e where e->>'id'=s->>'block_id' and e#>>'{reference,content_hash}'=s->>'content_hash') then usable:=false;exit;end if;
   end loop;
   if usable then
    reviews:=reviews||jsonb_build_array(jsonb_build_object('version',1,'id',r.review_id,'revision',r.revision,'opportunity_id',opp,'spans',r.spans,'semantics',r.semantics,'reason','Current source-bound human interpretation.','status',r.status));
    for s in select value from jsonb_array_elements(r.spans) loop
     if not exists(select 1 from jsonb_array_elements(spans) e where e->>'id'=s->>'id') then spans:=spans||jsonb_build_array(s);end if;
    end loop;
   end if;
  exception when sqlstate 'P0001' then null;end;
 end loop;
 return jsonb_build_object('version',1,'spans',spans,'reviews',reviews);
end$$;
create function public.source_review_context(opportunity_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$declare w uuid;sources jsonb;begin
 select o.workspace_id into w from public.opportunities o where o.id=opportunity_id and not o.archived and app_private.member_role(o.workspace_id) is not null;
 if w is null then raise exception 'NOT_FOUND';end if;
 sources:=app_private.source_review_sources(w,opportunity_id);
 return jsonb_build_object('source_contract_version',1,'source_evidence',app_private.source_review_evidence(w,opportunity_id,sources),'sources',sources);
end$$;

alter function app_private.app_command(text,jsonb,text) rename to app_command_before_source_authority;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;opp uuid;actor uuid:=auth.uid();digest text;replay app_private.idempotency_records;result jsonb;content jsonb;prior_revision integer;record_id uuid;review uuid;spans jsonb:='[]';span jsonb;r public.source_obligation_reviews;old_review public.source_obligation_reviews;replaces uuid;ancestor uuid;latest public.source_authority_decisions;
begin
 if operation not in ('source.authority.review','source.obligation.review') then return app_private.app_command_before_source_authority(operation,input,idempotency_key);end if;
 opp:=(input->>'opportunity_id')::uuid;
 select workspace_id into w from public.opportunities where id=opp and not archived and app_private.member_role(workspace_id) is not null;
 if w is null then raise exception 'NOT_FOUND';end if;
 perform 1 from public.workspaces where id=w for update;
 if coalesce(app_private.member_role(w),'') not in ('Owner','Editor') then raise exception 'ROLE_FORBIDDEN';end if;
 if exists(select 1 from public.restore_sessions where workspace_id=w and state='staging') then raise exception 'RESTORE_IN_PROGRESS';end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(input)>262144 or coalesce(length(trim(input->>'reason')),0) not between 1 and 3000 or coalesce(input->>'status','') not in ('confirmed','revoked') or input->>'expected_revision' is null or input->>'expected_revision'!~'^[0-9]+$' then raise exception 'INVALID_INPUT';end if;
 digest:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then if replay.body_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 if operation='source.authority.review' then
  perform app_private.check_keys(input,array['opportunity_id','entity_kind','entity_id','content_hash','expected_revision','role','status','supersedes','precedence','reason']);
  if coalesce(input->>'entity_kind','') not in ('document','notice') or coalesce(input->>'role','') not in ('buyer_rfp','buyer_addendum','supplier_proposal','company_evidence','reference','unknown') or (input->>'status'='confirmed' and input->>'role'='unknown') or coalesce(input->>'precedence','')!~'^[0-9]+$' or (input->>'precedence')::integer>1000 then raise exception 'INVALID_SOURCE_AUTHORITY';end if;
  content:=app_private.content_record(w,input->>'entity_kind',(input->>'entity_id')::uuid);
  if input->>'entity_kind'='document' and not app_private.source_document_current(w,(input->>'entity_id')::uuid) then raise exception 'SOURCE_SPAN_STALE';end if;
  if input->>'content_hash' is distinct from content->>'content_hash' then raise exception 'STALE_INPUT';end if;
  if (input->>'entity_kind'='notice' and (input->>'entity_id')::uuid<>opp) or (input->>'entity_kind'='document' and not exists(select 1 from public.documents where workspace_id=w and id=(input->>'entity_id')::uuid and opportunity_id=opp and kind='rfp')) then raise exception 'INVALID_SOURCE_AUTHORITY';end if;
  select * into latest from public.source_authority_decisions where workspace_id=w and opportunity_id=opp and entity_kind=input->>'entity_kind' and entity_id=(input->>'entity_id')::uuid and content_hash=input->>'content_hash' order by revision desc limit 1;
  prior_revision:=coalesce(latest.revision,0);
  if prior_revision<>(input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT';end if;
  if input->'supersedes' is not null and input->'supersedes'<>'null'::jsonb then
   if input->>'entity_kind'<>'document' or input->>'role'<>'buyer_addendum' or input->>'status'<>'confirmed' or jsonb_typeof(input->'supersedes')<>'object' or (select count(*) from jsonb_object_keys(input->'supersedes'))<>2 or not (input->'supersedes') ?& array['entity_id','content_hash'] or input#>>'{supersedes,entity_id}'=input->>'entity_id' then raise exception 'INVALID_SOURCE_PRECEDENCE';end if;
   if not exists(select 1 from public.documents where workspace_id=w and opportunity_id=opp and id=(input#>>'{supersedes,entity_id}')::uuid and extraction_hash=input#>>'{supersedes,content_hash}' and status in ('ready','partial') and not archived) then raise exception 'INVALID_SOURCE_PRECEDENCE';end if;
   ancestor:=(input#>>'{supersedes,entity_id}')::uuid;
   for prior_revision in 1..1001 loop
    if ancestor=(input->>'entity_id')::uuid or prior_revision>1000 then raise exception 'SOURCE_PRECEDENCE_CYCLE';end if;
    select (a.supersedes->>'entity_id')::uuid into ancestor from (select distinct on(entity_id) * from public.source_authority_decisions where workspace_id=w and opportunity_id=opp and entity_kind='document' order by entity_id,revision desc,created_at desc) a where a.entity_id=ancestor and a.status='confirmed';
    exit when ancestor is null;
   end loop;
  end if;
  insert into public.source_authority_decisions(workspace_id,opportunity_id,entity_kind,entity_id,content_hash,revision,role,status,supersedes,precedence,reason,created_by)
  values(w,opp,input->>'entity_kind',(input->>'entity_id')::uuid,input->>'content_hash',coalesce(latest.revision,0)+1,input->>'role',input->>'status',nullif(input->'supersedes','null'::jsonb),(input->>'precedence')::integer,input->>'reason',actor) returning id,to_jsonb(source_authority_decisions.*) into record_id,result;
 else
  perform app_private.check_keys(input,array['opportunity_id','review_id','expected_revision','spans','semantics','status','reason','supersedes_review_id']);
  if jsonb_typeof(input->'spans') is distinct from 'array' or jsonb_array_length(input->'spans') not between 1 and 8 or not app_private.valid_obligation_tuple(input->'semantics') then raise exception 'INVALID_SOURCE_SEMANTICS';end if;
  if input->>'status'='confirmed' and (input#>>'{semantics,modality}'='unknown' or input#>'{semantics,negated}'='null'::jsonb) then raise exception 'SOURCE_SEMANTICS_UNRESOLVED';end if;
  review:=coalesce((input->>'review_id')::uuid,gen_random_uuid());
  select * into r from public.source_obligation_reviews where workspace_id=w and review_id=review order by revision desc limit 1;
  if coalesce(r.revision,0)<>(input->>'expected_revision')::integer or (r.id is not null and r.opportunity_id<>opp) or (r.id is null and input->>'review_id' is not null) then raise exception 'REVISION_CONFLICT';end if;
  for span in select value from jsonb_array_elements(input->'spans') loop spans:=spans||jsonb_build_array(app_private.resolve_source_span(w,opp,span));end loop;
  if (select count(distinct value->>'id') from jsonb_array_elements(spans))<>jsonb_array_length(spans) then raise exception 'INVALID_SOURCE_SEMANTICS';end if;
  if input->>'status'='confirmed' and input#>'{semantics,actor}'='null'::jsonb and input#>>'{semantics,modality}'<>'informational' then
   old_review.spans:=spans;old_review.semantics:=input->'semantics';
   content:=app_private.source_semantics_for_review(old_review);
   if not (content->>'authority_status'='confirmed' and content->>'authority_role' in ('reference','supplier_proposal','company_evidence')) then raise exception 'SOURCE_SEMANTICS_UNRESOLVED';end if;
  end if;
  replaces:=(input->>'supersedes_review_id')::uuid;
  if replaces is not null then
   select * into old_review from public.source_obligation_reviews where workspace_id=w and opportunity_id=opp and review_id=replaces order by revision desc limit 1;
   if old_review.id is null or old_review.status<>'confirmed' or replaces=review or input->>'status'<>'confirmed' or exists(select 1 from (select distinct on(review_id) * from public.source_obligation_reviews where workspace_id=w and opportunity_id=opp order by review_id,revision desc) x where x.status='confirmed' and x.supersedes_review_id=replaces and x.review_id<>review) then raise exception 'INVALID_SOURCE_PRECEDENCE';end if;
   if not exists(select 1 from jsonb_array_elements(spans) n,jsonb_array_elements(old_review.spans) o where n#>>'{authority,status}'='confirmed' and n#>>'{authority,role}'='buyer_addendum' and n#>>'{authority,supersedes,entity_id}'=o->>'entity_id' and n#>>'{authority,supersedes,content_hash}'=o->>'content_hash') then raise exception 'INVALID_SOURCE_PRECEDENCE';end if;
   ancestor:=replaces;
   for prior_revision in 1..1001 loop
    if ancestor=review or prior_revision>1000 then raise exception 'SOURCE_PRECEDENCE_CYCLE';end if;
    select x.supersedes_review_id into ancestor from public.source_obligation_reviews x where x.workspace_id=w and x.review_id=ancestor order by x.revision desc limit 1;exit when ancestor is null;
   end loop;
  end if;
  insert into public.source_obligation_reviews(review_id,workspace_id,opportunity_id,revision,spans,semantics,status,supersedes_review_id,reason,created_by)
   values(review,w,opp,coalesce(r.revision,0)+1,spans,input->'semantics',input->>'status',replaces,input->>'reason',actor) returning id,to_jsonb(source_obligation_reviews.*) into record_id,result;
 end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,request_id) values(w,actor,operation,record_id,gen_random_uuid());
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,digest,result);
 return result;
end$$;

-- Install the claim floor in the same migration BEFORE activating new source
-- contracts. A rolling old worker must not claim a wire it cannot validate.
create function app_private.minimum_generation_executor(context jsonb) returns integer
language sql immutable set search_path='' as $$
 select case when context->'source_contract_version'='1'::jsonb or context->'repair_contract_version'='1'::jsonb then 4 else 1 end
$$;
create function app_private.guard_generation_executor() returns trigger
language plpgsql security definer set search_path='' as $$declare required integer;begin
 select app_private.minimum_generation_executor(p.frozen_context) into required from public.generation_plans p where p.workspace_id=new.workspace_id and p.id=new.entity_id;
 if coalesce(required,1)>=4 then
  new.checkpoint:=new.checkpoint||jsonb_build_object('minimum_worker_executor',greatest(required,coalesce((new.checkpoint->>'minimum_worker_executor')::integer,1)));
 end if;return new;
end$$;
create trigger generation_source_executor before insert or update on public.jobs for each row execute function app_private.guard_generation_executor();
do $$declare definition text;marker text;replacement text;begin
 definition:=pg_get_functiondef('app_private.next_fair_job(uuid,boolean)'::regprocedure);
 marker:='coalesce((q.checkpoint->>''model_executor'')::int,1)';
 replacement:='greatest(coalesce((q.checkpoint->>''model_executor'')::int,1),coalesce((q.checkpoint->>''minimum_worker_executor'')::int,1))';
 if position(marker in definition)=0 then raise exception 'SOURCE_EXECUTOR_QUEUE_GUARD_CHANGED';end if;
 execute replace(definition,marker,replacement);
end$$;

-- Pin only genuinely new workflow requests. Refresh an old paid workflow without
-- the version marker by delegating unchanged, never rewriting its request hash.
alter function app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb) rename to draft_generation_snapshot_before_source_authority;
create function app_private.draft_generation_snapshot(w uuid,opp uuid,proposal uuid,package uuid,prior jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;sources jsonb;selected jsonb;blocks jsonb;notice jsonb;begin
 result:=app_private.draft_generation_snapshot_before_source_authority(w,opp,proposal,package,prior);
 if prior is not null and prior->'source_contract_version' is distinct from '1'::jsonb then return result;end if;
 sources:=app_private.source_review_sources(w,opp);
 select coalesce(jsonb_agg(e.value||jsonb_build_object('block_hash',s.value->'block_hash','extraction_version',s.value->'extraction_version','authority',s.value->'authority','locator',coalesce(nullif(e.value->'locator','null'::jsonb),'{}'::jsonb)) order by e.n),'[]') into blocks
 from jsonb_array_elements(result->'blocks') with ordinality e(value,n) join jsonb_array_elements(sources) s(value) on s.value->>'id'=e.value->>'id' and s.value->'reference'=e.value->'reference';
 if jsonb_array_length(blocks)<>jsonb_array_length(result->'blocks') then raise exception 'SOURCE_SPAN_STALE';end if;
 select result->'notice'||jsonb_build_object('block_hash',s.value->'block_hash','extraction_version',s.value->'extraction_version','authority',s.value->'authority','locator',coalesce(result#>'{notice,locator}','{}')) into notice from jsonb_array_elements(sources) s(value) where s.value->>'id'=result#>>'{notice,id}';
 selected:=blocks;
 if not exists(select 1 from jsonb_array_elements(blocks) e where e->>'id'=notice->>'id') then selected:=jsonb_build_array(notice)||blocks;end if;
 result:=result||jsonb_build_object('notice',notice,'blocks',blocks,'source_contract_version',1,'repair_contract_version',1,'source_evidence',app_private.source_review_evidence(w,opp,selected));
 if pg_column_size(result)>8388608 then raise exception 'GENERATION_CONTEXT_CAP_REACHED';end if;return result;
end$$;
alter table public.requirements add column source_semantics jsonb;
-- Patch the original insertion, leaving every later lease/source/revision guard
-- in the public wrapper chain in place. Legacy rows keep NULL assurance.
do $$declare definition text;target regprocedure;old text;begin
 select p.oid::regprocedure into target from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'advance_generation%' and position('insert into public.requirements(id,workspace_id,plan_id,opportunity_id,text,category,mandatory,source_refs,interpretation,acceptance_evidence,owner_question,created_by)' in p.prosrc)>0;
 if target is null then raise exception 'SOURCE_REQUIREMENT_INSERT_CHANGED';end if;
 definition:=pg_get_functiondef(target);
 old:='insert into public.requirements(id,workspace_id,plan_id,opportunity_id,text,category,mandatory,source_refs,interpretation,acceptance_evidence,owner_question,created_by)';
 definition:=replace(definition,old,'insert into public.requirements(id,workspace_id,plan_id,opportunity_id,text,category,mandatory,source_refs,interpretation,acceptance_evidence,owner_question,created_by,source_semantics)');
 old:=$old$item->>'owner_question',p.created_by)$old$;
 if position(old in definition)=0 then raise exception 'SOURCE_REQUIREMENT_VALUES_CHANGED';end if;
 definition:=replace(definition,old,$new$item->>'owner_question',p.created_by,case when p.frozen_context->'source_contract_version'='1'::jsonb then item->'source_semantics' else null end)$new$);
 execute definition;
end$$;

-- Review history is retained by workspace backups. Restored source hashes and
-- decision IDs must still pass the same live resolver before any approval.
alter function app_private.backup_tables() rename to backup_tables_before_source_authority;
create function app_private.backup_tables() returns text[] language sql immutable set search_path='' as $$select app_private.backup_tables_before_source_authority()||array['source_authority_decisions','source_obligation_reviews']::text[]$$;

do $$declare t text;role_name text;signature text;begin
 foreach t in array array['source_authority_decisions','source_obligation_reviews'] loop
  execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public',t);
  execute format('create policy member_read on public.%I for select using(app_private.member_role(workspace_id) is not null)',t);
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then
    execute format('revoke all on public.%I from %I',t,role_name);
    if role_name in ('authenticated','tdp_app_authenticated','service_role','tdp_app_service') then execute format('grant select on public.%I to %I',t,role_name);end if;
   end if;
  end loop;
 end loop;
 for signature in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='app_private' and (p.proname in ('immutable_source_review','minimum_generation_executor','guard_generation_executor','source_authority','source_document_current','source_review_sources','source_span_from_block','resolve_source_span','valid_obligation_tuple','source_semantics_for_review','source_obligation_inventory','check_source_semantics','source_review_evidence','app_command_before_source_authority','app_command','draft_generation_snapshot_before_source_authority','draft_generation_snapshot','backup_tables_before_source_authority','backup_tables'))) or (n.nspname='public' and p.proname='source_review_context') loop
  execute 'revoke all on function '||signature||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function '||signature||' from '||quote_ident(role_name);end if;
  end loop;
 end loop;
 foreach role_name in array array['authenticated','tdp_app_authenticated'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute format('grant execute on function public.source_review_context(uuid),app_private.app_command(text,jsonb,text) to %I',role_name);end if;
 end loop;
end$$;

-- The service cannot persist an unbound source tuple by bypassing model parsing.
create function app_private.guard_requirement_source() returns trigger language plpgsql security definer set search_path='' as $$
declare plan public.generation_plans;catalog jsonb;span jsonb;selected jsonb:='[]';refs jsonb;semantics jsonb;tuple jsonb;body text;review public.source_obligation_reviews;
begin
 select * into plan from public.generation_plans where workspace_id=new.workspace_id and id=new.plan_id;
 if plan.frozen_context->'source_contract_version' is distinct from '1'::jsonb then
  if new.source_semantics is not null then raise exception 'SOURCE_CONTRACT_NOT_PINNED';end if;return new;
 end if;
 semantics:=new.source_semantics;
 if semantics is null or jsonb_typeof(semantics)<>'object' or (select count(*) from jsonb_object_keys(semantics))<>14 or semantics->'version' is distinct from '1'::jsonb or jsonb_typeof(semantics->'source_span_ids') is distinct from 'array' or jsonb_array_length(semantics->'source_span_ids') not between 1 and 8 then raise exception 'SOURCE_SEMANTICS_INVALID';end if;
 tuple:=semantics-array['version','source_span_ids','authority_role','authority_status','review_status','review_id'];
 if not app_private.valid_obligation_tuple(tuple) then raise exception 'SOURCE_SEMANTICS_INVALID';end if;
 catalog:=plan.frozen_context#>'{source_evidence,spans}';
 for span in select value from jsonb_array_elements(semantics->'source_span_ids') loop
  select value into span from jsonb_array_elements(catalog) where value->'id'=span;
  if span is null then raise exception 'SOURCE_SPAN_STALE';end if;
  perform app_private.resolve_source_span(new.workspace_id,new.opportunity_id,span);selected:=selected||jsonb_build_array(span);
 end loop;
 if (select count(distinct value->>'id') from jsonb_array_elements(selected))<>jsonb_array_length(selected) then raise exception 'SOURCE_SPAN_IDENTITY_INVALID';end if;
 select jsonb_agg(jsonb_build_object('id',value->>'id','quote',value->>'quote') order by n),string_agg(value->>'quote',E'\n[Separate source passage]\n' order by n) into refs,body from jsonb_array_elements(selected) with ordinality e(value,n);
 if refs is distinct from new.source_refs or body is distinct from new.text then raise exception 'SOURCE_SPAN_TEXT_INVALID';end if;
 if semantics->>'review_status'='confirmed' then
  if not app_private.check_source_semantics(new.workspace_id,semantics,refs) then raise exception 'SOURCE_SEMANTICS_STALE';end if;
 elsif semantics->>'review_status'='pending' and semantics->'review_id'='null'::jsonb then
  review.spans:=selected;review.semantics:=tuple;review.review_id:=null;
  if semantics is distinct from app_private.source_semantics_for_review(review)||jsonb_build_object('review_status','pending') then raise exception 'SOURCE_AUTHORITY_INVALID';end if;
 else raise exception 'SOURCE_SEMANTICS_INVALID';end if;
 if semantics->>'review_status'='confirmed' and new.mandatory is distinct from (semantics->>'authority_status'='confirmed' and semantics->>'authority_role' in ('buyer_rfp','buyer_addendum') and semantics->>'modality' in ('required','prohibited')) then raise exception 'SOURCE_SEMANTICS_CONTRADICTION';end if;
 return new;
end$$;
revoke all on function app_private.guard_requirement_source() from public;
create trigger requirement_source_guard before insert or update on public.requirements for each row execute function app_private.guard_requirement_source();

-- Explicit, preview-bound Owner purge includes review history; ordinary update
-- or delete remains forbidden. The existing confirmation/auth checks run first.
create or replace function app_private.immutable_source_review() returns trigger language plpgsql set search_path='' as $$begin
 if TG_OP='DELETE' and current_setting('app.source_review_purge',true)=old.opportunity_id::text and app_private.member_role(old.workspace_id)='Owner' then return old;end if;
 raise exception 'SOURCE_REVIEW_IMMUTABLE';end$$;
alter function app_private.purge_scope(uuid,uuid) rename to purge_scope_before_source_authority;
create function app_private.purge_scope(w uuid,opp uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$declare result jsonb;part jsonb;t text;begin
 result:=app_private.purge_scope_before_source_authority(w,opp);
 foreach t in array array['source_authority_decisions','source_obligation_reviews'] loop
  execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(r.id order by r.id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(r)::text,'','' order by r.id),''''),''UTF8'')),''hex'')) from public.%I r where workspace_id=$1 and opportunity_id=$2',t) into part using w,opp;
  result:=result||jsonb_build_object(t,part);
 end loop;return result;
end$$;
do $$declare definition text;marker text;constraint_name text;table_name text;role_name text;begin
 select pg_get_functiondef('public.purge_opportunity(uuid,text,text,text,boolean)'::regprocedure) into definition;
 marker:='set constraints all deferred;';
 if position(marker in definition)=0 then raise exception 'SOURCE_REVIEW_PURGE_GUARD_CHANGED';end if;
 definition:=replace(definition,marker,marker||'perform set_config(''app.source_review_purge'',opportunity_id::text,true);');
 marker:='set constraints all immediate;';
 if position(marker in definition)=0 then raise exception 'SOURCE_REVIEW_PURGE_END_CHANGED';end if;
 execute replace(definition,marker,'perform set_config(''app.source_review_purge'','''',true);'||marker);
 for table_name,constraint_name in select c.conrelid::regclass::text,c.conname from pg_constraint c where c.conrelid in ('public.source_authority_decisions'::regclass,'public.source_obligation_reviews'::regclass) and c.confrelid='public.opportunities'::regclass loop
  execute 'alter table '||table_name||' alter constraint '||quote_ident(constraint_name)||' deferrable initially immediate';
 end loop;
 foreach table_name in array array['app_private.purge_scope(uuid,uuid)','app_private.purge_scope_before_source_authority(uuid,uuid)','app_private.guard_requirement_source()'] loop
  execute 'revoke all on function '||table_name||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function '||table_name||' from '||quote_ident(role_name);end if;
  end loop;
 end loop;
end$$;
