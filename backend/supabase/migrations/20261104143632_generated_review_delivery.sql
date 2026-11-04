-- Automatic completed-response delivery has its own version and assurance.
-- Historical provisional (1) and explicitly human-authored (2) payloads remain
-- unchanged. A file is not final approval or a human semantic review.
alter table public.proposal_delivery_snapshots drop constraint delivery_payload_assurance_version;
alter table public.proposal_delivery_snapshots add constraint delivery_payload_assurance_version check(
 payload->>'approval_state'='draft' and ((payload->'version'='1'::jsonb and payload->'substantive_complete'='false'::jsonb)
 or (payload->'version'='2'::jsonb and payload->>'content_state' in ('authored_draft','substantive_draft') and payload->'substantive_complete'=to_jsonb(payload->>'content_state'='substantive_draft') and (payload->'substantive_complete'='false'::jsonb or (payload->>'assurance_state'='human_reviewed' and payload#>>'{authoring,review_id}' is not null)))
 or (payload->'version'='3'::jsonb and payload->>'content_state'='generated_review_draft' and payload->>'assurance_state' in ('model_checked','source_review_required') and payload->'substantive_complete'='false'::jsonb and payload#>>'{generation,machine_validation,policy}'='generated-delivery-v1' and payload#>'{generation,machine_validation,passed}'='true'::jsonb)));
alter table public.proposal_delivery_artifacts drop constraint proposal_delivery_artifacts_renderer_version_check;
alter table public.proposal_delivery_artifacts add constraint proposal_delivery_artifacts_renderer_version_check check(renderer_version in ('1','2','3'));
create or replace function app_private.delivery_renderer(s public.proposal_delivery_snapshots) returns text language sql immutable set search_path='' as $$select case s.payload->>'version' when '1' then '1' when '2' then '2' when '3' then '3' end$$;
create or replace function app_private.delivery_executor(s public.proposal_delivery_snapshots) returns integer language sql immutable set search_path='' as $$select case s.payload->>'version' when '1' then 3 when '2' then 4 when '3' then 4 end$$;

create function app_private.delivery_input_review_complete(w uuid,materials jsonb) returns boolean language sql stable security definer set search_path='' as $$
 select not exists(select 1 from jsonb_array_elements(coalesce(materials->'documents','[]')) m left join public.documents d on d.workspace_id=w and d.id=(m->>'document_id')::uuid
 where d.id is null or d.archived or d.status<>'ready' or m->'used_for_draft'='false'::jsonb or m->'requires_human_review'='true'::jsonb or to_jsonb(d)#>'{extraction_coverage,complete}'='false'::jsonb
 or (to_jsonb(d)#>'{ocr_provenance,requires_human_review}'='true'::jsonb and d.extraction_confirmed_at is null))
$$;
alter function app_private.authoring_context(uuid,uuid) rename to authoring_context_before_extraction_qualification;
create function app_private.authoring_context(session_id uuid,actor_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$declare result jsonb;qualified boolean;begin
 result:=app_private.authoring_context_before_extraction_qualification(session_id,actor_id);
 qualified:=app_private.delivery_input_review_complete((result#>>'{session,workspace_id}')::uuid,result#>'{snapshot,payload,input_materials}');
 return result||jsonb_build_object('input_review_complete',qualified,'context_hash',encode(sha256(convert_to(jsonb_build_array(result->>'context_hash',qualified)::text,'UTF8')),'hex'));
end $$;
do $$declare definition text;marker text;begin
 select pg_get_functiondef('public.publish_authored_delivery(uuid,uuid,integer,text,jsonb,jsonb,text)'::regprocedure) into definition;
 marker:='if payload->>''substantive_complete''=''true'' and (';
 if position(marker in definition)=0 then raise exception 'AUTHORING_QUALIFICATION_PUBLISH_CHANGED';end if;
 execute replace(definition,marker,marker||'ctx->''input_review_complete'' is distinct from ''true''::jsonb or ');
 select pg_get_functiondef('public.adopt_authored_response(uuid,uuid,integer,integer,uuid,text)'::regprocedure) into definition;
 marker:='if review.id is null or review.context_hash';
 if position(marker in definition)=0 then raise exception 'AUTHORING_QUALIFICATION_ADOPTION_CHANGED';end if;
 execute replace(definition,marker,'if ctx->''input_review_complete'' is distinct from ''true''::jsonb or review.id is null or review.context_hash');
 -- Preserve explicitly supplied numeric bindings as suggested review data;
 -- ordinary consistency approval still requires a new explicit human review.
 marker:='''confirmed'',false,''origin'',''authoring_adoption'',''fulfillment''';
 execute replace(pg_get_functiondef('public.adopt_authored_response(uuid,uuid,integer,integer,uuid,text)'::regprocedure),marker,'''confirmed'',false,''origin'',''authoring_adoption'',''section_facts'',coalesce(body->''section_facts'',''[]''),''fulfillment''');
end $$;

do $$declare definition text;begin
 select pg_get_constraintdef(oid) into definition from pg_constraint where conrelid='public.jobs'::regclass and conname='jobs_type_check';
 if position('ARRAY[' in definition)=0 then raise exception 'GENERATED_DELIVERY_JOB_TYPES_CHANGED';end if;
 alter table public.jobs drop constraint jobs_type_check;
 execute 'alter table public.jobs add constraint jobs_type_check '||replace(definition,'ARRAY[','ARRAY[''prepare_generated_delivery''::text,');
end $$;
create unique index generated_delivery_projection_job on public.jobs(workspace_id,(checkpoint->>'generated_version_id')) where type='prepare_generated_delivery';
alter function app_private.queue_work_class(public.jobs) rename to queue_work_class_before_generated_delivery;
create function app_private.queue_work_class(j public.jobs) returns text language sql immutable set search_path='' as $$select case when j.type='prepare_generated_delivery' then 'local' else app_private.queue_work_class_before_generated_delivery(j) end$$;
-- Projection is restartable local work under the original issuance clock. It
-- never enters model recovery or consumes another inference reservation.
do $$declare definition text;marker text;begin
 select pg_get_functiondef('public.claim_backend_job()'::regprocedure) into definition;
 marker:='where workspace_id=w and type=''render_delivery'' and status=''running''';
 if position(marker in definition)=0 then raise exception 'GENERATED_DELIVERY_LEASE_RECOVERY_CHANGED';end if;
 execute replace(definition,marker,'where workspace_id=w and type in (''render_delivery'',''prepare_generated_delivery'') and status=''running''');
 select pg_get_functiondef('app_private.recover_processing_job(uuid,timestamptz)'::regprocedure) into definition;
 marker:='if j.type=''render_delivery'' then return;end if;';
 if position(marker in definition)=0 then raise exception 'GENERATED_DELIVERY_PROCESSING_RECOVERY_CHANGED';end if;
 execute replace(definition,marker,'if j.type in (''render_delivery'',''prepare_generated_delivery'') then return;end if;');
end $$;
alter function app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb) rename to draft_generation_snapshot_before_generated_delivery;
create function app_private.draft_generation_snapshot(w uuid,opp uuid,proposal uuid,package uuid,prior jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$declare result jsonb;begin
 result:=app_private.draft_generation_snapshot_before_generated_delivery(w,opp,proposal,package,prior);
 if prior is null then return result||'{"generated_delivery_version":3}'::jsonb;end if;
 if prior ? 'generated_delivery_version' then return result||jsonb_build_object('generated_delivery_version',prior->'generated_delivery_version');end if;
 return result-'generated_delivery_version';
end $$;
alter function public.advance_generation(uuid,uuid,text,jsonb,jsonb,jsonb) rename to advance_generation_before_generated_delivery;
create function public.advance_generation(job_id uuid,lease uuid,next_stage text,requirements jsonb,steps jsonb,final_result jsonb) returns void language plpgsql security definer set search_path='' as $$declare j public.jobs;p public.generation_plans;v public.proposal_versions;begin
 select * into j from public.jobs where id=job_id;
 perform public.advance_generation_before_generated_delivery(job_id,lease,next_stage,requirements,steps,final_result);
 if next_stage<>'completed' then return;end if;
 select * into p from public.generation_plans where id=j.entity_id and workspace_id=j.workspace_id;
 if p.kind<>'proposal' or p.status<>'completed' or p.frozen_context->>'generated_delivery_version' is distinct from '3' or nullif(to_jsonb(p)->>'issuance_request_id','') is null then return;end if;
 select * into v from public.proposal_versions where workspace_id=p.workspace_id and plan_id=p.id order by ordinal desc limit 1;
 if v.id is null then raise exception 'GENERATED_DELIVERY_VERSION_MISSING';end if;
 insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by,checkpoint)
 values(p.workspace_id,'prepare_generated_delivery',p.id,p.input_hash,'queued',p.created_by,jsonb_build_object('model_executor',4,'minimum_worker_executor',4,'generated_version_id',v.id,'generated_version_hash',v.content_hash,'generated_delivery_version',3,'issuance_request_id',to_jsonb(p)->'issuance_request_id'));
end $$;

create function app_private.generated_delivery_job(job_id uuid,lease uuid) returns public.jobs language plpgsql security definer set search_path='' as $$declare j public.jobs;begin
 select * into j from public.jobs where id=job_id;perform 1 from public.workspaces where id=j.workspace_id for update;
 select * into j from public.jobs where id=job_id for update;
 if j.id is null or j.type<>'prepare_generated_delivery' or j.status<>'running' or j.lease_token is distinct from lease or lease is null or j.lease_until is null or j.lease_until<=clock_timestamp() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 perform app_private.delivery_actor(j.workspace_id,j.created_by,true);
 if to_regprocedure('app_private.assert_issuance_job(uuid)') is not null then perform app_private.assert_issuance_job(j.id);end if;
 return j;
end $$;
create function public.generated_delivery_context(job_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;p public.generation_plans;v public.proposal_versions;prop public.proposals;sections jsonb;requirements jsonb;steps jsonb;receipts jsonb;sources jsonb;manifest jsonb;context jsonb;ref jsonb;requirement jsonb;current_documents jsonb;saved_documents jsonb;begin
 j:=app_private.generated_delivery_job(job_id,lease);
 select * into p from public.generation_plans where workspace_id=j.workspace_id and id=j.entity_id;
 select * into v from public.proposal_versions where workspace_id=j.workspace_id and id=(j.checkpoint->>'generated_version_id')::uuid and plan_id=p.id;
 select * into prop from public.proposals where workspace_id=j.workspace_id and id=p.proposal_id;
 if p.status<>'completed' or p.frozen_context->>'generated_delivery_version' is distinct from '3' or v.id is null or v.content_hash is distinct from j.checkpoint->>'generated_version_hash' or p.input_hash is distinct from j.input_hash or prop.active_version_id is distinct from v.id then raise exception 'STALE_INPUT';end if;
 if exists(select 1 from public.restore_sessions where workspace_id=j.workspace_id and state in ('staging','committing')) then raise exception 'RESTORE_IN_PROGRESS';end if;
 if not exists(select 1 from public.opportunities where workspace_id=j.workspace_id and id=p.opportunity_id and not archived) then raise exception 'DELIVERY_SOURCE_UNAVAILABLE';end if;
 sources:=jsonb_build_array(p.frozen_context->'notice')||coalesce(p.frozen_context->'blocks','[]')||coalesce(p.frozen_context->'knowledge','[]')||coalesce(p.frozen_context->'reviews','[]')||coalesce(p.frozen_context->'rates','[]');
 select coalesce(jsonb_agg(distinct x->'reference'),'[]') into manifest from jsonb_array_elements(sources) x where x ? 'reference';
 perform app_private.check_delivery_sources(j.workspace_id,manifest);perform app_private.check_delivery_materials(j.workspace_id,p.frozen_context->'input_materials');
 select coalesce(jsonb_agg(x->>'document_id' order by x->>'document_id'),'[]') into current_documents from jsonb_array_elements(app_private.delivery_input(j.workspace_id,p.opportunity_id)#>'{input_materials,documents}') x;
 select coalesce(jsonb_agg(x->>'document_id' order by x->>'document_id'),'[]') into saved_documents from jsonb_array_elements(coalesce(p.frozen_context#>'{input_materials,documents}','[]')) x;
 if current_documents is distinct from saved_documents then raise exception 'STALE_INPUT';end if;
 if to_regprocedure('app_private.current_document_extraction(uuid,uuid)') is not null then
  for ref in select value from jsonb_array_elements(manifest) where value->>'entity_kind'='document' loop
   if app_private.current_document_extraction(j.workspace_id,(ref->>'entity_id')::uuid) is distinct from (ref->>'entity_id')::uuid then raise exception 'STALE_INPUT';end if;
  end loop;
 end if;
 select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('key',s.section_key) order by s.ordinal,s.id),'[]') into sections from public.proposal_sections s where s.workspace_id=j.workspace_id and s.proposal_version_id=v.id;
 select coalesce(jsonb_agg(to_jsonb(r)||case when r.source_semantics->>'review_status'='confirmed' then jsonb_build_object('source_review_reason',(select sr.reason from public.source_obligation_reviews sr where sr.workspace_id=j.workspace_id and sr.review_id=(r.source_semantics->>'review_id')::uuid order by sr.revision desc limit 1)) else '{}'::jsonb end order by r.id),'[]') into requirements from public.requirements r where r.workspace_id=j.workspace_id and r.plan_id=p.id;
 -- Pending machine source meaning remains honestly pending. An old confirmed
 -- human decision cannot survive a later revoked/replaced authority or clause.
 for requirement in select value from jsonb_array_elements(requirements) loop
  if requirement#>>'{source_semantics,review_status}'='confirmed' and not app_private.check_source_semantics(j.workspace_id,requirement->'source_semantics',requirement->'source_refs') then raise exception 'STALE_INPUT';end if;
 end loop;
 select coalesce(jsonb_agg(to_jsonb(s) order by s.ordinal,s.id),'[]') into steps from public.generation_steps s where s.workspace_id=j.workspace_id and s.plan_id=p.id;
 -- Use the graph's actual chosen verifier reference, not an arbitrary cached
 -- report with a convenient verdict. Accepted data remains bound to step.output.
 select coalesce(jsonb_agg(jsonb_build_object('step_id',s.id,'task',s.task,'receipt_id',accepted.id,'verification_receipt_id',checked.id,
  'candidate_hash',checked.value#>>'{result,checked_candidate_hash}','candidate',accepted.value,'verification',checked.value->'result',
  'accepted',true,'thread_id',g.id,'graph_input_hash',g.input_hash,'accepted_content_hash',accepted.content_hash,'verification_content_hash',checked.content_hash,
  'pin_hashes',(select coalesce(jsonb_agg(jsonb_build_object('key',x.result_key,'hash',x.content_hash) order by x.result_key),'[]') from app_private.model_graph_results x where x.thread_id=g.id and (x.result_key like 'semantic-instructions-%' or x.result_key like 'verification-instructions-%' or x.result_key like 'verification-format-%')),
  'attempt_pins',(select coalesce(jsonb_agg(jsonb_build_object('id',ma.id,'provider',ma.provider,'model',ma.model,'operation',ma.operation,'usage_id',ma.usage_id,'prompt_hash',ma.execution_metadata->'prompt_hash','schema_hash',ma.execution_metadata->'schema_hash') order by ma.id),'[]') from public.model_attempts ma where ma.workspace_id=j.workspace_id and ma.job_id=s.job_id and ma.sent and ma.status='succeeded')) order by s.ordinal,s.id),'[]') into receipts
 from public.generation_steps s join public.jobs source_job on source_job.id=s.job_id and source_job.workspace_id=s.workspace_id join app_private.model_graph_threads g on g.workspace_id=s.workspace_id and g.job_id=s.job_id and g.id=source_job.checkpoint->>'graph_thread' and g.status in ('accepted','committed')
 join app_private.model_graph_results accepted on accepted.id=g.result_id and accepted.thread_id=g.id and accepted.value=s.output
 join lateral (select checkpoint from app_private.model_graph_checkpoints where thread_id=g.id and namespace='' order by checkpoint_id desc limit 1) last_state on true
 join app_private.model_graph_results checked on checked.thread_id=g.id and checked.id::text=last_state.checkpoint#>>'{channel_values,reportRef}' and coalesce(checked.value->>'coverage','')<>'repair_only'
 where s.workspace_id=j.workspace_id and s.plan_id=p.id and s.status='completed';
 context:=jsonb_build_object('plan',to_jsonb(p),'version',to_jsonb(v),'proposal',to_jsonb(prop),'sections',sections,'requirements',requirements,'steps',steps,'section_outline',v.section_outline,'accepted_receipts',receipts,'sources',sources,'source_manifest',manifest,'input_review_complete',app_private.delivery_input_review_complete(j.workspace_id,p.frozen_context->'input_materials'));
 return context||jsonb_build_object('context_hash',encode(sha256(convert_to(context::text,'UTF8')),'hex'));
end $$;

create function public.publish_generated_delivery(job_id uuid,lease uuid,expected_context_hash text,payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;p public.generation_plans;v public.proposal_versions;prop public.proposals;ctx jsonb;s public.proposal_delivery_snapshots;selected public.proposal_delivery_snapshots;nextordinal integer;req jsonb;receipt jsonb;begin
 j:=app_private.generated_delivery_job(job_id,lease);ctx:=public.generated_delivery_context(job_id,lease);
 if expected_context_hash is null or expected_context_hash is distinct from ctx->>'context_hash' then raise exception 'STALE_INPUT';end if;
 select * into p from public.generation_plans where id=j.entity_id;
 select * into v from public.proposal_versions where id=(j.checkpoint->>'generated_version_id')::uuid;
 select * into prop from public.proposals where id=p.proposal_id for update;
 if payload->>'version' is distinct from '3' or payload->>'content_state' is distinct from 'generated_review_draft' or payload->>'approval_state' is distinct from 'draft' or payload->'substantive_complete' is distinct from 'false'::jsonb
  or payload#>>'{generation,proposal_version_id}' is distinct from v.id::text or payload#>>'{generation,plan_id}' is distinct from p.id::text or payload#>>'{generation,version_content_hash}' is distinct from v.content_hash or payload#>>'{generation,plan_input_hash}' is distinct from p.input_hash
  or payload#>>'{generation,machine_validation,policy}' is distinct from 'generated-delivery-v1' or payload#>'{generation,machine_validation,passed}' is distinct from 'true'::jsonb or payload->'source_manifest' is distinct from ctx->'source_manifest' then raise exception 'GENERATED_DELIVERY_INVALID';end if;
 if payload#>'{generation,machine_validation,version}' is distinct from '1'::jsonb or payload#>'{generation,machine_validation,machine_eligible}' is distinct from 'true'::jsonb
  or payload#>'{generation,machine_validation,blockers}' is distinct from '[]'::jsonb or payload#>'{generation,machine_validation,substantive_complete}' is distinct from 'false'::jsonb
  or jsonb_typeof(payload#>'{generation,receipt_pins}') is distinct from 'array' or jsonb_array_length(payload#>'{generation,receipt_pins}')=0
  or jsonb_array_length(ctx->'sections')=0 or jsonb_array_length(ctx->'accepted_receipts')=0
  or (select count(distinct x->>'step_id') from jsonb_array_elements(payload#>'{generation,receipt_pins}') x)<>jsonb_array_length(payload#>'{generation,receipt_pins}') then raise exception 'GENERATED_DELIVERY_INVALID';end if;
 if ctx->'input_review_complete'='false'::jsonb and not exists(select 1 from jsonb_array_elements(payload->'gaps') gap where gap->>'reason'='UNREAD_INPUT' and gap->>'required_for'='final_approval') then raise exception 'GENERATED_DELIVERY_INPUT_REVIEW_REQUIRED';end if;
 if exists(select 1 from jsonb_array_elements(ctx->'sections') original where not exists(select 1 from jsonb_array_elements(payload->'sections') rendered where rendered->>'section_key'=original->>'key' and rendered->>'title'=original->>'title' and rendered->>'volume'=original->>'volume' and rendered->'content_blocks'=original->'content_blocks'))
  or (select count(*) from jsonb_array_elements(ctx->'sections'))<>(select count(*) from jsonb_array_elements(payload->'sections') x where x->>'section_key'<>'generated-review-gaps') then raise exception 'GENERATED_DELIVERY_SECTION_MISMATCH';end if;
 if payload->'separate_volumes' is distinct from to_jsonb(v.separate_volumes) then raise exception 'BUYER_VOLUME_RULE';end if;
 for receipt in select value from jsonb_array_elements(payload#>'{generation,receipt_pins}') loop
  if not exists(select 1 from jsonb_array_elements(ctx->'accepted_receipts') actual where actual->>'step_id'=receipt->>'step_id' and actual->>'receipt_id'=receipt->>'receipt_id' and actual->>'verification_receipt_id'=receipt->>'verification_receipt_id' and actual->>'candidate_hash'=receipt->>'candidate_hash') then raise exception 'GENERATED_DELIVERY_RECEIPT_MISMATCH';end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(ctx->'steps') step where step->>'status'='completed' and step->>'task'<>'advance_plan' and not exists(select 1 from jsonb_array_elements(payload#>'{generation,receipt_pins}') r where r->>'step_id'=step->>'id')) then raise exception 'GENERATED_DELIVERY_RECEIPT_MISSING';end if;
 select * into s from public.proposal_delivery_snapshots existing where existing.workspace_id=j.workspace_id and existing.plan_id=p.id and existing.payload#>>'{generation,proposal_version_id}'=v.id::text order by ordinal desc limit 1;
 if s.id is not null then
  if s.payload is distinct from publish_generated_delivery.payload then raise exception 'IDEMPOTENCY_CONFLICT';end if;
 else
  select coalesce(max(ordinal),0)+1 into nextordinal from public.proposal_delivery_snapshots where workspace_id=j.workspace_id and proposal_id=prop.id;
  insert into public.proposal_delivery_snapshots(workspace_id,opportunity_id,proposal_id,plan_id,base_version_id,ordinal,content_hash,source_manifest,payload,created_by)
  values(j.workspace_id,p.opportunity_id,prop.id,p.id,v.id,nextordinal,encode(sha256(convert_to(payload::text,'UTF8')),'hex'),ctx->'source_manifest',payload,j.created_by) returning * into s;
  select * into selected from public.proposal_delivery_snapshots where id=prop.active_delivery_snapshot_id;
  if selected.payload->>'version' is distinct from '2' then update public.proposals set active_delivery_snapshot_id=s.id,delivery_revision=delivery_revision+1 where id=prop.id;end if;
  insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(j.workspace_id,j.created_by,'delivery.generated_projected','proposal_delivery_snapshot',s.id,jsonb_build_object('version_id',v.id,'plan_id',p.id,'context_hash',expected_context_hash,'renderer_version','3','machine_validation_hash',payload#>'{generation,machine_validation_hash}'));
 end if;
 -- Every successful path rechecks the request deadline in this same transaction.
 if to_regprocedure('app_private.assert_issuance_job(uuid)') is not null then perform app_private.assert_issuance_job(j.id);end if;
 update public.jobs set status='succeeded',lease_token=null,lease_until=null,error_code=null,revision=revision+1,updated_at=now() where id=j.id;
 return to_jsonb(s);
end $$;
create function public.fail_generated_delivery(job_id uuid,lease uuid,error_code text) returns void language plpgsql security definer set search_path='' as $$declare j public.jobs;request uuid;begin
 select * into j from public.jobs where id=job_id;perform 1 from public.workspaces where id=j.workspace_id for update;select * into j from public.jobs where id=job_id for update;
 if j.id is null or j.type<>'prepare_generated_delivery' or j.status<>'running' or j.lease_token is distinct from lease or lease is null or j.lease_until is null or j.lease_until<=clock_timestamp() then raise exception 'STALE_LEASE';end if;
 if error_code is null or error_code !~ '^[A-Z_]{1,100}$' then raise exception 'INVALID_INPUT';end if;
 update public.jobs set status='failed',error_code=fail_generated_delivery.error_code,lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
 request:=nullif(j.checkpoint->>'issuance_request_id','')::uuid;
 if request is not null and to_regprocedure('app_private.fail_proposal_issuance(uuid,text)') is not null then perform app_private.fail_proposal_issuance(request,error_code);end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(j.workspace_id,j.created_by,'delivery.generated_failed','job',j.id,jsonb_build_object('error_code',error_code,'plan_id',j.entity_id));
end $$;

-- In-progress automatic issuance revalidates new OCR leaves and reviewed
-- authority at every render boundary. Historical local snapshot downloads keep
-- their original immutable pins and existing read authorization semantics.
alter function app_private.delivery_job(uuid,uuid,boolean) rename to delivery_job_before_generated_current;
create function app_private.delivery_job(job_id uuid,lease uuid,check_sources boolean default true) returns public.jobs language plpgsql security definer set search_path='' as $$
declare j public.jobs;s public.proposal_delivery_snapshots;p public.generation_plans;v public.proposal_versions;ref jsonb;r public.requirements;current_documents jsonb;saved_documents jsonb;begin
 j:=app_private.delivery_job_before_generated_current(job_id,lease,check_sources);
 if not check_sources then return j;end if;
 select * into s from public.proposal_delivery_snapshots where id=j.entity_id;
 if s.payload->>'version' is distinct from '3' then return j;end if;
 select * into p from public.generation_plans where workspace_id=j.workspace_id and id=s.plan_id;
 select * into v from public.proposal_versions where workspace_id=j.workspace_id and id=(s.payload#>>'{generation,proposal_version_id}')::uuid and plan_id=p.id;
 if v.id is null or v.content_hash is distinct from s.payload#>>'{generation,version_content_hash}' or p.input_hash is distinct from s.payload#>>'{generation,plan_input_hash}'
  or not exists(select 1 from public.proposals where id=s.proposal_id and active_version_id=v.id) then raise exception 'STALE_INPUT';end if;
 select coalesce(jsonb_agg(x->>'document_id' order by x->>'document_id'),'[]') into current_documents from jsonb_array_elements(app_private.delivery_input(j.workspace_id,p.opportunity_id)#>'{input_materials,documents}') x;
 select coalesce(jsonb_agg(x->>'document_id' order by x->>'document_id'),'[]') into saved_documents from jsonb_array_elements(coalesce(p.frozen_context#>'{input_materials,documents}','[]')) x;
 if current_documents is distinct from saved_documents then raise exception 'STALE_INPUT';end if;
 if to_regprocedure('app_private.current_document_extraction(uuid,uuid)') is not null then
  for ref in select value from jsonb_array_elements(s.source_manifest) where value->>'entity_kind'='document' loop
   if app_private.current_document_extraction(j.workspace_id,(ref->>'entity_id')::uuid) is distinct from (ref->>'entity_id')::uuid then raise exception 'STALE_INPUT';end if;
  end loop;
 end if;
 for r in select * from public.requirements where workspace_id=j.workspace_id and plan_id=p.id loop
  if r.source_semantics->>'review_status'='confirmed' and not app_private.check_source_semantics(j.workspace_id,r.source_semantics,r.source_refs) then raise exception 'STALE_INPUT';end if;
 end loop;
 return j;
end $$;

do $$declare signature text;r text;begin foreach signature in array array[
 'app_private.queue_work_class_before_generated_delivery(public.jobs)','app_private.queue_work_class(public.jobs)',
 'app_private.delivery_input_review_complete(uuid,jsonb)','app_private.authoring_context_before_extraction_qualification(uuid,uuid)','app_private.authoring_context(uuid,uuid)',
 'app_private.delivery_job_before_generated_current(uuid,uuid,boolean)','app_private.delivery_job(uuid,uuid,boolean)',
 'app_private.draft_generation_snapshot_before_generated_delivery(uuid,uuid,uuid,uuid,jsonb)','app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb)',
 'public.advance_generation_before_generated_delivery(uuid,uuid,text,jsonb,jsonb,jsonb)','public.advance_generation(uuid,uuid,text,jsonb,jsonb,jsonb)',
 'app_private.generated_delivery_job(uuid,uuid)','public.generated_delivery_context(uuid,uuid)','public.publish_generated_delivery(uuid,uuid,text,jsonb)','public.fail_generated_delivery(uuid,uuid,text)'] loop
 execute 'revoke all on function '||signature||' from public';foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop if exists(select 1 from pg_roles where rolname=r) then execute 'revoke all on function '||signature||' from '||quote_ident(r);if r in ('service_role','tdp_app_service') and signature like 'public.%' and signature not like '%before_%' then execute 'grant execute on function '||signature||' to '||quote_ident(r);end if;end if;end loop;end loop;end $$;
