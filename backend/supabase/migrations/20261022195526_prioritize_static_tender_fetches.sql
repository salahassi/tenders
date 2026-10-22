-- Cheap configured listing fetches otherwise wait behind every unseen notice
-- created by an earlier fetch. Alternate this preference by existing queue cycle;
-- retain class slots, owner fairness on the other cycle, leases and due times.
do $patch$ declare definition text; marker text := E' order by slot.distance,\n  coalesce(served.last_dispatch,-1),'; begin
 select pg_get_functiondef('app_private.next_fair_job(uuid,boolean)'::regprocedure) into definition;
 if position(marker in definition)=0 then raise exception 'Queue ordering changed';end if;
 execute replace(definition,marker,$ordering$ order by slot.distance,
  case when c.work_class='background' and (scheduler.cursor/array_length(slots,1))%2=0
   and q.type='source_collect' and exists(
    select 1 from public.sources s where s.workspace_id=q.workspace_id and s.id=q.entity_id
     and s.approval='approved' and s.kind='link_directory' and s.revision::text=q.input_hash
     and s.adapter_config ? 'official_listing' and s.adapter_config ? 'extraction'
     and coalesce(s.adapter_config->>'automatic','false')<>'true'
   ) then 0 else 1 end,
  coalesce(served.last_dispatch,-1),$ordering$);
end $patch$;
