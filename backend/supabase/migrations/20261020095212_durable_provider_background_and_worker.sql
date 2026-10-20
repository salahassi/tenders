-- Native asynchronous providers keep one accepted request across worker lifetimes.
alter table public.provider_usage add column remote_project_ref text;
alter table public.provider_usage drop constraint provider_usage_remote_request_check;
alter table public.provider_usage add constraint provider_usage_remote_request_check check (
 (remote_request_id is null and remote_deadline is null) or
 (provider in ('gemini_free','openai') and remote_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' and remote_deadline is not null)
);

create or replace function public.resume_model_request(job_id uuid,lease uuid,input_hash text,target_provider text,manifest jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;u public.provider_usage;pool jsonb;
begin
 select * into j from public.jobs where id=job_id;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 if input_hash is null or input_hash !~ '^[0-9a-f]{64}$' or target_provider is null or target_provider not in ('gemini_free','openai') then raise exception 'INVALID_INPUT';end if;
 pool:=public.model_preflight(job_id,lease,manifest);
 select * into u from public.provider_usage p where p.job_id=j.id and p.provider=target_provider and p.remote_request_id is not null order by (p.state='reserved') desc,(p.state='unknown') desc,(p.input_hash=resume_model_request.input_hash) desc,p.created_at desc,p.id desc limit 1 for update;
 if u.id is null then return null;end if;
 -- A measured prior result may have led to an explicitly bounded repair prompt.
 if u.state='settled' and u.error_code='PROVIDER_REQUEST_REJECTED' then return null;end if;
 if u.state='settled' and u.input_hash<>resume_model_request.input_hash then return null;end if;
 if u.input_hash<>resume_model_request.input_hash or u.provider<>target_provider or not exists(select 1 from jsonb_array_elements(pool->'providers') m where m->>'provider'=u.provider and m->>'model'=u.model and (u.remote_project_ref is null or m->>'project_ref'=u.remote_project_ref)) then raise exception 'MODEL_IDENTITY_CHANGED';end if;

 update public.provider_usage set lease_token=lease,revision=revision+1,updated_at=now() where id=u.id returning * into u;
 return to_jsonb(u);
end $$;

create or replace function public.checkpoint_model_request(job_id uuid,lease uuid,reservation uuid,remote_id text)
returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;u public.provider_usage;
begin
 select * into j from public.jobs where id=job_id;perform 1 from public.workspaces where id=j.workspace_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 select * into u from public.provider_usage where id=reservation for update;
 if u.id is null or u.job_id<>j.id or u.lease_token is distinct from lease or u.provider not in ('gemini_free','openai') or u.state<>'reserved' then raise exception 'MODEL_CALL_ALREADY_RESERVED';end if;
 if remote_id is null or remote_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' then raise exception 'INVALID_INPUT';end if;
 if u.remote_request_id is not null and u.remote_request_id<>remote_id then raise exception 'IDEMPOTENCY_CONFLICT';end if;
 update public.provider_usage set remote_request_id=remote_id,
 remote_project_ref=coalesce(remote_project_ref,(select project_ref from public.model_settings where workspace_id=j.workspace_id and provider=u.provider and model=u.model)),
 remote_deadline=coalesce(remote_deadline,now()+interval '23 hours'),revision=revision+1,updated_at=now() where id=u.id;
end $$;

create or replace function public.claim_abandoned_model_request()
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.provider_usage;
begin
 select p.* into u from public.provider_usage p join public.jobs j on j.id=p.job_id
 where p.provider in ('gemini_free','openai') and p.state='unknown' and p.remote_request_id is not null
 and p.remote_deadline>now() and j.status in ('canceled','blocked','failed')
 and (p.reconciliation_after is null or p.reconciliation_after<=now())
 order by p.created_at,p.id for update of p skip locked limit 1;
 if u.id is null then return null;end if;
 update public.provider_usage set reconciliation_after=now()+interval '5 minutes',revision=revision+1,updated_at=now() where id=u.id;
 return jsonb_build_object('id',u.id,'provider',u.provider,'model',u.model,'project_ref',u.remote_project_ref,'remote_request_id',u.remote_request_id);
end $$;
revoke all on function public.claim_abandoned_model_request() from public,anon,authenticated;
grant execute on function public.claim_abandoned_model_request() to service_role;
