-- Prove public-reader handoffs using the existing immutable audit receipt
-- pattern. A receipt is written only after the canonical RPC releases its
-- checked parent lease; ready/blocked returns do not create handoff receipts.
create index audit_events_queue_handoff_proof on public.audit_events(workspace_id,entity_id,action,created_at)
 where action in ('queue.public_read_handoff','queue.graph_checkpoint_progress','queue.graph_handoff');

do $patch$ declare signature text;definition text;marker text;begin
 foreach signature in array array[
  'public.request_notice_ocr(uuid,uuid,text,text,jsonb,integer,text)',
  'public.request_notice_browser(uuid,uuid,text)'
 ] loop
  definition:=pg_get_functiondef(signature::regprocedure);
  marker:=$old$lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;$old$;
  if position(marker in definition)=0 then raise exception 'Reader lease release changed';end if;
  execute replace(definition,marker,marker||$receipt$
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
 values(j.workspace_id,j.created_by,'queue.public_read_handoff',j.id,
  jsonb_build_object('job_id',j.id,'released_lease',lease,
   'job_revision',(select revision from public.jobs where id=j.id))::text,gen_random_uuid());
$receipt$);
 end loop;
end $patch$;

-- A graph-only turn may advance a saved checkpoint without a provider attempt.
-- Record at most one new-checkpoint receipt per exact lease. An idempotent put
-- of an old checkpoint is not progress and cannot create a new wake chain.
do $patch$ declare definition text;marker text;begin
 definition:=pg_get_functiondef('public.model_graph_store(uuid,uuid,text,text,jsonb)'::regprocedure);
 marker:=$old$values(t.id,ns,cid,payload->>'parent_id',payload->'checkpoint',payload->'metadata') on conflict do nothing;$old$;
 if position(marker in definition)=0 then raise exception 'Graph checkpoint persistence changed';end if;
 definition:=replace(definition,marker,marker||$receipt$
  if c.thread_id is null and not exists(select 1 from public.audit_events a
   where a.workspace_id=j.workspace_id and a.entity_id=j.id and a.action='queue.graph_checkpoint_progress'
    and a.reason::jsonb @> jsonb_build_object('job_id',j.id,'lease_digest',encode(sha256(convert_to(lease::text,'UTF8')),'hex'),'thread_id',t.id)) then
   insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
   values(j.workspace_id,j.created_by,'queue.graph_checkpoint_progress',j.id,
    jsonb_build_object('job_id',j.id,'lease_digest',encode(sha256(convert_to(lease::text,'UTF8')),'hex'),'thread_id',t.id,
     'namespace',ns,'checkpoint_id',cid)::text,gen_random_uuid());
  end if;
$receipt$);
 marker:=$old$when 'yield' then
  if exists(select 1 from public.provider_usage u where u.job_id=j.id and u.state='reserved') then raise exception 'MODEL_CALL_ALREADY_RESERVED';end if;
  update public.jobs set status='retry_wait',error_code='MODEL_IN_PROGRESS',next_attempt_at=now(),lease_token=null,lease_until=null,
   revision=revision+1,updated_at=now() where id=j.id;$old$;
 if position(marker in definition)=0 then raise exception 'Graph lease yield changed';end if;
 execute replace(definition,marker,marker||$receipt$
  if t.status='running' and not exists(select 1 from public.model_attempts a where a.job_id=j.id and a.lease_token=lease)
   and exists(select 1 from public.audit_events a
    join app_private.model_graph_checkpoints cp on cp.thread_id=t.id
     and cp.namespace=a.reason::jsonb->>'namespace' and cp.checkpoint_id=a.reason::jsonb->>'checkpoint_id'
    where a.workspace_id=j.workspace_id and a.entity_id=j.id and a.action='queue.graph_checkpoint_progress'
     and a.reason::jsonb @> jsonb_build_object('job_id',j.id,'lease_digest',encode(sha256(convert_to(lease::text,'UTF8')),'hex'),'thread_id',t.id)) then
   insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id)
   values(j.workspace_id,j.created_by,'queue.graph_handoff',j.id,
    jsonb_build_object('job_id',j.id,'released_lease',lease,'thread_id',t.id,
     'job_revision',(select revision from public.jobs where id=j.id))::text,gen_random_uuid());
  end if;
$receipt$);
end $patch$;

-- Reuse the existing wake endpoint and every admission/throttle guard. Reader
-- handoffs are future-due and may wake only other due work. A graph handoff may
-- resume itself only when a new checkpoint was saved under its released lease.
do $patch$ declare definition text;marker text;begin
 definition:=pg_get_functiondef('app_private.wake_backend_queue_checked(uuid,uuid,bigint)'::regprocedure);
 marker:='detail_continuation boolean:=false;';
 if position(marker in definition)=0 then raise exception 'Wake declaration changed';end if;
 definition:=replace(definition,marker,marker||'reader_handoff boolean:=false;graph_handoff boolean:=false;');
 marker:=' -- Only an HTTP-successful accepted request can use the poll wake.';
 if position(marker in definition)=0 then raise exception 'Wake admission marker changed';end if;
 definition:=replace(definition,marker,$receipt$
 reader_handoff:=coalesce(j.type='classify_opportunity' and j.status='retry_wait'
  and j.error_code in ('NOTICE_OCR_PENDING','NOTICE_BROWSER_PENDING') and j.next_attempt_at>now()
  and coalesce((j.checkpoint->>'model_executor')::int,1)<=2
  and exists(select 1 from public.audit_events a where a.workspace_id=w and a.entity_id=j.id
   and a.action='queue.public_read_handoff' and a.created_at=j.updated_at
   and a.reason::jsonb @> jsonb_build_object('job_id',j.id,'released_lease',lease,'job_revision',j.revision)),false);
 graph_handoff:=coalesce(j.status='retry_wait' and j.error_code='MODEL_IN_PROGRESS' and j.next_attempt_at<=now()
  and coalesce((j.checkpoint->>'model_executor')::int,1)<=2
  and j.checkpoint ? 'graph_thread' and not (j.checkpoint ? 'model_round')
  and not exists(select 1 from public.model_attempts a where a.job_id=j.id and a.lease_token=lease)
  and exists(select 1 from public.audit_events a where a.workspace_id=w and a.entity_id=j.id
   and a.action='queue.graph_handoff' and a.created_at=j.updated_at
   and a.reason::jsonb @> jsonb_build_object('job_id',j.id,'released_lease',lease,
    'job_revision',j.revision,'thread_id',j.checkpoint->>'graph_thread')),false);
$receipt$||marker);
 marker:='if not remote_poll and not detail_continuation and j.status not in';
 if position(marker in definition)=0 then raise exception 'Wake continuation guard changed';end if;
 definition:=replace(definition,marker,'if not remote_poll and not detail_continuation and not reader_handoff and not graph_handoff and j.status not in');
 marker:=$old$and (j.status not in ('blocked','failed','canceled') or q.id<>j.id)$old$;
 if position(marker in definition)=0 then raise exception 'Wake other-work guard changed';end if;
 execute replace(definition,marker,marker||E'\n  and (not reader_handoff or q.id<>j.id)');
end $patch$;
