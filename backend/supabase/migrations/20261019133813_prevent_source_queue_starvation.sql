-- Keep accepted remote requests first, then give waiting source work a bounded turn.
-- updated_at resets on an attempt/continuation, so sources also yield to other work.
do $$ declare definition text;old text;begin
 select pg_get_functiondef('public.claim_backend_job()'::regprocedure) into definition;
 old:='order by case when error_code=''MODEL_IN_PROGRESS'' then 0 else 1 end,';
 if position(old in definition)=0 then raise exception 'Claim ordering changed';end if;
 execute replace(definition,old,old||'case when type in (''source_collect'',''source_candidates'') and updated_at<now()-interval ''2 minutes'' then 0 else 1 end,');
end $$;
