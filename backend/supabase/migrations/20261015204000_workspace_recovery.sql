-- Recovery copies business history; it never copies Auth users, invitations, secrets or access grants.
create function app_private.backup_tables() returns text[] language sql immutable set search_path='' as $$select array['workspace_actors','sources','import_batches','opportunities','knowledge_items','rate_catalog','templates','proposals','documents','document_blocks','document_packages','jobs','generation_plans','generation_steps','requirements','fit_assessments','proposal_versions','proposal_sections','questions','review_inputs','regeneration_requests','estimate_versions','estimate_lines','delivery_versions','delivery_tasks','requirement_inventories','compliance_responses','reviews','approvals','export_requests','export_artifacts','acquisitions','submissions','submission_events','opportunity_relations','opportunity_source_links','advertisement_snapshots','source_runs','model_settings','content_authorizations','provider_usage','audit_events']::text[]$$;
revoke all on function app_private.backup_tables() from public,anon,authenticated;
create table public.workspace_actors(workspace_id uuid not null references public.workspaces(id),id uuid not null,kind text not null check(kind in ('member','historical')),primary key(workspace_id,id));
alter table public.workspace_actors enable row level security;revoke all on public.workspace_actors from public,anon,authenticated;grant select on public.workspace_actors to authenticated;grant all on public.workspace_actors to service_role;
create policy member_read on public.workspace_actors for select to authenticated using(app_private.member_role(workspace_id) is not null);
insert into public.workspace_actors select workspace_id,user_id,'member' from public.memberships on conflict do nothing;
create function app_private.register_workspace_actor() returns trigger language plpgsql security definer set search_path='' as $$begin insert into public.workspace_actors values(new.workspace_id,new.user_id,'member') on conflict(workspace_id,id) do update set kind='member';return new;end $$;
revoke all on function app_private.register_workspace_actor() from public,anon,authenticated;
create trigger register_workspace_actor after insert on public.memberships for each row execute function app_private.register_workspace_actor();
-- Business author IDs can refer to historical actors without giving them a login or membership.
do $$ declare r record;begin
 for r in select c.conname,c.conrelid::regclass tab,a.attname from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1] where c.contype='f' and c.confrelid='auth.users'::regclass and n.nspname='public' and t.relname=any(app_private.backup_tables()) loop
 execute format('insert into public.workspace_actors select distinct workspace_id,%I,''historical'' from %s where %I is not null on conflict do nothing',r.attname,r.tab,r.attname);
 execute format('alter table %s drop constraint %I',r.tab,r.conname);
 execute format('alter table %s add constraint %I foreign key(workspace_id,%I) references public.workspace_actors(workspace_id,id) deferrable initially immediate',r.tab,r.conname,r.attname);
 end loop;
 -- The complete graph is validated at the end of the atomic restore, including circular version links.
 for r in select c.conname,c.conrelid::regclass tab from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where c.contype='f' and n.nspname='public' and t.relname=any(app_private.backup_tables()) loop execute format('alter table %s alter constraint %I deferrable initially immediate',r.tab,r.conname);end loop;
end $$;
create table public.restore_sessions(id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),manifest jsonb not null check(pg_column_size(manifest)<=16777216),state text not null default 'staging' check(state in ('staging','committed','canceled','expired')),created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '24 hours',committed_at timestamptz,unique(workspace_id,id));
create unique index one_restore_in_progress on public.restore_sessions(workspace_id) where state='staging';
create table app_private.restore_rows(session_id uuid not null references public.restore_sessions(id),row_key text not null,payload_text text not null check(octet_length(payload_text)<=9437184),content_hash text not null,primary key(session_id,row_key));
create table public.restore_files(id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),session_id uuid not null,row_key text not null,original_name text not null,mime_type text not null,content_hash text not null check(content_hash~'^[0-9a-f]{64}$'),expected_size bigint not null check(expected_size between 1 and 10485760),storage_key text not null unique,status text not null default 'pending' check(status in ('pending','ready','removed')),created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),unique(session_id,row_key),foreign key(workspace_id,session_id) references public.restore_sessions(workspace_id,id));
do $$ declare t text;begin foreach t in array array['restore_sessions','restore_files'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);execute format('grant all on public.%I to service_role',t);execute format('create policy owner_read on public.%I for select to authenticated using(app_private.member_role(workspace_id)=''Owner'')',t);end loop;end $$;
revoke all on app_private.restore_rows from public,anon,authenticated;grant all on app_private.restore_rows to service_role;
create function app_private.recovery_workspace() returns uuid language plpgsql stable security definer set search_path='' as $$declare w uuid;begin select workspace_id into w from public.memberships where user_id=auth.uid() and app_private.member_role(workspace_id)='Owner' limit 1;if w is null then raise exception 'ROLE_FORBIDDEN';end if;return w;end $$;
revoke all on function app_private.recovery_workspace() from public,anon,authenticated;
create function app_private.backup_schema_hash() returns text language sql stable security definer set search_path='' as $$select encode(sha256(convert_to(string_agg(table_name||'.'||column_name||':'||udt_name,',' order by table_name,ordinal_position),'UTF8')),'hex') from information_schema.columns where table_schema='public' and table_name=any(app_private.backup_tables())$$;
revoke all on function app_private.backup_schema_hash() from public,anon,authenticated;
create function public.workspace_backup_manifest() returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=app_private.recovery_workspace();t text;items jsonb:='[]';part jsonb;files jsonb;body jsonb;total bigint:=0;
begin
 perform 1 from public.workspaces where id=w for share;
 foreach t in array app_private.backup_tables() loop
 execute format('select coalesce(jsonb_agg(jsonb_build_object(''key'',$2||''/''||id,''hash'',encode(sha256(convert_to(to_jsonb(x)::text,''UTF8'')),''hex''),''size'',octet_length(to_jsonb(x)::text)) order by id),''[]'') from public.%I x where workspace_id=$1 %s',t,case when t='audit_events' then 'and action not like ''recovery.%''' else '' end) into part using w,t;
 items:=items||part;
 end loop;
 select coalesce(sum((value->>'size')::bigint),0) into total from jsonb_array_elements(items);
 if total>134217728 or jsonb_array_length(items)>100000 then raise exception 'BACKUP_METADATA_CAP_REACHED';end if;
 select coalesce(jsonb_agg(file order by file->>'key'),'[]') into files from (
 select jsonb_build_object('key','documents/'||id,'hash',original_hash,'size',uploaded_size,'name',original_name,'mime',mime_type) file from public.documents where workspace_id=w and uploaded_size is not null and status<>'expired'
 union all select jsonb_build_object('key','export_artifacts/'||id,'hash',content_hash,'size',expected_size,'name',original_name,'mime',mime_type) from public.export_artifacts where workspace_id=w and status='ready') x;
 body:=jsonb_build_object('format','tenderdesk-backup-v1','schema_hash',app_private.backup_schema_hash(),'source_workspace',w,'workspace_name',(select name from public.workspaces where id=w),'settings',(select settings from public.workspaces where id=w),'rows',items,'files',files);
 return body||jsonb_build_object('root_hash',encode(sha256(convert_to(body::text,'UTF8')),'hex'));
end $$;
revoke all on function public.workspace_backup_manifest() from public,anon;grant execute on function public.workspace_backup_manifest() to authenticated;
create function public.workspace_backup_rows(row_keys jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=app_private.recovery_workspace();item jsonb;k text;t text;id uuid;data text;result jsonb:='[]';total bigint:=0;
begin
 if jsonb_typeof(row_keys)<>'array' or jsonb_array_length(row_keys) not between 1 and 30 then raise exception 'INVALID_INPUT';end if;
 for item in select value from jsonb_array_elements(row_keys) loop k:=item#>>'{}';t:=split_part(k,'/',1);id:=split_part(k,'/',2)::uuid;
 if not t=any(app_private.backup_tables()) then raise exception 'INVALID_TABLE';end if;
 execute format('select to_jsonb(x)::text from public.%I x where workspace_id=$1 and id=$2 %s',t,case when t='audit_events' then 'and action not like ''recovery.%''' else '' end) into data using w,id;if data is null then raise exception 'BACKUP_SOURCE_CHANGED';end if;
 total:=total+octet_length(data);if total>10485760 then raise exception 'BACKUP_BATCH_CAP_REACHED';end if;
 result:=result||jsonb_build_array(jsonb_build_object('key',k,'data',data,'hash',encode(sha256(convert_to(data,'UTF8')),'hex')));end loop;return result;
end $$;
revoke all on function public.workspace_backup_rows(jsonb) from public,anon;grant execute on function public.workspace_backup_rows(jsonb) to authenticated;
create function public.recovery_file_context(file_kind text,file_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid:=app_private.recovery_workspace();result jsonb;
begin
 if file_kind='documents' then select jsonb_build_object('workspace_id',workspace_id,'storage_key',storage_key,'size',uploaded_size,'hash',original_hash,'name',original_name,'mime',mime_type) into result from public.documents where workspace_id=w and id=file_id and uploaded_size is not null and status<>'expired';
 elsif file_kind='export_artifacts' then select jsonb_build_object('workspace_id',workspace_id,'storage_key',storage_key,'size',expected_size,'hash',content_hash,'name',original_name,'mime',mime_type) into result from public.export_artifacts where workspace_id=w and id=file_id and status='ready';else raise exception 'INVALID_KIND';end if;
 if result is null then raise exception 'NOT_FOUND';end if;return result;
end $$;
revoke all on function public.recovery_file_context(text,uuid) from public,anon;grant execute on function public.recovery_file_context(text,uuid) to authenticated;
create function app_private.assert_empty_recovery_target(w uuid) returns void language plpgsql security definer set search_path='' as $$declare t text;present boolean;begin foreach t in array app_private.backup_tables() loop if t not in ('workspace_actors','audit_events') then execute format('select exists(select 1 from public.%I where workspace_id=$1)',t) into present using w;if present then raise exception 'RESTORE_TARGET_NOT_EMPTY';end if;end if;end loop;end $$;
revoke all on function app_private.assert_empty_recovery_target(uuid) from public,anon,authenticated;
create function public.begin_workspace_restore(backup_manifest jsonb,eligibility_attested boolean) returns jsonb language plpgsql security definer set search_path='' as $$
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
 insert into public.restore_sessions(workspace_id,manifest,created_by) values(w,m,auth.uid()) returning * into s;
 for item in select value from jsonb_array_elements(m->'files') loop insert into public.restore_files(workspace_id,session_id,row_key,original_name,mime_type,content_hash,expected_size,storage_key,created_by) values(w,s.id,item->>'key',item->>'name',item->>'mime',item->>'hash',(item->>'size')::bigint,w::text||'/restore/'||s.id::text||'/'||split_part(item->>'key','/',1)||'/'||split_part(item->>'key','/',2),auth.uid());end loop;
 return jsonb_build_object('id',s.id,'state',s.state,'files',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from public.restore_files x where session_id=s.id));
end $$;
revoke all on function public.begin_workspace_restore(jsonb,boolean) from public,anon;grant execute on function public.begin_workspace_restore(jsonb,boolean) to authenticated;
create function app_private.check_restore(s public.restore_sessions,actor uuid) returns void language plpgsql security definer set search_path='' as $$begin
 if s.id is null or not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=s.workspace_id and m.user_id=actor and m.active and m.role='Owner' and a.status='active') then raise exception 'ROLE_FORBIDDEN';end if;
 if s.state<>'staging' or s.expires_at<now() then raise exception 'RESTORE_SESSION_CLOSED';end if;
end $$;
revoke all on function app_private.check_restore(public.restore_sessions,uuid) from public,anon,authenticated;
create function public.stage_restore_rows(restore_id uuid,items jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.restore_sessions;i jsonb;expected jsonb;data jsonb;hash text;total bigint:=0;t text;unknown_key text;
begin
 select * into s from public.restore_sessions where id=restore_id for update;perform app_private.check_restore(s,auth.uid());if jsonb_typeof(items)<>'array' or jsonb_array_length(items) not between 1 and 30 or pg_column_size(items)>11534336 then raise exception 'INVALID_INPUT';end if;
 for i in select value from jsonb_array_elements(items) loop
 select value into expected from jsonb_array_elements(s.manifest->'rows') where value->>'key'=i->>'key';hash:=encode(sha256(convert_to(i->>'data','UTF8')),'hex');
 if expected is null or expected->>'hash' is distinct from hash or (expected->>'size')::bigint is distinct from octet_length(i->>'data') then raise exception 'BACKUP_ROW_HASH_MISMATCH';end if;
 data:=(i->>'data')::jsonb;t:=split_part(i->>'key','/',1);
 if jsonb_typeof(data) is distinct from 'object' or data->>'id' is distinct from split_part(i->>'key','/',2) or data->>'workspace_id' is distinct from s.manifest->>'source_workspace' then raise exception 'BACKUP_ROW_INVALID';end if;
 select key into unknown_key from jsonb_object_keys(data) key where not exists(select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=t and c.column_name=key) limit 1;if unknown_key is not null then raise exception 'BACKUP_SCHEMA_MISMATCH';end if;
 if t not in ('audit_events','workspace_actors') then perform app_private.assert_business_content(data::text);end if;
 insert into app_private.restore_rows(session_id,row_key,payload_text,content_hash) values(s.id,i->>'key',i->>'data',hash) on conflict(session_id,row_key) do nothing;
 end loop;return jsonb_build_object('staged',(select count(*) from app_private.restore_rows where session_id=s.id));
end $$;
revoke all on function public.stage_restore_rows(uuid,jsonb) from public,anon;grant execute on function public.stage_restore_rows(uuid,jsonb) to authenticated;
create function public.restore_file_context(file_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare f public.restore_files;s public.restore_sessions;begin select * into f from public.restore_files where id=file_id;select * into s from public.restore_sessions where id=f.session_id;perform app_private.check_restore(s,auth.uid());return to_jsonb(f);end $$;
revoke all on function public.restore_file_context(uuid) from public,anon;grant execute on function public.restore_file_context(uuid) to authenticated;
create function public.complete_restore_file(file_id uuid,actor_id uuid,actual_hash text,actual_size bigint) returns jsonb language plpgsql security definer set search_path='' as $$declare f public.restore_files;s public.restore_sessions;begin select * into f from public.restore_files where id=file_id for update;select * into s from public.restore_sessions where id=f.session_id;perform app_private.check_restore(s,actor_id);if f.content_hash is distinct from actual_hash or f.expected_size is distinct from actual_size then raise exception 'BACKUP_FILE_HASH_MISMATCH';end if;update public.restore_files set status='ready' where id=f.id returning * into f;return to_jsonb(f);end $$;
revoke all on function public.complete_restore_file(uuid,uuid,text,bigint) from public,anon,authenticated;grant execute on function public.complete_restore_file(uuid,uuid,text,bigint) to service_role;
create policy recovery_upload on storage.objects for insert to authenticated with check(bucket_id='tenderdesk-private' and exists(select 1 from public.restore_files f join public.restore_sessions s on s.id=f.session_id where f.storage_key=name and f.status='pending' and s.state='staging' and s.expires_at>now() and f.created_by=auth.uid() and app_private.member_role(f.workspace_id)='Owner'));
alter table public.workspaces add column restore_origin jsonb;
create function public.commit_workspace_restore(restore_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
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
 update public.restore_sessions set state='committed',committed_at=now() where id=s.id;
 delete from app_private.restore_rows where session_id=s.id;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details) values(s.workspace_id,auth.uid(),'recovery.restored','workspace',s.workspace_id,jsonb_build_object('manifest_hash',s.manifest->>'root_hash','row_count',jsonb_array_length(s.manifest->'rows'),'file_count',jsonb_array_length(s.manifest->'files'),'permissions_reset',true));
 return jsonb_build_object('id',s.id,'state','committed','rows',jsonb_array_length(s.manifest->'rows'),'files',jsonb_array_length(s.manifest->'files'));
end $$;
revoke all on function public.commit_workspace_restore(uuid) from public,anon;grant execute on function public.commit_workspace_restore(uuid) to authenticated;
create function public.cancel_workspace_restore(restore_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$declare s public.restore_sessions;begin select * into s from public.restore_sessions where id=restore_id for update;if s.id is null or app_private.member_role(s.workspace_id) is distinct from 'Owner' or s.state='committed' then raise exception 'ROLE_FORBIDDEN';end if;update public.restore_sessions set state='canceled' where id=s.id;delete from app_private.restore_rows where session_id=s.id;return jsonb_build_object('id',s.id,'state','canceled');end $$;
revoke all on function public.cancel_workspace_restore(uuid) from public,anon;grant execute on function public.cancel_workspace_restore(uuid) to authenticated;
alter function app_private.app_command(text,jsonb,text) rename to procurement_command;
revoke all on function app_private.procurement_command(text,jsonb,text) from public,anon,authenticated,service_role;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$declare w uuid;begin
 select workspace_id into w from public.memberships where user_id=auth.uid() and app_private.member_role(workspace_id) is not null limit 1;
 if exists(select 1 from public.restore_sessions where workspace_id=w and state='staging') then raise exception 'RESTORE_IN_PROGRESS';end if;
 return app_private.procurement_command(operation,input,idempotency_key);
end $$;
revoke all on function app_private.app_command(text,jsonb,text) from public,anon;grant execute on function app_private.app_command(text,jsonb,text) to authenticated;

-- Expired historical reservations do not allocate new object capacity on restore.
create or replace function app_private.enforce_combined_storage_cap() returns trigger language plpgsql security definer set search_path='' as $$
declare used bigint;begin
 if new.status='expired' then return new;end if;
 perform 1 from public.workspaces where id=new.workspace_id for update;
 select (select coalesce(sum(expected_size),0) from public.documents where workspace_id=new.workspace_id and status<>'expired')+(select coalesce(sum(expected_size),0) from public.export_artifacts where workspace_id=new.workspace_id and status<>'expired') into used;
 if used+new.expected_size>262144000 then raise exception 'STORAGE_CAP_REACHED';end if;return new;
end $$;
