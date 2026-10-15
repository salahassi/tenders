create function app_private.neutral_template(lang text) returns jsonb language plpgsql security definer set search_path='' as $$
declare required jsonb;
begin
 if lang not in ('en','ar') then raise exception 'INVALID_LANGUAGE';end if;
 select jsonb_agg(jsonb_build_object('key',value->>'key','title',value->>lang,'purpose',value->>lang,'volume',value->>'volume','applicable',true,'rationale','')) into required from jsonb_array_elements('[{"key": "executive_summary", "en": "Executive summary", "ar": "الملخص التنفيذي", "volume": "technical"}, {"key": "understanding", "en": "Understanding of requirements", "ar": "فهم المتطلبات", "volume": "technical"}, {"key": "scope", "en": "Scope and exclusions", "ar": "النطاق والاستثناءات", "volume": "technical"}, {"key": "solution", "en": "Proposed solution", "ar": "الحل المقترح", "volume": "technical"}, {"key": "architecture", "en": "Architecture and components", "ar": "المعمارية والمكونات", "volume": "technical"}, {"key": "integration", "en": "Integrations and data flow", "ar": "التكامل وتدفق البيانات", "volume": "technical"}, {"key": "security", "en": "Security and access", "ar": "الأمن وإدارة الوصول", "volume": "technical"}, {"key": "methodology", "en": "Implementation methodology", "ar": "منهجية التنفيذ", "volume": "technical"}, {"key": "work_plan", "en": "Work plan and milestones", "ar": "خطة العمل والمراحل", "volume": "technical"}, {"key": "team", "en": "Team roles", "ar": "أدوار الفريق", "volume": "technical"}, {"key": "acceptance", "en": "Testing and acceptance", "ar": "الاختبار والقبول", "volume": "technical"}, {"key": "handover", "en": "Deployment and handover", "ar": "النشر والتسليم", "volume": "technical"}, {"key": "support", "en": "Support and warranty", "ar": "الدعم والضمان", "volume": "technical"}, {"key": "assumptions", "en": "Assumptions and dependencies", "ar": "الافتراضات والتبعيات", "volume": "technical"}, {"key": "experience", "en": "Company experience", "ar": "خبرات الشركة", "volume": "technical"}, {"key": "compliance", "en": "Compliance matrix", "ar": "مصفوفة الامتثال", "volume": "technical"}, {"key": "financial", "en": "Commercial proposal", "ar": "العرض المالي", "volume": "financial"}]'::jsonb);
 return jsonb_build_object('id','professional-v1','revision',1,'volume_mode','combined','required_sections',required,'fixed_blocks','[]'::jsonb,'style_config',jsonb_build_object('accent_color','#164b45','company_name','','footer',''));
end $$;
revoke all on function app_private.neutral_template(text) from public,anon,authenticated;
alter function app_private.generation_snapshot(uuid,uuid,uuid,uuid) rename to generation_snapshot_core;
revoke all on function app_private.generation_snapshot_core(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
create function app_private.generation_snapshot(w uuid,opp uuid,proposal uuid,package uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;chosen public.templates;required jsonb;lang text;
begin
 result:=app_private.generation_snapshot_core(w,opp,proposal,package);lang:=result->>'language';
 select * into chosen from public.templates where workspace_id=w and approved and language=lang order by approved_at desc,id limit 1;
 if chosen.id is not null then result:=jsonb_set(result,'{template}',to_jsonb(chosen));else
 result:=jsonb_set(result,'{template}',app_private.neutral_template(lang));
 end if;
 result:=result||jsonb_build_object('rates',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'text',r.source,'kind','rate','verified',true,'reference',jsonb_build_object('entity_kind','rate','entity_id',r.id,'content_hash',r.content_hash)) order by r.id) from public.rate_catalog r where r.workspace_id=w and r.approved and r.public_approved and r.valid_from<=current_date and r.valid_until>=current_date),'[]'));
 if pg_column_size(result)>8388608 then raise exception 'GENERATION_CONTEXT_CAP_REACHED';end if;return result;
end $$;
revoke all on function app_private.generation_snapshot(uuid,uuid,uuid,uuid) from public,anon,authenticated;
-- Bind the provider/model/project on the first reserved call, and preserve it for resumptions.
alter table public.generation_plans add column model_identity jsonb;
alter function public.model_preflight(uuid,uuid,jsonb) rename to model_preflight_core;
revoke all on function public.model_preflight_core(uuid,uuid,jsonb) from public,anon,authenticated,service_role;
create function public.model_preflight(job_id uuid,lease uuid,manifest jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare config jsonb;identity jsonb;
begin
 config:=public.model_preflight_core(job_id,lease,manifest);
 select p.model_identity into identity from public.generation_plans p join public.generation_steps s on s.plan_id=p.id where s.job_id=model_preflight.job_id;
 if identity is not null and identity<>jsonb_build_object('provider',config->>'provider','model',config->>'model','project_ref',config->>'project_ref') then raise exception 'MODEL_IDENTITY_CHANGED';end if;return config;
end $$;
revoke all on function public.model_preflight(uuid,uuid,jsonb) from public,anon,authenticated;grant execute on function public.model_preflight(uuid,uuid,jsonb) to service_role;
create or replace function app_private.generation_call_cap() returns trigger language plpgsql security definer set search_path='' as $$
declare plan uuid;identity jsonb;existing jsonb;
begin
 select s.plan_id into plan from public.generation_steps s where s.job_id=new.job_id;
 if plan is not null then
 if (select count(*) from public.provider_usage u join public.generation_steps s on s.job_id=u.job_id where s.plan_id=plan)>=300 then raise exception 'PLAN_CALL_CAP_REACHED';end if;
 select jsonb_build_object('provider',provider,'model',model,'project_ref',project_ref) into identity from public.model_settings where workspace_id=new.workspace_id;
 select model_identity into existing from public.generation_plans where id=plan;
 if existing is not null and existing<>identity then raise exception 'MODEL_IDENTITY_CHANGED';end if;
 update public.generation_plans set model_identity=identity where id=plan and model_identity is null;
 end if;return new;
end $$;
create function app_private.persist_section_claims() returns trigger language plpgsql security definer set search_path='' as $$
begin
 select coalesce((select s.output->'company_claims' from public.generation_steps s join public.proposal_versions v on v.plan_id=s.plan_id where v.id=new.proposal_version_id and s.task='draft_section' and s.status='completed' and s.input->'section'->>'key'=new.section_key limit 1),'[]') into new.company_claims;return new;
end $$;
revoke all on function app_private.persist_section_claims() from public,anon,authenticated;
create trigger preserve_company_claims before insert on public.proposal_sections for each row execute function app_private.persist_section_claims();

create function public.template_defaults(language text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.memberships m where m.user_id=auth.uid() and app_private.member_role(m.workspace_id) is not null) then raise exception 'ACCESS_PENDING';end if;
 return app_private.neutral_template(language);
end $$;
revoke all on function public.template_defaults(text) from public,anon;grant execute on function public.template_defaults(text) to authenticated;

create function app_private.validate_template() returns trigger language plpgsql security definer set search_path='' as $$
declare s jsonb;keys text[]:='{}';k text;
begin
 if jsonb_typeof(new.required_sections)<>'array' or jsonb_array_length(new.required_sections) not between 1 and 40 or jsonb_typeof(new.fixed_blocks)<>'array' or jsonb_array_length(new.fixed_blocks)>20 then raise exception 'INVALID_TEMPLATE';end if;
 for s in select value from jsonb_array_elements(new.required_sections||new.fixed_blocks) loop
 k:=s->>'key';if k is null or k!~'^[a-z0-9_-]{1,100}$' or k=any(keys) or length(trim(coalesce(s->>'title','')))=0 or coalesce(s->>'volume','') not in ('technical','financial','shared') then raise exception 'INVALID_TEMPLATE_SECTION';end if;keys:=array_append(keys,k);
 end loop;
 for s in select value from jsonb_array_elements(new.required_sections) loop
 if jsonb_typeof(s->'applicable') is distinct from 'boolean' or (not(s->>'applicable')::boolean and length(trim(coalesce(s->>'rationale','')))<10) then raise exception 'TEMPLATE_APPLICABILITY_REQUIRED';end if;
 end loop;
 for s in select value from jsonb_array_elements(new.fixed_blocks) loop if length(coalesce(s->>'body','')) not between 1 and 20000 then raise exception 'INVALID_FIXED_TEXT';end if;end loop;
 if pg_column_size(new.required_sections||new.fixed_blocks)>524288 then raise exception 'TEMPLATE_CAP_REACHED';end if;return new;
end $$;
revoke all on function app_private.validate_template() from public,anon,authenticated;
create trigger template_validation before insert or update on public.templates for each row execute function app_private.validate_template();
create function app_private.inventory_invalidates() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.approvals set invalidated_at=now(),revision=revision+1 where proposal_version_id in(select id from public.proposal_versions where plan_id=new.plan_id) and invalidated_at is null;
 update public.proposals set state='draft',revision=revision+1 where active_version_id in(select id from public.proposal_versions where plan_id=new.plan_id) and state='approved';
 update public.proposal_versions set status='draft',revision=revision+1 where plan_id=new.plan_id and status='approved';return new;
end $$;
revoke all on function app_private.inventory_invalidates() from public,anon,authenticated;
create trigger inventory_invalidates after insert or update on public.requirement_inventories for each row execute function app_private.inventory_invalidates();
