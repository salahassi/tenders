-- These fixture helpers exist only in the exact disposable database selected
-- by the coordinator. No database or workspace selector is accepted by reset.
BEGIN;
SET LOCAL ROLE __OWNER__;
-- Freeze scope from the exact reconstructed schema plus verified migrations,
-- before any fixture account or business row exists. No RPC can modify it.
create table app_private.cloud_restore_contract as
 select true as singleton,app_private.backup_tables() as backup_tables,
  (select jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname) order by n.nspname,c.relname)
   from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname in ('public','app_private') and c.relkind='r' and exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='workspace_id' and not a.attisdropped)) as scoped_tables;
revoke all on app_private.cloud_restore_contract from public;
create table app_private.cloud_restore_fixture (
 singleton boolean primary key default true check(singleton),
 source_user uuid not null,target_user uuid not null,source_workspace uuid not null,target_workspace uuid,
 source_opportunity uuid,source_review uuid,source_requirement uuid,reset_done boolean not null default false);
revoke all on app_private.cloud_restore_fixture from public;
create function app_private.check_cloud_restore_fixture() returns void language plpgsql security definer set search_path='' as $$
begin
 if current_database()<>__DATABASE_LITERAL__ or
  (select shobj_description(oid,'pg_database') from pg_database where datname=current_database()) is distinct from __DATABASE_COMMENT_LITERAL__
 then raise exception 'CLOUD_RESTORE_DATABASE_GUARD';end if;
end $$;
revoke all on function app_private.check_cloud_restore_fixture() from public;
create function public.cloud_restore_fixture_users(source_user uuid,target_user uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare source_w uuid;target_w uuid;
begin
 perform app_private.check_cloud_restore_fixture();
 if exists(select 1 from app_private.cloud_restore_fixture) or exists(select 1 from public.workspaces)
  or source_user is null or target_user is null or source_user=target_user
  or (select count(*) from auth.users)<>2
  or (select count(*) from auth.users where id in (source_user,target_user) and email like '%@example.invalid' and email_confirmed_at is not null)<>2
 then raise exception 'CLOUD_RESTORE_FIXTURE_IDENTITY';end if;
 source_w:=public.bootstrap_workspace(source_user,'Isolated cloud restore source');
 insert into app_private.cloud_restore_fixture(source_user,target_user,source_workspace,target_workspace)
 values(source_user,target_user,source_w,target_w);
 return jsonb_build_object('source_workspace',source_w,'target_workspace',target_w);
end $$;
revoke all on function public.cloud_restore_fixture_users(uuid,uuid) from public;
grant execute on function public.cloud_restore_fixture_users(uuid,uuid) to __SERVICE__;

-- A dormant synthetic requirement exercises import ordering and assurance
-- invalidation. It has no worker job, successful model step or issued proposal.
create function public.cloud_restore_fixture_requirement(opportunity_id uuid,review_id uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare f app_private.cloud_restore_fixture;r jsonb;p uuid;requirement uuid:=gen_random_uuid();
begin
 perform app_private.check_cloud_restore_fixture();select * into strict f from app_private.cloud_restore_fixture where singleton for update;
 if f.reset_done or f.source_requirement is not null or not exists(select 1 from public.opportunities where id=opportunity_id and workspace_id=f.source_workspace)
 then raise exception 'CLOUD_RESTORE_FIXTURE_IDENTITY';end if;
 perform set_config('request.jwt.claim.sub',f.source_user::text,true);
 r:=app_private.source_obligation_inventory(f.source_workspace,opportunity_id,array[review_id])->0;
 if r is null or r->'source_semantics'->>'review_status' is distinct from 'confirmed' or r->'source_semantics'->>'authority_status' is distinct from 'confirmed'
 then raise exception 'CLOUD_RESTORE_CONFIRMED_SOURCE_REQUIRED';end if;
 insert into public.generation_plans(workspace_id,opportunity_id,kind,stage,status,evidence_revision,input_hash,frozen_context,created_by)
 select f.source_workspace,opportunity_id,'proposal','analysis','canceled',w.evidence_revision,repeat('d',64),
  jsonb_build_object('source_contract_version',1,'input_materials',jsonb_build_object('documents','[]'::jsonb),
   'source_evidence',public.source_review_context(opportunity_id)->'source_evidence'),f.source_user
 from public.workspaces w where w.id=f.source_workspace returning id into p;
 insert into public.requirements(id,workspace_id,plan_id,opportunity_id,text,category,mandatory,source_refs,source_semantics,interpretation,acceptance_evidence,created_by)
 values(requirement,f.source_workspace,p,opportunity_id,r->>'text','functional',true,r->'source_refs',r->'source_semantics','Synthetic restore-only requirement','Source review retained; no model execution',f.source_user);
 update app_private.cloud_restore_fixture set source_opportunity=opportunity_id,source_review=review_id,source_requirement=requirement where singleton;
 return requirement;
end $$;
revoke all on function public.cloud_restore_fixture_requirement(uuid,uuid) from public;
grant execute on function public.cloud_restore_fixture_requirement(uuid,uuid) to __SERVICE__;

create function public.cloud_restore_reset_source() returns jsonb language plpgsql security definer set search_path='' as $$
declare f app_private.cloud_restore_fixture;t text;item jsonb;unexpected boolean;triggers_before jsonb;triggers_after jsonb;allowed text[];all_scoped jsonb;target_w uuid;
begin
 perform app_private.check_cloud_restore_fixture();select * into strict f from app_private.cloud_restore_fixture where singleton for update;
 select backup_tables,scoped_tables into strict allowed,all_scoped from app_private.cloud_restore_contract where singleton;
 if f.reset_done or f.source_requirement is null or f.target_workspace is not null or (select count(*) from public.workspaces)<>1
  or not exists(select 1 from public.workspaces where id=f.source_workspace and name='Isolated cloud restore source')
  or not exists(select 1 from public.memberships where workspace_id=f.source_workspace and user_id=f.source_user and active and role='Owner')
  or app_private.backup_tables() is distinct from allowed
 then raise exception 'CLOUD_RESTORE_FIXTURE_IDENTITY';end if;
 for item in select value from jsonb_array_elements(all_scoped) loop
  execute format('select exists(select 1 from %I.%I where workspace_id is distinct from $1)',item->>'schema',item->>'table') into unexpected using f.source_workspace;
  if unexpected then raise exception 'CLOUD_RESTORE_NONFIXTURE_ROWS';end if;
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',tr.tgname,'enabled',tr.tgenabled,'definition',pg_get_triggerdef(tr.oid)) order by c.relname,tr.tgname),'[]') into triggers_before
 from pg_trigger tr join pg_class c on c.oid=tr.tgrelid join pg_namespace n on n.oid=c.relnamespace
 where all_scoped @> jsonb_build_array(jsonb_build_object('schema',n.nspname,'table',c.relname)) and not tr.tgisinternal;
 if exists(select 1 from jsonb_array_elements(triggers_before) x where x->>'enabled'<>'O') then raise exception 'CLOUD_RESTORE_UNEXPECTED_TRIGGER_STATE';end if;
 set constraints all deferred;
 -- Fixture teardown only. Immutable review history otherwise correctly forbids
 -- DELETE. PostgreSQL rollback restores these exact DDL changes on any error.
 for item in select value from jsonb_array_elements(all_scoped) loop execute format('alter table %I.%I disable trigger user',item->>'schema',item->>'table');end loop;
 for t in select value from unnest(allowed) with ordinality item(value,ordinal) order by ordinal desc loop
  if t='workspace_actors' then continue;end if;
  execute format('delete from public.%I where workspace_id=$1',t) using f.source_workspace;
 end loop;
 -- Remove only this fixture's remaining membership/configuration/idempotency
 -- metadata. The frozen scope came from the exact reviewed isolated schema.
 for item in select value from jsonb_array_elements(all_scoped) where value->>'table'<>'workspace_actors' loop
  execute format('delete from %I.%I where workspace_id=$1',item->>'schema',item->>'table') using f.source_workspace;
 end loop;
 delete from public.workspace_actors where workspace_id=f.source_workspace;
 -- Flush deferred FK trigger events before changing table trigger metadata.
 -- Any FK error rolls back the deletes and the earlier disable statements.
 set constraints all immediate;
 for item in select value from jsonb_array_elements(all_scoped) loop execute format('alter table %I.%I enable trigger user',item->>'schema',item->>'table');end loop;
 select coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'name',tr.tgname,'enabled',tr.tgenabled,'definition',pg_get_triggerdef(tr.oid)) order by c.relname,tr.tgname),'[]') into triggers_after
 from pg_trigger tr join pg_class c on c.oid=tr.tgrelid join pg_namespace n on n.oid=c.relnamespace
 where all_scoped @> jsonb_build_array(jsonb_build_object('schema',n.nspname,'table',c.relname)) and not tr.tgisinternal;
 if triggers_after is distinct from triggers_before then raise exception 'CLOUD_RESTORE_TRIGGER_STATE_CHANGED';end if;
 delete from public.workspaces where id=f.source_workspace;
 -- Keep the actual singleton constraint. Bootstrap the second verified Owner
 -- only after the synthetic source workspace is completely removed.
 target_w:=public.bootstrap_workspace(f.target_user,'Isolated cloud restore target');
 perform app_private.assert_empty_recovery_target(target_w);
 update app_private.cloud_restore_fixture set reset_done=true,target_workspace=target_w where singleton;
 return jsonb_build_object('target_workspace',target_w,'source_workspace',f.source_workspace,'trigger_fingerprint_preserved',true);
end $$;
revoke all on function public.cloud_restore_reset_source() from public;
grant execute on function public.cloud_restore_reset_source() to __SERVICE__;
NOTIFY pgrst,'reload schema';COMMIT;
