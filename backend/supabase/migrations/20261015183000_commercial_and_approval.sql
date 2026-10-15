create table public.rate_catalog (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),title text not null,unit text not null,currency text not null check(currency~'^[A-Z]{3}$'),unit_cost numeric(18,6) not null check(unit_cost>=0),zero_confirmed boolean not null default false,
 valid_from date not null,valid_until date not null,source_reference text not null,source text not null,content_hash text not null,public_approved boolean not null default false,approved boolean not null default false,approved_by uuid references auth.users(id),approved_at timestamptz,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id),check(valid_until>=valid_from),check(not approved or (public_approved and approved_by is not null and (unit_cost>0 or zero_confirmed)))
);
create table public.templates (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),title text not null,language text not null check(language in ('en','ar')),volume_mode text not null check(volume_mode in ('combined','separate')),required_sections jsonb not null check(jsonb_array_length(required_sections) between 1 and 40),fixed_blocks jsonb not null check(jsonb_array_length(fixed_blocks)<=20),style_config jsonb not null default '{}',content_hash text not null,
 approved boolean not null default false,approved_by uuid references auth.users(id),approved_at timestamptz,created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id),check(pg_column_size(required_sections)+pg_column_size(fixed_blocks)+pg_column_size(style_config)<=131072)
);
create table public.estimate_versions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),proposal_version_id uuid not null,ordinal integer not null,input jsonb not null check(pg_column_size(input)<=524288),input_hash text not null,evidence_revision bigint not null,
 status text not null default 'pending' check(status in ('pending','ready','approved')),calculated jsonb,rate_snapshot jsonb,content_hash text,currency text,direct_cost numeric(24,8),net_price numeric(24,8),tax numeric(24,8),gross_total numeric(24,8),approved_by uuid references auth.users(id),approved_at timestamptz,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id),unique(workspace_id,proposal_version_id,ordinal),foreign key(workspace_id,proposal_version_id) references public.proposal_versions(workspace_id,id)
);
create table public.estimate_lines (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),estimate_id uuid not null,line_key uuid not null,rate_id uuid not null,rate_revision integer not null,quantity numeric(18,6) not null,period_count numeric(18,6) not null,included_in_base boolean not null,charge_group text not null,tax_category text not null,direct_cost numeric(24,8) not null,net_price numeric(24,8) not null,tax numeric(24,8) not null,gross_total numeric(24,8) not null,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id),unique(workspace_id,estimate_id,line_key),foreign key(workspace_id,estimate_id) references public.estimate_versions(workspace_id,id),foreign key(workspace_id,rate_id) references public.rate_catalog(workspace_id,id)
);
create table public.delivery_versions (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),proposal_version_id uuid not null,ordinal integer not null,input jsonb not null check(pg_column_size(input)<=524288),input_hash text not null,evidence_revision bigint not null,
 status text not null default 'pending' check(status in ('pending','ready','approved')),calculated jsonb,content_hash text,approved_by uuid references auth.users(id),approved_at timestamptz,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id),unique(workspace_id,proposal_version_id,ordinal),foreign key(workspace_id,proposal_version_id) references public.proposal_versions(workspace_id,id)
);
create table public.delivery_tasks (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),delivery_id uuid not null,task_key text not null,title text not null,predecessors jsonb not null,role text not null,effort_days numeric(18,6) not null,allocation numeric(18,6) not null,duration_days numeric(18,6) not null,start_workday numeric(18,6) not null,end_workday numeric(18,6) not null,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id),unique(workspace_id,delivery_id,task_key),foreign key(workspace_id,delivery_id) references public.delivery_versions(workspace_id,id)
);
create table public.requirement_inventories (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),plan_id uuid not null,content_hash text not null,confirmed_by uuid not null references auth.users(id),confirmed_at timestamptz not null default now(),created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),revision integer not null default 1,
 unique(workspace_id,id),unique(workspace_id,plan_id),foreign key(workspace_id,plan_id) references public.generation_plans(workspace_id,id)
);
create table public.compliance_responses (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),proposal_version_id uuid not null,requirement_id uuid not null,status text not null check(status in ('answered','partial','missing','clarification_required','not_applicable_approved')),section_keys jsonb not null,evidence_refs jsonb not null,rationale text not null,confirmed_by uuid references auth.users(id),confirmed_at timestamptz,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id),unique(workspace_id,proposal_version_id,requirement_id),foreign key(workspace_id,proposal_version_id) references public.proposal_versions(workspace_id,id),foreign key(workspace_id,requirement_id) references public.requirements(workspace_id,id)
);
create table public.reviews (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),proposal_version_id uuid not null,verdict text not null check(verdict in ('recommend','changes_requested')),comment text not null,resolved_by uuid references auth.users(id),resolution text,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id),unique(workspace_id,proposal_version_id,created_by),foreign key(workspace_id,proposal_version_id) references public.proposal_versions(workspace_id,id)
);
create table public.approvals (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),proposal_version_id uuid not null,estimate_id uuid not null,delivery_id uuid not null,content_hash text not null,package_hash text not null,pricing_hash text not null,delivery_hash text not null,evidence_revision bigint not null,review_hash text not null,approved_by uuid not null references auth.users(id),invalidated_at timestamptz,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id),foreign key(workspace_id,proposal_version_id) references public.proposal_versions(workspace_id,id),foreign key(workspace_id,estimate_id) references public.estimate_versions(workspace_id,id),foreign key(workspace_id,delivery_id) references public.delivery_versions(workspace_id,id)
);
alter table public.questions add column answer_source text not null default '';
alter table public.proposal_sections add column company_claims jsonb not null default '[]';
do $$ declare t text;begin foreach t in array array['rate_catalog','templates','estimate_versions','estimate_lines','delivery_versions','delivery_tasks','requirement_inventories','compliance_responses','reviews','approvals'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);execute format('grant all on public.%I to service_role',t);execute format('create policy member_read on public.%I for select to authenticated using(app_private.member_role(workspace_id) is not null)',t);
end loop;end $$;
create view public.rate_records with(security_invoker=true) as select id,workspace_id,title,unit,currency,unit_cost::text,zero_confirmed,valid_from,valid_until,source_reference,source,content_hash,public_approved,approved,approved_by,approved_at,created_by,created_at,updated_at,revision from public.rate_catalog;
create view public.estimate_records with(security_invoker=true) as select id,workspace_id,proposal_version_id,ordinal,input,input_hash,evidence_revision,status,calculated,rate_snapshot,content_hash,currency,direct_cost::text,net_price::text,tax::text,gross_total::text,approved_by,approved_at,created_by,created_at,updated_at,revision from public.estimate_versions;
grant select on public.rate_records,public.estimate_records to authenticated,service_role;
create index estimate_version_parent on public.estimate_versions(workspace_id,proposal_version_id,ordinal);
create index delivery_version_parent on public.delivery_versions(workspace_id,proposal_version_id,ordinal);
create index approvals_version on public.approvals(workspace_id,proposal_version_id,created_at);
create trigger rate_evidence_changed after insert or update on public.rate_catalog for each row execute function app_private.invalidate_evidence();
create trigger template_evidence_changed after insert or update on public.templates for each row execute function app_private.invalidate_evidence();

create function app_private.rates_for_estimate(w uuid,payload jsonb) returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'revision',r.revision,'title',r.title,'unit',r.unit,'currency',r.currency,'unit_cost',r.unit_cost::text,'approved',r.approved,'zero_confirmed',r.zero_confirmed,'valid_from',r.valid_from,'valid_until',r.valid_until,'content_hash',r.content_hash) order by r.id),'[]') from public.rate_catalog r where r.workspace_id=w and r.id in (select (value->>'rate_id')::uuid from jsonb_array_elements(payload->'lines'))
$$;
revoke all on function app_private.rates_for_estimate(uuid,jsonb) from public,anon,authenticated;
create function public.calculation_context(record_id uuid,kind text) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;w uuid;payload jsonb;rates jsonb;
begin
 if kind='estimate' then select to_jsonb(e),workspace_id,input into result,w,payload from public.estimate_versions e where id=record_id;else if kind<>'delivery' then raise exception 'INVALID_KIND';end if;select to_jsonb(d),workspace_id,input into result,w,payload from public.delivery_versions d where id=record_id;end if;
 if w is null or coalesce(app_private.member_role(w),'') not in ('Owner','Editor') then raise exception 'NOT_FOUND';end if;
 rates:=case when kind='estimate' then app_private.rates_for_estimate(w,payload) else '[]'::jsonb end;
 return jsonb_build_object('record',result,'rates',rates,'rates_hash',encode(sha256(convert_to(rates::text,'UTF8')),'hex'));
end $$;
revoke all on function public.calculation_context(uuid,text) from public,anon;grant execute on function public.calculation_context(uuid,text) to authenticated;
create function public.complete_calculation(record_id uuid,kind text,actor_id uuid,input_hash text,rates_hash text,computed jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;rec jsonb;payload jsonb;rates jsonb;result jsonb;line jsonb;amount jsonb;digest text;
begin
 if kind='estimate' then select workspace_id into w from public.estimate_versions where id=record_id;elsif kind='delivery' then select workspace_id into w from public.delivery_versions where id=record_id;else raise exception 'INVALID_KIND';end if;
 perform 1 from public.workspaces where id=w for update;
 if not exists(select 1 from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=w and m.user_id=actor_id and m.active and m.role in ('Owner','Editor') and a.status='active') then raise exception 'ROLE_FORBIDDEN';end if;
 if kind='estimate' then select to_jsonb(e) into rec from public.estimate_versions e where id=record_id for update;else select to_jsonb(d) into rec from public.delivery_versions d where id=record_id for update;end if;
 if rec->>'input_hash'<>complete_calculation.input_hash or (rec->>'created_by')::uuid<>actor_id then raise exception 'STALE_INPUT';end if;
 if rec->>'status'<>'pending' then return rec;end if;
 if (rec->>'evidence_revision')::bigint<>(select evidence_revision from public.workspaces where id=w) or not exists(select 1 from public.proposals p where p.workspace_id=w and p.active_version_id=(rec->>'proposal_version_id')::uuid) then raise exception 'STALE_INPUT';end if;
 payload:=rec->'input';rates:=case when kind='estimate' then app_private.rates_for_estimate(w,payload) else '[]'::jsonb end;
 if encode(sha256(convert_to(rates::text,'UTF8')),'hex')<>rates_hash then raise exception 'STALE_INPUT';end if;
 if pg_column_size(computed)>524288 then raise exception 'PAYLOAD_TOO_LARGE';end if;
 digest:=encode(sha256(convert_to(jsonb_build_array(payload,computed,rates)::text,'UTF8')),'hex');
 if kind='estimate' then
 if computed->>'calculator_version'<>'decimal-v1' or jsonb_array_length(computed->'lines')<>jsonb_array_length(payload->'lines') then raise exception 'CALCULATION_INVALID';end if;
 update public.estimate_versions set status='ready',calculated=computed,rate_snapshot=rates,content_hash=digest,currency=payload->>'currency',direct_cost=(computed->>'direct_cost')::numeric,net_price=(computed->>'net_price')::numeric,tax=(computed->>'tax')::numeric,gross_total=(computed->>'gross_total')::numeric,revision=revision+1,updated_at=now() where id=record_id returning to_jsonb(estimate_versions.*) into result;
 for line in select value from jsonb_array_elements(payload->'lines') loop
 select value into amount from jsonb_array_elements(computed->'lines') where value->>'id'=line->>'id';if amount is null then raise exception 'CALCULATION_INVALID';end if;
 insert into public.estimate_lines(workspace_id,estimate_id,line_key,rate_id,rate_revision,quantity,period_count,included_in_base,charge_group,tax_category,direct_cost,net_price,tax,gross_total,created_by) values(w,record_id,(line->>'id')::uuid,(line->>'rate_id')::uuid,(amount->>'rate_revision')::int,(line->>'quantity')::numeric,(line->>'period_count')::numeric,(line->>'included_in_base')::boolean,line->>'charge_group',line->>'tax_category',(amount->>'direct_cost')::numeric,(amount->>'net_price')::numeric,(amount->>'tax')::numeric,(amount->>'gross_total')::numeric,actor_id);
 end loop;
 else
 if computed->>'calculator_version'<>'dependency-v1' or jsonb_array_length(computed->'tasks')<>jsonb_array_length(payload->'tasks') then raise exception 'CALCULATION_INVALID';end if;
 update public.delivery_versions set status='ready',calculated=computed,content_hash=digest,revision=revision+1,updated_at=now() where id=record_id returning to_jsonb(delivery_versions.*) into result;
 for line in select value from jsonb_array_elements(computed->'tasks') loop insert into public.delivery_tasks(workspace_id,delivery_id,task_key,title,predecessors,role,effort_days,allocation,duration_days,start_workday,end_workday,created_by) values(w,record_id,line->>'key',line->>'title',line->'predecessors',line->>'role',(line->>'effort_days')::numeric,(line->>'allocation')::numeric,(line->>'duration_days')::numeric,(line->>'start_workday')::numeric,(line->>'end_workday')::numeric,actor_id);end loop;
 end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,request_id) values(w,actor_id,kind||'.calculated',record_id,gen_random_uuid());return result;
end $$;
revoke all on function public.complete_calculation(uuid,text,uuid,text,text,jsonb) from public,anon,authenticated;grant execute on function public.complete_calculation(uuid,text,uuid,text,text,jsonb) to service_role;
create function app_private.invalidate_version_approval() returns trigger language plpgsql security definer set search_path='' as $$
declare v uuid:=new.proposal_version_id;
begin
 update public.approvals set invalidated_at=now(),revision=revision+1 where proposal_version_id=v and invalidated_at is null;
 update public.proposal_versions set status='draft',revision=revision+1,updated_at=now() where id=v and status='approved';
 update public.proposals set state='draft',revision=revision+1,updated_at=now() where active_version_id=v and state='approved';return new;
end $$;
revoke all on function app_private.invalidate_version_approval() from public,anon,authenticated;
create trigger estimate_invalidates after insert on public.estimate_versions for each row execute function app_private.invalidate_version_approval();
create trigger delivery_invalidates after insert on public.delivery_versions for each row execute function app_private.invalidate_version_approval();
create trigger question_resolution_invalidates after update of status,answer,answer_source on public.questions for each row execute function app_private.invalidate_version_approval();
create trigger compliance_invalidates after insert or update on public.compliance_responses for each row execute function app_private.invalidate_version_approval();
create trigger review_verdict_invalidates after insert or update on public.reviews for each row execute function app_private.invalidate_version_approval();
create function app_private.approval_gate(w uuid,version_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.proposal_versions;p public.proposals;e public.estimate_versions;d public.delivery_versions;errors jsonb:='[]';review_hash text;
begin
 select * into v from public.proposal_versions where workspace_id=w and id=version_id;select * into p from public.proposals where workspace_id=w and id=v.proposal_id;
 if v.id is null or p.active_version_id is distinct from version_id then raise exception 'STALE_INPUT';end if;
 if v.evidence_revision is distinct from (select evidence_revision from public.workspaces where id=w) then errors:=errors||'"Supporting evidence changed; regenerate the proposal."'::jsonb;end if;
 if exists(select 1 from public.proposal_sections where proposal_version_id=v.id and body like '%[INPUT REQUIRED%') then errors:=errors||'"Resolve all missing-input markers through a new version."'::jsonb;end if;
 if exists(select 1 from public.questions where proposal_version_id=v.id and blocking_level<>'advisory' and status not in ('resolved','not_applicable_with_reason')) then errors:=errors||'"Resolve the mandatory questions."'::jsonb;end if;
 if not exists(select 1 from public.requirement_inventories where plan_id=v.plan_id) then errors:=errors||'"Owner must confirm the complete requirement inventory."'::jsonb;end if;
 if exists(select 1 from public.requirements r left join public.compliance_responses c on c.proposal_version_id=v.id and c.requirement_id=r.id where r.plan_id=v.plan_id and r.mandatory and (c.id is null or c.status not in ('answered','not_applicable_approved') or c.confirmed_by is null)) then errors:=errors||'"Confirm coverage for every mandatory requirement."'::jsonb;end if;
 if exists(select 1 from public.reviews where proposal_version_id=v.id and verdict='changes_requested' and resolved_by is null) then errors:=errors||'"Resolve reviewer change requests."'::jsonb;end if;
 select * into e from public.estimate_versions where proposal_version_id=v.id order by ordinal desc limit 1;
 select * into d from public.delivery_versions where proposal_version_id=v.id order by ordinal desc limit 1;
 if e.id is null or e.status<>'approved' or e.evidence_revision is distinct from v.evidence_revision or (e.input->>'validity_date')::date<current_date then errors:=errors||'"Approve the latest complete, current financial estimate."'::jsonb;end if;
 if e.id is not null and exists(select 1 from public.estimate_lines l join public.rate_catalog r on r.id=l.rate_id where l.estimate_id=e.id and (not r.approved or r.valid_from>current_date or r.valid_until<current_date or r.revision<>l.rate_revision)) then errors:=errors||'"A rate is expired, changed or no longer approved."'::jsonb;end if;
 if exists(select 1 from public.generation_plans g,jsonb_array_elements(g.frozen_context->'knowledge') evidence join public.knowledge_items k on k.id=case when evidence.value->'reference'->>'entity_kind'='knowledge' then (evidence.value->'reference'->>'entity_id')::uuid else (select knowledge_item_id from public.documents where id=(evidence.value->'reference'->>'entity_id')::uuid) end where g.id=v.plan_id and evidence.value->>'kind'='company' and (not k.verified or not k.enabled or k.expiry_date<current_date)) then errors:=errors||'"Company evidence has expired or lost verification."'::jsonb;end if;
 if d.id is null or d.status<>'approved' or d.evidence_revision is distinct from v.evidence_revision then errors:=errors||'"Approve the latest current delivery plan."'::jsonb;end if;
 if v.separate_volumes and exists(select 1 from public.proposal_sections where proposal_version_id=v.id and volume<>'financial' and body~* '(\m(SAR|USD|AED|EUR)\M[[:space:]]*[0-9]|[0-9][[:digit:].,]*[[:space:]]*(ريال|دولار))') then errors:=errors||'"Remove prices from the technical volume."'::jsonb;end if;
 select encode(sha256(convert_to(jsonb_build_array(
 (select coalesce(jsonb_agg(to_jsonb(q) order by id),'[]') from public.questions q where proposal_version_id=v.id),
 (select coalesce(jsonb_agg(to_jsonb(c) order by id),'[]') from public.compliance_responses c where proposal_version_id=v.id),
 (select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.reviews r where proposal_version_id=v.id),
 (select coalesce(jsonb_agg(to_jsonb(i) order by id),'[]') from public.requirement_inventories i where plan_id=v.plan_id)
 )::text,'UTF8')),'hex') into review_hash;
 return jsonb_build_object('blockers',errors,'version_id',v.id,'content_hash',v.content_hash,'package_hash',v.package_hash,'estimate_id',e.id,'pricing_hash',e.content_hash,'delivery_id',d.id,'delivery_hash',d.content_hash,'evidence_revision',v.evidence_revision,'review_hash',review_hash);
end $$;
revoke all on function app_private.approval_gate(uuid,uuid) from public,anon,authenticated;
create function public.proposal_readiness(version_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;
begin select workspace_id into w from public.proposal_versions where id=version_id;if w is null or app_private.member_role(w) is null then raise exception 'NOT_FOUND';end if;return app_private.approval_gate(w,version_id);end $$;
revoke all on function public.proposal_readiness(uuid) from public,anon;grant execute on function public.proposal_readiness(uuid) to authenticated;

alter function app_private.app_command(text,jsonb,text) rename to generation_command;
revoke all on function app_private.generation_command(text,jsonb,text) from public,anon,authenticated,service_role;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare payload alias for $2;w uuid;actor uuid:=auth.uid();role text;h text;replay app_private.idempotency_records;target uuid;result jsonb;v public.proposal_versions;rate public.rate_catalog;template public.templates;item jsonb;ver integer;question public.questions;requirement public.requirements;gate jsonb;canonical jsonb;
begin
 if operation not in ('rate.save','rate.approve','template.save','template.approve','estimate.prepare','estimate.approve','delivery.prepare','delivery.approve','inventory.confirm','compliance.save','question.resolve','review.verdict','review.resolve','proposal.approve') then return app_private.generation_command(operation,payload,idempotency_key);end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;role:=app_private.member_role(w);
 if operation='review.verdict' then null;elsif operation in ('estimate.prepare','delivery.prepare') then if role not in ('Owner','Editor') then raise exception 'ROLE_FORBIDDEN';end if;else if role<>'Owner' then raise exception 'ROLE_FORBIDDEN';end if;end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(payload)>1048576 then raise exception 'INVALID_INPUT';end if;
 h:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then if replay.body_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 target:=coalesce((payload->>'id')::uuid,gen_random_uuid());
 case operation
 when 'rate.save' then
 perform app_private.check_keys(payload,array['id','expected_revision','title','unit','currency','unit_cost','zero_confirmed','valid_from','valid_until','source_reference','public_approved']);
 select * into rate from public.rate_catalog where workspace_id=w and id=target;
 if coalesce(rate.revision,0) is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 if payload->>'source_reference'~* '(confidential|سري للغاية|سرية|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})' then raise exception 'DATA_POLICY_BLOCKED';end if;
 canonical:=jsonb_build_object('title',payload->>'title','unit',payload->>'unit','currency',payload->>'currency','unit_cost',((payload->>'unit_cost')::numeric(18,6))::text,'valid_from',payload->>'valid_from','valid_until',payload->>'valid_until','source_reference',payload->>'source_reference');
 insert into public.rate_catalog(id,workspace_id,title,unit,currency,unit_cost,zero_confirmed,valid_from,valid_until,source_reference,source,content_hash,public_approved,created_by) values(target,w,payload->>'title',payload->>'unit',payload->>'currency',(payload->>'unit_cost')::numeric,(payload->>'zero_confirmed')::boolean,(payload->>'valid_from')::date,(payload->>'valid_until')::date,payload->>'source_reference',canonical::text,encode(sha256(convert_to(canonical::text,'UTF8')),'hex'),(payload->>'public_approved')::boolean,actor)
 on conflict(id) do update set title=excluded.title,unit=excluded.unit,currency=excluded.currency,unit_cost=excluded.unit_cost,zero_confirmed=excluded.zero_confirmed,valid_from=excluded.valid_from,valid_until=excluded.valid_until,source_reference=excluded.source_reference,source=excluded.source,content_hash=excluded.content_hash,public_approved=excluded.public_approved,approved=false,approved_by=null,approved_at=null,revision=rate_catalog.revision+1,updated_at=now() where rate_catalog.workspace_id=w returning to_jsonb(rate_catalog.*)||jsonb_build_object('unit_cost',unit_cost::text) into result;
 when 'rate.approve' then
 perform app_private.check_keys(payload,array['id','expected_revision']);update public.rate_catalog set approved=true,approved_by=actor,approved_at=now(),revision=revision+1,updated_at=now() where workspace_id=w and id=target and revision=(payload->>'expected_revision')::int and public_approved and valid_from<=current_date and valid_until>=current_date and (unit_cost>0 or zero_confirmed) returning to_jsonb(rate_catalog.*)||jsonb_build_object('unit_cost',unit_cost::text) into result;
 when 'template.save' then
 perform app_private.check_keys(payload,array['id','expected_revision','title','language','volume_mode','required_sections','fixed_blocks','style_config']);select * into template from public.templates where workspace_id=w and id=target;
 if coalesce(template.revision,0) is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 canonical:=payload-'id'-'expected_revision';insert into public.templates(id,workspace_id,title,language,volume_mode,required_sections,fixed_blocks,style_config,content_hash,created_by) values(target,w,payload->>'title',payload->>'language',payload->>'volume_mode',payload->'required_sections',payload->'fixed_blocks',payload->'style_config',encode(sha256(convert_to(canonical::text,'UTF8')),'hex'),actor)
 on conflict(id) do update set title=excluded.title,language=excluded.language,volume_mode=excluded.volume_mode,required_sections=excluded.required_sections,fixed_blocks=excluded.fixed_blocks,style_config=excluded.style_config,content_hash=excluded.content_hash,approved=false,approved_by=null,approved_at=null,revision=templates.revision+1,updated_at=now() where templates.workspace_id=w returning to_jsonb(templates.*) into result;
 when 'template.approve' then
 perform app_private.check_keys(payload,array['id','expected_revision']);update public.templates set approved=true,approved_by=actor,approved_at=now(),revision=revision+1,updated_at=now() where workspace_id=w and id=target and revision=(payload->>'expected_revision')::int returning to_jsonb(templates.*) into result;
 when 'estimate.prepare','delivery.prepare' then
 perform app_private.check_keys(payload,array['proposal_version_id','expected_revision','input']);select * into v from public.proposal_versions where workspace_id=w and id=(payload->>'proposal_version_id')::uuid;
 if v.id is null or v.revision is distinct from (payload->>'expected_revision')::int or not exists(select 1 from public.proposals where active_version_id=v.id) then raise exception 'REVISION_CONFLICT';end if;
 if v.evidence_revision is distinct from (select evidence_revision from public.workspaces where id=w) then raise exception 'STALE_INPUT';end if;
 if operation='estimate.prepare' then
 if jsonb_array_length(payload->'input'->'lines') not between 1 and 100 then raise exception 'INVALID_INPUT';end if;
 for item in select value from jsonb_array_elements(payload->'input'->'lines') loop
 if exists(select 1 from jsonb_array_elements_text(item->'requirement_ids') x where not exists(select 1 from public.requirements r where r.plan_id=v.plan_id and r.id::text=x.value)) or exists(select 1 from jsonb_array_elements_text(item->'section_ids') x where not exists(select 1 from public.proposal_sections s where s.proposal_version_id=v.id and s.section_key=x.value)) then raise exception 'INVALID_EVIDENCE_REFERENCE';end if;
 end loop;
 select coalesce(max(e.ordinal),0)+1 into ver from public.estimate_versions e where proposal_version_id=v.id;
 insert into public.estimate_versions(id,workspace_id,proposal_version_id,ordinal,input,input_hash,evidence_revision,created_by) values(target,w,v.id,ver,payload->'input',encode(sha256(convert_to((payload->'input')::text,'UTF8')),'hex'),v.evidence_revision,actor) returning to_jsonb(estimate_versions.*) into result;
 else
 if jsonb_array_length(payload->'input'->'tasks') not between 1 and 100 then raise exception 'INVALID_INPUT';end if;
 select coalesce(max(d.ordinal),0)+1 into ver from public.delivery_versions d where proposal_version_id=v.id;
 insert into public.delivery_versions(id,workspace_id,proposal_version_id,ordinal,input,input_hash,evidence_revision,created_by) values(target,w,v.id,ver,payload->'input',encode(sha256(convert_to((payload->'input')::text,'UTF8')),'hex'),v.evidence_revision,actor) returning to_jsonb(delivery_versions.*) into result;
 end if;
 when 'estimate.approve' then
 perform app_private.check_keys(payload,array['id','expected_revision']);update public.estimate_versions set status='approved',approved_by=actor,approved_at=now(),revision=revision+1,updated_at=now() where workspace_id=w and id=target and revision=(payload->>'expected_revision')::int and status='ready' and evidence_revision=(select evidence_revision from public.workspaces where id=w) and (estimate_versions.input->>'validity_date')::date>=current_date returning to_jsonb(estimate_versions.*) into result;
 when 'delivery.approve' then
 perform app_private.check_keys(payload,array['id','expected_revision']);update public.delivery_versions set status='approved',approved_by=actor,approved_at=now(),revision=revision+1,updated_at=now() where workspace_id=w and id=target and revision=(payload->>'expected_revision')::int and status='ready' and evidence_revision=(select evidence_revision from public.workspaces where id=w) returning to_jsonb(delivery_versions.*) into result;
 when 'inventory.confirm' then
 perform app_private.check_keys(payload,array['proposal_version_id','expected_revision']);select * into v from public.proposal_versions where workspace_id=w and id=(payload->>'proposal_version_id')::uuid;
 if v.id is null or v.revision is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 insert into public.requirement_inventories(workspace_id,plan_id,content_hash,confirmed_by,created_by) select w,v.plan_id,encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(r) order by id),'[]')::text,'UTF8')),'hex'),actor,actor from public.requirements r where plan_id=v.plan_id on conflict(workspace_id,plan_id) do update set confirmed_by=actor,confirmed_at=now(),revision=requirement_inventories.revision+1 returning to_jsonb(requirement_inventories.*) into result;
 when 'question.resolve' then
 perform app_private.check_keys(payload,array['id','expected_revision','status','answer','answer_source','reason']);select * into question from public.questions where workspace_id=w and id=target;
 if question.id is null or question.revision is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 if payload->>'status' not in ('resolved','not_applicable_with_reason') or length(trim(coalesce(payload->>'answer','')))=0 or length(trim(coalesce(payload->>'reason','')))<10 or length(trim(coalesce(payload->>'answer_source','')))=0 then raise exception 'RESOLUTION_EVIDENCE_REQUIRED';end if;
 update public.questions set status=payload->>'status',answer=payload->>'answer',answer_source=payload->>'answer_source',reason=payload->>'reason',resolved_by=actor,revision=revision+1,updated_at=now() where id=target returning to_jsonb(questions.*) into result;
 when 'compliance.save' then
 perform app_private.check_keys(payload,array['proposal_version_id','requirement_id','expected_revision','status','section_keys','evidence_refs','rationale']);select * into v from public.proposal_versions where workspace_id=w and id=(payload->>'proposal_version_id')::uuid;select * into requirement from public.requirements where workspace_id=w and id=(payload->>'requirement_id')::uuid and plan_id=v.plan_id;
 if requirement.id is null then raise exception 'NOT_FOUND';end if;
 select id,revision into target,ver from public.compliance_responses where proposal_version_id=v.id and requirement_id=requirement.id;
 if coalesce(ver,0) is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 if length(trim(coalesce(payload->>'rationale','')))<10 then raise exception 'REASON_REQUIRED';end if;
 if exists(select 1 from jsonb_array_elements_text(payload->'section_keys') x where not exists(select 1 from public.proposal_sections where proposal_version_id=v.id and section_key=x.value)) then raise exception 'INVALID_SECTION_REFERENCE';end if;
 if payload->>'status'='answered' and jsonb_array_length(payload->'section_keys')=0 then raise exception 'RESPONSE_LOCATION_REQUIRED';end if;
 if requirement.mandatory and requirement.category='eligibility' and payload->>'status'='not_applicable_approved' then raise exception 'MANDATORY_CREDENTIAL_CANNOT_BE_WAIVED';end if;
 if requirement.mandatory and requirement.category='eligibility' and payload->>'status'='answered' and jsonb_array_length(payload->'evidence_refs')=0 then raise exception 'VERIFIED_CREDENTIAL_EVIDENCE_REQUIRED';end if;
 for item in select value from jsonb_array_elements(payload->'evidence_refs') loop
 if not exists(select 1 from public.generation_plans g,jsonb_array_elements((g.frozen_context->'blocks')||(g.frozen_context->'knowledge')) e where g.id=v.plan_id and e.value->>'id'=item->>'id' and position(item->>'quote' in e.value->>'text')>0 and (not(requirement.mandatory and requirement.category='eligibility') or (e.value->>'kind'='company' and (e.value->>'verified')::boolean))) then raise exception 'INVALID_EVIDENCE_REFERENCE';end if;
 end loop;
 insert into public.compliance_responses(id,workspace_id,proposal_version_id,requirement_id,status,section_keys,evidence_refs,rationale,confirmed_by,confirmed_at,created_by) values(coalesce(target,gen_random_uuid()),w,v.id,requirement.id,payload->>'status',payload->'section_keys',payload->'evidence_refs',payload->>'rationale',actor,now(),actor) on conflict(workspace_id,proposal_version_id,requirement_id) do update set status=excluded.status,section_keys=excluded.section_keys,evidence_refs=excluded.evidence_refs,rationale=excluded.rationale,confirmed_by=actor,confirmed_at=now(),revision=compliance_responses.revision+1,updated_at=now() returning to_jsonb(compliance_responses.*) into result;
 when 'review.verdict' then
 perform app_private.check_keys(payload,array['proposal_version_id','expected_revision','verdict','comment']);select * into v from public.proposal_versions where workspace_id=w and id=(payload->>'proposal_version_id')::uuid;if v.id is null then raise exception 'NOT_FOUND';end if;
 select id,revision into target,ver from public.reviews where proposal_version_id=v.id and created_by=actor;if coalesce(ver,0) is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 insert into public.reviews(id,workspace_id,proposal_version_id,verdict,comment,created_by) values(coalesce(target,gen_random_uuid()),w,v.id,payload->>'verdict',payload->>'comment',actor) on conflict(workspace_id,proposal_version_id,created_by) do update set verdict=excluded.verdict,comment=excluded.comment,resolved_by=null,resolution=null,revision=reviews.revision+1,updated_at=now() returning to_jsonb(reviews.*) into result;
 when 'review.resolve' then
 perform app_private.check_keys(payload,array['id','expected_revision','reason']);if length(trim(coalesce(payload->>'reason','')))<10 then raise exception 'REASON_REQUIRED';end if;update public.reviews set resolved_by=actor,resolution=payload->>'reason',revision=revision+1,updated_at=now() where workspace_id=w and id=target and revision=(payload->>'expected_revision')::int returning to_jsonb(reviews.*) into result;
 when 'proposal.approve' then
 perform app_private.check_keys(payload,array['proposal_version_id','expected_revision','reason']);select * into v from public.proposal_versions where workspace_id=w and id=(payload->>'proposal_version_id')::uuid;if v.id is null or v.revision is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 if length(trim(coalesce(payload->>'reason','')))<10 then raise exception 'REASON_REQUIRED';end if;gate:=app_private.approval_gate(w,v.id);if jsonb_array_length(gate->'blockers')>0 then raise exception 'FINALIZATION_BLOCKED' using detail=gate::text;end if;
 insert into public.approvals(workspace_id,proposal_version_id,estimate_id,delivery_id,content_hash,package_hash,pricing_hash,delivery_hash,evidence_revision,review_hash,approved_by,created_by) values(w,v.id,(gate->>'estimate_id')::uuid,(gate->>'delivery_id')::uuid,v.content_hash,v.package_hash,gate->>'pricing_hash',gate->>'delivery_hash',v.evidence_revision,gate->>'review_hash',actor,actor) returning to_jsonb(approvals.*) into result;
 update public.proposal_versions set status='approved',pricing_hash=gate->>'pricing_hash',revision=revision+1,updated_at=now() where id=v.id;update public.proposals set state='approved',revision=revision+1,updated_at=now() where id=v.proposal_id;
 end case;
 if result is null then raise exception 'REVISION_CONFLICT';end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id) values(w,actor,operation,(result->>'id')::uuid,coalesce(payload->>'reason',''),gen_random_uuid());
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,h,result);return result;
end $$;
revoke all on function app_private.app_command(text,jsonb,text) from public,anon;grant execute on function app_private.app_command(text,jsonb,text) to authenticated;

create function app_private.invalidate_bound_approvals() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.approvals set invalidated_at=now(),revision=revision+1 where workspace_id=new.id and invalidated_at is null;
 return new;
end $$;
revoke all on function app_private.invalidate_bound_approvals() from public,anon,authenticated;
create trigger bound_approval_evidence after update of evidence_revision on public.workspaces for each row when(old.evidence_revision is distinct from new.evidence_revision) execute function app_private.invalidate_bound_approvals();

create or replace function public.eligibility_candidates(opportunity uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;items jsonb:='[]';rec record;
begin
 select m.workspace_id into w from public.memberships m where m.user_id=auth.uid() and app_private.member_role(m.workspace_id) is not null limit 1;if w is null then raise exception 'ACCESS_PENDING';end if;
 for rec in
 select 'document' kind,id from public.documents where workspace_id=w and status='ready' and not archived and (opportunity is null or opportunity_id=opportunity or documents.kind='company' or review_input_id in (select r.id from public.review_inputs r join public.proposals p on p.id=r.proposal_id where p.opportunity_id=opportunity))
 union all select 'knowledge',id from public.knowledge_items where workspace_id=w and enabled and length(content)>0
 union all select 'notice',id from public.opportunities where workspace_id=w and (opportunity is null or id=opportunity)
 union all select 'review',r.id from public.review_inputs r join public.proposals p on p.id=r.proposal_id where r.workspace_id=w and length(r.body)>0 and (opportunity is null or p.opportunity_id=opportunity)
 union all select 'rate',id from public.rate_catalog where workspace_id=w and approved
 loop items:=items||jsonb_build_array(app_private.content_record(w,rec.kind,rec.id));end loop;
 return jsonb_build_object('items',items,'authorizations',(select coalesce(jsonb_agg(to_jsonb(a)),'[]') from public.content_authorizations a where workspace_id=w and revoked_at is null));
end $$;
revoke all on function public.eligibility_candidates(uuid) from public,anon;grant execute on function public.eligibility_candidates(uuid) to authenticated;
