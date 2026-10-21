-- The display outline is application-derived from the saved planning/chunk
-- lineage. Content rows and their requirement/evidence references remain intact.
alter table public.proposal_versions add column section_outline jsonb
 check(section_outline is null or (
  jsonb_typeof(section_outline)='object' and section_outline->>'version'='1'
  and jsonb_typeof(section_outline->'groups')='array' and pg_column_size(section_outline)<=131072
 ));

-- Existing authenticated/service table grants cover the new readable column;
-- no new client mutation permission or RPC is introduced.
do $$ declare definition text;old text;replacement text;begin
 select pg_get_functiondef('public.advance_generation(uuid,uuid,text,jsonb,jsonb,jsonb)'::regprocedure) into definition;
 old:='review_result,commercial_draft,separate_volumes,created_by)';
 replacement:='review_result,commercial_draft,separate_volumes,section_outline,created_by)';
 if position(old in definition)=0 then raise exception 'Proposal version insert changed';end if;
 definition:=replace(definition,old,replacement);
 old:='(final_result->>''separate_volumes'')::boolean,p.created_by from public.document_packages';
 replacement:='(final_result->>''separate_volumes'')::boolean,nullif(final_result->''section_outline'',''null''::jsonb),p.created_by from public.document_packages';
 if position(old in definition)=0 then raise exception 'Proposal version values changed';end if;
 execute replace(definition,old,replacement);

 select pg_get_functiondef('app_private.export_command(text,jsonb,text)'::regprocedure) into definition;
 old:='if context is null then raise exception ''GENERATION_CONTEXT_REQUIRED'';end if;';
 if position(old in definition)=0 then raise exception 'Export snapshot boundary changed';end if;
 execute replace(definition,old,old||' context:=context||jsonb_build_object(''section_outline'',v.section_outline);');
end $$;
