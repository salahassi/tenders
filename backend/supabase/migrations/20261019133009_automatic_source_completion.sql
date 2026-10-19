create function public.advance_source_reading(job_id uuid,lease uuid,items jsonb,candidates jsonb,next_url text,warnings jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;state public.source_readings;j public.jobs;entry jsonb;count_new integer:=0;result jsonb;visited jsonb;
begin
 ctx:=public.auto_source_context(job_id,lease);
 select * into j from public.jobs where id=job_id for update;
 select * into state from public.source_readings where source_readings.job_id=j.id for update;
 if state.page is null or jsonb_typeof(items) is distinct from 'array' or jsonb_typeof(candidates) is distinct from 'array' or jsonb_typeof(warnings) is distinct from 'array' or jsonb_array_length(items)>100 or jsonb_array_length(candidates)>100 then raise exception 'INVALID_INPUT';end if;
 if next_url is not null and not exists(select 1 from jsonb_array_elements(state.page->'links') l where l->>'url'=next_url) then raise exception 'SOURCE_LINK_INVALID';end if;
 visited:=state.visited_urls||jsonb_build_array(state.page->>'url');
 select coalesce(jsonb_agg(v),'[]') into items from (select distinct on (value->>'identity_key') value v from jsonb_array_elements(state.items||items) order by value->>'identity_key' limit 100) x;
 select coalesce(jsonb_agg(v),'[]') into candidates from (select distinct on (value->>'url') value v from jsonb_array_elements(state.candidates||candidates) order by value->>'url' limit 100) x;
 warnings:=state.warnings||warnings;
 if next_url is not null and (visited ? next_url or jsonb_array_length(visited)>=5 or jsonb_array_length(items)>=100 or jsonb_array_length(candidates)>=100) then
  if jsonb_array_length(items)=0 and jsonb_array_length(candidates)=0 then raise exception 'SOURCE_NAVIGATION_LIMIT';end if;
  warnings:=warnings||'"SOURCE_NAVIGATION_LIMIT"'::jsonb;next_url:=null;
 end if;
 update public.source_readings set items=advance_source_reading.items,candidates=advance_source_reading.candidates,warnings=advance_source_reading.warnings,visited_urls=visited,pending_url=coalesce(next_url,pending_url),page=case when next_url is null then page else null end,updated_at=now() where source_readings.job_id=j.id;
 if next_url is not null then
  update public.jobs set status='queued',error_code='SOURCE_PAGE_CONTINUATION',next_attempt_at=now(),lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
  return jsonb_build_object('continued',true,'pages_read',jsonb_array_length(visited));
 end if;
 if j.type='source_collect' then
  result:=public.complete_collection(job_id,lease,jsonb_build_object('status',200,'items',items,'candidates','[]'::jsonb,'warnings',warnings));
 else
  for entry in select value from jsonb_array_elements(candidates) loop
   if not exists(select 1 from public.sources where workspace_id=j.workspace_id and url=entry->>'url') then
    insert into public.sources(workspace_id,name,kind,url,adapter_required,adapter_config,policy_note,created_by) values(j.workspace_id,left(entry->>'name',200),'link_directory',entry->>'url',false,jsonb_build_object('automatic',true,'discovery_job',j.id),'Public source suggested by directory discovery. Enable to begin automatic reading.',j.created_by);
    count_new:=count_new+1;
   end if;
  end loop;
  if not exists(select 1 from public.model_attempts a where a.job_id=j.id and a.lease_token=lease and a.operation='inspect_source_page' and a.status='succeeded') then raise exception 'HANDLER_NOT_IMPLEMENTED';end if;
  update public.jobs set status='succeeded',error_code=null,lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
  result:=jsonb_build_object('candidates',count_new);
 end if;
 update public.jobs set checkpoint=checkpoint||jsonb_build_object('source_reading_result',result||jsonb_build_object('pages_read',jsonb_array_length(visited),'warnings',warnings)),revision=revision+1 where id=j.id;
 -- Usage remains linked to the job; completed page text does not accumulate indefinitely.
 delete from public.source_readings where source_readings.job_id=j.id;
 return result;
end $$;

create function public.fail_source_reading(job_id uuid,lease uuid,error_code text,retry_after timestamptz default null) returns void language plpgsql security definer set search_path='' as $$
declare ctx jsonb;j public.jobs;
begin
 ctx:=public.auto_source_context(job_id,lease);
 select * into j from public.jobs where id=job_id;
 if j.type='source_collect' then perform public.fail_collection(job_id,lease,error_code,retry_after);return;end if;
 update public.jobs set status='blocked',error_code=fail_source_reading.error_code,next_attempt_at='infinity',lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
 perform app_private.recover_processing_job(j.id,retry_after);
end $$;

revoke all on function public.auto_source_context(uuid,uuid),public.save_source_page(uuid,uuid,jsonb),public.advance_source_reading(uuid,uuid,jsonb,jsonb,text,jsonb),public.fail_source_reading(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.auto_source_context(uuid,uuid),public.save_source_page(uuid,uuid,jsonb),public.advance_source_reading(uuid,uuid,jsonb,jsonb,text,jsonb),public.fail_source_reading(uuid,uuid,text,timestamptz) to service_role;

