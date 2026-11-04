-- Delivery is an independent, immutable draft projection. It never advances
-- active_version_id, accepts a model candidate, settles usage, or grants approval.
create table public.proposal_delivery_snapshots (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.workspaces(id) deferrable initially immediate,
 opportunity_id uuid not null, proposal_id uuid not null, plan_id uuid, base_version_id uuid,
 ordinal integer not null check(ordinal>0),
 content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),
 source_manifest jsonb not null check(jsonb_typeof(source_manifest)='array'),
 payload jsonb not null check(jsonb_typeof(payload)='object' and pg_column_size(payload)<=8388608),
 created_by uuid not null, created_at timestamptz not null default now(),
 revision integer not null default 1 check(revision=1),
 unique(workspace_id,id), unique(workspace_id,proposal_id,id),
 unique(workspace_id,proposal_id,ordinal),
 unique nulls not distinct(workspace_id,proposal_id,plan_id,content_hash),
 foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,proposal_id) references public.proposals(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,plan_id) references public.generation_plans(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,base_version_id) references public.proposal_versions(workspace_id,id) deferrable initially immediate,
 foreign key(workspace_id,created_by) references public.workspace_actors(workspace_id,id) deferrable initially immediate,
 check(content_hash=encode(sha256(convert_to(payload::text,'UTF8')),'hex')),
 check(payload->'source_manifest'=source_manifest),
 check(payload->'version'='1'::jsonb and payload->'substantive_complete'='false'::jsonb and payload->>'approval_state'='draft')
);
create index proposal_delivery_recent on public.proposal_delivery_snapshots(workspace_id,proposal_id,ordinal desc);
alter table public.proposals add column active_delivery_snapshot_id uuid,
 add column delivery_revision integer not null default 0 check(delivery_revision>=0);
alter table public.proposals add constraint active_delivery_belongs_to_proposal
 foreign key(workspace_id,id,active_delivery_snapshot_id)
 references public.proposal_delivery_snapshots(workspace_id,proposal_id,id) deferrable initially immediate;

alter table public.proposal_delivery_snapshots enable row level security;
revoke all on public.proposal_delivery_snapshots from public,anon,authenticated;
grant all on public.proposal_delivery_snapshots to service_role;
-- Contents are read only through the current-source RPC. Direct reads expose
-- metadata only, so a stale source cannot bypass the RPC via the Data API.
grant select(id,workspace_id,opportunity_id,proposal_id,plan_id,base_version_id,ordinal,
 content_hash,created_by,created_at,revision) on public.proposal_delivery_snapshots to authenticated;
create policy member_metadata on public.proposal_delivery_snapshots for select to authenticated
 using(app_private.member_role(workspace_id) is not null);
create view public.proposal_delivery_records with(security_invoker=true) as
 select id,workspace_id,opportunity_id,proposal_id,plan_id,base_version_id,ordinal,
 content_hash,created_by,created_at,revision from public.proposal_delivery_snapshots;
revoke all on public.proposal_delivery_records from public,anon;
grant select on public.proposal_delivery_records to authenticated,service_role;

create function app_private.delivery_snapshot_immutable() returns trigger
language plpgsql set search_path='' as $$begin raise exception 'DELIVERY_SNAPSHOT_IMMUTABLE';end $$;
create trigger delivery_snapshot_immutable before update on public.proposal_delivery_snapshots
 for each row execute function app_private.delivery_snapshot_immutable();

create function app_private.delivery_actor(w uuid,actor uuid,write_access boolean default false)
returns void language plpgsql stable security definer set search_path='' as $$
begin
 if not exists(select 1 from public.memberships m join public.identity_allowlist a
  on a.workspace_id=m.workspace_id and a.user_id=m.user_id
  where m.workspace_id=w and m.user_id=actor and m.active and a.status='active'
   and (not write_access or m.role in ('Owner','Editor'))) then raise exception 'ROLE_FORBIDDEN';end if;
end $$;

-- Current local draft-read authority is separate from provider-processing
-- consent and original-upload attestation. Restore intentionally clears those
-- attestations; that alone does not remove the current Owner's right to read
-- restored originals. Historical units remain visibly legacy-reviewed/draft;
-- neither source freshness nor restored membership grants new assurance.
create function app_private.check_delivery_sources(w uuid,manifest jsonb)
returns void language plpgsql stable security definer set search_path='' as $$
declare ref jsonb;record jsonb;d public.documents;
begin
 if jsonb_typeof(manifest) is distinct from 'array' then raise exception 'INVALID_INPUT';end if;
 for ref in select value from jsonb_array_elements(manifest) loop
  if ref->>'entity_kind'='document' then
   select * into d from public.documents where workspace_id=w and id=(ref->>'entity_id')::uuid
    and not archived and status in ('ready','partial');
   if d.id is null then raise exception 'DELIVERY_SOURCE_UNAVAILABLE';end if;
   record:=jsonb_build_object('content_hash',d.extraction_hash,'content',d.extracted_text);
   if d.kind='company' and not exists(select 1 from public.knowledge_items k
    where k.workspace_id=w and k.id=d.knowledge_item_id and k.enabled
     and (k.expiry_date is null or k.expiry_date>=current_date)) then raise exception 'DELIVERY_SOURCE_UNAVAILABLE';end if;
  else
   if ref->>'entity_kind'='knowledge' and not exists(select 1 from public.knowledge_items k
    where k.workspace_id=w and k.id=(ref->>'entity_id')::uuid and k.enabled
     and (k.expiry_date is null or k.expiry_date>=current_date)) then raise exception 'DELIVERY_SOURCE_UNAVAILABLE';end if;
   if ref->>'entity_kind'='rate' and not exists(select 1 from public.rate_catalog r
    where r.workspace_id=w and r.id=(ref->>'entity_id')::uuid and r.approved and r.public_approved
     and current_date between r.valid_from and r.valid_until) then raise exception 'DELIVERY_SOURCE_UNAVAILABLE';end if;
   record:=app_private.content_record(w,ref->>'entity_kind',(ref->>'entity_id')::uuid);
  end if;
  if record->>'content_hash' is distinct from ref->>'content_hash' then raise exception 'STALE_INPUT';end if;
  perform app_private.assert_business_content(record->>'content');
 end loop;
end $$;

-- Unread documents have no extraction hash but their names and gaps are still
-- source-derived metadata; archiving one must also invalidate that read.
create function app_private.check_delivery_materials(w uuid,materials jsonb)
returns void language plpgsql stable security definer set search_path='' as $$
begin
 if exists(select 1 from jsonb_array_elements(coalesce(materials->'documents','[]')) item
  where not exists(select 1 from public.documents d where d.workspace_id=w
   and d.id=(item->>'document_id')::uuid and not d.archived)) then raise exception 'DELIVERY_SOURCE_UNAVAILABLE';end if;
end $$;

create function app_private.check_delivery_snapshot(snapshot public.proposal_delivery_snapshots,actor uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin
 if snapshot.id is null then raise exception 'NOT_FOUND';end if;
 perform app_private.delivery_actor(snapshot.workspace_id,actor);
 if not exists(select 1 from public.opportunities o where o.workspace_id=snapshot.workspace_id
  and o.id=snapshot.opportunity_id and not o.archived) then raise exception 'DELIVERY_SOURCE_UNAVAILABLE';end if;
 if exists(select 1 from public.restore_sessions where workspace_id=snapshot.workspace_id and state in ('staging','committing')) then raise exception 'RESTORE_IN_PROGRESS';end if;
 perform app_private.check_delivery_sources(snapshot.workspace_id,snapshot.source_manifest);
 perform app_private.check_delivery_materials(snapshot.workspace_id,snapshot.payload->'input_materials');
end $$;

create function public.delivery_context(snapshot_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare snapshot public.proposal_delivery_snapshots;
begin
 select * into snapshot from public.proposal_delivery_snapshots where id=snapshot_id;
 perform app_private.check_delivery_snapshot(snapshot,auth.uid());return to_jsonb(snapshot);
end $$;
create function public.delivery_context_for_actor(snapshot_id uuid,actor_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare snapshot public.proposal_delivery_snapshots;
begin
 select * into snapshot from public.proposal_delivery_snapshots where id=snapshot_id;
 perform app_private.check_delivery_snapshot(snapshot,actor_id);return to_jsonb(snapshot);
end $$;

-- A current, model-free source context for an explicitly requested template or
-- draft, including no-upload cases. No fictitious document/package is created.
create function app_private.delivery_input(w uuid,opp uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare o public.opportunities;notice jsonb;blocks jsonb;materials jsonb;template jsonb;
begin
 select * into o from public.opportunities where workspace_id=w and id=opp and not archived;
 if o.id is null then raise exception 'NOT_FOUND';end if;
 notice:=app_private.content_record(w,'notice',o.id);
 select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'text',b.text,'kind','rfp','document_id',d.id,
  'reference',jsonb_build_object('entity_kind','document','entity_id',d.id,'content_hash',d.extraction_hash))
  order by d.precedence,d.id,b.ordinal),'[]') into blocks
  from public.documents d join public.document_blocks b on b.workspace_id=d.workspace_id and b.document_id=d.id
  where d.workspace_id=w and d.opportunity_id=opp and d.kind='rfp' and not d.archived
   and d.status in ('ready','partial') and length(trim(b.text))>0;
 select jsonb_build_object('version',1,'documents',coalesce(jsonb_agg(jsonb_build_object(
  'document_id',d.id,'name',d.original_name,'status',d.status,
  'used_for_draft',d.status in ('ready','partial'),'extraction_coverage',to_jsonb(d)->'extraction_coverage') order by d.id),'[]'))
  into materials from public.documents d where d.workspace_id=w and d.opportunity_id=opp and d.kind='rfp' and not d.archived;
 select to_jsonb(t) into template from public.templates t where workspace_id=w and approved and language=o.language order by approved_at desc,id limit 1;
 return jsonb_build_object('language',o.language,'title',o.title,
  'notice',jsonb_build_object('id',o.id,'text',notice->>'content','kind','notice','reference',notice-'content'-'title'),
  'blocks',blocks,'knowledge','[]'::jsonb,'reviews','[]'::jsonb,'rates','[]'::jsonb,
  'template',coalesce(template,app_private.neutral_template(o.language)),'input_materials',materials);
end $$;

create function app_private.publish_delivery_snapshot(proposal uuid,plan uuid,actor uuid,intake_failure text default null)
returns public.proposal_delivery_snapshots language plpgsql security definer set search_path='' as $$
declare prop public.proposals;p public.generation_plans;ctx jsonb;sections jsonb:='[]';gaps jsonb:='[]';
 manifest jsonb:='[]';materials jsonb;source jsonb;required jsonb;section jsonb;block jsonb;pin jsonb;
 sources jsonb;provenance jsonb;payload jsonb;gap jsonb;source_ids jsonb;
 item record;thread app_private.model_graph_threads;result app_private.model_graph_results;
 snapshot public.proposal_delivery_snapshots;lang text;key text;label text;title text;digest text;
 available boolean:=false;partial boolean:=false;accepted integer:=0;next_ordinal integer;gap_index integer;
begin
 select * into prop from public.proposals where id=proposal;
 if prop.id is null then raise exception 'NOT_FOUND';end if;
 perform 1 from public.workspaces where id=prop.workspace_id for update;
 select * into prop from public.proposals where id=proposal for update;
 perform app_private.delivery_actor(prop.workspace_id,actor,true);
 if exists(select 1 from public.restore_sessions where workspace_id=prop.workspace_id and state in ('staging','committing')) then raise exception 'RESTORE_IN_PROGRESS';end if;
 if plan is not null then
  select * into p from public.generation_plans where workspace_id=prop.workspace_id and id=plan and proposal_id=prop.id and kind='proposal';
  if p.id is null then raise exception 'NOT_FOUND';end if;
  if p.status in ('failed','canceled') then raise exception 'GENERATION_NOT_ACTIVE';end if;
  -- Completion may have advanced the ordinary active version; early delivery
  -- never does. Active generation must remain tied to its original base.
  if p.status<>'completed' and p.base_version_id is distinct from prop.active_version_id then raise exception 'STALE_INPUT';end if;
  ctx:=p.frozen_context;
 else ctx:=app_private.delivery_input(prop.workspace_id,prop.opportunity_id);end if;
 lang:=coalesce(ctx->>'language',prop.language);materials:=coalesce(ctx->'input_materials','{}');
 if intake_failure is not null then
  if intake_failure not in ('EMPTY_FILE','INVALID_FILE','UNSUPPORTED_FORMAT','EXTRACTION_LIMIT','EXTRACTION_FAILED') then raise exception 'INVALID_INPUT';end if;
  materials:=materials||jsonb_build_object('intake_failure',intake_failure,'intake_failure_source','client_reported');
  partial:=true;
  gaps:=gaps||jsonb_build_array(jsonb_build_object('id','intake-failure','section_key','input-review','field_path','$.input_materials.intake_failure',
   'reason','UNREAD_INPUT','label',case when lang='ar' then 'تعذرت قراءة أحد الملفات المرسلة (' else 'One supplied file could not be read (' end||intake_failure||').',
   'required_for','substantive_completion','source_ids','[]'::jsonb));
 end if;
 if ctx#>'{notice,reference}' is not null then manifest:=jsonb_build_array(ctx#>'{notice,reference}');end if;
 available:=exists(select 1 from public.opportunities where id=prop.opportunity_id and length(trim(description))>0);
 for source in select value from jsonb_array_elements(coalesce(ctx->'blocks','[]')) loop
  if length(trim(coalesce(source->>'text','')))=0 or source->>'kind'='notice' then continue;end if;
  available:=true;manifest:=manifest||jsonb_build_array(source->'reference');
  sections:=sections||jsonb_build_array(jsonb_build_object('section_key','source-'||(source->>'id'),
   'title',case when lang='ar' then 'نص من المصدر — لم يُعتمد كاستجابة' else 'Source text — not an approved response' end,
   'volume','shared','kind','source_extract','content_blocks',jsonb_build_array(jsonb_build_object('type','paragraph','text',source->>'text')),
   'source_ids',jsonb_build_array(source#>>'{reference,entity_id}'),'provenance',jsonb_build_object('source_reference',source->'reference','block_id',source->>'id')));
 end loop;
 if available and ctx->'notice' is not null then
  sections:=jsonb_build_array(jsonb_build_object('section_key','source-notice','title',case when lang='ar' then 'معلومات الفرصة المتاحة' else 'Available opportunity information' end,
   'volume','shared','kind','source_extract','content_blocks',jsonb_build_array(jsonb_build_object('type','paragraph','text',ctx#>>'{notice,text}')),
   'source_ids',jsonb_build_array(prop.opportunity_id),'provenance',jsonb_build_object('source_reference',ctx#>'{notice,reference}')))||sections;
 end if;
 for source in select value from jsonb_array_elements(coalesce(materials->'documents','[]')) loop
  if source->'used_for_draft'='false'::jsonb or source->>'status'='partial' then
   partial:=true;key:='unread-'||(source->>'document_id');
   label:=case when lang='ar' then 'لم تُقرأ كل مواد هذا المستند. راجع الصفحات أو استكمل الاستخراج: ' else 'Not all material in this document was read. Review pages or complete extraction: ' end||coalesce(source->>'name','');
   gaps:=gaps||jsonb_build_array(jsonb_build_object('id',key,'section_key','input-review','field_path','$.input_materials.documents',
    'reason','UNREAD_INPUT','label',label,'required_for','substantive_completion','source_ids',jsonb_build_array(source->>'document_id')));
  end if;
 end loop;
 if p.id is not null then
  for item in select s.*,j.checkpoint from public.generation_steps s join public.jobs j on j.workspace_id=s.workspace_id and j.id=s.job_id
   where s.workspace_id=prop.workspace_id and s.plan_id=p.id and s.task='draft_section' and s.status='completed' order by s.ordinal loop
   select g.* into thread from app_private.model_graph_threads g join app_private.model_graph_results r on r.id=g.result_id
    where g.workspace_id=prop.workspace_id and g.job_id=item.job_id and g.status in ('accepted','committed') and r.value=item.output order by g.created_at desc limit 1;
   -- A modern result without its accepted graph is not an accepted content unit.
   if item.checkpoint->>'model_executor'='2' and thread.id is null then continue;end if;
   if jsonb_typeof(item.output->'content_blocks') is distinct from 'array' then continue;end if;
   accepted:=accepted+1;key:='accepted-'||item.id::text;
   select coalesce(jsonb_agg(jsonb_build_object('key',r.result_key,'hash',r.content_hash,'value',r.value) order by r.result_key),'[]') into pin
    from app_private.model_graph_results r where r.thread_id=thread.id and (r.result_key like 'semantic-instructions-%' or r.result_key like 'verification-instructions-%' or r.result_key like 'verification-format-%');
   select coalesce(jsonb_agg(jsonb_build_object('attempt_id',a.id,'provider',a.provider,'model',a.model,
    'operation',a.operation,'usage_id',a.usage_id,'execution_metadata',a.execution_metadata) order by a.id),'[]') into provenance
    from public.model_attempts a where a.workspace_id=prop.workspace_id and a.job_id=item.job_id and a.sent and a.status='succeeded';
   provenance:=jsonb_build_object('assurance','legacy_reviewed','step_id',item.id,'job_id',item.job_id,
    'step_revision',item.revision,'output_hash',encode(sha256(convert_to(item.output::text,'UTF8')),'hex'),
    'plan_input_hash',p.input_hash,'workflow_version',p.workflow_version,'original_unit',item.output,'graph_thread',thread.id,
    'accepted_result_id',thread.result_id,'pinned_instructions',pin,'producer_attempts',provenance);
   section:=jsonb_build_object('section_key',key,'title',coalesce(item.output->>'title',item.input#>>'{section,title}',case when lang='ar' then 'جزء محفوظ' else 'Saved section' end),
    'volume',case when coalesce(item.output->>'volume',item.input#>>'{section,volume}') in ('technical','financial','shared') then coalesce(item.output->>'volume',item.input#>>'{section,volume}') else 'technical' end,
    'kind','accepted_unit','content_blocks',item.output->'content_blocks','source_ids','[]'::jsonb,'provenance',provenance);
   sections:=sections||jsonb_build_array(section);
  end loop;
  if accepted>0 then
   for source in select value from jsonb_array_elements(coalesce(ctx->'knowledge','[]')||coalesce(ctx->'reviews','[]')||coalesce(ctx->'rates','[]')) loop
    if source->'reference' is not null then manifest:=manifest||jsonb_build_array(source->'reference');end if;
   end loop;
   gaps:=gaps||jsonb_build_array(jsonb_build_object('id','legacy-assurance','section_key','review','field_path','$.sections[*].provenance',
    'reason','LEGACY_ASSURANCE_REVIEW_REQUIRED','label',case when lang='ar' then 'الأجزاء المحفوظة تحمل مراجعتها الأصلية؛ لم تُعَد مراجعتها بمعايير جديدة. يلزم التحقق من العرض كاملًا قبل الاعتماد.' else 'Saved sections retain their original review. They have not passed a new assurance policy. Review the complete response before approval.' end,
    'required_for','final_approval','source_ids','[]'::jsonb));
  end if;
 end if;
 -- Every required response remains explicitly incomplete. Source extraction
 -- and historical candidate acceptance cannot establish substantive completion.
 for required in select value from jsonb_array_elements(coalesce(ctx#>'{template,required_sections}',app_private.neutral_template(lang)->'required_sections')) loop
  key:='response-'||(required->>'key');label:=case when lang='ar' then 'استكمل استجابة موثقة لهذا القسم: ' else 'Complete an evidence-backed response for this section: ' end||(required->>'title');
  gap:=jsonb_build_object('id',key,'section_key',key,'field_path','$.sections.'||key,
   'reason',case when available then 'RESPONSE_NOT_PREPARED' else 'INSUFFICIENT_INPUT' end,'label',label,
   'required_for','substantive_completion','source_ids','[]'::jsonb);
  gaps:=gaps||jsonb_build_array(gap);
  sections:=sections||jsonb_build_array(jsonb_build_object('section_key',key,'title',required->>'title',
   'volume',coalesce(required->>'volume','technical'),'kind','response','content_blocks',jsonb_build_array(jsonb_build_object('type','placeholder','gap_id',key)),
   'source_ids','[]'::jsonb,'provenance',null));
 end loop;
 select coalesce(jsonb_agg(ref order by ref->>'entity_kind',ref->>'entity_id'),'[]') into manifest
  from (select distinct jsonb_build_object('entity_kind',value->>'entity_kind','entity_id',value->>'entity_id','content_hash',value->>'content_hash') ref from jsonb_array_elements(manifest)) d;
 perform app_private.check_delivery_sources(prop.workspace_id,manifest);
 perform app_private.check_delivery_materials(prop.workspace_id,materials);
 payload:=jsonb_build_object('version',1,'title',prop.title,'language',lang,'template',coalesce(ctx->'template',app_private.neutral_template(lang)),
  'separate_volumes',coalesce(ctx#>>'{template,volume_mode}'='separate',false) or exists(select 1 from public.generation_steps where plan_id=p.id and task='analyze_chunk' and status='completed' and output->'separate_volumes'='true'::jsonb),
  'input_state',case when not available then 'insufficient' when partial then 'partial' else 'available' end,
  'content_state',case when accepted>0 then 'partial_draft' when available then 'source_draft' else 'template' end,
  'assurance_state',case when accepted>0 then 'legacy_reviewed' else 'unreviewed' end,'substantive_complete',false,'approval_state','draft',
  'notice',case when not available then case when lang='ar' then 'لا توجد معلومات نطاق كافية قابلة للاستخدام. هذا قالب، والمواضع الصفراء تحتاج إلى تعبئة.' else 'Insufficient usable scope information is available. This is a template; yellow fields require input.' end
   else case when lang='ar' then 'مسودة أولية من المصادر المتاحة والأجزاء المحفوظة. نصوص المصدر ليست استجابة مكتملة، والمواضع الصفراء تحتاج إلى استكمال ومراجعة.' else 'Initial draft from available sources and saved sections. Source extracts are not a complete response; yellow fields require completion and review.' end end,
  'source_manifest',manifest,'input_materials',materials,'sections',sections,'gaps',gaps);
 digest:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
 select * into snapshot from public.proposal_delivery_snapshots where workspace_id=prop.workspace_id and proposal_id=prop.id and plan_id is not distinct from p.id and content_hash=digest;
 if snapshot.id is not null then return snapshot;end if;
 select coalesce(max(ordinal),0)+1 into next_ordinal from public.proposal_delivery_snapshots where workspace_id=prop.workspace_id and proposal_id=prop.id;
 insert into public.proposal_delivery_snapshots(workspace_id,opportunity_id,proposal_id,plan_id,base_version_id,ordinal,content_hash,source_manifest,payload,created_by)
 values(prop.workspace_id,prop.opportunity_id,prop.id,p.id,case when p.id is null then prop.active_version_id else p.base_version_id end,next_ordinal,digest,manifest,payload,actor) returning * into snapshot;
 update public.proposals set active_delivery_snapshot_id=snapshot.id,delivery_revision=delivery_revision+1 where id=prop.id;
 insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,details)
 values(prop.workspace_id,actor,'delivery.snapshot.created','proposal_delivery_snapshot',snapshot.id,
  jsonb_build_object('proposal_id',prop.id,'plan_id',p.id,'content_hash',digest,'ordinal',next_ordinal,
   'content_state',payload->>'content_state','substantive_complete',false,'preserved_active_version',prop.active_version_id));
 return snapshot;
end $$;

create function app_private.publish_initial_delivery() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.kind='proposal' and new.proposal_id is not null and not exists(select 1 from public.restore_sessions where workspace_id=new.workspace_id and state='committing') then
  perform app_private.publish_delivery_snapshot(new.proposal_id,new.id,new.created_by);
 end if;return new;
end $$;
create trigger publish_initial_delivery after insert on public.generation_plans
 for each row execute function app_private.publish_initial_delivery();
create function app_private.publish_completed_delivery_unit() returns trigger
language plpgsql security definer set search_path='' as $$
declare p public.generation_plans;
begin
 if new.task<>'draft_section' or new.status<>'completed' or old.status='completed'
  or exists(select 1 from public.restore_sessions where workspace_id=new.workspace_id and state='committing') then return new;end if;
 select * into p from public.generation_plans where workspace_id=new.workspace_id and id=new.plan_id;
 if p.kind='proposal' then perform app_private.publish_delivery_snapshot(p.proposal_id,p.id,p.created_by);end if;
 return new;
end $$;
create trigger publish_completed_delivery_unit after update of status on public.generation_steps
 for each row execute function app_private.publish_completed_delivery_unit();

alter function app_private.app_command(text,jsonb,text) rename to app_command_before_delivery;
create function app_private.app_command(operation text,input jsonb,idempotency_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid:=auth.uid();o public.opportunities;prop public.proposals;p public.generation_plans;
 snapshot public.proposal_delivery_snapshots;replay app_private.idempotency_records;digest text;result jsonb;
begin
 if operation not in ('delivery.snapshot.prepare','delivery.snapshot.refresh') then return app_private.app_command_before_delivery(operation,input,idempotency_key);end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;
 perform app_private.delivery_actor(w,actor,true);perform 1 from public.workspaces where id=w for update;
 if exists(select 1 from public.restore_sessions where workspace_id=w and state in ('staging','committing')) then raise exception 'RESTORE_IN_PROGRESS';end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(input)>65536 then raise exception 'INVALID_INPUT';end if;
 digest:=encode(sha256(convert_to(input::text,'UTF8')),'hex');
 select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key and expires_at>now();
 if replay.key is not null then
  if replay.body_hash<>digest then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  select * into snapshot from public.proposal_delivery_snapshots where workspace_id=w and id=(replay.result->>'id')::uuid;
  perform app_private.check_delivery_snapshot(snapshot,actor);return replay.result;
 end if;
 if operation='delivery.snapshot.prepare' then
  perform app_private.check_keys(input,array['opportunity_id','expected_revision','intake_failure']);
  select * into o from public.opportunities where workspace_id=w and id=(input->>'opportunity_id')::uuid and not archived for update;
  if o.id is null or o.revision is distinct from (input->>'expected_revision')::integer then raise exception 'REVISION_CONFLICT';end if;
  if o.decision<>'shortlisted' then raise exception 'SHORTLIST_REQUIRED';end if;
  select * into prop from public.proposals where workspace_id=w and opportunity_id=o.id for update;
  if prop.id is null then insert into public.proposals(workspace_id,opportunity_id,title,language,state,created_by)
   values(w,o.id,o.title,o.language,'draft',actor) returning * into prop;end if;
  -- An existing proposal keeps its accepted siblings when the caller asks
  -- for a file again. Do not replace that progress with a source-only draft.
  select * into p from public.generation_plans where workspace_id=w and proposal_id=prop.id and kind='proposal'
   and status not in ('failed','canceled') order by created_at desc,id desc limit 1;
  snapshot:=app_private.publish_delivery_snapshot(prop.id,p.id,actor,input->>'intake_failure');
 else
  perform app_private.check_keys(input,array['proposal_id','expected_revision','expected_delivery_revision']);
  select * into prop from public.proposals where workspace_id=w and id=(input->>'proposal_id')::uuid for update;
  if prop.id is null or prop.revision is distinct from (input->>'expected_revision')::integer
   or prop.delivery_revision is distinct from (input->>'expected_delivery_revision')::integer then raise exception 'REVISION_CONFLICT';end if;
  select * into p from public.generation_plans where workspace_id=w and proposal_id=prop.id and kind='proposal'
   and status not in ('failed','canceled') order by created_at desc,id desc limit 1;
  snapshot:=app_private.publish_delivery_snapshot(prop.id,p.id,actor);
 end if;
 result:=to_jsonb(snapshot);
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,digest,result);
 return result;
end $$;

-- Recovery keeps the immutable payload/provenance and the separate pointer.
-- Deferred FKs permit restore ordering; restored plans are canceled and trigger
-- publication is skipped while committing. No model, approval or file appears.
alter function app_private.backup_tables() rename to backup_tables_before_delivery;
create function app_private.backup_tables() returns text[] language sql immutable set search_path='' as $$
 select app_private.backup_tables_before_delivery()||array['proposal_delivery_snapshots']::text[]
$$;
alter function app_private.purge_scope(uuid,uuid) rename to purge_scope_before_delivery;
create function app_private.purge_scope(w uuid,opp uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;part jsonb;
begin
 result:=app_private.purge_scope_before_delivery(w,opp);
 select jsonb_build_object('ids',coalesce(jsonb_agg(id order by id),'[]'),
  'hash',encode(sha256(convert_to(coalesce(string_agg(to_jsonb(s)::text,',' order by id),''),'UTF8')),'hex')) into part
 from public.proposal_delivery_snapshots s where workspace_id=w and opportunity_id=opp;
 return result||jsonb_build_object('proposal_delivery_snapshots',part);
end $$;

do $$ declare signature text;role_name text;begin
 foreach signature in array array[
  'app_private.delivery_snapshot_immutable()','app_private.delivery_actor(uuid,uuid,boolean)',
  'app_private.check_delivery_sources(uuid,jsonb)','app_private.check_delivery_materials(uuid,jsonb)','app_private.check_delivery_snapshot(public.proposal_delivery_snapshots,uuid)',
  'app_private.delivery_input(uuid,uuid)','app_private.publish_delivery_snapshot(uuid,uuid,uuid,text)',
  'app_private.publish_initial_delivery()','app_private.publish_completed_delivery_unit()',
  'app_private.app_command_before_delivery(text,jsonb,text)','app_private.backup_tables_before_delivery()',
  'app_private.backup_tables()','app_private.purge_scope_before_delivery(uuid,uuid)','app_private.purge_scope(uuid,uuid)',
  'public.delivery_context(uuid)','public.delivery_context_for_actor(uuid,uuid)'] loop
  execute 'revoke all on function '||signature||' from public';
  foreach role_name in array array['anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service'] loop
   if exists(select 1 from pg_roles where rolname=role_name) then execute 'revoke all on function '||signature||' from '||quote_ident(role_name);end if;
  end loop;
 end loop;
end $$;
revoke all on function app_private.app_command(text,jsonb,text) from public,anon;
grant execute on function app_private.app_command(text,jsonb,text),public.delivery_context(uuid) to authenticated;
grant execute on function public.delivery_context_for_actor(uuid,uuid) to service_role;
