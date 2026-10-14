-- Connect existing UI fields without granting direct writes or importing demo data.
alter table public.workspaces add column settings jsonb not null default '{}' check(jsonb_typeof(settings)='object' and pg_column_size(settings)<=4096);
alter table public.sources add column tags text[] not null default '{}' check(cardinality(tags)<=100);
alter table public.opportunities add column category text not null default '' check(length(category)<=200);
alter table public.opportunities add column tags text[] not null default '{}' check(cardinality(tags)<=100);
alter table public.opportunities add column saved boolean not null default false;
alter table public.knowledge_items add column evidence text not null default '' check(length(evidence)<=100000);

create or replace function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=auth.uid(); w uuid; actor_role text; body_hash text; replay app_private.idempotency_records;
  result jsonb; target uuid; row_revision integer; affected integer; src public.sources; opp public.opportunities; prop public.proposals;
  item jsonb; review_id uuid; version_id uuid; job_id uuid; object_path text; doc public.documents; member public.memberships;
begin
  if actor is null then raise exception 'UNAUTHENTICATED'; end if;
  select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;
  actor_role:=app_private.member_role(w);
  if w is null or actor_role is null then raise exception 'ACCESS_PENDING'; end if;
  if idempotency_key is null or length(idempotency_key) not between 1 and 200 then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  if pg_column_size(input)>1048576 then raise exception 'PAYLOAD_TOO_LARGE'; end if;
  -- One workspace lock serializes quota reservations and multi-record commands.
  perform 1 from public.workspaces where id=w for update;
  actor_role:=app_private.member_role(w);
  if actor_role is null then raise exception 'ACCESS_PENDING'; end if;
  body_hash:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
  select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key for update;
  if replay.key is not null and replay.expires_at>now() then
    if replay.body_hash<>body_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return replay.result;
  end if;
  delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
  if input ? 'workspace_id' and input->>'workspace_id'<>w::text then raise exception 'WORKSPACE_MISMATCH'; end if;
  target:=nullif(input->>'id','')::uuid;
  if operation not in ('notification.read','review.save') and actor_role='Reviewer' then raise exception 'ROLE_FORBIDDEN'; end if;
  if operation in ('source.action','membership.set','knowledge.verify','workspace.settings') and actor_role<>'Owner' then raise exception 'ROLE_FORBIDDEN'; end if;
  -- Keep reads/administration available when the application storage cap is hit.
  if operation in ('source.create','opportunity.create','knowledge.save','review.save','document.prepare','proposal.regenerate') and (
    select coalesce(sum(pg_total_relation_size(c.oid)),0)>262144000 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private') and c.relkind='r'
  ) then raise exception 'DATABASE_CAP_REACHED'; end if;

  case operation
  when 'source.create' then
    perform app_private.check_keys(input,array['client_id','name','kind','url','approved_hosts','policy_note','poll_interval_hours','tags']);
    insert into public.sources(id,workspace_id,name,kind,url,approved_hosts,policy_note,poll_interval_hours,tags,created_by)
    values(coalesce((input->>'client_id')::uuid,gen_random_uuid()),w,input->>'name',input->>'kind',nullif(input->>'url',''),array(select jsonb_array_elements_text(coalesce(input->'approved_hosts','[]'))),coalesce(input->>'policy_note',''),coalesce((input->>'poll_interval_hours')::integer,6),array(select jsonb_array_elements_text(coalesce(input->'tags','[]'))),actor) returning to_jsonb(sources.*) into result;
  when 'source.action' then
    perform app_private.check_keys(input,array['id','action','reason','expected_revision']);
    select * into src from public.sources where workspace_id=w and id=target for update;
    if src.id is null then raise exception 'NOT_FOUND'; end if;
    if src.revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT' using detail=jsonb_build_object('current_revision',src.revision)::text; end if;
    if input->>'action' not in ('approve','pause','reject') then raise exception 'ADAPTER_NOT_CONNECTED'; end if;
    if input->>'action'='approve' and src.kind<>'manual' and (cardinality(src.approved_hosts)=0 or length(src.policy_note)=0) then raise exception 'SOURCE_POLICY_REQUIRED'; end if;
    if input->>'action'='approve' and src.approval<>'approved' and (select count(*) from public.sources where workspace_id=w and approval='approved' and kind<>'manual')>=5 then raise exception 'SOURCE_CAP_REACHED'; end if;
    update public.sources set approval=case input->>'action' when 'approve' then 'approved' when 'pause' then 'paused' else 'rejected' end,
      next_due=null,revision=revision+1,updated_at=now() where workspace_id=w and id=target returning to_jsonb(sources.*) into result;
  when 'opportunity.create' then
    perform app_private.check_keys(input,array['client_id','source_id','title','description','buyer','reference','canonical_url','language','deadline_raw','deadline_at','deadline_timezone','category','tags','decision']);
    if (select count(*) from public.opportunities where workspace_id=w)>=2000 then raise exception 'OPPORTUNITY_CAP_REACHED'; end if;
    insert into public.opportunities(id,workspace_id,source_id,title,description,buyer,reference,canonical_url,language,deadline_raw,deadline_at,deadline_timezone,category,tags,decision,created_by)
    values(coalesce((input->>'client_id')::uuid,gen_random_uuid()),w,(input->>'source_id')::uuid,input->>'title',coalesce(input->>'description',''),coalesce(input->>'buyer',''),coalesce(input->>'reference',''),nullif(input->>'canonical_url',''),coalesce(input->>'language','en'),input->>'deadline_raw',case when nullif(input->>'deadline_timezone','') is not null then (input->>'deadline_at')::timestamptz else null end,input->>'deadline_timezone',coalesce(input->>'category',''),array(select jsonb_array_elements_text(coalesce(input->'tags','[]'))),coalesce(input->>'decision','undecided'),actor) returning to_jsonb(opportunities.*) into result;
  when 'opportunity.decision' then
    perform app_private.check_keys(input,array['id','target_state','reason','expected_revision']);
    if length(coalesce(input->>'reason',''))=0 then raise exception 'REASON_REQUIRED'; end if;
    select * into opp from public.opportunities where workspace_id=w and id=target for update;
    if opp.id is null then raise exception 'NOT_FOUND'; end if;
    if opp.revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT' using detail=jsonb_build_object('current_revision',opp.revision)::text; end if;
    update public.opportunities set decision=input->>'target_state',revision=revision+1,updated_at=now() where workspace_id=w and id=target returning to_jsonb(opportunities.*) into result;
  when 'knowledge.save' then
    perform app_private.check_keys(input,array['id','client_id','category','title','content','enabled','evidence','expected_revision']);
    if target is null then
      insert into public.knowledge_items(id,workspace_id,category,title,content,enabled,evidence,created_by) values(coalesce((input->>'client_id')::uuid,gen_random_uuid()),w,input->>'category',input->>'title',coalesce(input->>'content',''),coalesce((input->>'enabled')::boolean,true),coalesce(input->>'evidence',''),actor) returning to_jsonb(knowledge_items.*) into result;
    else
      select revision into row_revision from public.knowledge_items where workspace_id=w and id=target for update;
      if row_revision is null then raise exception 'NOT_FOUND'; end if;
      if row_revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT' using detail=jsonb_build_object('current_revision',row_revision)::text; end if;
      update public.knowledge_items set title=input->>'title',category=input->>'category',content=coalesce(input->>'content',''),enabled=coalesce((input->>'enabled')::boolean,true),evidence=coalesce(input->>'evidence',''),verified=false,verified_at=null,verified_by=null,revision=revision+1,updated_at=now() where workspace_id=w and id=target returning to_jsonb(knowledge_items.*) into result;
    end if;
  when 'knowledge.verify' then
    perform app_private.check_keys(input,array['id','expected_revision']);
    update public.knowledge_items set verified=true,verified_by=actor,verified_at=now(),revision=revision+1,updated_at=now() where workspace_id=w and id=target and revision=(input->>'expected_revision')::integer returning to_jsonb(knowledge_items.*) into result;
    if result is null then raise exception 'REVISION_CONFLICT'; end if;
  when 'review.save' then
    perform app_private.check_keys(input,array['id','base_version_id','source_signature','expected_revision','inputs']);
    select * into prop from public.proposals where workspace_id=w and id=target for update;
    if prop.id is null then raise exception 'NOT_FOUND'; end if;
    if prop.revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT' using detail=jsonb_build_object('current_revision',prop.revision)::text; end if;
    version_id:=(input->>'base_version_id')::uuid;
    if prop.active_version_id is distinct from version_id then raise exception 'STALE_INPUT'; end if;
    if jsonb_typeof(input->'inputs')<>'array' or jsonb_array_length(input->'inputs')>200 then raise exception 'INVALID_INPUT'; end if;
    for item in select value from jsonb_array_elements(input->'inputs') loop
      perform app_private.check_keys(item,array['id','target_kind','target_id','body','expected_revision']);
      if item->>'target_kind'='section' and not exists(select 1 from public.proposal_sections where workspace_id=w and proposal_version_id=version_id and section_key=item->>'target_id') then raise exception 'REVIEW_TARGET_INVALID'; end if;
      if item->>'target_kind'='question' and not exists(select 1 from public.questions where workspace_id=w and opportunity_id=prop.opportunity_id and id::text=item->>'target_id') then raise exception 'REVIEW_TARGET_INVALID'; end if;
      if item->>'target_kind'='general' and item->>'target_id'<>'general' then raise exception 'REVIEW_TARGET_INVALID'; end if;
      review_id:=coalesce(nullif(item->>'id','')::uuid,gen_random_uuid());
      if exists(select 1 from public.review_inputs where id=review_id) then
        update public.review_inputs set body=coalesce(item->>'body',''),base_version_id=version_id,source_signature=input->>'source_signature',updated_at=now(),revision=revision+1 where workspace_id=w and id=review_id and proposal_id=target and created_by=actor and target_kind=item->>'target_kind' and target_id=item->>'target_id' and revision=(item->>'expected_revision')::integer;
        get diagnostics affected=row_count;
        if affected<>1 then raise exception 'REVISION_CONFLICT'; end if;
      else
        insert into public.review_inputs(id,workspace_id,proposal_id,base_version_id,target_kind,target_id,body,source_signature,created_by) values(review_id,w,target,version_id,item->>'target_kind',item->>'target_id',coalesce(item->>'body',''),input->>'source_signature',actor);
      end if;
    end loop;
    update public.proposals set revision=revision+1,updated_at=now() where workspace_id=w and id=target returning revision into row_revision;
    select jsonb_build_object('id',target,'revision',row_revision,'inputs',coalesce(jsonb_agg(to_jsonb(r)),'[]')) into result from public.review_inputs r where workspace_id=w and proposal_id=target and created_by=actor;
  when 'proposal.regenerate' then
    perform app_private.check_keys(input,array['id','base_version_id','expected_revision','input_hash']);
    select * into prop from public.proposals where workspace_id=w and id=target for update;
    if prop.id is null then raise exception 'NOT_FOUND'; end if;
    if prop.revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT'; end if;
    version_id:=(input->>'base_version_id')::uuid;
    if prop.active_version_id is distinct from version_id then raise exception 'STALE_INPUT'; end if;
    if not exists(select 1 from public.documents where workspace_id=w and opportunity_id=prop.opportunity_id and kind='rfp' and status='ready') then raise exception 'READABLE_RFP_REQUIRED'; end if;
    if (select count(*) from public.jobs where workspace_id=w and status in ('queued','running','retry_wait','quota_wait','blocked'))>=500 then raise exception 'JOB_CAP_REACHED'; end if;
    insert into public.jobs(workspace_id,type,entity_id,input_hash,status,error_code,created_by) values(w,'plan_proposal',target,input->>'input_hash','blocked','MODEL_NOT_CONFIGURED',actor) returning id into job_id;
    insert into public.regeneration_requests(workspace_id,proposal_id,base_version_id,job_id,review_snapshot,created_by)
    select w,target,version_id,job_id,coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('attachments',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'hash',d.original_hash,'status',d.status)),'[]') from public.documents d where d.workspace_id=w and d.review_input_id=r.id and d.status<>'pending'))),'[]'),actor from public.review_inputs r where r.workspace_id=w and r.proposal_id=target and r.base_version_id=version_id;
    result:=jsonb_build_object('id',target,'job_id',job_id,'status','blocked','blocker','MODEL_NOT_CONFIGURED','revision',prop.revision);
  when 'document.prepare' then
    perform app_private.check_keys(input,array['kind','opportunity_id','knowledge_item_id','review_input_id','original_name','mime_type','size','hash']);
    if (select coalesce(sum(expected_size),0) from public.documents where workspace_id=w and status<>'expired')+(input->>'size')::bigint>262144000 then raise exception 'STORAGE_CAP_REACHED'; end if;
    if input->>'kind'='rfp' and (select count(*) from public.documents where workspace_id=w and opportunity_id=(input->>'opportunity_id')::uuid and kind='rfp' and status<>'expired')>=10 then raise exception 'RFP_FILE_CAP_REACHED'; end if;
    if input->>'kind'='review' and not exists(select 1 from public.review_inputs where workspace_id=w and id=(input->>'review_input_id')::uuid and created_by=actor) then raise exception 'REVIEW_TARGET_INVALID'; end if;
    if input->>'kind'='review' and (select count(*) from public.documents where workspace_id=w and review_input_id=(input->>'review_input_id')::uuid and status<>'expired')>=10 then raise exception 'INPUT_FILE_CAP_REACHED'; end if;
    target:=gen_random_uuid();object_path:=w::text||'/'||target::text;
    insert into public.documents(id,workspace_id,opportunity_id,knowledge_item_id,review_input_id,kind,original_name,mime_type,expected_size,original_hash,storage_key,created_by)
    values(target,w,(input->>'opportunity_id')::uuid,(input->>'knowledge_item_id')::uuid,(input->>'review_input_id')::uuid,input->>'kind',input->>'original_name',input->>'mime_type',(input->>'size')::bigint,input->>'hash',object_path,actor) returning to_jsonb(documents.*) into result;
  when 'notification.read' then
    perform app_private.check_keys(input,array['id','expected_revision']);
    update public.notifications set read_at=now(),updated_at=now(),revision=revision+1 where workspace_id=w and id=target and recipient_user_id=actor and revision=(input->>'expected_revision')::integer returning to_jsonb(notifications.*) into result;
    if result is null then raise exception 'REVISION_CONFLICT'; end if;
  when 'membership.set' then
    perform app_private.check_keys(input,array['user_id','role','active','reason','expected_revision']);
    target:=(input->>'user_id')::uuid;
    select * into member from public.memberships where workspace_id=w and user_id=target for update;
    if member.user_id is null then raise exception 'VERIFIED_IDENTITY_PROVISIONING_REQUIRED'; end if;
    if member.revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT'; end if;
    if member.role='Owner' and member.active and (input->>'role'<>'Owner' or not(input->>'active')::boolean) and (select count(*) from public.memberships where workspace_id=w and role='Owner' and active)<=1 then raise exception 'LAST_OWNER_REQUIRED'; end if;
    if not member.active and (input->>'active')::boolean and (select count(*) from public.memberships where workspace_id=w and active)>=5 then raise exception 'USER_CAP_REACHED'; end if;
    update public.memberships set role=input->>'role',active=(input->>'active')::boolean,revision=revision+1,updated_at=now() where workspace_id=w and user_id=target returning to_jsonb(memberships.*) into result;
    update public.identity_allowlist set role=input->>'role',status=case when (input->>'active')::boolean then 'active' else 'inactive' end,revision=revision+1,updated_at=now() where workspace_id=w and user_id=target;

  when 'workspace.settings' then
    perform app_private.check_keys(input,array['name','daily_call_limit','input_token_limit','output_token_limit','poll_hours','retention_days','expected_revision']);
    if ((input->>'daily_call_limit')::integer between 1 and 50 and (input->>'input_token_limit')::integer between 1000 and 250000 and (input->>'output_token_limit')::integer between 1000 and 50000 and (input->>'poll_hours')::integer between 6 and 168 and (input->>'retention_days')::integer between 7 and 365) is not true then raise exception 'INVALID_INPUT'; end if;
    update public.workspaces set name=input->>'name',settings=input-'expected_revision'-'name',settings_version=settings_version+1,revision=revision+1,updated_at=now() where id=w and revision=(input->>'expected_revision')::integer returning to_jsonb(workspaces.*) into result;
    if result is null then raise exception 'REVISION_CONFLICT'; end if;
  when 'opportunity.update' then
    perform app_private.check_keys(input,array['id','expected_revision','title','description','buyer','reference','canonical_url','language','category','tags','saved','deadline_raw','deadline_at','deadline_timezone']);
    update public.opportunities set title=input->>'title',description=input->>'description',buyer=input->>'buyer',reference=input->>'reference',canonical_url=nullif(input->>'canonical_url',''),language=input->>'language',category=input->>'category',tags=array(select jsonb_array_elements_text(input->'tags')),saved=(input->>'saved')::boolean,deadline_raw=input->>'deadline_raw',deadline_timezone=input->>'deadline_timezone',deadline_at=case when nullif(input->>'deadline_timezone','') is not null then (input->>'deadline_at')::timestamptz else null end,revision=revision+1,updated_at=now() where workspace_id=w and id=target and revision=(input->>'expected_revision')::integer returning to_jsonb(opportunities.*) into result;
    if result is null then raise exception 'REVISION_CONFLICT'; end if;
  when 'job.action' then
    perform app_private.check_keys(input,array['id','expected_revision','action','reason']);
    if length(coalesce(input->>'reason',''))=0 then raise exception 'REASON_REQUIRED'; end if;
    if input->>'action'='cancel' then
      update public.jobs set cancel_requested=true,status=case when status='running' then 'running' else 'canceled' end,revision=revision+1,updated_at=now() where workspace_id=w and id=target and revision=(input->>'expected_revision')::integer and status in ('queued','running','retry_wait','quota_wait','blocked','failed') returning to_jsonb(jobs.*) into result;
    elsif input->>'action'='retry' then
      -- Missing handlers stay blocked; no fabricated attempt or execution.
      update public.jobs set status='blocked',cancel_requested=false,error_code=case when type like 'source_%' then 'SOURCE_ADAPTER_NOT_CONFIGURED' else 'MODEL_NOT_CONFIGURED' end,revision=revision+1,updated_at=now() where workspace_id=w and id=target and revision=(input->>'expected_revision')::integer and status in ('blocked','failed','canceled') returning to_jsonb(jobs.*) into result;
    else raise exception 'INVALID_INPUT'; end if;
    if result is null then raise exception 'REVISION_CONFLICT'; end if;
  else raise exception 'COMMAND_NOT_IMPLEMENTED';
  end case;

  insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id) values(w,actor,operation,coalesce(target,nullif(result->>'id','')::uuid),left(coalesce(input->>'reason',''),100000),gen_random_uuid());
  insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,body_hash,result);
  return result;
end $$;

-- One user action may create related records. Every command and audit event
-- commits together; failed commands roll back the whole action and replay key.
create or replace function app_private.apply_batch(commands jsonb,idempotency_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();w uuid;body_hash text;replay app_private.idempotency_records;item jsonb;result jsonb:='[]';n integer:=0;
begin
  if actor is null then raise exception 'UNAUTHENTICATED'; end if;
  select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;
  if w is null then raise exception 'ACCESS_PENDING'; end if;
  perform 1 from public.workspaces where id=w for update;
  if app_private.member_role(w) is null then raise exception 'ACCESS_PENDING'; end if;
  if idempotency_key is null or length(idempotency_key) not between 1 and 200 then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  if commands is null or jsonb_typeof(commands)<>'array' or jsonb_array_length(commands) not between 1 and 100 or pg_column_size(commands)>1048576 then raise exception 'INVALID_INPUT'; end if;
  body_hash:=encode(sha256(convert_to(commands::text,'UTF8')),'hex');
  select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='BATCH' and route='commands' and key=idempotency_key for update;
  if replay.key is not null and replay.expires_at>now() then
    if replay.body_hash<>body_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return replay.result;
  end if;
  delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='BATCH' and route='commands' and key=idempotency_key;
  for item in select value from jsonb_array_elements(commands) loop
    perform app_private.check_keys(item,array['operation','input']);
    if not(item ? 'operation' and item ? 'input') then raise exception 'INVALID_INPUT'; end if;
    n:=n+1;
    result:=result||jsonb_build_array(app_private.app_command(item->>'operation',item->'input',encode(sha256(convert_to('batch:'||idempotency_key||':'||n::text,'UTF8')),'hex')));
  end loop;
  insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'BATCH','commands',idempotency_key,body_hash,result);
  return result;
end $$;
revoke all on function app_private.apply_batch(jsonb,text) from public,anon;
grant execute on function app_private.apply_batch(jsonb,text) to authenticated;
create or replace function public.app_batch(commands jsonb,idempotency_key text) returns jsonb
language sql security invoker set search_path='' as $$select app_private.apply_batch(commands,idempotency_key)$$;
revoke all on function public.app_batch(jsonb,text) from public,anon;
grant execute on function public.app_batch(jsonb,text) to authenticated;
