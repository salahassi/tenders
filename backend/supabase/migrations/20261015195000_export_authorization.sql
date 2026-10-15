alter table public.audit_events add column entity_type text, add column details jsonb not null default '{}';
alter table public.audit_events alter column request_id set default gen_random_uuid();
create table public.export_requests (
 id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),proposal_version_id uuid not null,approval_id uuid,mode text not null check(mode in ('draft','final')),volume text not null check(volume in ('combined','technical','financial')),binding jsonb not null,snapshot jsonb not null check(pg_column_size(snapshot)<=4194304),expires_at timestamptz not null default(now()+interval '15 minutes'),created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id),foreign key(workspace_id,proposal_version_id) references public.proposal_versions(workspace_id,id),foreign key(workspace_id,approval_id) references public.approvals(workspace_id,id)
);
create table public.export_artifacts (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),export_id uuid not null,kind text not null check(kind in ('generated','reviewed')),original_name text not null,mime_type text not null,expected_size bigint not null check(expected_size between 1 and 10485760),content_hash text not null check(content_hash~'^[0-9a-f]{64}$'),storage_key text not null unique,status text not null default 'pending' check(status in ('pending','ready','expired')),review_attested boolean not null default false,verification text check(verification in ('generated_content','reviewed_docx','owner_reviewed_pdf')),created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),verified_at timestamptz,revision integer not null default 1,unique(workspace_id,id),foreign key(workspace_id,export_id) references public.export_requests(workspace_id,id)
);
do $$ declare t text;begin foreach t in array array['export_requests','export_artifacts'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);execute format('grant all on public.%I to service_role',t);execute format('create policy member_read on public.%I for select to authenticated using(app_private.member_role(workspace_id) is not null)',t);
end loop;end $$;
create index export_version on public.export_requests(workspace_id,proposal_version_id,created_at);
create index artifact_export on public.export_artifacts(workspace_id,export_id);
create function app_private.check_export(request public.export_requests,actor uuid,check_expiry boolean default true) returns void language plpgsql security definer set search_path='' as $$
declare gate jsonb;current_approval public.approvals;
begin
 if not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=request.workspace_id and m.user_id=actor and m.active and a.status='active') then raise exception 'ROLE_FORBIDDEN';end if;
 if check_expiry and request.expires_at<now() then raise exception 'EXPORT_AUTHORIZATION_EXPIRED';end if;
 if request.mode='final' then
 gate:=app_private.approval_gate(request.workspace_id,request.proposal_version_id);
 select * into current_approval from public.approvals where id=request.approval_id and invalidated_at is null;
 if current_approval.id is null or (gate-'blockers')<>request.binding or jsonb_array_length(gate->'blockers')>0 then raise exception 'STALE_EXPORT_APPROVAL';end if;
 end if;
end $$;
revoke all on function app_private.check_export(public.export_requests,uuid,boolean) from public,anon,authenticated;
create function public.export_context(request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.export_requests;
begin select * into r from public.export_requests where id=request_id;if r.id is null or app_private.member_role(r.workspace_id) is null then raise exception 'NOT_FOUND';end if;perform app_private.check_export(r,auth.uid());return to_jsonb(r);end $$;
revoke all on function public.export_context(uuid) from public,anon;grant execute on function public.export_context(uuid) to authenticated;
create function public.artifact_context(artifact_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.export_artifacts;r public.export_requests;
begin select * into a from public.export_artifacts where id=artifact_id;if a.id is null or app_private.member_role(a.workspace_id) is null then raise exception 'NOT_FOUND';end if;select * into r from public.export_requests where id=a.export_id;perform app_private.check_export(r,auth.uid());return jsonb_build_object('artifact',to_jsonb(a),'request',to_jsonb(r));end $$;
revoke all on function public.artifact_context(uuid) from public,anon;grant execute on function public.artifact_context(uuid) to authenticated;
create function public.complete_export_artifact(artifact_id uuid,actor_id uuid,actual_hash text,actual_size bigint,verification_kind text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.export_artifacts;r public.export_requests;
begin
 select * into a from public.export_artifacts where id=artifact_id;if a.id is null then raise exception 'NOT_FOUND';end if;perform 1 from public.workspaces where id=a.workspace_id for update;
 select * into a from public.export_artifacts where id=artifact_id for update;select * into r from public.export_requests where id=a.export_id;perform app_private.check_export(r,actor_id);
 if a.created_by<>actor_id or a.content_hash<>actual_hash or a.expected_size<>actual_size or a.status='expired' then raise exception 'ARTIFACT_MISMATCH';end if;
 if (a.kind='generated' and verification_kind<>'generated_content') or (a.kind='reviewed' and verification_kind not in ('reviewed_docx','owner_reviewed_pdf')) then raise exception 'INVALID_VERIFICATION';end if;
 if a.status='ready' then return to_jsonb(a);end if;
 update public.export_artifacts set status='ready',verification=verification_kind,verified_at=now(),revision=revision+1 where id=a.id returning * into a;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(a.workspace_id,actor_id,'export.completed','export_artifact',a.id,jsonb_build_object('hash',actual_hash,'version_id',r.proposal_version_id,'mode',r.mode,'verification',verification_kind));return to_jsonb(a);
end $$;
revoke all on function public.complete_export_artifact(uuid,uuid,text,bigint,text) from public,anon,authenticated;grant execute on function public.complete_export_artifact(uuid,uuid,text,bigint,text) to service_role;
create function public.authorize_artifact_download(artifact_id uuid,actor_id uuid,actual_hash text) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.export_artifacts;r public.export_requests;
begin
 select * into a from public.export_artifacts where id=artifact_id;if a.id is null then raise exception 'NOT_FOUND';end if;perform 1 from public.workspaces where id=a.workspace_id for update;select * into r from public.export_requests where id=a.export_id;perform app_private.check_export(r,actor_id);
 if a.status<>'ready' or a.content_hash<>actual_hash then raise exception 'ARTIFACT_MISMATCH';end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(a.workspace_id,actor_id,'export.download','export_artifact',a.id,jsonb_build_object('hash',actual_hash,'version_id',r.proposal_version_id,'mode',r.mode));return to_jsonb(a);
end $$;
revoke all on function public.authorize_artifact_download(uuid,uuid,text) from public,anon,authenticated;grant execute on function public.authorize_artifact_download(uuid,uuid,text) to service_role;
-- There is no direct Storage SELECT policy for artifacts; the API rechecks the bound approval before returning bytes.
create policy tenderdesk_export_upload on storage.objects for insert to authenticated with check(bucket_id='tenderdesk-private' and exists(select 1 from public.export_artifacts a join public.export_requests r on r.id=a.export_id where a.storage_key=name and a.status='pending' and a.created_by=auth.uid() and r.expires_at>now() and app_private.member_role(a.workspace_id) is not null));
alter function app_private.app_command(text,jsonb,text) rename to eligibility_command;
revoke all on function app_private.eligibility_command(text,jsonb,text) from public,anon,authenticated,service_role;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare payload alias for $2;w uuid;actor uuid:=auth.uid();role text;h text;replay app_private.idempotency_records;result jsonb;target uuid;v public.proposal_versions;p public.proposals;r public.export_requests;approval public.approvals;gate jsonb;context jsonb;
begin
 if operation not in ('export.prepare','export.reserve','export.renew') then return app_private.eligibility_command(operation,payload,idempotency_key);end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;role:=app_private.member_role(w);
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(payload)>1048576 then raise exception 'INVALID_INPUT';end if;
 h:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then if replay.body_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;target:=gen_random_uuid();
 if operation='export.renew' then
 perform app_private.check_keys(payload,array['id','expected_revision']);select * into r from public.export_requests where workspace_id=w and id=(payload->>'id')::uuid;if r.id is null or r.revision is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 if r.mode='final' and role<>'Owner' then raise exception 'ROLE_FORBIDDEN';end if;perform app_private.check_export(r,actor,false);
 update public.export_requests set expires_at=now()+interval '15 minutes',revision=revision+1 where id=r.id returning to_jsonb(export_requests.*) into result;target:=r.id;
 elsif operation='export.prepare' then
 perform app_private.check_keys(payload,array['proposal_version_id','expected_revision','mode','volume']);
 select * into v from public.proposal_versions where workspace_id=w and id=(payload->>'proposal_version_id')::uuid;if v.id is null or v.revision is distinct from (payload->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT';end if;
 if coalesce(payload->>'mode','') not in ('draft','final') or coalesce(payload->>'volume','') not in ('combined','technical','financial') then raise exception 'INVALID_INPUT';end if;
 if (v.separate_volumes and payload->>'volume'='combined') or (not v.separate_volumes and payload->>'volume'<>'combined') then raise exception 'BUYER_VOLUME_RULE';end if;
 select * into p from public.proposals where id=v.proposal_id;gate:=app_private.approval_gate(w,v.id);
 if payload->>'mode'='final' then
 if role<>'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 select * into approval from public.approvals where proposal_version_id=v.id and invalidated_at is null order by created_at desc limit 1;
 if approval.id is null or jsonb_array_length(gate->'blockers')>0 then raise exception 'APPROVAL_REQUIRED';end if;
 if approval.content_hash is distinct from gate->>'content_hash' or approval.review_hash is distinct from gate->>'review_hash' or approval.pricing_hash is distinct from gate->>'pricing_hash' or approval.delivery_hash is distinct from gate->>'delivery_hash' then raise exception 'STALE_EXPORT_APPROVAL';end if;
 end if;
 select jsonb_build_object('title',p.title,'ordinal',v.ordinal,'language',coalesce(g.frozen_context->>'language','en'),'opportunity_title',coalesce(g.frozen_context->>'title',p.title),'template',coalesce(g.frozen_context->'template',app_private.neutral_template('en')),'sections',(select coalesce(jsonb_agg(to_jsonb(s) order by ordinal),'[]') from public.proposal_sections s where proposal_version_id=v.id),'estimate',(select to_jsonb(e) from public.estimate_records e where proposal_version_id=v.id and status in ('ready','approved') order by ordinal desc limit 1),'delivery',(select to_jsonb(d) from public.delivery_versions d where proposal_version_id=v.id and status in ('ready','approved') order by ordinal desc limit 1),'requirements',(select coalesce(jsonb_agg(to_jsonb(q) order by id),'[]') from public.requirements q where plan_id=v.plan_id),'compliance',(select coalesce(jsonb_agg(to_jsonb(c) order by id),'[]') from public.compliance_responses c where proposal_version_id=v.id)) into context from public.generation_plans g where g.id=v.plan_id;
 if context is null then raise exception 'GENERATION_CONTEXT_REQUIRED';end if;
 if (select count(*) from public.export_requests where workspace_id=w and created_at>now()-interval '1 day')>=100 then raise exception 'EXPORT_DAILY_CAP_REACHED';end if;
 if (select coalesce(sum(pg_total_relation_size(c.oid)),0)>262144000 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private') and c.relkind='r') then raise exception 'DATABASE_CAP_REACHED';end if;
 insert into public.export_requests(id,workspace_id,proposal_version_id,approval_id,mode,volume,binding,snapshot,created_by) values(target,w,v.id,approval.id,payload->>'mode',payload->>'volume',gate-'blockers',context,actor) returning to_jsonb(export_requests.*) into result;
 else
 perform app_private.check_keys(payload,array['export_id','kind','original_name','mime_type','size','hash','review_attested']);select * into r from public.export_requests where workspace_id=w and id=(payload->>'export_id')::uuid;if r.id is null then raise exception 'NOT_FOUND';end if;perform app_private.check_export(r,actor);
 if coalesce(payload->>'kind','') not in ('generated','reviewed') then raise exception 'INVALID_INPUT';end if;
 if payload->>'kind'='reviewed' and (role<>'Owner' or r.mode<>'final' or payload->'review_attested' is distinct from 'true'::jsonb) then raise exception 'FINAL_ARTIFACT_REVIEW_REQUIRED';end if;
 if payload->>'kind'='generated' and payload->>'mime_type'<>'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then raise exception 'INVALID_INPUT';end if;
 if payload->>'mime_type' not in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document') or length(payload->>'original_name') not between 1 and 200 then raise exception 'INVALID_INPUT';end if;
 perform app_private.assert_business_content(payload->>'original_name');
 if (select coalesce(sum(expected_size),0) from public.documents where workspace_id=w and status<>'expired')+(select coalesce(sum(expected_size),0) from public.export_artifacts where workspace_id=w and status<>'expired')+(payload->>'size')::bigint>262144000 then raise exception 'STORAGE_CAP_REACHED';end if;
 insert into public.export_artifacts(id,workspace_id,export_id,kind,original_name,mime_type,expected_size,content_hash,storage_key,review_attested,created_by) values(target,w,r.id,payload->>'kind',payload->>'original_name',payload->>'mime_type',(payload->>'size')::bigint,payload->>'hash',w::text||'/exports/'||target::text,coalesce((payload->>'review_attested')::boolean,false),actor) returning to_jsonb(export_artifacts.*) into result;
 end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(w,actor,operation,'export',target,jsonb_build_object('version_id',v.id,'mode',r.mode));
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,h,result);return result;
end $$;
revoke all on function app_private.app_command(text,jsonb,text) from public,anon;grant execute on function app_private.app_command(text,jsonb,text) to authenticated;
