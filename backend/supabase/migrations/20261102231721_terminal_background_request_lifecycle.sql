-- An explicit failed/cancelled provider response terminates retrieval, even
-- when the provider omits usage. Keep accounting unknown and retain the remote
-- identity; do not infer termination from historical generic GET rejections.
do $terminal_requests$
declare signature text; definition text;
 marker text := 'p.remote_request_id is not null';
 exclusion text := 'p.remote_request_id is not null and p.error_code is distinct from ''PROVIDER_BACKGROUND_TERMINATED''';
begin
 foreach signature in array array[
  'public.resume_model_request(uuid,uuid,text,text,jsonb)',
  'public.resume_task_model_request(uuid,uuid,text,jsonb,uuid,uuid)',
  'public.resume_task_model_request_phase(uuid,uuid,text,jsonb,uuid,uuid,text)',
  'public.claim_abandoned_model_request()'
 ] loop
  select pg_get_functiondef(signature::regprocedure) into definition;
  if position(exclusion in definition)>0 then continue;end if;
  if position(marker in definition)=0 then raise exception 'TERMINAL_REQUEST_DEFINITION_CHANGED';end if;
  execute replace(definition,marker,exclusion);
 end loop;
end $terminal_requests$;

-- CREATE OR REPLACE retains the original security-definer boundaries/grants.
-- No rows are rewritten: an old ambiguous result requires a fresh provider GET.
