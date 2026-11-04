-- October 19 automatic-routing policy: accounting uncertainty is not an
-- eternal execution lock. Never infer termination from an arbitrary GET error.
create function app_private.model_usage_blocks_recovery(j public.jobs,u public.provider_usage,observed_at timestamptz)
returns boolean language sql stable set search_path='' as $$
 select case when u.workspace_id is distinct from j.workspace_id then true
  when u.state='reserved' then true when u.state<>'unknown' then false
  when j.checkpoint#>>'{model_routing,mode}' is distinct from 'round_robin' then true
  else not coalesce((
   (u.error_code='PROVIDER_BACKGROUND_TERMINATED' and u.remote_request_id is not null and exists(
    select 1 from public.model_attempts a where a.workspace_id=u.workspace_id and a.job_id=u.job_id and a.usage_id=u.id
     and a.provider=u.provider and a.model=u.model and a.connection_id is not distinct from u.connection_id
     and a.model_config_id is not distinct from u.model_config_id and a.status='failed'
     and (a.result_code='PROVIDER_BACKGROUND_TERMINATED' or (a.result_code='PROVIDER_REQUEST_REJECTED' and a.response_id=u.remote_request_id))
     and a.finish_reason in ('failed','cancelled','canceled')))
   or (u.created_at<=observed_at-interval '15 minutes' and (u.remote_deadline is null or u.remote_deadline<=observed_at)
    and (u.remote_request_id is null or u.remote_deadline is not null))
  ),false) end;
$$;
revoke all on function app_private.model_usage_blocks_recovery(public.jobs,public.provider_usage,timestamptz) from public,anon,authenticated,service_role;

-- An append-only audit event is lineage, not a usage settlement or allowance.
-- Callers hold the workspace lock; replay of the same eligible set is a no-op.
create function app_private.record_model_usage_recovery(j public.jobs,operation_name text,operation_key text,input_identity text default null,phase_prefix text default null,reservation_target jsonb default null)
returns void language plpgsql set search_path='' as $$
declare receipts jsonb;identity text;
begin
 if j.checkpoint#>>'{model_routing,mode}' is distinct from 'round_robin' then return;end if;
 select jsonb_agg(jsonb_build_object('usage_id',u.id,'job_id',u.job_id,'input_hash',u.input_hash,'call_key',u.call_key,
  'state',u.state,'error_code',u.error_code,'remote_request_hash',case when u.remote_request_id is not null then encode(sha256(convert_to(u.remote_request_id,'UTF8')),'hex') end,
  'disposition','automatic_policy_eligible') order by u.id)
 into receipts from public.provider_usage u where u.workspace_id=j.workspace_id and u.state='unknown'
  and case when operation_name='model_reservation' then case when reservation_target->>'kind'='task' then
    u.connection_id=(reservation_target->>'connection_id')::uuid and u.model=reservation_target->>'model' and
    (u.input_hash=input_identity or (u.job_id=j.id and (
     u.call_key !~ ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$' or operation_key !~ ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$' or
     regexp_replace(u.call_key, ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$', '')=regexp_replace(operation_key, ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$', ''))))
   when reservation_target->>'kind'='legacy' then u.provider=reservation_target->>'provider' and (u.job_id=j.id or u.input_hash=input_identity)
   else false end
  else u.job_id=j.id and (input_identity is null or u.input_hash=input_identity or left(u.call_key,length(phase_prefix)+1)=phase_prefix||':') end
  and not app_private.model_usage_blocks_recovery(j,u,now());
 if receipts is null then return;end if;
 identity:=encode(sha256(convert_to(operation_name||':'||operation_key||':'||receipts::text,'UTF8')),'hex');
 if exists(select 1 from public.audit_events a where a.workspace_id=j.workspace_id and a.entity_id=j.id
  and a.action='model.usage_recovery' and a.details->>'identity'=identity) then return;end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,entity_type,reason,request_id,details)
 values(j.workspace_id,coalesce(auth.uid(),j.created_by),'model.usage_recovery',j.id,'job','Automatic execution recovery; unknown usage retained',gen_random_uuid(),
  jsonb_build_object('version',1,'operation',operation_name,'operation_key_hash',encode(sha256(convert_to(operation_key,'UTF8')),'hex'),
   'identity',identity,'job_revision',j.revision,'receipts',receipts,'usage_unchanged',true,'candidate_allowances_unchanged',true));
end $$;
revoke all on function app_private.record_model_usage_recovery(public.jobs,text,text,text,text,jsonb) from public,anon,authenticated,service_role;

-- Patch only the reviewed guard/lineage points in final migrated functions.
-- Preserve later wrappers, owner/source/revision checks and exact old payloads.
do $recovery$
declare definition text;old_guard text;new_guard text;
begin
 select pg_get_functiondef('app_private.retry_generation_job(jsonb,text)'::regprocedure) into definition;
 old_guard:=$old$and u.state in ('reserved','unknown')) then raise exception 'USAGE_REVIEW_REQUIRED';end if;$old$;
 new_guard:=$new$and app_private.model_usage_blocks_recovery(j,u,now())) then raise exception 'USAGE_REVIEW_REQUIRED';end if;
  perform app_private.record_model_usage_recovery(j,'job_retry',idempotency_key);$new$;
 if position(old_guard in definition)=0 then raise exception 'RETRY_USAGE_GUARD_CHANGED';end if;
 execute replace(definition,old_guard,new_guard);
 select pg_get_functiondef('app_private.writer_validation_handoff(uuid,uuid,text,jsonb)'::regprocedure) into definition;
 old_guard:=$old$and other.state='unknown' and (other.input_hash=u.input_hash
      or left(other.call_key,length(v->>'request_prefix')+1)=(v->>'request_prefix')||':'))$old$;
 new_guard:=$new$and other.state='unknown' and (other.input_hash=u.input_hash
      or left(other.call_key,length(v->>'request_prefix')+1)=(v->>'request_prefix')||':')
    and app_private.model_usage_blocks_recovery(j,other,now()))$new$;
 if position(old_guard in definition)=0 then raise exception 'HANDOFF_USAGE_GUARD_CHANGED';end if;
 definition:=replace(definition,old_guard,new_guard);
 old_guard:=$old$ if marker.id is not null then$old$;
 new_guard:=$new$ perform app_private.record_model_usage_recovery(j,'writer_validation_handoff',r.id::text,u.input_hash,v->>'request_prefix');
 if marker.id is not null then$new$;
 if position(old_guard in definition)=0 then raise exception 'HANDOFF_MARKER_CHANGED';end if;
 execute replace(definition,old_guard,new_guard);
 -- Reservation still guards target identity and immutable call_key. Only the
 -- automatic uncertainty predicate changes; manual branch remains byte-for-byte.
 select pg_get_functiondef('public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)'::regprocedure) into definition;
 old_guard:=$old$(p.created_at>now()-interval '15 minutes' or p.remote_deadline>now())$old$;
 new_guard:=$new$app_private.model_usage_blocks_recovery(j,p,now())$new$;
 if position(old_guard in definition)=0 then raise exception 'TASK_RESERVATION_GUARD_CHANGED';end if;
 definition:=replace(definition,old_guard,new_guard);
 if position(' insert into public.provider_usage(' in definition)=0 then raise exception 'TASK_RESERVATION_INSERT_CHANGED';end if;
 definition:=replace(definition,' insert into public.provider_usage(',$insert$ perform app_private.record_model_usage_recovery(j,'model_reservation',call_key,input_hash,null,jsonb_build_object('kind','task','connection_id',target_connection,'model',entry->>'model'));
 insert into public.provider_usage($insert$);
 execute definition;
 select pg_get_functiondef('public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text)'::regprocedure) into definition;
 if position(old_guard in definition)=0 then raise exception 'LEGACY_RESERVATION_GUARD_CHANGED';end if;
 definition:=replace(definition,old_guard,new_guard);
 if position(' insert into public.provider_usage(' in definition)=0 then raise exception 'LEGACY_RESERVATION_INSERT_CHANGED';end if;
 definition:=replace(definition,' insert into public.provider_usage(',$insert$ perform app_private.record_model_usage_recovery(j,'model_reservation',call_key,input_hash,null,jsonb_build_object('kind','legacy','provider',target_provider));
 insert into public.provider_usage($insert$);
 execute definition;
end $recovery$;
