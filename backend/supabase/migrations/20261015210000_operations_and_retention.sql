alter table public.provider_usage alter column job_id drop not null;
alter table public.operations add column last_maintenance_at timestamptz,add column last_cleanup_at timestamptz;
create table public.storage_cleanup_queue(id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),storage_key text not null unique,estimated_size bigint not null default 0,reason text not null,status text not null default 'pending' check(status in ('pending','running','done','blocked')),attempts integer not null default 0,lease_token uuid,lease_until timestamptz,error_code text,created_at timestamptz not null default now(),updated_at timestamptz not null default now());
alter table public.storage_cleanup_queue enable row level security;revoke all on public.storage_cleanup_queue from public,anon,authenticated;grant select on public.storage_cleanup_queue to authenticated;grant all on public.storage_cleanup_queue to service_role;create policy owner_read on public.storage_cleanup_queue for select to authenticated using(app_private.member_role(workspace_id)='Owner');
create function app_private.storage_reserved_bytes(w uuid) returns bigint language sql stable security definer set search_path='' as $$
 select (select coalesce(sum(expected_size),0) from public.documents where workspace_id=w and status<>'expired')+(select coalesce(sum(expected_size),0) from public.export_artifacts where workspace_id=w and status<>'expired')+(select coalesce(sum(estimated_size),0) from public.storage_cleanup_queue where workspace_id=w and status<>'done')+(select coalesce(sum(f.expected_size),0) from public.restore_files f join public.restore_sessions s on s.id=f.session_id where f.workspace_id=w and s.state in ('staging','canceled','expired') and f.status<>'removed' and not exists(select 1 from public.storage_cleanup_queue q where q.storage_key=f.storage_key));
$$;
revoke all on function app_private.storage_reserved_bytes(uuid) from public,anon,authenticated;
create or replace function app_private.enforce_combined_storage_cap() returns trigger language plpgsql security definer set search_path='' as $$begin if new.status='expired' then return new;end if;perform 1 from public.workspaces where id=new.workspace_id for update;if app_private.storage_reserved_bytes(new.workspace_id)+new.expected_size>262144000 then raise exception 'STORAGE_CAP_REACHED';end if;return new;end $$;
-- Notification authors may be historical; recipients still require real Auth accounts.
alter table public.notifications drop constraint notifications_created_by_fkey;
alter table public.notifications add constraint notifications_created_by_fkey foreign key(workspace_id,created_by) references public.workspace_actors(workspace_id,id);
create function public.maintenance_tick() returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid;last_run timestamptz;retention integer;r record;n integer;expired_count integer:=0;
begin
 select id into w from public.workspaces limit 1;if w is null then return jsonb_build_object('workspace',false);end if;
 perform 1 from public.workspaces where id=w for update;
 select m.user_id into actor from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=w and m.active and m.role='Owner' and a.status='active' order by m.created_at limit 1;
 if actor is null then return jsonb_build_object('owner_available',false);end if;
 select last_maintenance_at into last_run from public.operations where workspace_id=w;
 if last_run>now()-interval '1 hour' then return jsonb_build_object('due',false);end if;
 retention:=greatest(7,least(365,coalesce((select (settings->>'retention_days')::integer from public.workspaces where id=w),90)));
 update public.restore_sessions set state='expired' where workspace_id=w and state='staging' and expires_at<now();
 insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) select f.workspace_id,f.storage_key,f.expected_size,'restore_abandoned' from public.restore_files f join public.restore_sessions s on s.id=f.session_id where f.workspace_id=w and s.state in ('canceled','expired') and f.status<>'removed' on conflict(storage_key) do nothing;
 delete from app_private.restore_rows where session_id in(select id from public.restore_sessions where workspace_id=w and state in ('canceled','expired'));
 for r in select * from public.documents where workspace_id=w and status='pending' and created_at<now()-interval '24 hours' limit 100 loop
 insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values(w,r.storage_key,r.expected_size,'original_upload_expired') on conflict do nothing;
 update public.documents set status='expired',archived=true,revision=revision+1,updated_at=now() where id=r.id;delete from app_private.extraction_parts where document_id=r.id;expired_count:=expired_count+1;
 end loop;
 for r in select * from public.export_artifacts where workspace_id=w and status='pending' and created_at<now()-interval '24 hours' limit 100 loop
 insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) values(w,r.storage_key,r.expected_size,'export_upload_expired') on conflict do nothing;
 update public.export_artifacts set status='expired',revision=revision+1 where id=r.id;expired_count:=expired_count+1;
 end loop;
 delete from app_private.idempotency_records where workspace_id=w and expires_at<now();
 delete from public.import_batches where id in(select b.id from public.import_batches b where b.workspace_id=w and b.committed_at is null and b.expires_at<now() and not exists(select 1 from public.opportunities o where o.import_batch_id=b.id) limit 100);
 -- Keep the latest source evidence and every snapshot associated with any retained plan or proposal.
 delete from public.advertisement_snapshots where id in(select s.id from public.advertisement_snapshots s where s.workspace_id=w and s.created_at<now()-make_interval(days=>retention) and exists(select 1 from public.advertisement_snapshots newer where newer.source_link_id=s.source_link_id and newer.created_at>s.created_at) and not exists(select 1 from public.generation_plans p where p.opportunity_id=s.opportunity_id) and not exists(select 1 from public.proposals p where p.opportunity_id=s.opportunity_id) and not exists(select 1 from public.submissions p where p.opportunity_id=s.opportunity_id) order by s.created_at limit 200);
 -- Persistent generation and usage evidence is retained. Only unreferenced terminal job details expire.
 delete from public.source_runs where id in(select sr.id from public.source_runs sr join public.jobs j on j.id=sr.job_id where sr.workspace_id=w and j.status in ('succeeded','failed','canceled') and j.updated_at<now()-make_interval(days=>retention) and not exists(select 1 from public.generation_steps gs where gs.job_id=j.id) and not exists(select 1 from public.regeneration_requests rr where rr.job_id=j.id) and not exists(select 1 from public.provider_usage u where u.job_id=j.id) limit 200);
 delete from public.jobs where id in(select j.id from public.jobs j where workspace_id=w and status in ('succeeded','failed','canceled') and updated_at<now()-make_interval(days=>retention) and not exists(select 1 from public.source_runs sr where sr.job_id=j.id) and not exists(select 1 from public.generation_steps gs where gs.job_id=j.id) and not exists(select 1 from public.regeneration_requests rr where rr.job_id=j.id) and not exists(select 1 from public.provider_usage u where u.job_id=j.id) limit 200);
 for r in select * from public.opportunities where workspace_id=w and not archived and decision<>'declined' loop
 if r.deadline_at is null and nullif(r.deadline_raw,'') is not null then
 perform app_private.notify_members(w,'deadline-review:'||r.id||':'||encode(sha256(convert_to(r.deadline_raw,'UTF8')),'hex'),'Confirm deadline time',r.title||': the source deadline needs an explicit time and timezone.',r.id,actor);
 elsif r.deadline_at>now() and r.deadline_timezone is not null then
 foreach n in array array[7,3,1] loop if r.deadline_at<=now()+make_interval(days=>n) and r.deadline_at>now()+make_interval(days=>n-1) then perform app_private.notify_members(w,'deadline:'||r.id||':'||r.deadline_at::text||':'||n,'Submission deadline approaching',r.title||': confirmed deadline within '||n||' day(s).',r.id,actor);end if;end loop;
 end if;end loop;
 update public.operations set last_maintenance_at=now() where workspace_id=w;
 return jsonb_build_object('due',true,'expired_uploads',expired_count,'retention_days',retention);
end $$;
revoke all on function public.maintenance_tick() from public,anon,authenticated;grant execute on function public.maintenance_tick() to service_role;
create function public.claim_storage_cleanup() returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.storage_cleanup_queue;result jsonb:='[]';w uuid;
begin
 select id into w from public.workspaces limit 1;if w is null then return result;end if;perform 1 from public.workspaces where id=w for update;
 update public.storage_cleanup_queue set status=case when attempts<5 then 'pending' else 'blocked' end,error_code='CLEANUP_LEASE_EXPIRED',lease_token=null,lease_until=null where workspace_id=w and status='running' and lease_until<now();
 for r in select * from public.storage_cleanup_queue where workspace_id=w and status='pending' order by created_at for update skip locked limit 5 loop
 if exists(select 1 from public.documents where storage_key=r.storage_key and status<>'expired') or exists(select 1 from public.export_artifacts where storage_key=r.storage_key and status<>'expired') or exists(select 1 from public.restore_files f join public.restore_sessions s on s.id=f.session_id where f.storage_key=r.storage_key and s.state='staging') then update public.storage_cleanup_queue set status='blocked',error_code='ACTIVE_REFERENCE_FOUND' where id=r.id;continue;end if;
 update public.storage_cleanup_queue set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '180 seconds',updated_at=now() where id=r.id returning * into r;result:=result||jsonb_build_array(to_jsonb(r));end loop;return result;
end $$;
revoke all on function public.claim_storage_cleanup() from public,anon,authenticated;grant execute on function public.claim_storage_cleanup() to service_role;
create function public.complete_storage_cleanup(cleanup_id uuid,lease uuid,succeeded boolean) returns void language plpgsql security definer set search_path='' as $$declare r public.storage_cleanup_queue;begin select * into r from public.storage_cleanup_queue where id=cleanup_id for update;if r.status<>'running' or r.lease_token is distinct from lease or r.lease_until<now() then raise exception 'STALE_LEASE';end if;
 update public.storage_cleanup_queue set status=case when succeeded then 'done' when attempts<5 then 'pending' else 'blocked' end,error_code=case when succeeded then null else 'STORAGE_DELETE_FAILED' end,lease_token=null,lease_until=null,updated_at=now() where id=r.id;
 if succeeded then update public.restore_files set status='removed' where storage_key=r.storage_key;update public.operations set last_cleanup_at=now() where workspace_id=r.workspace_id;end if;
end $$;
revoke all on function public.complete_storage_cleanup(uuid,uuid,boolean) from public,anon,authenticated;grant execute on function public.complete_storage_cleanup(uuid,uuid,boolean) to service_role;

alter table public.restore_sessions drop constraint restore_sessions_state_check;
alter table public.restore_sessions add constraint restore_sessions_state_check check(state in ('staging','committing','committed','canceled','expired'));

create or replace function public.begin_workspace_restore(backup_manifest jsonb,eligibility_attested boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=app_private.recovery_workspace();s public.restore_sessions;m jsonb:=backup_manifest;item jsonb;t text;id uuid;seen text[]:='{}';total bigint:=0;file_total bigint:=0;key text;f public.restore_files;
begin
 perform 1 from public.workspaces where workspaces.id=w for update;perform app_private.assert_empty_recovery_target(w);
 if eligibility_attested is distinct from true then raise exception 'ELIGIBILITY_REVIEW_REQUIRED';end if;
 if pg_column_size(m)>16777216 or m->>'format' is distinct from 'tenderdesk-backup-v1' or m->>'schema_hash' is distinct from app_private.backup_schema_hash() or m->>'root_hash' is distinct from encode(sha256(convert_to((m-'root_hash')::text,'UTF8')),'hex') then raise exception 'BACKUP_MANIFEST_INVALID';end if;
 if jsonb_typeof(m->'rows') is distinct from 'array' or jsonb_array_length(m->'rows')>100000 or jsonb_typeof(m->'files') is distinct from 'array' or jsonb_array_length(m->'files')>5000 then raise exception 'BACKUP_MANIFEST_INVALID';end if;
 for item in select value from jsonb_array_elements(m->'rows') loop
 key:=item->>'key';t:=split_part(key,'/',1);id:=split_part(key,'/',2)::uuid;if not t=any(app_private.backup_tables()) or key=any(seen) or item->>'hash'!~'^[0-9a-f]{64}$' or (item->>'size')::bigint not between 2 and 9437184 then raise exception 'BACKUP_MANIFEST_INVALID';end if;
 total:=total+(item->>'size')::bigint;seen:=array_append(seen,key);
 end loop;if total>134217728 then raise exception 'BACKUP_METADATA_CAP_REACHED';end if;
 for item in select value from jsonb_array_elements(m->'files') loop
 if not item->>'key'=any(seen) or split_part(item->>'key','/',1) not in ('documents','export_artifacts') or item->>'hash'!~'^[0-9a-f]{64}$' or (item->>'size')::bigint not between 1 and 10485760 then raise exception 'BACKUP_MANIFEST_INVALID';end if;
 file_total:=file_total+(item->>'size')::bigint;perform app_private.assert_business_content(item->>'name');end loop;if file_total>262144000 then raise exception 'STORAGE_CAP_REACHED';end if;
 if (select coalesce(sum(pg_total_relation_size(c.oid)),0) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private') and c.relkind='r')+total*2>262144000 then raise exception 'RESTORE_DATABASE_CAP_REACHED';end if;
 select * into s from public.restore_sessions where workspace_id=w and state='staging';
 if s.id is not null then
 if s.manifest->>'root_hash' is distinct from m->>'root_hash' or s.expires_at<now() then raise exception 'RESTORE_IN_PROGRESS';end if;
 return jsonb_build_object('id',s.id,'state',s.state,'files',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.restore_files x where session_id=s.id));
 end if;
 if app_private.storage_reserved_bytes(w)+file_total>262144000 then raise exception 'STORAGE_CAP_REACHED';end if;
 insert into public.restore_sessions(workspace_id,manifest,created_by) values(w,m,auth.uid()) returning * into s;
 for item in select value from jsonb_array_elements(m->'files') loop insert into public.restore_files(workspace_id,session_id,row_key,original_name,mime_type,content_hash,expected_size,storage_key,created_by) values(w,s.id,item->>'key',item->>'name',item->>'mime',item->>'hash',(item->>'size')::bigint,w::text||'/restore/'||s.id::text||'/'||split_part(item->>'key','/',1)||'/'||split_part(item->>'key','/',2),auth.uid());end loop;
 return jsonb_build_object('id',s.id,'state',s.state,'files',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.restore_files x where session_id=s.id));
end $$;

create or replace function public.commit_workspace_restore(restore_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.restore_sessions;r record;data jsonb;t text;f public.restore_files;columns text;source_workspace uuid;actor_key text;actor_value text;total bigint;
begin
 select * into s from public.restore_sessions where id=restore_id for update;
 if s.id is not null and s.state='committed' and app_private.member_role(s.workspace_id)='Owner' then return jsonb_build_object('id',s.id,'state',s.state);end if;
 perform app_private.check_restore(s,auth.uid());perform 1 from public.workspaces where id=s.workspace_id for update;perform app_private.assert_empty_recovery_target(s.workspace_id);
 if (select count(*) from app_private.restore_rows where session_id=s.id)<>jsonb_array_length(s.manifest->'rows') or exists(select 1 from public.restore_files where session_id=s.id and status<>'ready') then raise exception 'RESTORE_INCOMPLETE';end if;
 -- Validate file-to-record correspondence before inserting any business row.
 for r in select row_key,payload_text::jsonb d from app_private.restore_rows where session_id=s.id and split_part(row_key,'/',1) in ('documents','export_artifacts') loop
 select * into f from public.restore_files where session_id=s.id and row_key=r.row_key;
 if (split_part(r.row_key,'/',1)='documents' and r.d->>'uploaded_size' is not null and r.d->>'status'<>'expired') or (split_part(r.row_key,'/',1)='export_artifacts' and r.d->>'status'='ready') then
 if f.id is null or f.content_hash is distinct from coalesce(r.d->>'original_hash',r.d->>'content_hash') or f.expected_size is distinct from (coalesce(r.d->>'uploaded_size',r.d->>'expected_size'))::bigint or f.mime_type is distinct from r.d->>'mime_type' or f.original_name is distinct from r.d->>'original_name' then raise exception 'BACKUP_FILE_RECORD_MISMATCH';end if;
 elsif f.id is not null then raise exception 'BACKUP_FILE_RECORD_MISMATCH';end if;
 end loop;
 update public.restore_sessions set state='committing' where id=s.id;
 set constraints all deferred;
 -- Actors are pseudonymous historical references only. Current membership remains untouched.
 for r in select payload_text::jsonb d from app_private.restore_rows where session_id=s.id and split_part(row_key,'/',1)='workspace_actors' loop insert into public.workspace_actors values(s.workspace_id,(r.d->>'id')::uuid,'historical') on conflict do nothing;end loop;
 foreach t in array app_private.backup_tables() loop
 if t='workspace_actors' then continue;end if;
 select string_agg(quote_ident(column_name),',' order by ordinal_position) into columns from information_schema.columns where table_schema='public' and table_name=t;
 for r in select payload_text::jsonb d,row_key from app_private.restore_rows where session_id=s.id and split_part(row_key,'/',1)=t order by row_key loop
 data:=r.d||jsonb_build_object('workspace_id',s.workspace_id);
 -- All historical author IDs must be backed by a historical actor, never a new Auth account.
 if t='sources' then data:=data||'{"approval":"paused","next_due":null,"policy_checked_at":null}';
 elsif t='knowledge_items' then data:=data||'{"verified":false,"verified_by":null,"verified_at":null}';
 elsif t='rate_catalog' then data:=data||'{"approved":false,"public_approved":false,"approved_by":null,"approved_at":null}';
 elsif t='templates' then data:=data||'{"approved":false,"approved_by":null,"approved_at":null}';
 elsif t='model_settings' then data:=data||'{"enabled":false,"billing_verified":false}';
 elsif t='content_authorizations' then data:=data||jsonb_build_object('revoked_at',now());
 elsif t='provider_usage' and data->>'state'='reserved' then data:=data||'{"state":"unknown","error_code":"RESTORED_UNCERTAIN_USAGE"}';
 elsif t='proposals' then data:=data||'{"state":"draft"}';
 elsif t='proposal_versions' then data:=data||'{"status":"draft","evidence_revision":-1}';
 elsif t in ('estimate_versions','delivery_versions') then data:=data||jsonb_build_object('status',case when data->'calculated' is null or data->'calculated'='null'::jsonb then 'pending' else 'ready' end,'approved_by',null,'approved_at',null,'evidence_revision',-1);
 elsif t='approvals' then data:=data||jsonb_build_object('invalidated_at',now());
 elsif t='compliance_responses' then data:=data||'{"confirmed_by":null,"confirmed_at":null}';
 elsif t='generation_plans' then data:=data||jsonb_build_object('status',case when data->>'status'='completed' then 'completed' else 'canceled' end,'evidence_revision',-1,'error_code','RESTORED_REVIEW_REQUIRED');
 elsif t='jobs' then data:=data||jsonb_build_object('status',case when data->>'status' in ('succeeded','failed','canceled') then data->>'status' else 'canceled' end,'lease_token',null,'lease_until',null,'cancel_requested',true,'error_code','RESTORED_REVIEW_REQUIRED');
 elsif t='documents' then
 select * into f from public.restore_files where session_id=s.id and row_key=r.row_key;
 data:=data||jsonb_build_object('storage_key',coalesce(f.storage_key,s.workspace_id::text||'/unavailable/'||(data->>'id')),'extraction_confirmed_at',null,'extraction_confirmed_by',null,'eligibility_reviewed_at',null,'eligibility_reviewed_by',null,'eligibility_hash',null);
 if f.id is null then data:=data||'{"status":"expired"}';end if;
 elsif t='export_artifacts' then select * into f from public.restore_files where session_id=s.id and row_key=r.row_key;data:=data||jsonb_build_object('storage_key',coalesce(f.storage_key,s.workspace_id::text||'/unavailable/'||(data->>'id')));if f.id is null then data:=data||'{"status":"expired"}';end if;
 elsif t='export_requests' then data:=data||jsonb_build_object('expires_at',now()-interval '1 second');
 end if;
 execute format('insert into public.%I(%s) select %s from jsonb_populate_record(null::public.%I,$1)',t,columns,columns,t) using data;
 end loop;end loop;
 -- FK failures roll back the entire commit, including any trigger effects.
 set constraints all immediate;
 update public.workspaces set model_enabled=false,name=s.manifest->>'workspace_name',settings=s.manifest->'settings',evidence_revision=evidence_revision+1,restore_origin=jsonb_build_object('session_id',s.id,'root_hash',s.manifest->>'root_hash','source_workspace',s.manifest->>'source_workspace','restored_at',now(),'authorizations_reset',true),revision=revision+1 where id=s.workspace_id;
 update public.operations set scheduler_enabled=false where workspace_id=s.workspace_id;
 update public.restore_sessions set state='committed',committed_at=now(),manifest=jsonb_build_object('root_hash',s.manifest->>'root_hash','schema_hash',s.manifest->>'schema_hash','source_workspace',s.manifest->>'source_workspace','row_count',jsonb_array_length(s.manifest->'rows'),'file_count',jsonb_array_length(s.manifest->'files')) where id=s.id;
 delete from public.restore_files where session_id=s.id;
 delete from app_private.restore_rows where session_id=s.id;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(s.workspace_id,auth.uid(),'recovery.restored','workspace',s.workspace_id,jsonb_build_object('manifest_hash',s.manifest->>'root_hash','row_count',jsonb_array_length(s.manifest->'rows'),'file_count',jsonb_array_length(s.manifest->'files'),'permissions_reset',true));
 return jsonb_build_object('id',s.id,'state','committed','rows',jsonb_array_length(s.manifest->'rows'),'files',jsonb_array_length(s.manifest->'files'));
end $$;

create or replace function public.claim_backend_job() returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;j public.jobs;s public.sources;operator_id uuid;
begin
 select id into w from public.workspaces limit 1;if w is null then return null;end if;
 perform 1 from public.workspaces where id=w for update;
 if exists(select 1 from public.restore_sessions where workspace_id=w and state='staging') then return null;end if;
 select m.user_id into operator_id from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=w and m.active and m.role='Owner' and a.status='active' order by m.created_at limit 1;
 update public.operations set last_heartbeat_at=now(),scheduler_enabled=coalesce((select enabled from app_private.dispatcher_settings where singleton),false) where workspace_id=w;
 update public.jobs set status=case when cancel_requested then 'canceled' when type like 'source_%' and attempts<4 then 'retry_wait' else 'blocked' end,error_code=case when type like 'source_%' then 'COLLECTION_LEASE_EXPIRED' else 'LEASE_EXPIRED_REVIEW_REQUIRED' end,lease_token=null,lease_until=null,next_attempt_at=now()+interval '1 minute',revision=revision+1,updated_at=now() where workspace_id=w and status='running' and lease_until<now();
 for s in select * from public.sources where workspace_id=w and approval='approved' and kind<>'manual' and not adapter_required and next_due<=now() and operator_id is not null order by next_due,id loop
  exit when (select count(*) from public.jobs where workspace_id=w and status in ('queued','running','retry_wait','quota_wait','blocked'))>=500;
  if not exists(select 1 from public.jobs where workspace_id=w and entity_id=s.id and type='source_collect' and status in ('queued','running','retry_wait')) then
   insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by) values(w,'source_collect',s.id,s.revision::text,'queued',operator_id);
  end if;
  update public.sources set next_due=now()+make_interval(hours=>s.poll_interval_hours) where id=s.id;
 end loop;
 if exists(select 1 from public.jobs where workspace_id=w and status='running') then return null; end if;
 select * into j from public.jobs where workspace_id=w and status in ('queued','retry_wait','quota_wait') and next_attempt_at<=now() order by case when created_at<now()-interval '1 hour' then 0 when type in ('plan_proposal','analyze_chunk','draft_section') then 1 else 2 end,created_at,id for update skip locked limit 1;
 if j.id is null then return null;end if;
 if j.cancel_requested then update public.jobs set status='canceled',revision=revision+1 where id=j.id;return null;end if;
 update public.jobs set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '180 seconds',revision=revision+1,updated_at=now() where id=j.id returning * into j;
 return to_jsonb(j);
end $$;

create function app_private.purge_scope(w uuid,opp uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare proposals uuid[];versions uuid[];plans uuid[];documents uuid[];jobs uuid[];reviews uuid[];estimates uuid[];deliveries uuid[];exports uuid[];t text;clause text;part jsonb;result jsonb:='{}';
begin
 select coalesce(array_agg(id),'{}') into proposals from public.proposals where workspace_id=w and opportunity_id=opp;
 select coalesce(array_agg(id),'{}') into versions from public.proposal_versions where workspace_id=w and proposal_id=any(proposals);
 select coalesce(array_agg(id),'{}') into plans from public.generation_plans where workspace_id=w and opportunity_id=opp;
 select coalesce(array_agg(id),'{}') into reviews from public.review_inputs where workspace_id=w and proposal_id=any(proposals);
 select coalesce(array_agg(id),'{}') into documents from public.documents where workspace_id=w and (opportunity_id=opp or review_input_id=any(reviews));
 select coalesce(array_agg(id),'{}') into jobs from public.jobs where workspace_id=w and (entity_id=any(plans) or entity_id=any(proposals) or entity_id=opp or id in (select job_id from public.regeneration_requests where proposal_id=any(proposals)));
 select coalesce(array_agg(id),'{}') into estimates from public.estimate_versions where workspace_id=w and proposal_version_id=any(versions);
 select coalesce(array_agg(id),'{}') into deliveries from public.delivery_versions where workspace_id=w and proposal_version_id=any(versions);
 select coalesce(array_agg(id),'{}') into exports from public.export_requests where workspace_id=w and proposal_version_id=any(versions);
 t:='opportunities';clause:='id=$2';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='opportunity_relations';clause:='opportunity_id=$2 or related_opportunity_id=$2';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='submissions';clause:='opportunity_id=$2';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='submission_events';clause:='opportunity_id=$2';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='acquisitions';clause:='opportunity_id=$2';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='proposals';clause:='id=any($3)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='proposal_versions';clause:='id=any($4)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='proposal_sections';clause:='proposal_version_id=any($4)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='questions';clause:='opportunity_id=$2 or proposal_version_id=any($4)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='review_inputs';clause:='id=any($8)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='documents';clause:='id=any($6)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='document_blocks';clause:='document_id=any($6)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='document_packages';clause:='opportunity_id=$2';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='generation_plans';clause:='id=any($5)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='generation_steps';clause:='plan_id=any($5)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='requirements';clause:='opportunity_id=$2';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='fit_assessments';clause:='opportunity_id=$2';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='jobs';clause:='id=any($7)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='regeneration_requests';clause:='proposal_id=any($3)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='estimate_versions';clause:='id=any($9)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='estimate_lines';clause:='estimate_id=any($9)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='delivery_versions';clause:='id=any($10)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='delivery_tasks';clause:='delivery_id=any($10)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='requirement_inventories';clause:='plan_id=any($5)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='compliance_responses';clause:='proposal_version_id=any($4)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='reviews';clause:='proposal_version_id=any($4)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='approvals';clause:='proposal_version_id=any($4)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='export_requests';clause:='id=any($11)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='export_artifacts';clause:='export_id=any($11)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='opportunity_source_links';clause:='opportunity_id=$2';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='advertisement_snapshots';clause:='opportunity_id=$2';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='content_authorizations';clause:='entity_id=$2 or entity_id=any($6) or entity_id=any($8)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 t:='source_runs';clause:='job_id=any($7)';
 execute format('select jsonb_build_object(''ids'',coalesce(jsonb_agg(id order by id),''[]''),''hash'',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text,'','' order by id),''''),''UTF8'')),''hex'')) from public.%I x where workspace_id=$1 and (%s)',t,clause) into part using w,opp,proposals,versions,plans,documents,jobs,reviews,estimates,deliveries,exports;result:=result||jsonb_build_object(t,part);
 return result;end $$;
revoke all on function app_private.purge_scope(uuid,uuid) from public,anon,authenticated;
create function public.preview_opportunity_purge(opportunity_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=app_private.recovery_workspace();o public.opportunities;scope jsonb;counts jsonb;files jsonb;active boolean;
begin
 select * into o from public.opportunities where workspace_id=w and id=opportunity_id;if o.id is null then raise exception 'NOT_FOUND';end if;
 scope:=app_private.purge_scope(w,o.id);
 select jsonb_object_agg(key,jsonb_array_length(value->'ids')) into counts from jsonb_each(scope);
 select coalesce(jsonb_agg(f),'[]') into files from (select jsonb_build_object('id',id,'name',original_name,'size',expected_size,'hash',original_hash) f from public.documents where id in(select value::text::uuid from jsonb_array_elements_text(scope->'documents'->'ids')) union all select jsonb_build_object('id',id,'name',original_name,'size',expected_size,'hash',content_hash) from public.export_artifacts where id in(select value::text::uuid from jsonb_array_elements_text(scope->'export_artifacts'->'ids'))) x;
 select exists(select 1 from public.jobs where id in(select value::text::uuid from jsonb_array_elements_text(scope->'jobs'->'ids')) and status='running' and lease_until>now()) into active;
 return jsonb_build_object('id',o.id,'title',o.title,'archived',o.archived,'counts',counts,'files',files,'active_worker',active,'preview_hash',encode(sha256(convert_to(scope::text,'UTF8')),'hex'));
end $$;
revoke all on function public.preview_opportunity_purge(uuid) from public,anon;grant execute on function public.preview_opportunity_purge(uuid) to authenticated;
create function public.archive_opportunity(opportunity_id uuid,expected_revision integer,archive boolean,reason text) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.opportunities;w uuid;result jsonb;
begin
 select * into o from public.opportunities where id=opportunity_id;w:=o.workspace_id;if w is null or coalesce(app_private.member_role(w),'') not in ('Owner','Editor') then raise exception 'ROLE_FORBIDDEN';end if;perform 1 from public.workspaces where id=w for update;
 if exists(select 1 from public.restore_sessions where workspace_id=w and state='staging') then raise exception 'RESTORE_IN_PROGRESS';end if;
 if length(coalesce(reason,'')) not between 10 and 3000 or archive is null then raise exception 'INVALID_INPUT';end if;perform app_private.assert_business_content(reason);
 update public.opportunities set archived=archive,revision=revision+1,updated_at=now() where id=o.id and revision=expected_revision returning to_jsonb(opportunities.*) into result;if result is null then raise exception 'REVISION_CONFLICT';end if;
 if archive then update public.jobs set cancel_requested=true,status=case when status='running' then status else 'canceled' end,revision=revision+1,updated_at=now() where workspace_id=w and entity_id in(select gp.id from public.generation_plans gp where gp.opportunity_id=o.id) and status not in ('succeeded','failed','canceled');end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,reason) values(w,auth.uid(),case when archive then 'opportunity.archived' else 'opportunity.unarchived' end,'opportunity',o.id,reason);return result;
end $$;
revoke all on function public.archive_opportunity(uuid,integer,boolean,text) from public,anon;grant execute on function public.archive_opportunity(uuid,integer,boolean,text) to authenticated;
create function public.purge_opportunity(opportunity_id uuid,preview_hash text,confirmed_title text,reason text,acknowledge_history boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=app_private.recovery_workspace();preview jsonb;scope jsonb;t text;ids jsonb;all_ids uuid[];o public.opportunities;result jsonb;
begin
 perform 1 from public.workspaces where id=w for update;
 if exists(select 1 from public.restore_sessions where workspace_id=w and state='staging') then raise exception 'RESTORE_IN_PROGRESS';end if;
 if not exists(select 1 from public.opportunities where workspace_id=w and id=opportunity_id) then select details into result from public.audit_events where workspace_id=w and action='opportunity.purged' and entity_id=opportunity_id and details->>'preview_hash'=purge_opportunity.preview_hash order by created_at desc limit 1;if result is not null then return result;end if;raise exception 'NOT_FOUND';end if;
 preview:=public.preview_opportunity_purge(opportunity_id);
 if preview->>'preview_hash' is distinct from purge_opportunity.preview_hash then raise exception 'STALE_PURGE_PREVIEW';end if;
 if (preview->>'archived')::boolean is distinct from true or (preview->>'active_worker')::boolean then raise exception 'ARCHIVE_AND_STOP_PROCESSING_FIRST';end if;
 if acknowledge_history is distinct from true or confirmed_title is distinct from preview->>'title' or length(coalesce(reason,'')) not between 10 and 3000 then raise exception 'PURGE_CONFIRMATION_REQUIRED';end if;perform app_private.assert_business_content(reason);
 scope:=app_private.purge_scope(w,opportunity_id);select * into o from public.opportunities where id=opportunity_id;
 select coalesce(array_agg(deleted.value::uuid),'{}') into all_ids from jsonb_each(scope) item cross join lateral jsonb_array_elements_text(item.value->'ids') deleted;
 insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason) select w,storage_key,expected_size,'owner_confirmed_purge' from public.documents where status<>'expired' and id in(select value::uuid from jsonb_array_elements_text(scope->'documents'->'ids')) union all select w,storage_key,expected_size,'owner_confirmed_purge' from public.export_artifacts where status<>'expired' and id in(select value::uuid from jsonb_array_elements_text(scope->'export_artifacts'->'ids')) on conflict(storage_key) do nothing;
 update public.provider_usage set job_id=null,state=case when state='reserved' then 'unknown' else state end,error_code=case when state='reserved' then 'PURGED_EXPIRED_JOB_USAGE_UNKNOWN' else error_code end,revision=revision+1 where workspace_id=w and job_id in(select value::uuid from jsonb_array_elements_text(scope->'jobs'->'ids'));
 update app_private.idempotency_records r set result=jsonb_build_object('purged',true) where r.workspace_id=w and exists(select 1 from unnest(all_ids) deleted where position(deleted::text in r.result::text)>0);
 delete from app_private.extraction_parts where document_id in(select value::uuid from jsonb_array_elements_text(scope->'documents'->'ids'));
 set constraints all deferred;
 for t,ids in select key,value->'ids' from jsonb_each(scope) loop execute format('delete from public.%I where workspace_id=$1 and id in(select value::uuid from jsonb_array_elements_text($2))',t) using w,ids;end loop;
 delete from public.notifications where workspace_id=w and entity_id=any(all_ids);
 if o.import_batch_id is not null and o.import_row is not null then update public.import_batches set rows=jsonb_set(rows,array[(o.import_row-1)::text],'{"purged":true}'),revision=revision+1 where workspace_id=w and id=o.import_batch_id;end if;
 update public.audit_events set reason='Business content removed by Owner-confirmed purge',details=jsonb_build_object('purged',true,'previous_details_hash',encode(sha256(convert_to(details::text,'UTF8')),'hex')) where workspace_id=w and (entity_id=any(all_ids) or exists(select 1 from unnest(all_ids) deleted where position(deleted::text in details::text)>0));
 set constraints all immediate;
 result:=jsonb_build_object('id',opportunity_id,'preview_hash',preview_hash,'counts',preview->'counts','objects_queued',jsonb_array_length(preview->'files'));
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,reason,details) values(w,auth.uid(),'opportunity.purged','opportunity',opportunity_id,reason,result);return result;
end $$;
revoke all on function public.purge_opportunity(uuid,text,text,text,boolean) from public,anon;grant execute on function public.purge_opportunity(uuid,text,text,text,boolean) to authenticated;

alter function public.workspace_status() rename to workspace_status_before_operations;
revoke all on function public.workspace_status_before_operations() from public,anon,authenticated;
create function public.workspace_status() returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;result jsonb;day date:=(now() at time zone 'Asia/Riyadh')::date;
begin
 result:=public.workspace_status_before_operations();select m.workspace_id into w from public.memberships m where m.user_id=auth.uid() and app_private.member_role(m.workspace_id) is not null limit 1;
 return result||jsonb_build_object('last_maintenance_at',(select last_maintenance_at from public.operations where workspace_id=w),'last_cleanup_at',(select last_cleanup_at from public.operations where workspace_id=w),
 'export_bytes',(select coalesce(sum(expected_size),0)::text from public.export_artifacts where workspace_id=w and status<>'expired'),
 'reserved_storage_bytes',app_private.storage_reserved_bytes(w)::text,
 'cleanup_bytes',(select coalesce(sum(estimated_size),0)::text from public.storage_cleanup_queue where workspace_id=w and status<>'done'),
 'cleanup_pending',(select count(*) from public.storage_cleanup_queue where workspace_id=w and status in ('pending','running')),'cleanup_blocked',(select count(*) from public.storage_cleanup_queue where workspace_id=w and status='blocked'),
 'queued_jobs',(select count(*) from public.jobs where workspace_id=w and status in ('queued','retry_wait')),'blocked_jobs',(select count(*) from public.jobs where workspace_id=w and status in ('blocked','quota_wait')),
 'model_enabled',coalesce((select enabled from public.model_settings where workspace_id=w),false),'usage_day',day,'usage_timezone','Asia/Riyadh',
 'calls_today',(select count(*) from public.provider_usage where workspace_id=w and application_day=day),
 'input_tokens_today',(select coalesce(sum(coalesce(actual_input,reserved_input)),0)::text from public.provider_usage where workspace_id=w and application_day=day),
 'output_tokens_today',(select coalesce(sum(coalesce(actual_output,reserved_output)),0)::text from public.provider_usage where workspace_id=w and application_day=day),
 'unknown_usage',(select count(*) from public.provider_usage where workspace_id=w and state='unknown'));
end $$;
revoke all on function public.workspace_status() from public,anon;grant execute on function public.workspace_status() to authenticated;
create function public.retry_storage_cleanup(cleanup_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=app_private.recovery_workspace();result jsonb;
begin
 perform 1 from public.workspaces where id=w for update;
 update public.storage_cleanup_queue set status='pending',attempts=0,lease_token=null,lease_until=null,error_code=null,updated_at=now() where workspace_id=w and id=cleanup_id and status='blocked' returning to_jsonb(storage_cleanup_queue.*) into result;
 if result is null then raise exception 'INVALID_TRANSITION';end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id) values(w,auth.uid(),'storage.cleanup_retried',cleanup_id);return result;
end $$;
revoke all on function public.retry_storage_cleanup(uuid) from public,anon;grant execute on function public.retry_storage_cleanup(uuid) to authenticated;
create or replace function app_private.invalidate_evidence() returns trigger language plpgsql security definer set search_path='' as $$
declare a record;
begin
 if TG_OP='UPDATE' and to_jsonb(new)-'revision'-'updated_at'=to_jsonb(old)-'revision'-'updated_at' then return new;end if;
 update public.workspaces set evidence_revision=evidence_revision+1 where id=new.workspace_id;
 for a in update public.approvals set invalidated_at=now(),revision=revision+1 where workspace_id=new.workspace_id and invalidated_at is null returning * loop
 perform app_private.notify_members(new.workspace_id,'approval-invalidated:'||a.id,'Approval needs review','Supporting evidence changed. Review and approve the current proposal again.',a.proposal_version_id,a.created_by);end loop;
 update public.proposals set state='draft',revision=revision+1,updated_at=now() where workspace_id=new.workspace_id and state='approved';
 update public.proposal_versions set status='draft',revision=revision+1 where workspace_id=new.workspace_id and status='approved';return new;
end $$;
create or replace function app_private.invalidate_version_approval() returns trigger language plpgsql security definer set search_path='' as $$
declare v uuid:=new.proposal_version_id;a record;
begin
 for a in update public.approvals set invalidated_at=now(),revision=revision+1 where proposal_version_id=v and invalidated_at is null returning * loop
 perform app_private.notify_members(new.workspace_id,'approval-invalidated:'||a.id,'Approval needs review','Proposal content, review or commercial evidence changed. A new approval is required.',v,a.created_by);end loop;
 update public.proposal_versions set status='draft',revision=revision+1,updated_at=now() where id=v and status='approved';
 update public.proposals set state='draft',revision=revision+1,updated_at=now() where active_version_id=v and state='approved';return new;
end $$;
