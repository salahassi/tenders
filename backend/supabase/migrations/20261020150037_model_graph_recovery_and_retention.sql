-- Recovery aliases expose no browser Data API grants. They let the existing
-- Owner-only hashed backup protocol carry private graph state with UUID row keys.
alter table app_private.model_graph_threads add column recovery_id uuid not null default gen_random_uuid() unique;
do $$ declare t text;r record;definition text;begin
 foreach t in array array['model_connections','model_configurations','model_task_routes','model_execution_settings'] loop
  execute format('alter table public.%I add foreign key(workspace_id,created_by) references public.workspace_actors(workspace_id,id) deferrable initially immediate',t);
 end loop;
 foreach t in array array['model_graph_checkpoints','model_graph_writes','model_graph_results','model_graph_budgets'] loop
  execute format('alter table app_private.%I add column workspace_id uuid references public.workspaces(id) deferrable initially immediate',t);
  execute format('update app_private.%I c set workspace_id=t.workspace_id from app_private.model_graph_threads t where t.id=c.thread_id',t);
  execute format('alter table app_private.%I alter column workspace_id set not null',t);
  if t<>'model_graph_results' then execute format('alter table app_private.%I add column recovery_id uuid not null default gen_random_uuid() unique',t);end if;
  execute format('create index %I on app_private.%I(workspace_id)',t||'_workspace_idx',t);
 end loop;
 -- New catalog references must be deferred just like existing backup relations.
 for r in select c.conname,c.conrelid::regclass tab from pg_constraint c join pg_class t on t.oid=c.conrelid
  join pg_namespace n on n.oid=t.relnamespace where c.contype='f' and
  ((n.nspname='app_private' and t.relname like 'model_graph_%') or
   (n.nspname='public' and t.relname in ('model_connections','model_configurations','model_task_routes','model_execution_settings','provider_usage','model_attempts'))) loop
  execute format('alter table %s alter constraint %I deferrable initially immediate',r.tab,r.conname);
 end loop;
end $$;
create function app_private.graph_row_workspace() returns trigger language plpgsql set search_path='' as $$
declare w uuid;begin
 select workspace_id into w from app_private.model_graph_threads where id=new.thread_id;
 if new.workspace_id is null then new.workspace_id:=w;
 elsif w is not null and w<>new.workspace_id then raise exception 'WORKSPACE_MISMATCH';end if;
 return new;
end $$;
revoke all on function app_private.graph_row_workspace() from public,anon,authenticated,service_role;
do $$ declare t text;begin
 foreach t in array array['model_graph_checkpoints','model_graph_writes','model_graph_results','model_graph_budgets'] loop
 execute format('create trigger graph_row_workspace before insert or update on app_private.%I for each row execute function app_private.graph_row_workspace()',t);
 end loop;
end $$;
create view public.recovery_model_graph_threads with(security_invoker=true) as
 select recovery_id id,workspace_id,id graph_id,job_id,input_hash,task,graph_version,status,candidate_count,result_id,created_at,updated_at from app_private.model_graph_threads;
create view public.recovery_model_graph_checkpoints with(security_invoker=true) as
 select recovery_id id,workspace_id,thread_id,namespace,checkpoint_id,parent_id,checkpoint,metadata,created_at from app_private.model_graph_checkpoints;
create view public.recovery_model_graph_writes with(security_invoker=true) as
 select recovery_id id,workspace_id,thread_id,namespace,checkpoint_id,task_id,task_path,idx,channel,value from app_private.model_graph_writes;
create view public.recovery_model_graph_results with(security_invoker=true) as
 select id,workspace_id,thread_id,result_key,value,content_hash,created_at from app_private.model_graph_results;
create view public.recovery_model_graph_budgets with(security_invoker=true) as
 select recovery_id id,workspace_id,thread_id,unit,candidates from app_private.model_graph_budgets;
revoke all on public.recovery_model_graph_threads,public.recovery_model_graph_checkpoints,public.recovery_model_graph_writes,public.recovery_model_graph_results,public.recovery_model_graph_budgets from public,anon,authenticated,service_role;

do $$ declare definition text;begin
 select pg_get_functiondef('app_private.backup_tables()'::regprocedure) into definition;
 definition:=replace(definition,'select array[','select array[''model_connections'',''model_configurations'',''model_task_routes'',''model_execution_settings'',''recovery_model_graph_threads'',''recovery_model_graph_checkpoints'',''recovery_model_graph_writes'',''recovery_model_graph_results'',''recovery_model_graph_budgets'',');
 execute definition;
 select pg_get_functiondef('public.commit_workspace_restore(uuid)'::regprocedure) into definition;
 definition:=replace(definition,'if t=''sources'' then',
  'if t in (''model_connections'',''model_configurations'',''model_execution_settings'') then data:=data||''{"enabled":false}''; elsif t=''sources'' then');
 execute definition;
 -- Retain evidence and uncertain/running graphs. Prune only old committed graph
 -- checkpoints whose job has no retained generation or regeneration reference.
 select pg_get_functiondef('public.maintenance_tick()'::regprocedure) into definition;
 definition:=replace(definition,'delete from public.jobs where id in(',
  'delete from app_private.model_graph_threads where id in(select g.id from app_private.model_graph_threads g join public.jobs j on j.id=g.job_id where g.workspace_id=w and g.status=''committed'' and j.status in (''succeeded'',''failed'',''canceled'') and j.updated_at<now()-make_interval(days=>retention) and not exists(select 1 from public.generation_steps gs where gs.job_id=j.id) and not exists(select 1 from public.regeneration_requests rr where rr.job_id=j.id) limit 200); delete from public.jobs where id in(');
 definition:=replace(definition,'and not exists(select 1 from public.provider_usage u where u.job_id=j.id) limit 200);',
  'and not exists(select 1 from public.provider_usage u where u.job_id=j.id) and not exists(select 1 from app_private.model_graph_threads g where g.job_id=j.id) limit 200);');
 execute definition;
end $$;
-- Break the thread/result cycle during a controlled cascade while preserving the
-- immutable accepted value throughout normal execution.
alter table app_private.model_graph_threads drop constraint model_graph_threads_result_id_fkey;
alter table app_private.model_graph_threads add foreign key(result_id) references app_private.model_graph_results(id) on delete set null deferrable initially immediate;

-- Old workers can continue legacy jobs during deployment/rollback. A graph job
-- is claimed only by a worker that explicitly declares executor 2 support.
do $$ declare definition text;begin
 select pg_get_functiondef('public.claim_backend_job()'::regprocedure) into definition;
 definition:=replace(definition,'select * into j from public.jobs where workspace_id=w and status in',
  'select * into j from public.jobs where workspace_id=w and (coalesce((checkpoint->>''model_executor'')::int,1)<=coalesce(nullif(current_setting(''app.worker_executor'',true),'''')::int,1)) and status in');
 definition:=replace(definition,'update public.jobs set status=case when cancel_requested',
  'update public.jobs set status=''retry_wait'',error_code=''MODEL_IN_PROGRESS'',lease_token=null,lease_until=null,next_attempt_at=now(),revision=revision+1,updated_at=now() where workspace_id=w and status=''running'' and lease_until<now() and not cancel_requested and checkpoint->>''model_executor''=''2'' and checkpoint ? ''graph_thread''; update public.jobs set status=case when cancel_requested');
 execute definition;
end $$;
create function public.claim_backend_job_v2() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;previous text:=current_setting('app.worker_executor',true);begin
 perform set_config('app.worker_executor','2',true);
 result:=public.claim_backend_job();
 perform set_config('app.worker_executor',coalesce(previous,''),true);
 return result;
end $$;
revoke all on function public.claim_backend_job_v2() from public,anon,authenticated;
grant execute on function public.claim_backend_job_v2() to service_role;

-- The browser posts transactional command batches. Route every entry through
-- the current public dispatcher so catalog and notification commands have the
-- same membership, revision, audit and idempotency behavior as single commands.
do $$ declare definition text;begin
 select pg_get_functiondef('app_private.apply_batch(jsonb,text)'::regprocedure) into definition;
 definition:=replace(definition,'app_private.app_command(item->>','public.app_command(item->>');
 execute definition;
end $$;
