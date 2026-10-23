-- Reviewed HTML extraction now runs directly for automatic sources as well.
-- Give its initial fetch/browser handoff the same alternating background turn
-- as configured static sources; retain ordinary priority for saved model pages.
do $patch$ declare definition text;
 marker text := E'and coalesce(s.adapter_config->>''automatic'',''false'')<>''true'')';
begin
 select pg_get_functiondef('app_private.next_fair_job(uuid,boolean)'::regprocedure) into definition;
 if position(marker in definition)=0 then raise exception 'Configured queue preference changed';end if;
 execute replace(definition,marker,$ordering$and (
        coalesce(s.adapter_config->>'automatic','false')<>'true'
        or (s.adapter_config->'automatic'='true'::jsonb
         and jsonb_typeof(s.adapter_config->'official_listing')='string'
         and length(btrim(s.adapter_config->>'official_listing'))>0
         and jsonb_typeof(s.adapter_config->'extraction')='object'
         and s.adapter_config->'extraction'->'version'='1'::jsonb
         and s.adapter_config->'extraction'->>'url'=s.url
         and s.adapter_config->'extraction'->'listing'->>'layout' in ('records','table','links','cards')
         and length(coalesce(s.adapter_config->'extraction'->'listing'->>'rows','')) between 1 and 300
         and length(coalesce(s.adapter_config->'extraction'->'detail'->>'root','')) between 1 and 300
         and not exists(select 1 from public.source_readings cached where cached.job_id=q.id
          and cached.page is not null and jsonb_typeof(cached.page->'extraction_html') is distinct from 'string'))
       ))$ordering$);
end $patch$;

-- Original notice reading is a prerequisite, not a fresh inference request.
-- Prefer it on that same alternate cycle after listing fetches. In-flight OCR
-- and browser reads keep ordinary priority until their exact receipt is ready.
do $patch$ declare definition text;
 marker text := E'   ) then 0 else 1 end,\n  coalesce(served.last_dispatch,-1),';
begin
 select pg_get_functiondef('app_private.next_fair_job(uuid,boolean)'::regprocedure) into definition;
 if position(marker in definition)=0 then raise exception 'Notice queue preference changed';end if;
 execute replace(definition,marker,$ordering$   ) then 0
  when c.work_class='background' and (scheduler.cursor/array_length(slots,1))%2=0
   and not q.cancel_requested and app_private.queue_needs_notice_details(q)
   and (
    coalesce(q.error_code,'') not in ('NOTICE_OCR_PENDING','SOURCE_OCR_PENDING','NOTICE_BROWSER_PENDING','SOURCE_BROWSER_PENDING')
    or (q.error_code in ('NOTICE_OCR_PENDING','SOURCE_OCR_PENDING') and exists(
     select 1 from app_private.public_notice_ocr_requests receipt where receipt.job_id=q.id
      and receipt.status='ready' and app_private.notice_ocr_current(receipt))
     and not exists(select 1 from app_private.public_notice_ocr_requests pending where pending.job_id=q.id
      and pending.status in ('queued','running') and app_private.notice_ocr_current(pending)))
    or (q.error_code in ('NOTICE_BROWSER_PENDING','SOURCE_BROWSER_PENDING') and exists(
     select 1 from public.source_browser_requests receipt where receipt.job_id=q.id
      and receipt.purpose='notice_detail' and receipt.status='ready'
      and app_private.source_browser_request_current(receipt)))
   ) then 1 else 2 end,
  coalesce(served.last_dispatch,-1),$ordering$);
end $patch$;
