-- Restore preserves historical source evidence without importing live reviewer
-- authority. The scoped exception is never authorized by a session setting alone.
create function app_private.restoring_source_history(w uuid,plan public.generation_plans) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(plan.workspace_id=w and plan.evidence_revision=-1 and plan.error_code='RESTORED_REVIEW_REQUIRED'
  and plan.status in ('completed','canceled') and auth.uid() is not null and app_private.member_role(w)='Owner'
  and exists(select 1 from public.restore_sessions s where s.workspace_id=w and s.id::text=current_setting('app.source_review_restore',true)
   and s.created_by=auth.uid() and s.state='committing' and s.expires_at>now()),false)
$$;

-- The restored source reviews occur after requirements in the backup table
-- order. Keep the original semantic tuple and citations, but clear live assurance
-- before those later historical rows exist. Ordinary writes retain the full guard.
do $$declare definition text;marker text;begin
 definition:=pg_get_functiondef('app_private.guard_requirement_source()'::regprocedure);
 marker:='select * into plan from public.generation_plans where workspace_id=new.workspace_id and id=new.plan_id;';
 if position(marker in definition)=0 then raise exception 'SOURCE_RESTORE_REQUIREMENT_GUARD_CHANGED';end if;
 execute replace(definition,marker,marker||$new$
 if app_private.restoring_source_history(new.workspace_id,plan) then
  if new.source_semantics is not null then
   if new.source_semantics->'version' is distinct from '1'::jsonb or not app_private.valid_obligation_tuple(new.source_semantics-array['version','source_span_ids','authority_role','authority_status','review_status','review_id']) then raise exception 'SOURCE_SEMANTICS_INVALID';end if;
   new.source_semantics:=new.source_semantics||jsonb_build_object('review_status','pending','review_id',null,'authority_role','unknown','authority_status','unconfirmed');
  end if;return new;
 end if;
 $new$);
end$$;

create function app_private.invalidate_restored_source_reviews(w uuid,actor uuid) returns void
language plpgsql security definer set search_path='' as $$declare a public.source_authority_decisions;r public.source_obligation_reviews;
begin
 if actor is distinct from auth.uid() or app_private.member_role(w) is distinct from 'Owner'
  or not exists(select 1 from public.restore_sessions s where s.workspace_id=w and s.id::text=current_setting('app.source_review_restore',true) and s.created_by=actor and s.state='committing' and s.expires_at>now()) then raise exception 'RESTORE_SOURCE_SCOPE_REQUIRED';end if;
 -- Append explicit current-Owner reset decisions; imported rows, original
 -- timestamps, reviewer identities, source spans and interpretations stay intact.
 for a in select distinct on(opportunity_id,entity_kind,entity_id,content_hash) * from public.source_authority_decisions where workspace_id=w order by opportunity_id,entity_kind,entity_id,content_hash,revision desc loop
  if a.status='confirmed' then
   insert into public.source_authority_decisions(workspace_id,opportunity_id,entity_kind,entity_id,content_hash,revision,role,status,supersedes,precedence,reason,created_by)
   values(w,a.opportunity_id,a.entity_kind,a.entity_id,a.content_hash,a.revision+1,a.role,'revoked',a.supersedes,a.precedence,'Restored historical confirmation requires a current source review.',actor);
  end if;
 end loop;
 for r in select distinct on(review_id) * from public.source_obligation_reviews where workspace_id=w order by review_id,revision desc loop
  if r.status='confirmed' then
   insert into public.source_obligation_reviews(review_id,workspace_id,opportunity_id,revision,spans,semantics,status,supersedes_review_id,reason,created_by)
   values(r.review_id,w,r.opportunity_id,r.revision+1,r.spans,r.semantics,'revoked',r.supersedes_review_id,'Restored historical interpretation requires a current source review.',actor);
  end if;
 end loop;
end$$;

do $$declare definition text;marker text;begin
 definition:=pg_get_functiondef('public.commit_workspace_restore(uuid)'::regprocedure);
 marker:='total bigint;';
 if position(marker in definition)=0 then raise exception 'SOURCE_RESTORE_DECLARATION_CHANGED';end if;
 definition:=replace(definition,marker,marker||'source_restore_prior text;');
 marker:='perform app_private.check_restore(s,auth.uid());perform 1 from public.workspaces where id=s.workspace_id for update;perform app_private.assert_empty_recovery_target(s.workspace_id);';
 if position(marker in definition)=0 then raise exception 'SOURCE_RESTORE_AUTHORIZATION_CHANGED';end if;
 definition:=replace(definition,marker,marker||$new$
 -- Recheck current Owner and session validity after waiting on the workspace.
 perform app_private.check_restore(s,auth.uid());
 source_restore_prior:=current_setting('app.source_review_restore',true);
 perform set_config('app.source_review_restore',s.id::text,true);
 $new$);
 marker:='set constraints all immediate;';
 if position(marker in definition)=0 then raise exception 'SOURCE_RESTORE_COMPLETION_CHANGED';end if;
 execute replace(definition,marker,$new$
 perform app_private.invalidate_restored_source_reviews(s.workspace_id,auth.uid());
 perform set_config('app.source_review_restore',coalesce(source_restore_prior,''),true);
 $new$||marker);
end$$;

do $$declare signature text;role_name text;begin
 foreach signature in array array['app_private.restoring_source_history(uuid,public.generation_plans)','app_private.invalidate_restored_source_reviews(uuid,uuid)'] loop
  execute 'revoke all on function '||signature||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function '||signature||' from '||quote_ident(role_name);end if;
  end loop;
 end loop;
end$$;
