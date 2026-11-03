-- Analysis uses the registry's tenderdesk-v3 prompt identity. The earlier
-- recheck guard incorrectly inferred a prompt prefix from the task name.
-- Bind this correction narrowly to the immutable semantic-four writer phase;
-- keep the original receipt, candidate, graph and verifier history unchanged.
do $migration$
declare definition text;old_guard text;new_guard text;
begin
 select pg_get_functiondef('app_private.analysis_recheck_binding(uuid)'::regprocedure) into definition;
 old_guard:=$old$coalesce(a.execution_metadata->>'prompt_version','') not like 'analyze_chunk.%'$old$;
 new_guard:=$new$a.execution_metadata->>'prompt_version' is distinct from 'tenderdesk-v3.evidence-v1.tenderdesk-semantic-fidelity-v1.economy-v1'
  or not exists(select 1 from app_private.model_graph_results writer_pin
   where writer_pin.thread_id=r.parent_thread_id
    and writer_pin.result_key='semantic-instructions-'||encode(sha256(convert_to('step:'||r.parent_step_id||':candidate-0','UTF8')),'hex')
    and writer_pin.value->'version'='4'::jsonb
    and writer_pin.value->>'legacy_input_hash' ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(writer_pin.value->'instructions')='string'
    and writer_pin.content_hash=encode(sha256(convert_to(writer_pin.value::text,'UTF8')),'hex'))$new$;
 if (length(definition)-length(replace(definition,old_guard,'')))/length(old_guard)<>1 then
  raise exception 'ANALYSIS_RECHECK_PROMPT_GUARD_CHANGED';
 end if;
 execute replace(definition,old_guard,new_guard);
end $migration$;
