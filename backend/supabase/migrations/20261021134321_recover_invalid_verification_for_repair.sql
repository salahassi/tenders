-- Recovery creates scoped replay artifacts or untrusted repair-only findings.
-- Normal graph verification and acceptance remain mandatory.
-- Candidate allowances and already-settled usage remain unchanged.
create function app_private.invalid_verification_repair(job_id uuid,lease uuid,thread_id text,action text,payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;t app_private.model_graph_threads;c app_private.model_graph_results;
 r app_private.model_graph_results;a app_private.model_graph_results;pool jsonb;
 count_before integer;writer_count integer;candidate_hash text;phase text;phases text[];
 budget_unit text;correction_unit text;last_report_at timestamptz;identity_count integer;
begin
 j:=app_private.model_job(job_id,lease);
 select gt.* into t from app_private.model_graph_threads gt where gt.id=thread_id and gt.job_id=j.id and gt.workspace_id=j.workspace_id for update;
 if t.id is null or t.task<>'draft_section' or t.status<>'needs_review' or t.result_id is not null then return null;end if;
 if action='invalid_verification_repair_candidate' then
  perform app_private.check_keys(payload,array['candidate_id','candidate_hash','repair_count','manifest']);
 elsif action='invalid_verification_repair_resume' then
  perform app_private.check_keys(payload,array['candidate_id','candidate_hash','repair_count','report_id','artifact_id','manifest']);
 else raise exception 'INVALID_INPUT';end if;
 if jsonb_typeof(payload->'repair_count') is distinct from 'number'
  or payload->>'repair_count' not in ('0','1')
  or coalesce(payload->>'candidate_hash','') !~ '^[a-f0-9]{64}$'
  or jsonb_typeof(payload->'manifest') is distinct from 'array' then return null;end if;
 count_before:=(payload->>'repair_count')::int;candidate_hash:=payload->>'candidate_hash';
 if public.model_graph_store(job_id,lease,thread_id,'recovery_ready','{}')<>'true'::jsonb
  or exists(select 1 from app_private.model_graph_results gr where gr.thread_id=t.id and gr.result_key='accepted') then return null;end if;
 select * into c from app_private.model_graph_results gr where gr.thread_id=t.id
  and gr.id=(payload->>'candidate_id')::uuid and gr.result_key='candidate-'||count_before;
 if c.id is null or exists(select 1 from app_private.model_graph_results gr where gr.thread_id=t.id and gr.result_key='candidate-'||(count_before+1)) then return null;end if;
 select candidates into writer_count from app_private.model_graph_budgets b where b.thread_id=t.id and b.unit='writer';
 if writer_count is null or writer_count<1 or writer_count>=3 or t.candidate_count<>writer_count then return null;end if;
 pool:=public.task_model_preflight(job_id,lease,payload->'manifest');
 if jsonb_typeof(pool->'providers') is distinct from 'array' or pool->>'pending_model_config_id' is not null then return null;end if;

 -- Scope keys are persisted protocol identities, not inferred from prose.
 -- A unique exhausted, unresolved corrective phase is required. Ambiguity
 -- cannot choose an older or more favorable report.
 with report_phases as (
  select distinct coalesce(gr.value->>'verification_key',substring(gr.result_key from 9)) phase_key
  from app_private.model_graph_results gr where gr.thread_id=t.id
   and (gr.result_key like 'invalid-report-%' or gr.result_key like 'invalid-verification-repair-%')
 ), units as (
  select phase_key,
   case when phase_key='verification-repair-'||candidate_hash then 'verifier-'||candidate_hash
    else substring(phase_key from 21) end original_unit,
   case when phase_key='verification-repair-'||candidate_hash then 'verifier-repair-'||candidate_hash
    else substring(phase_key from 21)||'-repair' end corrective_unit
  from report_phases where phase_key='verification-repair-'||candidate_hash
   or phase_key ~ ('^verification-repair-v3-'||candidate_hash||'-(content-[0-9]+|requirements)$')
 )
 select array_agg(phase_key order by phase_key) into phases from units
 where exists(select 1 from app_private.model_graph_budgets b where b.thread_id=t.id and b.unit=original_unit and b.candidates>=3)
  and exists(select 1 from app_private.model_graph_budgets b where b.thread_id=t.id and b.unit=corrective_unit and b.candidates>=1)
  and not exists(select 1 from app_private.model_graph_results gr where gr.thread_id=t.id and gr.result_key in (phase_key,replace(phase_key,'verification-repair-','verification-')));
 if coalesce(array_length(phases,1),0)<>1 then return null;end if;
 phase:=phases[1];
 select max(gr.created_at) into last_report_at from app_private.model_graph_results gr where gr.thread_id=t.id
  and (gr.value->>'verification_key'=phase and gr.result_key like 'invalid-report-%' or gr.result_key='invalid-'||phase);
 select count(distinct jsonb_build_object('result',gr.value->'result','code',gr.value->'code','producer',gr.value->'producer')) into identity_count
 from app_private.model_graph_results gr where gr.thread_id=t.id and gr.created_at=last_report_at
  and (gr.value->>'verification_key'=phase and gr.result_key like 'invalid-report-%' or gr.result_key='invalid-'||phase);
 if identity_count<>1 then return null;end if;
 select * into r from app_private.model_graph_results gr where gr.thread_id=t.id and gr.created_at=last_report_at
  and (gr.value->>'verification_key'=phase and gr.result_key like 'invalid-report-%' or gr.result_key='invalid-'||phase)
  order by (gr.result_key like 'invalid-report-%') desc,gr.id desc limit 1;
 if r.id is null or r.value->>'code' is distinct from 'EVIDENCE_REFERENCE_INVALID'
  or r.value->'result'->>'checked_candidate_hash' is distinct from candidate_hash
  or r.value->'result'->>'reviewed_all_content' is distinct from 'true' then return null;end if;
 if action='invalid_verification_repair_candidate' then
  return jsonb_build_object('report',to_jsonb(r),'verification_key',phase,'writer_count',writer_count,'input_hash',t.input_hash);
 end if;
 if r.id is distinct from (payload->>'report_id')::uuid then return 'false'::jsonb;end if;
 select * into a from app_private.model_graph_results gr where gr.thread_id=t.id and gr.id=(payload->>'artifact_id')::uuid
  and gr.result_key in ('invalid-verification-repair-only-'||c.id||'-'||r.id,'invalid-verification-revalidated-'||c.id||'-'||r.id);
 if a.id is null
  or a.value->'result'->>'checked_candidate_hash' is distinct from candidate_hash
  or a.value#>>'{recovery_provenance,input_hash}' is distinct from t.input_hash
  or a.value#>>'{recovery_provenance,candidate_ref}' is distinct from c.id::text
  or a.value#>>'{recovery_provenance,candidate_hash}' is distinct from candidate_hash
  or a.value#>>'{recovery_provenance,report_ref}' is distinct from r.id::text
  or a.value#>>'{recovery_provenance,verification_key}' is distinct from phase
  or a.value#>>'{recovery_provenance,repair_count}' is distinct from count_before::text
  or a.value#>>'{recovery_provenance,received_candidate_budgets_unchanged}' is distinct from 'true'
  or a.value#>>'{recovery_provenance,new_provider_requests}' is distinct from '0' then return 'false'::jsonb;end if;
 if a.value->>'coverage'='repair_only' then
  if a.result_key is distinct from 'invalid-verification-repair-only-'||c.id||'-'||r.id
   or a.value->'result'->>'reviewed_all_content' is distinct from 'false'
   or a.value->'untrusted_report' is distinct from r.value->'result'
   or jsonb_typeof(a.value->'validation_diagnostics') is distinct from 'array'
   or jsonb_array_length(a.value->'validation_diagnostics')<1
   or not exists(select 1 from jsonb_array_elements(a.value->'result'->'findings') f
    where f->>'severity'='blocking' and f->>'code'='UNRESOLVED_VALIDATION') then return 'false'::jsonb;end if;
 elsif a.value->>'coverage'='revalidated_scope' then
  if a.result_key is distinct from 'invalid-verification-revalidated-'||c.id||'-'||r.id
   or a.value->'result' is distinct from r.value->'result'
   or a.value->'result'->>'reviewed_all_content' is distinct from 'true'
   or a.value ? 'validation_diagnostics' or a.value ? 'untrusted_report' then return 'false'::jsonb;end if;
 else return 'false'::jsonb;end if;
 update app_private.model_graph_threads set status='running',updated_at=now() where id=t.id;
 return 'true'::jsonb;
end $$;
revoke all on function app_private.invalid_verification_repair(uuid,uuid,text,text,jsonb) from public,anon,authenticated,service_role;

do $$ declare definition text;fragment text;replacement text;begin
 select pg_get_functiondef('public.model_graph_store(uuid,uuid,text,text,jsonb)'::regprocedure) into definition;
 fragment:=$old$ when 'candidate_budget' then$old$;
 replacement:=$new$ when 'invalid_verification_repair_candidate','invalid_verification_repair_resume' then
  return app_private.invalid_verification_repair(job_id,lease,thread_id,action,payload);
 when 'candidate_budget' then$new$;
 if position(fragment in definition)=0 then raise exception 'Unexpected invalid verification recovery guard';end if;
 execute replace(definition,fragment,replacement);
end $$;
