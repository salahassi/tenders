-- A parent can resume its pending read while the independent browser lease is
-- still valid. Publish the exact current receipt without touching that active
-- parent lease; canceled jobs and changed inputs remain rejected by currentness.
do $patch$ declare definition text;marker text;begin
 definition:=pg_get_functiondef('public.complete_source_browser_page(uuid,uuid,jsonb,text)'::regprocedure);
 marker:=$old$if j.status not in ('queued','retry_wait','quota_wait') or not app_private.source_browser_request_current(r) then$old$;
 if position(marker in definition)=0 then raise exception 'Browser completion currentness guard changed';end if;
 definition:=replace(definition,marker,$new$if not app_private.source_browser_request_current(r) then$new$);
 marker:=$old$update public.jobs set next_attempt_at=now(),updated_at=now() where id=j.id;$old$;
 if position(marker in definition)=0 then raise exception 'Browser completion wake changed';end if;
 execute replace(definition,marker,$new$update public.jobs set next_attempt_at=now(),updated_at=now() where id=j.id and status<>'running';$new$);
end $patch$;
