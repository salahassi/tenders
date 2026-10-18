-- Scope is owner configuration, not an embedded business category.
create function app_private.scope_keywords(raw jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare result jsonb;
begin
 if raw is null or jsonb_typeof(raw) is distinct from 'array' then raise exception 'INVALID_INPUT';end if;
 if jsonb_array_length(raw)>24 then raise exception 'INVALID_INPUT';end if;
 if exists(select 1 from jsonb_array_elements(raw) x where jsonb_typeof(x)<>'string' or length(btrim(regexp_replace(x#>>'{}','\s+',' ','g'))) not between 1 and 100) then raise exception 'INVALID_INPUT';end if;
 select coalesce(jsonb_agg(term order by n),'[]'::jsonb) into result from (
  select distinct on (lower(term)) term,n from (
   select btrim(regexp_replace(value,'\s+',' ','g')) term,ordinality n from jsonb_array_elements_text(raw) with ordinality
  ) terms order by lower(term),n
 ) unique_terms;
 return result;
end $$;
revoke all on function app_private.scope_keywords(jsonb) from public,anon,authenticated,service_role;

create function app_private.discovery_scope(policy jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare interests jsonb;exclusions jsonb;source text:=policy->>'scope';
begin
 if source is null or source not in ('company_knowledge','keywords','combined') then raise exception 'INVALID_INPUT';end if;
 interests:=app_private.scope_keywords(coalesce(policy->'include_keywords','[]'::jsonb));
 exclusions:=app_private.scope_keywords(coalesce(policy->'exclude_keywords','[]'::jsonb));
 if source='keywords' and jsonb_array_length(interests)=0 or source='combined' and jsonb_array_length(interests)+jsonb_array_length(exclusions)=0 then raise exception 'INVALID_INPUT';end if;
 if source<>'company_knowledge' and exists(select 1 from jsonb_array_elements_text(interests) i join jsonb_array_elements_text(exclusions) e on lower(i.value)=lower(e.value)) then raise exception 'INVALID_INPUT';end if;
 return jsonb_build_object('scope',source,'include_keywords',interests,'exclude_keywords',exclusions);
end $$;
revoke all on function app_private.discovery_scope(jsonb) from public,anon,authenticated,service_role;

alter table public.workspaces drop constraint workspaces_discovery_policy_check;
alter table public.workspaces alter column discovery_policy set default '{"scope":"company_knowledge","include_keywords":[],"exclude_keywords":[],"auto_public_notices":false,"auto_company_knowledge":false,"providers":[]}'::jsonb;
-- Do not manufacture customer interests from a retired preset. Each Owner can
-- configure their own terms; retain sharing consent and all assessment history.
do $$ declare w uuid;begin
 for w in update public.workspaces set discovery_policy=discovery_policy||'{"scope":"company_knowledge","include_keywords":[],"exclude_keywords":[]}'::jsonb,
   evidence_revision=evidence_revision+1,revision=revision+1,updated_at=now()
   where discovery_policy->>'scope' in ('all','software_services') returning id loop
  update public.opportunities set assessment_pending=true where workspace_id=w and not archived;
  update public.approvals set invalidated_at=coalesce(invalidated_at,now()) where workspace_id=w;
 end loop;
end $$;
alter table public.workspaces add constraint workspaces_discovery_policy_check check (
 jsonb_typeof(discovery_policy)='object' and discovery_policy->>'scope' in ('company_knowledge','keywords','combined')
 and jsonb_typeof(discovery_policy->'include_keywords')='array' and jsonb_typeof(discovery_policy->'exclude_keywords')='array' and pg_column_size(discovery_policy)<16384
);

create or replace function app_private.reset_discovery_on_restore() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.restore_origin is distinct from old.restore_origin then
  new.discovery_policy:='{"scope":"company_knowledge","include_keywords":[],"exclude_keywords":[],"auto_public_notices":false,"auto_company_knowledge":false,"providers":[]}'::jsonb;
 end if;
 return new;
end $$;

create or replace function app_private.generation_snapshot_before_details(w uuid,opp uuid,proposal uuid,package uuid) returns jsonb language sql security definer set search_path='' as $$
 select app_private.generation_snapshot_before_discovery(w,opp,proposal,package)||jsonb_build_object('discovery_scope',discovery_policy->>'scope','discovery_scope_policy',app_private.discovery_scope(discovery_policy)) from public.workspaces where id=w
$$;
