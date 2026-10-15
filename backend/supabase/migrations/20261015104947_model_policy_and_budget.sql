create table public.model_settings (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null unique references public.workspaces(id),enabled boolean not null default false,
 provider text not null check(provider in ('gemini_free','qwen_free')),model text not null check(model~'^[a-zA-Z0-9._-]{1,120}$'),project_ref text not null check(length(project_ref) between 1 and 120),
 free_only boolean not null check(free_only),billing_verified boolean not null,free_quota_only boolean not null default false,
 verified_at timestamptz not null,quota_ends_at timestamptz not null,quota_remaining_tokens bigint not null check(quota_remaining_tokens>0),
 calls_per_day integer not null check(calls_per_day between 1 and 50),input_per_day bigint not null check(input_per_day between 1000 and 250000),output_per_day bigint not null check(output_per_day between 1000 and 50000),
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
 check(not enabled or (billing_verified and (provider<>'qwen_free' or free_quota_only)))
);
create table public.content_authorizations (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),entity_kind text not null check(entity_kind in ('document','knowledge','notice','review','rate')),
 entity_id uuid not null,content_hash text not null check(content_hash~'^[0-9a-f]{64}$'),provider text not null check(provider in ('gemini_free','qwen_free')),attestation text not null check(attestation='nonconfidential_nonpersonal'),
 revoked_at timestamptz,created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),revision integer not null default 1,
 unique(workspace_id,entity_kind,entity_id,content_hash,provider)
);
create table public.provider_usage (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),job_id uuid not null,lease_token uuid not null,call_key text not null,
 provider text not null,model text not null,input_hash text not null,application_day date not null,settings_revision integer not null,
 reserved_input bigint not null check(reserved_input between 1 and 20000),reserved_output bigint not null check(reserved_output between 1 and 8192),
 actual_input bigint check(actual_input>=0),actual_output bigint check(actual_output>=0),thinking_tokens bigint check(thinking_tokens>=0),
 state text not null default 'reserved' check(state in ('reserved','settled','unknown')),error_code text,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
 unique(workspace_id,id),unique(workspace_id,job_id,call_key),foreign key(workspace_id,job_id) references public.jobs(workspace_id,id)
);
create index usage_day on public.provider_usage(workspace_id,application_day,created_at);
create index content_eligibility on public.content_authorizations(workspace_id,entity_kind,entity_id,content_hash,provider) where revoked_at is null;
do $$ declare t text;begin foreach t in array array['model_settings','content_authorizations','provider_usage'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);execute format('grant all on public.%I to service_role',t);execute format('create policy member_read on public.%I for select to authenticated using(app_private.member_role(workspace_id) is not null)',t);
end loop;end $$;

create function app_private.content_record(w uuid,kind text,entity uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare content text;title text;hash text;
begin
 case kind
 when 'document' then select original_name,extracted_text,extraction_hash into title,content,hash from public.documents where workspace_id=w and id=entity and status='ready' and not archived;
 when 'knowledge' then select k.title,k.title||E'\n'||k.content,encode(sha256(convert_to(k.title||E'\n'||k.content,'UTF8')),'hex') into title,content,hash from public.knowledge_items k where workspace_id=w and id=entity and enabled;
 when 'notice' then select o.title,o.title||E'\n'||o.description||E'\n'||o.buyer||E'\n'||o.reference into title,content from public.opportunities o where workspace_id=w and id=entity;
 when 'review' then select 'Review: '||target_id,body into title,content from public.review_inputs where workspace_id=w and id=entity;
 when 'rate' then if to_regclass('public.rate_catalog') is not null then execute 'select title, source, content_hash from public.rate_catalog where workspace_id=$1 and id=$2' into title,content,hash using w,entity;end if;
 else raise exception 'INVALID_CONTENT_KIND';end case;
 if title is null or content is null then raise exception 'NOT_FOUND';end if;
 return jsonb_build_object('entity_kind',kind,'entity_id',entity,'title',title,'content',content,'content_hash',coalesce(hash,encode(sha256(convert_to(content,'UTF8')),'hex')));
end $$;
revoke all on function app_private.content_record(uuid,text,uuid) from public,anon,authenticated;
create function public.eligibility_candidates(opportunity uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;items jsonb:='[]';rec record;
begin
 select m.workspace_id into w from public.memberships m where m.user_id=auth.uid() and app_private.member_role(m.workspace_id) is not null limit 1;if w is null then raise exception 'ACCESS_PENDING';end if;
 for rec in
 select 'document' kind,id from public.documents where workspace_id=w and status='ready' and not archived and (opportunity is null or opportunity_id=opportunity or documents.kind='company' or review_input_id in (select r.id from public.review_inputs r join public.proposals p on p.id=r.proposal_id where p.opportunity_id=opportunity))
 union all select 'knowledge',id from public.knowledge_items where workspace_id=w and enabled and length(content)>0
 union all select 'notice',id from public.opportunities where workspace_id=w and (opportunity is null or id=opportunity)
 union all select 'review',r.id from public.review_inputs r join public.proposals p on p.id=r.proposal_id where r.workspace_id=w and length(r.body)>0 and (opportunity is null or p.opportunity_id=opportunity)
 loop items:=items||jsonb_build_array(app_private.content_record(w,rec.kind,rec.id));end loop;
 return jsonb_build_object('items',items,'authorizations',(select coalesce(jsonb_agg(to_jsonb(a)),'[]') from public.content_authorizations a where workspace_id=w and revoked_at is null));
end $$;
revoke all on function public.eligibility_candidates(uuid) from public,anon;grant execute on function public.eligibility_candidates(uuid) to authenticated;

alter function app_private.app_command(text,jsonb,text) rename to collection_command;
revoke all on function app_private.collection_command(text,jsonb,text) from public,anon,authenticated,service_role;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid:=auth.uid();r text;body_hash text;replay app_private.idempotency_records;result jsonb;settings public.model_settings;content jsonb;usage public.provider_usage;target uuid;
begin
 if operation not in ('model.configure','content.authorize','content.revoke','usage.resolve') then return app_private.collection_command(operation,input,idempotency_key);end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;r:=app_private.member_role(w);if r is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(input)>1048576 then raise exception 'INVALID_INPUT';end if;
 body_hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then if replay.body_hash<>body_hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 target:=(input->>'id')::uuid;
 case operation
 when 'model.configure' then
  perform app_private.check_keys(input,array['expected_revision','enabled','provider','model','project_ref','free_only','billing_verified','free_quota_only','quota_ends_at','quota_remaining_tokens','calls_per_day','input_per_day','output_per_day']);
  select * into settings from public.model_settings where workspace_id=w for update;
  if coalesce(settings.revision,0) is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  if (input->>'quota_ends_at')::timestamptz<=now() and (input->>'enabled')::boolean then raise exception 'PROVIDER_QUOTA_EXPIRED';end if;
  insert into public.model_settings(workspace_id,enabled,provider,model,project_ref,free_only,billing_verified,free_quota_only,verified_at,quota_ends_at,quota_remaining_tokens,calls_per_day,input_per_day,output_per_day,created_by)
  values(w,(input->>'enabled')::boolean,input->>'provider',input->>'model',input->>'project_ref',(input->>'free_only')::boolean,(input->>'billing_verified')::boolean,(input->>'free_quota_only')::boolean,now(),(input->>'quota_ends_at')::timestamptz,(input->>'quota_remaining_tokens')::bigint,(input->>'calls_per_day')::int,(input->>'input_per_day')::bigint,(input->>'output_per_day')::bigint,actor)
  on conflict(workspace_id) do update set enabled=excluded.enabled,provider=excluded.provider,model=excluded.model,project_ref=excluded.project_ref,free_only=excluded.free_only,billing_verified=excluded.billing_verified,free_quota_only=excluded.free_quota_only,verified_at=now(),quota_ends_at=excluded.quota_ends_at,quota_remaining_tokens=excluded.quota_remaining_tokens,calls_per_day=excluded.calls_per_day,input_per_day=excluded.input_per_day,output_per_day=excluded.output_per_day,revision=model_settings.revision+1,updated_at=now() returning to_jsonb(model_settings.*) into result;
 when 'content.authorize' then
  perform app_private.check_keys(input,array['entity_kind','entity_id','content_hash','provider','attestation']);
  content:=app_private.content_record(w,input->>'entity_kind',(input->>'entity_id')::uuid);
  if content->>'content_hash'<>input->>'content_hash' then raise exception 'STALE_INPUT';end if;
  -- Detector assists review; it does not certify absence of personal or confidential content.
  if content->>'content' ~* '(confidential|strictly private|سري للغاية|سرية|password[[:space:]]*[:=]|api[_ -]?key[[:space:]]*[:=]|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|-----BEGIN .*PRIVATE KEY)' then raise exception 'DATA_POLICY_BLOCKED';end if;
  insert into public.content_authorizations(workspace_id,entity_kind,entity_id,content_hash,provider,attestation,created_by) values(w,input->>'entity_kind',(input->>'entity_id')::uuid,input->>'content_hash',input->>'provider',input->>'attestation',actor)
  on conflict(workspace_id,entity_kind,entity_id,content_hash,provider) do update set revoked_at=null,created_by=actor,created_at=now(),revision=content_authorizations.revision+1 returning to_jsonb(content_authorizations.*) into result;
 when 'content.revoke' then
  perform app_private.check_keys(input,array['id','expected_revision']);
  update public.content_authorizations set revoked_at=now(),revision=revision+1 where workspace_id=w and id=target and revision=(input->>'expected_revision')::int returning to_jsonb(content_authorizations.*) into result;if result is null then raise exception 'REVISION_CONFLICT';end if;
 when 'usage.resolve' then
  perform app_private.check_keys(input,array['id','expected_revision','actual_input','actual_output','thinking_tokens','reason']);
  if length(trim(coalesce(input->>'reason','')))<10 then raise exception 'PROVIDER_USAGE_EVIDENCE_REQUIRED';end if;
  select * into usage from public.provider_usage where workspace_id=w and id=target for update;
  if usage.id is null or usage.revision is distinct from (input->>'expected_revision')::int or usage.state<>'unknown' then raise exception 'REVISION_CONFLICT';end if;
  if (input->>'actual_input')::bigint>usage.reserved_input or (input->>'actual_output')::bigint>usage.reserved_output then update public.model_settings set enabled=false,revision=revision+1,updated_at=now() where workspace_id=w;end if;
  update public.provider_usage set actual_input=(input->>'actual_input')::bigint,actual_output=(input->>'actual_output')::bigint,thinking_tokens=(input->>'thinking_tokens')::bigint,state='settled',error_code='OWNER_USAGE_RECONCILIATION',revision=revision+1,updated_at=now() where id=target returning to_jsonb(provider_usage.*) into result;
 end case;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id) values(w,actor,operation,coalesce(target,(result->>'id')::uuid),coalesce(input->>'reason',''),gen_random_uuid());
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,body_hash,result);return result;
end $$;
revoke all on function app_private.app_command(text,jsonb,text) from public,anon;grant execute on function app_private.app_command(text,jsonb,text) to authenticated;

create function app_private.check_model_payload(w uuid,provider text,manifest jsonb) returns void language plpgsql security definer set search_path='' as $$
declare ref jsonb;content jsonb;
begin
 if jsonb_typeof(manifest)<>'array' or jsonb_array_length(manifest) not between 1 and 300 then raise exception 'DATA_AUTHORIZATION_REQUIRED';end if;
 for ref in select value from jsonb_array_elements(manifest) loop
  content:=app_private.content_record(w,ref->>'entity_kind',(ref->>'entity_id')::uuid);
  if content->>'content_hash'<>ref->>'content_hash' then raise exception 'STALE_INPUT';end if;
  if not exists(select 1 from public.content_authorizations a where a.workspace_id=w and a.entity_kind=ref->>'entity_kind' and a.entity_id=(ref->>'entity_id')::uuid and a.content_hash=ref->>'content_hash' and a.provider=check_model_payload.provider and a.revoked_at is null) then raise exception 'DATA_AUTHORIZATION_REQUIRED';end if;
 end loop;
end $$;
revoke all on function app_private.check_model_payload(uuid,text,jsonb) from public,anon,authenticated;
create function public.model_preflight(job_id uuid,lease uuid,manifest jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;m public.model_settings;
begin
 select * into j from public.jobs where id=job_id;if j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 select * into m from public.model_settings where workspace_id=j.workspace_id;
 if m.id is null or not m.enabled then raise exception 'MODEL_NOT_CONFIGURED';end if;
 if not m.free_only or not m.billing_verified or (m.provider='qwen_free' and not m.free_quota_only) then raise exception 'FREE_ONLY_REQUIRED';end if;
 if m.verified_at<now()-interval '30 days' or m.quota_ends_at<=now() then raise exception 'PROVIDER_VERIFICATION_EXPIRED';end if;
 perform app_private.check_model_payload(j.workspace_id,m.provider,manifest);return to_jsonb(m);
end $$;
create function public.reserve_model_call(job_id uuid,lease uuid,call_key text,input_hash text,input_tokens integer,output_tokens integer,manifest jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;m public.model_settings;w uuid;u public.provider_usage;day date:=(now() at time zone 'Asia/Riyadh')::date;calls integer;inputs bigint;outputs bigint;settings jsonb;
begin
 select workspace_id into w from public.jobs where id=job_id;perform 1 from public.workspaces where id=w for update;
 select * into j from public.jobs where id=job_id;
 perform public.model_preflight(job_id,lease,manifest);
 select * into m from public.model_settings where workspace_id=w;
 if input_tokens not between 1 and 20000 or output_tokens not between 1 and 8192 then raise exception 'MODEL_CONTEXT_TOO_LARGE';end if;
 if length(call_key) not between 1 and 200 or input_hash!~'^[0-9a-f]{64}$' then raise exception 'INVALID_INPUT';end if;
 if exists(select 1 from public.provider_usage p where p.workspace_id=w and p.job_id=reserve_model_call.job_id and p.call_key=reserve_model_call.call_key) then raise exception 'MODEL_CALL_ALREADY_RESERVED';end if;
 if exists(select 1 from public.provider_usage where workspace_id=w and state in ('reserved','unknown')) then raise exception 'USAGE_REVIEW_REQUIRED';end if;
 if exists(select 1 from public.provider_usage where workspace_id=w and created_at>now()-interval '1 minute') then raise exception 'MODEL_RATE_WAIT';end if;
 select count(*),coalesce(sum(coalesce(actual_input,reserved_input)),0),coalesce(sum(coalesce(actual_output,reserved_output)),0) into calls,inputs,outputs from public.provider_usage where workspace_id=w and application_day=day;
 select workspaces.settings into settings from public.workspaces where id=w;
 if calls>=least(m.calls_per_day,coalesce((settings->>'daily_call_limit')::int,50)) or inputs+input_tokens>least(m.input_per_day,coalesce((settings->>'input_token_limit')::int,250000)) or outputs+output_tokens>least(m.output_per_day,coalesce((settings->>'output_token_limit')::int,50000)) then raise exception 'MODEL_DAILY_QUOTA_WAIT';end if;
 if (select coalesce(sum(coalesce(actual_input,reserved_input)+coalesce(actual_output,reserved_output)),0) from public.provider_usage where workspace_id=w and provider=m.provider and model=m.model and created_at>=m.verified_at)+input_tokens+output_tokens>m.quota_remaining_tokens then raise exception 'PROVIDER_QUOTA_WAIT';end if;
 insert into public.provider_usage(workspace_id,job_id,lease_token,call_key,provider,model,input_hash,application_day,settings_revision,reserved_input,reserved_output,created_by) values(w,job_id,lease,call_key,m.provider,m.model,input_hash,day,m.revision,input_tokens,output_tokens,j.created_by) returning * into u;
 return to_jsonb(u);
end $$;
create function public.settle_model_call(reservation uuid,actual_input bigint,actual_output bigint,thinking bigint,error_code text default null) returns void language plpgsql security definer set search_path='' as $$
declare u public.provider_usage;
begin
 perform 1 from public.workspaces where id=(select workspace_id from public.provider_usage where id=reservation) for update;
 select * into u from public.provider_usage where id=reservation for update;if u.id is null then raise exception 'NOT_FOUND';end if;
 if u.state='settled' then if u.actual_input is distinct from actual_input or u.actual_output is distinct from actual_output or u.thinking_tokens is distinct from thinking then raise exception 'IDEMPOTENCY_CONFLICT';end if;return;end if;
 update public.provider_usage set actual_input=settle_model_call.actual_input,actual_output=settle_model_call.actual_output,thinking_tokens=thinking,state=case when settle_model_call.error_code in ('PROVIDER_QUOTA_WAIT','PROVIDER_REQUEST_REJECTED') then 'settled' when settle_model_call.actual_input is null or settle_model_call.actual_output is null then 'unknown' else 'settled' end,error_code=settle_model_call.error_code,revision=revision+1,updated_at=now() where id=reservation;
 if actual_input>u.reserved_input or actual_output>u.reserved_output then update public.model_settings set enabled=false,revision=revision+1 where workspace_id=u.workspace_id;end if;
end $$;
revoke all on function public.model_preflight(uuid,uuid,jsonb),public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb),public.settle_model_call(uuid,bigint,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.model_preflight(uuid,uuid,jsonb),public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb),public.settle_model_call(uuid,bigint,bigint,bigint,text) to service_role;

-- A terminated lease cannot release an uncertain provider reservation. Runs in the
-- same successful queue update, not a transaction that raises and rolls back.
create function app_private.retain_abandoned_usage() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.status='running' and (new.status<>'running' or new.lease_token is distinct from old.lease_token) then
 update public.provider_usage set state='unknown',error_code='LEASE_ENDED_WITHOUT_USAGE',revision=revision+1,updated_at=now() where job_id=old.id and lease_token=old.lease_token and state='reserved';
 end if;return new;
end $$;
revoke all on function app_private.retain_abandoned_usage() from public,anon,authenticated;
create trigger preserve_unknown_usage after update on public.jobs for each row execute function app_private.retain_abandoned_usage();
