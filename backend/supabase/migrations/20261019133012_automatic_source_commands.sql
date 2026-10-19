-- Enabling a saved public URL selects automatic reading when no custom extraction exists.
do $patch$ declare definition text;old text;new text;begin
 select pg_get_functiondef('app_private.collection_command(text,jsonb,text)'::regprocedure) into definition;
 old:='if src.kind=''manual'' or src.adapter_required then raise exception ''ADAPTER_REQUIRED''; end if;';
 new:=$body$
   if src.kind='manual' or src.adapter_required or (src.kind='link_directory' and not (src.adapter_config ? 'official_listing')) then
    if coalesce(src.url,'')!~'^https://[a-zA-Z0-9.-]+([/:?]|$)' then raise exception 'ADAPTER_REQUIRED';end if;
    update public.sources set kind='link_directory',adapter_required=false,adapter_config=adapter_config||'{"automatic":true}'::jsonb,approved_hosts=array[lower(substring(url from '^https://([^/:?]+)'))],policy_note=case when length(trim(policy_note))=0 then 'Owner enabled public source reading.' else policy_note end where id=src.id returning * into src;
   end if;
   if src.kind='link_directory' and src.adapter_config->'automatic'='true'::jsonb and cardinality(src.approved_hosts)=0 then
    update public.sources set approved_hosts=array[lower(substring(url from '^https://([^/:?]+)'))] where id=src.id returning * into src;
   end if;
 $body$;
 if position(old in definition)=0 then raise exception 'Source activation guard changed';end if;
 execute replace(definition,old,new);
end $patch$;

-- Preserve all current discovery columns and invoker RLS while including generic detail readiness.
do $$ declare definition text;old text:='src.adapter_config ? ''official_listing''::text';begin
 select pg_get_viewdef('public.opportunity_discovery'::regclass,true) into definition;
 if position(old in definition)=0 then raise exception 'Discovery readiness expression changed';end if;
 definition:=replace(definition,old,'(src.adapter_config ? ''official_listing''::text or src.adapter_config->''automatic''=''true''::jsonb)');
 execute 'create or replace view public.opportunity_discovery with(security_invoker=true) as '||definition;
end $$;

-- A credential-driven provider pool can assess collected notices without a manual model-settings row.
do $$ declare definition text;old text;begin
 select pg_get_functiondef('public.schedule_assessment_refresh_before_details()'::regprocedure) into definition;
 old:='if not exists(select 1 from public.model_settings where workspace_id=w and enabled) or exists';
 if position(old in definition)=0 then raise exception 'Assessment scheduling guard changed';end if;
 execute replace(definition,old,'if (not exists(select 1 from public.model_settings where workspace_id=w and enabled) and not exists(select 1 from public.model_routing where workspace_id=w and enabled)) or exists');
end $$;

-- Independent directory discovery is an explicit Owner action, not a source configuration mode.
alter function app_private.app_command(text,jsonb,text) rename to app_command_before_source_discovery;
revoke all on function app_private.app_command_before_source_discovery(text,jsonb,text) from public,anon,authenticated,service_role;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid:=auth.uid();digest text;replay app_private.idempotency_records;result jsonb;job uuid;
begin
 if operation<>'source.discover' then return app_private.app_command_before_source_discovery(operation,input,idempotency_key);end if;
 select workspace_id into w from public.memberships where user_id=actor and app_private.member_role(workspace_id) is not null limit 1;
 if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;
 if app_private.member_role(w) is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 if exists(select 1 from public.restore_sessions where workspace_id=w and state='staging') then raise exception 'RESTORE_IN_PROGRESS';end if;
 perform app_private.check_keys(input,array['url']);
 if coalesce(input->>'url','')!~'^https://[a-zA-Z0-9.-]+([/:?]|$)' or length(input->>'url')>2000 or idempotency_key is null or length(idempotency_key) not between 1 and 200 then raise exception 'INVALID_INPUT';end if;
 digest:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then if replay.body_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 if exists(select 1 from public.jobs where workspace_id=w and type='source_candidates' and checkpoint->>'discovery_url'=input->>'url' and status in ('queued','running','retry_wait','quota_wait')) then raise exception 'JOB_ALREADY_PENDING';end if;
 insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint) values(w,'source_candidates',w,digest,'queued',actor,jsonb_build_object('discovery_url',input->>'url')) returning id into job;
 result:=jsonb_build_object('job_id',job,'status','queued');
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,request_id) values(w,actor,operation,job,gen_random_uuid());
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,digest,result);
 return result;
end $$;
revoke all on function app_private.app_command(text,jsonb,text) from public,anon;
grant execute on function app_private.app_command(text,jsonb,text) to authenticated;

-- Automatic notices also receive generic public detail/PDF reading before assessment.
do $patch$ declare name text;definition text;begin
 foreach name in array array['public.generation_context(uuid,uuid)','public.schedule_assessment_refresh()','public.claim_backend_job()'] loop
  select pg_get_functiondef(name::regprocedure) into definition;
  definition:=replace(definition,'s.adapter_config ? ''official_listing''','(s.adapter_config ? ''official_listing'' or s.adapter_config->''automatic''=''true''::jsonb)');
  definition:=replace(definition,'src.adapter_config ? ''official_listing''','(src.adapter_config ? ''official_listing'' or src.adapter_config->''automatic''=''true''::jsonb)');
  execute definition;
 end loop;
end $patch$;
