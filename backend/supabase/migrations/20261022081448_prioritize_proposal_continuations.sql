-- Finish the saved proposal unit's validation before buying a fresh sibling
-- writer result. Class and owner fairness, deadlines, capacity, due times and
-- exclusive job leases remain earlier selection constraints.
do $patch$ declare definition text;marker text;begin
 select pg_get_functiondef('app_private.next_fair_job(uuid,boolean)'::regprocedure) into definition;
 marker:='  q.next_attempt_at,q.created_at,q.id';
 if position(marker in definition)=0 then raise exception 'Queue tie-break ordering changed';end if;
 execute replace(definition,marker,$order$  case when c.work_class='proposal' and q.checkpoint ? 'graph_thread'
   and (q.error_code is null or q.error_code='MODEL_IN_PROGRESS') then 0 else 1 end,
  q.next_attempt_at,q.created_at,q.id$order$);
end $patch$;
