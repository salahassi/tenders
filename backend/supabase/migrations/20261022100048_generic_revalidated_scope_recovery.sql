-- Reuse an exact revalidated verifier scope for any task. Existing invalid
-- draft reports may still drive bounded repair; other tasks get no new repair
-- path, candidate allowance or model call. All leases/identity/usage guards stay.
do $patch$ declare definition text;marker text;begin
 select pg_get_functiondef('app_private.invalid_verification_repair(uuid,uuid,text,text,jsonb)'::regprocedure) into definition;
 marker:=' or t.task<>''draft_section''';
 if position(marker in definition)=0 then raise exception 'Recovery task guard changed';end if;
 definition:=replace(definition,marker,'');
 marker:=' if a.value->>''coverage''=''repair_only'' then';
 if position(marker in definition)=0 then raise exception 'Recovery coverage guard changed';end if;
 definition:=replace(definition,marker,$gate$ if t.task<>'draft_section' and a.value->>'coverage' is distinct from 'revalidated_scope' then return 'false'::jsonb;end if;
 if a.value->>'coverage'='repair_only' then$gate$);
 execute definition;
end $patch$;
