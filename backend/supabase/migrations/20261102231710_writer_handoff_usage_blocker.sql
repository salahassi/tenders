-- A retained writer result may be validly identified while an earlier fallback
-- request has unknown usage. Keep that accounting guard, but report the actual
-- recovery requirement instead of presenting it as MODEL_IDENTITY_CHANGED.
do $patch$
declare definition text; original text; replacement text;
begin
 select pg_get_functiondef('app_private.writer_validation_handoff(uuid,uuid,text,jsonb)'::regprocedure) into definition;
 original:=$old$  or exists(select 1 from public.provider_usage other where other.workspace_id=j.workspace_id and other.job_id=j.id
    and (other.state='reserved' or (other.state='unknown' and (other.input_hash=u.input_hash
      or left(other.call_key,length(v->>'request_prefix')+1)=(v->>'request_prefix')||':'))))
  then return 'false'::jsonb;end if;$old$;
 replacement:=$new$  or exists(select 1 from public.provider_usage other where other.workspace_id=j.workspace_id and other.job_id=j.id
    and other.state='reserved')
  then return 'false'::jsonb;end if;
 -- Do not clear the round, consume another candidate allowance, or alter any
 -- receipt until ambiguous same-operation usage has been reconciled.
 if exists(select 1 from public.provider_usage other where other.workspace_id=j.workspace_id and other.job_id=j.id
    and other.state='unknown' and (other.input_hash=u.input_hash
      or left(other.call_key,length(v->>'request_prefix')+1)=(v->>'request_prefix')||':'))
 then raise exception 'USAGE_REVIEW_REQUIRED';end if;$new$;
 if position(replacement in definition)>0 then return;end if;
 if position(original in definition)=0 then raise exception 'Writer handoff usage guard changed';end if;
 execute replace(definition,original,replacement);
end $patch$;
