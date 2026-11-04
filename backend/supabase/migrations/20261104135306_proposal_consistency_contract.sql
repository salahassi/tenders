-- Opt new requests into targeted company followup and substantive consistency review.
-- The delegate preserves every existing input, authorization and source guard.
-- Refreshing a historical plan must not silently change its paid prompt identity.
alter function app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb)
 rename to draft_generation_snapshot_before_consistency;

create function app_private.draft_generation_snapshot(
 w uuid,opp uuid,proposal uuid,package uuid,prior jsonb default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 result:=app_private.draft_generation_snapshot_before_consistency(w,opp,proposal,package,prior);
 if prior is null then
  result:=result||jsonb_build_object('company_followup_version',1,'proposal_consistency_version',1);
 else
  -- Paid snapshots keep their exact compatibility markers, including absence.
  result:=result-'company_followup_version'-'proposal_consistency_version';
  if prior ? 'company_followup_version' then result:=result||jsonb_build_object('company_followup_version',prior->'company_followup_version'); end if;
  if prior ? 'proposal_consistency_version' then result:=result||jsonb_build_object('proposal_consistency_version',prior->'proposal_consistency_version'); end if;
 end if;
 return result;
end $$;

do $$ declare signature text;role_name text;begin
 foreach signature in array array[
  'app_private.draft_generation_snapshot_before_consistency(uuid,uuid,uuid,uuid,jsonb)',
  'app_private.draft_generation_snapshot(uuid,uuid,uuid,uuid,jsonb)'
 ] loop
  execute 'revoke all on function '||signature||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then
    execute 'revoke all on function '||signature||' from '||quote_ident(role_name);
   end if;
  end loop;
 end loop;
end $$;
