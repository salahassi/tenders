-- Reopen verification only for an unchanged, paid writer whose local guard
-- now passes. No candidate/verification budget or receipt is rewritten.
create function app_private.revalidated_writer_resume(job_id uuid,lease uuid,thread_id text,payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;t app_private.model_graph_threads;r app_private.model_graph_results;m app_private.model_graph_results;
begin
 j:=app_private.model_job(job_id,lease);
 perform app_private.check_keys(payload,array['candidate_id','candidate_key','marker_id','manifest']);
 select * into t from app_private.model_graph_threads where id=thread_id and model_graph_threads.job_id=j.id and workspace_id=j.workspace_id for update;
 if t.id is null or t.task='connection_probe' or public.model_graph_store(job_id,lease,thread_id,'recovery_ready','{}')<>'true'::jsonb then return 'false'::jsonb;end if;
 select * into r from app_private.model_graph_results where id=(payload->>'candidate_id')::uuid and model_graph_results.thread_id=t.id and result_key=payload->>'candidate_key';
 select * into m from app_private.model_graph_results where id=(payload->>'marker_id')::uuid and model_graph_results.thread_id=t.id and result_key='writer-local-revalidated-'||r.id::text;
 if r.id is null or m.id is null or r.value->'local_validation'->>'version' is distinct from '1'
  or m.value->>'candidate_id' is distinct from r.id::text or m.value->>'candidate_key' is distinct from r.result_key
  or m.value->>'new_provider_requests' is distinct from '0' or m.value->>'received_candidate_budgets_unchanged' is distinct from 'true'
  or exists(select 1 from app_private.model_graph_results newer where newer.thread_id=t.id and newer.result_key ~ '^candidate-[012]$' and newer.result_key>r.result_key)
  then return 'false'::jsonb;end if;
 if app_private.writer_validation_handoff(job_id,lease,thread_id,payload-'marker_id')<>'true'::jsonb then return 'false'::jsonb;end if;
 update app_private.model_graph_threads set status='running',updated_at=now() where id=t.id;
 return 'true'::jsonb;
end $$;
revoke all on function app_private.revalidated_writer_resume(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
do $patch$ declare definition text;marker text;begin
 select pg_get_functiondef('public.model_graph_store(uuid,uuid,text,text,jsonb)'::regprocedure) into definition;
 marker := ' when ''candidate_budget'' then';
 if position(marker in definition)=0 then raise exception 'Model graph store changed';end if;
 execute replace(definition,marker,' when ''revalidated_writer_resume'' then return app_private.revalidated_writer_resume(job_id,lease,thread_id,payload);'||marker);
end $patch$;
