-- Inspect the installed Storage trigger through catalogs without requiring
-- application ownership or USAGE on the independently owned Storage schema.
-- Preserve each function's existing owner, ACL and security-definer contract.
do $catalog_lookup$
declare signature text;definition text;marker text;replacement text;begin
 replacement:='(select c.oid from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname=''storage'' and c.relname=''objects'' and c.relkind in (''r'',''p''))';
 foreach signature in array array[
  'app_private.prepare_storage_write_retirement(uuid,uuid,jsonb)',
  'app_private.finish_storage_write_retirement(uuid,uuid,jsonb)'
 ] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  marker:='to_regclass(''storage.objects'')';
  if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 then raise exception 'STORAGE_RETIREMENT_CATALOG_SOURCE_CHANGED';end if;
  definition:=replace(definition,marker,replacement);
  if signature like '%finish_%' then
   marker:='''storage.objects''::regclass';
   if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 then raise exception 'STORAGE_RETIREMENT_CATALOG_SOURCE_CHANGED';end if;
   definition:=replace(definition,marker,replacement);
  end if;
  execute definition;
 end loop;
end $catalog_lookup$;

-- Qualify the command parameter where generation_steps also has an input column.
-- Existing retries retain their original authorization, budget and history rules.
do $retry_scope$
declare definition text;marker text:='step.job_id=(input->>''id'')::uuid';begin
 definition:=pg_get_functiondef('app_private.app_command(text,jsonb,text)'::regprocedure);
 if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 then
  raise exception 'SOURCE_RESOLUTION_RETRY_SOURCE_CHANGED';end if;
 execute replace(definition,marker,'step.job_id=(app_command.input->>''id'')::uuid');
end $retry_scope$;
