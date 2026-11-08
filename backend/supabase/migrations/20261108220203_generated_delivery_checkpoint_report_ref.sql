-- ModelGraphStore stores typed, base64-encoded checkpoints. Read only the
-- selected checkpoint's reportRef; a different report is never a substitute.
create function app_private.model_graph_checkpoint_report_ref(stored jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare checkpoint jsonb;encoded text;decoded bytea;report_ref text;begin
 if jsonb_typeof(stored) is distinct from 'object' or octet_length(stored::text)>262144 then return null;end if;
 -- ModelGraphStore has always used this envelope. Raw test-only objects and
 -- incomplete/unsupported envelopes must not fall through to a raw field.
 if stored->>'type' is distinct from 'json' or jsonb_typeof(stored->'data') is distinct from 'string'
  or stored-array['type','data'] is distinct from '{}'::jsonb then return null;end if;
 encoded:=stored->>'data';
 if length(encoded) not between 1 and 262144 or length(encoded)%4<>0
  or encoded !~ '^[A-Za-z0-9+/]*={0,2}$' then return null;end if;
 decoded:=decode(encoded,'base64');
 -- Match the actual btoa wire encoding, including canonical padding bits.
 if replace(encode(decoded,'base64'),E'\n','')<>encoded then return null;end if;
 checkpoint:=convert_from(decoded,'UTF8')::jsonb;
 if jsonb_typeof(checkpoint) is distinct from 'object'
  or jsonb_typeof(checkpoint->'channel_values') is distinct from 'object'
  or jsonb_typeof(checkpoint#>'{channel_values,reportRef}') is distinct from 'string' then return null;end if;
 report_ref:=checkpoint#>>'{channel_values,reportRef}';
 if report_ref !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then return null;end if;
 return report_ref;
exception when data_exception then return null;
end$$;

do $$declare role_name text;begin
 revoke all on function app_private.model_graph_checkpoint_report_ref(jsonb) from public;
 foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
  if exists(select 1 from pg_roles where rolname=role_name) then
   execute format('revoke all on function app_private.model_graph_checkpoint_report_ref(jsonb) from %I',role_name);
  end if;
 end loop;
end$$;

-- Change only wire decoding in the lease-bound receipt projection. Keep the
-- latest checkpoint, exact graph/thread, accepted output equality, coverage,
-- completed-step filter and all actor/source/deadline checks unchanged.
do $$declare definition text;marker text:=$marker$last_state.checkpoint#>>'{channel_values,reportRef}'$marker$;begin
 definition:=pg_get_functiondef('public.generated_delivery_context_before_source_resolution(uuid,uuid)'::regprocedure);
 if length(definition)-length(replace(definition,marker,''))<>length(marker) then
  raise exception 'GENERATED_DELIVERY_CHECKPOINT_JOIN_CHANGED';
 end if;
 execute replace(definition,marker,'app_private.model_graph_checkpoint_report_ref(last_state.checkpoint)');
end$$;
