create function public.source_browser_identity(request_id uuid,lease uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.source_browser_requests;
begin
 select * into r from public.source_browser_requests where id=request_id;
 if r.id is null or r.status<>'running' or r.lease_token is distinct from lease or r.lease_until<=now() then raise exception 'STALE_LEASE';end if;
 return jsonb_build_object('workspace_id',r.workspace_id,'host',lower(substring(r.url from '^https://([^/:?]+)')));
end $$;
revoke all on function public.source_browser_identity(uuid,uuid) from public,anon,authenticated;
grant execute on function public.source_browser_identity(uuid,uuid) to service_role;
