-- Durable public-page evidence for automatic source reading. No credentials or private files.
create table public.source_readings (
 job_id uuid primary key references public.jobs(id) on delete cascade,
 workspace_id uuid not null references public.workspaces(id),
 pending_url text not null,
 page jsonb,
 page_hash text,
 visited_urls jsonb not null default '[]',
 items jsonb not null default '[]',
 candidates jsonb not null default '[]',
 warnings jsonb not null default '[]',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(workspace_id,job_id) references public.jobs(workspace_id,id),
 check(page is null or pg_column_size(page)<=262144),
 check(jsonb_array_length(visited_urls)<=5),
 check(jsonb_array_length(items)<=100),
 check(jsonb_array_length(candidates)<=100)
);
create index source_readings_workspace on public.source_readings(workspace_id,job_id);
alter table public.source_readings enable row level security;
revoke all on public.source_readings from public,anon,authenticated;
grant select on public.source_readings to authenticated;
grant all on public.source_readings to service_role;
create policy member_read on public.source_readings for select to authenticated using(app_private.member_role(workspace_id) is not null);

create function public.auto_source_context(job_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;source jsonb;state public.source_readings;
begin
 select * into j from public.jobs where id=job_id;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 if j.type='source_candidates' and j.checkpoint ? 'discovery_url' then
  if not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=j.workspace_id and m.user_id=j.created_by and m.active and m.role='Owner' and a.status='active') then raise exception 'ROLE_FORBIDDEN';end if;
  source:=jsonb_build_object('id',j.entity_id,'url',j.checkpoint->>'discovery_url','kind','link_directory','approval','approved','policy_note','Owner requested public source discovery','approved_hosts','[]'::jsonb,'adapter_config',jsonb_build_object('automatic',true));
 else
  source:=public.collection_context(job_id,lease);
  if j.type<>'source_collect' or source->>'kind'<>'link_directory' then raise exception 'INVALID_INPUT';end if;
 end if;
 insert into public.source_readings(job_id,workspace_id,pending_url) values(j.id,j.workspace_id,source->>'url') on conflict do nothing;
 select * into state from public.source_readings where source_readings.job_id=j.id;
 update public.jobs set checkpoint=checkpoint||'{"automatic_reading":true}'::jsonb where id=j.id;
 return jsonb_build_object('source',source,'state',to_jsonb(state),'mode',case when j.type='source_candidates' then 'discover_sources' else 'collect_notices' end);
end $$;

create function public.save_source_page(job_id uuid,lease uuid,page jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;state public.source_readings;
begin
 ctx:=public.auto_source_context(job_id,lease);
 select * into state from public.source_readings where source_readings.job_id=save_source_page.job_id for update;
 if state.page is not null then return to_jsonb(state);end if;
 if page is null or page->>'requested_url' is distinct from state.pending_url or coalesce(page->>'url','')!~'^https://' or length(coalesce(page->>'text','')) not between 1 and 60000 or jsonb_typeof(page->'links') is distinct from 'array' or jsonb_array_length(page->'links')>200 or pg_column_size(page)>262144 then raise exception 'INVALID_INPUT';end if;
 update public.source_readings set page=save_source_page.page,page_hash=encode(sha256(convert_to(save_source_page.page::text,'UTF8')),'hex'),updated_at=now() where source_readings.job_id=save_source_page.job_id returning * into state;
 return to_jsonb(state);
end $$;

-- The saved processing policy covers public source-page evidence used to extract notices.
-- It never authorizes private company evidence or accepts a client-supplied page hash.
alter function app_private.check_model_payload(uuid,text,jsonb) rename to check_model_payload_before_sources;
do $$ declare definition text;begin
 select pg_get_functiondef('app_private.check_model_payload_before_sources(uuid,text,jsonb)'::regprocedure) into definition;
 execute replace(definition,'check_model_payload.provider','check_model_payload_before_sources.provider');
end $$;
revoke all on function app_private.check_model_payload_before_sources(uuid,text,jsonb) from public,anon,authenticated,service_role;
create function app_private.check_model_payload(w uuid,provider text,manifest jsonb) returns void language plpgsql security definer set search_path='' as $$
declare ref jsonb;state public.source_readings;j public.jobs;policy jsonb;
begin
 if jsonb_typeof(manifest) is distinct from 'array' or jsonb_array_length(manifest) not between 1 and 300 then raise exception 'DATA_AUTHORIZATION_REQUIRED';end if;
 for ref in select value from jsonb_array_elements(manifest) loop
  if ref->>'entity_kind'='source_page' then
   select * into state from public.source_readings where workspace_id=w and job_id=(ref->>'entity_id')::uuid;
   select * into j from public.jobs where id=state.job_id and workspace_id=w;
   if state.page_hash is null or state.page_hash is distinct from ref->>'content_hash' then raise exception 'STALE_INPUT';end if;
   perform public.auto_source_context(j.id,j.lease_token);
   select discovery_policy into policy from public.workspaces where id=w;
   if policy->'auto_public_notices' is distinct from 'true'::jsonb or not coalesce(policy->'providers' ? provider,false) then raise exception 'DATA_AUTHORIZATION_REQUIRED';end if;
   if not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=w and m.user_id=(policy->>'approved_by')::uuid and m.active and m.role='Owner' and a.status='active') then raise exception 'DATA_AUTHORIZATION_REQUIRED';end if;
   perform app_private.assert_business_content(state.page->>'text');
  else
   perform app_private.check_model_payload_before_sources(w,provider,jsonb_build_array(ref));
  end if;
 end loop;
end $$;
revoke all on function app_private.check_model_payload(uuid,text,jsonb) from public,anon,authenticated,service_role;

revoke all on function public.auto_source_context(uuid,uuid),public.save_source_page(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.auto_source_context(uuid,uuid),public.save_source_page(uuid,uuid,jsonb) to service_role;
