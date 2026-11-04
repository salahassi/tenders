-- Preserve readable pages without asserting that unread pages contain no work.
-- Existing finalized originals, paid snapshots and their input identities stay immutable.
alter table public.documents add column extraction_coverage jsonb;
alter table public.documents drop constraint documents_status_check;
alter table public.documents add constraint documents_status_check
 check(status in ('pending','ready','partial','needs_ocr','needs_processing','error','expired'));

create function app_private.valid_document_coverage(coverage jsonb,extraction_text text,extraction_status text,actual_pages integer)
returns boolean language plpgsql immutable set search_path='' as $$
declare page jsonb;index integer:=0;readable boolean:=false;unread boolean:=false;failed boolean:=false;complete boolean:=true;parts text[];numbers text[];characters integer;expected text;
begin
 if coverage is null or jsonb_typeof(coverage)<>'object' or pg_column_size(coverage)>65536
  or (select count(*) from jsonb_object_keys(coverage))<>4 or not coverage ?& array['version','kind','complete','pages'] or coverage->'version' is distinct from '1'::jsonb
  or coverage->>'kind' is distinct from 'pdf_pages' or jsonb_typeof(coverage->'complete')<>'boolean'
  or jsonb_typeof(coverage->'pages')<>'array' then return false;end if;
 if actual_pages is null or actual_pages not between 1 and 200 or jsonb_array_length(coverage->'pages')<>actual_pages then return false;end if;
 if extraction_text !~ '^\[Page 1\]' then return false;end if;
 parts:=regexp_split_to_array(extraction_text,E'(?n)^\\[Page [0-9]+\\]\\n');
 select array_agg(m[1]) into numbers from regexp_matches(extraction_text,E'(?n)^\\[Page ([0-9]+)\\]\\n','g') m;
 if array_length(parts,1)<>actual_pages+1 or coalesce(array_length(numbers,1),0)<>actual_pages then return false;end if;
 for page in select value from jsonb_array_elements(coverage->'pages') loop
  index:=index+1;
  if jsonb_typeof(page)<>'object' or (select count(*) from jsonb_object_keys(page))<>3
   or not page ?& array['page','status','characters'] or jsonb_typeof(page->'status')<>'string'
   or jsonb_typeof(page->'page')<>'number' or page->>'page'<>index::text or numbers[index]<>index::text
   or page->>'status' not in ('readable','blank','needs_ocr','extraction_failed')
   or jsonb_typeof(page->'characters')<>'number' or page->>'characters' !~ '^[0-9]+$' then return false;end if;
  characters:=length(regexp_replace(parts[index+1],'^\s+|\s+$','','g'));
  if characters::text<>page->>'characters' or (page->>'status'='readable')<>(characters>0) then return false;end if;
  readable:=readable or page->>'status'='readable';
  unread:=unread or page->>'status'='needs_ocr';
  failed:=failed or page->>'status'='extraction_failed';
  complete:=complete and page->>'status' in ('readable','blank');
 end loop;
 expected:=case when readable then case when complete then 'ready' else 'partial' end when unread then 'needs_ocr' when failed then 'error' else 'needs_processing' end;
 return coverage->'complete'=to_jsonb(complete) and (extraction_status=expected or extraction_status='expired');
exception when others then return false;
end $$;
do $role_acl$ declare role_name text;begin
 revoke all on function app_private.valid_document_coverage(jsonb,text,text,integer) from public;
 foreach role_name in array array['anon','tdp_app_anon','authenticated','tdp_app_authenticated','service_role','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function app_private.valid_document_coverage(jsonb,text,text,integer) from '||quote_ident(role_name);end if;
 end loop;
end $role_acl$;
alter table public.documents add constraint valid_extraction_coverage
 check((extraction_coverage is null and status<>'partial') or
  (status='pending' and jsonb_typeof(extraction_coverage)='object' and pg_column_size(extraction_coverage)<=65536) or
  (mime_type='application/pdf' and app_private.valid_document_coverage(extraction_coverage,extracted_text,status,pdf_pages)));

-- Extend only the accepted-original status vocabulary. Coverage is stored in
-- the same transaction before the old membership/idempotency/integrity checks.
do $$ declare definition text;old text;begin
 select pg_get_functiondef('public.accept_uploaded_document_v1(uuid,uuid,text,bigint,text,text,text)'::regprocedure) into definition;
 old:=$old$extraction_status not in ('ready','needs_ocr','needs_processing','error')$old$;
 if position(old in definition)=0 then raise exception 'PARTIAL_UPLOAD_STATUS_GUARD_CHANGED';end if;
 execute replace(definition,old,$new$extraction_status not in ('ready','partial','needs_ocr','needs_processing','error')$new$);
end $$;

create function public.accept_uploaded_document_with_coverage(document_id uuid,actor_id uuid,actual_hash text,actual_size bigint,extraction_text text,extraction_status text,command_key text,coverage jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d public.documents;answer jsonb;
begin
 select * into d from public.documents where id=document_id;
 if d.id is null then raise exception 'NOT_FOUND';end if;
 perform 1 from public.workspaces where id=d.workspace_id for update;
 select * into d from public.documents where id=document_id for update;
 if d.mime_type<>'application/pdf' or not app_private.valid_document_coverage(coverage,extraction_text,extraction_status,d.pdf_pages) then raise exception 'INVALID_EXTRACTION_COVERAGE';end if;
 if d.status<>'pending' and d.extraction_coverage is distinct from coverage then raise exception 'IDEMPOTENCY_CONFLICT';end if;
 -- Metadata and accepted bytes commit atomically. A failed membership,
 -- integrity or idempotency check rolls back this pending-row update.
 if d.status='pending' then
  update public.documents set extraction_coverage=coverage where id=document_id;
 end if;
 answer:=public.accept_uploaded_document(document_id,actor_id,actual_hash,actual_size,extraction_text,extraction_status,command_key);
 select to_jsonb(x) into answer from public.documents x where id=document_id;
 return answer;
end $$;

do $role_acl$ declare role_name text;begin
 revoke all on function public.accept_uploaded_document_with_coverage(uuid,uuid,text,bigint,text,text,text,jsonb) from public;
 foreach role_name in array array['anon','tdp_app_anon','authenticated','tdp_app_authenticated'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function public.accept_uploaded_document_with_coverage(uuid,uuid,text,bigint,text,text,text,jsonb) from '||quote_ident(role_name);end if;
 end loop;
end $role_acl$;
do $role_acl$ declare role_name text;begin
 foreach role_name in array array['service_role','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute 'grant execute on function public.accept_uploaded_document_with_coverage(uuid,uuid,text,bigint,text,text,text,jsonb) to '||quote_ident(role_name);end if;
 end loop;
end $role_acl$;

-- Current source authorization can read the useful text of a partial source;
-- it still checks workspace, current hash, archival and requested-use policy.
do $$ declare definition text;old text;begin
 select pg_get_functiondef('app_private.content_record(uuid,text,uuid)'::regprocedure) into definition;
 old:=$old$status='ready' and not archived$old$;
 if position(old in definition)=0 then raise exception 'PARTIAL_CONTENT_RECORD_GUARD_CHANGED';end if;
 execute replace(definition,old,$new$status in ('ready','partial') and not archived$new$);
end $$;

alter function app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb) rename to draft_generation_snapshot_before_page_coverage;
do $role_acl$ declare role_name text;begin
 revoke all on function app_private.draft_generation_snapshot_before_page_coverage(uuid,uuid,uuid,uuid,jsonb) from public;
 foreach role_name in array array['anon','tdp_app_anon','authenticated','tdp_app_authenticated','service_role','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function app_private.draft_generation_snapshot_before_page_coverage(uuid,uuid,uuid,uuid,jsonb) from '||quote_ident(role_name);end if;
 end loop;
end $role_acl$;
create function app_private.draft_generation_snapshot(w uuid,opp uuid,proposal uuid,package uuid,prior jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;all_blocks jsonb;blocks jsonb;materials jsonb;partial_reviews jsonb;notice_fallback boolean;
begin
 result:=app_private.draft_generation_snapshot_before_page_coverage(w,opp,proposal,package,prior);
 -- Paid old plans retain their exact selected evidence and snapshot shape.
 if prior is not null and prior->'extraction_coverage_version' is distinct from '1'::jsonb then return result;end if;
 all_blocks:=app_private.generation_snapshot(w,opp,null,package)->'blocks';
 select coalesce(jsonb_agg(e.value order by e.ord),'[]') into blocks
 from jsonb_array_elements(all_blocks) with ordinality e(value,ord)
 join public.documents d on d.workspace_id=w and d.id=(e.value->>'document_id')::uuid
 where d.opportunity_id=opp and d.kind='rfp' and d.status in ('ready','partial') and not d.archived
  and (prior is null or exists(select 1 from jsonb_array_elements(prior->'blocks') old where old->>'id'=e.value->>'id'));
 select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'text',b.text,'kind','review','verified',false,
   'target_kind',r.target_kind,'target_id',r.target_id,
   'reference',jsonb_build_object('entity_kind','document','entity_id',d.id,'content_hash',d.extraction_hash)) order by r.id,d.id,b.ordinal),'[]') into partial_reviews
 from public.review_inputs r join public.proposals p on p.workspace_id=r.workspace_id and p.id=r.proposal_id and p.active_version_id=r.base_version_id
 join public.documents d on d.workspace_id=r.workspace_id and d.review_input_id=r.id and d.kind='review' and d.status='partial' and not d.archived
 join public.document_blocks b on b.workspace_id=d.workspace_id and b.document_id=d.id
 where r.workspace_id=w and r.proposal_id=proposal
  and (prior is null or exists(select 1 from jsonb_array_elements(prior->'reviews') old where old->>'id'=b.id::text));
 result:=jsonb_set(result,'{reviews}',coalesce(result->'reviews','[]')||partial_reviews);
 if prior is null then
  notice_fallback:=jsonb_array_length(blocks)=0;
  select coalesce(jsonb_agg(case when d.id is null then e.value else e.value||jsonb_strip_nulls(jsonb_build_object(
    'used_for_draft',d.status in ('ready','partial') and exists(select 1 from public.document_blocks b where b.document_id=d.id and length(trim(b.text))>0),
    'extracted_characters',case when d.status in ('ready','partial') then length(d.extracted_text) else 0 end,
    'extraction_coverage',d.extraction_coverage)) end order by e.ord),'[]') into materials
  from jsonb_array_elements(result#>'{input_materials,documents}') with ordinality e(value,ord)
  left join public.documents d on d.workspace_id=w and d.id=(e.value->>'document_id')::uuid;
  result:=jsonb_set(result,'{input_materials,documents}',materials);
  result:=jsonb_set(result,'{input_materials,uses_notice_fallback}',to_jsonb(notice_fallback));
 else notice_fallback:=coalesce((prior#>>'{input_materials,uses_notice_fallback}')::boolean,false);end if;
 if notice_fallback then blocks:=jsonb_build_array(result->'notice');end if;
 result:=result||jsonb_build_object('blocks',blocks,'extraction_coverage_version',1);
 if pg_column_size(result)>8388608 then raise exception 'GENERATION_CONTEXT_CAP_REACHED';end if;
 return result;
end $$;
do $role_acl$ declare role_name text;begin
 revoke all on function app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb) from public;
 foreach role_name in array array['anon','tdp_app_anon','authenticated','tdp_app_authenticated','service_role','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb) from '||quote_ident(role_name);end if;
 end loop;
end $role_acl$;

do $$ declare role_name text;begin
 foreach role_name in array array['tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then
   execute 'revoke all on function public.accept_uploaded_document_with_coverage(uuid,uuid,text,bigint,text,text,text,jsonb) from '||quote_ident(role_name);
   if role_name='tdp_app_service' then execute 'grant execute on function public.accept_uploaded_document_with_coverage(uuid,uuid,text,bigint,text,text,text,jsonb) to '||quote_ident(role_name);end if;
  end if;
 end loop;
end $$;
