-- M2 foundation. No demo identities, company claims, documents or provider keys.
create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 200),
  timezone text not null default 'Asia/Riyadh' check (timezone = 'Asia/Riyadh'),
  mode text not null default 'CONNECTED_FREE' check (mode = 'CONNECTED_FREE'),
  singleton boolean not null default true unique check (singleton),
  settings_version integer not null default 1 check (settings_version > 0),
  model_enabled boolean not null default false check (model_enabled = false),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  revision integer not null default 1 check (revision > 0)
);
create table public.memberships (
  workspace_id uuid not null references public.workspaces(id),
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('Owner','Editor','Reviewer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  revision integer not null default 1,
  primary key (workspace_id,user_id)
);
create table public.identity_allowlist (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id),
  provider text not null check (provider = 'github'),
  provider_user_id text not null,
  verified_email text not null,
  user_id uuid not null references auth.users(id),
  role text not null check (role in ('Owner','Editor','Reviewer')),
  status text not null default 'active' check (status in ('active','inactive')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision integer not null default 1,
  unique(workspace_id,provider,provider_user_id)
);
create or replace function app_private.member_role(w uuid) returns text
language sql stable security definer set search_path = '' as $$
  select m.role from public.memberships m
  join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id
  where m.workspace_id=w and m.user_id=auth.uid() and m.active and a.status='active' limit 1
$$;
create or replace function public.current_membership() returns table(workspace_id uuid,role text)
language sql stable security definer set search_path = '' as $$
  select m.workspace_id,m.role from public.memberships m
  where m.user_id=auth.uid() and app_private.member_role(m.workspace_id) is not null
$$;
revoke all on function public.current_membership() from public,anon;
grant execute on function public.current_membership() to authenticated;

create table public.sources (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null references public.workspaces(id),
  name text not null check(length(name) between 1 and 200),
  kind text not null check(kind in ('rss','json_feed','link_directory','manual')),
  url text check(url is null or length(url)<=2000),
  approved_hosts text[] not null default '{}',
  approval text not null default 'proposed' check(approval in ('proposed','approved','paused','rejected')),
  health text not null default 'unknown' check(health in ('unknown','healthy','unavailable','blocked','authentication_required','schema_changed')),
  poll_interval_hours integer not null default 6 check(poll_interval_hours between 1 and 168),
  next_due timestamptz, last_success_at timestamptz,
  policy_note text not null default '' check(length(policy_note)<=100000),
  adapter_config jsonb not null default '{}' check(jsonb_typeof(adapter_config)='object' and pg_column_size(adapter_config)<=65536),
  created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now(), revision integer not null default 1,
  unique(workspace_id,id)
);
create table public.opportunities (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
  source_id uuid not null, title text not null check(length(title) between 1 and 1000),
  description text not null default '' check(length(description)<=100000), buyer text not null default '' check(length(buyer)<=1000),
  reference text not null default '' check(length(reference)<=1000), canonical_url text,
  decision text not null default 'undecided' check(decision in ('undecided','shortlisted','deferred','declined')),
  deadline_raw text,deadline_at timestamptz,deadline_timezone text,
  language text not null default 'en' check(language in ('en','ar')),
  archived boolean not null default false,
  created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
  unique(workspace_id,id),foreign key(workspace_id,source_id) references public.sources(workspace_id,id)
);
create table public.knowledge_items (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
  category text not null check(category in ('capability','company','exclusion','rate','template','team','previous_proposal','other')),
  title text not null check(length(title) between 1 and 1000),content text not null default '' check(length(content)<=100000),
  verified boolean not null default false,verified_by uuid references auth.users(id),verified_at timestamptz,expiry_date date,
  enabled boolean not null default true,
  created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
  unique(workspace_id,id),check(not verified or (verified_by is not null and verified_at is not null))
);
create table public.proposals (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),opportunity_id uuid not null,
  title text not null check(length(title) between 1 and 1000),language text not null default 'en' check(language in ('en','ar')),
  state text not null default 'blocked' check(state in ('blocked','queued','generating','draft','in_review','changes_requested','approved')),
  active_version_id uuid,
  created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
  unique(workspace_id,id),unique(workspace_id,opportunity_id),foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id)
);
create table public.proposal_versions (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),proposal_id uuid not null,
  ordinal integer not null check(ordinal>0),content_hash text not null check(length(content_hash)=64),
  package_hash text,pricing_hash text,status text not null default 'draft' check(status in ('draft','in_review','approved','superseded')),
  created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
  unique(workspace_id,id),unique(workspace_id,proposal_id,id),unique(workspace_id,proposal_id,ordinal),
  foreign key(workspace_id,proposal_id) references public.proposals(workspace_id,id)
);
alter table public.proposals add constraint active_version_belongs_to_proposal foreign key(workspace_id,id,active_version_id) references public.proposal_versions(workspace_id,proposal_id,id);
create table public.proposal_sections (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),proposal_version_id uuid not null,
  section_key text not null check(length(section_key) between 1 and 200),title text not null check(length(title)<=1000),
  body text not null check(length(body)<=100000),ordinal integer not null check(ordinal>=0),evidence_refs jsonb not null default '[]' check(jsonb_typeof(evidence_refs)='array' and pg_column_size(evidence_refs)<=65536),
  created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
  unique(workspace_id,id),unique(workspace_id,proposal_version_id,section_key),foreign key(workspace_id,proposal_version_id) references public.proposal_versions(workspace_id,id)
);
create table public.questions (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),opportunity_id uuid not null,proposal_version_id uuid,
  question text not null check(length(question) between 1 and 100000),reason text not null default '' check(length(reason)<=100000),
  target_section_key text,blocking_level text not null default 'advisory' check(blocking_level in ('generation','finalization','advisory')),
  status text not null default 'open' check(status in ('open','answered_pending_review','resolved','not_applicable_with_reason')),
  answer text not null default '' check(length(answer)<=100000),resolved_by uuid references auth.users(id),
  created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
  unique(workspace_id,id),foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id),foreign key(workspace_id,proposal_version_id) references public.proposal_versions(workspace_id,id)
);
create table public.review_inputs (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),proposal_id uuid not null,base_version_id uuid not null,
  target_kind text not null check(target_kind in ('section','question','general')),target_id text not null check(length(target_id) between 1 and 200),
  body text not null default '' check(length(body)<=100000),source_signature text not null check(length(source_signature)<=1000),
  created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
  unique(workspace_id,id),unique(workspace_id,proposal_id,created_by,target_kind,target_id),
  foreign key(workspace_id,proposal_id) references public.proposals(workspace_id,id),foreign key(workspace_id,proposal_id,base_version_id) references public.proposal_versions(workspace_id,proposal_id,id)
);
create table public.documents (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
  opportunity_id uuid,knowledge_item_id uuid,review_input_id uuid,
  kind text not null check(kind in ('rfp','company','review','export')),
  original_name text not null check(length(original_name) between 1 and 1000),mime_type text not null,
  expected_size bigint not null check(expected_size between 1 and 10485760),original_hash text not null check(original_hash ~ '^[0-9a-f]{64}$'),
  storage_key text not null unique,status text not null default 'pending' check(status in ('pending','ready','needs_ocr','needs_processing','error','expired')),
  uploaded_size bigint check(uploaded_size between 1 and 10485760),expires_at timestamptz not null default(now()+interval '24 hours'),
  extracted_text text not null default '' check(length(extracted_text)<=1000000),
  created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
  unique(workspace_id,id),foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id),foreign key(workspace_id,knowledge_item_id) references public.knowledge_items(workspace_id,id),foreign key(workspace_id,review_input_id) references public.review_inputs(workspace_id,id),
  check((kind='rfp' and opportunity_id is not null and knowledge_item_id is null and review_input_id is null) or (kind='company' and knowledge_item_id is not null and opportunity_id is null and review_input_id is null) or (kind='review' and review_input_id is not null and opportunity_id is null and knowledge_item_id is null) or kind='export')
);
create table public.jobs (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),
  type text not null check(type in ('source_collect','source_candidates','classify_opportunity','analyze_chunk','consolidate_requirements','plan_proposal','draft_section','review_proposal','maintenance')),
  entity_id uuid not null,input_hash text not null,status text not null default 'blocked' check(status in ('queued','running','retry_wait','quota_wait','blocked','succeeded','failed','canceled')),
  attempts integer not null default 0 check(attempts>=0),next_attempt_at timestamptz not null default now(),lease_token uuid,lease_until timestamptz,
  cancel_requested boolean not null default false,error_code text,checkpoint jsonb not null default '{}' check(pg_column_size(checkpoint)<=65536),
  created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
  unique(workspace_id,id)
);
create unique index one_active_job_per_workspace on public.jobs(workspace_id) where status='running';
create table public.regeneration_requests (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),proposal_id uuid not null,base_version_id uuid not null,
  job_id uuid not null,review_snapshot jsonb not null check(jsonb_typeof(review_snapshot)='array' and pg_column_size(review_snapshot)<=1048576),
  created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
  unique(workspace_id,id),foreign key(workspace_id,proposal_id,base_version_id) references public.proposal_versions(workspace_id,proposal_id,id),foreign key(workspace_id,job_id) references public.jobs(workspace_id,id)
);
create table public.notifications (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),recipient_user_id uuid not null references auth.users(id),
  title text not null check(length(title)<=1000),body text not null check(length(body)<=100000),entity_id uuid,dedupe_key text not null,read_at timestamptz,
  created_by uuid references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
  unique(workspace_id,recipient_user_id,dedupe_key)
);
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),actor_id uuid not null references auth.users(id),
  action text not null,entity_id uuid,reason text not null default '',request_id uuid not null,
  created_at timestamptz not null default now()
);
create table public.operations (
  workspace_id uuid primary key references public.workspaces(id),last_heartbeat_at timestamptz,last_source_success_at timestamptz,
  scheduler_enabled boolean not null default false,last_error_code text
);
create table app_private.idempotency_records (
  workspace_id uuid not null references public.workspaces(id),actor_id uuid not null references auth.users(id),method text not null,route text not null,key text not null,
  body_hash text not null,result jsonb,expires_at timestamptz not null default(now()+interval '24 hours'),
  primary key(workspace_id,actor_id,method,route,key)
);

create index sources_due on public.sources(workspace_id,approval,next_due);
create index opportunities_status on public.opportunities(workspace_id,decision,id);
create index opportunities_deadline on public.opportunities(workspace_id,deadline_at,id);
create index jobs_due on public.jobs(workspace_id,status,next_attempt_at,id);
create index documents_target on public.documents(workspace_id,opportunity_id,review_input_id);
create index review_inputs_proposal on public.review_inputs(workspace_id,proposal_id,base_version_id);
create index audit_events_time on public.audit_events(workspace_id,created_at desc,id);

-- Reads are membership scoped. All business writes go through checked RPCs.
do $$ declare t text; begin
  foreach t in array array['workspaces','memberships','identity_allowlist','sources','opportunities','knowledge_items','proposals','proposal_versions','proposal_sections','questions','review_inputs','documents','jobs','regeneration_requests','notifications','audit_events','operations'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
    execute format('grant all on public.%I to service_role',t);
    if t='workspaces' then
      execute 'create policy member_read on public.workspaces for select to authenticated using(app_private.member_role(id) is not null)';
    elsif t='identity_allowlist' then
      execute 'create policy owner_read on public.identity_allowlist for select to authenticated using(app_private.member_role(workspace_id)=''Owner'')';
    elsif t='notifications' then
      execute 'create policy recipient_read on public.notifications for select to authenticated using(app_private.member_role(workspace_id) is not null and recipient_user_id=auth.uid())';
    elsif t='audit_events' then
      execute 'create policy audit_read on public.audit_events for select to authenticated using(app_private.member_role(workspace_id) is not null and (action not like ''membership.%'' or app_private.member_role(workspace_id)=''Owner''))';
    else
      execute format('create policy member_read on public.%I for select to authenticated using(app_private.member_role(workspace_id) is not null)',t);
    end if;
  end loop;
end $$;
grant usage on schema app_private to authenticated,service_role;
grant execute on function app_private.member_role(uuid) to authenticated,service_role;
revoke all on all tables in schema app_private from public,anon,authenticated;
revoke all on function app_private.member_role(uuid) from public,anon;

create or replace function public.bootstrap_workspace(owner_user_id uuid,workspace_name text) returns uuid
language plpgsql security definer set search_path='' as $$
declare w uuid; u auth.users; provider_identity text;
begin
  perform pg_advisory_xact_lock(1476521);
  if exists(select 1 from public.workspaces) then raise exception 'BOOTSTRAP_CLOSED'; end if;
  select * into u from auth.users where id=owner_user_id and email_confirmed_at is not null;
  if u.id is null then raise exception 'VERIFIED_USER_REQUIRED'; end if;
  select coalesce(identity_data->>'provider_id',identity_data->>'sub') into provider_identity from auth.identities where user_id=owner_user_id and provider='github' limit 1;
  if provider_identity is null then raise exception 'GITHUB_IDENTITY_REQUIRED'; end if;
  insert into public.workspaces(name,created_by) values(workspace_name,owner_user_id) returning id into w;
  insert into public.identity_allowlist(workspace_id,provider,provider_user_id,verified_email,user_id,role,created_by) values(w,'github',provider_identity,u.email,owner_user_id,'Owner',owner_user_id);
  insert into public.memberships(workspace_id,user_id,role,created_by) values(w,owner_user_id,'Owner',owner_user_id);
  insert into public.operations(workspace_id) values(w);
  insert into public.audit_events(workspace_id,actor_id,action,request_id) values(w,owner_user_id,'workspace.bootstrapped',gen_random_uuid());
  return w;
end $$;
revoke all on function public.bootstrap_workspace(uuid,text) from public,anon,authenticated;
grant execute on function public.bootstrap_workspace(uuid,text) to service_role;
