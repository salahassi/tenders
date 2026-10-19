-- Independent directory jobs belong to the workspace, not an existing source row.
-- Retrying preserves their directory hash instead of looking for a source revision.
do $$ declare definition text;old text;begin
 select pg_get_functiondef('app_private.collection_command(text,jsonb,text)'::regprocedure) into definition;
 old:='case when type like ''source_%'' then (select revision::text from public.sources where id=entity_id) else input_hash end';
 if position(old in definition)=0 then raise exception 'Source retry expression changed';end if;
 execute replace(definition,old,'case when type like ''source_%'' and not (checkpoint ? ''discovery_url'') then (select revision::text from public.sources where id=entity_id) else input_hash end');
end $$;
