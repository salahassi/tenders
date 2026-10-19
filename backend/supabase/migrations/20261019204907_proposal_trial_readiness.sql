-- Apply the same content check at storage and explicit model authorization.
-- A requirement to maintain confidentiality is not a Confidential marking.
do $migration$ declare definition text; old text; begin
 select pg_get_functiondef('app_private.model_policy_command(text,jsonb,text)'::regprocedure) into definition;
 old:=$old$if content->>'content' ~* '(confidential|strictly private|سري للغاية|سرية|password[[:space:]]*[:=]|api[_ -]?key[[:space:]]*[:=]|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|-----BEGIN .*PRIVATE KEY)' then raise exception 'DATA_POLICY_BLOCKED';end if;$old$;
 if position(old in definition)=0 then raise exception 'Model authorization check changed';end if;
 execute replace(definition,old,'perform app_private.assert_business_content(content->>''content'');');
end $migration$;

-- Alternate proposal work with waiting assessment work. Accepted remote requests
-- and sources waiting two minutes retain their existing priority. Neither class
-- bypasses next_attempt_at, cancellation, workspace locking or the one-live-lease rule.
do $migration$ declare definition text; marker text; begin
 select pg_get_functiondef('public.claim_backend_job()'::regprocedure) into definition;
 marker:='case when type in (''source_collect'',''source_candidates'') and updated_at<now()-interval ''2 minutes'' then 0 else 1 end,';
 if position(marker in definition)=0 or position('operator_id uuid;' in definition)=0 then raise exception 'Claim ordering changed';end if;
 definition:=replace(definition,'operator_id uuid;','operator_id uuid;previous_interactive boolean;');
 definition:=replace(definition,'select * into j from public.jobs where workspace_id=w and status in',
 $insert$select coalesce((select recent.type in ('plan_proposal','analyze_chunk','consolidate_requirements','draft_section','plan_commercial','review_proposal','advance_plan') from public.jobs recent where recent.workspace_id=w and recent.attempts>0 order by recent.updated_at desc,recent.id limit 1),false) into previous_interactive;
 select * into j from public.jobs where workspace_id=w and status in$insert$);
 definition:=replace(definition,marker,marker||$order$
 case when (type in ('plan_proposal','analyze_chunk','consolidate_requirements','draft_section','plan_commercial','review_proposal','advance_plan') and not previous_interactive) or (previous_interactive and type='classify_opportunity' and updated_at<now()-interval '2 minutes') then 0 else 1 end,$order$);
 execute definition;
end $migration$;
