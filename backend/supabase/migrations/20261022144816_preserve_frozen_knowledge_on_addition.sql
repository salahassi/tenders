-- New library additions are inputs for future plans. Existing proposal snapshots
-- remain immutable. Removing/changing an already used source still fails closed.
do $patch$ declare definition text;marker text;replacement text;begin
 select pg_get_functiondef('app_private.refresh_proposal_evidence(uuid)'::regprocedure) into definition;
 marker:=' -- These three fields are consumed only by classify_opportunity, never by a';
 replacement:=$sql$
 current_context:=jsonb_set(current_context,'{knowledge}',coalesce((
  select jsonb_agg(current_item.value order by current_item.ordinality)
  from jsonb_array_elements(current_context->'knowledge') with ordinality current_item(value,ordinality)
  where exists(select 1 from jsonb_array_elements(p.frozen_context->'knowledge') frozen_item where frozen_item->>'id'=current_item.value->>'id')
 ),'[]'::jsonb));
 -- These three fields are consumed only by classify_opportunity, never by a$sql$;
 if position(marker in definition)=0 then raise exception 'Frozen evidence guard changed';end if;
 execute replace(definition,marker,replacement);
end $patch$;
