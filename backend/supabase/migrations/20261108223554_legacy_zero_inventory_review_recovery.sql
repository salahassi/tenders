-- Explicitly recover the missing whole-proposal review in completed legacy
-- zero-inventory plans. Installation creates no jobs or customer records.
create table app_private.legacy_zero_inventory_review_lineage (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id),
 plan_id uuid not null,
 recovery_version integer not null default 1 check(recovery_version=1),
 original_base_version_id uuid,
 input_hash text not null check(input_hash ~ '^[a-f0-9]{64}$'),
 frozen_context_hash text not null check(frozen_context_hash ~ '^[a-f0-9]{64}$'),
 original_last_ordinal integer not null check(original_last_ordinal between 1 and 298),
 predecessor_version_id uuid not null,
 predecessor_version_hash text not null check(predecessor_version_hash ~ '^[a-f0-9]{64}$'),
 predecessor_sections_hash text not null check(predecessor_sections_hash ~ '^[a-f0-9]{64}$'),
 predecessor_proposal_revision integer not null,
 predecessor_projection_job_id uuid not null,
 predecessor_projection_job_hash text not null check(predecessor_projection_job_hash ~ '^[a-f0-9]{64}$'),
 saved_history jsonb not null check(jsonb_typeof(saved_history)='object' and pg_column_size(saved_history)<=65536),
 review_job_id uuid not null,
 review_step_id uuid not null,
 review_input_hash text not null check(review_input_hash ~ '^[a-f0-9]{64}$'),
 issuance_request_id uuid not null,
 authorized_by uuid not null,
 operation text not null check(operation='generation.retry'),
 idempotency_key_hash text not null check(idempotency_key_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default transaction_timestamp(),
 unique(workspace_id,plan_id,recovery_version),
 unique(workspace_id,review_job_id)
);
alter table app_private.legacy_zero_inventory_review_lineage enable row level security;
create function app_private.immutable_legacy_review_lineage() returns trigger
language plpgsql set search_path='' as $$begin raise exception 'LEGACY_REVIEW_LINEAGE_IMMUTABLE';end$$;
create trigger immutable_legacy_review_lineage before update or delete on app_private.legacy_zero_inventory_review_lineage
 for each row execute function app_private.immutable_legacy_review_lineage();
create view public.recovery_legacy_zero_inventory_review_lineage with(security_invoker=true) as
 select * from app_private.legacy_zero_inventory_review_lineage;
do $$declare definition text;marker text:='array[''recovery_commercial_successor_lineage'']::text[]';begin
 definition:=pg_get_functiondef('app_private.backup_tables()'::regprocedure);
 if length(definition)-length(replace(definition,marker,''))<>length(marker) then raise exception 'LEGACY_REVIEW_BACKUP_REGISTRY_CHANGED';end if;
 execute replace(definition,marker,marker||'||array[''recovery_legacy_zero_inventory_review_lineage'']::text[]');
end$$;

-- Hash only the pre-recovery range. Newly accepted review/assembly rows must
-- never make old history appear changed, and a missing old row must not pass.
create function app_private.legacy_review_history(target_plan uuid,last_ordinal integer) returns jsonb
language sql stable security definer set search_path='' as $$
 with old_steps as materialized (
  select * from public.generation_steps where plan_id=target_plan and ordinal<=last_ordinal
 ), old_jobs as materialized (
  select j.* from public.jobs j join old_steps s on s.job_id=j.id and s.workspace_id=j.workspace_id
 ), old_threads as materialized (
  select g.* from app_private.model_graph_threads g join old_jobs j on j.id=g.job_id and j.workspace_id=g.workspace_id
 ), receipts as (
  select s.id,s.task,g.id thread_id,g.input_hash graph_input_hash,a.id accepted_id,a.content_hash accepted_hash,
   c.id verification_id,c.content_hash verification_hash,cp.checkpoint_id,
   encode(sha256(convert_to(cp.checkpoint::text,'UTF8')),'hex') checkpoint_hash,
   coalesce(g.status in ('accepted','committed') and a.result_key='accepted' and a.value=s.output
    and a.content_hash=encode(sha256(convert_to(a.value::text,'UTF8')),'hex')
    and c.content_hash=encode(sha256(convert_to(c.value::text,'UTF8')),'hex')
    and coalesce(c.value->>'coverage','')<>'repair_only'
    and c.value#>>'{result,reviewed_all_content}'='true'
    and c.value#>>'{result,checked_candidate_hash}' ~ '^[a-f0-9]{64}$',false) valid
  from old_steps s join old_jobs j on j.id=s.job_id
  left join old_threads g on g.id=j.checkpoint->>'graph_thread' and g.job_id=j.id
  left join app_private.model_graph_results a on a.thread_id=g.id and a.id=g.result_id
  left join lateral (select checkpoint_id,checkpoint from app_private.model_graph_checkpoints where thread_id=g.id and namespace='' order by checkpoint_id desc limit 1) cp on true
  left join app_private.model_graph_results c on c.thread_id=g.id and c.id::text=app_private.model_graph_checkpoint_report_ref(cp.checkpoint)
  where s.status='completed' and s.task<>'advance_plan'
 )
 select jsonb_build_object(
  'step_count',(select count(*) from old_steps),
  'accepted_count',(select count(*) from receipts),
  'receipts_complete',(select coalesce(bool_and(valid),false) from receipts),
  'steps_hash',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(s) order by ordinal,id),'[]')::text,'UTF8')),'hex') from old_steps s),
  'jobs_hash',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(j) order by id),'[]')::text,'UTF8')),'hex') from old_jobs j),
  'graphs_hash',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(g) order by id),'[]')::text,'UTF8')),'hex') from old_threads g),
  'receipts_hash',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by id),'[]')::text,'UTF8')),'hex') from receipts r),
  'results_hash',(select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(r.id,r.thread_id,r.result_key,r.content_hash) order by r.id),'[]')::text,'UTF8')),'hex') from app_private.model_graph_results r join old_threads g on g.id=r.thread_id),
  'budgets_hash',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(b) order by b.thread_id,b.unit),'[]')::text,'UTF8')),'hex') from app_private.model_graph_budgets b join old_threads g on g.id=b.thread_id),
  'usage_hash',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(u) order by u.id),'[]')::text,'UTF8')),'hex') from public.provider_usage u join old_jobs j on j.id=u.job_id),
  'attempts_hash',(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]')::text,'UTF8')),'hex') from public.model_attempts a join old_jobs j on j.id=a.job_id)
 )
$$;

create function app_private.legacy_review_recovery_proof(target_plan uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.generation_plans;prop public.proposals;v public.proposal_versions;j public.jobs;
 history jsonb;last_ordinal integer;section_keys jsonb;sections_hash text;sources jsonb;manifest jsonb;ref jsonb;
 current_documents jsonb;saved_documents jsonb;
begin
 select * into p from public.generation_plans where id=target_plan;
 select * into prop from public.proposals where id=p.proposal_id and workspace_id=p.workspace_id;
 select * into v from public.proposal_versions where id=prop.active_version_id and workspace_id=p.workspace_id and plan_id=p.id;
 if p.id is null or p.kind is distinct from 'proposal' or p.workflow_version<>1 or p.stage is distinct from 'completed'
  or p.status is distinct from 'failed' or p.error_code is distinct from 'GENERATED_DELIVERY_VALIDATION_FAILED'
  or p.frozen_context->'generated_delivery_version' is distinct from '3'::jsonb
  or p.frozen_context->'proposal_consistency_version' is distinct from '1'::jsonb
  or v.id is null or v.status is distinct from 'draft'
  or exists(select 1 from app_private.legacy_zero_inventory_review_lineage where workspace_id=p.workspace_id and plan_id=p.id)
  or exists(select 1 from public.requirements where workspace_id=p.workspace_id and plan_id=p.id)
  or exists(select 1 from public.generation_steps where workspace_id=p.workspace_id and plan_id=p.id and (task='review_proposal' or status not in ('completed','split')))
  or not exists(select 1 from public.generation_steps where plan_id=p.id and task='draft_section' and status='completed')
  or not exists(select 1 from public.generation_steps where plan_id=p.id and task='plan_commercial' and status='completed')
  or exists(select 1 from public.generation_plans newer where newer.workspace_id=p.workspace_id and newer.opportunity_id=p.opportunity_id and newer.kind=p.kind and (newer.created_at,newer.id)>(p.created_at,p.id))
  or exists(select 1 from public.proposal_issuance_requests where plan_id=p.id and outcome='issued') then return null;end if;
 select * into j from public.jobs where workspace_id=p.workspace_id and entity_id=p.id and type='prepare_generated_delivery'
  and checkpoint->>'generated_version_id'=v.id::text and checkpoint->>'generated_version_hash'=v.content_hash;
 if j.id is null or j.status is distinct from 'failed' or j.error_code is distinct from 'GENERATED_DELIVERY_VALIDATION_FAILED'
  or j.input_hash is distinct from p.input_hash or j.lease_token is not null or j.lease_until is not null
  or not exists(select 1 from public.proposal_issuance_requests i where i.id=p.issuance_request_id and i.id::text=j.checkpoint->>'issuance_request_id'
   and i.workspace_id=p.workspace_id and i.plan_id=p.id and i.outcome='failed' and i.error_code='GENERATED_DELIVERY_VALIDATION_FAILED') then return null;end if;
 if exists(select 1 from public.jobs where workspace_id=p.workspace_id and entity_id=p.id and status in ('queued','running','retry_wait','quota_wait','blocked')) then raise exception 'GENERATION_BUSY';end if;
 -- Canonical admission below applies the modern route's scoped unknown-usage
 -- policy to the fresh review. Historical unknown usage remains unchanged.
 if exists(select 1 from public.provider_usage where workspace_id=p.workspace_id and state='reserved') then raise exception 'USAGE_REVIEW_REQUIRED';end if;
 if p.evidence_revision is distinct from (select evidence_revision from public.workspaces where id=p.workspace_id) then raise exception 'STALE_INPUT';end if;
 perform app_private.assert_plan_source_resolution(p.id);
 sources:=jsonb_build_array(p.frozen_context->'notice')||coalesce(p.frozen_context->'blocks','[]')||coalesce(p.frozen_context->'knowledge','[]')||coalesce(p.frozen_context->'reviews','[]')||coalesce(p.frozen_context->'rates','[]');
 select coalesce(jsonb_agg(distinct x->'reference'),'[]') into manifest from jsonb_array_elements(sources) x where x ? 'reference';
 perform app_private.check_delivery_sources(p.workspace_id,manifest);
 perform app_private.check_delivery_materials(p.workspace_id,p.frozen_context->'input_materials');
 select coalesce(jsonb_agg(x->>'document_id' order by x->>'document_id'),'[]') into current_documents from jsonb_array_elements(app_private.delivery_input(p.workspace_id,p.opportunity_id)#>'{input_materials,documents}') x;
 select coalesce(jsonb_agg(x->>'document_id' order by x->>'document_id'),'[]') into saved_documents from jsonb_array_elements(coalesce(p.frozen_context#>'{input_materials,documents}','[]')) x;
 if current_documents is distinct from saved_documents then raise exception 'STALE_INPUT';end if;
 for ref in select value from jsonb_array_elements(manifest) where value->>'entity_kind'='document' loop
  if app_private.current_document_extraction(p.workspace_id,(ref->>'entity_id')::uuid) is distinct from (ref->>'entity_id')::uuid then raise exception 'STALE_INPUT';end if;
 end loop;
 select max(ordinal) into last_ordinal from public.generation_steps where plan_id=p.id;
 if last_ordinal is null or last_ordinal>298 then return null;end if;
 history:=app_private.legacy_review_history(p.id,last_ordinal);
 if history->'receipts_complete' is distinct from 'true'::jsonb then return null;end if;
 -- The accepted version must still be the local projection of those exact
 -- drafts and fixed template blocks, rather than independently edited prose.
 if exists(
  with expected as (
   select row_number() over(order by s.ordinal,s.id)-1 ordinal,s.input#>>'{section,key}' section_key,
    s.input#>>'{section,title}' title,s.input#>>'{section,volume}' volume,s.output->'content_blocks' content_blocks,
    s.output->'requirement_ids' requirement_ids,s.output->'evidence_refs' evidence_refs,false fixed,
    (select string_agg(case b->>'type' when 'table' then
      (select string_agg((select string_agg(cell,' | ' order by cell_n) from jsonb_array_elements_text(row_value) with ordinality cells(cell,cell_n)),E'\n' order by row_n)
       from jsonb_array_elements(jsonb_build_array(b->'headers')||(b->'rows')) with ordinality rows(row_value,row_n))
     when 'bullet' then '• '||(b->>'text') else b->>'text' end,E'\n\n' order by block_n)
     from jsonb_array_elements(s.output->'content_blocks') with ordinality blocks(b,block_n)) body
   from public.generation_steps s where s.workspace_id=p.workspace_id and s.plan_id=p.id and s.task='draft_section' and s.status='completed'
   union all
   select (select count(*) from public.generation_steps where plan_id=p.id and task='draft_section' and status='completed')+n-1,
    'fixed-'||(f->>'key'),f->>'title',f->>'volume',jsonb_build_array(jsonb_build_object('type','paragraph','text',f->>'body')),'[]'::jsonb,'[]'::jsonb,true,f->>'body'
   from jsonb_array_elements(coalesce(p.frozen_context#>'{template,fixed_blocks}','[]')) with ordinality fixed(f,n)
  )
  select 1 from expected e full join (select * from public.proposal_sections where workspace_id=p.workspace_id and proposal_version_id=v.id) actual using(section_key)
  where e.section_key is null or actual.id is null
   or row(e.ordinal,e.title,e.volume,e.content_blocks,e.requirement_ids,e.evidence_refs,e.fixed,e.body)
    is distinct from row(actual.ordinal::bigint,actual.title,actual.volume,actual.content_blocks,actual.requirement_ids,actual.evidence_refs,actual.fixed,actual.body)
 ) then return null;end if;
 if v.commercial_draft is distinct from jsonb_build_object('lines',
   (select coalesce(jsonb_agg(x.line order by s.ordinal,x.n),'[]') from public.generation_steps s cross join lateral jsonb_array_elements(s.output->'lines') with ordinality x(line,n) where s.plan_id=p.id and s.task='plan_commercial' and s.status='completed'),
   'tasks',(select coalesce(jsonb_agg(x.task order by s.ordinal,x.n),'[]') from public.generation_steps s cross join lateral jsonb_array_elements(s.output->'tasks') with ordinality x(task,n) where s.plan_id=p.id and s.task='plan_commercial' and s.status='completed'),
   'confirmed',false) then return null;end if;
 select jsonb_agg(section_key order by first_ordinal,section_key) into section_keys
 from (select section_key,min(ordinal) first_ordinal from public.proposal_sections where workspace_id=p.workspace_id and proposal_version_id=v.id group by section_key) keys;
 if section_keys is null or jsonb_array_length(section_keys) not between 1 and 2000 or exists(select 1 from jsonb_array_elements_text(section_keys) key where length(trim(key))=0) then return null;end if;
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(s) order by ordinal,id),'[]')::text,'UTF8')),'hex') into sections_hash from public.proposal_sections s where workspace_id=p.workspace_id and proposal_version_id=v.id;
 return jsonb_build_object('plan_id',p.id,'workspace_id',p.workspace_id,'original_base_version_id',p.base_version_id,
  'input_hash',p.input_hash,'frozen_context_hash',encode(sha256(convert_to(p.frozen_context::text,'UTF8')),'hex'),
  'last_ordinal',last_ordinal,'predecessor_version_id',v.id,'predecessor_version_hash',encode(sha256(convert_to(to_jsonb(v)::text,'UTF8')),'hex'),
  'predecessor_sections_hash',sections_hash,'predecessor_proposal_revision',prop.revision,
  'predecessor_projection_job_id',j.id,'predecessor_projection_job_hash',encode(sha256(convert_to(to_jsonb(j)::text,'UTF8')),'hex'),
  'saved_history',history,'section_keys',section_keys);
end$$;

-- The original generation base remains immutable. Only the recorded review
-- and its following assembly may read against the pinned accepted version.
create function app_private.legacy_review_base_current(p public.generation_plans,target_job uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare receipt app_private.legacy_zero_inventory_review_lineage;prop public.proposals;v public.proposal_versions;
 s public.generation_steps;review public.generation_steps;sections_hash text;
begin
 select * into receipt from app_private.legacy_zero_inventory_review_lineage where workspace_id=p.workspace_id and plan_id=p.id;
 if receipt.id is null or p.kind<>'proposal' or p.workflow_version<>1 or p.stage<>'review'
  or p.status not in ('queued','running','blocked') or p.base_version_id is distinct from receipt.original_base_version_id
  or p.input_hash is distinct from receipt.input_hash or encode(sha256(convert_to(p.frozen_context::text,'UTF8')),'hex')<>receipt.frozen_context_hash
  or exists(select 1 from public.requirements where workspace_id=p.workspace_id and plan_id=p.id) then return false;end if;
 select * into prop from public.proposals where id=p.proposal_id and workspace_id=p.workspace_id;
 select * into v from public.proposal_versions where id=prop.active_version_id and workspace_id=p.workspace_id and plan_id=p.id;
 if v.id is distinct from receipt.predecessor_version_id or prop.revision is distinct from receipt.predecessor_proposal_revision
  or encode(sha256(convert_to(to_jsonb(v)::text,'UTF8')),'hex') is distinct from receipt.predecessor_version_hash then return false;end if;
 select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(x) order by ordinal,id),'[]')::text,'UTF8')),'hex') into sections_hash
 from public.proposal_sections x where workspace_id=p.workspace_id and proposal_version_id=v.id;
 if sections_hash is distinct from receipt.predecessor_sections_hash
  or app_private.legacy_review_history(p.id,receipt.original_last_ordinal) is distinct from receipt.saved_history then return false;end if;
 select * into review from public.generation_steps where id=receipt.review_step_id and job_id=receipt.review_job_id and workspace_id=p.workspace_id and plan_id=p.id;
 select * into s from public.generation_steps where job_id=target_job and workspace_id=p.workspace_id and plan_id=p.id;
 if review.id is null or review.task<>'review_proposal' or review.stage<>'review'
  or encode(sha256(convert_to(review.input::text,'UTF8')),'hex') is distinct from receipt.review_input_hash
  or review.input->'legacy_zero_inventory_review_version' is distinct from '1'::jsonb then return false;end if;
 return coalesce(s.id=review.id and s.status='queued'
  or s.task='advance_plan' and s.stage='review' and s.status='queued' and s.ordinal=review.ordinal+1 and review.status='completed'
   and exists(select 1 from public.jobs j join app_private.model_graph_threads g on g.id=j.checkpoint->>'graph_thread' and g.job_id=j.id
    join app_private.model_graph_results r on r.id=g.result_id and r.thread_id=g.id
    where j.id=review.job_id and j.status='succeeded' and g.status in ('accepted','committed') and r.result_key='accepted' and r.value=review.output),false);
end$$;

do $$declare definition text;marker text;begin
 definition:=pg_get_functiondef('public.generation_context_before_details(uuid,uuid)'::regprocedure);
 marker:='if p.proposal_id is not null and p.base_version_id is distinct from (select active_version_id from public.proposals where id=p.proposal_id) then raise exception ''STALE_INPUT'';end if;';
 if length(definition)-length(replace(definition,marker,''))<>length(marker) then raise exception 'LEGACY_REVIEW_BASE_GUARD_CHANGED';end if;
 execute replace(definition,marker,replace(marker,' then raise exception',' and not app_private.legacy_review_base_current(p,j.id) then raise exception'));
 definition:=pg_get_functiondef('public.advance_generation_before_generated_delivery(uuid,uuid,text,jsonb,jsonb,jsonb)'::regprocedure);
 marker:='from public.generation_plans g where v.plan_id=plan and g.id=v.plan_id and g.frozen_context->''proposal_consistency_version''=''1''::jsonb;';
 if length(definition)-length(replace(definition,marker,''))<>length(marker) then raise exception 'LEGACY_REVIEW_VERSION_UPDATE_CHANGED';end if;
 execute replace(definition,marker,replace(marker,' and g.frozen_context',' and v.id=(select active_version_id from public.proposals where id=g.proposal_id and workspace_id=g.workspace_id) and g.frozen_context'));
end$$;

-- Stamp only newly enqueued marked review work; old queued input/pins stay put.
do $$declare definition text;marker text;begin
 definition:=pg_get_functiondef('app_private.enqueue_generation(public.generation_plans,text,jsonb,integer)'::regprocedure);
 marker:='case when task=''plan_commercial'' then ''{"commercial_input_version":2,"minimum_worker_executor":6}''::jsonb else ''{}''::jsonb end';
 if length(definition)-length(replace(definition,marker,''))<>length(marker) then raise exception 'LEGACY_REVIEW_ENQUEUE_CHANGED';end if;
 execute replace(definition,marker,replace(marker,' else ', ' when task=''review_proposal'' and input->''legacy_zero_inventory_review_version''=''1''::jsonb then ''{"legacy_zero_inventory_review_version":1,"minimum_worker_executor":7}''::jsonb else '));
end$$;
create function app_private.guard_legacy_review_worker_capability() returns trigger
language plpgsql set search_path='' as $$begin
 if new.type='review_proposal' and new.checkpoint->'legacy_zero_inventory_review_version'='1'::jsonb
  or tg_op='INSERT' and new.type in ('advance_plan','prepare_generated_delivery') and exists(
   select 1 from public.generation_plans p where p.workspace_id=new.workspace_id and p.id=new.entity_id and p.kind='proposal' and p.workflow_version=1
    and not exists(select 1 from public.requirements where workspace_id=p.workspace_id and plan_id=p.id)
    and (new.type='advance_plan' and p.stage in ('commercial','review')
     or exists(select 1 from public.generation_steps s where s.workspace_id=p.workspace_id and s.plan_id=p.id and s.task='review_proposal' and s.input->'legacy_zero_inventory_review_version'='1'::jsonb))) then
  new.checkpoint:=new.checkpoint||jsonb_build_object('minimum_worker_executor',greatest(7,coalesce((new.checkpoint->>'minimum_worker_executor')::integer,1)));
 end if;
 return new;
end$$;
create trigger zzzzzz_legacy_review_worker_capability before insert or update on public.jobs
 for each row execute function app_private.guard_legacy_review_worker_capability();

-- Old queued commercial transitions also need the corrected review planner.
-- Apply that capability at read time; never rewrite their frozen checkpoints.
create function app_private.minimum_legacy_review_executor(j public.jobs) returns integer
language sql stable security definer set search_path='' as $$
 select case when j.type='advance_plan' and exists(
  select 1 from public.generation_plans p join public.generation_steps s on s.workspace_id=p.workspace_id and s.plan_id=p.id and s.job_id=j.id
  where p.workspace_id=j.workspace_id and p.id=j.entity_id and p.kind='proposal' and p.workflow_version=1
   and p.stage='commercial' and s.stage='commercial' and s.task='advance_plan' and s.status='queued'
   and not exists(select 1 from public.requirements where workspace_id=p.workspace_id and plan_id=p.id)) then 7 else 1 end
$$;
do $$declare definition text;signature text;alias_name text;marker text;begin
 foreach signature in array array['app_private.next_fair_job(uuid,boolean)',
  'app_private.wake_backend_queue_checked(uuid,uuid,bigint)','app_private.wake_backend_queue_checked_v3(uuid,uuid,bigint)',
  'app_private.wake_backend_queue_checked_v4(uuid,uuid,bigint)','app_private.wake_backend_queue_checked_v5(uuid,uuid,bigint)',
  'app_private.wake_backend_queue_checked_v6(uuid,uuid,bigint)'] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  foreach alias_name in array case when signature='app_private.next_fair_job(uuid,boolean)' then array['q'] else array['q','j','ready'] end loop
   marker:='greatest(coalesce(('||alias_name||'.checkpoint->>''model_executor'')::int,1),coalesce(('||alias_name||'.checkpoint->>''minimum_worker_executor'')::int,1))';
   if position(marker in definition)=0 then raise exception 'LEGACY_REVIEW_DYNAMIC_FLOOR_CHANGED: % %',signature,alias_name;end if;
   definition:=replace(definition,marker,'greatest('||marker||',app_private.minimum_legacy_review_executor('||alias_name||'))');
  end loop;
  execute definition;
 end loop;
end$$;

create function public.claim_backend_job_v7() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;previous text:=current_setting('app.worker_executor',true);begin
 perform set_config('app.worker_executor','7',true);result:=public.claim_backend_job();
 perform set_config('app.worker_executor',coalesce(previous,''),true);return result;
exception when others then perform set_config('app.worker_executor',coalesce(previous,''),true);raise;
end$$;
create function public.claim_backend_local_job_v7() returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;previous text:=current_setting('app.queue_local_only',true);begin
 perform set_config('app.queue_local_only','true',true);result:=public.claim_backend_job_v7();
 perform set_config('app.queue_local_only',coalesce(previous,''),true);return result;
exception when others then perform set_config('app.queue_local_only',coalesce(previous,''),true);raise;
end$$;
do $$declare definition text;begin
 definition:=pg_get_functiondef('app_private.wake_backend_queue_checked_v6(uuid,uuid,bigint)'::regprocedure);
 if position('<=6' in definition)=0 then raise exception 'WORKER_SEVEN_WAKE_CAPABILITY_CHANGED';end if;
 execute replace(replace(definition,'app_private.wake_backend_queue_checked_v6(','app_private.wake_backend_queue_checked_v7('),'<=6','<=7');
end$$;
create function public.wake_backend_queue_status_v7(job_id uuid,lease uuid) returns jsonb
language sql security definer set search_path='' as $$select app_private.wake_backend_queue_checked_v7(job_id,lease,null)$$;
create function public.wake_backend_queue_revision_v7(job_id uuid,lease uuid,expected_revision bigint) returns jsonb
language sql security definer set search_path='' as $$select case when expected_revision is null then '{"dispatched":false}'::jsonb else app_private.wake_backend_queue_checked_v7(job_id,lease,expected_revision) end$$;

alter function app_private.app_command(text,jsonb,text) rename to app_command_before_legacy_review_recovery;
do $$declare definition text;begin
 definition:=pg_get_functiondef('app_private.app_command_before_legacy_review_recovery(text,jsonb,text)'::regprocedure);
 execute replace(definition,'app_command.','app_command_before_legacy_review_recovery.');
end$$;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.generation_plans;original_plan public.generation_plans;prop public.proposals;v public.proposal_versions;j public.jobs;
 review public.generation_steps;issuance public.proposal_issuance_requests;replay app_private.idempotency_records;
 proof jsonb;review_input jsonb;command_result jsonb;review_job uuid;receipt_id uuid;sections_hash text;
 actor uuid:=auth.uid();recover boolean:=false;previous_depth text:=current_setting('app.legacy_review_recovery_depth',true);
begin
 perform set_config('app.legacy_review_recovery_depth',(coalesce(nullif(previous_depth,''),'0')::integer+1)::text,true);
 if coalesce(nullif(previous_depth,''),'0')='0' and operation='generation.retry' then
  select * into p from public.generation_plans where id=(input->>'id')::uuid;
  if p.id is not null and app_private.member_role(p.workspace_id) is not null then
   perform 1 from public.workspaces where id=p.workspace_id for update;
   select * into p from public.generation_plans where id=p.id for update;
   select * into replay from app_private.idempotency_records where workspace_id=p.workspace_id and actor_id=actor
    and method='COMMAND' and route=operation and key=idempotency_key and expires_at>now();
   if replay.key is not null and replay.result ? 'legacy_review_recovery_id' then
    perform app_private.delivery_actor(p.workspace_id,actor,true);
    if app_private.member_role(p.workspace_id) is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
    if replay.body_hash is distinct from encode(sha256(convert_to(input::text,'UTF8')),'hex') then raise exception 'IDEMPOTENCY_CONFLICT';end if;
    perform set_config('app.legacy_review_recovery_depth',coalesce(previous_depth,''),true);return replay.result;
   end if;
   recover:=replay.key is null and p.kind='proposal' and p.workflow_version=1 and p.stage='completed'
    and p.status='failed' and p.error_code='GENERATED_DELIVERY_VALIDATION_FAILED';
   if recover then
    perform app_private.delivery_actor(p.workspace_id,actor,true);
    if app_private.member_role(p.workspace_id) is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
    perform app_private.check_keys(input,array['id','expected_revision','reason']);
    if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(input)>1048576 then raise exception 'INVALID_INPUT';end if;
    if length(trim(coalesce(input->>'reason','')))=0 then raise exception 'REASON_REQUIRED';end if;
    if p.revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT';end if;
    select * into prop from public.proposals where id=p.proposal_id and workspace_id=p.workspace_id for update;
    perform 1 from public.jobs where workspace_id=p.workspace_id and entity_id=p.id order by id for update;
    proof:=app_private.legacy_review_recovery_proof(p.id);
    if proof is null then raise exception 'LEGACY_REVIEW_RECOVERY_NOT_SAFE';end if;
    original_plan:=p;
    review_input:=jsonb_build_object('requirement_ids','[]'::jsonb,'legacy_zero_inventory_review_version',1,
     'review_scope_version',1,'review_source_version',1,'coherence_review',true,'section_keys',proof->'section_keys');
    -- The canonical retry below owns revision, consent, usage admission and the
    -- new 600-second request. Only the missing stage is appended beforehand.
    update public.generation_plans set stage='review',status='blocked' where id=p.id returning * into p;
    p.created_by:=actor;
    review_job:=app_private.enqueue_generation(p,'review_proposal',review_input);
   end if;
  end if;
 end if;
 command_result:=app_private.app_command_before_legacy_review_recovery(operation,input,idempotency_key);
 if recover then
  select * into p from public.generation_plans where id=original_plan.id;
  select * into review from public.generation_steps where workspace_id=p.workspace_id and plan_id=p.id and job_id=review_job;
  select * into j from public.jobs where id=review_job;
  select * into issuance from public.proposal_issuance_requests where id=p.issuance_request_id;
  select * into prop from public.proposals where id=p.proposal_id and workspace_id=p.workspace_id;
  select * into v from public.proposal_versions where id=prop.active_version_id and workspace_id=p.workspace_id;
  select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(x) order by ordinal,id),'[]')::text,'UTF8')),'hex') into sections_hash
   from public.proposal_sections x where workspace_id=p.workspace_id and proposal_version_id=v.id;
  if p.stage is distinct from 'review' or p.status is distinct from 'queued' or p.revision<>original_plan.revision+1
   or p.base_version_id is distinct from original_plan.base_version_id or p.input_hash is distinct from original_plan.input_hash
   or p.frozen_context is distinct from original_plan.frozen_context or p.workflow_version is distinct from original_plan.workflow_version
   or p.created_by is distinct from original_plan.created_by or prop.revision is distinct from (proof->>'predecessor_proposal_revision')::integer
   or v.id is distinct from (proof->>'predecessor_version_id')::uuid
   or encode(sha256(convert_to(to_jsonb(v)::text,'UTF8')),'hex') is distinct from proof->>'predecessor_version_hash'
   or sections_hash is distinct from proof->>'predecessor_sections_hash'
   or app_private.legacy_review_history(p.id,(proof->>'last_ordinal')::integer) is distinct from proof->'saved_history'
   or (select encode(sha256(convert_to(to_jsonb(old_job)::text,'UTF8')),'hex') from public.jobs old_job where id=(proof->>'predecessor_projection_job_id')::uuid) is distinct from proof->>'predecessor_projection_job_hash'
   or review.id is null or review.ordinal<>(proof->>'last_ordinal')::integer+1 or review.input is distinct from review_input or review.status is distinct from 'queued'
   or j.status is distinct from 'queued' or j.cancel_requested or j.lease_token is not null or j.lease_until is not null
   or j.checkpoint->>'minimum_worker_executor' is distinct from '7' or j.checkpoint->>'issuance_request_id' is distinct from issuance.id::text
   or issuance.id is null or issuance.id=original_plan.issuance_request_id or issuance.workspace_id<>p.workspace_id or issuance.plan_id<>p.id
   or issuance.requested_by is distinct from actor or issuance.operation is distinct from operation or issuance.idempotency_key is distinct from idempotency_key
   or issuance.outcome is distinct from 'active' or issuance.accepted_at is distinct from transaction_timestamp()
   or issuance.deadline_at is distinct from issuance.accepted_at+interval '600 seconds'
   or (select count(*) from public.generation_steps where plan_id=p.id and ordinal>(proof->>'last_ordinal')::integer)<>1 then
    raise exception 'LEGACY_REVIEW_RECOVERY_NOT_SAFE';
  end if;
  insert into app_private.legacy_zero_inventory_review_lineage(workspace_id,plan_id,original_base_version_id,input_hash,frozen_context_hash,
   original_last_ordinal,predecessor_version_id,predecessor_version_hash,predecessor_sections_hash,predecessor_proposal_revision,
   predecessor_projection_job_id,predecessor_projection_job_hash,saved_history,review_job_id,review_step_id,review_input_hash,
   issuance_request_id,authorized_by,operation,idempotency_key_hash)
  values(p.workspace_id,p.id,original_plan.base_version_id,p.input_hash,proof->>'frozen_context_hash',(proof->>'last_ordinal')::integer,
   v.id,proof->>'predecessor_version_hash',proof->>'predecessor_sections_hash',prop.revision,
   (proof->>'predecessor_projection_job_id')::uuid,proof->>'predecessor_projection_job_hash',proof->'saved_history',review_job,review.id,
   encode(sha256(convert_to(review_input::text,'UTF8')),'hex'),issuance.id,actor,operation,encode(sha256(convert_to(idempotency_key,'UTF8')),'hex')) returning id into receipt_id;
  command_result:=to_jsonb(p)||jsonb_build_object('legacy_review_recovery_id',receipt_id,'legacy_review_job_id',review_job);
  update app_private.idempotency_records set result=command_result where workspace_id=p.workspace_id and actor_id=actor
   and method='COMMAND' and route=operation and key=idempotency_key;
  insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details)
   values(p.workspace_id,actor,'generation.legacy_review_recovered','generation_plan',p.id,
    jsonb_build_object('recovery_id',receipt_id,'predecessor_version_id',v.id,'review_job_id',review_job,'issuance_request_id',issuance.id,'recovery_version',1));
 end if;
 perform set_config('app.legacy_review_recovery_depth',coalesce(previous_depth,''),true);return command_result;
exception when others then
 perform set_config('app.legacy_review_recovery_depth',coalesce(previous_depth,''),true);raise;
end$$;

do $$declare signature text;role_name text;relation_name text;begin
 foreach relation_name in array array['app_private.legacy_zero_inventory_review_lineage','public.recovery_legacy_zero_inventory_review_lineage'] loop
  execute 'revoke all on '||relation_name||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on '||relation_name||' from '||quote_ident(role_name);end if;
  end loop;
 end loop;
 foreach signature in array array[
  'app_private.immutable_legacy_review_lineage()',
  'app_private.legacy_review_history(uuid,integer)',
  'app_private.legacy_review_recovery_proof(uuid)',
  'app_private.legacy_review_base_current(public.generation_plans,uuid)',
  'app_private.guard_legacy_review_worker_capability()',
  'app_private.minimum_legacy_review_executor(public.jobs)',
  'app_private.app_command_before_legacy_review_recovery(text,jsonb,text)',
  'app_private.app_command(text,jsonb,text)',
  'app_private.wake_backend_queue_checked_v7(uuid,uuid,bigint)',
  'public.claim_backend_job_v7()','public.claim_backend_local_job_v7()',
  'public.wake_backend_queue_status_v7(uuid,uuid)','public.wake_backend_queue_revision_v7(uuid,uuid,bigint)'] loop
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
