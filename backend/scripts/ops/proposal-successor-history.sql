   history_now:='{}'::jsonb;
   FOREACH relation_name IN ARRAY ARRAY[
     'public.provider_usage','public.model_attempts','public.content_authorizations',
     'public.documents','public.document_blocks','public.knowledge_items','public.templates','public.rate_catalog',
     'public.generation_steps','public.requirements','public.document_packages',
     'app_private.generation_processing_requests','app_private.proposal_workflow_admission',
     'app_private.model_graph_threads','app_private.model_graph_results','app_private.model_graph_budgets',
     'app_private.model_graph_checkpoints','app_private.model_graph_writes'] LOOP
    predicate:=CASE
     WHEN relation_name='app_private.proposal_workflow_admission' THEN 'true'
     WHEN relation_name IN ('public.generation_steps','public.requirements','app_private.generation_processing_requests') THEN 'x.workspace_id=$1 AND x.plan_id=$2'
     WHEN relation_name='public.document_packages' THEN 'x.workspace_id=$1 AND x.id=$3'
     WHEN relation_name='app_private.model_graph_threads' THEN 'x.workspace_id=$1 AND x.job_id IN (SELECT id FROM public.jobs WHERE workspace_id=$1 AND entity_id=$2)'
     WHEN relation_name LIKE 'app_private.model_graph_%' THEN 'x.workspace_id=$1 AND x.thread_id IN (SELECT id FROM app_private.model_graph_threads WHERE workspace_id=$1 AND job_id IN (SELECT id FROM public.jobs WHERE workspace_id=$1 AND entity_id=$2))'
     ELSE 'x.workspace_id=$1' END;
    EXECUTE 'SELECT jsonb_build_object(''count'',count(*),''sha256'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,E''\n'' ORDER BY to_jsonb(x)::text),''''),''UTF8'')),''hex'')) FROM '||relation_name||' x WHERE '||predicate
     INTO relation_state USING p.workspace_id,p.id,p.package_id;
    history_now:=history_now||jsonb_build_object(relation_name,relation_state);
   END LOOP;
