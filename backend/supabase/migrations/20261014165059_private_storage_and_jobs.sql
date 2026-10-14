insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('tenderdesk-private','tenderdesk-private',false,10485760,array[
 'application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','text/markdown','text/csv','image/png','image/jpeg','image/webp','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.openxmlformats-officedocument.presentationml.presentation'
]) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

-- Authenticated uploads use a single immutable reserved path. Signed uploads
-- have a provider-fixed lifetime, so no broad reusable signed token is issued.
create policy tenderdesk_upload on storage.objects for insert to authenticated with check(
  bucket_id='tenderdesk-private' and exists(
    select 1 from public.documents d where d.storage_key=name and d.status='pending' and d.created_by=auth.uid()
      and d.created_at+interval '15 minutes'>now() and app_private.member_role(d.workspace_id) in ('Owner','Editor')
  )
);
create policy tenderdesk_download on storage.objects for select to authenticated using(
  bucket_id='tenderdesk-private' and exists(
    select 1 from public.documents d where d.storage_key=name and d.status not in ('pending','expired') and app_private.member_role(d.workspace_id) is not null
  )
);
-- No client update/delete policies: originals cannot be overwritten in place.

create or replace function public.claim_backend_job() returns jsonb
language plpgsql security definer set search_path='' as $$
declare w uuid;j public.jobs;
begin
  select id into w from public.workspaces limit 1;
  if w is null then return null; end if;
  perform 1 from public.workspaces where id=w for update;
  update public.operations set last_heartbeat_at=now() where workspace_id=w;
  -- Expiry recovery preserves uncertainty instead of repeating a provider call.
  update public.jobs set status=case when cancel_requested then 'canceled' else 'blocked' end,error_code='LEASE_EXPIRED_REVIEW_REQUIRED',lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where workspace_id=w and status='running' and lease_until<now();
  if exists(select 1 from public.jobs where workspace_id=w and status='running') then return null; end if;
  select * into j from public.jobs where workspace_id=w and status in ('queued','retry_wait') and next_attempt_at<=now() order by case when type in ('plan_proposal','analyze_chunk','draft_section') then 0 else 1 end,created_at,id for update skip locked limit 1;
  if j.id is null then return null; end if;
  if j.cancel_requested then
    update public.jobs set status='canceled',revision=revision+1,updated_at=now() where id=j.id;
    return null;
  end if;
  update public.jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '180 seconds',revision=revision+1,updated_at=now() where id=j.id returning * into j;
  return to_jsonb(j);
end $$;
create or replace function public.finish_backend_job(job_id uuid,lease uuid,result_status text,result_error text) returns void
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  if result_status not in ('blocked','failed','canceled') then raise exception 'HANDLER_NOT_IMPLEMENTED'; end if;
  update public.jobs set status=case when cancel_requested then 'canceled' else result_status end,error_code=result_error,lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=job_id and status='running' and lease_token=lease and lease_until>now();
  get diagnostics n=row_count;
  if n<>1 then raise exception 'STALE_LEASE'; end if;
end $$;
revoke all on function public.claim_backend_job() from public,anon,authenticated;
revoke all on function public.finish_backend_job(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_backend_job() to service_role;
grant execute on function public.finish_backend_job(uuid,uuid,text,text) to service_role;
