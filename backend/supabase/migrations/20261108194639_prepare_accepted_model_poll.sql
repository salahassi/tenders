-- Resume an already accepted ordinary graph request before replaying the graph.
-- This fuses existing lease/authorization/attempt RPCs; it cannot reserve work,
-- settle usage, accept a candidate or alter any immutable graph/prompt pin.
create function public.prepare_accepted_model_poll(
 job_id uuid,lease uuid,thread_id text,graph_input_hash text,manifest jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 j public.jobs;s public.generation_steps;t app_private.model_graph_threads;
 u public.provider_usage;origin public.model_attempts;
 operation_name text;phase text;phase_key text;phase_hash text;step_task text;
 metadata jsonb;record_metadata jsonb;pool jsonb;configuration jsonb;first_target jsonb;
 semantic_pin jsonb;verification_pin jsonb;semantic_version integer;verification_version integer;
 prompt_base text;prompt_suffix text;pending jsonb;issuance jsonb;attempt bigint;
begin
 -- A stale/canceled lease or a closed issuance is never an optional-cache miss.
 j:=app_private.model_job(job_id,lease);
 if j.lease_until is null or j.lease_until<=clock_timestamp() then raise exception 'STALE_LEASE';end if;
 perform app_private.assert_issuance_job(j.id);
 if j.checkpoint->>'model_executor' is distinct from '2'
  or j.checkpoint ? 'verifier_recheck'
  or j.checkpoint#>>'{model_routing,mode}' is distinct from 'round_robin'
  or thread_id is null or thread_id !~ '^[a-f0-9]{64}$'
  or graph_input_hash is null or graph_input_hash !~ '^[a-f0-9]{64}$'
  or j.checkpoint->>'graph_thread' is distinct from thread_id then return null;end if;

 select step.* into s from public.generation_steps step
 join public.generation_plans p on p.workspace_id=step.workspace_id and p.id=step.plan_id
 where step.workspace_id=j.workspace_id and step.job_id=j.id and step.plan_id=j.entity_id
  and step.status='queued' and step.task=j.type and p.status in ('queued','running','blocked');
 if s.id is null then return null;end if;
 -- Match taskInput's hierarchical planning mapping, not only the queue task.
 step_task:=case
  when s.task='plan_proposal' and s.input->>'planning_phase'='structure' then 'plan_structure'
  when s.task='plan_proposal' and case when jsonb_typeof(s.input->'workflow_version')='number'
    then (s.input->>'workflow_version')::numeric>=2 else false end then 'plan_blueprint'
  else s.task end;
 if step_task not in ('classify_opportunity','summarize_review','analyze_chunk','plan_proposal',
  'plan_blueprint','plan_structure','draft_section','plan_commercial','review_proposal') then return null;end if;
 select graph.* into t from app_private.model_graph_threads graph
 where graph.id=thread_id and graph.workspace_id=j.workspace_id and graph.job_id=j.id
  and graph.input_hash=graph_input_hash and graph.task=step_task and graph.status='running'
  and graph.graph_version=1;
 if t.id is null or t.id is distinct from encode(sha256(convert_to(
  j.id::text||':step:'||s.id::text||':'||graph_input_hash,'UTF8')),'hex') then return null;end if;

 -- Never choose between multiple reservations or reinterpret an unknown/settled
 -- historical response. Their original graph/reconciliation path remains owner.
 if (select count(*) from public.provider_usage p where p.workspace_id=j.workspace_id
  and p.job_id=j.id and p.state='reserved')<>1 then return null;end if;
 select p.* into u from public.provider_usage p where p.workspace_id=j.workspace_id
  and p.job_id=j.id and p.state='reserved';
 if u.remote_request_id is null or u.remote_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
  or u.remote_deadline is null or u.graph_candidate_recorded
  or u.provider not in ('openai','gemini_free')
  or u.connection_id is null or u.model_config_id is null
  or u.error_code='PROVIDER_BACKGROUND_TERMINATED' then return null;end if;
 if u.remote_deadline<=clock_timestamp() then return null;end if;
 if jsonb_typeof(j.checkpoint->'model_round') is distinct from 'object'
  or j.checkpoint#>>'{model_round,input_hash}' is distinct from u.input_hash
  or jsonb_typeof(j.checkpoint#>'{model_round,remaining}') is distinct from 'array' then return null;end if;
 first_target:=j.checkpoint#>'{model_round,remaining,0}';
 if first_target->>'provider' is distinct from u.provider
  or first_target->>'model' is distinct from u.model
  or first_target->>'project_ref' is distinct from u.remote_project_ref
  or first_target->>'model_config_id' is distinct from u.model_config_id::text
  or first_target->>'connection_id' is distinct from u.connection_id::text then return null;end if;
 operation_name:=j.checkpoint#>>'{model_operation,task}';
 if operation_name is null or operation_name not in (t.task,'verify_grounding','repair_result') then return null;end if;

 phase:=regexp_replace(u.call_key, ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$', '');
 if phase=u.call_key or left(phase,length('step:'||s.id::text||':'))<>'step:'||s.id::text||':'
  or length(phase) not between 1 and 400
  or u.call_key !~ (':'||left(u.input_hash,16)||':[1-9][0-9]*:'||u.model_config_id::text||'$') then return null;end if;
 phase_key:=substr(phase,length('step:'||s.id::text||':')+1);
 if operation_name='verify_grounding' then
  if phase_key !~ '^(verification(-repair)?-[a-f0-9]{64}|verification-v3:[a-f0-9]{64}|review-boundary-v3-[a-f0-9]{64})$'
   then return null;end if;
 elsif operation_name='repair_result' then
  if phase_key !~ '^candidate-[12]$' then return null;end if;
 elsif phase_key<>'candidate-0' then return null;
 end if;
 phase_hash:=encode(sha256(convert_to(phase,'UTF8')),'hex');
 select pin.value into semantic_pin from app_private.model_graph_results pin
 where pin.workspace_id=j.workspace_id and pin.thread_id=t.id
  and pin.result_key='semantic-instructions-'||phase_hash
  and pin.content_hash=encode(sha256(convert_to(pin.value::text,'UTF8')),'hex');
 if jsonb_typeof(semantic_pin) is distinct from 'object'
  or jsonb_typeof(semantic_pin->'version') is distinct from 'number'
  or coalesce(semantic_pin->>'version','') !~ '^[1-6]$'
  or coalesce(semantic_pin->>'legacy_input_hash','') !~ '^[a-f0-9]{64}$'
  or jsonb_typeof(semantic_pin->'instructions') is distinct from 'string'
  or length(semantic_pin->>'instructions')=0 then return null;end if;
 semantic_version:=(semantic_pin->>'version')::integer;
 if operation_name='verify_grounding' then
  select pin.value into verification_pin from app_private.model_graph_results pin
  where pin.workspace_id=j.workspace_id and pin.thread_id=t.id
   and pin.result_key='verification-instructions-'||phase_hash
   and pin.content_hash=encode(sha256(convert_to(pin.value::text,'UTF8')),'hex');
  if jsonb_typeof(verification_pin) is distinct from 'object'
   or jsonb_typeof(verification_pin->'version') is distinct from 'number'
   or coalesce(verification_pin->>'version','') !~ '^[2-6]$'
   or coalesce(verification_pin->>'legacy_input_hash','') !~ '^[a-f0-9]{64}$'
   or jsonb_typeof(verification_pin->'instructions') is distinct from 'string'
   or length(verification_pin->>'instructions')=0 then return null;end if;
  verification_version:=(verification_pin->>'version')::integer;
 end if;

 select a.* into origin from public.model_attempts a where a.workspace_id=j.workspace_id
  and a.job_id=j.id and a.usage_id=u.id and a.sent and a.request_phase='generation'
  and a.execution_metadata is not null order by a.id limit 1;
 metadata:=coalesce(u.execution_metadata,origin.execution_metadata);
 if origin.id is null or metadata is distinct from origin.execution_metadata
  or origin.provider is distinct from u.provider or origin.model is distinct from u.model
  or origin.project_ref is distinct from u.remote_project_ref
  or origin.connection_id is distinct from u.connection_id or origin.model_config_id is distinct from u.model_config_id
  or origin.operation is distinct from operation_name
  or jsonb_typeof(metadata) is distinct from 'object' or pg_column_size(metadata)>8192
  or metadata->>'input_hash' is distinct from u.input_hash
  or metadata->>'graph_thread' is distinct from t.id
  or metadata->'executor_version' is distinct from '2'::jsonb
  or metadata->>'operation' is distinct from operation_name
  or metadata->>'contract_version' is distinct from '1'
  or coalesce(metadata->>'schema_version','') not in ('1','2','3')
  or jsonb_typeof(metadata->'profile') is distinct from 'object'
  or jsonb_typeof(metadata->'capabilities') is distinct from 'object'
  or metadata#>'{capabilities,background}' is distinct from 'true'::jsonb then return null;end if;
 -- Bind the durable revision pins to the original label; unsupported future
 -- policy versions simply use ordinary graph replay instead of this shortcut.
 prompt_base:=case when operation_name='verify_grounding' then case verification_version
   when 2 then 'tenderdesk-grounding-v2-contiguous-quotes'
   when 3 then 'tenderdesk-grounding-v3-review-boundary'
   when 4 then 'tenderdesk-grounding-v4-analysis-boundary'
   when 5 then 'tenderdesk-grounding-v5-analysis-metadata'
   when 6 then 'tenderdesk-grounding-v6-literal' end
  when operation_name='repair_result' then case when metadata->>'schema_version'='3'
   then 'tenderdesk-repair-patch-v1' else 'tenderdesk-repair-v1' end
  when operation_name='classify_opportunity' then 'tenderdesk-v6-configurable-service-scope'
  else 'tenderdesk-v3' end;
 prompt_suffix:=case semantic_version when 3 then '.scope-v1' when 4 then '.evidence-v1'
  when 5 then '.plan-v1' when 6 then '.evidence-v1.ew1' else '' end
  ||'.tenderdesk-semantic-fidelity-v1'||case when semantic_version>=2 then '.economy-v1' else '' end;
 if metadata->>'prompt_version' is distinct from prompt_base||prompt_suffix then return null;end if;
 begin
  perform app_private.validate_model_profile(metadata->'profile');
  perform app_private.validate_model_capabilities(metadata->'capabilities');
  if metadata ? 'reasoning_control' then
   perform app_private.check_keys(metadata->'reasoning_control',array['transport','requested','effective']);
   if jsonb_typeof(metadata->'reasoning_control') is distinct from 'object'
    or coalesce(metadata#>>'{reasoning_control,transport}','') not in ('generate_content:v1beta','interactions:v1beta:2026-05-20')
    or coalesce(metadata#>>'{reasoning_control,requested}','') not in ('none','minimal','low','medium','high')
    or coalesce(metadata#>>'{reasoning_control,effective}','') not in ('none','minimal','low','medium','high') then return null;end if;
  end if;
 exception when raise_exception or invalid_text_representation or numeric_value_out_of_range then return null;
 end;

 -- Reuse the current source authorization and frozen target identity checks.
 -- Optional proof has completed before the first reservation lease/attempt write.
 -- A different permitted fallback must not hide revocation for this accepted
 -- target: the original provider is the only provider this RPC may retrieve.
 perform app_private.check_requested_model_payload(j.id,u.provider,manifest);
 pool:=public.task_model_preflight(j.id,lease,manifest);
 select p.value into configuration from jsonb_array_elements(pool->'providers') p(value)
 where p.value->>'model_config_id'=u.model_config_id::text
  and p.value->>'connection_id'=u.connection_id::text;
 if configuration is null or configuration->>'provider' is distinct from u.provider
  or configuration->>'model' is distinct from u.model
  or configuration->>'project_ref' is distinct from u.remote_project_ref then return null;end if;
 issuance:=public.proposal_issuance_job_state(j.id,lease);
 perform app_private.assert_issuance_job(j.id);
 if u.remote_deadline<=clock_timestamp() then return null;end if;
 pending:=public.resume_task_model_request_phase(j.id,lease,u.input_hash,manifest,u.model_config_id,u.connection_id,phase);
 if pending is null or pending->>'id' is distinct from u.id::text
  or pending->>'remote_request_id' is distinct from u.remote_request_id
  or pending->'execution_metadata' is distinct from metadata then raise exception 'MODEL_IDENTITY_CHANGED';end if;
 attempt:=public.start_task_model_attempt(j.id,lease,u.model_config_id,u.connection_id,operation_name);
 select jsonb_object_agg(field.key,field.value) into record_metadata from jsonb_each(metadata) field
 where field.key in ('contract_version','schema_version','prompt_version','input_hash','route_revision',
  'profile','capabilities','reasoning_control');
 perform public.record_model_request_metadata(attempt,lease,record_metadata);
 return jsonb_build_object('version',1,'request_prefix',phase,'operation',operation_name,
  'attempt_id',attempt::text,'pending',pending,'configuration',configuration,'issuance_request',issuance);
end $$;

do $acl$ declare role_name text;begin
 revoke all on function public.prepare_accepted_model_poll(uuid,uuid,text,text,jsonb) from public;
 foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then
   execute format('revoke all on function public.prepare_accepted_model_poll(uuid,uuid,text,text,jsonb) from %I',role_name);
   if role_name in ('service_role','tdp_app_service') then
    execute format('grant execute on function public.prepare_accepted_model_poll(uuid,uuid,text,text,jsonb) to %I',role_name);
   end if;
  end if;
 end loop;
end $acl$;
