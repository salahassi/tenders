alter table public.sources add column etag text,add column last_modified text,add column policy_checked_at timestamptz,add column adapter_required boolean not null default false;
create table public.opportunity_source_links (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),opportunity_id uuid not null,source_id uuid not null,
 identity_key text not null check(length(identity_key)<=2200),created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),revision integer not null default 1,
 unique(workspace_id,id),unique(workspace_id,source_id,identity_key),foreign key(workspace_id,source_id) references public.sources(workspace_id,id),foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id)
);
create table public.advertisement_snapshots (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),opportunity_id uuid not null,source_link_id uuid not null,
 content jsonb not null check(pg_column_size(content)<=131072),evidence_hash text not null check(length(evidence_hash)=64),created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),revision integer not null default 1,
 unique(workspace_id,id),unique(workspace_id,source_link_id,evidence_hash),foreign key(workspace_id,source_link_id) references public.opportunity_source_links(workspace_id,id),foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id)
);
create table public.source_runs (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),source_id uuid not null,job_id uuid not null,
 http_status integer,status text not null,counts jsonb not null default '{}',warnings jsonb not null default '[]',error_code text,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),revision integer not null default 1,
 unique(workspace_id,job_id),foreign key(workspace_id,source_id) references public.sources(workspace_id,id),foreign key(workspace_id,job_id) references public.jobs(workspace_id,id)
);
create table public.import_batches (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),kind text not null check(kind in ('tenders','sources')),
 rows jsonb not null check(jsonb_array_length(rows) between 1 and 100 and pg_column_size(rows)<=1048576),preview_hash text not null,
 committed_at timestamptz,expires_at timestamptz not null default now()+interval '24 hours',created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id)
);
alter table public.opportunities add column import_batch_id uuid references public.import_batches(id),add column import_row integer,add column source_name text;
create unique index manual_source_per_workspace on public.sources(workspace_id) where kind='manual' and name='Added by you';
create index source_link_opportunity on public.opportunity_source_links(workspace_id,opportunity_id);
create index snapshots_opportunity on public.advertisement_snapshots(workspace_id,opportunity_id,created_at);
do $$ declare t text;begin
 foreach t in array array['opportunity_source_links','advertisement_snapshots','source_runs','import_batches'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 execute format('create policy member_read on public.%I for select to authenticated using(app_private.member_role(workspace_id) is not null)',t);
 end loop;
end $$;
create function app_private.notify_members(w uuid,event_key text,title text,body text,entity uuid,actor uuid) returns void language sql security definer set search_path='' as $$
 insert into public.notifications(workspace_id,recipient_user_id,title,body,entity_id,dedupe_key,created_by)
 select w,user_id,title,body,entity,event_key,actor from public.memberships where workspace_id=w and active on conflict(workspace_id,recipient_user_id,dedupe_key) do nothing
$$;
revoke all on function app_private.notify_members(uuid,text,text,text,uuid,uuid) from public,anon,authenticated;
create function app_private.ingest_notice(w uuid,s public.sources,item jsonb,actor uuid,batch uuid default null,row_number integer default null) returns uuid language plpgsql security definer set search_path='' as $$
declare linked public.opportunity_source_links;opportunity uuid;digest text;fresh boolean:=false;
begin
 if length(coalesce(item->>'title','')) not between 1 and 1000 or length(coalesce(item->>'identity_key','')) not between 1 and 2200 then raise exception 'INVALID_SOURCE_ITEM'; end if;
 select * into linked from public.opportunity_source_links where workspace_id=w and source_id=s.id and identity_key=item->>'identity_key';
 digest:=encode(sha256(convert_to((item-'identity_key')::text,'UTF8')),'hex');
 if linked.id is not null and exists(select 1 from public.advertisement_snapshots where source_link_id=linked.id and evidence_hash=digest) then return linked.opportunity_id; end if;
 if (select coalesce(sum(pg_column_size(content)),0) from public.advertisement_snapshots where workspace_id=w)+pg_column_size(item)>20971520 then raise exception 'SNAPSHOT_CAP_REACHED'; end if;
 if linked.id is null then
  if (select count(*) from public.opportunities where workspace_id=w)>=2000 then raise exception 'OPPORTUNITY_CAP_REACHED'; end if;
  insert into public.opportunities(workspace_id,source_id,title,description,buyer,reference,canonical_url,language,deadline_raw,created_by,import_batch_id,import_row,source_name)
  values(w,s.id,item->>'title',coalesce(item->>'description',''),coalesce(item->>'buyer',''),coalesce(item->>'reference',''),item->>'canonical_url',coalesce(item->>'language','en'),item->>'deadline_raw',actor,batch,row_number,item->>'source_name') returning id into opportunity;
  insert into public.opportunity_source_links(workspace_id,opportunity_id,source_id,identity_key,created_by) values(w,opportunity,s.id,item->>'identity_key',actor) returning * into linked;fresh:=true;
 else
  opportunity:=linked.opportunity_id;
  -- New evidence cannot undo a user's decision or silently resolve a date timezone.
  update public.opportunities set title=item->>'title',description=coalesce(item->>'description',''),buyer=coalesce(item->>'buyer',''),reference=coalesce(item->>'reference',''),canonical_url=item->>'canonical_url',deadline_raw=item->>'deadline_raw',deadline_at=case when deadline_raw is not distinct from item->>'deadline_raw' then deadline_at else null end,deadline_timezone=case when deadline_raw is not distinct from item->>'deadline_raw' then deadline_timezone else null end,revision=revision+1,updated_at=now() where id=opportunity;
 end if;
 insert into public.advertisement_snapshots(workspace_id,opportunity_id,source_link_id,content,evidence_hash,created_by) values(w,opportunity,linked.id,item-'identity_key',digest,actor);
 perform app_private.notify_members(w,'notice:'||linked.id||':'||digest,case when fresh then 'New opportunity' else 'Source notice changed' end,item->>'title',opportunity,actor);
 return opportunity;
end $$;
revoke all on function app_private.ingest_notice(uuid,public.sources,jsonb,uuid,uuid,integer) from public,anon,authenticated;

alter function app_private.app_command(text,jsonb,text) rename to evidence_command;
revoke all on function app_private.evidence_command(text,jsonb,text) from public,anon,authenticated,service_role;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();w uuid;r text;body_hash text;replay app_private.idempotency_records;result jsonb;target uuid;src public.sources;batch public.import_batches;item jsonb;n integer:=0;job uuid;operation_key text;
begin
 if operation not in ('source.configure','source.collect','source.action','job.action','import.preview','import.commit') then return app_private.evidence_command(operation,input,idempotency_key); end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;
 if w is null then raise exception 'ACCESS_PENDING'; end if;
 perform 1 from public.workspaces where id=w for update;r:=app_private.member_role(w);
 if r is null then raise exception 'ACCESS_PENDING'; end if;
 if r='Reviewer' or (operation like 'source.%' and r<>'Owner') then raise exception 'ROLE_FORBIDDEN'; end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(input)>1048576 then raise exception 'INVALID_INPUT'; end if;
 body_hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then if replay.body_hash<>body_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;return replay.result;end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 target:=(input->>'id')::uuid;
 if operation like 'source.%' then
  select * into src from public.sources where workspace_id=w and id=target for update;
  if src.id is null then raise exception 'NOT_FOUND'; end if;
  if src.revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT'; end if;
 end if;
 case operation
 when 'source.configure' then
  perform app_private.check_keys(input,array['id','expected_revision','url','kind','approved_hosts','policy_note','poll_interval_hours','adapter_config']);
  update public.sources set url=input->>'url',kind=input->>'kind',approved_hosts=array(select jsonb_array_elements_text(input->'approved_hosts')),policy_note=input->>'policy_note',poll_interval_hours=(input->>'poll_interval_hours')::int,adapter_config=input->'adapter_config',approval='paused',next_due=null,health='unknown',adapter_required=false,etag=null,last_modified=null,policy_checked_at=now(),revision=revision+1,updated_at=now() where id=target returning to_jsonb(sources.*) into result;
 when 'source.action' then
  perform app_private.check_keys(input,array['id','expected_revision','action','reason']);
  if input->>'action'='approve' then
   if src.kind='manual' or src.adapter_required then raise exception 'ADAPTER_REQUIRED'; end if;
   if cardinality(src.approved_hosts)=0 or length(trim(src.policy_note))=0 then raise exception 'SOURCE_POLICY_REQUIRED'; end if;
   if src.approval<>'approved' and (select count(*) from public.sources where workspace_id=w and approval='approved' and kind<>'manual')>=5 then raise exception 'SOURCE_CAP_REACHED'; end if;
  end if;
  if input->>'action' not in ('approve','pause','reject') then raise exception 'INVALID_INPUT'; end if;
  update public.sources set approval=case input->>'action' when 'approve' then 'approved' when 'pause' then 'paused' else 'rejected' end,next_due=case when input->>'action'='approve' then now() else null end,policy_checked_at=case when input->>'action'='approve' then now() else policy_checked_at end,revision=revision+1,updated_at=now() where id=target returning to_jsonb(sources.*) into result;
 when 'source.collect' then
  perform app_private.check_keys(input,array['id','expected_revision']);
  if src.approval<>'approved' or src.kind='manual' or src.adapter_required then raise exception 'SOURCE_PERMISSION_REQUIRED'; end if;
  if (select count(*) from public.jobs where workspace_id=w and status in ('queued','running','retry_wait','quota_wait','blocked'))>=500 then raise exception 'JOB_CAP_REACHED'; end if;
  if exists(select 1 from public.jobs where workspace_id=w and entity_id=target and type='source_collect' and status in ('queued','running','retry_wait')) then raise exception 'JOB_ALREADY_PENDING'; end if;
  insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by) values(w,'source_collect',target,src.revision::text,'queued',actor) returning id into job;
  result:=jsonb_build_object('id',target,'job_id',job,'status','queued');
 when 'job.action' then
  perform app_private.check_keys(input,array['id','expected_revision','action','reason']);
  if length(trim(coalesce(input->>'reason','')))=0 then raise exception 'REASON_REQUIRED'; end if;
  if input->>'action'='cancel' then
   update public.jobs set cancel_requested=true,status=case when status='running' then 'running' else 'canceled' end,revision=revision+1,updated_at=now() where workspace_id=w and id=target and revision=(input->>'expected_revision')::int and status in ('queued','running','retry_wait','quota_wait','blocked','failed') returning to_jsonb(jobs.*) into result;
  elsif input->>'action'='retry' then
   if exists(select 1 from public.jobs where id=target and error_code in ('USAGE_UNKNOWN','LEASE_EXPIRED_REVIEW_REQUIRED')) then raise exception 'USAGE_REVIEW_REQUIRED'; end if;
   update public.jobs set status=case when type like 'source_%' then 'queued' else 'blocked' end,cancel_requested=false,attempts=0,next_attempt_at=now(),error_code=case when type like 'source_%' then null else 'MODEL_NOT_CONFIGURED' end,input_hash=case when type like 'source_%' then (select revision::text from public.sources where id=entity_id) else input_hash end,revision=revision+1,updated_at=now() where workspace_id=w and id=target and revision=(input->>'expected_revision')::int and status in ('blocked','failed','canceled','quota_wait') returning to_jsonb(jobs.*) into result;
  else raise exception 'INVALID_INPUT';end if;
  if result is null then raise exception 'REVISION_CONFLICT';end if;
 when 'import.preview' then
  perform app_private.check_keys(input,array['kind','rows']);
  insert into public.import_batches(workspace_id,kind,rows,preview_hash,created_by) values(w,input->>'kind',input->'rows',body_hash,actor) returning to_jsonb(import_batches.*) into result;
 when 'import.commit' then
  perform app_private.check_keys(input,array['id','expected_revision','preview_hash']);
  select * into batch from public.import_batches where workspace_id=w and id=target and created_by=actor for update;
  if batch.id is null then raise exception 'NOT_FOUND'; end if;
  if batch.preview_hash<>input->>'preview_hash' or batch.revision<>(input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  if batch.committed_at is not null then raise exception 'IMPORT_ALREADY_COMMITTED';end if;
  if batch.expires_at<now() then raise exception 'IMPORT_EXPIRED';end if;
  if batch.kind='tenders' then
   select * into src from public.sources where workspace_id=w and kind='manual' and name='Added by you';
   if src.id is null then insert into public.sources(workspace_id,name,kind,created_by) values(w,'Added by you','manual',actor) returning * into src;end if;
  end if;
  for item in select value from jsonb_array_elements(batch.rows) loop
   n:=n+1;
   if batch.kind='tenders' then perform app_private.ingest_notice(w,src,item,actor,batch.id,n);
   elsif not exists(select 1 from public.sources where workspace_id=w and url=item->>'url') then
    insert into public.sources(workspace_id,name,kind,url,adapter_required,policy_note,created_by) values(w,item->>'name','manual',item->>'url',true,'Imported candidate: select a supported adapter and confirm collection permission.',actor);
   end if;
  end loop;
  update public.import_batches set committed_at=now(),revision=revision+1 where id=target returning to_jsonb(import_batches.*)||jsonb_build_object('processed',n) into result;
 end case;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,request_id) values(w,actor,operation,coalesce(target,(result->>'id')::uuid),gen_random_uuid());
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,body_hash,result);
 return result;
end $$;
revoke all on function app_private.app_command(text,jsonb,text) from public,anon;
grant execute on function app_private.app_command(text,jsonb,text) to authenticated;

create or replace function public.claim_backend_job() returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;j public.jobs;s public.sources;
begin
 select id into w from public.workspaces limit 1;if w is null then return null;end if;
 perform 1 from public.workspaces where id=w for update;
 update public.operations set last_heartbeat_at=now(),scheduler_enabled=coalesce((select enabled from app_private.dispatcher_settings where singleton),false) where workspace_id=w;
 update public.jobs set status=case when cancel_requested then 'canceled' when type like 'source_%' and attempts<4 then 'retry_wait' else 'blocked' end,error_code=case when type like 'source_%' then 'COLLECTION_LEASE_EXPIRED' else 'LEASE_EXPIRED_REVIEW_REQUIRED' end,lease_token=null,lease_until=null,next_attempt_at=now()+interval '1 minute',revision=revision+1,updated_at=now() where workspace_id=w and status='running' and lease_until<now();
 for s in select * from public.sources where workspace_id=w and approval='approved' and kind<>'manual' and not adapter_required and next_due<=now() order by next_due,id loop
  exit when (select count(*) from public.jobs where workspace_id=w and status in ('queued','running','retry_wait','quota_wait','blocked'))>=500;
  if not exists(select 1 from public.jobs where workspace_id=w and entity_id=s.id and type='source_collect' and status in ('queued','running','retry_wait')) then
   insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by) values(w,'source_collect',s.id,s.revision::text,'queued',s.created_by);
  end if;
  update public.sources set next_due=now()+make_interval(hours=>s.poll_interval_hours) where id=s.id;
 end loop;
 if exists(select 1 from public.jobs where workspace_id=w and status='running') then return null; end if;
 select * into j from public.jobs where workspace_id=w and status in ('queued','retry_wait','quota_wait') and next_attempt_at<=now() order by case when created_at<now()-interval '1 hour' then 0 when type in ('plan_proposal','analyze_chunk','draft_section') then 1 else 2 end,created_at,id for update skip locked limit 1;
 if j.id is null then return null;end if;
 if j.cancel_requested then update public.jobs set status='canceled',revision=revision+1 where id=j.id;return null;end if;
 update public.jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '180 seconds',revision=revision+1,updated_at=now() where id=j.id returning * into j;
 return to_jsonb(j);
end $$;
create or replace function public.finish_backend_job(job_id uuid,lease uuid,result_status text,result_error text) returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;w uuid;
begin
 select workspace_id into w from public.jobs where id=job_id;perform 1 from public.workspaces where id=w for update;
 select * into j from public.jobs where id=job_id for update;
 if j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() then raise exception 'STALE_LEASE';end if;
 if result_status not in ('succeeded','retry_wait','quota_wait','blocked','failed','canceled') then raise exception 'INVALID_INPUT';end if;
 if result_status='succeeded' and not exists(select 1 from public.source_runs where source_runs.job_id=j.id and status='succeeded') then raise exception 'HANDLER_NOT_IMPLEMENTED';end if;
 if result_status='retry_wait' and j.attempts>=4 then result_status:='failed';end if;
 update public.jobs set status=case when cancel_requested then 'canceled' else result_status end,error_code=result_error,lease_token=null,lease_until=null,next_attempt_at=case when result_status='retry_wait' then now()+make_interval(secs=> (case j.attempts when 1 then 60 when 2 then 300 else 1800 end)*(0.8+random()*0.4)) when result_status='quota_wait' then 'infinity'::timestamptz else next_attempt_at end,revision=revision+1,updated_at=now() where id=job_id;
 if result_status in ('blocked','failed','quota_wait') and not j.cancel_requested then perform app_private.notify_members(w,'job:'||j.id||':'||result_status,'Processing needs attention',coalesce(result_error,'Unknown failure'),j.entity_id,j.created_by);end if;
end $$;
create function public.collection_context(job_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.sources;
begin
 select * into j from public.jobs where id=job_id;
 if j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 select * into s from public.sources where workspace_id=j.workspace_id and id=j.entity_id;
 if s.id is null or s.approval<>'approved' or s.kind='manual' or s.adapter_required then raise exception 'SOURCE_PERMISSION_REQUIRED';end if;
 if s.revision::text<>j.input_hash then raise exception 'STALE_INPUT';end if;
 return to_jsonb(s);
end $$;
create function public.complete_collection(job_id uuid,lease uuid,result jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.sources;item jsonb;n integer:=0;c integer:=0;w uuid;
begin
 select workspace_id into w from public.jobs where id=job_id;perform 1 from public.workspaces where id=w for update;
 select * into j from public.jobs where id=job_id for update;
 if j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() then raise exception 'STALE_LEASE';end if;
 if j.cancel_requested then perform public.finish_backend_job(job_id,lease,'canceled',null);return jsonb_build_object('canceled',true);end if;
 perform public.collection_context(job_id,lease);
 select * into s from public.sources where id=j.entity_id;
 if jsonb_array_length(result->'items')>100 or jsonb_array_length(result->'candidates')>100 then raise exception 'SOURCE_ITEM_CAP_REACHED';end if;
 if (select coalesce(sum(pg_total_relation_size(c.oid)),0)>262144000 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private') and c.relkind='r') then raise exception 'DATABASE_CAP_REACHED';end if;
 for item in select value from jsonb_array_elements(result->'items') loop perform app_private.ingest_notice(w,s,item,j.created_by);n:=n+1;end loop;
 for item in select value from jsonb_array_elements(result->'candidates') loop
  if not exists(select 1 from public.sources where workspace_id=w and url=item->>'url') and (select count(*) from public.sources where workspace_id=w)<500 then
   insert into public.sources(workspace_id,name,kind,url,adapter_required,policy_note,created_by) values(w,item->>'name','manual',item->>'url',true,'Discovered from '||s.url||'. Permission and supported adapter required.',j.created_by);c:=c+1;
  end if;
 end loop;
 insert into public.source_runs(workspace_id,source_id,job_id,http_status,status,counts,warnings,created_by) values(w,s.id,j.id,(result->>'status')::int,'succeeded',jsonb_build_object('processed',n,'candidates',c),result->'warnings',j.created_by) on conflict on constraint source_runs_workspace_id_job_id_key do update set http_status=excluded.http_status,status='succeeded',counts=excluded.counts,warnings=excluded.warnings,error_code=null,revision=source_runs.revision+1;
 update public.sources set health='healthy',last_success_at=now(),etag=coalesce(result->>'etag',etag),last_modified=coalesce(result->>'last_modified',last_modified),next_due=now()+make_interval(hours=>poll_interval_hours),updated_at=now() where id=s.id;
 update public.operations set last_source_success_at=now(),last_error_code=null where workspace_id=w;
 perform public.finish_backend_job(job_id,lease,'succeeded',null);
 return jsonb_build_object('processed',n,'candidates',c);
end $$;
create function public.fail_collection(job_id uuid,lease uuid,error_code text,retry_after timestamptz default null) returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;w uuid;state text;
begin
 select workspace_id into w from public.jobs where id=job_id;perform 1 from public.workspaces where id=w for update;select * into j from public.jobs where id=job_id;
 state:=case when error_code='SOURCE_TEMPORARY_FAILURE' then 'retry_wait' when error_code='SOURCE_QUOTA_WAIT' then 'quota_wait' else 'blocked' end;
 perform public.finish_backend_job(job_id,lease,state,error_code);
 if j.cancel_requested then return;end if;
 if state='quota_wait' then update public.jobs set next_attempt_at=case when retry_after is null then 'infinity'::timestamptz else greatest(retry_after,now()+interval '1 minute') end where id=job_id;end if;
 update public.sources set health=case when error_code='MANUAL_SOURCE_REQUIRED' then 'authentication_required' when state in ('quota_wait','retry_wait') then 'unavailable' else 'blocked' end,next_due=case when state='blocked' then null when state='quota_wait' then coalesce(retry_after,'infinity') else now()+interval '6 hours' end,updated_at=now() where workspace_id=w and id=j.entity_id;
 insert into public.source_runs(workspace_id,source_id,job_id,status,error_code,created_by) values(w,j.entity_id,j.id,state,error_code,j.created_by) on conflict on constraint source_runs_workspace_id_job_id_key do update set status=excluded.status,error_code=excluded.error_code,revision=source_runs.revision+1;
 update public.operations set last_error_code=error_code where workspace_id=w;
end $$;
revoke all on function public.collection_context(uuid,uuid),public.complete_collection(uuid,uuid,jsonb),public.fail_collection(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.collection_context(uuid,uuid),public.complete_collection(uuid,uuid,jsonb),public.fail_collection(uuid,uuid,text,timestamptz) to service_role;
create trigger review_evidence_changed after insert or update on public.review_inputs for each row execute function app_private.invalidate_evidence();

create table app_private.dispatcher_settings(singleton boolean primary key default true check(singleton),project_url text not null,secret_hash text not null,collection_hosts text[] not null default '{}',enabled boolean not null default false,last_dispatch_at timestamptz,last_worker_at timestamptz);
alter table app_private.dispatcher_settings enable row level security;
revoke all on app_private.dispatcher_settings from public,anon,authenticated,service_role;
create function public.verify_dispatcher_secret(supplied text) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if length(supplied)<>64 then return false;end if;
 update app_private.dispatcher_settings set last_worker_at=now() where singleton and enabled and secret_hash=encode(sha256(convert_to(supplied,'UTF8')),'hex');return found;
end $$;
create function public.worker_collection_hosts() returns text[] language sql security definer set search_path='' as $$select coalesce((select collection_hosts from app_private.dispatcher_settings where singleton and enabled),'{}')$$;
create function app_private.dispatch_backend() returns void language plpgsql security definer set search_path='' as $$
declare config app_private.dispatcher_settings;secret text;
begin
 select * into config from app_private.dispatcher_settings where singleton and enabled;if not found then return;end if;
 select decrypted_secret into secret from vault.decrypted_secrets where name='tenderdesk_worker';if secret is null then raise exception 'DISPATCH_SECRET_MISSING';end if;
 perform net.http_post(url:=config.project_url||'/functions/v1/worker',headers:=jsonb_build_object('Content-Type','application/json','x-worker-secret',secret),body:='{}'::jsonb,timeout_milliseconds:=120000);
 update app_private.dispatcher_settings set last_dispatch_at=now() where singleton;
end $$;
create function public.configure_dispatcher(project_url text,collection_hosts text[] default '{}') returns void language plpgsql security definer set search_path='' as $$
declare secret text:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');secret_id uuid;
begin
 if project_url!~'^https://[a-z0-9]+\.supabase\.co$' or exists(select 1 from unnest(collection_hosts) h where h!~'^[a-z0-9.-]+\.[a-z]{2,}$') then raise exception 'INVALID_DISPATCH_CONFIGURATION';end if;
 execute 'create extension if not exists pg_cron';execute 'create extension if not exists pg_net';execute 'create extension if not exists supabase_vault';
 select id into secret_id from vault.decrypted_secrets where name='tenderdesk_worker';
 if secret_id is null then perform vault.create_secret(secret,'tenderdesk_worker');else perform vault.update_secret(secret_id,secret);end if;
 insert into app_private.dispatcher_settings(singleton,project_url,secret_hash,collection_hosts,enabled) values(true,project_url,encode(sha256(convert_to(secret,'UTF8')),'hex'),collection_hosts,true)
 on conflict(singleton) do update set project_url=excluded.project_url,secret_hash=excluded.secret_hash,collection_hosts=excluded.collection_hosts,enabled=true;
 perform cron.schedule('tenderdesk-dispatch','* * * * *','select app_private.dispatch_backend()');
 update public.operations set scheduler_enabled=true;
end $$;
revoke all on function public.configure_dispatcher(text,text[]),app_private.dispatch_backend() from public,anon,authenticated,service_role;
revoke all on function public.verify_dispatcher_secret(text),public.worker_collection_hosts() from public,anon,authenticated;
grant execute on function public.verify_dispatcher_secret(text),public.worker_collection_hosts() to service_role;

create function public.workspace_status() returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;result jsonb;
begin
 select m.workspace_id into w from public.memberships m where m.user_id=auth.uid() and app_private.member_role(m.workspace_id) is not null limit 1;
 if w is null then raise exception 'ACCESS_PENDING';end if;
 select jsonb_build_object('server_time',now(),'last_heartbeat_at',o.last_heartbeat_at,'last_source_success_at',o.last_source_success_at,'scheduler_enabled',coalesce(d.enabled,false),'last_error_code',o.last_error_code,
 'original_bytes',(select coalesce(sum(expected_size),0)::text from public.documents where workspace_id=w and status<>'expired'),
 'extracted_bytes',(select coalesce(sum(octet_length(extracted_text)),0)::text from public.documents where workspace_id=w),
 'database_bytes',(select coalesce(sum(pg_total_relation_size(c.oid)),0)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private') and c.relkind='r'),
 'change_token',concat((select revision from public.workspaces where id=w),':',(select max(created_at) from public.audit_events where workspace_id=w),':',(select max(updated_at) from public.jobs where workspace_id=w))) into result
 from public.operations o left join app_private.dispatcher_settings d on d.singleton where o.workspace_id=w;
 return result;
end $$;
revoke all on function public.workspace_status() from public,anon;
grant execute on function public.workspace_status() to authenticated;
