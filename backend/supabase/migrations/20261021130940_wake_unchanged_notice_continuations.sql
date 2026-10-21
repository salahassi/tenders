-- A successful unchanged detail read releases its lease without completing the
-- assessment. Bind that local continuation to its exact release in the existing
-- immutable audit record; never change a checkpoint, input, or provider request.
do $$ declare definition text;old text;replacement text;begin
 select pg_get_functiondef('public.complete_notice_details(uuid,uuid,jsonb)'::regprocedure) into definition;
 old:='jsonb_build_object(''job_id'',j.id,''plan_id'',p.id,''detail_url'',metadata->>''detail_url'')::text';
 replacement:='jsonb_build_object(''job_id'',j.id,''plan_id'',p.id,''detail_url'',metadata->>''detail_url'',
  ''released_lease'',lease,''job_revision'',(select revision from public.jobs where id=j.id))::text';
 if position(old in definition)=0 then raise exception 'Unchanged notice audit changed';end if;
 execute replace(definition,old,replacement);
end $$;

-- Admit only the proven healthy local continuation to the existing normal wake
-- policy. All dispatcher/restore/lease/reservation guards, revision dedupe and
-- the ten-second workspace throttle remain unchanged. Cron remains fallback.
do $$ declare definition text;old text;replacement text;begin
 select pg_get_functiondef('app_private.wake_backend_queue_checked(uuid,uuid,bigint)'::regprocedure) into definition;
 old:='remote_poll boolean:=false;eligible_at timestamptz;';
 if position(old in definition)=0 then raise exception 'Queue wake declaration changed';end if;
 definition:=replace(definition,old,'remote_poll boolean:=false;eligible_at timestamptz;detail_continuation boolean:=false;');
 old:=' -- Only an HTTP-successful accepted request can use the poll wake.';
 replacement:=$receipt$ detail_continuation:=coalesce(j.type='classify_opportunity' and j.status='retry_wait'
  and j.error_code is null and j.next_attempt_at<=now()
  and exists(select 1 from public.audit_events a where a.workspace_id=w
   and a.action='notice.details_unchanged' and a.created_at=j.updated_at
   and a.reason::jsonb @> jsonb_build_object('job_id',j.id,'plan_id',j.entity_id,
    'released_lease',lease,'job_revision',j.revision)),false);
 -- Only an HTTP-successful accepted request can use the poll wake.$receipt$;
 if position(old in definition)=0 then raise exception 'Queue wake admission changed';end if;
 definition:=replace(definition,old,replacement);
 old:='if not remote_poll and j.status not in';
 if position(old in definition)=0 then raise exception 'Queue wake continuation changed';end if;
 definition:=replace(definition,old,'if not remote_poll and not detail_continuation and j.status not in');
 old:='(q.status=''queued'' or (q.status=''retry_wait'' and q.error_code=''MODEL_IN_PROGRESS'' and not (q.checkpoint ? ''model_round'')))';
 replacement:='(q.status=''queued'' or (q.status=''retry_wait'' and q.error_code=''MODEL_IN_PROGRESS'' and not (q.checkpoint ? ''model_round''))
   or (detail_continuation and q.id=j.id))';
 if position(old in definition)=0 then raise exception 'Queue wake ready work changed';end if;
 execute replace(definition,old,replacement);
end $$;
