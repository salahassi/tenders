-- Atomic update of the existing audited command, with exact before/after guards.
-- Retains its Owner, membership, revision, idempotency, consent and audit boundaries.
do $$ declare definition text;current_body text;begin
 select prosrc,pg_get_functiondef(oid) into current_body,definition from pg_proc where oid='app_private.app_command(text,jsonb,text)'::regprocedure;
 if encode(sha256(convert_to(current_body,'UTF8')),'hex')<> 'e2b1ef29050aa4736358c8cf6d6c409a4d7f824dad7148afb1ea5200703f2668' then raise exception 'Unexpected discovery command version';end if;
 definition:=replace(definition,$old$scope_changed boolean;$old$,$new$scope_changed boolean;scope_policy jsonb;$new$);
 definition:=replace(definition,$old$'providers','auto_company_knowledge']$old$,$new$'providers','auto_company_knowledge','include_keywords','exclude_keywords']$new$);
 definition:=replace(definition,$old$pg_column_size(input)>4096$old$,$new$pg_column_size(input)>16384$new$);
 definition:=replace(definition,$old$  or coalesce(input->>'scope','') not in ('all','software_services') or coalesce(input->>'auto_public_notices','')$old$,$new$  or coalesce(input->>'auto_public_notices','')$new$);
 definition:=replace(definition,$old$ body_hash:=$old$,$new$ scope_policy:=app_private.discovery_scope(input);
 body_hash:=$new$);
 definition:=replace(definition,$old$select discovery_policy->>'scope' is distinct from input->>'scope'$old$,$new$select app_private.discovery_scope(discovery_policy) is distinct from scope_policy$new$);
 definition:=replace(definition,$old$policy:=(input-'expected_revision')||$old$,$new$policy:=(input-'expected_revision')||scope_policy||$new$);
 execute definition;
 select prosrc into current_body from pg_proc where oid='app_private.app_command(text,jsonb,text)'::regprocedure;
 if encode(sha256(convert_to(current_body,'UTF8')),'hex')<>'87eba09fc5949dbe29605e4ded74a0be7f23add57cd07a86aecb6bda0723c179' then raise exception 'Unexpected updated discovery command';end if;
end $$;
