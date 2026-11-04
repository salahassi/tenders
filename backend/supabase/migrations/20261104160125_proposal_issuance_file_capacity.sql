-- Reserve the existing complete package envelope before a new billable model
-- operation. Two volumes × the existing 10MiB artifact limit; no model/token cap.
alter table public.proposal_issuance_requests add column file_capacity_version integer;
alter table public.proposal_issuance_requests alter column file_capacity_version set default 1;
alter table public.proposal_issuance_requests add column file_capacity_acquired boolean not null default false;
alter table public.proposal_issuance_requests add column reserved_file_bytes bigint not null default 0;
alter table public.proposal_issuance_requests add constraint issuance_file_capacity_bounds check(
 reserved_file_bytes between 0 and 20971520 and (file_capacity_acquired or reserved_file_bytes=0)
 and (outcome='active' or reserved_file_bytes=0)
 and case when file_capacity_version is null then not file_capacity_acquired and reserved_file_bytes=0 else file_capacity_version=1 end);

alter function app_private.storage_reserved_bytes(uuid) rename to storage_reserved_bytes_before_issuance_capacity;
create function app_private.storage_reserved_bytes(w uuid) returns bigint language sql stable security definer set search_path='' as $$
 select app_private.storage_reserved_bytes_before_issuance_capacity(w)+coalesce((select sum(reserved_file_bytes) from public.proposal_issuance_requests where workspace_id=w),0)
$$;

-- Capacity metadata is not paid request identity. Acquiring an allowance cannot
-- reset a deadline, candidate, provider reservation or historical source pin.
create or replace function app_private.issuance_identity_immutable() returns trigger language plpgsql set search_path='' as $$begin
 if new.outcome<>'active' then new.reserved_file_bytes:=0;end if;
 if (to_jsonb(new)-array['outcome','error_code','completed_at','issued_snapshot_id','file_capacity_acquired','reserved_file_bytes']) is distinct from
    (to_jsonb(old)-array['outcome','error_code','completed_at','issued_snapshot_id','file_capacity_acquired','reserved_file_bytes'])
  or old.outcome<>'active' and new is distinct from old
  or old.file_capacity_acquired and not new.file_capacity_acquired
 then raise exception 'ISSUANCE_IDENTITY_IMMUTABLE';end if;
 return new;
end $$;
create function app_private.guard_issuance_file_capacity() returns trigger language plpgsql security definer set search_path='' as $$
declare previous_bytes bigint:=case when tg_op='UPDATE' then old.reserved_file_bytes else 0 end;begin
 -- Restore turns historical active requests into terminal review-required rows.
 -- Their unspent allowance is future capacity, never stored/ambiguous bytes.
 if new.outcome<>'active' then new.reserved_file_bytes:=0;end if;
 if new.reserved_file_bytes>previous_bytes then
  perform 1 from public.workspaces where id=new.workspace_id for update;
  if app_private.storage_reserved_bytes(new.workspace_id)+new.reserved_file_bytes-previous_bytes>262144000 then raise exception 'STORAGE_CAP_REACHED';end if;
 end if;return new;
end $$;
create trigger issuance_capacity_guard before insert or update on public.proposal_issuance_requests for each row execute function app_private.guard_issuance_file_capacity();

create function app_private.ensure_issuance_file_capacity(job_id uuid,lease uuid) returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs;r public.proposal_issuance_requests;begin
 perform app_private.assert_issuance_job(job_id);
 select * into j from public.jobs where id=job_id;
 if j.id is null or not(j.checkpoint ? 'issuance_request_id') then return;end if;
 if lease is null or j.lease_token is distinct from lease or j.status<>'running' then raise exception 'STALE_LEASE';end if;
 select * into r from public.proposal_issuance_requests where id=(j.checkpoint->>'issuance_request_id')::uuid and workspace_id=j.workspace_id for update;
 if r.file_capacity_version is null or r.file_capacity_acquired then return;end if;
 -- The workspace lock is already held by assert_issuance_job. The capacity
 -- guard and every competing storage writer use the same canonical ledger.
 update public.proposal_issuance_requests set file_capacity_acquired=true,reserved_file_bytes=20971520 where id=r.id;
end $$;

alter function public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid) rename to reserve_task_model_call_before_file_capacity;
create function public.reserve_task_model_call(job_id uuid,lease uuid,call_key text,input_hash text,input_tokens integer,output_tokens integer,manifest jsonb,target_model uuid,target_connection uuid) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform app_private.ensure_issuance_file_capacity(job_id,lease);
 return public.reserve_task_model_call_before_file_capacity(job_id,lease,call_key,input_hash,input_tokens,output_tokens,manifest,target_model,target_connection);
end $$;
alter function public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text) rename to reserve_model_call_before_file_capacity;
create function public.reserve_model_call(job_id uuid,lease uuid,call_key text,input_hash text,input_tokens integer,output_tokens integer,manifest jsonb,target_provider text) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 perform app_private.ensure_issuance_file_capacity(job_id,lease);
 return public.reserve_model_call_before_file_capacity(job_id,lease,call_key,input_hash,input_tokens,output_tokens,manifest,target_provider);
end $$;

alter function public.delivery_export_context(uuid,uuid) rename to delivery_export_context_before_file_capacity;
create function public.delivery_export_context(job_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.proposal_delivery_snapshots;r public.proposal_issuance_requests;needed bigint;begin
 j:=app_private.delivery_job(job_id,lease,true);
 select * into s from public.proposal_delivery_snapshots where id=j.entity_id;
 if s.payload->'version'='3'::jsonb and j.checkpoint ? 'issuance_request_id' then
  select * into r from public.proposal_issuance_requests where id=(j.checkpoint->>'issuance_request_id')::uuid and workspace_id=j.workspace_id for update;
  select coalesce(sum(10485760-reserved_bytes),0) into needed from public.proposal_delivery_artifacts where proposal_delivery_artifacts.job_id=j.id and status='pending';
  if r.reserved_file_bytes>0 and needed>0 then
   -- Atomically transfer future package capacity to exact pending artifact
   -- slots. Delegation failure rolls this decrease back; v1 previews cannot use it.
   update public.proposal_issuance_requests set reserved_file_bytes=reserved_file_bytes-least(reserved_file_bytes,needed) where id=r.id;
  end if;
 end if;
 return public.delivery_export_context_before_file_capacity(job_id,lease);
end $$;

-- A known impossible file package ends the automatic request immediately.
do $$ declare definition text;marker text:='error_code in (''PROPOSAL_ISSUANCE_TIMEOUT'',''AI_AGENTS_UNAVAILABLE'')';begin
 definition:=pg_get_functiondef('public.fail_generation(uuid,uuid,text,timestamptz,jsonb)'::regprocedure);
 if position(marker in definition)=0 then raise exception 'ISSUANCE_FAILURE_CONTRACT_CHANGED';end if;
 execute replace(definition,marker,'error_code in (''PROPOSAL_ISSUANCE_TIMEOUT'',''AI_AGENTS_UNAVAILABLE'',''STORAGE_CAP_REACHED'')');
end $$;

-- Rebind qualified parameter names inside renamed wrappers, not caller input.
do $$ declare signature text;definition text;old_name text;new_name text;begin
 foreach signature in array array[
 'public.reserve_task_model_call_before_file_capacity(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)',
 'public.reserve_model_call_before_file_capacity(uuid,uuid,text,text,integer,integer,jsonb,text)',
 'public.delivery_export_context_before_file_capacity(uuid,uuid)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);new_name:=split_part(split_part(signature,'.',2),'(',1);old_name:=replace(new_name,'_before_file_capacity','');
  execute replace(definition,old_name||'.',new_name||'.');
 end loop;
end $$;
revoke all on function app_private.storage_reserved_bytes_before_issuance_capacity(uuid),app_private.storage_reserved_bytes(uuid),app_private.guard_issuance_file_capacity(),app_private.ensure_issuance_file_capacity(uuid,uuid) from public;
do $$ declare signature text;r text;begin
 foreach signature in array array[
 'app_private.storage_reserved_bytes_before_issuance_capacity(uuid)','app_private.storage_reserved_bytes(uuid)',
 'app_private.guard_issuance_file_capacity()','app_private.ensure_issuance_file_capacity(uuid,uuid)',
 'public.reserve_task_model_call_before_file_capacity(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)',
 'public.reserve_model_call_before_file_capacity(uuid,uuid,text,text,integer,integer,jsonb,text)',
 'public.delivery_export_context_before_file_capacity(uuid,uuid)',
 'public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)',
 'public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text)','public.delivery_export_context(uuid,uuid)'] loop
  execute format('revoke all on function %s from public',signature);
  foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',signature,r);end if;
  end loop;
 end loop;
 foreach signature in array array['public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)','public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text)','public.delivery_export_context(uuid,uuid)'] loop
  foreach r in array array['service_role','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=r) then execute format('grant execute on function %s to %I',signature,r);end if;
  end loop;
 end loop;
end $$;
