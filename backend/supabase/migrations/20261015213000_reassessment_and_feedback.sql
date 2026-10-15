alter table app_private.idempotency_records enable row level security;
-- Reassessment is queued only after deliberate model activation. Human decisions are never rewritten.
alter table public.opportunities add column assessment_pending boolean not null default false;
alter table public.jobs drop constraint jobs_type_check;
alter table public.jobs add constraint jobs_type_check check(type in ('source_collect','source_candidates','classify_opportunity','analyze_chunk','summarize_review','consolidate_requirements','plan_proposal','draft_section','plan_commercial','review_proposal','advance_plan','maintenance'));
create or replace function app_private.enqueue_generation(p public.generation_plans,task text,input jsonb,depth integer default 0) returns uuid language plpgsql security definer set search_path='' as $$
declare j uuid;ordinal integer;
begin
 if task not in ('classify_opportunity','analyze_chunk','summarize_review','plan_proposal','draft_section','plan_commercial','review_proposal','advance_plan') then raise exception 'INVALID_TASK';end if;
 select coalesce(max(s.ordinal),0)+1 into ordinal from public.generation_steps s where s.plan_id=p.id;
 if ordinal>300 then raise exception 'PLAN_JOB_CAP_REACHED';end if;
 if (select count(*) from public.jobs where workspace_id=p.workspace_id and status in ('queued','running','retry_wait','quota_wait','blocked'))>=500 then raise exception 'QUEUE_CAP_REACHED';end if;
 insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by) values(p.workspace_id,task,p.id,p.input_hash,'queued',p.created_by) returning id into j;
 insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,depth,created_by) values(p.workspace_id,p.id,j,task,p.stage,ordinal,input,depth,p.created_by);return j;
end $$;
create function app_private.enqueue_review_segments() returns trigger language plpgsql security definer set search_path='' as $$
declare r jsonb;start_at integer;total integer;
begin
 if new.kind<>'proposal' or new.status<>'queued' or exists(select 1 from public.restore_sessions where workspace_id=new.workspace_id and state='committing') then return new;end if;
 for r in select value from jsonb_array_elements(new.frozen_context->'reviews') loop
 total:=length(r->>'text');start_at:=0;
 while start_at<total loop perform app_private.enqueue_generation(new,'summarize_review',jsonb_build_object('review_id',r->>'id','start',start_at,'end',least(total,start_at+6000)));start_at:=start_at+5800;end loop;
 end loop;return new;
end $$;
revoke all on function app_private.enqueue_review_segments() from public,anon,authenticated;
create trigger enqueue_review_segments after insert on public.generation_plans for each row execute function app_private.enqueue_review_segments();
drop trigger new_notice_assessment on public.opportunities;
create or replace function app_private.schedule_notice_assessment() returns trigger language plpgsql security definer set search_path='' as $$begin update public.opportunities set assessment_pending=true where id=new.id;return new;end $$;
create trigger new_notice_assessment after insert on public.opportunities for each row execute function app_private.schedule_notice_assessment();
create trigger changed_notice_assessment after update of title,description,buyer,reference,language,deadline_raw on public.opportunities for each row when (old.title is distinct from new.title or old.description is distinct from new.description or old.buyer is distinct from new.buyer or old.reference is distinct from new.reference or old.language is distinct from new.language or old.deadline_raw is distinct from new.deadline_raw) execute function app_private.schedule_notice_assessment();
create function app_private.queue_profile_reassessment() returns trigger language plpgsql security definer set search_path='' as $$begin
 if TG_OP='UPDATE' and to_jsonb(new)-'revision'-'updated_at'=to_jsonb(old)-'revision'-'updated_at' then return new;end if;
 if TG_TABLE_NAME='documents' then if new.kind<>'company' then return new;end if;end if;
 update public.opportunities set assessment_pending=true where workspace_id=new.workspace_id and not archived;return new;
end $$;
revoke all on function app_private.queue_profile_reassessment() from public,anon,authenticated;
create trigger knowledge_reassessment after insert or update on public.knowledge_items for each row execute function app_private.queue_profile_reassessment();
create trigger company_document_reassessment after insert or update on public.documents for each row execute function app_private.queue_profile_reassessment();
create trigger model_policy_reassessment after insert or update of enabled,provider,model on public.model_settings for each row execute function app_private.queue_profile_reassessment();
create function public.schedule_assessment_refresh() returns jsonb language plpgsql security definer set search_path='' as $$
declare w uuid;actor uuid;o public.opportunities;p public.generation_plans;context jsonb;version bigint;n integer:=0;
begin
 select id,evidence_revision into w,version from public.workspaces limit 1;if w is null then return jsonb_build_object('scheduled',0);end if;
 perform 1 from public.workspaces where id=w for update;
 if not exists(select 1 from public.model_settings where workspace_id=w and enabled) or exists(select 1 from public.restore_sessions where workspace_id=w and state='staging') then return jsonb_build_object('scheduled',0);end if;
 select m.user_id into actor from public.memberships m join public.identity_allowlist a on a.workspace_id=m.workspace_id and a.user_id=m.user_id where m.workspace_id=w and m.active and m.role='Owner' and a.status='active' order by m.created_at limit 1;
 if actor is null then return jsonb_build_object('scheduled',0);end if;
 update public.opportunities pending_opp set assessment_pending=true where pending_opp.workspace_id=w and not pending_opp.archived and exists(select 1 from public.generation_plans active_plan where active_plan.opportunity_id=pending_opp.id and active_plan.kind='assessment' and active_plan.status in ('queued','running','blocked') and active_plan.evidence_revision<>version);
 for o in select * from public.opportunities where workspace_id=w and assessment_pending and not archived order by updated_at,id limit 20 loop
 if (select count(*) from public.jobs where workspace_id=w and status in ('queued','running','retry_wait','quota_wait','blocked'))>=480 then exit;end if;
 if exists(select 1 from public.generation_plans where opportunity_id=o.id and kind='assessment' and status in ('queued','running','blocked') and evidence_revision=version) then update public.opportunities set assessment_pending=false where id=o.id;continue;end if;
 update public.jobs set cancel_requested=true,status=case when status='running' then status else 'canceled' end,revision=revision+1,updated_at=now() where entity_id in(select id from public.generation_plans where opportunity_id=o.id and kind='assessment' and status in ('queued','running','blocked')) and status not in ('succeeded','failed','canceled');
 update public.generation_plans set status='canceled',error_code='REASSESSMENT_SUPERSEDED',revision=revision+1,updated_at=now() where opportunity_id=o.id and kind='assessment' and status in ('queued','running','blocked');
 begin
 context:=app_private.generation_snapshot(w,o.id,null,null);
 insert into public.generation_plans(workspace_id,opportunity_id,kind,stage,evidence_revision,input_hash,frozen_context,created_by) values(w,o.id,'assessment','assessment',version,encode(sha256(convert_to(context::text,'UTF8')),'hex'),context,actor) returning * into p;
 perform app_private.enqueue_generation(p,'classify_opportunity','{}');n:=n+1;
 exception when check_violation or raise_exception then perform app_private.notify_members(w,'assessment-blocked:'||o.id||':'||version,'Assessment needs attention','The evidence exceeds the generation boundary. Review the company profile and request assessment again.',o.id,actor);
 end;
 update public.opportunities set assessment_pending=false where id=o.id;
 end loop;return jsonb_build_object('scheduled',n);
end $$;
revoke all on function public.schedule_assessment_refresh() from public,anon,authenticated;grant execute on function public.schedule_assessment_refresh() to service_role;
-- Existing records are assessed when the Owner deliberately activates a model.
update public.opportunities set assessment_pending=true where not archived;
