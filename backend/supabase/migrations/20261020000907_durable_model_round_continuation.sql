-- A logical model round can span worker leases without resending completed
-- attempts. Only identity hashes, provider identities and safe error codes are
-- checkpointed here; content/credentials never enter this checkpoint.
create function public.load_model_round(job_id uuid, lease uuid, input_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs; progress jsonb;
begin
 select * into j from public.jobs where id=job_id;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 progress:=j.checkpoint->'model_round';
 if progress is not null and progress->>'input_hash' is distinct from input_hash then raise exception 'STALE_INPUT';end if;
 return progress;
end $$;

create function public.save_model_round(job_id uuid, lease uuid, progress jsonb, release_job boolean default false)
returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs; item jsonb;
begin
 select * into j from public.jobs where id=job_id;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 select * into j from public.jobs where id=job_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 if release_job is null or (progress is null and release_job) then raise exception 'INVALID_INPUT';end if;
 if progress is not null then
  perform app_private.check_keys(progress,array['input_hash','remaining','output_error','retry_windows']);
  if pg_column_size(progress)>8192 or coalesce(progress->>'input_hash','') !~ '^[a-f0-9]{64}$'
   or jsonb_typeof(progress->'remaining') is distinct from 'array'
   or jsonb_typeof(progress->'retry_windows') is distinct from 'array' then raise exception 'INVALID_INPUT';end if;
  if jsonb_array_length(progress->'remaining') not between 1 and 8 or jsonb_array_length(progress->'retry_windows')>8
   or (progress->>'output_error' is not null and progress->>'output_error' not in ('MODEL_OUTPUT_INVALID','MODEL_OUTPUT_TRUNCATED','MODEL_OUTPUT_TOO_LARGE','MODEL_COVERAGE_INCOMPLETE','EVIDENCE_REFERENCE_INVALID','UNSUPPORTED_COMPANY_CLAIM'))
   or (select count(distinct e->>'provider') from jsonb_array_elements(progress->'remaining') e)<>jsonb_array_length(progress->'remaining') then raise exception 'INVALID_INPUT';end if;
  for item in select value from jsonb_array_elements(progress->'remaining') loop
   perform app_private.check_keys(item,array['provider','model','project_ref']);
   if not exists(select 1 from jsonb_array_elements(j.checkpoint->'model_routing'->'providers') p where p->>'provider'=item->>'provider' and p->>'model'=item->>'model' and p->>'project_ref'=item->>'project_ref') then raise exception 'MODEL_IDENTITY_CHANGED';end if;
  end loop;
  for item in select value from jsonb_array_elements(progress->'retry_windows') loop
   if item<>'null'::jsonb and (jsonb_typeof(item)<>'string' or not isfinite((item#>>'{}')::timestamptz)) then raise exception 'INVALID_INPUT';end if;
  end loop;
 end if;
 -- Releasing between providers is distinct from an accepted remote request;
 -- that request must use defer_model_request so it remains GET-only on resume.
 if release_job and exists(select 1 from public.provider_usage u where u.job_id=j.id and u.state='reserved') then raise exception 'MODEL_CALL_ALREADY_RESERVED';end if;
 update public.jobs set checkpoint=case when progress is null then checkpoint-'model_round' else jsonb_set(checkpoint,'{model_round}',progress) end,
  status=case when release_job then 'retry_wait' else status end,
  error_code=case when release_job then 'MODEL_IN_PROGRESS' else error_code end,
  next_attempt_at=case when release_job then now() else next_attempt_at end,
  lease_token=case when release_job then null else lease_token end,
  lease_until=case when release_job then null else lease_until end,
  revision=revision+1,updated_at=now() where id=j.id;
end $$;

-- Continue the existing round/order/count after a clean handoff, while still
-- rebuilding current server identities and checking current sharing permissions.
do $$ declare definition text; fragment text;begin
 select pg_get_functiondef('public.prepare_model_routing_before_activity(uuid,uuid,jsonb)'::regprocedure) into definition;
 fragment:='resuming:=exists(select 1 from public.provider_usage u where u.job_id=j.id and u.state=''reserved'' and u.remote_request_id is not null);';
 if position(fragment in definition)=0 then raise exception 'Unexpected routing continuation guard';end if;
 execute replace(definition,fragment,'resuming:=j.checkpoint ? ''model_round'' or exists(select 1 from public.provider_usage u where u.job_id=j.id and u.state=''reserved'' and u.remote_request_id is not null);');
end $$;
revoke all on function public.load_model_round(uuid,uuid,text), public.save_model_round(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.load_model_round(uuid,uuid,text), public.save_model_round(uuid,uuid,jsonb,boolean) to service_role;
