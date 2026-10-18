-- Health must support multiple configured providers and automatic routing.
create or replace function public.workspace_status() returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;result jsonb;day date:=(now() at time zone 'Asia/Riyadh')::date;
begin
 result:=public.workspace_status_before_operations();select m.workspace_id into w from public.memberships m where m.user_id=auth.uid() and app_private.member_role(m.workspace_id) is not null limit 1;
 return result||jsonb_build_object('last_maintenance_at',(select last_maintenance_at from public.operations where workspace_id=w),'last_cleanup_at',(select last_cleanup_at from public.operations where workspace_id=w),
 'export_bytes',(select coalesce(sum(expected_size),0)::text from public.export_artifacts where workspace_id=w and status<>'expired'),
 'reserved_storage_bytes',app_private.storage_reserved_bytes(w)::text,
 'cleanup_bytes',(select coalesce(sum(estimated_size),0)::text from public.storage_cleanup_queue where workspace_id=w and status<>'done'),
 'cleanup_pending',(select count(*) from public.storage_cleanup_queue where workspace_id=w and status in ('pending','running')),'cleanup_blocked',(select count(*) from public.storage_cleanup_queue where workspace_id=w and status='blocked'),
 'queued_jobs',(select count(*) from public.jobs where workspace_id=w and status in ('queued','retry_wait')),'blocked_jobs',(select count(*) from public.jobs where workspace_id=w and status in ('blocked','quota_wait')),
 'model_enabled',(exists(select 1 from public.model_settings where workspace_id=w and enabled) or exists(select 1 from public.model_routing where workspace_id=w and enabled)),'usage_day',day,'usage_timezone','Asia/Riyadh',
 'calls_today',(select count(*) from public.provider_usage where workspace_id=w and application_day=day),
 'input_tokens_today',(select coalesce(sum(coalesce(actual_input,reserved_input)),0)::text from public.provider_usage where workspace_id=w and application_day=day),
 'output_tokens_today',(select coalesce(sum(coalesce(actual_output,reserved_output)),0)::text from public.provider_usage where workspace_id=w and application_day=day),
 'unknown_usage',(select count(*) from public.provider_usage where workspace_id=w and state='unknown'));
end $$;
revoke all on function public.workspace_status() from public,anon;
grant execute on function public.workspace_status() to authenticated;
