-- Private uploaded OCR uses the existing offline native engine. Finalized
-- sources remain immutable; publication creates a separately verified successor.
alter table public.documents add column ocr_parent_document_id uuid,
 add column ocr_successor_id uuid, add column ocr_status text,
 add column ocr_provenance jsonb;
alter table public.documents add constraint ocr_parent_same_workspace foreign key(workspace_id,ocr_parent_document_id) references public.documents(workspace_id,id) deferrable initially immediate,
 add constraint ocr_successor_same_workspace foreign key(workspace_id,ocr_successor_id) references public.documents(workspace_id,id) deferrable initially immediate,
 add constraint ocr_status_valid check(ocr_status is null or ocr_status in ('queued','running','retry_wait','blocked','needs_review','published'));
create table public.document_ocr_requests(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,document_id uuid not null,
 original_hash text not null,base_extraction_hash text not null,engine_policy integer not null default 1 check(engine_policy in (1,2)),
 status text not null default 'queued' check(status in ('queued','running','retry_wait','blocked','needs_review','published','superseded')),
 active_page integer,lease_token uuid,lease_until timestamptz,next_attempt_at timestamptz not null default now(),
 publish_attempts integer not null default 0,successor_id uuid,output_hash text,error_code text,
 created_by uuid not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
 unique(workspace_id,id),
 foreign key(workspace_id,document_id) references public.documents(workspace_id,id) on delete cascade deferrable initially immediate,
 foreign key(workspace_id,successor_id) references public.documents(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,created_by) references public.workspace_actors(workspace_id,id) deferrable initially immediate
);
create unique index document_ocr_request_identity on public.document_ocr_requests(workspace_id,document_id,engine_policy) where status<>'superseded';
create table public.document_ocr_pages(
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,request_id uuid not null,page integer not null check(page between 1 and 200),
 status text not null default 'queued' check(status in ('queued','ready','needs_review','blocked')),
 attempts integer not null default 0,receipt jsonb,receipt_hash text,error_code text,
 completed_lease uuid,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
 unique(workspace_id,id),unique(request_id,page),
 foreign key(workspace_id,request_id) references public.document_ocr_requests(workspace_id,id) on delete cascade deferrable initially immediate,
 check(receipt is null or pg_column_size(receipt)<=131072)
);
create index document_ocr_due on public.document_ocr_requests(next_attempt_at,created_at) where status in ('queued','retry_wait','running');
alter table public.document_ocr_requests enable row level security;
alter table public.document_ocr_pages enable row level security;
revoke all on public.document_ocr_requests,public.document_ocr_pages from public;


create function app_private.current_document_extraction(w uuid,document_id uuid) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare d public.documents;seen uuid[]:='{}';begin
 loop
  select * into d from public.documents where workspace_id=w and id=document_id;
  if d.id is null or d.id=any(seen) then raise exception 'STALE_INPUT';end if;
  seen:=seen||d.id;
  if d.ocr_successor_id is null then return d.id;end if;
  if not exists(select 1 from public.documents n where n.workspace_id=w and n.id=d.ocr_successor_id and n.ocr_parent_document_id=d.id and n.status not in ('pending','expired') and n.extraction_hash is not null and n.original_hash=d.original_hash and n.uploaded_size=n.expected_size and not n.archived)
   then return d.id;end if;
  document_id:=d.ocr_successor_id;
 end loop;
end $$;
create function app_private.document_page_reviewer_current(d public.documents,reviewer text) returns boolean
language plpgsql stable security definer set search_path='' as $$begin
 if reviewer is null or reviewer!~'^[0-9a-f-]{36}$' then return false;end if;
 return exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id
  where m.workspace_id=d.workspace_id and m.user_id=reviewer::uuid and m.active and a.status='active'
  and (m.role in ('Owner','Editor') or (m.role='Reviewer' and d.kind='review' and exists(select 1 from public.review_inputs x where x.id=d.review_input_id and x.created_by=m.user_id))));
end $$;

create function app_private.check_uploaded_ocr_source(r public.document_ocr_requests) returns public.documents
language plpgsql stable security definer set search_path='' as $$
declare d public.documents;begin
 select * into d from public.documents where id=r.document_id and workspace_id=r.workspace_id;
 if d.id is null or d.archived or d.status in ('pending','expired') or d.original_hash is distinct from r.original_hash or d.extraction_hash is distinct from r.base_extraction_hash
  or d.mime_type<>'application/pdf' or d.pdf_pages is null or d.pdf_pages not between 1 and 200 or d.uploaded_size is distinct from d.expected_size
  or (d.ocr_successor_id is not null and d.ocr_successor_id is distinct from r.successor_id)
  then raise exception 'STALE_INPUT';end if;
 if not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id
  where m.workspace_id=r.workspace_id and m.user_id=r.created_by and m.active and a.status='active'
   and (m.role in ('Owner','Editor') or (m.role='Reviewer' and d.kind='review' and exists(select 1 from public.review_inputs x where x.id=d.review_input_id and x.created_by=r.created_by)))) then raise exception 'ROLE_FORBIDDEN';end if;
 if d.kind='rfp' and not exists(select 1 from public.opportunities o where o.id=d.opportunity_id and o.workspace_id=d.workspace_id and not o.archived) then raise exception 'STALE_INPUT';end if;
 if d.kind='review' and not exists(select 1 from public.review_inputs x join public.proposals p on p.id=x.proposal_id join public.opportunities o on o.id=p.opportunity_id
  where x.id=d.review_input_id and not o.archived and p.active_version_id=x.base_version_id) then raise exception 'STALE_INPUT';end if;
 if exists(select 1 from public.restore_sessions where workspace_id=r.workspace_id and state in ('staging','committing')) then raise exception 'RESTORE_IN_PROGRESS';end if;
 return d;
end $$;
-- Legacy image-only PDFs have no page coverage. Derive an unresolved baseline
-- from their verified page count without editing the old extraction/hash. A
-- legacy nonempty text must retain exact page anchors; never guess its order.
create function app_private.uploaded_ocr_baseline(d public.documents) returns public.documents
language plpgsql immutable set search_path='' as $$
declare parts text[];page_number integer;page_text text;pages jsonb:='[]';complete boolean:=true;begin
 if d.extraction_coverage is not null then return d;end if;
 if d.pdf_pages is null or d.pdf_pages not between 1 and 200 then raise exception 'DOCUMENT_PAGE_REVIEW_UNAVAILABLE';end if;
 if length(trim(coalesce(d.extracted_text,'')))=0 then
  select string_agg('[Page '||n::text||E']\n',E'\n\n' order by n) into d.extracted_text from generate_series(1,d.pdf_pages) n;
 end if;
 parts:=regexp_split_to_array(d.extracted_text,E'(?n)^\\[Page [0-9]+\\]\\n');
 if array_length(parts,1)<>d.pdf_pages+1 then raise exception 'DOCUMENT_PAGE_REVIEW_UNAVAILABLE';end if;
 for page_number in 1..d.pdf_pages loop
  page_text:=regexp_replace(parts[page_number+1],'^\s+|\s+$','','g');
  pages:=pages||jsonb_build_array(jsonb_build_object('page',page_number,'status',case when length(page_text)>0 then 'readable' else 'needs_ocr' end,'characters',length(page_text)));
  complete:=complete and length(page_text)>0;
 end loop;
 d.extraction_coverage:=jsonb_build_object('version',1,'kind','pdf_pages','complete',complete,'pages',pages);
 return d;
end $$;

create function app_private.enqueue_uploaded_ocr(target_document_id uuid,actor uuid) returns public.document_ocr_requests
language plpgsql security definer set search_path='' as $$
declare d public.documents;r public.document_ocr_requests;p jsonb;begin
 select * into d from public.documents where id=target_document_id;
 if d.id is null or d.mime_type<>'application/pdf' or d.pdf_pages is null or d.pdf_pages not between 1 and 200 or d.status not in ('partial','needs_ocr','error') or d.archived or d.extraction_hash is null then return null;end if;
 begin d:=app_private.uploaded_ocr_baseline(d);exception when others then return null;end;
 if not exists(select 1 from jsonb_array_elements(d.extraction_coverage->'pages') v where v->>'status' in ('needs_ocr','extraction_failed')) then return null;end if;
 insert into public.document_ocr_requests(workspace_id,document_id,original_hash,base_extraction_hash,created_by)
 values(d.workspace_id,d.id,d.original_hash,d.extraction_hash,actor) on conflict(workspace_id,document_id,engine_policy) where status<>'superseded' do nothing;
 select * into r from public.document_ocr_requests where workspace_id=d.workspace_id and document_ocr_requests.document_id=d.id and engine_policy=1 and status<>'superseded';
 perform app_private.check_uploaded_ocr_source(r);
 for p in select value from jsonb_array_elements(d.extraction_coverage->'pages') where value->>'status' in ('needs_ocr','extraction_failed') loop
  insert into public.document_ocr_pages(workspace_id,request_id,page) values(d.workspace_id,r.id,(p->>'page')::integer) on conflict(request_id,page) do nothing;
 end loop;
 update public.documents set ocr_status=r.status where id=d.id and ocr_status is distinct from r.status;
 return r;
end $$;
alter function public.accept_uploaded_document_with_coverage(uuid,uuid,text,bigint,text,text,text,jsonb) rename to accept_uploaded_document_before_ocr;
create function public.accept_uploaded_document_with_coverage(document_id uuid,actor_id uuid,actual_hash text,actual_size bigint,extraction_text text,extraction_status text,command_key text,coverage jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 result:=public.accept_uploaded_document_before_ocr(document_id,actor_id,actual_hash,actual_size,extraction_text,extraction_status,command_key,coverage);
 if result->>'ocr_parent_document_id' is null then perform app_private.enqueue_uploaded_ocr(document_id,actor_id);end if;
 return (select to_jsonb(d) from public.documents d where id=document_id);
end $$;

create function public.claim_uploaded_document_ocr() returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.document_ocr_requests;d public.documents;p public.document_ocr_pages;failure text;begin
 for r in select * from public.document_ocr_requests where
  (status in ('queued','retry_wait') and next_attempt_at<=now()) or (status='running' and (lease_until is null or lease_token is null or lease_until<=now()))
  order by next_attempt_at,created_at,id limit 100 loop
  perform 1 from public.workspaces where id=r.workspace_id for update;
  select * into r from public.document_ocr_requests where id=r.id for update skip locked;
  if r.id is null or not ((r.status in ('queued','retry_wait') and r.next_attempt_at<=now()) or (r.status='running' and (r.lease_until is null or r.lease_token is null or r.lease_until<=now()))) then continue;end if;
  begin d:=app_private.check_uploaded_ocr_source(r);
  exception when others then
   failure:=case when sqlerrm in ('ROLE_FORBIDDEN','STALE_INPUT','RESTORE_IN_PROGRESS') then sqlerrm else 'DOCUMENT_OCR_FAILED' end;
   update public.document_ocr_requests set status='blocked',error_code=failure,lease_token=null,lease_until=null,updated_at=now(),revision=revision+1 where id=r.id;
   update public.documents set ocr_status='blocked' where id=r.document_id;continue;
  end;
  if r.status='running' and r.active_page is not null then
   update public.document_ocr_pages set status=case when attempts>=5 then 'blocked' else 'queued' end,error_code='DOCUMENT_OCR_WORKER_RESTARTED',updated_at=now(),revision=revision+1 where request_id=r.id and page=r.active_page;
  end if;
  select * into p from public.document_ocr_pages where request_id=r.id and status='queued' order by page limit 1 for update;
  if p.id is null and r.publish_attempts>=5 then
   update public.document_ocr_requests set status='blocked',error_code='DOCUMENT_OCR_RETRY_EXHAUSTED',lease_token=null,lease_until=null,active_page=null,updated_at=now(),revision=revision+1 where id=r.id;
   update public.documents set ocr_status='blocked' where id=d.id;continue;
  end if;
  if p.id is null and not exists(select 1 from public.document_ocr_pages where request_id=r.id and status='ready') then
   update public.document_ocr_requests set status='needs_review',error_code='DOCUMENT_OCR_REVIEW_REQUIRED',lease_token=null,lease_until=null,active_page=null,updated_at=now(),revision=revision+1 where id=r.id;
   update public.documents set ocr_status='needs_review' where id=d.id;continue;
  end if;
  if p.id is not null then update public.document_ocr_pages set attempts=attempts+1,updated_at=now(),revision=revision+1 where id=p.id;end if;
  update public.document_ocr_requests set status='running',active_page=p.page,lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',
   publish_attempts=publish_attempts+case when p.id is null then 1 else 0 end,error_code=null,updated_at=now(),revision=revision+1 where id=r.id returning * into r;
  update public.documents set ocr_status='running' where id=d.id;
  return jsonb_build_object('request_id',r.id,'lease',r.lease_token,'action',case when p.id is null then 'publish' else 'page' end,
   'document_id',d.id,'original_hash',d.original_hash,'total_pages',d.pdf_pages,'page',p.page,
   'language',coalesce((select language from public.opportunities where id=d.opportunity_id),'auto'));
 end loop;
 return null;
end $$;
create function public.uploaded_document_ocr_context(request_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.document_ocr_requests;d public.documents;begin
 select * into r from public.document_ocr_requests where id=request_id;
 if r.id is null then raise exception 'NOT_FOUND';end if;
 perform 1 from public.workspaces where id=r.workspace_id for update;
 select * into r from public.document_ocr_requests where id=request_id for update;
 if lease is null or r.lease_token is null or r.lease_until is null or r.status<>'running' or r.lease_token is distinct from lease or r.lease_until<=now() then raise exception 'STALE_LEASE';end if;
 d:=app_private.check_uploaded_ocr_source(r);
 return jsonb_build_object('request',to_jsonb(r),'document',to_jsonb(d));
end $$;
create function public.complete_uploaded_document_ocr_page(request_id uuid,lease uuid,result jsonb default null,error_code text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.document_ocr_requests;p public.document_ocr_pages;ctx jsonb;digest text;good boolean;begin
 select * into r from public.document_ocr_requests where id=request_id;
 if r.id is null then raise exception 'NOT_FOUND';end if;
 perform 1 from public.workspaces where id=r.workspace_id for update;
 -- Replay of an exact committed page receipt is safe after a lost response,
 -- but still checks the current actor/source and cannot accept changed text.
 select * into p from public.document_ocr_pages where document_ocr_pages.request_id=r.id and completed_lease=lease;
 if p.id is not null then
  perform app_private.check_uploaded_ocr_source(r);
  if p.receipt is distinct from result or p.error_code is distinct from error_code then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  return to_jsonb(p);
 end if;
 ctx:=public.uploaded_document_ocr_context(request_id,lease);
 r:=jsonb_populate_record(null::public.document_ocr_requests,ctx->'request');
 if r.active_page is null then raise exception 'INVALID_TRANSITION';end if;
 select * into p from public.document_ocr_pages where document_ocr_pages.request_id=r.id and page=r.active_page for update;
 if error_code is not null then
  if result is not null or error_code not in ('DOCUMENT_OCR_TIMEOUT','DOCUMENT_OCR_FAILED','DOCUMENT_OCR_CAPACITY','DOCUMENT_OCR_STORAGE_UNAVAILABLE','DOCUMENT_OCR_SOURCE_CHANGED','DOCUMENT_OCR_RESTRICTED') then raise exception 'INVALID_INPUT';end if;
  update public.document_ocr_pages set status=case when error_code in ('DOCUMENT_OCR_TIMEOUT','DOCUMENT_OCR_FAILED','DOCUMENT_OCR_STORAGE_UNAVAILABLE') and attempts<5 then 'queued' else 'blocked' end,
   error_code=complete_uploaded_document_ocr_page.error_code,completed_lease=lease,updated_at=now(),revision=revision+1 where id=p.id returning * into p;
 else
  if result is null or pg_column_size(result)>131072 or result->>'page' is distinct from r.active_page::text or jsonb_typeof(result->'text') is distinct from 'string'
   or length(result->>'text')>20000 or result->>'text_hash' is distinct from encode(sha256(convert_to(result->>'text','UTF8')),'hex')
   or coalesce(result->>'image_hash','')!~'^[a-f0-9]{64}$' or result->>'engine' is distinct from 'tesseract'
   or coalesce(result->>'engine_version','')!~'^[0-9]+(\.[0-9]+){1,3}$' or result->'languages' is distinct from '["ara","eng"]'::jsonb
   or jsonb_typeof(result->'confidence') is distinct from 'number' or (result->>'confidence')::numeric not between 0 and 100
   or jsonb_typeof(result->'numeric_uncertainty') is distinct from 'boolean' then raise exception 'INVALID_INPUT';end if;
  good:=length(trim(result->>'text'))>0 and (result->>'confidence')::numeric>=70 and result->'numeric_uncertainty'='false'::jsonb
   and not coalesce((result->>'recognition_uncertainty')::boolean,false)
   and not (result->>'text' ~ '[؀-ۿ]')
   and coalesce((select language from public.opportunities where id=(select opportunity_id from public.documents where id=r.document_id)),'auto')<>'ar';
  digest:=encode(sha256(convert_to(result::text,'UTF8')),'hex');
  update public.document_ocr_pages set status=case when good then 'ready' else 'needs_review' end,receipt=result,receipt_hash=digest,error_code=null,completed_lease=lease,updated_at=now(),revision=revision+1 where id=p.id returning * into p;
 end if;
 update public.document_ocr_requests set status=case when p.status='queued' then 'retry_wait' else 'queued' end,
  next_attempt_at=case when p.status='queued' then now()+make_interval(secs=>least(3600,30*power(2,least(p.attempts-1,7)))::int) else now() end,
  active_page=null,lease_token=null,lease_until=null,error_code=p.error_code,updated_at=now(),revision=revision+1 where id=r.id;
 update public.documents set ocr_status=case when p.status='queued' then 'retry_wait' else 'queued' end where id=r.document_id;
 return to_jsonb(p);
end $$;

alter table public.documents add column extraction_version text check(length(extraction_version)<=40);
alter table public.document_ocr_requests add column publication jsonb check(publication is null or pg_column_size(publication)<=8388608),add column published_lease uuid;
create unique index one_ocr_output_per_parent on public.documents(workspace_id,ocr_parent_document_id,extraction_hash) where ocr_parent_document_id is not null and extraction_hash is not null;
create function public.prepare_uploaded_document_ocr_publication(request_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ctx jsonb;r public.document_ocr_requests;d public.documents;child public.documents;child_id uuid;p jsonb;receipt jsonb;parts text[];page_text text;merged text:='';pages jsonb:='[]';provenance jsonb:='[]';coverage jsonb;next_status text;complete boolean:=true;digest text;prior_page jsonb;review_required boolean;page_review_required boolean;begin
 select * into r from public.document_ocr_requests where id=request_id;
 if r.id is null then raise exception 'NOT_FOUND';end if;
 perform 1 from public.workspaces where id=r.workspace_id for update;
 select * into r from public.document_ocr_requests where id=request_id for update;
 if r.status='published' and r.published_lease=lease then
  d:=app_private.check_uploaded_ocr_source(r);
  select * into child from public.documents where id=r.successor_id and workspace_id=r.workspace_id and not archived and status not in ('pending','expired');
  if child.id is null then raise exception 'STALE_INPUT';end if;
  return jsonb_build_object('request_id',r.id,'successor_id',child.id,'source_key',d.storage_key,'destination_key',child.storage_key,
   'original_hash',d.original_hash,'expected_size',d.expected_size,'mime_type',d.mime_type,'output_hash',r.output_hash);
 end if;
 ctx:=public.uploaded_document_ocr_context(request_id,lease);
 r:=jsonb_populate_record(null::public.document_ocr_requests,ctx->'request');
 d:=jsonb_populate_record(null::public.documents,ctx->'document');
 if r.active_page is not null or exists(select 1 from public.document_ocr_pages where document_ocr_pages.request_id=r.id and document_ocr_pages.status='queued')
  or not exists(select 1 from public.document_ocr_pages where document_ocr_pages.request_id=r.id and document_ocr_pages.status='ready') then raise exception 'INVALID_TRANSITION';end if;
 if r.successor_id is not null then
  select * into child from public.documents where id=r.successor_id and workspace_id=r.workspace_id;
  if child.status='expired' and exists(select 1 from public.storage_cleanup_queue q where q.workspace_id=r.workspace_id and q.storage_key=child.storage_key) then
   update public.document_ocr_requests set successor_id=null,publication=null,output_hash=null where id=r.id returning * into r;
  elsif child.id is null or child.status<>'pending' or child.archived then raise exception 'STALE_INPUT';end if;
 end if;
 if r.successor_id is null then
  d:=app_private.uploaded_ocr_baseline(d);
  parts:=regexp_split_to_array(d.extracted_text,E'(?n)^\\[Page [0-9]+\\]\\n');
  if array_length(parts,1)<>d.pdf_pages+1 then raise exception 'INVALID_EXTRACTION_COVERAGE';end if;
  for p in select value from jsonb_array_elements(d.extraction_coverage->'pages') loop
   page_text:=regexp_replace(parts[(p->>'page')::integer+1],'^\s+|\s+$','','g');
   select x.receipt into receipt from public.document_ocr_pages x where x.request_id=r.id and x.page=(p->>'page')::integer and x.status='ready';
   if receipt is not null then
    page_text:=trim(receipt->>'text');p:=p||jsonb_build_object('status',case when receipt->>'engine'='human' and receipt->'blank_confirmed'='true'::jsonb then 'blank' else 'readable' end,'characters',length(page_text));
    page_review_required:=receipt->>'engine'<>'human' or coalesce(receipt->'review_requires_reconfirmation'='true'::jsonb,false) or receipt->>'reviewed_by' is distinct from r.created_by::text or not app_private.document_page_reviewer_current(d,receipt->>'reviewed_by');
    provenance:=provenance||jsonb_build_array((receipt-'text')||jsonb_build_object('origin',case when receipt->>'engine'='human' then 'human_correction' else 'ocr' end,
     'requires_human_review',coalesce(page_review_required,true),'review_authority_current',app_private.document_page_reviewer_current(d,receipt->>'reviewed_by')));
   else
    select value into prior_page from jsonb_array_elements(coalesce(d.ocr_provenance->'pages','[]')) where value->'page'=p->'page';
    if prior_page is not null and (prior_page->>'reviewed_by' is distinct from r.created_by::text or not app_private.document_page_reviewer_current(d,prior_page->>'reviewed_by') or prior_page->>'text_hash' is distinct from encode(sha256(convert_to(page_text,'UTF8')),'hex')) then
     prior_page:=prior_page||jsonb_build_object('requires_human_review',true,'review_authority_current',app_private.document_page_reviewer_current(d,prior_page->>'reviewed_by'));
    end if;
    provenance:=provenance||jsonb_build_array(coalesce(prior_page,jsonb_build_object('page',p->'page','origin',case when p->>'status'='readable' then 'original_text_layer' else p->>'status' end,
      'text_hash',encode(sha256(convert_to(page_text,'UTF8')),'hex'),'requires_human_review',true)));
   end if;
   if merged<>'' then merged:=merged||E'\n\n';end if;
   merged:=merged||'[Page '||(p->>'page')||E']\n'||page_text;
   pages:=pages||jsonb_build_array(p);complete:=complete and p->>'status' in ('readable','blank');
  end loop;
  -- The trailing page marker retains its newline, including blank last pages.
  if merged !~ E'\n$' then merged:=merged||E'\n';end if;
  if length(merged)>1000000 then raise exception 'EXTRACTION_CAP_REACHED';end if;
  coverage:=jsonb_build_object('version',1,'kind','pdf_pages','complete',complete,'pages',pages);
  next_status:=case when exists(select 1 from jsonb_array_elements(pages) x where x->>'status'='readable') then case when complete then 'ready' else 'partial' end
   when exists(select 1 from jsonb_array_elements(pages) x where x->>'status'='needs_ocr') then 'needs_ocr'
   when exists(select 1 from jsonb_array_elements(pages) x where x->>'status'='extraction_failed') then 'error' else 'needs_processing' end;
  if not app_private.valid_document_coverage(coverage,merged,next_status,d.pdf_pages) then raise exception 'INVALID_EXTRACTION_COVERAGE';end if;
  digest:=encode(sha256(convert_to(merged,'UTF8')),'hex');
  select exists(select 1 from jsonb_array_elements(provenance) x where x->'requires_human_review' is distinct from 'false'::jsonb) into review_required;
  if (select coalesce(sum(octet_length(extracted_text)),0) from public.documents where workspace_id=d.workspace_id)+octet_length(merged)>20971520 then raise exception 'EXTRACTION_CAP_REACHED';end if;
  if d.kind='rfp' and (select coalesce(sum(length(extracted_text)),0) from public.documents x where x.workspace_id=d.workspace_id and x.opportunity_id=d.opportunity_id and x.kind='rfp' and not x.archived and x.id<>d.id and x.status<>'pending' and app_private.current_document_extraction(x.workspace_id,x.id)=x.id)+length(merged)>1000000 then raise exception 'PACKAGE_CAP_REACHED';end if;
  -- Insert reserves the physical second original under the existing combined
  -- storage lock/cap BEFORE any copy. No object existence is assumed here.
  child_id:=gen_random_uuid();
  child:=jsonb_populate_record(null::public.documents,to_jsonb(d)||jsonb_build_object(
   'id',child_id,'storage_key',d.workspace_id::text||'/ocr/'||r.id::text||'/'||child_id::text||'/original.pdf',
   'status','pending','uploaded_size',null,'extracted_text','','extraction_hash',null,'extraction_coverage',null,
   'extraction_confirmed_at',null,'extraction_confirmed_by',null,'created_by',r.created_by,'created_at',now(),'updated_at',now(),'expires_at',now()+interval '24 hours','revision',1,
   'ocr_parent_document_id',d.id,'ocr_successor_id',null,'ocr_status',null,'supersedes_id',d.id,
   'extraction_version',case when r.engine_policy=2 then 'human-v1' else 'ocr-v1:tesseract-'||coalesce((select document_ocr_pages.receipt->>'engine_version' from public.document_ocr_pages where document_ocr_pages.request_id=r.id and document_ocr_pages.status='ready' order by page limit 1),'unknown') end,
   'ocr_provenance',jsonb_build_object('version',1,'engine_policy',r.engine_policy,'parent_document_id',d.id,'original_hash',d.original_hash,'base_extraction_hash',d.extraction_hash,'requires_human_review',review_required,'pages',provenance)));
  insert into public.documents select (child).*;
  update public.document_ocr_requests set successor_id=child.id,output_hash=digest,
   publication=jsonb_build_object('text',merged,'status',next_status,'coverage',coverage),updated_at=now(),revision=revision+1 where id=r.id returning * into r;
 end if;
 return jsonb_build_object('request_id',r.id,'successor_id',child.id,'source_key',d.storage_key,'destination_key',child.storage_key,
  'original_hash',d.original_hash,'expected_size',d.expected_size,'mime_type',d.mime_type,'output_hash',r.output_hash);
end $$;
create function public.complete_uploaded_document_ocr_publication(request_id uuid,lease uuid,actual_hash text,actual_size bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.document_ocr_requests;d public.documents;child public.documents;ctx jsonb;start_at integer:=1;ordinal integer:=0;fragment text;begin
 select * into r from public.document_ocr_requests where id=request_id;
 if r.id is null then raise exception 'NOT_FOUND';end if;
 perform 1 from public.workspaces where id=r.workspace_id for update;
 select * into r from public.document_ocr_requests where id=request_id for update;
 d:=app_private.check_uploaded_ocr_source(r);
 if actual_hash is distinct from r.original_hash or actual_size is distinct from d.expected_size then raise exception 'UPLOAD_MISMATCH';end if;
 if r.status='published' and r.published_lease=lease then return (select to_jsonb(x) from public.documents x where id=r.successor_id);end if;
 ctx:=public.uploaded_document_ocr_context(request_id,lease);
 if r.active_page is not null or r.successor_id is null or r.publication is null then raise exception 'INVALID_TRANSITION';end if;
 select * into child from public.documents where id=r.successor_id and workspace_id=r.workspace_id for update;
 if child.id is null or child.status<>'pending' or child.archived or child.ocr_parent_document_id<>d.id or child.original_hash<>actual_hash then raise exception 'STALE_INPUT';end if;
 if encode(sha256(convert_to(r.publication->>'text','UTF8')),'hex')<>r.output_hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;
 update public.documents set status=r.publication->>'status',extracted_text=r.publication->>'text',extraction_hash=r.output_hash,
  extraction_coverage=r.publication->'coverage',uploaded_size=actual_size,
  extraction_confirmed_at=case when r.engine_policy=2 and r.publication#>'{coverage,complete}'='true'::jsonb and ocr_provenance->'requires_human_review'='false'::jsonb then now() else null end,
  extraction_confirmed_by=case when r.engine_policy=2 and r.publication#>'{coverage,complete}'='true'::jsonb and ocr_provenance->'requires_human_review'='false'::jsonb then r.created_by else null end,revision=revision+1,updated_at=now() where id=child.id returning * into child;
 while start_at<=length(child.extracted_text) loop
  fragment:=substr(child.extracted_text,start_at,12000);
  insert into public.document_blocks(workspace_id,document_id,ordinal,locator,text,text_hash,created_by)
  values(child.workspace_id,child.id,ordinal,jsonb_build_object('kind','extracted_character_range','start',start_at,'end',start_at+length(fragment)-1,'extraction_version',child.extraction_version),fragment,encode(sha256(convert_to(fragment,'UTF8')),'hex'),r.created_by);
  exit when start_at+12000>length(child.extracted_text);start_at:=start_at+11000;ordinal:=ordinal+1;
 end loop;
 -- Publishing never modifies old blocks, extraction bytes/hashes, paid plans,
 -- confirmations or approval. Company evidence requires review again.
 if child.kind='company' then update public.knowledge_items set verified=false,verified_by=null,verified_at=null,revision=revision+1,updated_at=now() where id=child.knowledge_item_id and workspace_id=child.workspace_id;end if;
 update public.documents set ocr_successor_id=child.id,ocr_status='published',revision=revision+1,updated_at=now() where id=d.id;
 update public.document_ocr_requests set status='published',published_lease=lease,lease_token=null,lease_until=null,active_page=null,error_code=null,updated_at=now(),revision=revision+1 where id=r.id;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details)
 values(r.workspace_id,r.created_by,'document.ocr.published','document',child.id,jsonb_build_object('parent_document_id',d.id,'original_hash',actual_hash,'extraction_hash',child.extraction_hash,'extraction_version',child.extraction_version,'complete',child.extraction_coverage->'complete','requires_human_review',child.ocr_provenance->'requires_human_review'));
 if to_regprocedure('app_private.document_ocr_published(uuid,uuid)') is not null then
  execute 'select app_private.document_ocr_published($1,$2)' using child.id,r.created_by;
 end if;
 return to_jsonb(child);
end $$;
create function public.fail_uploaded_document_ocr_publication(request_id uuid,lease uuid,error_code text) returns void
language plpgsql security definer set search_path='' as $$
declare r public.document_ocr_requests;retryable boolean;begin
 select * into r from public.document_ocr_requests where id=request_id;
 if r.id is null then raise exception 'NOT_FOUND';end if;
 perform 1 from public.workspaces where id=r.workspace_id for update;
 select * into r from public.document_ocr_requests where id=request_id for update;
 if lease is null or r.lease_token is null or r.lease_until is null or r.status<>'running' or r.active_page is not null or r.lease_token is distinct from lease or r.lease_until<=now() then raise exception 'STALE_LEASE';end if;
 if error_code is null or error_code not in ('DOCUMENT_OCR_STORAGE_UNAVAILABLE','DOCUMENT_OCR_FAILED','STORAGE_CAP_REACHED','EXTRACTION_CAP_REACHED','PACKAGE_CAP_REACHED','DATA_POLICY_BLOCKED','ROLE_FORBIDDEN','STALE_INPUT','RESTORE_IN_PROGRESS','UPLOAD_MISMATCH','INVALID_EXTRACTION_COVERAGE') then raise exception 'INVALID_INPUT';end if;
 retryable:=error_code in ('DOCUMENT_OCR_STORAGE_UNAVAILABLE','DOCUMENT_OCR_FAILED','STORAGE_CAP_REACHED') and r.publish_attempts<5;
 update public.document_ocr_requests set status=case when retryable then 'retry_wait' else 'blocked' end,error_code=fail_uploaded_document_ocr_publication.error_code,
  next_attempt_at=case when retryable then now()+make_interval(secs=>least(3600,30*power(2,least(r.publish_attempts-1,7)))::int) else 'infinity'::timestamptz end,
  lease_token=null,lease_until=null,updated_at=now(),revision=revision+1 where id=r.id;
 update public.documents set ocr_status=case when retryable then 'retry_wait' else 'blocked' end where id=r.document_id;
end $$;

-- Filter source families before the legacy snapshot's size guard. Clone the
-- existing private metadata delegate chain: fresh requests select current
-- families; resumptions select their pinned RFP document IDs before size checks.
-- Metadata and historical source fields retain the original selection rules.
-- This is an explicit function boundary, not a caller-controlled session flag.
do $$ declare names text[];name text;dependency text;definition text;begin
 select array_agg(p.proname order by p.proname) into names from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='app_private' and p.proname like 'generation_snapshot%' and p.pronargs=4;
 if not ('generation_snapshot_core'=any(names)) then raise exception 'OCR_SNAPSHOT_CORE_CHANGED';end if;
 perform set_config('check_function_bodies','off',true);
 foreach name in array names loop
  select pg_get_functiondef(('app_private.'||name||'(uuid,uuid,uuid,uuid)')::regprocedure) into definition;
  foreach dependency in array names loop definition:=replace(definition,'app_private.'||dependency||'(','app_private.'||dependency||'_ocr_current(');end loop;
  definition:=replace(definition,'package uuid)','package uuid, pinned jsonb DEFAULT NULL)');
  definition:=replace(definition,'(w,opp,proposal,package)','(w,opp,proposal,package,pinned)');
  if name='generation_snapshot_core' then
   definition:=replace(definition,'not d.archived','not d.archived and (pinned is not null or (app_private.current_document_extraction(d.workspace_id,d.id)=d.id and (d.ocr_parent_document_id is null or d.status not in (''pending'',''expired''))))');
   definition:=replace(definition,'and package is not null','and package is not null and (pinned is null or exists(select 1 from jsonb_array_elements(coalesce(pinned->''blocks'',''[]'')) frozen where frozen#>>''{reference,entity_id}''=d.id::text))');
  end if;
  execute definition;
 end loop;
 perform set_config('check_function_bodies','on',true);
 foreach name in array array['draft_generation_snapshot_before_page_coverage','draft_generation_snapshot_before_delivery'] loop
  if to_regprocedure('app_private.'||name||'(uuid,uuid,uuid,uuid,jsonb)') is null then continue;end if;
  select pg_get_functiondef(('app_private.'||name||'(uuid,uuid,uuid,uuid,jsonb)')::regprocedure) into definition;
  definition:=replace(definition,'app_private.generation_snapshot(w,opp,null,package)','app_private.generation_snapshot_ocr_current(w,opp,null,package,prior)');
  definition:=replace(definition,'not d.archived','not d.archived and (prior is not null or app_private.current_document_extraction(d.workspace_id,d.id)=d.id)');
  execute definition;
 end loop;
end $$;

-- Assessment and other fresh snapshot callers also resolve the current source.
-- Historical proposal resumptions use the explicit pinned delegate above;
-- an assessment's changed source makes its old input comparison stale, never
-- rewrites a stored request or changes text under a prior hash.
alter function app_private.generation_snapshot(uuid,uuid,uuid,uuid) rename to generation_snapshot_before_uploaded_ocr;
create function app_private.generation_snapshot(w uuid,opp uuid,proposal uuid,package uuid) returns jsonb
language sql security definer set search_path='' as $$select app_private.generation_snapshot_ocr_current(w,opp,proposal,package,null)$$;

-- New requests select current OCR sources. Historical paid snapshot selection
-- and the old document/hash are retained rather than rewritten under old keys.
alter function app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb) rename to draft_generation_snapshot_before_uploaded_ocr;
create function app_private.draft_generation_snapshot(w uuid,opp uuid,proposal uuid,package uuid,prior jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;field text;values jsonb;begin
 result:=app_private.draft_generation_snapshot_before_uploaded_ocr(w,opp,proposal,package,prior);
 if prior is not null then return case when prior->'uploaded_ocr_version'='1'::jsonb then result||jsonb_build_object('uploaded_ocr_version',1) else result end;end if;
 foreach field in array array['blocks','knowledge','reviews'] loop
  select coalesce(jsonb_agg(value order by ord),'[]') into values from jsonb_array_elements(coalesce(result->field,'[]')) with ordinality e(value,ord)
   where value#>>'{reference,entity_kind}' is distinct from 'document' or app_private.current_document_extraction(w,(value#>>'{reference,entity_id}')::uuid)=(value#>>'{reference,entity_id}')::uuid;
  result:=jsonb_set(result,array[field],values);
 end loop;
 select coalesce(jsonb_agg(e.value||jsonb_strip_nulls(jsonb_build_object('extraction_version',d.extraction_version,'ocr_provenance',d.ocr_provenance,
 'extraction_review_version',1,'extraction_confirmed',d.extraction_confirmed_at is not null,'extraction_confirmed_at',d.extraction_confirmed_at,'extraction_confirmed_by',d.extraction_confirmed_by,
 'requires_human_review',d.extraction_confirmed_at is null or coalesce((d.ocr_provenance->>'requires_human_review')::boolean,false) or (exists(select 1 from jsonb_array_elements(coalesce(d.extraction_coverage->'pages','[]')) p where p->>'status'='blank') and d.ocr_provenance->'requires_human_review' is distinct from 'false'::jsonb))) order by e.ord),'[]') into values
 from jsonb_array_elements(coalesce(result#>'{input_materials,documents}','[]')) with ordinality e(value,ord)
 join public.documents d on d.workspace_id=w and d.id=(e.value->>'document_id')::uuid
 where app_private.current_document_extraction(w,d.id)=d.id and (d.ocr_parent_document_id is null or d.status not in ('pending','expired'));
 result:=jsonb_set(jsonb_set(result,'{input_materials,documents}',values),'{input_materials,extraction_review_version}','1')||jsonb_build_object('uploaded_ocr_version',1);
 if pg_column_size(result)>8388608 then raise exception 'GENERATION_CONTEXT_CAP_REACHED';end if;
 return result;
end $$;
alter function app_private.delivery_input(uuid,uuid) rename to delivery_input_before_uploaded_ocr;
create function app_private.delivery_input(w uuid,opp uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;items jsonb;begin
 result:=app_private.delivery_input_before_uploaded_ocr(w,opp);
 select coalesce(jsonb_agg(value order by ord),'[]') into items from jsonb_array_elements(result->'blocks') with ordinality e(value,ord)
 where app_private.current_document_extraction(w,(value->>'document_id')::uuid)=(value->>'document_id')::uuid;
 result:=jsonb_set(result,'{blocks}',items);
 select coalesce(jsonb_agg(e.value||jsonb_strip_nulls(jsonb_build_object('extraction_version',d.extraction_version,'ocr_provenance',d.ocr_provenance,
 'extraction_review_version',1,'extraction_confirmed',d.extraction_confirmed_at is not null,'extraction_confirmed_at',d.extraction_confirmed_at,'extraction_confirmed_by',d.extraction_confirmed_by,
 'requires_human_review',d.extraction_confirmed_at is null or coalesce((d.ocr_provenance->>'requires_human_review')::boolean,false) or (exists(select 1 from jsonb_array_elements(coalesce(d.extraction_coverage->'pages','[]')) p where p->>'status'='blank') and d.ocr_provenance->'requires_human_review' is distinct from 'false'::jsonb))) order by e.ord),'[]') into items
 from jsonb_array_elements(result#>'{input_materials,documents}') with ordinality e(value,ord)
 join public.documents d on d.workspace_id=w and d.id=(e.value->>'document_id')::uuid
 where app_private.current_document_extraction(w,d.id)=d.id and (d.ocr_parent_document_id is null or d.status not in ('pending','expired'));
 return jsonb_set(jsonb_set(result,'{input_materials,documents}',items),'{input_materials,extraction_review_version}','1');
end $$;

-- Archiving any displayed extraction removes its original/source family from
-- current use; historical rows remain retained and purge cannot orphan children.
create function app_private.archive_ocr_family() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if pg_trigger_depth()>1 or not new.archived or old.archived or (old.ocr_parent_document_id is not null and old.status in ('pending','expired')) then return new;end if;
 with recursive family(id) as (
  select new.id union select d.id from family f join public.documents current on current.id=f.id
   join public.documents d on d.workspace_id=new.workspace_id and (d.id=current.ocr_parent_document_id or d.ocr_parent_document_id=current.id)
 ) update public.documents set archived=true,revision=revision+1,updated_at=now() where id in(select id from family) and not archived;
 return new;
end $$;
create trigger archive_ocr_family after update of archived on public.documents for each row execute function app_private.archive_ocr_family();

-- Human transcription is a distinct versioned extraction, never a flag that
-- silently approves a recognizer's text. Every supplied page is bound to the
-- original bytes, previous extraction and previous full-page text hash.
create function app_private.correct_document_extraction(input jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d public.documents;r public.document_ocr_requests;actor uuid:=auth.uid();w uuid;digest text;replay app_private.idempotency_records;result jsonb;item jsonb;parts text[];page_number integer;prior_text text;receipt jsonb;corrected_text text;superseded_requests jsonb;carried public.document_ocr_pages;begin
 perform app_private.check_keys(input,array['id','expected_revision','expected_original_hash','expected_extraction_hash','pages','review_confirmed']);
 if input->'review_confirmed' is distinct from 'true'::jsonb or jsonb_typeof(input->'pages') is distinct from 'array' or jsonb_array_length(input->'pages') not between 1 and 200 or pg_column_size(input)>8388608 then raise exception 'INVALID_INPUT';end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;
 if w is null then raise exception 'ROLE_FORBIDDEN';end if;
 perform 1 from public.workspaces where id=w for update;
 select * into d from public.documents where workspace_id=w and id=(input->>'id')::uuid for update;
 if d.id is null or d.archived then raise exception 'STALE_INPUT';end if;
 if not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id
  where m.workspace_id=w and m.user_id=actor and m.active and a.status='active' and (m.role in ('Owner','Editor') or (m.role='Reviewer' and d.kind='review' and exists(select 1 from public.review_inputs x where x.id=d.review_input_id and x.created_by=actor)))) then raise exception 'ROLE_FORBIDDEN';end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 then raise exception 'IDEMPOTENCY_KEY_REQUIRED';end if;
 digest:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route='document.extraction.correct' and key=idempotency_key and expires_at>now();
 if replay.key is not null then
  if replay.body_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  return replay.result;
 end if;
 if d.revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT';end if;
 if d.ocr_successor_id is not null or d.original_hash is distinct from input->>'expected_original_hash' or d.extraction_hash is distinct from input->>'expected_extraction_hash' then raise exception 'STALE_INPUT';end if;
 if d.mime_type<>'application/pdf' or d.pdf_pages is null or d.pdf_pages not between 1 and 200 then raise exception 'DOCUMENT_PAGE_REVIEW_UNAVAILABLE';end if;
 -- A new explicit correction can replace unfinished work while preserving
 -- its immutable receipts/reservations and revoking its old publication lease.
 select coalesce(jsonb_agg(id order by created_at),'[]') into superseded_requests from public.document_ocr_requests where workspace_id=w and document_id=d.id and engine_policy=2 and status not in ('published','superseded');
 update public.document_ocr_requests set status='superseded',lease_token=null,lease_until=null,updated_at=now(),revision=revision+1
  where workspace_id=w and document_id=d.id and engine_policy=2 and status not in ('published','superseded');
 if exists(select 1 from public.document_ocr_requests where workspace_id=w and document_id=d.id and engine_policy=2 and status<>'superseded') then raise exception 'DOCUMENT_CORRECTION_PENDING';end if;
 r:=jsonb_populate_record(null::public.document_ocr_requests,jsonb_build_object('workspace_id',w,'document_id',d.id,'original_hash',d.original_hash,'base_extraction_hash',d.extraction_hash,'created_by',actor));
 perform app_private.check_uploaded_ocr_source(r);
 d:=app_private.uploaded_ocr_baseline(d);
 parts:=regexp_split_to_array(d.extracted_text,E'(?n)^\\[Page [0-9]+\\]\\n');
 if array_length(parts,1)<>d.pdf_pages+1 then raise exception 'INVALID_EXTRACTION_COVERAGE';end if;
 if (select count(distinct value->>'page') from jsonb_array_elements(input->'pages'))<>jsonb_array_length(input->'pages') then raise exception 'INVALID_INPUT';end if;
 insert into public.document_ocr_requests(workspace_id,document_id,original_hash,base_extraction_hash,created_by,engine_policy)
 values(w,d.id,d.original_hash,d.extraction_hash,actor,2) returning * into r;
 for item in select value from jsonb_array_elements(input->'pages') loop
  perform app_private.check_keys(item,array['page','expected_page_text_hash','text','blank_confirmed']);
  if jsonb_typeof(item->'page') is distinct from 'number' or (item->>'page')!~'^[0-9]+$' or jsonb_typeof(item->'text') is distinct from 'string' or length(item->>'text')>20000
   or jsonb_typeof(item->'blank_confirmed') is distinct from 'boolean' or item->>'text' ~ E'(?n)^\\[Page [0-9]+\\]' then raise exception 'INVALID_INPUT';end if;
  page_number:=(item->>'page')::integer;
  corrected_text:=regexp_replace(item->>'text','^\s+|\s+$','','g');
  if page_number not between 1 and d.pdf_pages or (length(corrected_text)=0) is distinct from ((item->>'blank_confirmed')::boolean) then raise exception 'INVALID_INPUT';end if;
  prior_text:=regexp_replace(parts[page_number+1],'^\s+|\s+$','','g');
  if item->>'expected_page_text_hash' is distinct from encode(sha256(convert_to(prior_text,'UTF8')),'hex') then raise exception 'STALE_INPUT';end if;
  receipt:=jsonb_build_object('page',page_number,'text',corrected_text,'text_hash',encode(sha256(convert_to(corrected_text,'UTF8')),'hex'),
   'engine','human','engine_version','1','confidence',null,'blank_confirmed',item->'blank_confirmed','reviewed_by',actor,'reviewed_at',now(),
   'original_hash',d.original_hash,'base_extraction_hash',d.extraction_hash,'previous_page_text_hash',item->>'expected_page_text_hash');
  insert into public.document_ocr_pages(workspace_id,request_id,page,status,receipt,receipt_hash)
  values(w,r.id,page_number,'ready',receipt,encode(sha256(convert_to(receipt::text,'UTF8')),'hex'));
 end loop;
 -- A later page save is an additive edit, not permission to discard another
 -- saved page. Preserve exact same-base unoverridden human text and attribution.
 for carried in select x.* from public.document_ocr_pages x join public.document_ocr_requests previous on previous.id=x.request_id
  where previous.id::text in(select jsonb_array_elements_text(superseded_requests)) and previous.original_hash=d.original_hash and previous.base_extraction_hash=d.extraction_hash
   and x.receipt->>'engine'='human' and x.page between 1 and d.pdf_pages
   and not exists(select 1 from public.document_ocr_pages fresh where fresh.request_id=r.id and fresh.page=x.page) loop
  prior_text:=regexp_replace(parts[carried.page+1],'^\s+|\s+$','','g');
  if carried.receipt->>'original_hash' is distinct from d.original_hash or carried.receipt->>'base_extraction_hash' is distinct from d.extraction_hash
   or carried.receipt->>'previous_page_text_hash' is distinct from encode(sha256(convert_to(prior_text,'UTF8')),'hex')
   or carried.receipt->>'text_hash' is distinct from encode(sha256(convert_to(carried.receipt->>'text','UTF8')),'hex') then continue;end if;
  receipt:=carried.receipt||jsonb_build_object('carried_from_request_id',carried.request_id);
  if carried.status<>'ready' then receipt:=receipt||jsonb_build_object('review_requires_reconfirmation',true);end if;
  insert into public.document_ocr_pages(workspace_id,request_id,page,status,receipt,receipt_hash)
  values(w,r.id,carried.page,'ready',receipt,encode(sha256(convert_to(receipt::text,'UTF8')),'hex'));
 end loop;
 -- Supersede in-flight recognizer authority before allowing a human successor.
 -- Its immutable receipts/reservations survive for history and cleanup.
 update public.document_ocr_requests set status='blocked',error_code='MANUAL_CORRECTION_REQUESTED',lease_token=null,lease_until=null,active_page=null,revision=revision+1,updated_at=now()
 where workspace_id=w and document_id=d.id and engine_policy=1 and status<>'published';
 update public.documents set ocr_status='queued',revision=revision+1,updated_at=now() where id=d.id returning to_jsonb(documents.*) into result;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(w,actor,'document.extraction.correct','document',d.id,
  jsonb_build_object('request_id',r.id,'superseded_request_ids',superseded_requests,'original_hash',d.original_hash,'base_extraction_hash',d.extraction_hash,'pages',(select jsonb_agg(jsonb_build_object('page',page,'receipt_hash',receipt_hash) order by page) from public.document_ocr_pages where request_id=r.id)));
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route='document.extraction.correct' and key=idempotency_key;
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND','document.extraction.correct',idempotency_key,digest,result);
 return result;
end $$;

alter function app_private.app_command(text,jsonb,text) rename to app_command_before_uploaded_ocr;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d public.documents;r public.document_ocr_requests;actor uuid:=auth.uid();w uuid;digest text;replay app_private.idempotency_records;result jsonb;begin
 if operation='knowledge.verify' and exists(select 1 from public.documents x where x.knowledge_item_id=(input->>'id')::uuid and not x.archived
  and x.workspace_id in(select m.workspace_id from public.memberships m where m.user_id=actor and m.active)
  and x.ocr_provenance is not null and x.extraction_confirmed_at is null and app_private.current_document_extraction(x.workspace_id,x.id)=x.id and x.status in ('ready','partial')) then raise exception 'DOCUMENT_PAGE_REVIEW_REQUIRED';end if;
 if operation='document.confirm' and exists(select 1 from public.documents x where x.id=(input->>'id')::uuid and x.workspace_id in(select m.workspace_id from public.memberships m where m.user_id=actor and m.active) and (x.ocr_provenance is not null or exists(select 1 from jsonb_array_elements(coalesce(x.extraction_coverage->'pages','[]')) p where p->>'status'='blank'))) then raise exception 'DOCUMENT_PAGE_REVIEW_REQUIRED';end if;
 if operation='document.extraction.correct' then return app_private.correct_document_extraction(input,idempotency_key);end if;
 if operation<>'document.ocr.retry' then return app_private.app_command_before_uploaded_ocr(operation,input,idempotency_key);end if;
 perform app_private.check_keys(input,array['id','expected_revision']);
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;
 if w is null then raise exception 'ROLE_FORBIDDEN';end if;
 perform 1 from public.workspaces where id=w for update;
 select * into d from public.documents where workspace_id=w and id=(input->>'id')::uuid for update;
 if d.id is null or d.archived or d.ocr_successor_id is not null then raise exception 'STALE_INPUT';end if;
 if not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id
  where m.workspace_id=w and m.user_id=actor and m.active and a.status='active' and (m.role in ('Owner','Editor') or (m.role='Reviewer' and d.kind='review' and exists(select 1 from public.review_inputs x where x.id=d.review_input_id and x.created_by=actor)))) then raise exception 'ROLE_FORBIDDEN';end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 then raise exception 'IDEMPOTENCY_KEY_REQUIRED';end if;
 digest:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key and expires_at>now();
 if replay.key is not null then
  if replay.body_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  return replay.result;
 end if;
 if d.revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT';end if;
 select * into r from public.document_ocr_requests where workspace_id=w and document_id=d.id and status<>'superseded' order by engine_policy desc limit 1 for update;
 if r.id is null then r:=app_private.enqueue_uploaded_ocr(d.id,actor);end if;
 if r.id is null or r.status='published' then raise exception 'DOCUMENT_OCR_NOT_REQUIRED';end if;
 if r.engine_policy=2 and r.error_code='RESTORED_REVIEW_REQUIRED' then raise exception 'DOCUMENT_PAGE_REVIEW_REQUIRED';end if;
 if r.status='running' and r.lease_until>now() then raise exception 'DOCUMENT_OCR_RUNNING';end if;
 update public.document_ocr_requests set created_by=actor,lease_token=null,lease_until=null,active_page=null,publish_attempts=0,status='queued',next_attempt_at=now(),error_code=null,updated_at=now(),revision=revision+1 where id=r.id returning * into r;
 perform app_private.check_uploaded_ocr_source(r);
 update public.document_ocr_pages set status='queued',attempts=0,error_code=null,completed_lease=null,updated_at=now(),revision=revision+1 where request_id=r.id and status<>'ready';
 update public.documents set ocr_status='queued' where id=d.id returning to_jsonb(documents.*) into result;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(w,actor,'document.ocr.retry','document',d.id,jsonb_build_object('request_id',r.id));
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,digest,result);
 return result;
end $$;

-- Source completeness is checked against the effective extraction family, not
-- the retained unread ancestor. OCR itself never confirms extraction review.
create or replace function app_private.seal_package(w uuid,opportunity uuid,actor uuid) returns public.document_packages
language plpgsql security definer set search_path='' as $$
declare v_manifest jsonb;digest text;result public.document_packages;begin
 perform 1 from public.workspaces where id=w for update;
 if not exists(select 1 from public.documents d where workspace_id=w and opportunity_id=opportunity and kind='rfp' and not archived and status='ready' and (d.ocr_parent_document_id is null or d.status not in ('pending','expired')) and app_private.current_document_extraction(w,d.id)=d.id) then raise exception 'READABLE_RFP_REQUIRED';end if;
 if exists(select 1 from public.documents d where workspace_id=w and opportunity_id=opportunity and kind='rfp' and not archived and (d.ocr_parent_document_id is null or d.status not in ('pending','expired')) and app_private.current_document_extraction(w,d.id)=d.id and (status<>'ready' or extraction_confirmed_at is null)) then raise exception 'EXTRACTION_REVIEW_REQUIRED';end if;
 select jsonb_agg(jsonb_build_object('id',id,'original_hash',original_hash,'extraction_hash',extraction_hash,'precedence',precedence,'supersedes_id',supersedes_id) order by id) into v_manifest from public.documents d where workspace_id=w and opportunity_id=opportunity and kind='rfp' and not archived and (d.ocr_parent_document_id is null or d.status not in ('pending','expired')) and app_private.current_document_extraction(w,d.id)=d.id;
 digest:=encode(sha256(convert_to(v_manifest::text,'UTF8')),'hex');
 select * into result from public.document_packages where workspace_id=w and opportunity_id=opportunity and package_hash=digest;
 if result.id is null then insert into public.document_packages(workspace_id,opportunity_id,ordinal,package_hash,manifest,created_by)
  select w,opportunity,coalesce(max(ordinal),0)+1,digest,v_manifest,actor from public.document_packages where workspace_id=w and opportunity_id=opportunity returning * into result;end if;
 return result;
end $$;

-- Page receipts survive logical recovery. Restored work never resumes a saved
-- lease/identity; current authorized retry is required, retaining ready pages.
alter function app_private.backup_tables() rename to backup_tables_before_uploaded_ocr;
create function app_private.backup_tables() returns text[] language sql immutable set search_path='' as $$
 select app_private.backup_tables_before_uploaded_ocr()||array['document_ocr_requests','document_ocr_pages']::text[]
$$;
do $$ declare definition text;marker text;begin
 select pg_get_functiondef('public.commit_workspace_restore(uuid)'::regprocedure) into definition;
 marker:='elsif t=''jobs'' then';
 if position(marker in definition)=0 then raise exception 'UPLOADED_OCR_RESTORE_CHANGED';end if;
 definition:=replace(definition,'if t=''documents'' then',$document$if t='documents' then
 if data->'ocr_provenance' is not null and data->'ocr_provenance'<>'null'::jsonb then
  data:=jsonb_set(data,'{ocr_provenance}',data->'ocr_provenance'||jsonb_build_object('requires_human_review',true,'review_reset_reason','RESTORED_REVIEW_REQUIRED',
   'pages',(select coalesce(jsonb_agg(p||jsonb_build_object('requires_human_review',true,'review_reset_reason','RESTORED_REVIEW_REQUIRED')),'[]') from jsonb_array_elements(coalesce(data#>'{ocr_provenance,pages}','[]')) p)));
 end if;
 $document$);
 execute replace(definition,marker,$new$elsif t='document_ocr_requests' then
  data:=data||jsonb_build_object('status',case when data->>'status' in ('published','superseded') then data->>'status' else 'blocked' end,
   'active_page',null,'lease_token',null,'lease_until',null,'published_lease',null,'error_code',case when data->>'status'='published' then null else 'RESTORED_REVIEW_REQUIRED' end);
 elsif t='document_ocr_pages' then data:=data||jsonb_build_object('completed_lease',null,
  'status',case when data#>>'{receipt,engine}'='human' then 'needs_review' else data->>'status' end);
 $new$||marker);
end $$;

-- Operational OCR state does not change evidence. A finalized successor does.
do $$ declare definition text;marker text;begin
 select pg_get_functiondef('app_private.invalidate_evidence()'::regprocedure) into definition;
 marker:='begin';
 execute replace(definition,marker,$new$begin
 if TG_TABLE_NAME='documents' then
  if new.ocr_parent_document_id is not null and new.status='pending' then return new;end if;
  if TG_OP='UPDATE' and (to_jsonb(new)-array['revision','updated_at','ocr_status'])=(to_jsonb(old)-array['revision','updated_at','ocr_status']) then return new;end if;
 end if;
 $new$);
end $$;

-- Logical package limits count the current extraction once. Physical original
-- storage and retained historical text still consume their actual reservations.
do $$ declare definition text;marker text;begin
 select pg_get_functiondef('public.accept_uploaded_document(uuid,uuid,text,bigint,text,text,text)'::regprocedure) into definition;
 definition:=replace(definition,'begin','begin if exists(select 1 from public.documents where id=document_id and ocr_parent_document_id is not null) then raise exception ''OCR_PUBLICATION_REQUIRED'';end if;');
 marker:='and x.id<>d.id and not x.archived';
 if position(marker in definition)=0 then raise exception 'UPLOADED_OCR_PACKAGE_GUARD_CHANGED';end if;
 execute replace(definition,marker,marker||' and app_private.current_document_extraction(x.workspace_id,x.id)=x.id');
 select pg_get_functiondef('public.verify_document_pages(uuid,integer)'::regprocedure) into definition;
 marker:='and not archived and id<>d.id';
 if position(marker in definition)=0 then raise exception 'UPLOADED_OCR_PAGE_GUARD_CHANGED';end if;
 execute replace(definition,marker,marker||' and app_private.current_document_extraction(documents.workspace_id,documents.id)=documents.id');
 select pg_get_functiondef('app_private.seal_draft_package(uuid,uuid,uuid)'::regprocedure) into definition;
 marker:='and kind=''rfp'' and not archived';
 if position(marker in definition)=0 then raise exception 'UPLOADED_OCR_DRAFT_PACKAGE_CHANGED';end if;
 execute replace(definition,marker,marker||' and app_private.current_document_extraction(documents.workspace_id,documents.id)=documents.id');
end $$;

-- Upload file-count limits refer to logical current documents; historical
-- extraction copies still consume real physical storage reservations.
do $$ declare f record;definition text;begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname like 'app_command%' loop
  definition:=pg_get_functiondef(f.oid);
  if position('when ''document.prepare'' then' in definition)>0 then
   execute replace(definition,'and status<>''expired'')>=','and status<>''expired'' and (ocr_parent_document_id is null or status not in (''pending'',''expired'')) and app_private.current_document_extraction(workspace_id,id)=id)>=');
  end if;
 end loop;
end $$;

create function public.uploaded_document_ocr_status(document_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d public.documents;r public.document_ocr_requests;begin
 select * into d from public.documents where id=document_id and not archived;
 if d.id is null then raise exception 'NOT_FOUND';end if;
 perform app_private.delivery_actor(d.workspace_id,auth.uid(),false);
 select * into r from public.document_ocr_requests where workspace_id=d.workspace_id and document_ocr_requests.document_id=d.id and status<>'superseded' order by engine_policy desc limit 1;
 return jsonb_build_object('document_id',d.id,'document_revision',d.revision,'status',d.ocr_status,'successor_id',d.ocr_successor_id,
  'error_code',r.error_code,'revision',r.revision,'total_pages',(select count(*) from public.document_ocr_pages where request_id=r.id),
  'completed_pages',(select count(*) from public.document_ocr_pages where request_id=r.id and receipt is not null),
  'review_pages',(select coalesce(jsonb_agg(page order by page),'[]') from public.document_ocr_pages where request_id=r.id and status in ('needs_review','blocked')));
end $$;

create function public.uploaded_document_extraction(document_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare d public.documents;p jsonb;parts text[];page_text text;pages jsonb:='[]';candidate jsonb;provenance jsonb;begin
 select * into d from public.documents where id=document_id and not archived and status not in ('pending','expired');
 if d.id is null then raise exception 'NOT_FOUND';end if;
 perform app_private.delivery_actor(d.workspace_id,auth.uid(),false);
 if d.mime_type<>'application/pdf' or d.extraction_hash is null or d.pdf_pages is null or d.uploaded_size is distinct from d.expected_size then raise exception 'DOCUMENT_PAGE_REVIEW_UNAVAILABLE';end if;
 d:=app_private.uploaded_ocr_baseline(d);
 parts:=regexp_split_to_array(d.extracted_text,E'(?n)^\\[Page [0-9]+\\]\\n');
 if array_length(parts,1)<>d.pdf_pages+1 then raise exception 'INVALID_EXTRACTION_COVERAGE';end if;
 for p in select value from jsonb_array_elements(d.extraction_coverage->'pages') loop
  page_text:=regexp_replace(parts[(p->>'page')::integer+1],'^\s+|\s+$','','g');
  select x.receipt into candidate from public.document_ocr_pages x join public.document_ocr_requests r on r.id=x.request_id
   where r.document_id=d.id and r.status<>'superseded' and x.receipt is not null and x.page=(p->>'page')::integer
   order by r.engine_policy desc,r.created_at desc limit 1;
  select value into provenance from jsonb_array_elements(coalesce(d.ocr_provenance->'pages','[]')) where value->'page'=p->'page';
  pages:=pages||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('page',p->'page','status',p->'status','text',page_text,
   'text_hash',encode(sha256(convert_to(page_text,'UTF8')),'hex'),'candidate_text',candidate->'text','candidate_text_hash',candidate->'text_hash',
   'candidate_origin',case when candidate is null then null when candidate->>'engine'='human' then 'human' else 'ocr' end,
   'candidate_reviewed_by',candidate->'reviewed_by','candidate_reviewed_at',candidate->'reviewed_at',
   'candidate_requires_review',case when candidate is null then null else candidate->>'engine'<>'human' or coalesce(candidate->'review_requires_reconfirmation'='true'::jsonb,false) or candidate->>'reviewed_by' is distinct from auth.uid()::text or not app_private.document_page_reviewer_current(d,candidate->>'reviewed_by') end,
   'requires_review',coalesce(provenance->'requires_human_review','true'::jsonb),'reviewed_by',provenance->'reviewed_by','reviewed_at',provenance->'reviewed_at')));
 end loop;
 return jsonb_build_object('document_id',d.id,'document_revision',d.revision,'original_hash',d.original_hash,'extraction_hash',d.extraction_hash,
  'original_name',d.original_name,'pdf_pages',d.pdf_pages,'pages',pages,'ocr',public.uploaded_document_ocr_status(d.id));
end $$;

-- No implicit PUBLIC execute and no assumed role family on managed DO.
do $$ declare name text;role_name text;signature text;begin
 foreach name in array array['document_ocr_requests','document_ocr_pages'] loop
  execute 'revoke all on public.'||quote_ident(name)||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then
    execute 'revoke all on public.'||quote_ident(name)||' from '||quote_ident(role_name);
    if role_name in ('service_role','tdp_app_service') then execute 'grant all on public.'||quote_ident(name)||' to '||quote_ident(role_name);end if;
   end if;
  end loop;
 end loop;
 foreach signature in array array[
  'public.accept_uploaded_document_before_ocr(uuid,uuid,text,bigint,text,text,text,jsonb)',
  'public.accept_uploaded_document_with_coverage(uuid,uuid,text,bigint,text,text,text,jsonb)',
  'public.uploaded_document_extraction(uuid)','public.claim_uploaded_document_ocr()','public.uploaded_document_ocr_context(uuid,uuid)','public.uploaded_document_ocr_status(uuid)',
  'public.complete_uploaded_document_ocr_page(uuid,uuid,jsonb,text)',
  'public.prepare_uploaded_document_ocr_publication(uuid,uuid)',
  'public.complete_uploaded_document_ocr_publication(uuid,uuid,text,bigint)',
  'public.fail_uploaded_document_ocr_publication(uuid,uuid,text)',
  'app_private.current_document_extraction(uuid,uuid)','app_private.document_page_reviewer_current(public.documents,text)',
  'app_private.check_uploaded_ocr_source(public.document_ocr_requests)',
  'app_private.uploaded_ocr_baseline(public.documents)','app_private.enqueue_uploaded_ocr(uuid,uuid)','app_private.correct_document_extraction(jsonb,text)',
  'app_private.generation_snapshot_before_uploaded_ocr(uuid,uuid,uuid,uuid)','app_private.generation_snapshot(uuid,uuid,uuid,uuid)',
  'app_private.draft_generation_snapshot_before_uploaded_ocr(uuid,uuid,uuid,uuid,jsonb)',
  'app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb)',
  'app_private.delivery_input_before_uploaded_ocr(uuid,uuid)','app_private.delivery_input(uuid,uuid)',
  'app_private.archive_ocr_family()',
  'app_private.app_command_before_uploaded_ocr(text,jsonb,text)','app_private.app_command(text,jsonb,text)',
  'app_private.seal_package(uuid,uuid,uuid)',
  'app_private.backup_tables_before_uploaded_ocr()','app_private.backup_tables()'
 ] loop
  execute 'revoke all on function '||signature||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then
    execute 'revoke all on function '||signature||' from '||quote_ident(role_name);
    if signature like 'public.%' and signature not like 'public.accept_uploaded_document_before_ocr%' and role_name in ('service_role','tdp_app_service')
     then execute 'grant execute on function '||signature||' to '||quote_ident(role_name);
    elsif signature in ('app_private.app_command(text,jsonb,text)','public.uploaded_document_ocr_status(uuid)','public.uploaded_document_extraction(uuid)') and role_name in ('authenticated','tdp_app_authenticated')
     then execute 'grant execute on function '||signature||' to '||quote_ident(role_name);end if;
   end if;
  end loop;
 end loop;
end $$;

do $$ declare f record;role_name text;begin
 for f in select p.oid::regprocedure::text signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='app_private' and p.proname like 'generation_snapshot%_ocr_current' loop
  execute 'revoke all on function '||f.signature||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function '||f.signature||' from '||quote_ident(role_name);end if;
  end loop;
 end loop;
end $$;
