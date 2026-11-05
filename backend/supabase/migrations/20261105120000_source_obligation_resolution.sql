-- Resolve exact human-reviewed obligation units, never remove a source passage.
-- Historical immutable reviews, paid contexts, accounting and timestamps stay intact.
alter table public.source_obligation_reviews add column supersedes_review_revision integer check(supersedes_review_revision>0);
create function app_private.pin_source_supersession_revision() returns trigger language plpgsql security definer set search_path='' as $$declare predecessor public.source_obligation_reviews;begin
 if new.supersedes_review_id is null then
  if new.supersedes_review_revision is not null then raise exception 'SOURCE_SUPERSESSION_REVISION_INVALID';end if;
  return new;
 end if;
 -- Restoration imports historical rows without asserting present authority. Its
 -- append-only revoked assurance reset also must not manufacture an old pin.
 if new.status<>'confirmed' or (auth.uid() is not null and app_private.member_role(new.workspace_id)='Owner' and exists(select 1 from public.restore_sessions rs where rs.workspace_id=new.workspace_id and rs.id::text=current_setting('app.source_review_restore',true) and rs.created_by=auth.uid() and rs.state='committing' and rs.expires_at>now())) then return new;end if;
 perform 1 from public.workspaces where id=new.workspace_id for update;
 select * into predecessor from public.source_obligation_reviews where workspace_id=new.workspace_id and opportunity_id=new.opportunity_id and review_id=new.supersedes_review_id order by revision desc limit 1;
 if predecessor.id is null or predecessor.status<>'confirmed' then raise exception 'SOURCE_SUPERSESSION_REVIEW_REQUIRED';end if;
 if new.supersedes_review_revision is not null and new.supersedes_review_revision<>predecessor.revision then raise exception 'SOURCE_SUPERSESSION_REVISION_INVALID';end if;
 new.supersedes_review_revision:=predecessor.revision;return new;
end$$;
create trigger source_supersession_revision before insert on public.source_obligation_reviews for each row execute function app_private.pin_source_supersession_revision();

create function app_private.source_review_value(r public.source_obligation_reviews) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('version',1,'id',r.review_id,'revision',r.revision,'opportunity_id',r.opportunity_id,'spans',r.spans,'semantics',r.semantics,'reason','Current source-bound human interpretation.','status',r.status)
$$;
create function app_private.source_review_is_current(r public.source_obligation_reviews,sources jsonb) returns boolean language plpgsql stable security definer set search_path='' as $$declare span jsonb;source jsonb;begin
 if r.id is null or r.status<>'confirmed' or not app_private.valid_obligation_tuple(r.semantics) then return false;end if;
 for span in select value from jsonb_array_elements(r.spans) loop
  select value into source from jsonb_array_elements(sources) s where s->>'id'=span->>'block_id';
  if source is null or app_private.source_span_from_block(source,(span->>'start')::int,(span->>'end')::int) is distinct from span then return false;end if;
 end loop;
 return true;
exception when sqlstate 'P0001' then return false;end$$;

create function app_private.source_resolution(w uuid,opp uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare active jsonb:='[]';edges jsonb:='[]';unresolved jsonb:='[]';r public.source_obligation_reviews;p public.source_obligation_reviews;latest_predecessor public.source_obligation_reviews;pin integer;reason text;sources jsonb:=app_private.source_review_sources(w,opp);begin
 -- Each edge is a typed review-unit decision. A whole evidence paragraph is
 -- never treated as an atomic replacement range. Latest revoked replacements
 -- remove their own edge; another confirmed edge in a chain stays effective.
 for r in select distinct on(review_id) * from public.source_obligation_reviews where workspace_id=w and opportunity_id=opp order by review_id,revision desc loop
  if r.status<>'confirmed' or r.supersedes_review_id is null then continue;end if;
  reason:=null;pin:=r.supersedes_review_revision;
  select * into latest_predecessor from public.source_obligation_reviews where workspace_id=w and opportunity_id=opp and review_id=r.supersedes_review_id order by revision desc limit 1;
  if pin is null then
   -- No timestamp inference: now() may tie inside a transaction. One immutable
   -- revision is the only legacy history with an unambiguous predecessor.
   if (select count(*) from public.source_obligation_reviews where workspace_id=w and opportunity_id=opp and review_id=r.supersedes_review_id)=1 then pin:=latest_predecessor.revision;
   else reason:='PREDECESSOR_REVISION_UNPINNED';end if;
  end if;
  select * into p from public.source_obligation_reviews where workspace_id=w and opportunity_id=opp and review_id=r.supersedes_review_id and revision=pin;
  if reason is null and (p.id is null or latest_predecessor.revision is distinct from pin or latest_predecessor.status<>'confirmed') then reason:='PREDECESSOR_REVISION_CHANGED';end if;
  if reason is null and (not app_private.source_review_is_current(p,sources) or not app_private.source_review_is_current(r,sources)) then reason:='REVIEW_SOURCE_STALE';end if;
  if reason is null and exists(select 1 from jsonb_array_elements(p.spans) oldspan where not exists(
   select 1 from jsonb_array_elements(r.spans) newspan where newspan#>>'{authority,status}'='confirmed' and newspan#>>'{authority,role}'='buyer_addendum'
    and newspan#>>'{authority,supersedes,entity_id}'=oldspan->>'entity_id' and newspan#>>'{authority,supersedes,content_hash}'=oldspan->>'content_hash')) then reason:='SUPERSESSION_AUTHORITY_INCOMPLETE';end if;
  if reason is null and exists(select 1 from (select distinct on(review_id) * from public.source_obligation_reviews where workspace_id=w and opportunity_id=opp order by review_id,revision desc) other where other.status='confirmed' and other.review_id<>r.review_id and other.supersedes_review_id=r.supersedes_review_id) then reason:='SUPERSESSION_CONFLICT';end if;
  if reason is not null then unresolved:=unresolved||jsonb_build_array(jsonb_build_object('predecessor_review_id',r.supersedes_review_id,'replacement_review_id',r.review_id,'replacement_revision',r.revision,'reason',reason));
  else edges:=edges||jsonb_build_array(jsonb_build_object('predecessor',app_private.source_review_value(p),'replacement',app_private.source_review_value(r)));end if;
 end loop;
 for r in select distinct on(review_id) * from public.source_obligation_reviews where workspace_id=w and opportunity_id=opp order by review_id,revision desc loop
  if app_private.source_review_is_current(r,sources) and not exists(select 1 from jsonb_array_elements(edges) e where e#>>'{predecessor,id}'=r.review_id::text) then active:=active||jsonb_build_array(app_private.source_review_value(r));end if;
 end loop;
 return jsonb_build_object('version',1,'active_reviews',active,'supersessions',edges,'unresolved_edges',unresolved);
end$$;

-- Existing review consumers use the same current edge authority. A replacement
-- with a revoked review no longer hides its predecessor; unresolved historical
-- edges cannot manufacture a confirmed interpretation.
create or replace function app_private.source_obligation_inventory(w uuid,opportunity uuid,review_ids uuid[]) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb:='[]';resolution jsonb;sources jsonb;rid uuid;r public.source_obligation_reviews;semantics jsonb;refs jsonb;body text;begin
 if review_ids is null or cardinality(review_ids)>1000 or cardinality(review_ids)<>(select count(distinct x) from unnest(review_ids) x) then raise exception 'INVALID_SOURCE_INVENTORY';end if;
 resolution:=app_private.source_resolution(w,opportunity);sources:=app_private.source_review_sources(w,opportunity);
 foreach rid in array review_ids loop
  if exists(select 1 from jsonb_array_elements(resolution->'supersessions') e where e#>>'{predecessor,id}'=rid::text) then raise exception 'SOURCE_OBLIGATION_SUPERSEDED';end if;
  if exists(select 1 from jsonb_array_elements(resolution->'unresolved_edges') e where e->>'predecessor_review_id'=rid::text or e->>'replacement_review_id'=rid::text) then raise exception 'SOURCE_RESOLUTION_REVIEW_REQUIRED';end if;
  select * into r from public.source_obligation_reviews where workspace_id=w and opportunity_id=opportunity and review_id=rid order by revision desc limit 1;
  if not app_private.source_review_is_current(r,sources) then raise exception 'SOURCE_SEMANTICS_REVIEW_REQUIRED';end if;
  semantics:=app_private.source_semantics_for_review(r);
  select jsonb_agg(jsonb_build_object('id',value->>'id','quote',value->>'quote') order by n),string_agg(value->>'quote',E'\n[Separate source passage]\n' order by n) into refs,body from jsonb_array_elements(r.spans) with ordinality e(value,n);
  result:=result||jsonb_build_array(jsonb_build_object('id',rid,'text',body,'mandatory',(semantics->>'authority_status'='confirmed' and semantics->>'authority_role' in ('buyer_rfp','buyer_addendum') and semantics->>'modality' in ('required','prohibited')),'source_refs',refs,'source_semantics',semantics,'source_review_reason',r.reason));
 end loop;return result;
end$$;

create or replace function app_private.source_review_evidence(w uuid,opp uuid,sources jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare spans jsonb:='[]';reviews jsonb:='[]';resolution jsonb:=app_private.source_resolution(w,opp);source jsonb;r jsonb;span jsonb;start_at integer;begin
 for source in select value from jsonb_array_elements(sources) loop
  start_at:=0;while start_at<length(source->>'text') loop spans:=spans||jsonb_build_array(app_private.source_span_from_block(source,start_at,least(start_at+1400,length(source->>'text'))));start_at:=start_at+1400;end loop;
 end loop;
 for r in select value from jsonb_array_elements(resolution->'active_reviews') loop
  if exists(select 1 from jsonb_array_elements(resolution->'unresolved_edges') e where e->>'predecessor_review_id'=r->>'id' or e->>'replacement_review_id'=r->>'id') then continue;end if;
  if exists(select 1 from jsonb_array_elements(r->'spans') x where not exists(select 1 from jsonb_array_elements(sources) src where src->>'id'=x->>'block_id' and src#>>'{reference,content_hash}'=x->>'content_hash')) then continue;end if;
  reviews:=reviews||jsonb_build_array(r);
  for span in select value from jsonb_array_elements(r->'spans') loop if not exists(select 1 from jsonb_array_elements(spans) e where e->>'id'=span->>'id') then spans:=spans||jsonb_build_array(span);end if;end loop;
 end loop;
 return jsonb_build_object('version',1,'spans',spans,'reviews',reviews);
end$$;

create function app_private.source_span_contains(container jsonb,contained jsonb) returns boolean language sql immutable set search_path='' as $$
 select container-array['id','start','end','quote'] = contained-array['id','start','end','quote']
 and (container->>'start')::integer <= (contained->>'start')::integer and (container->>'end')::integer >= (contained->>'end')::integer
$$;
create function app_private.source_span_overlaps(a jsonb,b jsonb) returns boolean language sql immutable set search_path='' as $$
 select a-array['id','start','end','quote'] = b-array['id','start','end','quote']
 and (a->>'start')::integer < (b->>'end')::integer and (a->>'end')::integer > (b->>'start')::integer
$$;
create function app_private.source_tuple_has_atoms(tuple jsonb) returns boolean language sql immutable set search_path='' as $$
 select exists(select 1 from unnest(array['quantities','dates','conditions','exceptions','consequences']) key where jsonb_array_length(tuple->key)>0)
$$;
create function app_private.source_tuple_reuses_atom(tuple jsonb,old_tuple jsonb) returns boolean language sql immutable set search_path='' as $$
 select exists(select 1 from unnest(array['quantities','dates','conditions','exceptions','consequences']) key,jsonb_array_elements(tuple->key) x,jsonb_array_elements(old_tuple->key) y where x=y)
$$;
create function app_private.assert_requirement_resolution_current(w uuid,opp uuid,context jsonb,semantics jsonb,refs jsonb,resolution jsonb,sources jsonb) returns void language plpgsql stable security definer set search_path='' as $$
declare selected jsonb:='[]';span jsonb;source jsonb;edge jsonb;tuple jsonb;review jsonb;record public.source_obligation_reviews;active_match boolean:=false;begin
 if context->'source_contract_version' is distinct from '1'::jsonb then return;end if;
 if jsonb_array_length(resolution->'unresolved_edges')>0 then raise exception 'SOURCE_RESOLUTION_REVIEW_REQUIRED';end if;
 if context->'source_resolution_version'='1'::jsonb and context->'source_resolution' is distinct from resolution then raise exception 'SOURCE_RESOLUTION_STALE';end if;
 if semantics is null then raise exception 'SOURCE_SEMANTICS_INVALID';end if;
 for span in select value from jsonb_array_elements(semantics->'source_span_ids') loop
  select value into span from jsonb_array_elements(context#>'{source_evidence,spans}') where value->'id'=span;
  if span is null then raise exception 'SOURCE_SPAN_STALE';end if;
  select value into source from jsonb_array_elements(sources) src where src->>'id'=span->>'block_id';
  if source is null or app_private.source_span_from_block(source,(span->>'start')::int,(span->>'end')::int) is distinct from span then raise exception 'SOURCE_SPAN_STALE';end if;selected:=selected||jsonb_build_array(span);
 end loop;
 if refs is distinct from (select jsonb_agg(jsonb_build_object('id',value->>'id','quote',value->>'quote') order by n) from jsonb_array_elements(selected) with ordinality e(value,n)) then raise exception 'SOURCE_SPAN_TEXT_INVALID';end if;
 tuple:=semantics-array['version','source_span_ids','authority_role','authority_status','review_status','review_id'];
 for review in select value from jsonb_array_elements(resolution->'active_reviews') loop
  if semantics->>'review_status'='confirmed' and semantics->>'review_id'=review->>'id' and review->'spans'=selected then
   record.spans:=review->'spans';record.semantics:=review->'semantics';record.review_id:=(review->>'id')::uuid;
   if semantics=app_private.source_semantics_for_review(record) then return;end if;
  end if;
  if tuple=review->'semantics' and not exists(select 1 from jsonb_array_elements(review->'spans') oldspan where not exists(select 1 from jsonb_array_elements(selected) s where app_private.source_span_contains(s,oldspan))) and not exists(select 1 from jsonb_array_elements(selected) s where not exists(select 1 from jsonb_array_elements(review->'spans') oldspan where app_private.source_span_overlaps(s,oldspan))) then active_match:=true;end if;
 end loop;
 if semantics->>'review_status'='confirmed' then raise exception 'SOURCE_SEMANTICS_STALE';end if;
 for edge in select value from jsonb_array_elements(resolution->'supersessions') loop
  -- Persistence does not accept a caller's deletion audit as authority. A
  -- pending/null-review row cannot launder the exact retired tuple through its
  -- enclosing source chunk, including ambiguous or extra-passage candidates.
  if exists(select 1 from jsonb_array_elements(selected) s,jsonb_array_elements(edge#>'{predecessor,spans}') oldspan where app_private.source_span_overlaps(s,oldspan)) then
   if not app_private.source_tuple_has_atoms(edge#>'{predecessor,semantics}') then raise exception 'SOURCE_OBLIGATION_RESOLUTION_REQUIRED';end if;
   if tuple=edge#>'{predecessor,semantics}' then raise exception 'SOURCE_OBLIGATION_SUPERSEDED';end if;
   if not active_match and app_private.source_tuple_reuses_atom(tuple,edge#>'{predecessor,semantics}') then raise exception 'SOURCE_OBLIGATION_RESOLUTION_REQUIRED';end if;
  end if;
 end loop;
end$$;
create function app_private.assert_requirement_resolution(w uuid,opp uuid,context jsonb,semantics jsonb,refs jsonb) returns void language plpgsql stable security definer set search_path='' as $$begin
 if context->'source_contract_version' is distinct from '1'::jsonb then return;end if;
 perform app_private.assert_requirement_resolution_current(w,opp,context,semantics,refs,app_private.source_resolution(w,opp),app_private.source_review_sources(w,opp));
end$$;
create function app_private.guard_requirement_resolution() returns trigger language plpgsql security definer set search_path='' as $$declare p public.generation_plans;begin
 select * into p from public.generation_plans where workspace_id=new.workspace_id and id=new.plan_id;
 if app_private.restoring_source_history(new.workspace_id,p) then return new;end if;
 perform app_private.assert_requirement_resolution(new.workspace_id,new.opportunity_id,p.frozen_context,new.source_semantics,new.source_refs);return new;
end$$;
create trigger requirement_z_resolution_guard before insert or update on public.requirements for each row execute function app_private.guard_requirement_resolution();

create function app_private.assert_plan_source_resolution(plan_id uuid) returns void language plpgsql stable security definer set search_path='' as $$declare p public.generation_plans;r public.requirements;resolution jsonb;sources jsonb;begin
 select * into p from public.generation_plans where id=plan_id;
 if p.id is null or p.frozen_context->'source_contract_version' is distinct from '1'::jsonb then return;end if;
 resolution:=app_private.source_resolution(p.workspace_id,p.opportunity_id);sources:=app_private.source_review_sources(p.workspace_id,p.opportunity_id);
 if jsonb_array_length(resolution->'unresolved_edges')>0 then raise exception 'SOURCE_RESOLUTION_REVIEW_REQUIRED';end if;
 if p.frozen_context->'source_resolution_version'='1'::jsonb and p.frozen_context->'source_resolution' is distinct from resolution then raise exception 'SOURCE_RESOLUTION_STALE';end if;
 -- Unmarked frozen histories stay byte-identical. Existing supersession scopes
 -- require a new generation rather than retroactive assurance/rewriting.
 if p.frozen_context->'source_resolution_version' is distinct from '1'::jsonb and jsonb_array_length(resolution->'supersessions')>0 then raise exception 'SOURCE_RESOLUTION_REFRESH_REQUIRED';end if;
 for r in select * from public.requirements where workspace_id=p.workspace_id and requirements.plan_id=p.id loop perform app_private.assert_requirement_resolution_current(p.workspace_id,p.opportunity_id,p.frozen_context,r.source_semantics,r.source_refs,resolution,sources);end loop;
end$$;

alter function app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb) rename to draft_generation_snapshot_before_source_resolution;
create function app_private.draft_generation_snapshot(w uuid,opp uuid,proposal uuid,package uuid,prior jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$declare result jsonb;resolution jsonb;review jsonb;span jsonb;begin
 result:=app_private.draft_generation_snapshot_before_source_resolution(w,opp,proposal,package,prior);
 if prior is not null and prior->'source_resolution_version' is distinct from '1'::jsonb then return result;end if;
 resolution:=app_private.source_resolution(w,opp);
 -- A selected-generation budget must not silently lose a reviewed obligation.
 for review in select value from jsonb_array_elements(resolution->'active_reviews') loop
  for span in select value from jsonb_array_elements(review->'spans') loop
   if not exists(select 1 from jsonb_array_elements(coalesce(result->'blocks','[]')||jsonb_build_array(result->'notice')) s where s->>'id'=span->>'block_id' and s#>>'{reference,content_hash}'=span->>'content_hash') then raise exception 'SOURCE_RESOLUTION_SCOPE_INCOMPLETE';end if;
  end loop;
 end loop;
 result:=result||jsonb_build_object('source_resolution_version',1,'source_resolution',resolution);
 if pg_column_size(result)>8388608 then raise exception 'GENERATION_CONTEXT_CAP_REACHED';end if;return result;
end$$;
create or replace function app_private.minimum_generation_executor(context jsonb) returns integer language sql immutable set search_path='' as $$select case when context->'source_resolution_version'='1'::jsonb then 5 when context->'source_contract_version'='1'::jsonb or context->'repair_contract_version'='1'::jsonb then 4 else 1 end$$;

-- Current artifact issuance always rechecks pending as well as confirmed units.
-- Local historical read-only snapshots and stored rows are not rewritten.
alter function public.generated_delivery_context(uuid,uuid) rename to generated_delivery_context_before_source_resolution;
create function public.generated_delivery_context(job_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare result jsonb;p uuid;begin
 result:=public.generated_delivery_context_before_source_resolution(job_id,lease);
 select entity_id into p from public.jobs where id=job_id;perform app_private.assert_plan_source_resolution(p);return result;
end$$;
alter function app_private.delivery_job(uuid,uuid,boolean) rename to delivery_job_before_source_resolution;
create function app_private.delivery_job(job_id uuid,lease uuid,check_sources boolean default true) returns public.jobs language plpgsql security definer set search_path='' as $$declare j public.jobs;p uuid;begin
 j:=app_private.delivery_job_before_source_resolution(job_id,lease,check_sources);
 if check_sources then select plan_id into p from public.proposal_delivery_snapshots where id=j.entity_id;perform app_private.assert_plan_source_resolution(p);end if;return j;
end$$;
alter function app_private.check_export_package(public.export_packages,uuid,boolean) rename to check_export_package_before_source_resolution;
create function app_private.check_export_package(p public.export_packages,actor uuid,check_expiry boolean default true) returns void language plpgsql security definer set search_path='' as $$declare plan uuid;begin
 perform app_private.check_export_package_before_source_resolution(p,actor,check_expiry);
 select plan_id into plan from public.proposal_versions where workspace_id=p.workspace_id and id=p.proposal_version_id;perform app_private.assert_plan_source_resolution(plan);
end$$;

alter function app_private.check_delivery_snapshot(public.proposal_delivery_snapshots,uuid) rename to check_delivery_snapshot_before_source_resolution;
create function app_private.check_delivery_snapshot(snapshot public.proposal_delivery_snapshots,actor uuid) returns void language plpgsql stable security definer set search_path='' as $$begin
 perform app_private.check_delivery_snapshot_before_source_resolution(snapshot,actor);
 if snapshot.payload->'version'='3'::jsonb then perform app_private.assert_plan_source_resolution(snapshot.plan_id);end if;
end$$;
alter function app_private.check_export(public.export_requests,uuid,boolean) rename to check_export_before_source_resolution;
create function app_private.check_export(request public.export_requests,actor uuid,check_expiry boolean default true) returns void language plpgsql security definer set search_path='' as $$declare plan uuid;begin
 perform app_private.check_export_before_source_resolution(request,actor,check_expiry);
 select plan_id into plan from public.proposal_versions where workspace_id=request.workspace_id and id=request.proposal_version_id;perform app_private.assert_plan_source_resolution(plan);
end$$;
alter function public.source_review_context(uuid) rename to source_review_context_before_resolution;
create function public.source_review_context(opportunity_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$declare result jsonb;w uuid;begin
 result:=public.source_review_context_before_resolution(opportunity_id);
 select workspace_id into w from public.opportunities where id=opportunity_id;
 return result||jsonb_build_object('source_resolution_version',1,'source_resolution',app_private.source_resolution(w,opportunity_id));
end$$;
-- New authored adoptions get the same exact resolver pin. Imported/previous
-- adopted plans are never upgraded in place.
do $$declare definition text;marker text:='insert into public.generation_plans(workspace_id,opportunity_id,proposal_id,base_version_id,kind,stage,status,evidence_revision,input_hash,frozen_context,execution_policy,created_by)';begin
 definition:=pg_get_functiondef('public.adopt_authored_response(uuid,uuid,integer,integer,uuid,text)'::regprocedure);
 if position(marker in definition)=0 then raise exception 'SOURCE_RESOLUTION_ADOPTION_CHANGED';end if;
 execute replace(definition,marker,'frozen:=frozen||jsonb_build_object(''source_resolution_version'',1,''source_resolution'',app_private.source_resolution(a.workspace_id,a.opportunity_id)); '||marker);
end$$;

create function app_private.source_resolution_candidate(context jsonb,candidate jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare selected jsonb:='[]';span jsonb;tuple jsonb;edge jsonb;review jsonb;matched jsonb;count_matches integer:=0;active_matches integer:=0;body text;refs jsonb;begin
 tuple:=(candidate->'source_semantics')-array['version','source_span_ids','authority_role','authority_status','review_status','review_id'];
 if not app_private.valid_obligation_tuple(tuple) then raise exception 'SOURCE_SEMANTICS_INVALID';end if;
 for span in select value from jsonb_array_elements(candidate#>'{source_semantics,source_span_ids}') loop
  select value into span from jsonb_array_elements(context#>'{source_evidence,spans}') where value->'id'=span;
  if span is null then raise exception 'SOURCE_SPAN_STALE';end if;selected:=selected||jsonb_build_array(span);
 end loop;
 select jsonb_agg(jsonb_build_object('id',value->>'id','quote',value->>'quote') order by n),string_agg(value->>'quote',E'\n[Separate source passage]\n' order by n) into refs,body from jsonb_array_elements(selected) with ordinality e(value,n);
 if refs is distinct from candidate->'source_refs' or body is distinct from candidate->>'text' then raise exception 'SOURCE_SPAN_TEXT_INVALID';end if;
 for review in select value from jsonb_array_elements(context#>'{source_resolution,active_reviews}') loop
  if tuple=review->'semantics' and candidate#>>'{source_semantics,review_status}'='confirmed' and candidate#>>'{source_semantics,review_id}'=review->>'id' and selected=review->'spans' then return jsonb_build_object('kind','active');end if;
  if tuple=review->'semantics' and app_private.source_tuple_has_atoms(tuple)
   and not exists(select 1 from jsonb_array_elements(review->'spans') oldspan where not exists(select 1 from jsonb_array_elements(selected) s where app_private.source_span_contains(s,oldspan)))
   and not exists(select 1 from jsonb_array_elements(selected) s where not exists(select 1 from jsonb_array_elements(review->'spans') oldspan where app_private.source_span_overlaps(s,oldspan))) then active_matches:=active_matches+1;end if;
 end loop;
 for edge in select value from jsonb_array_elements(context#>'{source_resolution,supersessions}') loop
  review:=edge->'predecessor';
  if not exists(select 1 from jsonb_array_elements(selected) s,jsonb_array_elements(review->'spans') oldspan where app_private.source_span_overlaps(s,oldspan)) then continue;end if;
  if not app_private.source_tuple_has_atoms(review->'semantics') and not (candidate#>>'{source_semantics,review_status}'='confirmed' and candidate#>>'{source_semantics,review_id}'=review->>'id' and selected=review->'spans' and tuple=review->'semantics') then raise exception 'SOURCE_OBLIGATION_RESOLUTION_REQUIRED';end if;
  if tuple=review->'semantics' then
   if exists(select 1 from jsonb_array_elements(review->'spans') oldspan where not exists(select 1 from jsonb_array_elements(selected) s where app_private.source_span_contains(s,oldspan)))
    or exists(select 1 from jsonb_array_elements(selected) s where not exists(select 1 from jsonb_array_elements(review->'spans') oldspan where app_private.source_span_overlaps(s,oldspan))) then raise exception 'SOURCE_OBLIGATION_RESOLUTION_REQUIRED';end if;
   count_matches:=count_matches+1;matched:=edge;
  elsif active_matches=0 and app_private.source_tuple_reuses_atom(tuple,review->'semantics') then raise exception 'SOURCE_OBLIGATION_RESOLUTION_REQUIRED';end if;
 end loop;
 if count_matches>1 or (count_matches>0 and active_matches>0) or active_matches>1 then raise exception 'SOURCE_OBLIGATION_RESOLUTION_REQUIRED';end if;
 if count_matches=1 then return jsonb_build_object('kind','retired','edge',matched);end if;
 if active_matches=1 then return jsonb_build_object('kind','active');end if;
 return jsonb_build_object('kind','preserved');
end$$;
create function app_private.source_review_requirement_id(plan uuid,review jsonb) returns uuid language plpgsql immutable set search_path='' as $$declare hash text;begin
 hash:=encode(sha256(convert_to(plan::text||E'\nsource-obligation-review:'||(review->>'id')||':'||(review->>'revision'),'UTF8')),'hex');
 return (substring(hash,1,8)||'-'||substring(hash,9,4)||'-5'||substring(hash,14,3)||'-a'||substring(hash,18,3)||'-'||substring(hash,21,12))::uuid;
end$$;
create function app_private.validate_source_resolution_inventory(p public.generation_plans,requirements jsonb,provided jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare expected jsonb;retired jsonb:='[]';seeded jsonb:='[]';preserved jsonb:='[]';s public.generation_steps;candidate jsonb;decision jsonb;review jsonb;canonical jsonb;incoming jsonb;record public.source_obligation_reviews;n bigint;id uuid;begin
 if provided is null or jsonb_typeof(provided)<>'object' or (select count(*) from jsonb_object_keys(provided))<>3 or provided->'version' is distinct from '1'::jsonb or jsonb_typeof(provided->'retired') is distinct from 'array' or jsonb_typeof(provided->'seeded') is distinct from 'array' then raise exception 'SOURCE_RESOLUTION_AUDIT_INVALID';end if;
 for s in select * from public.generation_steps where workspace_id=p.workspace_id and plan_id=p.id and task='analyze_chunk' and status='completed' order by ordinal loop
  for candidate,n in select value,ordinality-1 from jsonb_array_elements(s.output->'requirements') with ordinality loop
   decision:=app_private.source_resolution_candidate(p.frozen_context,candidate);
   if decision->>'kind'='retired' then
    retired:=retired||jsonb_build_array(jsonb_build_object('step_id',s.id,'requirement_index',n,'predecessor_review_id',decision#>>'{edge,predecessor,id}','predecessor_revision',decision#>'{edge,predecessor,revision}','replacement_review_id',decision#>>'{edge,replacement,id}','replacement_revision',decision#>'{edge,replacement,revision}'));
   elsif decision->>'kind'='preserved' then
    preserved:=preserved||jsonb_build_array(candidate);
    if not exists(select 1 from jsonb_array_elements(requirements) r where r-'id'=candidate-'id') then raise exception 'SOURCE_RESOLUTION_INVENTORY_INCOMPLETE';end if;
   end if;
  end loop;
 end loop;
 for review in select value from jsonb_array_elements(p.frozen_context#>'{source_resolution,active_reviews}') loop
  id:=app_private.source_review_requirement_id(p.id,review);
  record.spans:=review->'spans';record.semantics:=review->'semantics';record.review_id:=(review->>'id')::uuid;
  canonical:=jsonb_build_object('source_semantics',app_private.source_semantics_for_review(record),'source_refs',(select jsonb_agg(jsonb_build_object('id',value->>'id','quote',value->>'quote') order by ordinality) from jsonb_array_elements(record.spans) with ordinality),'text',(select string_agg(value->>'quote',E'\n[Separate source passage]\n' order by ordinality) from jsonb_array_elements(record.spans) with ordinality));
  canonical:=canonical||jsonb_build_object('mandatory',canonical#>>'{source_semantics,authority_status}'='confirmed' and canonical#>>'{source_semantics,authority_role}' in ('buyer_rfp','buyer_addendum') and canonical#>>'{source_semantics,modality}' in ('required','prohibited'));
  select value into incoming from jsonb_array_elements(requirements) r where r->>'id'=id::text;
  if incoming is null or incoming->'source_refs' is distinct from canonical->'source_refs' or incoming->'source_semantics' is distinct from canonical->'source_semantics' or incoming->'text' is distinct from canonical->'text' or incoming->'mandatory' is distinct from canonical->'mandatory' then raise exception 'SOURCE_RESOLUTION_ACTIVE_UNIT_MISSING';end if;
  seeded:=seeded||jsonb_build_array(jsonb_build_object('review_id',review->>'id','revision',review->'revision','requirement_id',id));
 end loop;
 for incoming in select value from jsonb_array_elements(requirements) loop
  if not exists(select 1 from jsonb_array_elements(seeded) r where r->>'requirement_id'=incoming->>'id') and not exists(select 1 from jsonb_array_elements(preserved) r where r-'id'=incoming-'id') then raise exception 'SOURCE_RESOLUTION_INVENTORY_INVALID';end if;
 end loop;
 expected:=jsonb_build_object('version',1,'retired',retired,'seeded',seeded);
 if jsonb_array_length(provided->'retired')<>jsonb_array_length(retired) or not (provided->'retired' @> retired and retired @> (provided->'retired'))
  or jsonb_array_length(provided->'seeded')<>jsonb_array_length(seeded) or not (provided->'seeded' @> seeded and seeded @> (provided->'seeded')) then raise exception 'SOURCE_RESOLUTION_AUDIT_INVALID';end if;
 return expected;
end$$;
alter function public.advance_generation(uuid,uuid,text,jsonb,jsonb,jsonb) rename to advance_generation_before_source_resolution;
do $$declare definition text;begin definition:=pg_get_functiondef('public.advance_generation_before_source_resolution(uuid,uuid,text,jsonb,jsonb,jsonb)'::regprocedure);execute replace(definition,'advance_generation.','advance_generation_before_source_resolution.');end$$;
create function public.advance_generation(job_id uuid,lease uuid,next_stage text,requirements jsonb,steps jsonb,final_result jsonb default null) returns void language plpgsql security definer set search_path='' as $$
declare ctx jsonb;p public.generation_plans;step_id uuid;audit jsonb;begin
 -- The canonical lease/auth/workspace checks run before inspecting private plan
 -- rows; the existing delegate still owns stage, persistence and accounting.
 ctx:=public.generation_context(job_id,lease);
 select * into p from public.generation_plans where id=(ctx#>>'{plan,id}')::uuid;
 perform app_private.assert_plan_source_resolution(p.id);
 if p.stage='analysis' and p.frozen_context->'source_resolution_version'='1'::jsonb then
  audit:=app_private.validate_source_resolution_inventory(p,requirements,final_result->'source_resolution_dispositions');
  step_id:=(ctx#>>'{step,id}')::uuid;
 end if;
 perform public.advance_generation_before_source_resolution(job_id,lease,next_stage,requirements,steps,final_result);
 if audit is not null then update public.generation_steps set output=output||jsonb_build_object('source_resolution_dispositions',audit) where id=step_id and workspace_id=p.workspace_id;end if;
end$$;

-- A fresh retry authorization may not recommit an unmarked old inventory.
-- Existing idempotent receipts are returned unchanged by the original command.
alter function app_private.app_command(text,jsonb,text) rename to app_command_before_source_resolution;
do $$declare definition text;begin definition:=pg_get_functiondef('app_private.app_command_before_source_resolution(text,jsonb,text)'::regprocedure);execute replace(definition,'app_command.','app_command_before_source_resolution.');end$$;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$declare p public.generation_plans;replay app_private.idempotency_records;proposal public.proposals;opportunity public.opportunities;begin
 if operation='generation.retry' then select * into p from public.generation_plans where id=(input->>'id')::uuid;
 elsif operation='job.action' and input->>'action'='retry' then select plan.* into p from public.generation_plans plan join public.generation_steps step on step.plan_id=plan.id where step.job_id=(input->>'id')::uuid;
 elsif operation='proposal.generate' then select * into p from public.generation_plans where opportunity_id=(input->>'id')::uuid and kind='proposal' and status in ('queued','running','blocked') order by created_at desc limit 1;
 elsif operation='proposal.regenerate' then select * into p from public.generation_plans where proposal_id=(input->>'id')::uuid and kind='proposal' and status in ('queued','running','blocked') order by created_at desc limit 1;end if;
 if p.id is not null and app_private.member_role(p.workspace_id) in ('Owner','Editor') then
  perform 1 from public.workspaces where id=p.workspace_id for update;
  select * into p from public.generation_plans where id=p.id;
  select * into replay from app_private.idempotency_records where workspace_id=p.workspace_id and actor_id=auth.uid() and method='COMMAND' and route=operation and key=idempotency_key and expires_at>now();
  if replay.key is null then
   begin perform app_private.assert_plan_source_resolution(p.id);
   exception when sqlstate 'P0001' then
    if sqlerrm<>'SOURCE_RESOLUTION_REFRESH_REQUIRED' or p.kind<>'proposal' then raise;end if;
    select * into proposal from public.proposals where id=p.proposal_id;
    select * into opportunity from public.opportunities where id=p.opportunity_id;
    raise exception using message='PROPOSAL_CURRENT_CONTRACT_REQUIRED',detail=jsonb_build_object(
     'plan_id',p.id,'expected_plan_revision',p.revision,'preserved_input_hash',p.input_hash,
     'cancel_required',p.status in ('queued','running','blocked'),
     'opportunity_id',p.opportunity_id,'expected_opportunity_revision',opportunity.revision,
     'proposal_id',p.proposal_id,'expected_proposal_revision',proposal.revision,
     'base_version_id',proposal.active_version_id,
     'next_operation',case when proposal.active_version_id is null then 'proposal.generate' else 'proposal.regenerate' end)::text;
   end;
  end if;
 end if;
 return app_private.app_command_before_source_resolution(operation,input,idempotency_key);
end$$;

-- No private resolver is a new RPC/role authorization surface.
do $$declare signature text;role_name text;begin
 for signature in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where
  (n.nspname='app_private' and p.proname in ('pin_source_supersession_revision','source_review_value','source_review_is_current','source_resolution','source_obligation_inventory','source_review_evidence','source_span_contains','source_span_overlaps','assert_requirement_resolution','guard_requirement_resolution','assert_plan_source_resolution','draft_generation_snapshot_before_source_resolution','draft_generation_snapshot','minimum_generation_executor','delivery_job_before_source_resolution','delivery_job','check_export_package_before_source_resolution','check_export_package','check_delivery_snapshot_before_source_resolution','check_delivery_snapshot','check_export_before_source_resolution','check_export','source_resolution_candidate','source_tuple_has_atoms','source_tuple_reuses_atom','assert_requirement_resolution_current','source_review_requirement_id','validate_source_resolution_inventory','app_command_before_source_resolution','app_command'))
  or (n.nspname='public' and p.proname in ('generated_delivery_context_before_source_resolution','generated_delivery_context','source_review_context_before_resolution','source_review_context','advance_generation_before_source_resolution','advance_generation')) loop
  execute 'revoke all on function '||signature||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function '||signature||' from '||quote_ident(role_name);end if;
  end loop;
 end loop;
 foreach role_name in array array['authenticated','tdp_app_authenticated'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute 'grant execute on function public.source_review_context(uuid),app_private.app_command(text,jsonb,text) to '||quote_ident(role_name);end if;
 end loop;
 foreach role_name in array array['service_role','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute 'grant execute on function public.generated_delivery_context(uuid,uuid),public.advance_generation(uuid,uuid,text,jsonb,jsonb,jsonb) to '||quote_ident(role_name);end if;
 end loop;
end$$;
