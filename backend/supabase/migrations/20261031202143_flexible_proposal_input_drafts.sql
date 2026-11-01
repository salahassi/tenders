-- Draft intake is deliberately more permissive than final approval. A file is
-- supplied context, not proof that it is a complete or matching buyer RFP.
-- Existing plans retain their exact snapshots, inputs and paid model work.
create function app_private.seal_draft_package(w uuid,opportunity uuid,actor uuid)
returns public.document_packages language plpgsql security definer set search_path='' as $$
declare v_manifest jsonb;digest text;result public.document_packages;
begin
 perform 1 from public.workspaces where id=w for update;
 if actor is distinct from auth.uid() or coalesce(app_private.member_role(w),'') not in ('Owner','Editor') then raise exception 'ROLE_FORBIDDEN';end if;
 if not exists(select 1 from public.opportunities where workspace_id=w and id=opportunity) then raise exception 'NOT_FOUND';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'original_hash',original_hash,
   'extraction_hash',extraction_hash,'precedence',precedence,'supersedes_id',supersedes_id) order by id),'[]')
 into v_manifest from public.documents where workspace_id=w and opportunity_id=opportunity and kind='rfp' and not archived;
 -- At least one attachment is still required. Its classification, readability
 -- and extraction-review status do not prevent a draft from being requested.
 if jsonb_array_length(v_manifest)=0 then raise exception 'READABLE_RFP_REQUIRED';end if;
 digest:=encode(sha256(convert_to(v_manifest::text,'UTF8')),'hex');
 select * into result from public.document_packages where workspace_id=w and opportunity_id=opportunity and package_hash=digest;
 if result.id is null then
  insert into public.document_packages(workspace_id,opportunity_id,ordinal,package_hash,manifest,created_by)
  select w,opportunity,coalesce(max(ordinal),0)+1,digest,v_manifest,actor
  from public.document_packages where workspace_id=w and opportunity_id=opportunity returning * into result;
 end if;
 return result;
end $$;

create function app_private.draft_generation_snapshot(w uuid,opp uuid,proposal uuid,package uuid,prior jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;blocks jsonb;reviews jsonb:='[]';materials jsonb;rec record;content jsonb;notice_fallback boolean;
begin
 if not exists(select 1 from public.opportunities where workspace_id=w and id=opp)
  or (proposal is not null and not exists(select 1 from public.proposals where workspace_id=w and id=proposal and opportunity_id=opp))
  or (package is not null and not exists(select 1 from public.document_packages where workspace_id=w and id=package and opportunity_id=opp))
 then raise exception 'NOT_FOUND';end if;
 -- The original snapshot remains authoritative for company evidence, template,
 -- rates, notice and discovery context. Rebuild review inputs below so an
 -- unread review attachment has the same nonblocking draft treatment.
 result:=app_private.generation_snapshot(w,opp,null,package);
 select coalesce(jsonb_agg(e.value order by e.ord),'[]') into blocks
 from jsonb_array_elements(result->'blocks') with ordinality e(value,ord)
 join public.documents d on d.workspace_id=w and d.id=(e.value->>'document_id')::uuid
 where d.opportunity_id=opp and d.kind='rfp' and d.status='ready' and not d.archived;
 if proposal is not null then
  for rec in select r.* from public.review_inputs r join public.proposals p
   on p.workspace_id=r.workspace_id and p.id=r.proposal_id and p.active_version_id=r.base_version_id
   where r.workspace_id=w and r.proposal_id=proposal order by r.id loop
   if length(rec.body)>0 then
    content:=app_private.content_record(w,'review',rec.id);
    reviews:=reviews||jsonb_build_array(jsonb_build_object('id',rec.id,'text',rec.body,'kind','review','verified',false,
      'target_kind',rec.target_kind,'target_id',rec.target_id,'reference',content-'content'-'title'));
   end if;
   reviews:=reviews||coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'text',b.text,'kind','review','verified',false,
     'target_kind',rec.target_kind,'target_id',rec.target_id,
     'reference',jsonb_build_object('entity_kind','document','entity_id',d.id,'content_hash',d.extraction_hash)) order by d.id,b.ordinal)
    from public.documents d join public.document_blocks b on b.workspace_id=d.workspace_id and b.document_id=d.id
    where d.workspace_id=w and d.review_input_id=rec.id and d.kind='review' and not d.archived and d.status='ready'),'[]');
  end loop;
 end if;
 if prior->'draft_input_version'='1'::jsonb then
  -- Only inputs actually selected at the request can make its paid work stale.
  -- A skipped file finishing extraction or a new attachment is for a later
  -- request; never silently adopt its text or rewrite the frozen limitation.
  notice_fallback:=coalesce((prior#>>'{input_materials,uses_notice_fallback}')::boolean,false);
  select coalesce(jsonb_agg(e.value order by e.ord),'[]') into blocks
   from jsonb_array_elements(blocks) with ordinality e(value,ord)
   where exists(select 1 from jsonb_array_elements(prior->'blocks') old where old->>'id'=e.value->>'id');
  select coalesce(jsonb_agg(e.value order by e.ord),'[]') into reviews
   from jsonb_array_elements(reviews) with ordinality e(value,ord)
   where e.value#>>'{reference,entity_kind}'<>'document'
    or exists(select 1 from jsonb_array_elements(prior->'reviews') old where old->>'id'=e.value->>'id');
  materials:=prior->'input_materials';
 else
  notice_fallback:=jsonb_array_length(blocks)=0;
  select jsonb_build_object('version',1,'uses_notice_fallback',notice_fallback,
   'documents',coalesce(jsonb_agg(jsonb_build_object('document_id',d.id,'name',d.original_name,'kind',d.kind,'status',d.status,
    'used_for_draft',d.status='ready' and exists(select 1 from public.document_blocks b where b.workspace_id=w and b.document_id=d.id and length(trim(b.text))>0),
    'extracted_characters',case when d.status='ready' then length(d.extracted_text) else 0 end) order by d.id),'[]'))
   into materials from public.documents d where d.workspace_id=w and not d.archived and (
    (d.kind='rfp' and d.opportunity_id=opp) or (d.kind='review' and exists(
      select 1 from public.review_inputs r join public.proposals p on p.workspace_id=r.workspace_id and p.id=r.proposal_id and p.active_version_id=r.base_version_id
      where r.workspace_id=w and r.id=d.review_input_id and r.proposal_id=proposal)));
 end if;
 if notice_fallback then blocks:=jsonb_build_array(result->'notice');end if;
 result:=result||jsonb_build_object('blocks',blocks,'reviews',reviews,'draft_input_version',1,'input_materials',materials);
 if pg_column_size(result)>8388608 then raise exception 'GENERATION_CONTEXT_CAP_REACHED';end if;
 return result;
end $$;

-- Only newly requested proposal work opts into these semantics. Assessment,
-- historical frozen plans and the original strict package sealer are unchanged.
do $$ declare definition text;old text;replacement text;begin
 select pg_get_functiondef('app_private.generation_command(text,jsonb,text)'::regprocedure) into definition;
 old:='pkg:=app_private.seal_package(w,opp.id,actor);';
 if position(old in definition)=0 then raise exception 'FLEXIBLE_DRAFT_PACKAGE_COMMAND_MISMATCH';end if;
 definition:=replace(definition,old,'pkg:=app_private.seal_draft_package(w,opp.id,actor);');
 old:='context:=app_private.generation_snapshot(w,opp.id,prop.id,pkg.id);';
 replacement:=$new$context:=case when operation='opportunity.assess'
  then app_private.generation_snapshot(w,opp.id,prop.id,pkg.id)
  else app_private.draft_generation_snapshot(w,opp.id,prop.id,pkg.id) end;$new$;
 if position(old in definition)=0 then raise exception 'FLEXIBLE_DRAFT_SNAPSHOT_COMMAND_MISMATCH';end if;
 execute replace(definition,old,replacement);

 select pg_get_functiondef('app_private.refresh_proposal_evidence(uuid)'::regprocedure) into definition;
 old:='current_context:=app_private.generation_snapshot(p.workspace_id,p.opportunity_id,p.proposal_id,p.package_id);';
 replacement:=$new$current_context:=case when p.frozen_context->'draft_input_version'='1'::jsonb
  then app_private.draft_generation_snapshot(p.workspace_id,p.opportunity_id,p.proposal_id,p.package_id,p.frozen_context)
  else app_private.generation_snapshot(p.workspace_id,p.opportunity_id,p.proposal_id,p.package_id) end;$new$;
 if position(old in definition)=0 then raise exception 'FLEXIBLE_DRAFT_CURRENTNESS_MISMATCH';end if;
 execute replace(definition,old,replacement);
end $$;

-- Moving review out of draft intake must not silently approve unreviewed text.
-- Check current source records at final approval; a later confirmation of the
-- same exact extraction satisfies this guard without a frozen false flag.
alter function app_private.approval_gate(uuid,uuid) rename to approval_gate_before_flexible_inputs;
create function app_private.approval_gate(w uuid,version_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;p public.generation_plans;missing boolean;
begin
 result:=app_private.approval_gate_before_flexible_inputs(w,version_id);
 select g.* into p from public.generation_plans g join public.proposal_versions v
  on v.workspace_id=g.workspace_id and v.plan_id=g.id where v.workspace_id=w and v.id=version_id;
 if p.frozen_context->'draft_input_version'='1'::jsonb then
  select exists(select 1 from jsonb_array_elements(coalesce(p.frozen_context->'blocks','[]')||coalesce(p.frozen_context->'reviews','[]')) e
   left join public.documents d on d.workspace_id=w and d.id=(e#>>'{reference,entity_id}')::uuid
   where e#>>'{reference,entity_kind}'='document' and (d.id is null or d.status<>'ready' or d.archived
    or d.extraction_confirmed_at is null or d.extraction_hash is distinct from e#>>'{reference,content_hash}')) into missing;
  if missing then result:=jsonb_set(result,'{blockers}',coalesce(result->'blockers','[]')||
   jsonb_build_array('Review the extracted text used by this draft before final approval.'));end if;
  -- Draft creation deliberately ignores attachments added after its request.
  -- Their absence must remain visible at final approval, including review
  -- attachments linked to the version from which regeneration was requested.
  select exists(select 1 from public.documents d where d.workspace_id=w and not d.archived
   and ((d.kind='rfp' and d.opportunity_id=p.opportunity_id) or (d.kind='review' and exists(
    select 1 from public.review_inputs r where r.workspace_id=w and r.id=d.review_input_id
     and r.proposal_id=p.proposal_id and r.base_version_id is not distinct from p.base_version_id)))
   and not exists(select 1 from jsonb_array_elements(coalesce(p.frozen_context#>'{input_materials,documents}','[]')) material
    where material->>'document_id'=d.id::text)) into missing;
  if missing then result:=jsonb_set(result,'{blockers}',coalesce(result->'blockers','[]')||
   jsonb_build_array('New attachments were added after this draft started; regenerate with those inputs or remove them before final approval.'));end if;
 end if;
 return result;
end $$;

do $$ declare signature text;role_name text;begin
 foreach signature in array array['app_private.seal_draft_package(uuid,uuid,uuid)',
  'app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb)',
  'app_private.approval_gate_before_flexible_inputs(uuid,uuid)','app_private.approval_gate(uuid,uuid)'] loop
  execute 'revoke all on function '||signature||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function '||signature||' from '||quote_ident(role_name);end if;
  end loop;
 end loop;
end $$;
