-- A new commercial input contract is admitted only by an explicit Owner retry.
-- The old step, graph, paid calls and exhausted budgets remain historical facts.
-- Installation performs DDL only; it never retries or accepts customer content.
create table app_private.commercial_successor_lineage (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 plan_id uuid not null,
 recovery_version integer not null default 1 check(recovery_version=1),
 predecessor_step_id uuid not null,
 predecessor_job_id uuid not null,
 successor_step_id uuid not null,
 successor_job_id uuid not null,
 predecessor_revision integer not null,
 predecessor_status text not null check(predecessor_status='failed'),
 predecessor_error text not null check(predecessor_error='MODEL_CORRECTION_EXHAUSTED'),
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 graph_thread text not null check(graph_thread ~ '^[a-f0-9]{64}$'),
 proof jsonb not null check(jsonb_typeof(proof)='object' and pg_column_size(proof)<=65536),
 proof_hash text not null check(proof_hash ~ '^[a-f0-9]{64}$'),
 issuance_request_id uuid not null,
 authorized_by uuid not null,
 operation text not null check(operation='generation.retry'),
 idempotency_key_hash text not null check(idempotency_key_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default transaction_timestamp(),
 unique(workspace_id,plan_id,recovery_version),
 unique(workspace_id,predecessor_job_id),
 unique(workspace_id,successor_job_id)
);
alter table app_private.commercial_successor_lineage enable row level security;
create function app_private.immutable_commercial_successor_lineage() returns trigger
language plpgsql set search_path='' as $$begin
 raise exception 'COMMERCIAL_SUCCESSOR_LINEAGE_IMMUTABLE';
end$$;
create trigger immutable_commercial_successor_lineage before update or delete on app_private.commercial_successor_lineage
 for each row execute function app_private.immutable_commercial_successor_lineage();

-- Recovery already requires an empty target. Export/import the receipt through
-- the same private recovery-view convention as graph history. Existing receipts
-- make a target nonempty, so an older backup cannot remove a spent recovery.
create view public.recovery_commercial_successor_lineage with(security_invoker=true) as
 select * from app_private.commercial_successor_lineage;
do $$declare definition text;marker text:='array[''export_packages'',''export_package_volumes'']::text[]';begin
 definition:=pg_get_functiondef('app_private.backup_tables()'::regprocedure);
 if position(marker in definition)=0 then raise exception 'COMMERCIAL_BACKUP_REGISTRY_CHANGED';end if;
 execute replace(definition,marker,marker||'||array[''recovery_commercial_successor_lineage'']::text[]');
end$$;

-- Match candidate prose, excluding citation/identity metadata. This is only a
-- failure-provenance predicate: it never declares an old result acceptable.
create function app_private.commercial_candidate_contains(value jsonb,quote text,depth integer default 0) returns boolean
language plpgsql immutable set search_path='' as $$declare item record;begin
 if depth>32 or quote is null or length(quote)=0 then return false;end if;
 if jsonb_typeof(value)='string' then return position(quote in (value#>>'{}'))>0;
 elsif jsonb_typeof(value)='array' then
  for item in select x from jsonb_array_elements(value) x loop
   if app_private.commercial_candidate_contains(item.x,quote,depth+1) then return true;end if;
  end loop;
 elsif jsonb_typeof(value)='object' then
  for item in select key,val from jsonb_each(value) e(key,val)
   where key not in ('source_refs','evidence_refs','notice_evidence','company_evidence','quote','source_id','key','rate_id') and key !~ '_ids$'
  loop
   if app_private.commercial_candidate_contains(item.val,quote,depth+1) then return true;end if;
  end loop;
 end if;
 return false;
end$$;

create function app_private.commercial_successor_proof(target_job uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.generation_steps;p public.generation_plans;t app_private.model_graph_threads;
 checkpoint jsonb;raw_checkpoint jsonb;c app_private.model_graph_results;r app_private.model_graph_results;
 report jsonb;diagnostic jsonb;claim jsonb;source_ref jsonb;source jsonb;source_pool jsonb;
 candidate jsonb;literal jsonb;identity text;remaining text;previous_text text;fragments text[];
 claims_index integer;report_count integer:=0;diagnostic_count integer:=0;removed boolean;
 candidate_pins jsonb;report_pins jsonb:='[]';usage_pins jsonb;proof jsonb;
begin
 select * into j from public.jobs where id=target_job;
 select * into s from public.generation_steps where job_id=j.id and workspace_id=j.workspace_id;
 select * into p from public.generation_plans where id=s.plan_id and workspace_id=j.workspace_id;
 select * into t from app_private.model_graph_threads where id=j.checkpoint->>'graph_thread' and job_id=j.id and workspace_id=j.workspace_id;
 if j.id is null or s.id is null or p.kind is distinct from 'proposal' or p.stage is distinct from 'commercial'
  or s.task is distinct from 'plan_commercial' or s.stage is distinct from 'commercial' or s.status is distinct from 'queued'
  or s.input ? 'commercial_input_version' or s.input ? 'commercial_predecessor_job_id'
  or j.type is distinct from 'plan_commercial' or j.input_hash is distinct from p.input_hash
  or t.id is null or t.task is distinct from 'plan_commercial' or t.status is distinct from 'needs_review'
  or t.result_id is not null or t.candidate_count<>1 or t.budget_version<>2
  or exists(select 1 from app_private.commercial_successor_lineage where workspace_id=p.workspace_id and plan_id=p.id)
  or exists(select 1 from app_private.model_graph_results where thread_id=t.id and result_key='accepted')
  or (select candidates from app_private.model_graph_budgets where thread_id=t.id and unit='writer') is distinct from 1
  or (select candidates from app_private.model_graph_budgets where thread_id=t.id and unit='writer-repair') is distinct from 2
  or exists(select 1 from public.provider_usage where job_id=j.id and state in ('reserved','unknown'))
  or not exists(select 1 from public.provider_usage where job_id=j.id and workspace_id=j.workspace_id and state='settled') then return null;end if;
 select ckp.checkpoint into raw_checkpoint from app_private.model_graph_checkpoints ckp where ckp.thread_id=t.id and namespace='' order by checkpoint_id desc limit 1;
 if raw_checkpoint->>'type' is distinct from 'json' or length(coalesce(raw_checkpoint->>'data','')) not between 1 and 2000000 then return null;end if;
 checkpoint:=convert_from(decode(raw_checkpoint->>'data','base64'),'UTF8')::jsonb;
 if checkpoint#>>'{channel_values,repairCount}' is distinct from '2' then return null;end if;
 select * into c from app_private.model_graph_results where thread_id=t.id and result_key='candidate-2';
 if c.id is null or checkpoint#>>'{channel_values,candidateRef}' is distinct from c.id::text
  or not exists(select 1 from app_private.model_graph_results where thread_id=t.id and id::text=checkpoint#>>'{channel_values,reportRef}') then return null;end if;
 select jsonb_agg(jsonb_build_object('id',id,'key',result_key,'hash',content_hash) order by result_key) into candidate_pins
 from app_private.model_graph_results where thread_id=t.id and result_key in ('candidate-0','candidate-1','candidate-2');
 if jsonb_array_length(candidate_pins)<>3 or exists(select 1 from app_private.model_graph_results where thread_id=t.id
  and (result_key in ('candidate-0','candidate-1','candidate-2') or result_key like 'invalid-report-%')
  and content_hash is distinct from encode(sha256(convert_to(value::text,'UTF8')),'hex')) then return null;end if;
 source_pool:=coalesce(p.frozen_context->'blocks','[]')||jsonb_build_array(p.frozen_context->'notice');
 -- Check every retained invalid report; no favorable-report selection. Cap the
 -- work and fail closed when diagnostics were truncated or are not this bug.
 if (select count(*) from app_private.model_graph_results where thread_id=t.id and result_key like 'invalid-report-%') not between 1 and 32 then return null;end if;
 for r in select * from app_private.model_graph_results where thread_id=t.id and result_key like 'invalid-report-%' order by result_key loop
  report:=r.value->'result';
  if r.value->>'code' is distinct from 'EVIDENCE_REFERENCE_INVALID'
   or coalesce(r.value->>'omitted_diagnostic_count','0')<>'0'
   or jsonb_typeof(r.value->'validation_diagnostics') is distinct from 'array'
   or jsonb_array_length(r.value->'validation_diagnostics') not between 1 and 64
   or coalesce(report->>'checked_candidate_hash','') !~ '^[a-f0-9]{64}$'
   or coalesce(r.value->>'verification_key','') !~ ('^verification-(repair-)?(v3-)?'||(report->>'checked_candidate_hash')||'(-content-[0-9]+|-requirements)?$')
   or jsonb_typeof(report->'claims') is distinct from 'array' then return null;end if;
  for diagnostic in select value from jsonb_array_elements(r.value->'validation_diagnostics') loop
   if diagnostic->>'code' is distinct from 'EVIDENCE_REFERENCE_INVALID' or diagnostic->>'reason' is distinct from 'numeric_evidence_mismatch'
    or jsonb_typeof(diagnostic->'paths') is distinct from 'array' or jsonb_array_length(diagnostic->'paths')<>2
    or coalesce(diagnostic#>>'{paths,0}','') !~ '^\$\.claims\[[0-9]+\]\.candidate_quote$'
    or jsonb_typeof(diagnostic->'numeric_literals') is distinct from 'array' or jsonb_array_length(diagnostic->'numeric_literals')=0
    or jsonb_typeof(diagnostic->'evidence_ids') is distinct from 'array' then return null;end if;
   claims_index:=substring(diagnostic#>>'{paths,0}' from '\[([0-9]+)\]')::integer;
   if diagnostic#>>'{paths,1}' is distinct from '$.claims['||claims_index||'].source_refs' then return null;end if;
   claim:=report->'claims'->claims_index;remaining:=claim->>'candidate_quote';
   if claim->>'status' is distinct from 'supported' or coalesce(claim->>'kind','') not in ('tender_fact','company_fact','commercial_commitment')
    or length(coalesce(remaining,'')) not between 1 and 20000 or jsonb_typeof(claim->'source_refs') is distinct from 'array'
    or jsonb_array_length(claim->'source_refs') not between 1 and 32 then return null;end if;
   -- The claimed span must occur in a retained candidate's actual prose. Its
   -- private content hash, report hash and protocol candidate hash are retained
   -- together; JSONB text is deliberately not misused as a JS JSON.stringify hash.
   if not exists(select 1 from app_private.model_graph_results candidate_row where candidate_row.thread_id=t.id
    and candidate_row.result_key in ('candidate-0','candidate-1','candidate-2')
    and app_private.commercial_candidate_contains(case when candidate_row.value#>'{result,result}' is not null then candidate_row.value#>'{result,result}' else candidate_row.value->'result' end,remaining)) then return null;end if;
   removed:=false;fragments:=array[]::text[];
   for source_ref in select value from jsonb_array_elements(claim->'source_refs') loop
    identity:=source_ref->>'id';
    if coalesce(identity,'') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then return null;end if;
    select value into source from jsonb_array_elements(source_pool) where value->>'id'=identity;
    if source is null or length(coalesce(source_ref->>'quote',''))=0
     or position(source_ref->>'quote' in coalesce(source->>'text',source->>'description',''))=0 then return null;end if;
    previous_text:=remaining;
    remaining:=regexp_replace(remaining,'(^|[^[:alnum:]_:-])'||identity||':(?=[[:space:]"''“”‘’]|$)','\1:','g');
    if remaining<>previous_text then
     removed:=true;
     fragments:=fragments||array(select (m[1]::numeric)::text from regexp_matches(identity,'([0-9]+)','g') m);
    end if;
   end loop;
   if not removed or remaining ~ '[0-9٠-٩۰-۹]' then return null;end if;
   for literal in select value from jsonb_array_elements(diagnostic->'numeric_literals') loop
    if jsonb_typeof(literal)<>'string' or not((literal#>>'{}')=any(fragments)) then return null;end if;
   end loop;
   if jsonb_array_length(diagnostic->'evidence_ids')=0 or exists(select 1 from jsonb_array_elements_text(diagnostic->'evidence_ids') e
    where not exists(select 1 from jsonb_array_elements(claim->'source_refs') sr where sr->>'id'=e)) then return null;end if;
   diagnostic_count:=diagnostic_count+1;
  end loop;
  report_count:=report_count+1;
  report_pins:=report_pins||jsonb_build_array(jsonb_build_object('id',r.id,'hash',r.content_hash,'candidate_hash',report->>'checked_candidate_hash','verification_key',r.value->>'verification_key'));
 end loop;
 select jsonb_agg(jsonb_build_object('id',id,'state',state,'hash',encode(sha256(convert_to(to_jsonb(u)::text,'UTF8')),'hex')) order by id) into usage_pins
 from public.provider_usage u where job_id=j.id;
 proof:=jsonb_build_object('version',1,'plan_id',p.id,'step_id',s.id,'job_id',j.id,'input_hash',p.input_hash,
  'graph_thread',t.id,'graph_input_hash',t.input_hash,'candidate_pins',candidate_pins,'report_pins',report_pins,'usage_pins',usage_pins,
  'checkpoint_hash',encode(sha256(convert_to(raw_checkpoint::text,'UTF8')),'hex'),
  'frozen_context_hash',encode(sha256(convert_to(p.frozen_context::text,'UTF8')),'hex'),'report_count',report_count,'diagnostic_count',diagnostic_count);
 return proof;
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value or character_not_in_repertoire then return null;
end$$;

-- V2 is stamped at enqueue time only. Historical queued steps keep their input.
do $$declare definition text;old_insert text;begin
 definition:=pg_get_functiondef('app_private.enqueue_generation(public.generation_plans,text,jsonb,integer)'::regprocedure);
 old_insert:='insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by) values(p.workspace_id,task,p.id,p.input_hash,''queued'',p.created_by) returning id into j;';
 if position(old_insert in definition)=0 then raise exception 'COMMERCIAL_ENQUEUE_GUARD_CHANGED';end if;
 definition:=replace(definition,old_insert,$replacement$if task='plan_commercial' then input:=input||'{"commercial_input_version":2}'::jsonb;end if;
 insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint) values(p.workspace_id,task,p.id,p.input_hash,'queued',p.created_by,
  case when task='plan_commercial' then '{"commercial_input_version":2,"minimum_worker_executor":6}'::jsonb else '{}'::jsonb end) returning id into j;$replacement$);
 execute definition;
end$$;
create function app_private.guard_commercial_worker_capability() returns trigger
language plpgsql set search_path='' as $$begin
 if new.type='plan_commercial' and new.checkpoint->>'commercial_input_version'='2' then
  new.checkpoint:=new.checkpoint||jsonb_build_object('minimum_worker_executor',greatest(6,coalesce((new.checkpoint->>'minimum_worker_executor')::integer,1)));
 end if;
 return new;
end$$;
create trigger zzzzz_commercial_worker_capability before insert or update on public.jobs
 for each row execute function app_private.guard_commercial_worker_capability();

create function public.claim_backend_job_v6() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;previous text:=current_setting('app.worker_executor',true);begin
 perform set_config('app.worker_executor','6',true);result:=public.claim_backend_job();
 perform set_config('app.worker_executor',coalesce(previous,''),true);return result;
exception when others then perform set_config('app.worker_executor',coalesce(previous,''),true);raise;
end$$;
create function public.claim_backend_local_job_v6() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;previous text:=current_setting('app.queue_local_only',true);begin
 perform set_config('app.queue_local_only','true',true);result:=public.claim_backend_job_v6();
 perform set_config('app.queue_local_only',coalesce(previous,''),true);return result;
exception when others then perform set_config('app.queue_local_only',coalesce(previous,''),true);raise;
end$$;
do $$declare definition text;begin
 definition:=pg_get_functiondef('app_private.wake_backend_queue_checked_v5(uuid,uuid,bigint)'::regprocedure);
 if position('<=5' in definition)=0 then raise exception 'WORKER_SIX_WAKE_CAPABILITY_CHANGED';end if;
 execute replace(replace(definition,'app_private.wake_backend_queue_checked_v5(','app_private.wake_backend_queue_checked_v6('),'<=5','<=6');
end$$;
create function public.wake_backend_queue_status_v6(job_id uuid,lease uuid) returns jsonb
language sql security definer set search_path='' as $$select app_private.wake_backend_queue_checked_v6(job_id,lease,null)$$;
create function public.wake_backend_queue_revision_v6(job_id uuid,lease uuid,expected_revision bigint) returns jsonb
language sql security definer set search_path='' as $$select case when expected_revision is null then '{"dispatched":false}'::jsonb else app_private.wake_backend_queue_checked_v6(job_id,lease,expected_revision) end$$;

create function app_private.reprepare_commercial_successor(target_job uuid,actor uuid,expected_revision integer,proof jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.generation_steps;p public.generation_plans;i public.proposal_issuance_requests;
 child uuid;child_step uuid;original_checkpoint jsonb;receipt jsonb;successor_authorization jsonb:=proof->'authorization';
 previous_issuance_setting text:=current_setting('app.issuance_authorizing',true);
begin
 if current_setting('app.commercial_successor_authorizing',true) is distinct from target_job::text
  or current_setting('app.commercial_successor_depth',true) is distinct from '1'
  or actor is null or actor is distinct from auth.uid() then raise exception 'COMMERCIAL_SUCCESSOR_NOT_SAFE';end if;
 select * into j from public.jobs where id=target_job for update;
 if j.id is null then raise exception 'COMMERCIAL_SUCCESSOR_NOT_SAFE';end if;
 perform 1 from public.workspaces where id=j.workspace_id for update;
 if app_private.member_role(j.workspace_id) is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 select * into s from public.generation_steps where job_id=j.id and workspace_id=j.workspace_id for update;
 select * into p from public.generation_plans where id=s.plan_id and workspace_id=j.workspace_id for update;
 if j.revision is distinct from expected_revision or successor_authorization->>'predecessor_revision' is distinct from (expected_revision-1)::text
  or successor_authorization->>'predecessor_status' is distinct from 'failed'
  or successor_authorization->>'predecessor_error' is distinct from 'MODEL_CORRECTION_EXHAUSTED'
  or j.status is distinct from 'queued' or j.error_code is not null or j.cancel_requested
  or j.lease_token is not null or j.lease_until is not null or p.status is distinct from 'queued'
  or s.status is distinct from 'queued' or p.stage is distinct from 'commercial'
  or (select count(*) from public.generation_steps where plan_id=p.id and status='queued')<>1
  or proof-'authorization' is distinct from app_private.commercial_successor_proof(j.id)
  or not exists(select 1 from public.model_execution_settings where workspace_id=p.workspace_id and enabled and (admitted_after is null or p.created_at>=admitted_after))
  then raise exception 'COMMERCIAL_SUCCESSOR_NOT_SAFE';end if;
 if exists(select 1 from public.provider_usage where job_id=j.id and state in ('reserved','unknown')) then raise exception 'USAGE_REVIEW_REQUIRED';end if;
 if p.evidence_revision is distinct from (select evidence_revision from public.workspaces where id=p.workspace_id)
  or p.base_version_id is distinct from (select active_version_id from public.proposals where id=p.proposal_id) then raise exception 'STALE_INPUT';end if;
 perform app_private.assert_plan_source_resolution(p.id);
 select * into i from public.proposal_issuance_requests where id=p.issuance_request_id and workspace_id=p.workspace_id and plan_id=p.id;
 if i.id is null or i.outcome is distinct from 'active' or i.operation is distinct from 'generation.retry'
  or i.requested_by is distinct from actor or i.accepted_at is distinct from transaction_timestamp()
  or i.deadline_at is distinct from i.accepted_at+interval '600 seconds' or i.deadline_at<=clock_timestamp()
  or encode(sha256(convert_to(i.idempotency_key,'UTF8')),'hex') is distinct from successor_authorization->>'idempotency_key_hash'
  then raise exception 'COMMERCIAL_SUCCESSOR_NOT_SAFE';end if;
 original_checkpoint:=successor_authorization->'predecessor_checkpoint';
 if jsonb_typeof(original_checkpoint) is distinct from 'object'
  or original_checkpoint->>'graph_thread' is distinct from proof->>'graph_thread'
  or not exists(select 1 from public.proposal_issuance_requests previous_request where previous_request.id::text=original_checkpoint->>'issuance_request_id'
   and previous_request.workspace_id=p.workspace_id and previous_request.plan_id=p.id and previous_request.outcome='failed'
   and previous_request.error_code='MODEL_CORRECTION_EXHAUSTED') then raise exception 'COMMERCIAL_SUCCESSOR_NOT_SAFE';end if;
 -- Canonical retry briefly requeues/rebinds the old job in this transaction.
 -- Restore its original issuance/pins before making it a terminal predecessor.
 perform set_config('app.issuance_authorizing','true',true);
 update public.jobs set status='canceled',cancel_requested=true,error_code='COMMERCIAL_CONTEXT_SUPERSEDED',
  lease_token=null,lease_until=null,checkpoint=original_checkpoint,revision=revision+1,updated_at=now() where id=j.id;
 perform set_config('app.issuance_authorizing',coalesce(previous_issuance_setting,''),true);
 update public.generation_steps set status='split',revision=revision+1,updated_at=now() where id=s.id;
 child:=app_private.enqueue_generation(p,'plan_commercial',s.input||jsonb_build_object('commercial_input_version',2,
  'commercial_predecessor_job_id',j.id,'commercial_recovery_version',1),s.depth);
 select id into child_step from public.generation_steps where job_id=child and workspace_id=p.workspace_id;
 receipt:=(proof-'authorization')||jsonb_build_object('predecessor_checkpoint_hash',encode(sha256(convert_to(original_checkpoint::text,'UTF8')),'hex'),
  'predecessor_cancel_requested',successor_authorization->'predecessor_cancel_requested','predecessor_issuance_request_id',original_checkpoint->>'issuance_request_id');
 insert into app_private.commercial_successor_lineage(workspace_id,plan_id,predecessor_step_id,predecessor_job_id,successor_step_id,successor_job_id,
  predecessor_revision,predecessor_status,predecessor_error,input_hash,graph_thread,proof,proof_hash,issuance_request_id,authorized_by,operation,idempotency_key_hash)
 values(p.workspace_id,p.id,s.id,j.id,child_step,child,expected_revision-1,'failed','MODEL_CORRECTION_EXHAUSTED',p.input_hash,proof->>'graph_thread',receipt,
  encode(sha256(convert_to(receipt::text,'UTF8')),'hex'),i.id,actor,'generation.retry',successor_authorization->>'idempotency_key_hash');
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details)
 values(p.workspace_id,actor,'proposal.commercial.reprepare','generation_plan',p.id,jsonb_build_object(
  'predecessor_step_id',s.id,'predecessor_job_id',j.id,'successor_step_id',child_step,'successor_job_id',child,
  'commercial_input_version',2,'recovery_version',1,'proof_hash',encode(sha256(convert_to(receipt::text,'UTF8')),'hex'),
  'issuance_request_id',i.id,'preserved_completed_steps',true,'preserved_usage_and_budgets',true));
 return child;
exception when others then
 perform set_config('app.issuance_authorizing',coalesce(previous_issuance_setting,''),true);raise;
end$$;

alter function app_private.app_command(text,jsonb,text) rename to app_command_before_commercial_successor;
do $$declare definition text;begin
 definition:=pg_get_functiondef('app_private.app_command_before_commercial_successor(text,jsonb,text)'::regprocedure);
 -- PL/pgSQL's implicit outer block is named after the function. Preserve any
 -- qualified parameter references when moving the current canonical wrapper.
 execute replace(definition,'app_command.','app_command_before_commercial_successor.');
end$$;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.generation_plans;j public.jobs;s public.generation_steps;proof jsonb;command_result jsonb;child uuid;
 replayed boolean:=false;consider_successor boolean:=false;original_actor uuid:=auth.uid();
 previous_depth text:=current_setting('app.commercial_successor_depth',true);
 previous_authorizing text:=current_setting('app.commercial_successor_authorizing',true);
begin
 -- Recursive job.action -> generation.retry is deliberately not a direct
 -- commercial authorization. Restore the scoped marker on every exit.
 perform set_config('app.commercial_successor_depth',(coalesce(nullif(previous_depth,''),'0')::integer+1)::text,true);
 if coalesce(nullif(previous_depth,''),'0')='0' and operation='generation.retry' then
  select * into p from public.generation_plans where id=(input->>'id')::uuid;
  if p.id is not null and app_private.member_role(p.workspace_id) in ('Owner','Editor') then
   perform 1 from public.workspaces where id=p.workspace_id for update;
   select * into p from public.generation_plans where id=p.id for update;
   replayed:=exists(select 1 from app_private.idempotency_records where workspace_id=p.workspace_id and actor_id=original_actor
    and method='COMMAND' and route=operation and key=idempotency_key and expires_at>now());
   if not replayed and p.kind='proposal' and p.stage='commercial' then
    select * into s from public.generation_steps where plan_id=p.id and stage='commercial' and task='plan_commercial' and status='queued' order by ordinal limit 1;
    select * into j from public.jobs where id=s.job_id and workspace_id=p.workspace_id for update;
    consider_successor:=j.id is not null and j.status='failed' and j.error_code='MODEL_CORRECTION_EXHAUSTED';
    if consider_successor and j.lease_token is null and j.lease_until is null
     and exists(select 1 from public.proposal_issuance_requests previous_request where previous_request.id::text=j.checkpoint->>'issuance_request_id'
      and previous_request.workspace_id=p.workspace_id and previous_request.plan_id=p.id and previous_request.outcome='failed'
      and previous_request.error_code='MODEL_CORRECTION_EXHAUSTED') then
     proof:=app_private.commercial_successor_proof(j.id);
    end if;
   end if;
  end if;
 end if;
 -- Preserve canonical Auth, allowlist, revision, input/source/usage checks,
 -- idempotency and the one newly authorized 600-second issuance. Any refusal
 -- below rolls every canonical side effect back in the same transaction.
 command_result:=app_private.app_command_before_commercial_successor(operation,input,idempotency_key);
 if consider_successor then
  if app_private.member_role(p.workspace_id) is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
  if exists(select 1 from public.provider_usage where job_id=j.id and state in ('reserved','unknown')) then raise exception 'USAGE_REVIEW_REQUIRED';end if;
  if proof is null then raise exception 'COMMERCIAL_SUCCESSOR_NOT_SAFE';end if;
  proof:=proof||jsonb_build_object('authorization',jsonb_build_object('predecessor_revision',j.revision,
   'predecessor_status',j.status,'predecessor_error',j.error_code,'predecessor_checkpoint',j.checkpoint,'predecessor_cancel_requested',j.cancel_requested,
   'idempotency_key_hash',encode(sha256(convert_to(idempotency_key,'UTF8')),'hex')));
  perform set_config('app.commercial_successor_authorizing',j.id::text,true);
  child:=app_private.reprepare_commercial_successor(j.id,original_actor,j.revision+1,proof);
  perform set_config('app.commercial_successor_authorizing',coalesce(previous_authorizing,''),true);
  select to_jsonb(plan) into command_result from public.generation_plans plan where id=p.id;
  command_result:=command_result||jsonb_build_object('commercial_successor_job_id',child);
  update app_private.idempotency_records set result=command_result where workspace_id=p.workspace_id and actor_id=original_actor
   and method='COMMAND' and route=operation and key=idempotency_key;
 end if;
 perform set_config('app.commercial_successor_depth',coalesce(previous_depth,''),true);
 return command_result;
exception when others then
 perform set_config('app.commercial_successor_depth',coalesce(previous_depth,''),true);
 perform set_config('app.commercial_successor_authorizing',coalesce(previous_authorizing,''),true);raise;
end$$;

do $$declare signature text;role_name text;relation_name text;begin
 foreach relation_name in array array['app_private.commercial_successor_lineage','public.recovery_commercial_successor_lineage'] loop
  execute 'revoke all on '||relation_name||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on '||relation_name||' from '||quote_ident(role_name);end if;
  end loop;
 end loop;
 foreach signature in array array[
  'app_private.immutable_commercial_successor_lineage()',
  'app_private.commercial_candidate_contains(jsonb,text,integer)',
  'app_private.commercial_successor_proof(uuid)',
  'app_private.reprepare_commercial_successor(uuid,uuid,integer,jsonb)',
  'app_private.guard_commercial_worker_capability()',
  'app_private.app_command_before_commercial_successor(text,jsonb,text)',
  'app_private.app_command(text,jsonb,text)',
  'app_private.wake_backend_queue_checked_v6(uuid,uuid,bigint)',
  'public.claim_backend_job_v6()','public.claim_backend_local_job_v6()',
  'public.wake_backend_queue_status_v6(uuid,uuid)','public.wake_backend_queue_revision_v6(uuid,uuid,bigint)'] loop
  execute 'revoke all on function '||signature||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then
    execute 'revoke all on function '||signature||' from '||quote_ident(role_name);
    if signature like 'public.%' and role_name in ('service_role','tdp_app_service')
     or signature='app_private.app_command(text,jsonb,text)' and role_name in ('authenticated','tdp_app_authenticated') then
     execute 'grant execute on function '||signature||' to '||quote_ident(role_name);
    end if;
   end if;
  end loop;
 end loop;
end$$;
