-- Reports are service-computed from current source and actual stored sections.
-- Columns travel with the existing version backup/restore/retention contract;
-- restored reports never bypass current actor/source/authority checks.
alter table public.proposal_versions
 add column consistency_report jsonb,
 add column consistency_binding_hash text,
 add column consistency_review jsonb,
 add constraint consistency_report_bounded check(consistency_report is null or (jsonb_typeof(consistency_report)='object' and pg_column_size(consistency_report)<=1048576)),
 add constraint consistency_binding_format check(consistency_binding_hash is null or consistency_binding_hash~'^[a-f0-9]{64}$'),
 add constraint consistency_review_bounded check(consistency_review is null or (jsonb_typeof(consistency_review)='object' and pg_column_size(consistency_review)<=1048576));

create function app_private.consistency_actor(w uuid,actor uuid) returns void
language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from public.memberships m join public.identity_allowlist a
 on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=w
 and m.user_id=actor and m.active and a.status='active' and m.role in ('Owner','Editor','Reviewer')) then raise exception 'ROLE_FORBIDDEN';end if;
end $$;

create function app_private.proposal_consistency_data(w uuid,version_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare v public.proposal_versions;p public.proposals;g public.generation_plans;requirements jsonb;sections jsonb;sources jsonb;contract jsonb;manifest jsonb;input jsonb;decisions jsonb;financial jsonb;delivery jsonb;binding text;
begin
 select * into v from public.proposal_versions where workspace_id=w and id=version_id;
 select * into p from public.proposals where workspace_id=w and id=v.proposal_id;
 select * into g from public.generation_plans where workspace_id=w and id=v.plan_id;
 if v.id is null or p.active_version_id is distinct from version_id then raise exception 'STALE_INPUT';end if;
 if g.frozen_context->'proposal_consistency_version' is distinct from '1'::jsonb then raise exception 'CONSISTENCY_VERSION_REQUIRED';end if;
 if v.evidence_revision is distinct from (select evidence_revision from public.workspaces where id=w) then raise exception 'STALE_INPUT';end if;
 if not exists(select 1 from public.opportunities o where o.workspace_id=w and o.id=p.opportunity_id and not o.archived) then raise exception 'NOT_FOUND';end if;
 if exists(select 1 from public.restore_sessions where workspace_id=w and state in ('staging','committing')) then raise exception 'RESTORE_IN_PROGRESS';end if;
 sources:=jsonb_build_array(g.frozen_context->'notice')||coalesce(g.frozen_context->'blocks','[]')||coalesce(g.frozen_context->'knowledge','[]')||coalesce(g.frozen_context->'reviews','[]')||coalesce(g.frozen_context->'rates','[]');
 select coalesce(jsonb_agg(e),'[]') into sources from jsonb_array_elements(sources) e where jsonb_typeof(e)='object';
 select coalesce(jsonb_agg(distinct e->'reference'),'[]') into manifest from jsonb_array_elements(sources) e where e is not null and e<>'null'::jsonb and e ? 'reference';
 perform app_private.check_delivery_sources(w,manifest);
 perform app_private.check_delivery_materials(w,g.frozen_context->'input_materials');
 contract:=app_private.source_review_evidence(w,p.opportunity_id,app_private.source_review_sources(w,p.opportunity_id));
 -- Requirements cite exact S1 spans. Only current server-resolved spans receive
 -- aliases; frozen prose or a browser-supplied quote cannot create one.
 sources:=sources||coalesce((select jsonb_agg(jsonb_build_object('id',s->>'id','text',s->>'quote','kind','rfp','verified',true,'reference',jsonb_build_object('entity_kind',s->>'entity_kind','entity_id',s->>'entity_id','content_hash',s->>'content_hash'))) from jsonb_array_elements(contract->'spans') s),'[]');
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'text',r.text,'category',r.category,'mandatory',r.mandatory,'source_refs',r.source_refs,'source_semantics',case when app_private.check_source_semantics(w,r.source_semantics,r.source_refs) then r.source_semantics else coalesce(r.source_semantics,'{}')||'{"review_status":"pending"}'::jsonb end) order by r.id),'[]') into requirements from public.requirements r where r.workspace_id=w and r.plan_id=g.id;
 select coalesce(jsonb_agg(jsonb_build_object('key',s.section_key,'title',s.title,'volume',s.volume,'requirement_ids',s.requirement_ids,'content_blocks',s.content_blocks) order by s.ordinal,s.id),'[]') into sections from public.proposal_sections s where s.workspace_id=w and s.proposal_version_id=v.id;
 select coalesce(jsonb_agg(jsonb_build_object('id',d->>'key','statement',d->>'statement') order by d->>'key'),'[]') into decisions from public.generation_steps gs cross join lateral jsonb_array_elements(coalesce(gs.output->'decisions','[]')) d where gs.workspace_id=w and gs.plan_id=g.id and gs.task='plan_blueprint' and gs.status='completed';
 select to_jsonb(e) into financial from public.estimate_versions e where e.workspace_id=w and e.proposal_version_id=v.id order by ordinal desc limit 1;
 select to_jsonb(d) into delivery from public.delivery_versions d where d.workspace_id=w and d.proposal_version_id=v.id order by ordinal desc limit 1;
 input:=jsonb_build_object('requirements',requirements,'sections',sections,'sources',sources,'separate_volumes',v.separate_volumes,'input_complete',coalesce(jsonb_typeof(g.frozen_context->'input_materials'->'documents')='array',false) and not exists(select 1 from jsonb_array_elements(coalesce(g.frozen_context->'input_materials'->'documents','[]')) x where x->'used_for_draft'='false'::jsonb or x->'extraction_coverage'->'complete'='false'::jsonb));
 -- Actual section rows, source semantic reviews and latest Decimal calculation
 -- records participate, so a stale summary content_hash is insufficient.
 binding:=encode(sha256(convert_to(jsonb_build_array(v.content_hash,v.package_hash,v.evidence_revision,input,decisions,financial,delivery)::text,'UTF8')),'hex');
 return jsonb_build_object('version_id',v.id,'version_revision',v.revision,'binding_hash',binding,'input',input,'shared_decisions',decisions,'financial_truth',financial,'delivery_truth',delivery,'report',v.consistency_report,'review',v.consistency_review);
end $$;

create function public.proposal_consistency_context(version_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare w uuid;
begin
 select workspace_id into w from public.proposal_versions where id=version_id;
 perform app_private.consistency_actor(w,auth.uid());
 return app_private.proposal_consistency_data(w,version_id);
end $$;

create function public.complete_proposal_consistency(version_id uuid,actor_id uuid,expected_revision integer,binding_hash text,request_body jsonb,idempotency_key text,report jsonb,review jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare w uuid;ctx jsonb;v public.proposal_versions;result jsonb;receipt app_private.idempotency_records;request_hash text;review_route text:='proposal.consistency:'||version_id::text;
begin
 select workspace_id into w from public.proposal_versions where id=version_id;
 perform 1 from public.workspaces where id=w for update;
 -- Recheck after acquiring serialization, including revocation while waiting.
 perform app_private.consistency_actor(w,actor_id);
 ctx:=app_private.proposal_consistency_data(w,version_id);
 if binding_hash is null or ctx->>'binding_hash' is distinct from binding_hash then raise exception 'STALE_INPUT';end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or jsonb_typeof(request_body) is distinct from 'object' or pg_column_size(request_body)>1048576 then raise exception 'INVALID_INPUT';end if;
 request_hash:=encode(sha256(convert_to(request_body::text,'UTF8')),'hex');
 select * into receipt from app_private.idempotency_records i where i.workspace_id=w and i.actor_id=complete_proposal_consistency.actor_id and i.method='REVIEW' and i.route=review_route and i.key=idempotency_key;
 if receipt.key is not null and receipt.expires_at>now() then
  if receipt.body_hash is distinct from request_hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  if ctx->'review'->>'review_id' is distinct from receipt.result->>'review_id' then raise exception 'REVISION_CONFLICT';end if;
  return receipt.result;
 end if;
 if expected_revision is null or (ctx->>'version_revision')::integer is distinct from expected_revision then raise exception 'REVISION_CONFLICT';end if;
 if report->'version' is distinct from '1'::jsonb or report->>'policy' is distinct from 'proposal-consistency-v1' or jsonb_typeof(report->'coverage') is distinct from 'array' or jsonb_typeof(report->'diagnostics') is distinct from 'array' or jsonb_typeof(report->'substantive_complete') is distinct from 'boolean' or report->>'input_hash' is null or report->>'input_hash'!~'^[a-f0-9]{64}$' or pg_column_size(report)>1048576 then raise exception 'CONSISTENCY_REPORT_INVALID';end if;
 if review->>'actor_id' is distinct from actor_id::text or review->'confirmed' is distinct from 'true'::jsonb or review->>'review_id' is null or jsonb_typeof(review->'requirement_ids') is distinct from 'array' or length(trim(coalesce(request_body->>'reason','')))<30 then raise exception 'CONSISTENCY_REVIEW_INVALID';end if;
 if report->'substantive_complete'='true'::jsonb then
  if jsonb_array_length(report->'coverage')=0 or jsonb_array_length(report->'coverage')<>jsonb_array_length(ctx->'input'->'requirements')
   or (select count(distinct c->>'requirement_id') from jsonb_array_elements(report->'coverage') c)<>jsonb_array_length(report->'coverage')
   or jsonb_array_length(report->'diagnostics')<>0 or report->'semantic_review_required' is distinct from 'false'::jsonb
   or exists(select 1 from jsonb_array_elements(report->'coverage') c where coalesce(c->>'status','') not in ('answered','excluded'))
   or exists(select 1 from jsonb_array_elements(ctx->'input'->'requirements') r where
    not exists(select 1 from jsonb_array_elements(report->'coverage') c where c->>'requirement_id'=r->>'id' and (
     (c->>'status'='answered' and exists(select 1 from jsonb_array_elements_text(review->'requirement_ids') id where id=r->>'id')
      and r->'source_semantics'->>'authority_role' in ('buyer_rfp','buyer_addendum') and r->'source_semantics'->'actor'<>'null'::jsonb)
     or (c->>'status'='excluded' and c->>'classification'='approved_not_applicable' and exists(select 1 from jsonb_array_elements(coalesce(ctx->'input'->'approved_exclusions','[]')) x where x->>'requirement_id'=r->>'id' and x->>'binding_hash'=r->>'applicability_binding'))
     or (c->>'status'='excluded' and c->>'classification'='non_obligation' and length(trim(coalesce(r->>'source_review_reason','')))>0
      and (r->'source_semantics'->>'modality'='informational' or r->'source_semantics'->>'authority_role' in ('supplier_proposal','company_evidence','reference')))
    ))
    or r->'source_semantics'->>'review_status' is distinct from 'confirmed'
    or r->'source_semantics'->>'authority_status' is distinct from 'confirmed'
    or coalesce(r->'source_semantics'->>'modality','unknown')='unknown'
    or jsonb_typeof(r->'source_semantics'->'negated') is distinct from 'boolean'
   ) then raise exception 'CONSISTENCY_REPORT_INVALID';end if;
 end if;
 update public.approvals set invalidated_at=now(),revision=revision+1 where proposal_version_id=version_id and invalidated_at is null;
 update public.proposal_versions set consistency_report=report,consistency_binding_hash=binding_hash,consistency_review=review||jsonb_build_object('reason',request_body->>'reason','fulfillment',request_body->'fulfillment','section_facts',request_body->'section_facts','confirmed_decision_ids',request_body->'confirmed_decision_ids','reviewed_at',now()),status='draft',revision=revision+1,updated_at=now() where id=version_id returning * into v;
 update public.proposals set state='draft',revision=revision+1,updated_at=now() where id=v.proposal_id and state='approved';
 result:=jsonb_build_object('version_id',v.id,'version_revision',v.revision,'binding_hash',binding_hash,'report',report,'review_id',review->>'review_id');
 delete from app_private.idempotency_records i where i.workspace_id=w and i.actor_id=complete_proposal_consistency.actor_id and i.method='REVIEW' and i.route=review_route and i.key=idempotency_key;
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor_id,'REVIEW',review_route,idempotency_key,request_hash,result);
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id) values(w,actor_id,'proposal.consistency.reviewed',version_id,request_body->>'reason',(review->>'review_id')::uuid);
 return result;
end $$;

alter function app_private.approval_gate(uuid,uuid) rename to approval_gate_before_consistency;
create function app_private.approval_gate(w uuid,version_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;v public.proposal_versions;ctx jsonb;valid boolean:=false;
begin
 result:=app_private.approval_gate_before_consistency(w,version_id);
 select * into v from public.proposal_versions where workspace_id=w and id=version_id;
 if exists(select 1 from public.generation_plans g where g.id=v.plan_id and g.frozen_context->'proposal_consistency_version'='1'::jsonb) then
  begin
   ctx:=app_private.proposal_consistency_data(w,version_id);
   perform app_private.consistency_actor(w,(v.consistency_review->>'actor_id')::uuid);
   valid:=coalesce(v.consistency_binding_hash=ctx->>'binding_hash' and v.consistency_report->'substantive_complete'='true'::jsonb and v.consistency_report->'semantic_review_required'='false'::jsonb and v.consistency_report->'diagnostics'='[]'::jsonb and v.consistency_review->'confirmed'='true'::jsonb,false);
  exception when others then valid:=false;end;
  if not valid then result:=jsonb_set(result,'{blockers}',(result->'blockers')||'"Complete the current source-bound substantive response and whole-proposal consistency review."'::jsonb);end if;
  result:=result||jsonb_build_object('consistency_complete',valid,'review_hash',encode(sha256(convert_to(jsonb_build_array(result->>'review_hash',v.consistency_binding_hash,v.consistency_report,v.consistency_review)::text,'UTF8')),'hex'));
 end if;
 return result;
end $$;

-- Preserve the composed lease/currentness/phase wrappers and persist the actual
-- assembly report. The delegate must finish successfully before touching it.
alter function public.advance_generation(uuid,uuid,text,jsonb,jsonb,jsonb) rename to advance_generation_before_consistency;
-- Function-qualified PL/pgSQL parameters follow the implicit block label.
-- A rename alone leaves the previous public wrapper's label references stale.
do $$declare definition text;begin
 select pg_get_functiondef('public.advance_generation_before_consistency(uuid,uuid,text,jsonb,jsonb,jsonb)'::regprocedure) into definition;
 definition:=replace(definition,'advance_generation.','advance_generation_before_consistency.');
 execute definition;
end $$;
create function public.advance_generation(job_id uuid,lease uuid,next_stage text,requirements jsonb,steps jsonb,final_result jsonb default null) returns void
language plpgsql security definer set search_path='' as $$
declare plan uuid;
begin
 perform public.advance_generation_before_consistency(job_id,lease,next_stage,requirements,steps,final_result);
 if next_stage='completed' then
  select s.plan_id into plan from public.generation_steps s where s.job_id=advance_generation.job_id;
  update public.proposal_versions v set consistency_report=final_result->'consistency_report'
  from public.generation_plans g where v.plan_id=plan and g.id=v.plan_id and g.frozen_context->'proposal_consistency_version'='1'::jsonb;
 end if;
end $$;

-- Compatible with hosted Supabase and the managed DO app role families.
do $$ declare signature text;role_name text;begin
 foreach signature in array array[
 'app_private.consistency_actor(uuid,uuid)','app_private.proposal_consistency_data(uuid,uuid)',
 'app_private.approval_gate_before_consistency(uuid,uuid)','app_private.approval_gate(uuid,uuid)',
 'public.proposal_consistency_context(uuid)',
 'public.complete_proposal_consistency(uuid,uuid,integer,text,jsonb,text,jsonb,jsonb)',
 'public.advance_generation_before_consistency(uuid,uuid,text,jsonb,jsonb,jsonb)',
 'public.advance_generation(uuid,uuid,text,jsonb,jsonb,jsonb)'
 ] loop
 execute 'revoke all on function '||signature||' from public';
 foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function '||signature||' from '||quote_ident(role_name);end if;
 end loop;end loop;
 foreach role_name in array array['authenticated','tdp_app_authenticated'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then execute 'grant execute on function public.proposal_consistency_context(uuid) to '||quote_ident(role_name);end if;end loop;
 foreach role_name in array array['service_role','tdp_app_service'] loop
 if exists(select 1 from pg_roles where rolname=role_name) then
 execute 'grant execute on function public.complete_proposal_consistency(uuid,uuid,integer,text,jsonb,text,jsonb,jsonb),public.advance_generation(uuid,uuid,text,jsonb,jsonb,jsonb) to '||quote_ident(role_name);
 end if;end loop;
end $$;
