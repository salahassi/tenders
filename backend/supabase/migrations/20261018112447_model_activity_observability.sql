-- Durable attempt metadata: never prompts, company text, response bodies or credentials.
create table public.model_attempts (
 id bigint generated always as identity primary key,
 workspace_id uuid not null references public.workspaces(id) on delete cascade,
 job_id uuid not null, lease_token uuid not null,
 provider text not null, model text not null default '', project_ref text not null default '',
 operation text not null, round_number int not null, worker_attempt int not null,
 status text not null check(status in ('running','succeeded','failed','skipped','waiting','historical')),
 result_code text, sent boolean not null default false,
 usage_id uuid references public.provider_usage(id) on delete set null,
 started_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
 http_status int check(http_status between 100 and 599), request_id text, response_id text,
 reported_model text, finish_reason text, request_phase text, retry_after timestamptz,
 foreign key(workspace_id,job_id) references public.jobs(workspace_id,id) on delete cascade,
 constraint model_attempts_job_lease_provider_key unique(job_id,lease_token,provider)
);
create index model_attempts_workspace_recent on public.model_attempts(workspace_id,id desc);
create index model_attempts_job on public.model_attempts(job_id);
create index model_attempts_usage on public.model_attempts(usage_id);
alter table public.model_attempts enable row level security;
create policy member_read on public.model_attempts for select to authenticated using(app_private.member_role(workspace_id) is not null);
create policy service_all on public.model_attempts to service_role using(true) with check(true);
revoke all on public.model_attempts from public,anon,authenticated;
grant select on public.model_attempts to authenticated;
grant all on public.model_attempts to service_role;
grant usage,select on sequence public.model_attempts_id_seq to service_role;

-- Preserve measured history without inventing a response-validation outcome.
insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,operation,round_number,worker_attempt,status,result_code,sent,usage_id,started_at,finished_at)
select u.workspace_id,u.job_id,u.lease_token,u.provider,u.model,case when j.type='model_probe' then 'connection_probe' else j.type end,0,0,'historical',u.error_code,true,u.id,u.created_at,case when u.state<>'reserved' then u.updated_at end
from public.provider_usage u join public.jobs j on j.id=u.job_id and j.workspace_id=u.workspace_id order by u.created_at,u.id;

create function public.start_model_attempt(job_id uuid,lease uuid,provider_id text,model_name text,project_name text,operation_name text) returns bigint language plpgsql security definer set search_path='' as $$
declare j public.jobs; result bigint;
begin
 select * into j from public.jobs where id=job_id;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 if provider_id not in ('gemini_free','qwen_free','mistral_free','groq_free','zai_free','cloudflare_free') or length(model_name)>120 or length(project_name)>120 or operation_name !~ '^[a-z_]{1,80}$' then raise exception 'INVALID_INPUT';end if;
 insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,project_ref,operation,round_number,worker_attempt,status)
 values(j.workspace_id,j.id,lease,provider_id,model_name,project_name,operation_name,coalesce((j.checkpoint->'model_routing'->>'round_attempts')::int,j.attempts),j.attempts,'running')
 on conflict on constraint model_attempts_job_lease_provider_key do update set model=excluded.model,project_ref=excluded.project_ref returning id into result;
 return result;
end $$;
create function public.finish_model_attempt(attempt_id bigint,lease uuid,result_code text,sent boolean,usage_id uuid,metadata jsonb) returns void language plpgsql security definer set search_path='' as $$
declare a public.model_attempts;
begin
 select * into a from public.model_attempts where id=attempt_id for update;
 if a.id is null or a.lease_token is distinct from lease then raise exception 'STALE_LEASE';end if;
 if result_code is null or result_code !~ '^[A-Z][A-Z0-9_]{1,100}$' or sent is null or pg_column_size(metadata)>4096 then raise exception 'INVALID_INPUT';end if;
 perform app_private.check_keys(metadata,array['http_status','request_id','response_id','reported_model','finish_reason','request_phase','retry_after']);
 if exists(select 1 from jsonb_each_text(metadata) e where e.key in ('request_id','response_id','reported_model','finish_reason','request_phase') and e.value !~ '^[A-Za-z0-9._:/@-]{1,200}$') then raise exception 'INVALID_INPUT';end if;
 if usage_id is not null and not exists(select 1 from public.provider_usage u where u.id=usage_id and u.workspace_id=a.workspace_id and u.job_id=a.job_id and u.provider=a.provider) then raise exception 'MODEL_IDENTITY_CHANGED';end if;
 update public.model_attempts set status=case when finish_model_attempt.result_code='SUCCEEDED' then 'succeeded' when finish_model_attempt.result_code='MODEL_IN_PROGRESS' then 'waiting' when not finish_model_attempt.sent then 'skipped' else 'failed' end,
 result_code=finish_model_attempt.result_code,sent=finish_model_attempt.sent,usage_id=finish_model_attempt.usage_id,finished_at=clock_timestamp(),
 http_status=(metadata->>'http_status')::int,request_id=metadata->>'request_id',response_id=metadata->>'response_id',reported_model=metadata->>'reported_model',finish_reason=metadata->>'finish_reason',request_phase=metadata->>'request_phase',retry_after=(metadata->>'retry_after')::timestamptz where id=a.id;
end $$;
revoke all on function public.start_model_attempt(uuid,uuid,text,text,text,text),public.finish_model_attempt(bigint,uuid,text,boolean,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.start_model_attempt(uuid,uuid,text,text,text,text),public.finish_model_attempt(bigint,uuid,text,boolean,uuid,jsonb) to service_role;

create view public.model_activity with(security_invoker=true) as
select a.id::text id,a.workspace_id,a.job_id,a.provider,a.model,a.project_ref,a.operation,a.round_number,a.worker_attempt,
 case when a.status='running' and (j.status<>'running' or j.lease_token is distinct from a.lease_token or j.lease_until<=now()) then 'interrupted' else a.status end status,
 a.result_code,a.sent,coalesce(a.usage_id,u.id) usage_id,a.started_at,a.finished_at,
 case when a.finished_at is not null then round(extract(epoch from a.finished_at-a.started_at)*1000)::bigint end duration_ms,
 a.http_status,a.request_id,a.response_id,a.reported_model,a.finish_reason,a.request_phase,a.retry_after,
 u.actual_input,u.actual_output,u.thinking_tokens,u.reserved_input,u.reserved_output,u.state usage_state,u.remote_request_id,
 p.id plan_id,p.opportunity_id,p.proposal_id,o.title opportunity_title,j.status job_status,j.error_code job_error,j.next_attempt_at,
 -- Keep numeric ordering separate from the lossless text identifier delivered to JS.
 a.id sequence
from public.model_attempts a join public.jobs j on j.id=a.job_id and j.workspace_id=a.workspace_id
left join public.provider_usage u on u.workspace_id=a.workspace_id and (u.id=a.usage_id or (a.usage_id is null and u.job_id=a.job_id and u.lease_token=a.lease_token and u.provider=a.provider))
left join public.generation_steps s on s.job_id=j.id and s.workspace_id=a.workspace_id
left join public.generation_plans p on p.id=coalesce(s.plan_id,case when j.type<>'model_probe' then j.entity_id end) and p.workspace_id=a.workspace_id
left join public.opportunities o on o.id=p.opportunity_id and o.workspace_id=a.workspace_id;
grant select on public.model_activity to authenticated,service_role;

alter function public.prepare_model_routing(uuid,uuid,jsonb) rename to prepare_model_routing_before_activity;
revoke all on function public.prepare_model_routing_before_activity(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.prepare_model_routing(job_id uuid,lease uuid,server_models jsonb) returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs; check_row jsonb; target text;
begin
 perform public.prepare_model_routing_before_activity(job_id,lease,server_models);
 select * into j from public.jobs where id=job_id;
 target:=case when j.type='model_probe' then j.checkpoint->>'probe_provider' end;
 if target is not null then
  update public.jobs set checkpoint=jsonb_set(jsonb_set(checkpoint,'{model_routing,providers}',(select coalesce(jsonb_agg(e),'[]') from jsonb_array_elements(checkpoint->'model_routing'->'providers') e where e->>'provider'=target)),'{model_routing,checks}',(select coalesce(jsonb_agg(e),'[]') from jsonb_array_elements(checkpoint->'model_routing'->'checks') e where e->>'provider'=target)) where id=j.id returning * into j;
 end if;
 for check_row in select e from jsonb_array_elements(coalesce(j.checkpoint->'model_routing'->'checks','[]')) e where e->>'sent'='false' loop
  insert into public.model_attempts(workspace_id,job_id,lease_token,provider,model,project_ref,operation,round_number,worker_attempt,status,result_code,finished_at)
  values(j.workspace_id,j.id,lease,check_row->>'provider',coalesce(check_row->>'model',''),coalesce(check_row->>'project_ref',''),case when j.type='model_probe' then 'connection_probe' else j.type end,coalesce((j.checkpoint->'model_routing'->>'round_attempts')::int,j.attempts),j.attempts,'skipped',check_row->>'code',clock_timestamp()) on conflict on constraint model_attempts_job_lease_provider_key do nothing;
 end loop;
end $$;
revoke all on function public.prepare_model_routing(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_model_routing(uuid,uuid,jsonb) to service_role;

create or replace function app_private.model_policy_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid:=auth.uid();r text;body_hash text;replay app_private.idempotency_records;result jsonb;settings public.model_settings;content jsonb;usage public.provider_usage;target uuid;rank smallint;routing_config public.model_routing;
begin
 if operation not in ('model.configure','model.probe','model.routing','content.authorize','content.revoke','usage.resolve') then return app_private.collection_command(operation,input,idempotency_key);end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;r:=app_private.member_role(w);if r is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(input)>1048576 then raise exception 'INVALID_INPUT';end if;
 body_hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then if replay.body_hash<>body_hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 target:=(input->>'id')::uuid;
 case operation
 when 'model.routing' then
  perform app_private.check_keys(input,array['enabled','expected_revision','free_providers','provider_order','strategy']);
  if coalesce(input->>'enabled','') not in ('true','false') or coalesce((input->>'expected_revision')::int,-1)<0 then raise exception 'INVALID_INPUT';end if;
  if input ? 'free_providers' and (jsonb_typeof(input->'free_providers') is distinct from 'array' or jsonb_array_length(input->'free_providers')>5 or exists(select 1 from jsonb_array_elements_text(input->'free_providers') p where p is null or not p=any(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free']::text[]))) then raise exception 'INVALID_INPUT';end if;
  if input ? 'strategy' and coalesce(input->>'strategy','') not in ('priority','round_robin') then raise exception 'INVALID_INPUT';end if;
  if input ? 'provider_order' and (jsonb_typeof(input->'provider_order') is distinct from 'array' or jsonb_array_length(input->'provider_order')<>5 or not (input->'provider_order' @> to_jsonb(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free']::text[])) or not (to_jsonb(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free']::text[]) @> (input->'provider_order'))) then raise exception 'INVALID_INPUT';end if;
  select * into routing_config from public.model_routing where workspace_id=w;
  if coalesce(routing_config.revision,0) is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  insert into public.model_routing(workspace_id,enabled,created_by,free_providers,provider_order,strategy) values(w,(input->>'enabled')::boolean,actor,case when input ? 'free_providers' then array(select jsonb_array_elements_text(input->'free_providers')) else coalesce(routing_config.free_providers,'{}'::text[]) end,case when input ? 'provider_order' then array(select jsonb_array_elements_text(input->'provider_order')) else coalesce(routing_config.provider_order,array['gemini_free','qwen_free','mistral_free','groq_free','zai_free']::text[]) end,coalesce(input->>'strategy',routing_config.strategy,'priority'))
  on conflict(workspace_id) do update set enabled=excluded.enabled,free_providers=excluded.free_providers,provider_order=excluded.provider_order,strategy=excluded.strategy,next_position=case when model_routing.provider_order is distinct from excluded.provider_order or model_routing.strategy is distinct from excluded.strategy then 0 else model_routing.next_position end,created_by=actor,revision=model_routing.revision+1,updated_at=now() returning to_jsonb(model_routing.*) into result;
 when 'model.configure' then
  perform app_private.check_keys(input,array['expected_revision','enabled','provider','model','project_ref','free_only','billing_verified','free_quota_only','quota_ends_at','quota_remaining_tokens','calls_per_day','input_per_day','output_per_day','failover_rank','quota_mode']);
  select * into settings from public.model_settings where workspace_id=w and provider=(input->>'provider') for update;
  if coalesce(settings.revision,0) is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  if coalesce(input->>'quota_mode','verified_budget')='verified_budget' and (input->>'quota_ends_at')::timestamptz<=now() and (input->>'enabled')::boolean then raise exception 'PROVIDER_QUOTA_EXPIRED';end if;
  rank:=coalesce((input->>'failover_rank')::smallint,case input->>'provider'
   when 'gemini_free' then 1 when 'qwen_free' then 2 when 'groq_free' then 3
   when 'mistral_free' then 4 when 'cloudflare_free' then 5 when 'zai_free' then 6 else 1 end);
  insert into public.model_settings(workspace_id,enabled,provider,model,project_ref,free_only,billing_verified,free_quota_only,verified_at,quota_ends_at,quota_remaining_tokens,calls_per_day,input_per_day,output_per_day,failover_rank,quota_mode,created_by)
  values(w,(input->>'enabled')::boolean,input->>'provider',input->>'model',input->>'project_ref',(input->>'free_only')::boolean,(input->>'billing_verified')::boolean,(input->>'free_quota_only')::boolean,now(),(input->>'quota_ends_at')::timestamptz,(input->>'quota_remaining_tokens')::bigint,(input->>'calls_per_day')::int,(input->>'input_per_day')::bigint,(input->>'output_per_day')::bigint,rank,coalesce(input->>'quota_mode','verified_budget'),actor)
  on conflict(workspace_id,provider) do update set enabled=excluded.enabled,model=excluded.model,project_ref=excluded.project_ref,free_only=excluded.free_only,billing_verified=excluded.billing_verified,free_quota_only=excluded.free_quota_only,verified_at=now(),quota_ends_at=excluded.quota_ends_at,quota_remaining_tokens=excluded.quota_remaining_tokens,calls_per_day=excluded.calls_per_day,input_per_day=excluded.input_per_day,output_per_day=excluded.output_per_day,failover_rank=excluded.failover_rank,quota_mode=excluded.quota_mode,revision=model_settings.revision+1,updated_at=now() returning to_jsonb(model_settings.*) into result;
 when 'model.probe' then
  perform app_private.check_keys(input,array['provider']);
  if input ? 'provider' and (coalesce(input->>'provider','') not in ('gemini_free','qwen_free','mistral_free','groq_free','zai_free') or not exists(select 1 from public.model_routing where workspace_id=w and enabled)) then raise exception 'INVALID_INPUT';end if;
  if not exists(select 1 from public.model_settings where workspace_id=w and provider='gemini_free' and enabled) and not exists(select 1 from public.model_routing where workspace_id=w and enabled) then raise exception 'MODEL_NOT_CONFIGURED'; end if;
  select to_jsonb(j) into result from public.jobs j where j.workspace_id=w and j.type='model_probe' and (j.checkpoint->>'probe_provider') is not distinct from (input->>'provider') and j.status in ('queued','running','retry_wait','quota_wait') order by j.created_at limit 1;
  if result is null then
   if (select count(*) from public.jobs where workspace_id=w and status in ('queued','running','retry_wait','quota_wait','blocked'))>=500 then raise exception 'JOB_CAP_REACHED'; end if;
   insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint)
    values(w,'model_probe',w,encode(sha256(convert_to('tenderdesk-connection-probe-v1','UTF8')),'hex'),'queued',actor,jsonb_strip_nulls(jsonb_build_object('probe_provider',input->>'provider')))
    returning to_jsonb(jobs.*) into result;
  end if;
 when 'content.authorize' then
  perform app_private.check_keys(input,array['entity_kind','entity_id','content_hash','provider','attestation']);
  content:=app_private.content_record(w,input->>'entity_kind',(input->>'entity_id')::uuid);
  if content->>'content_hash'<>input->>'content_hash' then raise exception 'STALE_INPUT';end if;
  if content->>'content' ~* '(confidential|strictly private|سري للغاية|سرية|password[[:space:]]*[:=]|api[_ -]?key[[:space:]]*[:=]|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|-----BEGIN .*PRIVATE KEY)' then raise exception 'DATA_POLICY_BLOCKED';end if;
  insert into public.content_authorizations(workspace_id,entity_kind,entity_id,content_hash,provider,attestation,created_by) values(w,input->>'entity_kind',(input->>'entity_id')::uuid,input->>'content_hash',input->>'provider',input->>'attestation',actor)
  on conflict(workspace_id,entity_kind,entity_id,content_hash,provider) do update set revoked_at=null,authorization_basis='explicit',created_by=actor,created_at=now(),revision=content_authorizations.revision+1 returning to_jsonb(content_authorizations.*) into result;
 when 'content.revoke' then
  perform app_private.check_keys(input,array['id','expected_revision']);
  update public.content_authorizations set revoked_at=now(),revision=revision+1 where workspace_id=w and id=target and revision=(input->>'expected_revision')::int returning to_jsonb(content_authorizations.*) into result;if result is null then raise exception 'REVISION_CONFLICT';end if;
 when 'usage.resolve' then
  perform app_private.check_keys(input,array['id','expected_revision','actual_input','actual_output','thinking_tokens','reason']);
  if length(trim(coalesce(input->>'reason','')))<10 then raise exception 'PROVIDER_USAGE_EVIDENCE_REQUIRED';end if;
  select * into usage from public.provider_usage where workspace_id=w and id=target for update;
  if usage.id is null or usage.revision is distinct from (input->>'expected_revision')::int or usage.state<>'unknown' then raise exception 'REVISION_CONFLICT';end if;
  if (input->>'actual_input')::bigint>usage.reserved_input or (input->>'actual_output')::bigint>usage.reserved_output then
   update public.model_settings set enabled=false,revision=revision+1,updated_at=now() where workspace_id=w and provider=usage.provider;
  end if;
  update public.provider_usage set actual_input=(input->>'actual_input')::bigint,actual_output=(input->>'actual_output')::bigint,thinking_tokens=(input->>'thinking_tokens')::bigint,state='settled',error_code='OWNER_USAGE_RECONCILIATION',revision=revision+1,updated_at=now() where id=target returning to_jsonb(provider_usage.*) into result;
 end case;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id) values(w,actor,operation,coalesce(target,(result->>'id')::uuid),coalesce(input->>'reason',''),gen_random_uuid());
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,body_hash,result);return result;
end $$;



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
 'queued_jobs',(select count(*) from public.jobs where workspace_id=w and status='queued'),'blocked_jobs',(select count(*) from public.jobs where workspace_id=w and status='blocked'),
 'running_jobs',(select count(*) from public.jobs where workspace_id=w and status='running'),
 'retry_wait_jobs',(select count(*) from public.jobs where workspace_id=w and status='retry_wait'),
 'quota_wait_jobs',(select count(*) from public.jobs where workspace_id=w and status='quota_wait'),
 'job_wait_reasons',(select coalesce(jsonb_agg(x),'[]') from(select status,error_code,count(*) count,min(next_attempt_at) filter(where isfinite(next_attempt_at)) next_attempt_at from public.jobs where workspace_id=w and status in ('blocked','retry_wait','quota_wait') group by status,error_code order by status,error_code) x),
 'estimated_usage_records',(select count(*) from public.provider_usage where workspace_id=w and application_day=day and (actual_input is null or actual_output is null)),
 'model_enabled',(exists(select 1 from public.model_settings where workspace_id=w and enabled) or exists(select 1 from public.model_routing where workspace_id=w and enabled)),'usage_day',day,'usage_timezone','Asia/Riyadh',
 'calls_today',(select count(*) from public.provider_usage where workspace_id=w and application_day=day),
 'input_tokens_today',(select coalesce(sum(coalesce(actual_input,reserved_input)),0)::text from public.provider_usage where workspace_id=w and application_day=day),
 'output_tokens_today',(select coalesce(sum(coalesce(actual_output,reserved_output)),0)::text from public.provider_usage where workspace_id=w and application_day=day),
 'unknown_usage',(select count(*) from public.provider_usage where workspace_id=w and state='unknown'));
end $$;
revoke all on function public.workspace_status() from public,anon;
grant execute on function public.workspace_status() to authenticated;
