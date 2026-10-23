-- Retry a transient native read on the same bounded receipt, rather than
-- returning its first failure forever. Preserve source/hash bindings and usage.
do $patch$ declare definition text;marker text;begin
 definition:=pg_get_functiondef('public.complete_source_browser_page(uuid,uuid,jsonb,text)'::regprocedure);
 marker:=$old$status=case when complete_source_browser_page.error_code is null then 'ready' else 'blocked' end$old$;
 if position(marker in definition)=0 then raise exception 'Browser completion state changed';end if;
 execute replace(definition,marker,$new$status=case when complete_source_browser_page.error_code is null then 'ready'
  when complete_source_browser_page.error_code in ('SOURCE_TIMEOUT','SOURCE_BROWSER_FAILED') and r.attempts<2 then 'queued'
  else 'blocked' end$new$);

 definition:=pg_get_functiondef('public.request_notice_browser(uuid,uuid,text)'::regprocedure);
 marker:=$old$if not app_private.source_browser_request_current(r) then raise exception 'STALE_INPUT';end if;$old$;
 if position(marker in definition)=0 then raise exception 'Notice browser currentness guard changed';end if;
 definition:=replace(definition,marker,marker||$new$
 if r.status='blocked' and r.error_code in ('SOURCE_TIMEOUT','SOURCE_BROWSER_FAILED') and r.attempts<2 then
  update public.source_browser_requests set status='queued',lease_token=null,lease_until=null,updated_at=now()
   where id=r.id returning * into r;
 end if;
$new$);
 marker:=$old$'error_code',r.error_code);$old$;
 if position(marker in definition)=0 then raise exception 'Notice browser result changed';end if;
 execute replace(definition,marker,$new$'error_code',case when r.status='blocked' and r.attempts>=2
  and r.error_code in ('SOURCE_TIMEOUT','SOURCE_BROWSER_FAILED') then 'SOURCE_BROWSER_FAILED' else r.error_code end);$new$);

 definition:=pg_get_functiondef('public.source_browser_page(uuid,uuid)'::regprocedure);
 marker:=$old$if r.input_hash is distinct from j.input_hash then raise exception 'STALE_INPUT';end if;$old$;
 if position(marker in definition)=0 then raise exception 'Listing browser input guard changed';end if;
 definition:=replace(definition,marker,marker||$new$
 if r.status='blocked' and r.error_code in ('SOURCE_TIMEOUT','SOURCE_BROWSER_FAILED') and r.attempts<2 then
  if not app_private.source_browser_request_current(r) then raise exception 'STALE_INPUT';end if;
  update public.source_browser_requests set status='queued',lease_token=null,lease_until=null,updated_at=now()
   where id=r.id returning * into r;
 end if;
$new$);
 marker:=$old$'error_code',r.error_code);$old$;
 if position(marker in definition)=0 then raise exception 'Listing browser result changed';end if;
 execute replace(definition,marker,$new$'error_code',case when r.status='blocked' and r.attempts>=2
  and r.error_code in ('SOURCE_TIMEOUT','SOURCE_BROWSER_FAILED') then 'SOURCE_BROWSER_FAILED' else r.error_code end);$new$);

 definition:=pg_get_functiondef('public.request_notice_ocr(uuid,uuid,text,text,jsonb,integer,text)'::regprocedure);
 marker:=$old$if not app_private.notice_ocr_current(r) then raise exception 'STALE_INPUT';end if;$old$;
 if position(marker in definition)=0 then raise exception 'OCR currentness guard changed';end if;
 definition:=replace(definition,marker,marker||$new$
 if r.status='blocked' and r.error_code in ('SOURCE_TIMEOUT','NOTICE_OCR_FAILED') and r.attempts<2 then
  update app_private.public_notice_ocr_requests set status='queued',lease_token=null,lease_until=null,updated_at=now()
   where id=r.id returning * into r;
 end if;
$new$);
 marker:=$old$if r.status='blocked' then return jsonb_build_object('status','blocked','error_code',r.error_code);end if;$old$;
 if position(marker in definition)=0 then raise exception 'OCR blocked result changed';end if;
 execute replace(definition,marker,$new$if r.status='blocked' then return jsonb_build_object('status','blocked','error_code',
  case when r.attempts>=2 and r.error_code in ('SOURCE_TIMEOUT','NOTICE_OCR_FAILED') then 'NOTICE_OCR_FAILED' else r.error_code end);end if;$new$);
end $patch$;
