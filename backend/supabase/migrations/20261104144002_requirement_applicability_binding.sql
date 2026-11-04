-- Reuse the existing Owner compliance.save decision, binding it to the current
-- requirement and complete proposal content. No separate approval permission.
alter table public.compliance_responses add column applicability_binding_hash text
 check(applicability_binding_hash is null or applicability_binding_hash~'^[a-f0-9]{64}$');

create function app_private.requirement_applicability_binding(w uuid,version_id uuid,requirement_id uuid) returns text
language plpgsql stable security definer set search_path='' as $$
declare v public.proposal_versions;r public.requirements;sections jsonb;review jsonb;
begin
 select * into v from public.proposal_versions where workspace_id=w and id=version_id;
 select * into r from public.requirements where workspace_id=w and id=requirement_id and plan_id=v.plan_id;
 if v.id is null or r.id is null or not exists(select 1 from public.proposals p join public.opportunities o on o.workspace_id=p.workspace_id and o.id=p.opportunity_id where p.workspace_id=w and p.id=v.proposal_id and p.active_version_id=v.id and not o.archived)
  or v.evidence_revision is distinct from (select evidence_revision from public.workspaces where id=w)
  or r.source_semantics->>'authority_status' is distinct from 'confirmed' or coalesce(r.source_semantics->>'authority_role','unknown')='unknown'
  or not app_private.check_source_semantics(w,r.source_semantics,r.source_refs) then return null;end if;
 select to_jsonb(s) into review from public.source_obligation_reviews s where s.workspace_id=w and s.review_id=(r.source_semantics->>'review_id')::uuid order by s.revision desc limit 1;
 select coalesce(jsonb_agg(to_jsonb(s)-'created_at'-'updated_at'-'revision' order by s.ordinal,s.id),'[]') into sections from public.proposal_sections s where s.workspace_id=w and s.proposal_version_id=v.id;
 return encode(sha256(convert_to(jsonb_build_object('policy','requirement-applicability-v1','workspace_id',w,'version_id',v.id,'content_hash',v.content_hash,'package_hash',v.package_hash,'evidence_revision',v.evidence_revision,'separate_volumes',v.separate_volumes,
 'requirement',jsonb_build_object('id',r.id,'text',r.text,'category',r.category,'mandatory',r.mandatory,'source_refs',r.source_refs,'source_semantics',r.source_semantics),'source_review',review,'sections',sections)::text,'UTF8')),'hex');
end$$;

create function app_private.bind_requirement_applicability() returns trigger
language plpgsql security definer set search_path='' as $$declare current_hash text;versioned boolean;begin
 select coalesce(g.frozen_context->'proposal_consistency_version'='1'::jsonb or g.frozen_context->'source_contract_version'='1'::jsonb,false) into versioned from public.proposal_versions v join public.generation_plans g on g.workspace_id=v.workspace_id and g.id=v.plan_id where v.workspace_id=new.workspace_id and v.id=new.proposal_version_id;
 -- A restore clears confirmed_by under the existing recovery policy. Preserve
 -- that historical row without manufacturing a fresh applicability approval.
 if not coalesce(versioned,false) or new.status<>'not_applicable_approved' or new.confirmed_by is null then new.applicability_binding_hash:=null;return new;end if;
 if auth.uid() is distinct from new.confirmed_by or app_private.member_role(new.workspace_id) is distinct from 'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 if new.confirmed_at is null or length(trim(new.rationale))<10 then raise exception 'REASON_REQUIRED';end if;
 current_hash:=app_private.requirement_applicability_binding(new.workspace_id,new.proposal_version_id,new.requirement_id);
 if current_hash is null then raise exception 'STALE_SOURCE_APPLICABILITY';end if;
 new.applicability_binding_hash:=current_hash;return new;
end$$;
create trigger bind_requirement_applicability before insert or update on public.compliance_responses for each row execute function app_private.bind_requirement_applicability();

create function app_private.approved_requirement_exclusions(w uuid,version_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$declare c public.compliance_responses;current_hash text;result jsonb:='[]';begin
 for c in select * from public.compliance_responses where workspace_id=w and proposal_version_id=version_id and status='not_applicable_approved' and applicability_binding_hash is not null loop
  if not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=w and m.user_id=c.confirmed_by and m.active and m.role='Owner' and a.status='active') then continue;end if;
  current_hash:=app_private.requirement_applicability_binding(w,version_id,c.requirement_id);
  if current_hash is null or current_hash<>c.applicability_binding_hash or c.confirmed_at is null or length(trim(c.rationale))<10 then continue;end if;
  result:=result||jsonb_build_array(jsonb_build_object('requirement_id',c.requirement_id,'approval_id',c.id,'actor_id',c.confirmed_by,'approved_by_role','Owner','binding_hash',current_hash,'reason',c.rationale));
 end loop;return result;
end$$;

-- Extend only the two context projections. Existing actor/currentness/source
-- guards and report binding computation remain in the installed function.
do $$declare definition text;marker text;begin
 definition:=pg_get_functiondef('app_private.proposal_consistency_data(uuid,uuid)'::regprocedure);
 marker:='''mandatory'',r.mandatory,''source_refs'',r.source_refs';
 if position(marker in definition)=0 then raise exception 'APPLICABILITY_REQUIREMENT_PROJECTION_CHANGED';end if;
 definition:=replace(definition,marker,$new$'mandatory',r.mandatory,'applicability_binding',app_private.requirement_applicability_binding(w,v.id,r.id),'source_review_reason',(select sr.reason from public.source_obligation_reviews sr where sr.workspace_id=w and sr.review_id=(r.source_semantics->>'review_id')::uuid order by sr.revision desc limit 1),'source_refs',r.source_refs$new$);
 marker:='input:=jsonb_build_object(''requirements'',requirements,';
 if position(marker in definition)=0 then raise exception 'APPLICABILITY_CONTEXT_PROJECTION_CHANGED';end if;
 execute replace(definition,marker,'input:=jsonb_build_object(''approved_exclusions'',app_private.approved_requirement_exclusions(w,v.id),''requirements'',requirements,');
end$$;

-- Compare the exact view the Owner approved after the existing command acquires
-- its workspace lock. Merely attaching a fresh hash at save would bless a late edit.
do $$declare definition text;target regprocedure;marker text;begin
 select p.oid::regprocedure into target from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and position('when ''compliance.save'' then' in p.prosrc)>0;
 if target is null then raise exception 'APPLICABILITY_COMMAND_CHANGED';end if;
 definition:=pg_get_functiondef(target);
 marker:='array[''proposal_version_id'',''requirement_id'',''expected_revision'',''status'',''section_keys'',''evidence_refs'',''rationale'']';
 if position(marker in definition)=0 then raise exception 'APPLICABILITY_COMMAND_KEYS_CHANGED';end if;
 definition:=replace(definition,marker,'array[''proposal_version_id'',''requirement_id'',''expected_revision'',''status'',''section_keys'',''evidence_refs'',''rationale'',''expected_applicability_binding'']');
 marker:='if requirement.id is null then raise exception ''NOT_FOUND'';end if;';
 if position(marker in definition)=0 then raise exception 'APPLICABILITY_COMMAND_SCOPE_CHANGED';end if;
 execute replace(definition,marker,marker||$new$
 if payload->>'status'='not_applicable_approved' and exists(select 1 from public.generation_plans gp where gp.workspace_id=w and gp.id=v.plan_id and (gp.frozen_context->'proposal_consistency_version'='1'::jsonb or gp.frozen_context->'source_contract_version'='1'::jsonb))
  and (payload->>'expected_applicability_binding' is null or payload->>'expected_applicability_binding' is distinct from app_private.requirement_applicability_binding(w,v.id,requirement.id)) then raise exception 'STALE_SOURCE_APPLICABILITY';end if;
 $new$);
end$$;

-- Backup rows carry the new hash, but restore explicitly removes its authority.
do $$declare definition text;marker text;begin
 definition:=pg_get_functiondef('public.commit_workspace_restore(uuid)'::regprocedure);
 marker:=$old$elsif t='compliance_responses' then data:=data||'{"confirmed_by":null,"confirmed_at":null}';$old$;
 if position(marker in definition)=0 then raise exception 'APPLICABILITY_RESTORE_GUARD_CHANGED';end if;
 execute replace(definition,marker,$new$elsif t='compliance_responses' then data:=data||'{"confirmed_by":null,"confirmed_at":null,"applicability_binding_hash":null}';$new$);
end$$;

do $$declare signature text;role_name text;begin
 foreach signature in array array['app_private.requirement_applicability_binding(uuid,uuid,uuid)','app_private.bind_requirement_applicability()','app_private.approved_requirement_exclusions(uuid,uuid)'] loop
  execute 'revoke all on function '||signature||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function '||signature||' from '||quote_ident(role_name);end if;
  end loop;
 end loop;
end$$;
