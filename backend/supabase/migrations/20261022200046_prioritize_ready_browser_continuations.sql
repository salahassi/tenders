-- Consume an already-rendered approved page on the same alternating background
-- preference, only when model admission has capacity. This applies once, before
-- its error state changes from SOURCE_BROWSER_PENDING to model continuation.
do $patch$ declare definition text; marker text := E'and s.adapter_config ? ''official_listing'' and s.adapter_config ? ''extraction''\n     and coalesce(s.adapter_config->>''automatic'',''false'')<>''true'''; begin
 select pg_get_functiondef('app_private.next_fair_job(uuid,boolean)'::regprocedure) into definition;
 if position(marker in definition)=0 then raise exception 'Static queue preference changed';end if;
 execute replace(definition,marker,$ordering$and (
      (s.adapter_config ? 'official_listing' and s.adapter_config ? 'extraction'
       and coalesce(s.adapter_config->>'automatic','false')<>'true')
      or (capacity and q.error_code='SOURCE_BROWSER_PENDING' and s.adapter_config->'automatic'='true'::jsonb
       and exists(select 1 from public.source_browser_requests b
        join public.source_readings r on r.job_id=b.job_id and r.pending_url=b.url
        where b.job_id=q.id and b.input_hash=q.input_hash and b.status='ready'))
     )$ordering$);
end $patch$;
