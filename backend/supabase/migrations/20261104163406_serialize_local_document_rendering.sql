-- One valid document-render lease at a time across the existing jobs queue.
-- Queue wait consumes neither a lease attempt nor a render failure. Inference,
-- remote polling and local graph/projection work retain their own admission.
-- Keep the existing hard one-job non-render lane, while giving local document
-- rendering its own lane. The global advisory guard below is stricter across
-- workspaces than either per-workspace index.
drop index public.one_active_job_per_workspace;
create unique index one_active_non_render_job_per_workspace on public.jobs(workspace_id)
 where status='running' and type not in ('render_delivery','render_export');
create unique index one_active_render_job_per_workspace on public.jobs(workspace_id)
 where status='running' and type in ('render_delivery','render_export');
create index jobs_active_document_render on public.jobs(lease_until)
 where type in ('render_delivery','render_export') and status='running' and lease_token is not null;
create function app_private.document_render_slot_available() returns boolean
language sql volatile security definer set search_path='' as $$
 select not exists(select 1 from public.jobs
  where type in ('render_delivery','render_export') and status='running'
   and lease_token is not null and lease_until>clock_timestamp())
$$;

-- The workspace lock already serializes ordinary claims within a workspace.
-- A nonblocking transaction advisory mutex also makes the global slot check and
-- subsequent canonical lease transition atomic across distinct workspaces.
-- A contender unable to take it can still claim non-render work normally.
do $$declare definition text;marker text;signature text;begin
 select pg_get_functiondef('app_private.next_fair_job(uuid,boolean)'::regprocedure) into definition;
 marker:='capacity boolean;';if position(marker in definition)=0 then raise exception 'DOCUMENT_RENDER_ADMISSION_DECLARATION_CHANGED';end if;
 definition:=replace(definition,marker,marker||'render_capacity boolean;non_render_capacity boolean;');
 marker:=' capacity:=';if position(marker in definition)=0 then raise exception 'DOCUMENT_RENDER_ADMISSION_CAPACITY_CHANGED';end if;
 definition:=replace(definition,marker,$new$
 non_render_capacity:=not exists(select 1 from public.jobs where workspace_id=workspace and status='running'
  and type not in ('render_delivery','render_export'));
 render_capacity:=false;
 if pg_try_advisory_xact_lock(hashtextextended('tenderdesk.document-render-admission.v1',0)) then
  render_capacity:=app_private.document_render_slot_available();
 end if;
$new$||marker);
 marker:='and (not local_only or c.work_class=''local'')';if position(marker in definition)=0 then raise exception 'DOCUMENT_RENDER_ADMISSION_SCOPE_CHANGED';end if;
 definition:=replace(definition,marker,marker||$new$
  and (q.type not in ('render_delivery','render_export') or q.cancel_requested or render_capacity)
  and (q.type in ('render_delivery','render_export') or q.cancel_requested or non_render_capacity)$new$);
 execute definition;

 -- The previous blanket one-running-job guard serialized render work with all
 -- other work. Keep its existing non-render lane in the selector above, while
 -- admitting one independent render lease through the global mutex.
 select pg_get_functiondef('public.claim_backend_job()'::regprocedure) into definition;
 marker:='if exists(select 1 from public.jobs where workspace_id=w and status=''running'') then return null; end if;';
 if position(marker in definition)=0 then raise exception 'DOCUMENT_RENDER_ADMISSION_CLAIM_CHANGED';end if;
 execute replace(definition,marker,'');

 -- Wake inspection does not reserve capacity; the canonical claim above is the
 -- authority. Avoid redundant wakes caused solely by occupied render work, while
 -- preserving independent model/poll/projection candidates and existing delays.
 foreach signature in array array[
  'app_private.wake_backend_queue_checked(uuid,uuid,bigint)',
  'app_private.wake_backend_queue_checked_v3(uuid,uuid,bigint)',
  'app_private.wake_backend_queue_checked_v4(uuid,uuid,bigint)'] loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  marker:='where q.workspace_id=w and not q.cancel_requested';
  if position(marker in definition)=0 then raise exception 'DOCUMENT_RENDER_ADMISSION_WAKE_CHANGED';end if;
  definition:=replace(definition,marker,marker||$new$
   and (q.type not in ('render_delivery','render_export') or app_private.document_render_slot_available())
   and (q.type in ('render_delivery','render_export') or not exists(select 1 from public.jobs busy
    where busy.workspace_id=w and busy.status='running' and busy.type not in ('render_delivery','render_export')))$new$);
  marker:='or exists(select 1 from public.jobs where workspace_id=w and status=''running'')';
  if position(marker in definition)=0 then raise exception 'DOCUMENT_RENDER_ADMISSION_WAKE_RUNNING_CHANGED';end if;
  definition:=replace(definition,marker,$new$or (remote_poll and exists(select 1 from public.jobs busy
   where busy.workspace_id=w and busy.status='running' and busy.type not in ('render_delivery','render_export')))$new$);
  definition:=replace(definition,'q.type=''render_delivery''','q.type in (''render_delivery'',''render_export'')');
  execute definition;
 end loop;
end $$;

-- This is an internal capacity predicate, not a caller-supplied authorization
-- or a new public RPC. Preserve each replaced function's owner/ACL/definer flags.
revoke all on function app_private.document_render_slot_available() from public;
do $$declare role_name text;begin
 foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then
   execute format('revoke all on function app_private.document_render_slot_available() from %I',role_name);
  end if;
 end loop;
end $$;
