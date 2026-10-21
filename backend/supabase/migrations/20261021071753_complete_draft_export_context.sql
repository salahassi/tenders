-- Preserve generated review inputs in draft downloads without promoting them
-- to approved commercial, delivery or compliance records. Existing membership,
-- revision, idempotency, snapshot-size and final-approval checks stay intact.
do $patch$ declare definition text; marker text; begin
 select pg_get_functiondef('app_private.export_command(text,jsonb,text)'::regprocedure) into definition;
 marker := 'if context is null then raise exception ''GENERATION_CONTEXT_REQUIRED'';end if;';
 if position(marker in definition)=0 then raise exception 'Export context changed';end if;
 execute replace(definition,marker,marker||$draft$
 if payload->>'mode'='draft' then
  context:=context||jsonb_build_object(
   'commercial_draft',v.commercial_draft,
   'review_result',v.review_result,
   'questions',(select coalesce(jsonb_agg(jsonb_build_object(
    'question',q.question,'blocking_level',q.blocking_level,
    'target_section_key',q.target_section_key,'reason',q.reason
   ) order by q.created_at,q.id),'[]') from public.questions q
    where q.workspace_id=w and q.proposal_version_id=v.id
     and q.status not in ('resolved','not_applicable_with_reason'))
  );
 end if;
$draft$);
end $patch$;
