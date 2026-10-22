-- A bounded public browser queue: Edge Functions cannot launch Chromium.
-- The trusted browser worker receives public URLs only; all application writes
-- retain current source, input, membership and exclusive-lease checks.
create table public.source_browser_requests (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 job_id uuid not null references public.jobs(id) on delete cascade,
 url text not null check(url ~ '^https://[a-zA-Z0-9.-]+([/:?]|$)'),
 input_hash text not null,
 status text not null default 'queued' check(status in ('queued','running','ready','blocked')),
 page jsonb,
 error_code text,
 challenge_id uuid,
 challenge_image text,
 challenge_expires_at timestamptz,
 lease_token uuid,
 lease_until timestamptz,
 attempts integer not null default 0,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(job_id,url),
 foreign key(workspace_id,job_id) references public.jobs(workspace_id,id),
 check(page is null or pg_column_size(page)<=262144)
);
alter table public.source_browser_requests enable row level security;
revoke all on public.source_browser_requests from public,anon,authenticated;
grant select on public.source_browser_requests to authenticated;
grant all on public.source_browser_requests to service_role;
create policy member_read on public.source_browser_requests for select to authenticated using(app_private.member_role(workspace_id) is not null);
create index source_browser_pending on public.source_browser_requests(status,created_at);

create function public.source_browser_page(job_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ctx jsonb;r public.source_browser_requests;j public.jobs;
begin
 ctx:=public.auto_source_context(job_id,lease);
 select * into j from public.jobs where id=job_id;
 select * into r from public.source_browser_requests b where b.job_id=j.id and b.url=ctx->'state'->>'pending_url';
 if r.id is null then return null;end if;
 if r.input_hash is distinct from j.input_hash then raise exception 'STALE_INPUT';end if;
 return jsonb_build_object('id',r.id,'status',r.status,'page',r.page,'error_code',r.error_code);
end $$;

create function public.queue_source_browser_page(job_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ctx jsonb;j public.jobs;r public.source_browser_requests;target text;
begin
 ctx:=public.auto_source_context(job_id,lease);
 select * into j from public.jobs where id=job_id for update;
 target:=ctx->'state'->>'pending_url';
 if target !~ '^https://[a-zA-Z0-9.-]+([/:?]|$)' then raise exception 'UNSAFE_DESTINATION';end if;
 if (select count(*) from public.source_browser_requests b where b.job_id=j.id)>=5
  and not exists(select 1 from public.source_browser_requests b where b.job_id=j.id and b.url=target) then raise exception 'SOURCE_NAVIGATION_LIMIT';end if;
 insert into public.source_browser_requests(workspace_id,job_id,url,input_hash) values(j.workspace_id,j.id,target,j.input_hash)
 on conflict on constraint source_browser_requests_job_id_url_key do nothing;
 select * into r from public.source_browser_requests b where b.job_id=j.id and b.url=target;
 if r.input_hash is distinct from j.input_hash then raise exception 'STALE_INPUT';end if;
 update public.source_readings set page=null,page_hash=null,updated_at=now() where source_readings.job_id=j.id;
 update public.jobs set status='retry_wait',error_code='SOURCE_BROWSER_PENDING',next_attempt_at=case when r.status in ('ready','blocked') then now() else now()+interval '2 minutes' end,lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
 return jsonb_build_object('waiting_for_browser',true,'request_id',r.id);
end $$;

create function public.claim_source_browser_page() returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.source_browser_requests;j public.jobs;ctx public.source_readings;s public.sources;
begin
 select b.* into r from public.source_browser_requests b join public.jobs q on q.id=b.job_id
 where (b.status='queued' or (b.status='running' and b.lease_until<=now()))
  and q.status in ('queued','retry_wait','quota_wait') and not q.cancel_requested
 order by b.created_at,b.id for update of b skip locked limit 1;
 if r.id is null then return null;end if;
 select * into j from public.jobs where id=r.job_id;
 select * into ctx from public.source_readings where job_id=j.id;
 select * into s from public.sources where id=j.entity_id and workspace_id=j.workspace_id;
 if j.input_hash is distinct from r.input_hash or ctx.pending_url is distinct from r.url
  or (j.type='source_collect' and (s.approval is distinct from 'approved' or s.revision::text is distinct from j.input_hash))
  or not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=j.workspace_id and m.user_id=j.created_by and m.role='Owner' and m.active and a.status='active') then
  update public.source_browser_requests set status='blocked',error_code='STALE_INPUT',updated_at=now() where id=r.id;return null;
 end if;
 if r.attempts>=2 then
  update public.source_browser_requests set status='blocked',error_code='SOURCE_BROWSER_FAILED',updated_at=now() where id=r.id;
  update public.jobs set next_attempt_at=now() where id=j.id;return null;
 end if;
 update public.source_browser_requests set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',updated_at=now() where id=r.id returning * into r;
 return jsonb_build_object('id',r.id,'url',r.url,'workspace_id',r.workspace_id,'lease_token',r.lease_token);
end $$;

create function public.complete_source_browser_page(request_id uuid,lease uuid,page jsonb default null,error_code text default null) returns void
language plpgsql security definer set search_path='' as $$
declare r public.source_browser_requests;j public.jobs;state public.source_readings;
begin
 select * into r from public.source_browser_requests where id=request_id for update;
 if r.id is null or r.status<>'running' or r.lease_token is distinct from lease or r.lease_until<=now() then raise exception 'STALE_LEASE';end if;
 select * into j from public.jobs where id=r.job_id for update;
 select * into state from public.source_readings where job_id=j.id;
 if j.cancel_requested or j.status not in ('queued','retry_wait','quota_wait') or j.input_hash is distinct from r.input_hash or state.pending_url is distinct from r.url
  or (j.type='source_collect' and not exists(select 1 from public.sources s where s.id=j.entity_id and s.workspace_id=j.workspace_id and s.approval='approved' and s.revision::text=j.input_hash))
  or not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=j.workspace_id and m.user_id=j.created_by and m.role='Owner' and m.active and a.status='active') then raise exception 'STALE_INPUT';end if;
 if error_code is not null then
  if error_code not in ('SOURCE_HUMAN_VERIFICATION_REQUIRED','SOURCE_LOGIN_REQUIRED','SOURCE_BROWSER_FAILED','SOURCE_TIMEOUT','UNSAFE_DESTINATION','SOURCE_TOO_LARGE') then raise exception 'INVALID_INPUT';end if;
 else
  if page is null or page->>'requested_url' is distinct from r.url or coalesce(page->>'url','')!~'^https://[a-zA-Z0-9.-]+([/:?]|$)'
   or page->'rendered' is distinct from 'true'::jsonb or length(coalesce(page->>'text','')) not between 20 and 60000
   or jsonb_typeof(page->'links') is distinct from 'array' or jsonb_array_length(page->'links')>200 or pg_column_size(page)>262144
   or exists(select 1 from jsonb_array_elements(page->'links') l where coalesce(l->>'url','')!~'^https://[a-zA-Z0-9.-]+([/:?]|$)' or coalesce(l->>'id','')!~'^L[0-9]+$') then raise exception 'INVALID_INPUT';end if;
 end if;
 update public.source_browser_requests set status=case when complete_source_browser_page.error_code is null then 'ready' else 'blocked' end,page=complete_source_browser_page.page,error_code=complete_source_browser_page.error_code,lease_token=null,lease_until=null,updated_at=now() where id=r.id;
 update public.jobs set next_attempt_at=now(),updated_at=now() where id=j.id;
end $$;
revoke all on function public.source_browser_page(uuid,uuid),public.queue_source_browser_page(uuid,uuid),public.claim_source_browser_page(),public.complete_source_browser_page(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.source_browser_page(uuid,uuid),public.queue_source_browser_page(uuid,uuid),public.claim_source_browser_page(),public.complete_source_browser_page(uuid,uuid,jsonb,text) to service_role;

-- Captcha answers and encrypted session state never enter a readable API table.
create table app_private.source_browser_answers (
 request_id uuid primary key references public.source_browser_requests(id) on delete cascade,
 challenge_id uuid not null,
 answer text not null check(length(answer) between 1 and 40)
);
create table app_private.source_browser_sessions (
 workspace_id uuid not null references public.workspaces(id),
 host text not null,
 sealed_state text not null check(length(sealed_state)<=1048576),
 expires_at timestamptz not null,
 primary key(workspace_id,host)
);
alter table app_private.source_browser_answers enable row level security;
alter table app_private.source_browser_sessions enable row level security;
revoke all on app_private.source_browser_answers,app_private.source_browser_sessions from public,anon,authenticated,service_role;

create function public.source_browser_challenge(request_id uuid,lease uuid,image text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.source_browser_requests;a app_private.source_browser_answers;
begin
 select * into r from public.source_browser_requests where id=request_id for update;
 if r.status is distinct from 'running' or r.lease_token is distinct from lease or r.lease_until<=now() then raise exception 'STALE_LEASE';end if;
 if image is not null then
  if length(image)>200000 or image !~ '^data:image/png;base64,[A-Za-z0-9+/=]+$' then raise exception 'INVALID_INPUT';end if;
  delete from app_private.source_browser_answers where source_browser_answers.request_id=r.id;
  update public.source_browser_requests set challenge_id=gen_random_uuid(),challenge_image=image,challenge_expires_at=now()+interval '3 minutes',lease_until=now()+interval '4 minutes',updated_at=now() where id=r.id;
  return jsonb_build_object('published',true);
 end if;
 if r.challenge_expires_at<=now() then return jsonb_build_object('expired',true);end if;
 delete from app_private.source_browser_answers where source_browser_answers.request_id=r.id and challenge_id=r.challenge_id returning * into a;
 return case when a.request_id is null then '{}'::jsonb else jsonb_build_object('answer',a.answer) end;
end $$;

create function public.source_browser_session(request_id uuid,lease uuid,sealed_state text default null) returns text
language plpgsql security definer set search_path='' as $$
declare r public.source_browser_requests;request_host text;cached text;
begin
 select * into r from public.source_browser_requests where id=request_id;
 if r.status is distinct from 'running' or r.lease_token is distinct from lease or r.lease_until<=now() then raise exception 'STALE_LEASE';end if;
 request_host:=lower(substring(r.url from '^https://([^/:?]+)'));
 if sealed_state is not null then
  if length(sealed_state)>1048576 then raise exception 'INVALID_INPUT';end if;
  insert into app_private.source_browser_sessions(workspace_id,host,sealed_state,expires_at)
  values(r.workspace_id,request_host,sealed_state,now()+interval '4 hours') on conflict on constraint source_browser_sessions_pkey do update set sealed_state=excluded.sealed_state,expires_at=excluded.expires_at;
  return null;
 end if;
 select s.sealed_state into cached from app_private.source_browser_sessions s where s.workspace_id=r.workspace_id and s.host=request_host and s.expires_at>now();
 return cached;
end $$;

create function public.source_verification(source_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.sources;r public.source_browser_requests;
begin
 select * into s from public.sources where id=source_id;
 if s.id is null or app_private.member_role(s.workspace_id) is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 select b.* into r from public.source_browser_requests b join public.jobs j on j.id=b.job_id
 where j.entity_id=s.id and j.workspace_id=s.workspace_id and not j.cancel_requested and b.status='running'
  and b.challenge_id is not null and b.challenge_expires_at>now() order by b.created_at desc limit 1;
 if r.id is null then return null;end if;
 return jsonb_build_object('id',r.id,'challenge_id',r.challenge_id,'image',r.challenge_image,'expires_at',r.challenge_expires_at,'url',r.url);
end $$;
revoke all on function public.source_browser_challenge(uuid,uuid,text),public.source_browser_session(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.source_browser_challenge(uuid,uuid,text),public.source_browser_session(uuid,uuid,text) to service_role;
revoke all on function public.source_verification(uuid) from public,anon;
grant execute on function public.source_verification(uuid) to authenticated;

alter function public.app_command(text,jsonb,text) rename to app_command_before_browser;
revoke all on function public.app_command_before_browser(text,jsonb,text) from public,anon,authenticated;
create function public.app_command(operation text,input jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.source_browser_requests;j public.jobs;actor uuid:=auth.uid();h text;replay app_private.idempotency_records;result jsonb;
begin
 if operation<>'source.verification.answer' then return public.app_command_before_browser(operation,input,idempotency_key);end if;
 select * into r from public.source_browser_requests where id=(input->>'id')::uuid;
 if r.id is null or app_private.member_role(r.workspace_id) is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 perform 1 from public.workspaces where id=r.workspace_id for update;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 then raise exception 'INVALID_INPUT';end if;
 perform app_private.check_keys(input,array['id','challenge_id','answer']);
 h:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=r.workspace_id and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key and expires_at>now();
 if replay.key is not null then if replay.body_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 select * into r from public.source_browser_requests where id=r.id for update;
 select * into j from public.jobs where id=r.job_id;
 if r.status<>'running' or r.challenge_id is distinct from (input->>'challenge_id')::uuid or r.challenge_expires_at<=now() or r.lease_until<=now() or j.cancel_requested or j.input_hash is distinct from r.input_hash
  or not exists(select 1 from public.sources s where s.id=j.entity_id and s.workspace_id=r.workspace_id and s.approval='approved' and s.revision::text=j.input_hash) then raise exception 'SOURCE_VERIFICATION_EXPIRED';end if;
 if length(trim(coalesce(input->>'answer',''))) not between 1 and 40 or input->>'answer' !~ '^[A-Za-z0-9 -]+$' then raise exception 'INVALID_INPUT';end if;
 insert into app_private.source_browser_answers values(r.id,r.challenge_id,trim(input->>'answer')) on conflict(request_id) do update set answer=excluded.answer,challenge_id=excluded.challenge_id;
 result:=jsonb_build_object('id',r.id,'submitted',true);
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,details) values(r.workspace_id,actor,operation,r.id,jsonb_build_object('job_id',r.job_id,'answer_redacted',true));
 delete from app_private.idempotency_records where workspace_id=r.workspace_id and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(r.workspace_id,actor,'COMMAND',operation,idempotency_key,h,result);
 return result;
end $$;
revoke all on function public.app_command(text,jsonb,text) from public,anon;
grant execute on function public.app_command(text,jsonb,text) to authenticated;
