-- Private, lease-bound graph persistence. The existing jobs queue remains the
-- only execution authority; these tables never grant another worker a lease.
create table app_private.model_graph_threads (
 id text primary key check(id ~ '^[a-f0-9]{64}$'),
 workspace_id uuid not null references public.workspaces(id),
 job_id uuid not null references public.jobs(id),
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 task text not null, graph_version integer not null default 1,
 status text not null default 'running' check(status in ('running','accepted','needs_review','committed')),
 candidate_count integer not null default 0 check(candidate_count between 0 and 3),
 result_id uuid,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index model_graph_threads_job_idx on app_private.model_graph_threads(job_id);
create index model_graph_threads_workspace_idx on app_private.model_graph_threads(workspace_id);
create table app_private.model_graph_checkpoints (
 thread_id text not null references app_private.model_graph_threads(id) on delete cascade,
 namespace text not null default '', checkpoint_id text not null,
 parent_id text, checkpoint jsonb not null, metadata jsonb not null,
 created_at timestamptz not null default now(),
 primary key(thread_id,namespace,checkpoint_id)
);
create table app_private.model_graph_writes (
 thread_id text not null references app_private.model_graph_threads(id) on delete cascade,
 namespace text not null default '', checkpoint_id text not null,
 task_id text not null, task_path text not null default '', idx integer not null,
 channel text not null, value jsonb not null,
 primary key(thread_id,namespace,checkpoint_id,task_id,idx)
);
create table app_private.model_graph_results (
 id uuid primary key default gen_random_uuid(),
 thread_id text not null references app_private.model_graph_threads(id) on delete cascade,
 result_key text not null, value jsonb not null, content_hash text not null,
 created_at timestamptz not null default now(),unique(thread_id,result_key)
);
create table app_private.model_graph_budgets (
 thread_id text not null references app_private.model_graph_threads(id) on delete cascade,
 unit text not null check(length(unit) between 1 and 200),
 candidates integer not null default 0 check(candidates between 0 and 3),
 primary key(thread_id,unit)
);
alter table app_private.model_graph_threads add foreign key(result_id) references app_private.model_graph_results(id);
create index model_graph_threads_result_idx on app_private.model_graph_threads(result_id);
alter table public.provider_usage add column graph_candidate_recorded boolean not null default false;
do $$ declare name text;begin
 foreach name in array array['model_graph_threads','model_graph_checkpoints','model_graph_writes','model_graph_results','model_graph_budgets'] loop
  execute format('alter table app_private.%I enable row level security',name);
  execute format('revoke all on app_private.%I from public,anon,authenticated,service_role',name);
 end loop;
end $$;

create function public.model_graph_store(job_id uuid,lease uuid,thread_id text,action text,payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;t app_private.model_graph_threads;c app_private.model_graph_checkpoints;
 r app_private.model_graph_results;result jsonb;entry jsonb;ns text;cid text;hash text;budget_unit text;candidate_total integer;
begin
 j:=app_private.model_job(job_id,lease);
 if thread_id is null or thread_id !~ '^[a-f0-9]{64}$' or payload is null or jsonb_typeof(payload)<>'object' or pg_column_size(payload)>1500000 then raise exception 'INVALID_INPUT';end if;
 select * into t from app_private.model_graph_threads where id=thread_id for update;
 if action='init' then
  perform app_private.check_keys(payload,array['input_hash','task','graph_version']);
  if payload->>'graph_version'<>'1' then raise exception 'GRAPH_VERSION_UNSUPPORTED';end if;
  if j.checkpoint->>'model_executor' is distinct from '2' then raise exception 'MODEL_ROUTING_NOT_PREPARED';end if;
  if t.id is not null and (t.job_id<>j.id or t.input_hash<>payload->>'input_hash' or t.task<>payload->>'task') then raise exception 'STALE_INPUT';end if;
  insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task)
  values(thread_id,j.workspace_id,j.id,payload->>'input_hash',payload->>'task') on conflict(id) do nothing;
  update public.jobs set checkpoint=jsonb_set(checkpoint,'{graph_thread}',to_jsonb(thread_id)) where id=j.id;
  select * into t from app_private.model_graph_threads where id=thread_id;
  return to_jsonb(t);
 end if;
 if t.id is null or t.job_id<>j.id or t.workspace_id<>j.workspace_id then raise exception 'NOT_FOUND';end if;
 ns:=coalesce(payload->>'namespace','');cid:=payload->>'checkpoint_id';
 if length(ns)>200 or (cid is not null and cid !~ '^[a-zA-Z0-9_-]{1,100}$') then raise exception 'INVALID_INPUT';end if;
 case action
 when 'get' then
  select * into c from app_private.model_graph_checkpoints cp where cp.thread_id=t.id and cp.namespace=ns and (cid is null or cp.checkpoint_id=cid)
  order by cp.checkpoint_id desc limit 1;
  if c.thread_id is null then return null;end if;
  select coalesce(jsonb_agg(to_jsonb(w) order by w.task_path collate "C",w.task_id collate "C",w.idx),'[]') into result
   from app_private.model_graph_writes w where w.thread_id=t.id and w.namespace=ns and w.checkpoint_id=c.checkpoint_id;
  return to_jsonb(c)||jsonb_build_object('writes',result);
 when 'list' then
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
   select cp.checkpoint_id from app_private.model_graph_checkpoints cp
   where cp.thread_id=t.id and cp.namespace=ns and (cid is null or cp.checkpoint_id<cid) order by cp.checkpoint_id desc
   limit least(128,greatest(1,coalesce((payload->>'limit')::int,128)))
  ) x;return result;
 when 'put' then
  if cid is null or pg_column_size(payload)>262144 then raise exception 'INVALID_INPUT';end if;
  select * into c from app_private.model_graph_checkpoints cp where cp.thread_id=t.id and cp.namespace=ns and cp.checkpoint_id=cid;
  if c.thread_id is not null and (c.checkpoint<>payload->'checkpoint' or c.metadata<>payload->'metadata') then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  if c.thread_id is null and (select count(*) from app_private.model_graph_checkpoints cp where cp.thread_id=t.id)>=128 then raise exception 'GRAPH_CHECKPOINT_LIMIT';end if;
  insert into app_private.model_graph_checkpoints(thread_id,namespace,checkpoint_id,parent_id,checkpoint,metadata)
   values(t.id,ns,cid,payload->>'parent_id',payload->'checkpoint',payload->'metadata') on conflict do nothing;
 when 'writes' then
  if cid is null or jsonb_typeof(payload->'writes') is distinct from 'array' or jsonb_array_length(payload->'writes')>128 or length(payload->>'task_id') not between 1 and 200 then raise exception 'INVALID_INPUT';end if;
  for entry in select value from jsonb_array_elements(payload->'writes') loop
   insert into app_private.model_graph_writes(thread_id,namespace,checkpoint_id,task_id,task_path,idx,channel,value)
   values(t.id,ns,cid,payload->>'task_id',coalesce(payload->>'task_path',''),(entry->>'idx')::int,entry->>'channel',entry->'value')
   on conflict on constraint model_graph_writes_pkey do update set value=excluded.value,channel=excluded.channel,task_path=excluded.task_path
    where model_graph_writes.idx<0;
  end loop;
 when 'result_put' then
  if length(payload->>'key') not between 1 and 200 or pg_column_size(payload->'value')>1048576 then raise exception 'INVALID_INPUT';end if;
  hash:=encode(sha256(convert_to((payload->'value')::text,'UTF8')),'hex');
  select * into r from app_private.model_graph_results gr where gr.thread_id=t.id and gr.result_key=payload->>'key';
  if r.id is not null then
   if r.content_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return to_jsonb(r);
  end if;
  insert into app_private.model_graph_results(thread_id,result_key,value,content_hash) values(t.id,payload->>'key',payload->'value',hash) returning * into r;
  return to_jsonb(r);
 when 'result_get' then
  select to_jsonb(gr) into result from app_private.model_graph_results gr where gr.thread_id=t.id and
   ((payload->>'id' is not null and gr.id=(payload->>'id')::uuid) or (payload->>'key' is not null and gr.result_key=payload->>'key'));
  return result;
 when 'candidate_budget' then
  budget_unit:=coalesce(payload->>'unit','writer');
  select candidates into candidate_total from app_private.model_graph_budgets b where b.thread_id=t.id and b.unit=budget_unit;
  if coalesce(candidate_total,0)>=3 then raise exception 'MODEL_CORRECTION_EXHAUSTED';end if;
  return jsonb_build_object('count',coalesce(candidate_total,0));
 when 'candidate_received' then
  budget_unit:=coalesce(payload->>'unit','writer');
  select candidates into candidate_total from app_private.model_graph_budgets b where b.thread_id=t.id and b.unit=budget_unit;
  if not exists(select 1 from public.provider_usage u where u.id=(payload->>'usage_id')::uuid and u.job_id=j.id and u.lease_token=lease) then raise exception 'MODEL_IDENTITY_CHANGED';end if;
  if exists(select 1 from public.provider_usage u where u.id=(payload->>'usage_id')::uuid and u.graph_candidate_recorded) then return jsonb_build_object('count',coalesce(candidate_total,0));end if;
  if coalesce(candidate_total,0)>=3 then raise exception 'MODEL_CORRECTION_EXHAUSTED';end if;
  update public.provider_usage set graph_candidate_recorded=true where id=(payload->>'usage_id')::uuid;
  insert into app_private.model_graph_budgets(thread_id,unit,candidates) values(t.id,budget_unit,1)
   on conflict on constraint model_graph_budgets_pkey do update set candidates=model_graph_budgets.candidates+1 returning candidates into candidate_total;
  if budget_unit='writer' then update app_private.model_graph_threads gt set candidate_count=candidate_total,updated_at=now() where gt.id=t.id;end if;
  return jsonb_build_object('count',candidate_total);
 when 'accept' then
  if not exists(select 1 from app_private.model_graph_results gr where gr.id=(payload->>'result_id')::uuid and gr.thread_id=t.id) then raise exception 'NOT_FOUND';end if;
  update app_private.model_graph_threads set status='accepted',result_id=(payload->>'result_id')::uuid,updated_at=now() where id=t.id;
 when 'needs_review' then
  update app_private.model_graph_threads set status='needs_review',updated_at=now() where id=t.id;
 when 'yield' then
  if exists(select 1 from public.provider_usage u where u.job_id=j.id and u.state='reserved') then raise exception 'MODEL_CALL_ALREADY_RESERVED';end if;
  update public.jobs set status='retry_wait',error_code='MODEL_IN_PROGRESS',next_attempt_at=now(),lease_token=null,lease_until=null,
   revision=revision+1,updated_at=now() where id=j.id;
 when 'delete' then
  if t.status='committed' then raise exception 'GRAPH_ALREADY_COMMITTED';end if;
  update app_private.model_graph_threads set result_id=null where id=t.id;
  delete from app_private.model_graph_threads where id=t.id;
 else raise exception 'INVALID_INPUT';
 end case;
 return '{}'::jsonb;
end $$;
revoke all on function public.model_graph_store(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.model_graph_store(uuid,uuid,text,text,jsonb) to service_role;

create function public.complete_generation_graph(job_id uuid,lease uuid,result jsonb,thread_id text)
returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;t app_private.model_graph_threads;r app_private.model_graph_results;
begin
 j:=app_private.model_job(job_id,lease);
 select * into t from app_private.model_graph_threads where id=thread_id and model_graph_threads.job_id=j.id for update;
 select * into r from app_private.model_graph_results where id=t.result_id;
 if t.status is distinct from 'accepted' or r.value is distinct from result then raise exception 'GRAPH_RESULT_NOT_ACCEPTED';end if;
 perform public.complete_generation_step(job_id,lease,result);
 update app_private.model_graph_threads set status='committed',updated_at=now() where id=t.id;
end $$;
revoke all on function public.complete_generation_graph(uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.complete_generation_graph(uuid,uuid,jsonb,text) to service_role;

-- Domain commits and graph completion share a transaction. No late graph result
-- can bypass cancellation, input revisions, or the existing source validation.
create function public.complete_model_probe_graph(job_id uuid,lease uuid,result jsonb,thread_id text)
returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;t app_private.model_graph_threads;
begin
 j:=app_private.model_job(job_id,lease);
 select * into t from app_private.model_graph_threads where id=thread_id and model_graph_threads.job_id=j.id for update;
 if j.type<>'model_probe' or t.status is distinct from 'accepted' or result is distinct from '{"status":"ready"}'::jsonb
  or not exists(select 1 from app_private.model_graph_results r where r.id=t.result_id and r.value=result)
  then raise exception 'GRAPH_RESULT_NOT_ACCEPTED';end if;
 update public.jobs set status='succeeded',lease_token=null,lease_until=null,error_code=null,
  checkpoint=checkpoint||jsonb_build_object('result','ready','checked_at',now()),revision=revision+1,updated_at=now() where id=j.id;
 update app_private.model_graph_threads set status='committed',updated_at=now() where id=t.id;
end $$;
create function public.advance_source_reading_graph(job_id uuid,lease uuid,result jsonb,thread_id text,items jsonb,candidates jsonb,next_url text,warnings jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;t app_private.model_graph_threads;saved jsonb;
begin
 j:=app_private.model_job(job_id,lease);
 select * into t from app_private.model_graph_threads where id=thread_id and model_graph_threads.job_id=j.id for update;
 if t.status is distinct from 'accepted' or not exists(select 1 from app_private.model_graph_results r where r.id=t.result_id and r.value=result)
  then raise exception 'GRAPH_RESULT_NOT_ACCEPTED';end if;
 saved:=public.advance_source_reading(job_id,lease,items,candidates,next_url,warnings);
 update app_private.model_graph_threads set status='committed',updated_at=now() where id=t.id;
 return saved;
end $$;
revoke all on function public.complete_model_probe_graph(uuid,uuid,jsonb,text),public.advance_source_reading_graph(uuid,uuid,jsonb,text,jsonb,jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.complete_model_probe_graph(uuid,uuid,jsonb,text),public.advance_source_reading_graph(uuid,uuid,jsonb,text,jsonb,jsonb,text,jsonb) to service_role;

do $$ declare definition text;begin
 select pg_get_functiondef('public.advance_source_reading(uuid,uuid,jsonb,jsonb,text,jsonb)'::regprocedure) into definition;
 definition:=replace(definition,
  'if not exists(select 1 from public.model_attempts a where a.job_id=j.id and a.lease_token=lease and a.operation=''inspect_source_page'' and a.status=''succeeded'') then',
  'if not exists(select 1 from public.model_attempts a where a.job_id=j.id and a.lease_token=lease and a.operation=''inspect_source_page'' and a.status=''succeeded'') and not exists(select 1 from app_private.model_graph_threads g where g.job_id=j.id and g.id=j.checkpoint->>''graph_thread'' and g.status=''accepted'' and g.task=''inspect_source_page'') then');
 execute definition;
end $$;
