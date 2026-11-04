-- Explicit adoption into the ordinary review/commercial workflow; no generated
-- success, remote request, paid usage or final approval is implied.
create table public.proposal_authoring_adoptions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null,session_id uuid not null,authoring_revision_id uuid not null,review_id uuid not null,proposal_version_id uuid not null,
 body_hash text not null,requirement_map jsonb not null,created_by uuid not null,created_at timestamptz not null default now(),revision integer not null default 1 check(revision=1),
 unique(workspace_id,id),unique(workspace_id,authoring_revision_id,proposal_version_id),
 foreign key(workspace_id,session_id) references public.proposal_authoring_sessions(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,authoring_revision_id) references public.proposal_authoring_revisions(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,review_id) references public.proposal_authoring_reviews(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,proposal_version_id) references public.proposal_versions(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,created_by) references public.workspace_actors(workspace_id,id) deferrable initially immediate
);
create index authoring_adoption_version on public.proposal_authoring_adoptions(workspace_id,proposal_version_id);
create index authoring_adoption_session on public.proposal_authoring_adoptions(workspace_id,session_id);
alter table public.proposal_authoring_adoptions enable row level security;
revoke all on public.proposal_authoring_adoptions from public;
create trigger authoring_adoption_immutable before update on public.proposal_authoring_adoptions for each row execute function app_private.delivery_snapshot_immutable();
create function public.adopt_authored_response(actor_id uuid,session_id uuid,expected_revision integer,expected_proposal_revision integer,review_id uuid,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.proposal_authoring_sessions;r public.proposal_authoring_revisions;review public.proposal_authoring_reviews;s public.proposal_delivery_snapshots;p public.proposals;v public.proposal_versions;plan public.generation_plans;ctx jsonb;body jsonb;frozen jsonb;requirements jsonb;req jsonb;section jsonb;item jsonb;mapping jsonb:='{}';mapped uuid;ordinal integer;version_ordinal integer;ev bigint;digest text;receipt app_private.idempotency_records;result jsonb;
begin
 select * into a from public.proposal_authoring_sessions where id=session_id;
 if a.id is null then raise exception 'NOT_FOUND';end if;
 perform app_private.delivery_actor(a.workspace_id,actor_id,true);perform 1 from public.workspaces where id=a.workspace_id for update;perform app_private.delivery_actor(a.workspace_id,actor_id,true);
 ctx:=app_private.authoring_context(a.id,actor_id);
 select * into p from public.proposals where id=a.proposal_id for update;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 then raise exception 'INVALID_INPUT';end if;
 digest:=encode(sha256(convert_to(jsonb_build_array(session_id,expected_revision,expected_proposal_revision,review_id)::text,'UTF8')),'hex');
 select * into receipt from app_private.idempotency_records i where i.workspace_id=a.workspace_id and i.actor_id=adopt_authored_response.actor_id and i.method='COMMAND' and i.route='proposal.authoring.adopt' and i.key=idempotency_key and i.expires_at>now();
 if receipt.key is not null then if receipt.body_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;return receipt.result;end if;
 if (ctx#>>'{session,revision}')::int is distinct from expected_revision or p.revision is distinct from expected_proposal_revision then raise exception 'REVISION_CONFLICT';end if;
 select * into r from public.proposal_authoring_revisions where id=a.current_revision_id;
 select * into review from public.proposal_authoring_reviews ar where ar.workspace_id=a.workspace_id and ar.id=adopt_authored_response.review_id and ar.session_id=a.id and ar.authoring_revision_id=r.id;
 if review.id is null or review.context_hash is distinct from ctx->>'context_hash' or review.report->>'substantive_complete' is distinct from 'true' or review.report->'diagnostics'<>'[]'::jsonb then raise exception 'AUTHORING_REVIEW_REQUIRED';end if;
 perform app_private.delivery_actor(a.workspace_id,review.created_by,true);
 select * into s from public.proposal_delivery_snapshots where id=review.snapshot_id;
 if s.payload->>'substantive_complete' is distinct from 'true' or p.active_delivery_snapshot_id is distinct from s.id or jsonb_array_length(ctx->'inventory_missing_ids')>0 then raise exception 'AUTHORING_REVIEW_REQUIRED';end if;
 body:=r.body;ev:=(select evidence_revision from public.workspaces where id=a.workspace_id);
 frozen:=app_private.delivery_input(a.workspace_id,a.opportunity_id)||jsonb_build_object('proposal_consistency_version',1,'source_contract_version',1,'authoring_origin',jsonb_build_object('session_id',a.id,'revision_id',r.id,'review_id',review.id,'body_hash',r.body_hash),
  'source_evidence',app_private.source_review_evidence(a.workspace_id,a.opportunity_id,app_private.source_review_sources(a.workspace_id,a.opportunity_id)));
 frozen:=jsonb_set(frozen,'{knowledge}',coalesce((select jsonb_agg(x) from jsonb_array_elements(ctx->'sources') x where x->>'kind'='knowledge'),'[]'));
 insert into public.generation_plans(workspace_id,opportunity_id,proposal_id,base_version_id,kind,stage,status,evidence_revision,input_hash,frozen_context,execution_policy,created_by)
 values(a.workspace_id,a.opportunity_id,p.id,p.active_version_id,'proposal','completed','completed',ev,r.body_hash,frozen,'{"mode":"authorized_structured_authoring","version":1}',actor_id) returning * into plan;
 for req in select value from jsonb_array_elements(body->'requirements') loop
  mapped:=gen_random_uuid();mapping:=mapping||jsonb_build_object(req->>'id',mapped);
  insert into public.requirements(id,workspace_id,plan_id,opportunity_id,text,category,mandatory,source_refs,source_semantics,interpretation,acceptance_evidence,created_by)
  values(mapped,a.workspace_id,plan.id,a.opportunity_id,req->>'text','authorized_source_review',(req->>'mandatory')::boolean,req->'source_refs',req->'source_semantics','',(select x->>'acceptance_evidence' from jsonb_array_elements(body->'fulfillment') x where x->>'requirement_id'=req->>'id'),actor_id);
 end loop;
 select coalesce(max(x.ordinal),0)+1 into version_ordinal from public.proposal_versions x where x.proposal_id=p.id;
 insert into public.proposal_versions(workspace_id,proposal_id,ordinal,content_hash,package_hash,plan_id,evidence_revision,review_result,commercial_draft,separate_volumes,created_by)
 values(a.workspace_id,p.id,version_ordinal,encode(sha256(convert_to(jsonb_build_array(body,mapping,review.id)::text,'UTF8')),'hex'),s.content_hash,plan.id,ev,jsonb_build_object('origin','authorized_structured_authoring','source_review_id',review.id,'approval_state','draft'),'{"currency":null,"lines":[],"assumptions":[],"questions":[]}',(s.payload->>'separate_volumes')::boolean,actor_id) returning * into v;
 ordinal:=0;
 for section in select value from jsonb_array_elements(body->'sections') loop
  insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,evidence_refs,content_blocks,requirement_ids,volume,fixed,company_claims,created_by)
  values(a.workspace_id,v.id,section->>'key',section->>'title',(select string_agg(case when x->>'type'='table' then x::text else x->>'text' end,E'\n' order by n) from jsonb_array_elements(section->'content_blocks') with ordinality t(x,n)),ordinal,section->'evidence_refs',section->'content_blocks',(select coalesce(jsonb_agg(mapping->>x),'[]') from jsonb_array_elements_text(section->'requirement_ids') x),section->>'volume',false,section->'company_claims',actor_id);ordinal:=ordinal+1;
 end loop;
 for item in select value from jsonb_array_elements(body->'pending_inputs') loop
  insert into public.questions(workspace_id,opportunity_id,proposal_version_id,question,blocking_level,reason,created_by) values(a.workspace_id,a.opportunity_id,v.id,item->>'question',case when item->>'required_for'='substantive_completion' then 'generation' else 'finalization' end,'Authored input remains unresolved.',actor_id);
 end loop;
 for section in select value from jsonb_array_elements(body->'sections') loop
  for item in select value from jsonb_array_elements(section->'questions') loop
   insert into public.questions(workspace_id,opportunity_id,proposal_version_id,question,blocking_level,target_section_key,reason,created_by) values(a.workspace_id,a.opportunity_id,v.id,item->>'question',item->>'blocking_level',section->>'key','Authored response question.',actor_id);
  end loop;
  for item in select value from jsonb_array_elements(section->'assumptions') loop
   insert into public.questions(workspace_id,opportunity_id,proposal_version_id,question,blocking_level,target_section_key,reason,created_by) values(a.workspace_id,a.opportunity_id,v.id,item#>>'{}','finalization',section->>'key','Confirm the authored assumption before final approval.',actor_id);
  end loop;
 end loop;
 insert into public.proposal_authoring_adoptions(workspace_id,session_id,authoring_revision_id,review_id,proposal_version_id,body_hash,requirement_map,created_by) values(a.workspace_id,a.id,r.id,review.id,v.id,r.body_hash,mapping,actor_id);
 update public.approvals set invalidated_at=now(),revision=revision+1 where workspace_id=a.workspace_id and proposal_version_id in(select id from public.proposal_versions where proposal_id=p.id) and invalidated_at is null;
 update public.proposal_versions set status='superseded',revision=revision+1,updated_at=now() where proposal_id=p.id and id<>v.id and status in ('draft','in_review','approved');
 update public.proposals set active_version_id=v.id,state='draft',revision=revision+1,updated_at=now() where id=p.id;
 -- Rebind actual fulfillment to the new canonical requirement identities. This
 -- is suggested input for the normal current-source review, not a carried pass.
 update public.proposal_versions set consistency_review=jsonb_build_object('confirmed',false,'origin','authoring_adoption','fulfillment',(select jsonb_agg(x||jsonb_build_object('requirement_id',mapping->>(x->>'requirement_id'))) from jsonb_array_elements(body->'fulfillment') x),'source_review_id',review.id) where id=v.id;
 result:=jsonb_build_object('proposal_id',p.id,'proposal_version_id',v.id,'version_revision',v.revision,'authoring_revision_id',r.id,'requirement_map',mapping,'approval_state','draft');
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(a.workspace_id,actor_id,'COMMAND','proposal.authoring.adopt',idempotency_key,digest,result);
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(a.workspace_id,actor_id,'proposal.authoring.adopted','proposal_version',v.id,jsonb_build_object('session_id',a.id,'authoring_revision_id',r.id,'review_id',review.id,'body_hash',r.body_hash));
 return result;
end $$;

alter function app_private.approval_gate(uuid,uuid) rename to approval_gate_before_authoring;
create function app_private.approval_gate(w uuid,version_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare result jsonb;v public.proposal_versions;begin
 result:=app_private.approval_gate_before_authoring(w,version_id);select * into v from public.proposal_versions where workspace_id=w and id=version_id;
 if exists(select 1 from public.proposal_authoring_sessions a join public.proposal_authoring_revisions r on r.id=a.current_revision_id
  where a.workspace_id=w and a.proposal_id=v.proposal_id and jsonb_array_length(r.body->'sections')>0
   and not exists(select 1 from public.proposal_authoring_sessions successor where successor.workspace_id=w and successor.predecessor_id=a.id)
   and not exists(select 1 from public.proposal_authoring_adoptions adopted where adopted.workspace_id=w and adopted.session_id=a.id and adopted.authoring_revision_id=r.id and adopted.body_hash=r.body_hash and adopted.proposal_version_id=v.id)) then
  result:=jsonb_set(result,'{blockers}',(result->'blockers')||'"AUTHORING_RESPONSE_RECONCILIATION_REQUIRED: adopt the current reviewed authored response before approving this version."'::jsonb);
 end if;return result;
end $$;
alter function app_private.backup_tables() rename to backup_tables_before_authoring_adoption;
create function app_private.backup_tables() returns text[] language sql immutable set search_path='' as $$select app_private.backup_tables_before_authoring_adoption()||array['proposal_authoring_adoptions']::text[]$$;
alter function app_private.purge_scope(uuid,uuid) rename to purge_scope_before_authoring_adoption;
create function app_private.purge_scope(w uuid,opp uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$declare result jsonb;part jsonb;begin
 result:=app_private.purge_scope_before_authoring_adoption(w,opp);
 select jsonb_build_object('ids',coalesce(jsonb_agg(x.id order by x.id),'[]'),'hash',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,',' order by x.id),''),'UTF8')),'hex')) into part from public.proposal_authoring_adoptions x where x.workspace_id=w and x.session_id in(select id from public.proposal_authoring_sessions where workspace_id=w and opportunity_id=opp);
 return result||jsonb_build_object('proposal_authoring_adoptions',part);
end $$;
do $$declare signature text;r text;begin
 foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop if exists(select 1 from pg_roles where rolname=r) then execute 'revoke all on public.proposal_authoring_adoptions from '||quote_ident(r);if r in ('service_role','tdp_app_service') then execute 'grant all on public.proposal_authoring_adoptions to '||quote_ident(r);end if;end if;end loop;
 foreach signature in array array['public.adopt_authored_response(uuid,uuid,integer,integer,uuid,text)','app_private.approval_gate(uuid,uuid)','app_private.approval_gate_before_authoring(uuid,uuid)','app_private.backup_tables_before_authoring_adoption()','app_private.backup_tables()','app_private.purge_scope_before_authoring_adoption(uuid,uuid)','app_private.purge_scope(uuid,uuid)'] loop
 execute 'revoke all on function '||signature||' from public';foreach r in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop if exists(select 1 from pg_roles where rolname=r) then execute 'revoke all on function '||signature||' from '||quote_ident(r);if r in ('service_role','tdp_app_service') and signature like 'public.%' then execute 'grant execute on function '||signature||' to '||quote_ident(r);end if;end if;end loop;end loop;end $$;
