create or replace function app_private.check_keys(value jsonb,allowed text[]) returns void
language plpgsql immutable set search_path='' as $$
begin
  if jsonb_typeof(value)<>'object' or exists(select 1 from jsonb_object_keys(value) k where not(k=any(allowed))) then raise exception 'INVALID_INPUT'; end if;
end $$;
create or replace function public.app_command(operation text,input jsonb,idempotency_key text) returns jsonb
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
  if operation in ('source.action','membership.set','knowledge.verify') and actor_role<>'Owner' then raise exception 'ROLE_FORBIDDEN'; end if;
  -- Keep reads/administration available when the application storage cap is hit.
  if operation in ('source.create','opportunity.create','knowledge.save','review.save','document.prepare','proposal.regenerate') and (
    select coalesce(sum(pg_total_relation_size(c.oid)),0)>262144000 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private') and c.relkind='r'
  ) then raise exception 'DATABASE_CAP_REACHED'; end if;

  case operation
  when 'source.create' then
    perform app_private.check_keys(input,array['name','kind','url','approved_hosts','policy_note','poll_interval_hours']);
    insert into public.sources(workspace_id,name,kind,url,approved_hosts,policy_note,poll_interval_hours,created_by)
    values(w,input->>'name',input->>'kind',nullif(input->>'url',''),array(select jsonb_array_elements_text(coalesce(input->'approved_hosts','[]'))),coalesce(input->>'policy_note',''),coalesce((input->>'poll_interval_hours')::integer,6),actor) returning to_jsonb(sources.*) into result;
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
    perform app_private.check_keys(input,array['source_id','title','description','buyer','reference','canonical_url','language','deadline_raw','deadline_at','deadline_timezone']);
    if (select count(*) from public.opportunities where workspace_id=w)>=2000 then raise exception 'OPPORTUNITY_CAP_REACHED'; end if;
    insert into public.opportunities(workspace_id,source_id,title,description,buyer,reference,canonical_url,language,deadline_raw,deadline_at,deadline_timezone,created_by)
    values(w,(input->>'source_id')::uuid,input->>'title',coalesce(input->>'description',''),coalesce(input->>'buyer',''),coalesce(input->>'reference',''),nullif(input->>'canonical_url',''),coalesce(input->>'language','en'),input->>'deadline_raw',case when nullif(input->>'deadline_timezone','') is not null then (input->>'deadline_at')::timestamptz else null end,input->>'deadline_timezone',actor) returning to_jsonb(opportunities.*) into result;
  when 'opportunity.decision' then
    perform app_private.check_keys(input,array['id','target_state','reason','expected_revision']);
    if length(coalesce(input->>'reason',''))=0 then raise exception 'REASON_REQUIRED'; end if;
    select * into opp from public.opportunities where workspace_id=w and id=target for update;
    if opp.id is null then raise exception 'NOT_FOUND'; end if;
    if opp.revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT' using detail=jsonb_build_object('current_revision',opp.revision)::text; end if;
    update public.opportunities set decision=input->>'target_state',revision=revision+1,updated_at=now() where workspace_id=w and id=target returning to_jsonb(opportunities.*) into result;
  when 'knowledge.save' then
    perform app_private.check_keys(input,array['id','category','title','content','enabled','expected_revision']);
    if target is null then
      insert into public.knowledge_items(workspace_id,category,title,content,enabled,created_by) values(w,input->>'category',input->>'title',coalesce(input->>'content',''),coalesce((input->>'enabled')::boolean,true),actor) returning to_jsonb(knowledge_items.*) into result;
    else
      select revision into row_revision from public.knowledge_items where workspace_id=w and id=target for update;
      if row_revision is null then raise exception 'NOT_FOUND'; end if;
      if row_revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT' using detail=jsonb_build_object('current_revision',row_revision)::text; end if;
      update public.knowledge_items set title=input->>'title',category=input->>'category',content=coalesce(input->>'content',''),enabled=coalesce((input->>'enabled')::boolean,true),verified=false,verified_at=null,verified_by=null,revision=revision+1,updated_at=now() where workspace_id=w and id=target returning to_jsonb(knowledge_items.*) into result;
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
    update public.memberships set role=input->>'role',active=(input->>'active')::boolean,revision=revision+1,updated_at=now() where workspace_id=w and user_id=target returning to_jsonb(memberships.*) into result;
    update public.identity_allowlist set role=input->>'role',status=case when (input->>'active')::boolean then 'active' else 'inactive' end,revision=revision+1,updated_at=now() where workspace_id=w and user_id=target;
  else raise exception 'COMMAND_NOT_IMPLEMENTED';
  end case;

  insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id) values(w,actor,operation,coalesce(target,nullif(result->>'id','')::uuid),left(coalesce(input->>'reason',''),100000),gen_random_uuid());
  insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,body_hash,result);
  return result;
end $$;
revoke all on function public.app_command(text,jsonb,text) from public,anon;
grant execute on function public.app_command(text,jsonb,text) to authenticated;

-- Completion is internal-only: API validates actual object bytes before calling.
create or replace function public.accept_uploaded_document(document_id uuid,actor_id uuid,actual_hash text,actual_size bigint,extraction_text text,extraction_status text,command_key text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d public.documents; result jsonb; replay app_private.idempotency_records; fingerprint text; command_route text; document_workspace uuid;
begin
  select workspace_id into document_workspace from public.documents where id=document_id;
  if document_workspace is null then raise exception 'NOT_FOUND'; end if;
  -- Use the same lock order as member changes and quota reservations. Recheck
  -- admission after locking so a revoked identity cannot finalize an upload.
  perform 1 from public.workspaces where id=document_workspace for update;
  select * into d from public.documents where id=document_id for update;
  if d.id is null or d.created_by<>actor_id or not exists(
    select 1 from public.memberships m
    join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id
    where m.workspace_id=d.workspace_id and m.user_id=actor_id and m.active and m.role in ('Owner','Editor') and a.status='active'
  ) then raise exception 'NOT_FOUND'; end if;
  if command_key is null or length(command_key) not between 1 and 200 then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  command_route:='document.complete/'||document_id::text;
  fingerprint:=encode(sha256(convert_to(jsonb_build_array(actual_hash,actual_size,extraction_text,extraction_status)::text,'UTF8')),'hex');
  select * into replay from app_private.idempotency_records i where i.workspace_id=d.workspace_id and i.actor_id=accept_uploaded_document.actor_id and i.method='POST' and i.route=command_route and i.key=command_key;
  if replay.key is not null and replay.expires_at>now() then
    if replay.body_hash<>fingerprint then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return replay.result;
  end if;
  if d.status<>'pending' then
    if d.original_hash=actual_hash and d.uploaded_size=actual_size and d.extracted_text=extraction_text and d.status=extraction_status then return to_jsonb(d); end if;
    raise exception 'UPLOAD_ALREADY_FINALIZED';
  end if;
  if d.expires_at<now() then raise exception 'UPLOAD_EXPIRED'; end if;
  if d.original_hash<>actual_hash or d.expected_size<>actual_size then raise exception 'UPLOAD_MISMATCH'; end if;
  if extraction_status not in ('ready','needs_ocr','needs_processing','error') or (extraction_status='ready' and length(trim(extraction_text))=0) then raise exception 'INVALID_EXTRACTION'; end if;
  if (select coalesce(sum(octet_length(extracted_text)),0) from public.documents where workspace_id=d.workspace_id)+octet_length(extraction_text)>20971520 then raise exception 'EXTRACTION_CAP_REACHED'; end if;
  update public.documents set status=extraction_status,uploaded_size=actual_size,extracted_text=extraction_text,revision=revision+1,updated_at=now() where id=document_id returning to_jsonb(documents.*) into result;
  insert into public.audit_events(workspace_id,actor_id,action,entity_id,request_id) values(d.workspace_id,accept_uploaded_document.actor_id,'document.accepted',d.id,gen_random_uuid());
  delete from app_private.idempotency_records i where i.workspace_id=d.workspace_id and i.actor_id=accept_uploaded_document.actor_id and i.method='POST' and i.route=command_route and i.key=command_key;
  insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(d.workspace_id,accept_uploaded_document.actor_id,'POST',command_route,command_key,fingerprint,result);
  return result;
end $$;
revoke all on function public.accept_uploaded_document(uuid,uuid,text,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.accept_uploaded_document(uuid,uuid,text,bigint,text,text,text) to service_role;
