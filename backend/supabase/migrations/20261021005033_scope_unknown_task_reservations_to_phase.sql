-- Accepted unknown work still owns its original phase/input identity. A distinct
-- graph phase may proceed while the old request remains GET-only reconcilable.
-- Unstructured legacy call keys fail closed at the existing whole-job scope.
do $patch$
declare definition text; marker text; replacement text;
begin
 select pg_get_functiondef('public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)'::regprocedure) into definition;
 marker := '(p.job_id=j.id or p.input_hash=reserve_task_model_call.input_hash)';
 if position(marker in definition)=0 then raise exception 'Task unknown-request guard changed';end if;
 replacement := $guard$(p.input_hash=reserve_task_model_call.input_hash or
  (p.job_id=j.id and (
   p.call_key !~ ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$' or
   reserve_task_model_call.call_key !~ ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$' or
   regexp_replace(p.call_key, ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$', '')=
    regexp_replace(reserve_task_model_call.call_key, ':[a-f0-9]{16}:[0-9]+:[a-f0-9-]{36}$', '')
  )))$guard$;
 execute replace(definition,marker,replacement);
end $patch$;
