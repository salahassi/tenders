-- Detail pages can require the same public JavaScript session as their listing.
-- Bind browser work to its original assessment, notice evidence and source revision.
alter table public.source_browser_requests
 add column purpose text not null default 'listing' check(purpose in ('listing','notice_detail')),
 add column source_id uuid references public.sources(id),
 add column source_revision integer,
 add column notice_hash text,
 add column context_key text not null default '';

-- Retain prior request receipts when a source configuration changes. Listing
-- callers keep the empty context and the existing named conflict constraint.
alter table public.source_browser_requests
 drop constraint source_browser_requests_job_id_url_key,
 add constraint source_browser_requests_job_id_url_key unique(job_id,url,context_key);

create function app_private.source_browser_request_current(r public.source_browser_requests)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from public.jobs j
  where j.id=r.job_id and j.workspace_id=r.workspace_id and j.input_hash=r.input_hash
   and j.status in ('queued','running','retry_wait','quota_wait') and not j.cancel_requested
   and exists(select 1 from public.memberships m join public.identity_allowlist a
    on a.workspace_id=m.workspace_id and a.user_id=m.user_id
    where m.workspace_id=j.workspace_id and m.user_id=j.created_by and m.active and a.status='active'
     and (m.role='Owner' or (j.type='classify_opportunity' and m.role='Editor')))
   and (
    (r.purpose='listing' and j.type in ('source_collect','source_candidates')
     and exists(select 1 from public.source_readings state where state.job_id=j.id
      and state.workspace_id=j.workspace_id and state.pending_url=r.url)
     and (j.type='source_candidates' or exists(select 1 from public.sources s
      where s.id=j.entity_id and s.workspace_id=j.workspace_id and s.approval='approved' and s.revision::text=j.input_hash)))
    or
    (r.purpose='notice_detail' and j.type='classify_opportunity'
     and exists(select 1 from public.generation_plans p
      join public.opportunities o on o.id=p.opportunity_id and o.workspace_id=p.workspace_id
      join public.sources s on s.id=o.source_id and s.workspace_id=o.workspace_id
      where p.id=j.entity_id and p.workspace_id=j.workspace_id and p.kind='assessment'
       and p.status in ('queued','running') and p.input_hash=j.input_hash and not o.archived
       and s.id=r.source_id and s.revision=r.source_revision and s.approval='approved' and s.policy_checked_at is not null
       and o.canonical_url=r.url and p.frozen_context->'notice'->'reference'->>'content_hash'=r.notice_hash
       and app_private.content_record(o.workspace_id,'notice',o.id)->>'content_hash'=r.notice_hash))
   )
 )
$$;
revoke all on function app_private.source_browser_request_current(public.source_browser_requests) from public,anon,authenticated,service_role;

create function public.request_notice_browser(job_id uuid,lease uuid,url text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ctx jsonb;j public.jobs;r public.source_browser_requests;s public.sources;notice_hash text;request_context text;
begin
 ctx:=public.generation_context(job_id,lease);
 if ctx->'step'->>'task' is distinct from 'classify_opportunity' or ctx->'detail_source' is null
  or ctx->'detail_notice'->>'canonical_url' is distinct from url then raise exception 'NOTICE_SOURCE_EVIDENCE_CHANGED';end if;
 select * into j from public.jobs where id=job_id for update;
 select * into s from public.sources where id=(ctx->'detail_source'->>'id')::uuid and workspace_id=j.workspace_id;
 notice_hash:=ctx->'plan'->'frozen_context'->'notice'->'reference'->>'content_hash';
 request_context:=s.id::text||':'||s.revision::text||':'||notice_hash;
 insert into public.source_browser_requests(workspace_id,job_id,url,input_hash,purpose,source_id,source_revision,notice_hash,context_key)
 values(j.workspace_id,j.id,request_notice_browser.url,j.input_hash,'notice_detail',s.id,s.revision,notice_hash,request_context)
 on conflict on constraint source_browser_requests_job_id_url_key do nothing;
 select * into r from public.source_browser_requests b where b.job_id=j.id and b.url=request_notice_browser.url and b.context_key=request_context;
 if not app_private.source_browser_request_current(r) then raise exception 'STALE_INPUT';end if;
 if r.status in ('ready','blocked') then
  return jsonb_build_object('id',r.id,'status',r.status,'page',r.page,'error_code',r.error_code);
 end if;
 update public.jobs set status='retry_wait',error_code='NOTICE_BROWSER_PENDING',next_attempt_at=now()+interval '2 minutes',
  lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
 return jsonb_build_object('id',r.id,'status',r.status);
end $$;
revoke all on function public.request_notice_browser(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.request_notice_browser(uuid,uuid,text) to service_role;

create or replace function public.claim_source_browser_page() returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.source_browser_requests;j public.jobs;tabs jsonb:='[]'::jsonb;candidate_index integer;
begin
 -- Discard stale/exhausted queue heads in this claim, so they cannot delay valid
 -- requests until the next worker schedule. Keep each claim's work bounded.
 for candidate_index in 1..20 loop
 select b.* into r from public.source_browser_requests b join public.jobs q on q.id=b.job_id
 where (b.status='queued' or (b.status='running' and b.lease_until<=now()))
  and q.status in ('queued','retry_wait','quota_wait') and not q.cancel_requested
 order by b.created_at,b.id for update of b skip locked limit 1;
 if r.id is null then return null;end if;
 select * into j from public.jobs where id=r.job_id;
 if not app_private.source_browser_request_current(r) then
  update public.source_browser_requests set status='blocked',error_code='STALE_INPUT',lease_token=null,lease_until=null,updated_at=now() where id=r.id;continue;
 end if;
 if r.attempts>=2 then
  update public.source_browser_requests set status='blocked',error_code='SOURCE_BROWSER_FAILED',lease_token=null,lease_until=null,updated_at=now() where id=r.id;
  update public.jobs set next_attempt_at=now() where id=j.id;continue;
 end if;
 update public.source_browser_requests set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),
  lease_until=now()+interval '3 minutes',updated_at=now() where id=r.id returning * into r;
 if r.purpose='notice_detail' then
  select coalesce(s.adapter_config->'extraction'->'detail'->'render_tabs','[]'::jsonb) into tabs from public.sources s where s.id=r.source_id;
  if jsonb_typeof(tabs) is distinct from 'array' or jsonb_array_length(tabs)>3
   or exists(select 1 from jsonb_array_elements(tabs) t where jsonb_typeof(t) is distinct from 'string' or length(t#>>'{}') not between 1 and 300)
   then raise exception 'INVALID_INPUT';end if;
 end if;
 return jsonb_build_object('id',r.id,'url',r.url,'workspace_id',r.workspace_id,'lease_token',r.lease_token,'read_tabs',tabs);
 end loop;
 return null;
end $$;

-- Preserve the existing response shape and field bounds; only the authorization
-- predicate is shared with notice-detail requests.
do $patch$ declare definition text;old text;begin
 select pg_get_functiondef('public.complete_source_browser_page(uuid,uuid,jsonb,text)'::regprocedure) into definition;
 old:=$old$if j.cancel_requested or j.status not in ('queued','retry_wait','quota_wait') or j.input_hash is distinct from r.input_hash or state.pending_url is distinct from r.url
  or (j.type='source_collect' and not exists(select 1 from public.sources s where s.id=j.entity_id and s.workspace_id=j.workspace_id and s.approval='approved' and s.revision::text=j.input_hash))
  or not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=j.workspace_id and m.user_id=j.created_by and m.role='Owner' and m.active and a.status='active') then$old$;
 if position(old in definition)=0 then raise exception 'Browser completion guard changed';end if;
 execute replace(definition,old,$new$if j.status not in ('queued','retry_wait','quota_wait') or not app_private.source_browser_request_current(r) then$new$);
end $patch$;

-- Session/challenge operations use the same current request binding as publish.
-- They retain their existing lease, encryption scope and human-answer lifetime.
do $patch$ declare signature text;definition text;marker text;begin
 marker:=$old$then raise exception 'STALE_LEASE';end if;$old$;
 foreach signature in array array[
  'public.source_browser_identity(uuid,uuid)',
  'public.source_browser_session(uuid,uuid,text)',
  'public.source_browser_challenge(uuid,uuid,text)'
 ] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  if position(marker in definition)=0 then raise exception 'Browser session lease guard changed';end if;
  execute replace(definition,marker,marker||E'\n if not app_private.source_browser_request_current(r) then raise exception ''STALE_INPUT'';end if;');
 end loop;
end $patch$;

create or replace function public.source_verification(source_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.sources;r public.source_browser_requests;
begin
 select * into s from public.sources where id=source_id;
 if s.id is null or app_private.member_role(s.workspace_id) is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 select b.* into r from public.source_browser_requests b join public.jobs j on j.id=b.job_id
 where j.workspace_id=s.workspace_id and ((b.purpose='listing' and j.entity_id=s.id) or (b.purpose='notice_detail' and b.source_id=s.id))
  and app_private.source_browser_request_current(b) and b.status='running' and b.challenge_id is not null
  and b.challenge_expires_at>now() order by b.created_at desc limit 1;
 if r.id is null then return null;end if;
 return jsonb_build_object('id',r.id,'challenge_id',r.challenge_id,'image',r.challenge_image,
  'expires_at',r.challenge_expires_at,'url',r.url);
end $$;

-- Manual answers remain Owner-only, single-use, expiring and audit-redacted.
do $patch$ declare definition text;old text;candidate record;n integer:=0;begin
 old:=$old$or not exists(select 1 from public.sources s where s.id=j.entity_id and s.workspace_id=r.workspace_id and s.approval='approved' and s.revision::text=j.input_hash) then raise exception 'SOURCE_VERIFICATION_EXPIRED';end if;$old$;
 for candidate in select p.oid from pg_proc p join pg_namespace nsp on nsp.oid=p.pronamespace
  where nsp.nspname='public' and p.proname like 'app_command%' and position(old in p.prosrc)>0 loop
  definition:=pg_get_functiondef(candidate.oid);
  execute replace(definition,old,$new$or not app_private.source_browser_request_current(r) then raise exception 'SOURCE_VERIFICATION_EXPIRED';end if;$new$);
  n:=n+1;
 end loop;
 if n<>1 then raise exception 'Browser manual-answer guard changed';end if;
end $patch$;
