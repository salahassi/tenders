   history_now:='{}'::jsonb;
   FOREACH table_name IN ARRAY ARRAY[
    'public.jobs','public.generation_steps','public.provider_usage','public.model_attempts','public.audit_events',
    'public.proposals','public.proposal_versions','public.requirements','public.documents','public.document_blocks',
    'public.content_authorizations','public.document_packages','public.knowledge_items','public.templates','public.rate_catalog','public.review_inputs',
    'app_private.generation_processing_requests','app_private.analysis_verifier_rechecks',
    'app_private.model_graph_threads','app_private.model_graph_results','app_private.model_graph_budgets',
    'app_private.model_graph_checkpoints','app_private.model_graph_writes'] LOOP
    predicate:=CASE
     WHEN table_name='public.jobs' THEN 'x.workspace_id=$1 AND x.id=ANY($2)'
     WHEN table_name IN ('public.generation_steps','public.provider_usage','public.model_attempts','app_private.model_graph_threads') THEN 'x.workspace_id=$1 AND x.job_id=ANY($2)'
     WHEN table_name='public.audit_events' THEN 'x.workspace_id=$1 AND x.id=ANY($4)'
     WHEN table_name='app_private.analysis_verifier_rechecks' THEN 'x.workspace_id=$1 AND x.child_job_id=ANY($2)'
     WHEN table_name LIKE 'app_private.model_graph_%' THEN 'x.workspace_id=$1 AND x.thread_id IN (SELECT id FROM app_private.model_graph_threads WHERE workspace_id=$1 AND job_id=ANY($2))'
     ELSE 'x.workspace_id=$1' END;
    projection:=CASE
     WHEN table_name='public.jobs' THEN 'CASE WHEN x.id=$3 THEN to_jsonb(x)-ARRAY[''status'',''cancel_requested'',''revision'',''updated_at''] ELSE to_jsonb(x) END'
     WHEN table_name='public.generation_steps' THEN 'CASE WHEN x.job_id=$3 THEN to_jsonb(x)-ARRAY[''status'',''revision'',''updated_at''] ELSE to_jsonb(x) END'
     ELSE 'to_jsonb(x)' END;
    EXECUTE 'SELECT jsonb_build_object(''count'',count(*),''sha256'',encode(sha256(convert_to(coalesce(string_agg(y.value::text,E''\n'' ORDER BY y.value::text),''''),''UTF8'')),''hex'')) FROM (SELECT '||projection||' AS value FROM '||table_name||' x WHERE '||predicate||') y'
     INTO part USING p.workspace_id,original_jobs,parent.id,original_audit;
    history_now:=history_now||jsonb_build_object(table_name,part);
   END LOOP;
