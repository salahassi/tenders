-- A newly authorized proposal should not wait for the dispatcher's periodic
-- recovery tick. Reuse the existing deduplicated admission trigger: its early
-- replay exits and every canonical authorization check remain authoritative.
-- Only the installed durable-outbox runtime receives this transactional hint;
-- legacy Supabase HTTP dispatch keeps its existing scheduling boundary.
do $admission_wake$
declare definition text;marker text:=$old$ perform set_config('app.issuance_authorizing',coalesce(previous,''),true);
 return new;$old$;
begin
 select pg_get_functiondef('app_private.admit_proposal_issuance()'::regprocedure) into definition;
 if length(definition)-length(replace(definition,marker,''))<>length(marker)
 then raise exception 'PROPOSAL_ADMISSION_WAKE_CONTRACT_CHANGED';end if;
 execute replace(definition,marker,$new$ perform set_config('app.issuance_authorizing',coalesce(previous,''),true);
 -- The outbox write and notification commit with the admitted issuance. The
 -- normal dispatcher still owns enabled state, due work, leases and capacity.
 if new.operation in ('proposal.generate','generation.retry')
  and to_regclass('app_private.k8s_dispatch_queue') is not null then
  perform app_private.dispatch_backend();
 end if;
 return new;$new$);
end $admission_wake$;
