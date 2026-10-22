-- Transaction-aborted database failures resume durable checkpoints with the
-- existing backoff/incident policy. Do not reclassify ambiguous older errors,
-- clear receipts, replenish graph budgets or reopen canceled work.
do $patch$ declare definition text; marker text; begin
 select pg_get_functiondef('app_private.recover_processing_job(uuid,timestamptz)'::regprocedure) into definition;
 marker := '''COLLECTION_LEASE_EXPIRED'',''LEASE_EXPIRED_REVIEW_REQUIRED''';
 if position(marker in definition)=0 then raise exception 'Processing recovery policy changed';end if;
 execute replace(definition,marker,marker||',''DATABASE_TEMPORARY_FAILURE''');
end $patch$;
