-- Owner-confirmed account billing is operational configuration, not an API secret.
alter table public.model_routing add column free_providers text[] not null default '{}' check(free_providers <@ array['gemini_free','qwen_free','mistral_free','groq_free','zai_free']::text[] and array_position(free_providers,null) is null);
-- Distinguish continuing workspace policy from one-off exact-content approval.
alter table public.content_authorizations add column authorization_basis text not null default 'explicit' check(authorization_basis in ('explicit','company_knowledge_policy'));

create or replace function public.prepare_model_routing(job_id uuid,lease uuid,server_models jsonb) returns void language plpgsql security definer set search_path='' as $$
declare j public.jobs; route public.model_routing; slot jsonb; profile public.model_settings; entries jsonb:='[]'; checks jsonb:='[]'; ids text[]:=array['gemini_free','qwen_free','mistral_free','groq_free','zai_free']; provider_id text; pos int; start_pos int; reason text; config jsonb; resuming boolean; provider_count int;
begin
 select * into j from public.jobs where id=job_id;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 select * into route from public.model_routing where workspace_id=j.workspace_id;
 if not coalesce(route.enabled,false) then return;end if;
 if j.checkpoint->'model_routing'->>'lease' = lease::text then return;end if;
 if server_models is null or jsonb_typeof(server_models)<>'array' or jsonb_array_length(server_models) not in (4,5) or pg_column_size(server_models)>8192 then raise exception 'INVALID_INPUT';end if;
 -- Accept the previous four-slot worker during a rolling deployment.
 if jsonb_array_length(server_models)=4 then ids:=ids[1:4];end if;
 provider_count:=array_length(ids,1);
 if (select count(distinct s->>'provider') from jsonb_array_elements(server_models) s where s->>'provider'=any(ids))<>provider_count then raise exception 'INVALID_INPUT';end if;
 resuming:=exists(select 1 from public.provider_usage u where u.job_id=j.id and u.state='reserved' and u.remote_request_id is not null);
 start_pos:=case when resuming then coalesce((j.checkpoint->'model_routing'->>'start_position')::int,((j.checkpoint->'model_routing'->>'next_start')::int+3)%4,route.next_position) else route.next_position end % provider_count;
 if start_pos not between 0 and provider_count-1 then raise exception 'INVALID_INPUT';end if;
 if not resuming then update public.model_routing set next_position=(start_pos+1)%provider_count where workspace_id=j.workspace_id;end if;
 for pos in 0..provider_count-1 loop
  provider_id:=ids[((start_pos+pos)%provider_count)+1];
  select value into slot from jsonb_array_elements(server_models) where value->>'provider'=provider_id;
  perform app_private.check_keys(slot,array['provider','model','project_ref','key_configured','free_tier_confirmed']);
  select * into profile from public.model_settings where workspace_id=j.workspace_id and provider=provider_id;
  reason:=null;
  if slot->>'key_configured' is distinct from 'true' or coalesce(slot->>'model','') !~ '^[a-zA-Z0-9._@/-]{1,120}$' or length(coalesce(slot->>'project_ref','')) not between 1 and 120 then reason:='MODEL_NOT_CONFIGURED';
  elsif not (provider_id=any(route.free_providers) or coalesce((slot->>'free_tier_confirmed')::boolean,false) or (coalesce(profile.billing_verified,false) and profile.free_only and (provider_id<>'qwen_free' or profile.free_quota_only))) then reason:='FREE_ONLY_REQUIRED';
  elsif profile.id is not null and profile.project_ref<>slot->>'project_ref' then reason:='MODEL_IDENTITY_CHANGED';
  elsif exists(select 1 from public.provider_usage u where u.workspace_id=j.workspace_id and u.provider=provider_id and (u.actual_input>u.reserved_input or u.actual_output>u.reserved_output) and u.created_at>=coalesce(profile.verified_at,route.updated_at)) then reason:='MODEL_BUDGET_EXCEEDED';
  end if;
  if reason is not null then checks:=checks||jsonb_build_array(jsonb_build_object('provider',provider_id,'code',reason,'sent',false,'model',slot->>'model','project_ref',slot->>'project_ref','key_configured',slot->'key_configured'));continue;end if;
  config:=jsonb_build_object('enabled',true,'automatic',true,'provider',provider_id,'model',slot->>'model','project_ref',slot->>'project_ref','free_only',true,'billing_verified',(coalesce(profile.billing_verified,false) or provider_id=any(route.free_providers)),'free_quota_only',provider_id='qwen_free','verified_at',coalesce(profile.verified_at,route.updated_at),'quota_mode','provider_managed','quota_ends_at',null,'quota_remaining_tokens',null,'revision',coalesce(profile.revision,route.revision),'calls_per_day',coalesce(profile.calls_per_day,50),'input_per_day',coalesce(profile.input_per_day,250000),'output_per_day',coalesce(profile.output_per_day,50000));
  entries:=entries||jsonb_build_array(config);
 end loop;
 update public.jobs set checkpoint=checkpoint||jsonb_build_object('model_routing',jsonb_build_object('lease',lease,'mode','round_robin','start_position',start_pos,'provider_count',provider_count,'next_start',(start_pos+1)%provider_count,'providers',entries,'checks',checks)),revision=revision+1,updated_at=now() where id=j.id;
end $$;

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
  perform app_private.check_keys(input,array['enabled','expected_revision','free_providers']);
  if coalesce(input->>'enabled','') not in ('true','false') or coalesce((input->>'expected_revision')::int,-1)<0 then raise exception 'INVALID_INPUT';end if;
  if input ? 'free_providers' and (jsonb_typeof(input->'free_providers') is distinct from 'array' or jsonb_array_length(input->'free_providers')>5 or exists(select 1 from jsonb_array_elements_text(input->'free_providers') p where p is null or not p=any(array['gemini_free','qwen_free','mistral_free','groq_free','zai_free']::text[]))) then raise exception 'INVALID_INPUT';end if;
  select * into routing_config from public.model_routing where workspace_id=w;
  if coalesce(routing_config.revision,0) is distinct from (input->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
  insert into public.model_routing(workspace_id,enabled,created_by,free_providers) values(w,(input->>'enabled')::boolean,actor,case when input ? 'free_providers' then array(select jsonb_array_elements_text(input->'free_providers')) else coalesce(routing_config.free_providers,'{}'::text[]) end)
  on conflict(workspace_id) do update set enabled=excluded.enabled,free_providers=excluded.free_providers,created_by=actor,revision=model_routing.revision+1,updated_at=now() returning to_jsonb(model_routing.*) into result;
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
  perform app_private.check_keys(input,array[]::text[]);
  if not exists(select 1 from public.model_settings where workspace_id=w and provider='gemini_free' and enabled) and not exists(select 1 from public.model_routing where workspace_id=w and enabled) then raise exception 'MODEL_NOT_CONFIGURED'; end if;
  select to_jsonb(j) into result from public.jobs j where j.workspace_id=w and j.type='model_probe' and j.status in ('queued','running','retry_wait','quota_wait') order by j.created_at limit 1;
  if result is null then
   if (select count(*) from public.jobs where workspace_id=w and status in ('queued','running','retry_wait','quota_wait','blocked'))>=500 then raise exception 'JOB_CAP_REACHED'; end if;
   insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by)
    values(w,'model_probe',w,encode(sha256(convert_to('tenderdesk-connection-probe-v1','UTF8')),'hex'),'queued',actor)
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

create or replace function app_private.pause_restored_model_routing() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state='committed' and old.state is distinct from new.state then update public.model_routing set enabled=false,free_providers='{}',revision=revision+1,updated_at=now() where workspace_id=new.workspace_id;end if;
 return new;
end $$;

create or replace function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid:=auth.uid();body_hash text;replay app_private.idempotency_records;result jsonb;policy jsonb;scope_changed boolean;
begin
 if operation<>'discovery.configure' then
  result:=app_private.discovery_previous_command(operation,input,idempotency_key);
  if operation='content.authorize' then
   update public.opportunities o set assessment_pending=true where o.workspace_id=(result->>'workspace_id')::uuid and not o.archived
    and (input->>'entity_kind'='knowledge' or (input->>'entity_kind'='notice' and o.id=(input->>'entity_id')::uuid))
    and exists(select 1 from public.generation_plans p where p.opportunity_id=o.id and p.kind='assessment' and p.status='blocked' and p.error_code='DATA_AUTHORIZATION_REQUIRED');
  end if;return result;
 end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;
 if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;
 if app_private.member_role(w) is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 if exists(select 1 from public.restore_sessions where workspace_id=w and state='staging') then raise exception 'RESTORE_IN_PROGRESS';end if;
 perform app_private.check_keys(input,array['expected_revision','scope','auto_public_notices','providers','auto_company_knowledge']);
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(input)>4096
  or coalesce(input->>'scope','') not in ('all','software_services') or coalesce(input->>'auto_public_notices','') not in ('true','false')
  or jsonb_typeof(input->'providers') is distinct from 'array' then raise exception 'INVALID_INPUT';end if;
 if input ? 'auto_company_knowledge' and coalesce(input->>'auto_company_knowledge','') not in ('true','false') then raise exception 'INVALID_INPUT';end if;
 if jsonb_array_length(input->'providers')>6 or exists(select 1 from jsonb_array_elements_text(input->'providers') p where p not in ('gemini_free','qwen_free','mistral_free','groq_free','cloudflare_free','zai_free'))
  or ((input->>'auto_public_notices')::boolean or coalesce((input->>'auto_company_knowledge')::boolean,false)) and jsonb_array_length(input->'providers')=0 then raise exception 'INVALID_INPUT';end if;
 body_hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then if replay.body_hash<>body_hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 select discovery_policy->>'scope' is distinct from input->>'scope' into scope_changed from public.workspaces where id=w;
 policy:=(input-'expected_revision')||jsonb_build_object('auto_company_knowledge',coalesce(input->'auto_company_knowledge',(select discovery_policy->'auto_company_knowledge' from public.workspaces where id=w),'false'::jsonb),'approved_by',actor,'approved_at',now());
 update public.workspaces set discovery_policy=policy,evidence_revision=evidence_revision+case when scope_changed then 1 else 0 end,revision=revision+1,updated_at=now() where id=w and revision=(input->>'expected_revision')::int returning to_jsonb(workspaces.*) into result;
 if result is null then raise exception 'REVISION_CONFLICT';end if;
 update public.opportunities o set assessment_pending=true where workspace_id=w and not archived and (scope_changed or exists(select 1 from public.generation_plans p where p.opportunity_id=o.id and p.kind='assessment' and p.status='blocked' and p.error_code='DATA_AUTHORIZATION_REQUIRED'));
 update public.approvals set invalidated_at=coalesce(invalidated_at,now()) where workspace_id=w and scope_changed;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id) values(w,actor,operation,w,policy::text,gen_random_uuid());
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,body_hash,result);
 return result;
end $$;

create function app_private.authorize_company_knowledge(w uuid,ref jsonb,provider text) returns boolean language plpgsql security definer set search_path='' as $$
declare policy jsonb; actor uuid; content jsonb; eligible boolean:=false;
begin
 select discovery_policy into policy from public.workspaces where id=w;
 actor:=(policy->>'approved_by')::uuid;
 if ref->>'entity_kind' not in ('knowledge','document') or policy->'auto_company_knowledge' is distinct from 'true'::jsonb or not (policy->'providers' ? provider) or actor is null then return false;end if;
 if not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=w and m.user_id=actor and m.active and m.role='Owner' and a.status='active') then return false;end if;
 if exists(select 1 from public.content_authorizations a where a.workspace_id=w and a.entity_kind=ref->>'entity_kind' and a.entity_id=(ref->>'entity_id')::uuid and a.content_hash=ref->>'content_hash' and a.provider=authorize_company_knowledge.provider and a.revoked_at is not null) then return false;end if;
 if ref->>'entity_kind'='knowledge' then
  select exists(select 1 from public.knowledge_items k where k.workspace_id=w and k.id=(ref->>'entity_id')::uuid and k.enabled and k.verified_at is not null and (k.expiry_date is null or k.expiry_date>=current_date) and k.category not in ('previous_proposal','template','rate')) into eligible;
 else
  select exists(select 1 from public.documents d join public.knowledge_items k on k.id=d.knowledge_item_id and k.workspace_id=d.workspace_id where d.workspace_id=w and d.id=(ref->>'entity_id')::uuid and d.kind='company' and d.status='ready' and not d.archived and k.enabled and k.verified_at is not null and (k.expiry_date is null or k.expiry_date>=current_date) and k.category not in ('previous_proposal','template','rate')) into eligible;
 end if;
 if not eligible then return false;end if;
 content:=app_private.content_record(w,ref->>'entity_kind',(ref->>'entity_id')::uuid);
 if content->>'content_hash' is distinct from ref->>'content_hash' then raise exception 'STALE_INPUT';end if;
 perform app_private.assert_business_content(content->>'content');
 insert into public.content_authorizations(workspace_id,entity_kind,entity_id,content_hash,provider,attestation,created_by,authorization_basis)
 values(w,ref->>'entity_kind',(ref->>'entity_id')::uuid,ref->>'content_hash',provider,'nonconfidential_nonpersonal',actor,'company_knowledge_policy') on conflict do nothing;
 if found then insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id) values(w,actor,'knowledge.authorize_by_policy',(ref->>'entity_id')::uuid,'Enabled verified Company Knowledge; exact hash; provider '||provider,gen_random_uuid());end if;
 return true;
end $$;
revoke all on function app_private.authorize_company_knowledge(uuid,jsonb,text) from public,anon,authenticated,service_role;

create or replace function app_private.check_model_payload(w uuid,provider text,manifest jsonb) returns void language plpgsql security definer set search_path='' as $$
declare ref jsonb;content jsonb;company_allowed boolean;
begin
 if jsonb_typeof(manifest) is distinct from 'array' or jsonb_array_length(manifest) not between 1 and 300 then raise exception 'DATA_AUTHORIZATION_REQUIRED';end if;
 for ref in select value from jsonb_array_elements(manifest) loop
  content:=app_private.content_record(w,ref->>'entity_kind',(ref->>'entity_id')::uuid);
  if content->>'content_hash' is distinct from ref->>'content_hash' then raise exception 'STALE_INPUT';end if;
  perform app_private.authorize_public_notice(w,ref,provider);
  company_allowed:=app_private.authorize_company_knowledge(w,ref,provider);
  if not exists(select 1 from public.content_authorizations a where a.workspace_id=w and a.entity_kind=ref->>'entity_kind' and a.entity_id=(ref->>'entity_id')::uuid and a.content_hash=ref->>'content_hash' and a.provider=check_model_payload.provider and a.revoked_at is null and (a.authorization_basis='explicit' or company_allowed)) then raise exception 'DATA_AUTHORIZATION_REQUIRED';end if;
 end loop;
end $$;
