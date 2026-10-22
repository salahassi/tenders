-- One audit-boundary verification phase for an unchanged paid review result.
-- Its own received-result budget is bounded by the existing verifier policy;
-- writer budgets and the original verification history remain immutable.
create function app_private.review_boundary_resume(job_id uuid,lease uuid,thread_id text,payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;t app_private.model_graph_threads;c app_private.model_graph_results;m app_private.model_graph_results;r app_private.model_graph_results;pool jsonb;
begin
 j:=app_private.model_job(job_id,lease);
 perform app_private.check_keys(payload,array['candidate_id','candidate_key','marker_id','report_id','manifest']);
 select * into t from app_private.model_graph_threads where id=thread_id and model_graph_threads.job_id=j.id and workspace_id=j.workspace_id for update;
 if t.id is null or t.task<>'review_proposal' or public.model_graph_store(job_id,lease,thread_id,'recovery_ready','{}')<>'true'::jsonb then return 'false'::jsonb;end if;
 select * into c from app_private.model_graph_results where id=(payload->>'candidate_id')::uuid and model_graph_results.thread_id=t.id and result_key=payload->>'candidate_key';
 select * into m from app_private.model_graph_results where id=(payload->>'marker_id')::uuid and model_graph_results.thread_id=t.id and result_key='review-boundary-recheck-'||c.id::text;
 select * into r from app_private.model_graph_results where id=(payload->>'report_id')::uuid and model_graph_results.thread_id=t.id;
 if c.id is null or m.id is null or r.id is null or c.result_key !~ '^candidate-[012]$'
  or m.value->>'version' is distinct from '3' or m.value->>'candidate_id' is distinct from c.id::text
  or m.value->>'candidate_key' is distinct from c.result_key or m.value->>'report_id' is distinct from r.id::text
  or r.value->>'coverage'='repair_only' or r.value->'result'->>'checked_candidate_hash' is distinct from m.value->>'candidate_hash'
  or exists(select 1 from app_private.model_graph_results newer where newer.thread_id=t.id and newer.result_key ~ '^candidate-[012]$' and newer.result_key>c.result_key)
  or exists(select 1 from app_private.model_graph_results done where done.thread_id=t.id and done.result_key='review-boundary-v3-'||(m.value->>'candidate_hash')) then return 'false'::jsonb;end if;
 pool:=public.task_model_preflight(job_id,lease,payload->'manifest');
 if pool->>'pending_model_config_id' is not null then return 'false'::jsonb;end if;
 update app_private.model_graph_threads set status='running',updated_at=now() where id=t.id;
 return 'true'::jsonb;
end $$;
revoke all on function app_private.review_boundary_resume(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
do $patch$ declare definition text;marker text;begin
 select pg_get_functiondef('public.model_graph_store(uuid,uuid,text,text,jsonb)'::regprocedure) into definition;
 marker := ' when ''candidate_budget'' then';
 if position(marker in definition)=0 then raise exception 'Model graph store changed';end if;
 execute replace(definition,marker,' when ''review_boundary_resume'' then return app_private.review_boundary_resume(job_id,lease,thread_id,payload);'||marker);
end $patch$;
