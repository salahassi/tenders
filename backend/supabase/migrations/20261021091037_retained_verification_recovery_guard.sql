-- A deterministic validation fix may recover an unchanged retained report.
-- This check authorizes no new model calls and changes no usage or budgets.
-- Use the existing store's service-only, current lease and exact-thread checks.
do $$ declare definition text; fragment text; replacement text;begin
 select pg_get_functiondef('public.model_graph_store(uuid,uuid,text,text,jsonb)'::regprocedure) into definition;
 fragment := $old$ when 'candidate_budget' then$old$;
 replacement := $new$ when 'recovery_ready' then
  perform app_private.check_keys(payload,array[]::text[]);
  return to_jsonb(t.status='needs_review' and t.result_id is null
   and not (j.checkpoint ? 'model_round')
   and not exists(select 1 from public.provider_usage u where u.job_id=j.id and u.state in ('reserved','unknown')));
 when 'candidate_budget' then$new$;
 if position(fragment in definition)=0 then raise exception 'Unexpected model graph recovery guard';end if;
 execute replace(definition,fragment,replacement);
end $$;
