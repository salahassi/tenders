-- A terminal failure releases the only worker slot just as a successful job
-- does. Wake other already-due work through the normal dispatcher; never retry
-- this failed job or shorten any retry/Retry-After deadline. Keep the existing
-- revision receipt, ten-second workspace throttle and all global guards.
do $patch$ declare definition text;admission text;eligible text;begin
 select pg_get_functiondef('public.wake_backend_queue(uuid,uuid)'::regprocedure) into definition;
 admission:='if j.status<>''succeeded'' and not coalesce((';
 eligible:='where q.workspace_id=w and not q.cancel_requested';
 if position(admission in definition)=0 or position(eligible in definition)=0 then
  raise exception 'Queue wake guards changed';
 end if;
 definition:=replace(definition,admission,'if j.status not in (''succeeded'',''blocked'',''failed'') and not coalesce((');
 definition:=replace(definition,eligible,eligible||' and (j.status not in (''blocked'',''failed'') or q.id<>j.id)');
 execute definition;
end $patch$;
