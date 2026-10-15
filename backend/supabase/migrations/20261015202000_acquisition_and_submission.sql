create table public.acquisitions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),opportunity_id uuid not null,state text not null default 'not_started' check(state in ('not_started','requested','approved','awaiting_document','document_available','failed')),method text not null default 'manual_upload' check(method in ('manual_upload','free_public','paid_manual')),fee numeric check(fee>=0),currency text check(currency~'^[A-Z]{3}$'),instructions text not null default '',note text not null default '',external_reference text not null default '',approved_by uuid references auth.users(id),approved_at timestamptz,document_id uuid,created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id),unique(workspace_id,opportunity_id),foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id),foreign key(workspace_id,document_id) references public.documents(workspace_id,id),check((fee is null and currency is null) or (fee is not null and currency is not null))
);
create table public.submissions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),opportunity_id uuid not null,proposal_version_id uuid not null,approval_id uuid not null,artifact_manifest jsonb not null,artifact_verification text not null check(artifact_verification in ('reviewed','final_artifact_unverified')),state text not null default 'submitted' check(state in ('submitted','withdrawn','won','lost','canceled')),submitted_at timestamptz not null,channel text not null,external_reference text not null,sanitized_receipt text not null default '',created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id),foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id),foreign key(workspace_id,proposal_version_id) references public.proposal_versions(workspace_id,id),foreign key(workspace_id,approval_id) references public.approvals(workspace_id,id)
);
create table public.submission_events (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),opportunity_id uuid not null,submission_id uuid not null,event_type text not null check(event_type in ('submitted','withdrawn','won','lost','canceled','correction')),occurred_at timestamptz not null,reason text not null,correction jsonb not null default '{}',created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),foreign key(workspace_id,submission_id) references public.submissions(workspace_id,id),foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id)
);
create table public.opportunity_relations (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),opportunity_id uuid not null,related_opportunity_id uuid not null,reason text not null,created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),unique(workspace_id,opportunity_id,related_opportunity_id),foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id),foreign key(workspace_id,related_opportunity_id) references public.opportunities(workspace_id,id),check(opportunity_id<related_opportunity_id)
);
do $$ declare t text;begin foreach t in array array['acquisitions','submissions','submission_events','opportunity_relations'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);execute format('grant all on public.%I to service_role',t);execute format('create policy member_read on public.%I for select to authenticated using(app_private.member_role(workspace_id) is not null)',t);
end loop;end $$;
create index submission_opportunity on public.submissions(workspace_id,opportunity_id,created_at);
create index submission_history on public.submission_events(workspace_id,submission_id,created_at);
create function app_private.accepted_rfp_acquisition() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.kind='rfp' and new.status='ready' and new.extraction_confirmed_at is not null and not new.archived and (old.extraction_confirmed_at is null or old.status<>'ready') then
 insert into public.acquisitions(workspace_id,opportunity_id,state,method,document_id,created_by) values(new.workspace_id,new.opportunity_id,'document_available','manual_upload',new.id,new.extraction_confirmed_by)
 on conflict(workspace_id,opportunity_id) do update set state='document_available',document_id=excluded.document_id,revision=acquisitions.revision+1,updated_at=now();
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(new.workspace_id,new.extraction_confirmed_by,'acquisition.document_available','opportunity',new.opportunity_id,jsonb_build_object('document_id',new.id));
 end if;return new;
end $$;
revoke all on function app_private.accepted_rfp_acquisition() from public,anon,authenticated;
create trigger accepted_rfp_acquisition after update of extraction_confirmed_at,status on public.documents for each row execute function app_private.accepted_rfp_acquisition();
-- Storage reservations share a workspace lock across originals and output artifacts.
create function app_private.enforce_combined_storage_cap() returns trigger language plpgsql security definer set search_path='' as $$
declare used bigint;
begin
 perform 1 from public.workspaces where id=new.workspace_id for update;
 select (select coalesce(sum(expected_size),0) from public.documents where workspace_id=new.workspace_id and status<>'expired')+(select coalesce(sum(expected_size),0) from public.export_artifacts where workspace_id=new.workspace_id and status<>'expired') into used;
 if used+new.expected_size>262144000 then raise exception 'STORAGE_CAP_REACHED';end if;return new;
end $$;
revoke all on function app_private.enforce_combined_storage_cap() from public,anon,authenticated;
create trigger combined_storage_cap before insert on public.documents for each row execute function app_private.enforce_combined_storage_cap();
create trigger combined_storage_cap before insert on public.export_artifacts for each row execute function app_private.enforce_combined_storage_cap();
alter function app_private.app_command(text,jsonb,text) rename to export_command;
revoke all on function app_private.export_command(text,jsonb,text) from public,anon,authenticated,service_role;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare payload alias for $2;w uuid;actor uuid:=auth.uid();role text;h text;replay app_private.idempotency_records;result jsonb;target uuid:=gen_random_uuid();a public.acquisitions;s public.submissions;v public.proposal_versions;p public.proposals;er public.export_requests;artifact public.export_artifacts;approval uuid;ids jsonb;manifest jsonb:='[]';volumes text[]:='{}';verified boolean:=true;item jsonb;next_state text;opportunity uuid;related uuid;
begin
 if operation not in ('acquisition.transition','submission.record','submission.event','opportunity.relate') then return app_private.export_command(operation,payload,idempotency_key);end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;role:=app_private.member_role(w);
 if role='Reviewer' or (operation like 'submission.%' and role<>'Owner') then raise exception 'ROLE_FORBIDDEN';end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(payload)>65536 then raise exception 'INVALID_INPUT';end if;perform app_private.assert_business_content(payload::text);
 h:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then if replay.body_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if operation='acquisition.transition' then
 perform app_private.check_keys(payload,array['opportunity_id','expected_revision','state','method','fee','currency','instructions','note','external_reference']);opportunity:=(payload->>'opportunity_id')::uuid;
 if not exists(select 1 from public.opportunities where workspace_id=w and id=opportunity and not archived) then raise exception 'NOT_FOUND';end if;
 select * into a from public.acquisitions where workspace_id=w and opportunity_id=opportunity;
 if coalesce(a.revision,0) is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 next_state:=payload->>'state';
 if not ((coalesce(a.state,'not_started') in ('not_started','failed') and next_state='requested') or (a.state='requested' and next_state='approved') or (a.state='approved' and next_state='awaiting_document') or (coalesce(a.state,'not_started') in ('not_started','requested','approved','awaiting_document') and next_state='failed')) then raise exception 'INVALID_TRANSITION';end if;
 if next_state='approved' and role<>'Owner' then raise exception 'ROLE_FORBIDDEN';end if;
 if length(coalesce(payload->>'note','')) not between 5 and 3000 or length(coalesce(payload->>'instructions',''))>5000 or length(coalesce(payload->>'external_reference',''))>1000 then raise exception 'INVALID_INPUT';end if;
 if payload ? 'method' and coalesce(payload->>'method','') not in ('manual_upload','free_public','paid_manual') then raise exception 'INVALID_INPUT';end if;
 if a.id is null then
 insert into public.acquisitions(id,workspace_id,opportunity_id,state,method,fee,currency,instructions,note,external_reference,created_by) values(target,w,opportunity,next_state,coalesce(payload->>'method','manual_upload'),nullif(payload->>'fee','')::numeric,nullif(payload->>'currency',''),coalesce(payload->>'instructions',''),payload->>'note',coalesce(payload->>'external_reference',''),actor) returning * into a;
 else
 target:=a.id;update public.acquisitions set state=next_state,note=payload->>'note',external_reference=coalesce(payload->>'external_reference',external_reference),approved_by=case when next_state='approved' then actor else approved_by end,approved_at=case when next_state='approved' then now() else approved_at end,updated_at=now(),revision=revision+1 where id=a.id returning * into a;
 end if;result:=to_jsonb(a);
 elsif operation='submission.record' then
 perform app_private.check_keys(payload,array['proposal_version_id','expected_revision','artifact_ids','submitted_at','channel','external_reference','sanitized_receipt']);
 select * into v from public.proposal_versions where workspace_id=w and id=(payload->>'proposal_version_id')::uuid;if v.id is null or v.revision is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 select * into p from public.proposals where workspace_id=w and id=v.proposal_id;opportunity:=p.opportunity_id;ids:=payload->'artifact_ids';
 if jsonb_typeof(ids) is distinct from 'array' or jsonb_array_length(ids) not between 1 and 2 then raise exception 'FINAL_EXPORT_REQUIRED';end if;
 for item in select value from jsonb_array_elements(ids) loop
 select * into artifact from public.export_artifacts where workspace_id=w and id=(item#>>'{}')::uuid and status='ready';if artifact.id is null then raise exception 'FINAL_EXPORT_REQUIRED';end if;
 select * into er from public.export_requests where workspace_id=w and id=artifact.export_id;if er.mode<>'final' or er.proposal_version_id<>v.id then raise exception 'FINAL_EXPORT_REQUIRED';end if;perform app_private.check_export(er,actor,false);
 if er.volume=any(volumes) or (approval is not null and approval<>er.approval_id) then raise exception 'EXPORT_VOLUME_MISMATCH';end if;approval:=er.approval_id;volumes:=array_append(volumes,er.volume);
 verified:=verified and artifact.kind='reviewed' and artifact.review_attested;
 manifest:=manifest||jsonb_build_array(jsonb_build_object('artifact_id',artifact.id,'export_id',er.id,'hash',artifact.content_hash,'volume',er.volume,'verification',artifact.verification));
 end loop;
 if (v.separate_volumes and not (volumes @> array['technical','financial'] and array_length(volumes,1)=2)) or (not v.separate_volumes and volumes<>array['combined']) then raise exception 'EXPORT_VOLUME_MISMATCH';end if;
 if nullif(payload->>'submitted_at','') is null or (payload->>'submitted_at')::timestamptz>now()+interval '5 minutes' or length(coalesce(payload->>'channel','')) not between 2 and 200 or length(coalesce(payload->>'external_reference','')) not between 1 and 1000 or length(coalesce(payload->>'sanitized_receipt',''))>1000 then raise exception 'INVALID_INPUT';end if;
 insert into public.submissions(id,workspace_id,opportunity_id,proposal_version_id,approval_id,artifact_manifest,artifact_verification,submitted_at,channel,external_reference,sanitized_receipt,created_by) values(target,w,opportunity,v.id,approval,manifest,case when verified then 'reviewed' else 'final_artifact_unverified' end,(payload->>'submitted_at')::timestamptz,payload->>'channel',payload->>'external_reference',coalesce(payload->>'sanitized_receipt',''),actor) returning * into s;
 insert into public.submission_events(workspace_id,opportunity_id,submission_id,event_type,occurred_at,reason,created_by) values(w,opportunity,s.id,'submitted',s.submitted_at,'Manual submission recorded by Owner',actor);result:=to_jsonb(s);
 elsif operation='submission.event' then
 perform app_private.check_keys(payload,array['id','expected_revision','event_type','occurred_at','reason','correction']);
 select * into s from public.submissions where workspace_id=w and id=(payload->>'id')::uuid;if s.id is null or s.revision is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 opportunity:=s.opportunity_id;next_state:=payload->>'event_type';if coalesce(next_state,'') not in ('withdrawn','won','lost','canceled','correction') or (next_state<>'correction' and s.state<>'submitted') then raise exception 'INVALID_TRANSITION';end if;
 if length(coalesce(payload->>'reason','')) not between 10 and 3000 or nullif(payload->>'occurred_at','') is null or (payload->>'occurred_at')::timestamptz>now()+interval '5 minutes' then raise exception 'INVALID_INPUT';end if;
 if next_state='correction' then perform app_private.check_keys(coalesce(payload->'correction','{}'),array['submitted_at','channel','external_reference','sanitized_receipt']);if coalesce(payload->'correction','{}')='{}'::jsonb then raise exception 'CORRECTION_REQUIRED';end if;
 elsif coalesce(payload->'correction','{}')<>'{}'::jsonb then raise exception 'INVALID_INPUT';end if;
 insert into public.submission_events(id,workspace_id,opportunity_id,submission_id,event_type,occurred_at,reason,correction,created_by) values(target,w,opportunity,s.id,next_state,(payload->>'occurred_at')::timestamptz,payload->>'reason',coalesce(payload->'correction','{}'),actor) returning to_jsonb(submission_events.*) into result;
 update public.submissions set state=case when next_state='correction' then state else next_state end,revision=revision+1,updated_at=now() where id=s.id;
 else
 perform app_private.check_keys(payload,array['opportunity_id','related_opportunity_id','reason']);opportunity:=least((payload->>'opportunity_id')::uuid,(payload->>'related_opportunity_id')::uuid);related:=greatest((payload->>'opportunity_id')::uuid,(payload->>'related_opportunity_id')::uuid);
 if opportunity=related or length(coalesce(payload->>'reason','')) not between 10 and 3000 then raise exception 'INVALID_INPUT';end if;
 insert into public.opportunity_relations(id,workspace_id,opportunity_id,related_opportunity_id,reason,created_by) values(target,w,opportunity,related,payload->>'reason',actor) returning to_jsonb(opportunity_relations.*) into result;
 end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(w,actor,operation,'opportunity',opportunity,jsonb_build_object('record_id',target,'input',payload));
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,h,result);return result;
end $$;
revoke all on function app_private.app_command(text,jsonb,text) from public,anon;grant execute on function app_private.app_command(text,jsonb,text) to authenticated;
