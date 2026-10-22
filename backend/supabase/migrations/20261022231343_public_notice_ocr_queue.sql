-- Public tender images are processed by the existing authenticated native worker.
-- No OCR text or private working state is exposed through browser table grants.
create table app_private.public_notice_ocr_requests (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 job_id uuid not null references public.jobs(id) on delete cascade,
 source_id uuid not null references public.sources(id),
 source_revision bigint not null,
 input_hash text not null,
 url text not null,
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 mime text not null check(mime in ('application/pdf','image/png','image/jpeg','image/webp')),
 pages integer[] not null check(cardinality(pages) between 1 and 10),
 total_pages integer not null check(total_pages between 1 and 100),
 status text not null default 'queued' check(status in ('queued','running','ready','blocked')),
 result jsonb check(result is null or pg_column_size(result)<=262144),
 error_code text,
 attempts integer not null default 0,
 lease_token uuid,
 lease_until timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(job_id,url,sha256,source_revision),
 foreign key(workspace_id,job_id) references public.jobs(workspace_id,id)
);
alter table app_private.public_notice_ocr_requests enable row level security;
revoke all on app_private.public_notice_ocr_requests from public,anon,authenticated;
grant all on app_private.public_notice_ocr_requests to service_role;
create index public_notice_ocr_pending on app_private.public_notice_ocr_requests(status,created_at);

create function app_private.notice_ocr_current(request app_private.public_notice_ocr_requests)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.jobs j
 join public.generation_plans p on p.id=j.entity_id and p.workspace_id=j.workspace_id
 join public.opportunities o on o.id=p.opportunity_id and o.workspace_id=p.workspace_id
 join public.sources s on s.id=o.source_id and s.workspace_id=o.workspace_id
 join public.memberships m on m.workspace_id=j.workspace_id and m.user_id=j.created_by
 join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id
 where j.id=request.job_id and j.workspace_id=request.workspace_id and j.type='classify_opportunity'
 and not j.cancel_requested and j.status in ('queued','running','retry_wait','quota_wait')
 and j.input_hash=request.input_hash and p.input_hash=j.input_hash and p.kind='assessment'
 and p.status in ('queued','running') and not o.archived and app_private.assessment_inputs_current(p.id)
 and s.id=request.source_id and s.approval='approved' and s.revision=request.source_revision
 and substring(request.url from '^https://([^/:?#]+)')=any(s.approved_hosts)
 and substring(request.url from '^https://([^/:?#]+)')=any(public.worker_collection_hosts())
 and m.active and m.role in ('Owner','Editor') and a.status='active')
$$;
revoke all on function app_private.notice_ocr_current(app_private.public_notice_ocr_requests) from public,anon,authenticated,service_role;

create function public.request_notice_ocr(job_id uuid,lease uuid,url text,content_hash text,pages jsonb,total_pages integer,mime text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;j public.jobs;s public.sources;r app_private.public_notice_ocr_requests;
 requested_pages integer[];target_host text;
begin
 ctx:=public.generation_context(job_id,lease);
 select * into j from public.jobs where id=job_id for update;
 if j.type is distinct from 'classify_opportunity' or ctx->'detail_source' is null then raise exception 'NOTICE_DETAILS_NOT_REQUIRED';end if;
 select * into s from public.sources where id=(ctx->'detail_source'->>'id')::uuid and workspace_id=j.workspace_id;
 if s.approval is distinct from 'approved' then raise exception 'SOURCE_PERMISSION_REQUIRED';end if;
 if coalesce(url,'')!~'^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}(/|\?|$)' or length(url)>4000
  or url ~ '[[:space:]\\]' or coalesce(content_hash,'')!~'^[0-9a-f]{64}$'
  or mime is null or mime not in ('application/pdf','image/png','image/jpeg','image/webp')
  or total_pages is null or total_pages not between 1 and 100
  or jsonb_typeof(pages) is distinct from 'array' then raise exception 'INVALID_INPUT';end if;
 target_host:=substring(url from '^https://([^/:?#]+)');
 if not (target_host=any(s.approved_hosts)) or not(target_host=any(public.worker_collection_hosts())) then raise exception 'UNSAFE_DESTINATION';end if;
 if jsonb_array_length(pages) not between 1 and 10
  or exists(select 1 from jsonb_array_elements(pages) v where jsonb_typeof(v)<>'number' or v::text!~'^[0-9]+$') then raise exception 'INVALID_INPUT';end if;
 requested_pages:=array(select v::text::integer from jsonb_array_elements(pages) v order by v::text::integer);
 if exists(select 1 from unnest(requested_pages) p where p not between 1 and total_pages)
  or cardinality(requested_pages)<>(select count(distinct p) from unnest(requested_pages) p)
  or (mime<>'application/pdf' and (total_pages<>1 or requested_pages<>array[1])) then raise exception 'INVALID_INPUT';end if;
 select * into r from app_private.public_notice_ocr_requests q where q.job_id=j.id and q.url=request_notice_ocr.url and q.sha256=content_hash and q.source_revision=s.revision;
 if r.id is not null and (r.pages<>requested_pages or r.total_pages<>total_pages or r.mime<>mime) then raise exception 'STALE_INPUT';end if;
 if r.id is null then
  if (select count(*) from app_private.public_notice_ocr_requests q where q.job_id=j.id and q.source_revision=s.revision)>=3 then raise exception 'NOTICE_OCR_REQUEST_LIMIT';end if;
  insert into app_private.public_notice_ocr_requests(workspace_id,job_id,source_id,source_revision,input_hash,url,sha256,mime,pages,total_pages)
   values(j.workspace_id,j.id,s.id,s.revision,j.input_hash,url,content_hash,mime,requested_pages,total_pages) returning * into r;
 end if;
 if not app_private.notice_ocr_current(r) then raise exception 'STALE_INPUT';end if;
 if r.status='ready' then return jsonb_build_object('status','ready','result',r.result);end if;
 if r.status='blocked' then return jsonb_build_object('status','blocked','error_code',r.error_code);end if;
 update public.jobs set status='retry_wait',error_code='NOTICE_OCR_PENDING',next_attempt_at=now()+interval '2 minutes',
  lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
 return jsonb_build_object('status','pending','request_id',r.id);
end $$;

create function public.claim_notice_ocr() returns jsonb
language plpgsql security definer set search_path='' as $$
declare r app_private.public_notice_ocr_requests;s public.sources;
begin
 for r in select q.* from app_private.public_notice_ocr_requests q join public.jobs j on j.id=q.job_id
 where (q.status='queued' or (q.status='running' and q.lease_until<=now()))
 and j.status in ('queued','retry_wait','quota_wait') and not j.cancel_requested
 order by q.created_at,q.id for update of q skip locked limit 100 loop
 if not app_private.notice_ocr_current(r) or r.attempts>=2 then
  update app_private.public_notice_ocr_requests set status='blocked',error_code=case when r.attempts>=2 then 'NOTICE_OCR_FAILED' else 'STALE_INPUT' end,
   lease_token=null,lease_until=null,updated_at=now() where id=r.id;
  update public.jobs set next_attempt_at=now(),updated_at=now() where id=r.job_id
   and not exists(select 1 from app_private.public_notice_ocr_requests other
    where other.job_id=r.job_id and other.id<>r.id and other.status in ('queued','running','ready')
    and app_private.notice_ocr_current(other));
  continue;
 end if;
 update app_private.public_notice_ocr_requests set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),
  lease_until=now()+interval '5 minutes',updated_at=now() where id=r.id returning * into r;
 select * into s from public.sources where id=r.source_id;
 return jsonb_build_object('id',r.id,'workspace_id',r.workspace_id,'url',r.url,'sha256',r.sha256,'mime',r.mime,
  'pages',r.pages,'total_pages',r.total_pages,
  'approved_hosts',array(select host from unnest(s.approved_hosts) host where host=any(public.worker_collection_hosts())),
  'lease_token',r.lease_token);
 end loop;
 return null;
end $$;

create function public.complete_notice_ocr(request_id uuid,lease uuid,result jsonb default null,error_code text default null)
returns void language plpgsql security definer set search_path='' as $$
declare r app_private.public_notice_ocr_requests;returned_pages integer[];retryable boolean:=false;
begin
 select * into r from app_private.public_notice_ocr_requests q where q.id=request_id for update;
 if r.id is null or r.status<>'running' or r.lease_token is distinct from lease or r.lease_until<=now() then raise exception 'STALE_LEASE';end if;
 perform 1 from public.jobs where id=r.job_id for update;
 if not app_private.notice_ocr_current(r) then raise exception 'STALE_INPUT';end if;
 if error_code is not null then
  if error_code not in ('NOTICE_OCR_FAILED','NOTICE_OCR_LOW_CONFIDENCE','SOURCE_TIMEOUT','SOURCE_TOO_LARGE','UNSAFE_DESTINATION','SOURCE_CONTENT_CHANGED','SOURCE_DOCUMENT_RESTRICTED')
   or result is not null then raise exception 'INVALID_INPUT';end if;
  retryable:=error_code in ('NOTICE_OCR_FAILED','SOURCE_TIMEOUT') and r.attempts<2;
 else
  if result is null or result->>'sha256' is distinct from r.sha256 or result->>'engine' is distinct from 'tesseract'
   or result->'languages' is distinct from '["ara","eng"]'::jsonb or jsonb_typeof(result->'pages') is distinct from 'array'
   or pg_column_size(result)>262144 then raise exception 'INVALID_INPUT';end if;
  if jsonb_array_length(result->'pages')<>cardinality(r.pages)
   or exists(select 1 from jsonb_array_elements(result->'pages') p where jsonb_typeof(p->'page') is distinct from 'number'
    or coalesce(p->>'page','')!~'^[0-9]+$' or length(coalesce(p->>'text',''))>20000
    or jsonb_typeof(p->'text') is distinct from 'string' or jsonb_typeof(p->'confidence') is distinct from 'number') then raise exception 'INVALID_INPUT';end if;
  returned_pages:=array(select (p->>'page')::integer from jsonb_array_elements(result->'pages') p order by (p->>'page')::integer);
  if returned_pages<>r.pages or (select sum(length(p->>'text')) from jsonb_array_elements(result->'pages') p)>60000
   or exists(select 1 from jsonb_array_elements(result->'pages') p where (p->>'confidence')::numeric not between 0 and 100)
   or not exists(select 1 from jsonb_array_elements(result->'pages') p where length(p->>'text')>=30 and (p->>'confidence')::numeric>=50)
   then raise exception 'INVALID_INPUT';end if;
 end if;
 update app_private.public_notice_ocr_requests set status=case when complete_notice_ocr.error_code is null then 'ready' when retryable then 'queued' else 'blocked' end,
  result=complete_notice_ocr.result,error_code=complete_notice_ocr.error_code,lease_token=null,lease_until=null,updated_at=now() where id=r.id;
 update public.jobs set next_attempt_at=case when retryable then now()+interval '2 minutes' else now() end,revision=revision+1,updated_at=now() where id=r.job_id;
end $$;
revoke all on function public.request_notice_ocr(uuid,uuid,text,text,jsonb,integer,text),public.claim_notice_ocr(),public.complete_notice_ocr(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.request_notice_ocr(uuid,uuid,text,text,jsonb,integer,text),public.claim_notice_ocr(),public.complete_notice_ocr(uuid,uuid,jsonb,text) to service_role;
