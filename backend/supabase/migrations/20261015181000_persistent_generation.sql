-- Persistent bounded execution. The active proposal version moves only on complete review.
alter table public.jobs drop constraint jobs_type_check;
alter table public.jobs add constraint jobs_type_check check(type in ('source_collect','source_candidates','classify_opportunity','analyze_chunk','consolidate_requirements','plan_proposal','draft_section','plan_commercial','review_proposal','advance_plan','maintenance'));
create table public.generation_plans (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),opportunity_id uuid not null,proposal_id uuid,base_version_id uuid,package_id uuid,
 kind text not null check(kind in ('assessment','proposal')),stage text not null default 'analysis' check(stage in ('assessment','analysis','planning','drafting','commercial','review','completed')),
 status text not null default 'queued' check(status in ('queued','running','blocked','completed','failed','canceled')),evidence_revision bigint not null,input_hash text not null,
 frozen_context jsonb not null check(pg_column_size(frozen_context)<=8388608),error_code text,created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
 unique(workspace_id,id),foreign key(workspace_id,opportunity_id) references public.opportunities(workspace_id,id),foreign key(workspace_id,proposal_id) references public.proposals(workspace_id,id),foreign key(workspace_id,package_id) references public.document_packages(workspace_id,id)
);
create unique index one_open_generation on public.generation_plans(workspace_id,opportunity_id,kind) where status in ('queued','running','blocked');
create table public.generation_steps (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),plan_id uuid not null,job_id uuid not null,
 task text not null,stage text not null,ordinal integer not null,input jsonb not null check(pg_column_size(input)<=65536),output jsonb check(pg_column_size(output)<=1048576),
 status text not null default 'queued' check(status in ('queued','completed','split')),depth integer not null default 0 check(depth between 0 and 8),repair_count integer not null default 0 check(repair_count between 0 and 1),
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),revision integer not null default 1,
 unique(workspace_id,id),unique(workspace_id,job_id),unique(workspace_id,plan_id,ordinal),foreign key(workspace_id,plan_id) references public.generation_plans(workspace_id,id),foreign key(workspace_id,job_id) references public.jobs(workspace_id,id)
);
create table public.requirements (
 id uuid primary key,workspace_id uuid not null references public.workspaces(id),plan_id uuid not null,opportunity_id uuid not null,text text not null,category text not null,mandatory boolean not null,source_refs jsonb not null,interpretation text not null,acceptance_evidence text not null,owner_question text,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id),foreign key(workspace_id,plan_id) references public.generation_plans(workspace_id,id)
);
create table public.fit_assessments (
 id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id),opportunity_id uuid not null,plan_id uuid not null,fit_score integer check(fit_score between 0 and 100),evidence_coverage integer not null check(evidence_coverage between 0 and 100),routing text not null check(routing in ('recommended','needs_review','low_fit','excluded')),result jsonb not null,input_hash text not null,evidence_revision bigint not null,
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),revision integer not null default 1,unique(workspace_id,id),foreign key(workspace_id,plan_id) references public.generation_plans(workspace_id,id)
);
alter table public.proposal_versions add column plan_id uuid references public.generation_plans(id);
alter table public.proposal_versions add column evidence_revision bigint;
alter table public.proposal_versions add column review_result jsonb;
alter table public.proposal_versions add column commercial_draft jsonb;
alter table public.proposal_versions add column separate_volumes boolean not null default false;
alter table public.proposal_sections add column content_blocks jsonb not null default '[]';
alter table public.proposal_sections add column requirement_ids jsonb not null default '[]';
alter table public.proposal_sections add column volume text not null default 'technical' check(volume in ('technical','financial','shared'));
alter table public.proposal_sections add column fixed boolean not null default false;
create index generation_plan_opportunity on public.generation_plans(workspace_id,opportunity_id,created_at);
create index generation_steps_plan on public.generation_steps(workspace_id,plan_id,stage,ordinal);
create index requirements_plan on public.requirements(workspace_id,plan_id);
create index assessments_opportunity on public.fit_assessments(workspace_id,opportunity_id,created_at);
do $$ declare t text;begin foreach t in array array['generation_plans','generation_steps','requirements','fit_assessments'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);execute format('grant all on public.%I to service_role',t);execute format('create policy member_read on public.%I for select to authenticated using(app_private.member_role(workspace_id) is not null)',t);
end loop;end $$;

create function app_private.enqueue_generation(p public.generation_plans,task text,input jsonb,depth integer default 0) returns uuid language plpgsql security definer set search_path='' as $$
declare j uuid;ordinal integer;
begin
 if task not in ('classify_opportunity','analyze_chunk','plan_proposal','draft_section','plan_commercial','review_proposal','advance_plan') then raise exception 'INVALID_TASK';end if;
 select coalesce(max(s.ordinal),0)+1 into ordinal from public.generation_steps s where s.plan_id=p.id;
 if ordinal>300 then raise exception 'PLAN_JOB_CAP_REACHED';end if;
 if (select count(*) from public.jobs where workspace_id=p.workspace_id and status in ('queued','running','retry_wait','quota_wait','blocked'))>=500 then raise exception 'QUEUE_CAP_REACHED';end if;
 insert into public.jobs(workspace_id,type,entity_id,input_hash,status,created_by) values(p.workspace_id,task,p.id,p.input_hash,'queued',p.created_by) returning id into j;
 insert into public.generation_steps(workspace_id,plan_id,job_id,task,stage,ordinal,input,depth,created_by) values(p.workspace_id,p.id,j,task,p.stage,ordinal,input,depth,p.created_by);return j;
end $$;
revoke all on function app_private.enqueue_generation(public.generation_plans,text,jsonb,integer) from public,anon,authenticated;

create function app_private.generation_snapshot(w uuid,opp uuid,proposal uuid,package uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;knowledge jsonb:='[]';reviews jsonb:='[]';rec record;content jsonb;
begin
 for rec in select k.* from public.knowledge_items k where workspace_id=w and enabled and (expiry_date is null or expiry_date>=current_date) and (verified_at is not null or category='previous_proposal') and category not in ('template','rate') order by id loop
 if length(rec.content)>0 then
 content:=app_private.content_record(w,'knowledge',rec.id);
 knowledge:=knowledge||jsonb_build_array(jsonb_build_object('id',rec.id,'text',content->>'content','kind',case when rec.category='previous_proposal' then 'style' else 'company' end,'category',rec.category,'verified',rec.verified_at is not null,'reference',content-'content'-'title'));
 end if;
 end loop;
 for rec in select d.*,k.category,k.verified_at from public.documents d join public.knowledge_items k on k.id=d.knowledge_item_id and k.workspace_id=d.workspace_id where d.workspace_id=w and d.kind='company' and not d.archived and d.status='ready' and k.enabled and (k.expiry_date is null or k.expiry_date>=current_date) and (k.verified_at is not null or k.category='previous_proposal') and k.category not in ('template','rate') order by d.id loop
 knowledge:=knowledge||coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'text',b.text,'kind',case when rec.category='previous_proposal' then 'style' else 'company' end,'category',rec.category,'verified',rec.verified_at is not null,'reference',jsonb_build_object('entity_kind','document','entity_id',rec.id,'content_hash',rec.extraction_hash))) from public.document_blocks b where b.document_id=rec.id),'[]');
 end loop;
 if proposal is not null then
 for rec in select r.* from public.review_inputs r join public.proposals p on p.id=r.proposal_id and p.active_version_id=r.base_version_id where r.workspace_id=w and r.proposal_id=proposal order by r.id loop
 if length(rec.body)>0 then content:=app_private.content_record(w,'review',rec.id);reviews:=reviews||jsonb_build_array(jsonb_build_object('id',rec.id,'text',rec.body,'kind','review','verified',false,'target_kind',rec.target_kind,'target_id',rec.target_id,'reference',content-'content'-'title'));end if;
 if exists(select 1 from public.documents d where d.review_input_id=rec.id and not d.archived and d.status not in ('ready','expired')) then raise exception 'REVIEW_ATTACHMENT_UNREADABLE';end if;
 reviews:=reviews||coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'text',b.text,'kind','review','verified',false,'target_kind',rec.target_kind,'target_id',rec.target_id,'reference',jsonb_build_object('entity_kind','document','entity_id',d.id,'content_hash',d.extraction_hash))) from public.documents d join public.document_blocks b on b.document_id=d.id where d.review_input_id=rec.id and not d.archived and d.status='ready'),'[]');
 end loop;end if;
 content:=app_private.content_record(w,'notice',opp);
 select jsonb_build_object('notice',jsonb_build_object('id',opp,'text',content->>'content','kind','notice','verified',false,'reference',content-'content'-'title'),'language',o.language,'title',o.title,'knowledge',knowledge,'reviews',reviews,'blocks',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'text',b.text,'kind','rfp','verified',false,'document_id',d.id,'locator',b.locator,'precedence',d.precedence,'supersedes_id',d.supersedes_id,'reference',jsonb_build_object('entity_kind','document','entity_id',d.id,'content_hash',d.extraction_hash)) order by d.precedence,d.id,b.ordinal) from public.documents d join public.document_blocks b on b.document_id=d.id where d.workspace_id=w and d.opportunity_id=opp and d.kind='rfp' and not d.archived and package is not null),'[]'),'template',jsonb_build_object('id','professional-v1','fixed_blocks','[]'::jsonb)) into result from public.opportunities o where o.id=opp;
 if pg_column_size(result)>8388608 then raise exception 'GENERATION_CONTEXT_CAP_REACHED';end if;return result;
end $$;
revoke all on function app_private.generation_snapshot(uuid,uuid,uuid,uuid) from public,anon,authenticated;

alter function app_private.app_command(text,jsonb,text) rename to model_policy_command;
revoke all on function app_private.model_policy_command(text,jsonb,text) from public,anon,authenticated,service_role;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare payload alias for $2;w uuid;actor uuid:=auth.uid();role text;h text;replay app_private.idempotency_records;result jsonb;opp public.opportunities;prop public.proposals;pkg public.document_packages;p public.generation_plans;context jsonb;rec jsonb;j uuid;evidence_version bigint;job_record public.jobs;
begin
 if operation='job.action' and exists(select 1 from public.generation_steps where job_id=(payload->>'id')::uuid) then
 select * into job_record from public.jobs where id=(payload->>'id')::uuid;
 if coalesce(app_private.member_role(job_record.workspace_id),'') not in ('Owner','Editor') then raise exception 'ROLE_FORBIDDEN';end if;
 if job_record.revision is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 select * into p from public.generation_plans where id=job_record.entity_id;
 return app_private.app_command(case when payload->>'action'='cancel' then 'generation.cancel' else 'generation.retry' end,jsonb_build_object('id',p.id,'expected_revision',p.revision,'reason',payload->>'reason'),idempotency_key);
 end if;
 if operation not in ('opportunity.assess','proposal.generate','proposal.regenerate','generation.cancel','generation.retry') then return app_private.model_policy_command(operation,payload,idempotency_key);end if;
 select m.workspace_id into w from public.memberships m where m.user_id=actor and app_private.member_role(m.workspace_id) is not null limit 1;if w is null then raise exception 'ACCESS_PENDING';end if;
 perform 1 from public.workspaces where id=w for update;role:=app_private.member_role(w);if role not in ('Owner','Editor') then raise exception 'ROLE_FORBIDDEN';end if;
 if idempotency_key is null or length(idempotency_key) not between 1 and 200 or pg_column_size(payload)>1048576 then raise exception 'INVALID_INPUT';end if;
 h:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');select * into replay from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if replay.key is not null and replay.expires_at>now() then if replay.body_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return replay.result;end if;
 delete from app_private.idempotency_records where workspace_id=w and actor_id=actor and method='COMMAND' and route=operation and key=idempotency_key;
 if operation in ('generation.cancel','generation.retry') then
 perform app_private.check_keys(payload,array['id','expected_revision','reason']);if length(trim(coalesce(payload->>'reason','')))=0 then raise exception 'REASON_REQUIRED';end if;
 select * into p from public.generation_plans where workspace_id=w and id=(payload->>'id')::uuid for update;
 if p.id is null or p.revision is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 if p.status='completed' then raise exception 'STATE_CONFLICT';end if;
 if operation='generation.retry' then
 if p.evidence_revision<>(select evidence_revision from public.workspaces where id=w) then raise exception 'STALE_INPUT';end if;
 if exists(select 1 from public.jobs where entity_id=p.id and status='running') then raise exception 'GENERATION_BUSY';end if;
 if exists(select 1 from public.provider_usage where workspace_id=w and state in ('unknown','reserved')) then raise exception 'USAGE_REVIEW_REQUIRED';end if;
 update public.jobs set status='queued',cancel_requested=false,error_code=null,next_attempt_at=now(),revision=revision+1,updated_at=now() where entity_id=p.id and id in (select job_id from public.generation_steps where plan_id=p.id and status='queued');
 update public.generation_plans set status='queued',error_code=null,revision=revision+1,updated_at=now() where id=p.id returning to_jsonb(generation_plans.*) into result;
 else
 update public.generation_plans set status='canceled',revision=revision+1,updated_at=now() where id=p.id returning to_jsonb(generation_plans.*) into result;
 update public.jobs set cancel_requested=true,status=case when status='running' then status else 'canceled' end,revision=revision+1,updated_at=now() where entity_id=p.id and status not in ('succeeded','failed','canceled');
 end if;
 else
 if operation='proposal.regenerate' then
 perform app_private.check_keys(payload,array['id','expected_revision','base_version_id','input_hash']);select * into prop from public.proposals where workspace_id=w and id=(payload->>'id')::uuid for update;
 if prop.id is null or prop.revision is distinct from (payload->>'expected_revision')::int or prop.active_version_id is distinct from (payload->>'base_version_id')::uuid then raise exception 'REVISION_CONFLICT';end if;
 select * into opp from public.opportunities where workspace_id=w and id=prop.opportunity_id;
 else
 perform app_private.check_keys(payload,array['id','expected_revision']);select * into opp from public.opportunities where workspace_id=w and id=(payload->>'id')::uuid for update;
 if opp.id is null or opp.revision is distinct from (payload->>'expected_revision')::int then raise exception 'REVISION_CONFLICT';end if;
 end if;
 if exists(select 1 from public.generation_plans where workspace_id=w and opportunity_id=opp.id and kind=case when operation='opportunity.assess' then 'assessment' else 'proposal' end and status in ('queued','running','blocked')) then raise exception 'GENERATION_ALREADY_ACTIVE';end if;
 if operation<>'opportunity.assess' then
 if opp.decision<>'shortlisted' then raise exception 'SHORTLIST_REQUIRED';end if;pkg:=app_private.seal_package(w,opp.id,actor);
 if prop.id is null then select * into prop from public.proposals where workspace_id=w and opportunity_id=opp.id;end if;
 if prop.id is null then insert into public.proposals(workspace_id,opportunity_id,title,language,state,created_by) values(w,opp.id,opp.title,opp.language,'queued',actor) returning * into prop;end if;
 if operation='proposal.generate' and prop.active_version_id is not null then raise exception 'USE_REGENERATION';end if;
 end if;
 context:=app_private.generation_snapshot(w,opp.id,prop.id,pkg.id);select evidence_revision into evidence_version from public.workspaces where id=w;
 insert into public.generation_plans(workspace_id,opportunity_id,proposal_id,base_version_id,package_id,kind,stage,evidence_revision,input_hash,frozen_context,created_by) values(w,opp.id,prop.id,prop.active_version_id,pkg.id,case when operation='opportunity.assess' then 'assessment' else 'proposal' end,case when operation='opportunity.assess' then 'assessment' else 'analysis' end,evidence_version,encode(sha256(convert_to(context::text,'UTF8')),'hex'),context,actor) returning * into p;
 if p.kind='assessment' then j:=app_private.enqueue_generation(p,'classify_opportunity','{}');else
 for rec in select value from jsonb_array_elements(context->'blocks') loop j:=app_private.enqueue_generation(p,'analyze_chunk',jsonb_build_object('block_id',rec->>'id','start',0,'end',length(rec->>'text')));end loop;
 update public.proposals set state='queued',revision=proposals.revision+1,updated_at=now() where id=prop.id;
 if operation='proposal.regenerate' then insert into public.regeneration_requests(workspace_id,proposal_id,base_version_id,job_id,review_snapshot,created_by) select w,prop.id,prop.active_version_id,j,coalesce(jsonb_agg(to_jsonb(r)),'[]'),actor from public.review_inputs r where r.proposal_id=prop.id and r.base_version_id=prop.active_version_id;end if;
 end if;
 result:=to_jsonb(p)||jsonb_build_object('job_id',j);
 end if;
 insert into public.audit_events(workspace_id,actor_id,action,entity_id,reason,request_id) values(w,actor,operation,p.id,coalesce(payload->>'reason',''),gen_random_uuid());
 insert into app_private.idempotency_records(workspace_id,actor_id,method,route,key,body_hash,result) values(w,actor,'COMMAND',operation,idempotency_key,h,result);return result;
end $$;
revoke all on function app_private.app_command(text,jsonb,text) from public,anon;grant execute on function app_private.app_command(text,jsonb,text) to authenticated;

create function public.generation_context(job_id uuid,lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.jobs;p public.generation_plans;s public.generation_steps;
begin
 select * into j from public.jobs where id=job_id;if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() or j.cancel_requested then raise exception 'STALE_LEASE';end if;
 select * into s from public.generation_steps where generation_steps.job_id=j.id;select * into p from public.generation_plans where id=s.plan_id;
 if p.id is null or p.status in ('completed','failed','canceled') then raise exception 'GENERATION_NOT_ACTIVE';end if;
 if p.evidence_revision<>(select evidence_revision from public.workspaces where id=p.workspace_id) then raise exception 'STALE_INPUT';end if;
 if p.proposal_id is not null and p.base_version_id is distinct from (select active_version_id from public.proposals where id=p.proposal_id) then raise exception 'STALE_INPUT';end if;
 return jsonb_build_object('plan',to_jsonb(p),'step',to_jsonb(s),'steps',(select coalesce(jsonb_agg(to_jsonb(x) order by ordinal),'[]') from public.generation_steps x where plan_id=p.id),'requirements',(select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') from public.requirements r where plan_id=p.id));
end $$;
create function public.complete_generation_step(job_id uuid,lease uuid,result jsonb) returns void language plpgsql security definer set search_path='' as $$
declare w uuid;ctx jsonb;p public.generation_plans;s public.generation_steps;
begin
 select workspace_id into w from public.jobs where id=job_id;perform 1 from public.workspaces where id=w for update;
 ctx:=public.generation_context(job_id,lease);select * into p from public.generation_plans where id=(ctx->'plan'->>'id')::uuid;select * into s from public.generation_steps where generation_steps.job_id=complete_generation_step.job_id;
 if s.task='advance_plan' then raise exception 'INVALID_TASK';end if;
 update public.generation_steps set status='completed',output=result,revision=revision+1,updated_at=now() where id=s.id;
 update public.jobs set status='succeeded',lease_token=null,lease_until=null,error_code=null,revision=revision+1,updated_at=now() where id=job_id;
 update public.generation_plans set status='running',error_code=null,revision=revision+1,updated_at=now() where id=p.id;
 if not exists(select 1 from public.generation_steps where plan_id=p.id and stage=p.stage and status='queued') then perform app_private.enqueue_generation(p,'advance_plan','{}');end if;
end $$;
create function public.advance_generation(job_id uuid,lease uuid,next_stage text,requirements jsonb,steps jsonb,final_result jsonb default null) returns void language plpgsql security definer set search_path='' as $$
declare w uuid;ctx jsonb;p public.generation_plans;s public.generation_steps;item jsonb;v uuid;v_ordinal integer:=0;section jsonb;
begin
 select workspace_id into w from public.jobs where id=job_id;perform 1 from public.workspaces where id=w for update;ctx:=public.generation_context(job_id,lease);select * into p from public.generation_plans where id=(ctx->'plan'->>'id')::uuid;select * into s from public.generation_steps where generation_steps.job_id=advance_generation.job_id;
 if s.task<>'advance_plan' or exists(select 1 from public.generation_steps where plan_id=p.id and id<>s.id and stage=p.stage and status='queued') then raise exception 'STAGE_INCOMPLETE';end if;
 if next_stage<>(case p.stage when 'assessment' then 'completed' when 'analysis' then 'planning' when 'planning' then 'drafting' when 'drafting' then 'commercial' when 'commercial' then 'review' when 'review' then 'completed' else 'invalid' end) then raise exception 'INVALID_STAGE';end if;
 if (select coalesce(sum(pg_total_relation_size(c.oid)),0)>262144000 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app_private') and c.relkind='r') then raise exception 'DATABASE_CAP_REACHED';end if;
 if p.stage='analysis' then
 if jsonb_array_length(requirements)>2000 then raise exception 'REQUIREMENT_CAP_REACHED';end if;
 for item in select value from jsonb_array_elements(requirements) loop
 insert into public.requirements(id,workspace_id,plan_id,opportunity_id,text,category,mandatory,source_refs,interpretation,acceptance_evidence,owner_question,created_by) values((item->>'id')::uuid,w,p.id,p.opportunity_id,item->>'text',item->>'category',(item->>'mandatory')::boolean,item->'source_refs',item->>'interpretation',item->>'acceptance_evidence',item->>'owner_question',p.created_by);
 end loop;end if;
 update public.generation_steps set status='completed',output=jsonb_build_object('next_stage',next_stage),revision=revision+1,updated_at=now() where id=s.id;
 update public.jobs set status='succeeded',lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=job_id;
 update public.generation_plans set stage=next_stage,status=case when next_stage='completed' then 'completed' else 'running' end,error_code=null,revision=revision+1,updated_at=now() where id=p.id returning * into p;
 if next_stage<>'completed' then
 if jsonb_array_length(steps)=0 then perform app_private.enqueue_generation(p,'advance_plan','{}');else for item in select value from jsonb_array_elements(steps) loop perform app_private.enqueue_generation(p,item->>'task',item->'input');end loop;end if;
 elsif p.kind='assessment' then
 insert into public.fit_assessments(workspace_id,opportunity_id,plan_id,fit_score,evidence_coverage,routing,result,input_hash,evidence_revision,created_by) values(w,p.opportunity_id,p.id,(final_result->>'fit_score')::int,(final_result->>'evidence_coverage')::int,final_result->>'routing',final_result->'result',p.input_hash,p.evidence_revision,p.created_by);
 perform app_private.notify_members(w,'assessment:'||p.id,'Assessment ready','The recorded assessment does not change your bid decision.',p.opportunity_id,p.created_by);
 else
 if jsonb_array_length(final_result->'sections')=0 then raise exception 'EMPTY_PROPOSAL';end if;
 select coalesce(max(x.ordinal),0)+1 into v_ordinal from public.proposal_versions x where proposal_id=p.proposal_id;
 insert into public.proposal_versions(workspace_id,proposal_id,ordinal,content_hash,package_hash,plan_id,evidence_revision,review_result,commercial_draft,separate_volumes,created_by) select w,p.proposal_id,v_ordinal,encode(sha256(convert_to(final_result::text,'UTF8')),'hex'),package_hash,p.id,p.evidence_revision,final_result->'review',final_result->'commercial',(final_result->>'separate_volumes')::boolean,p.created_by from public.document_packages where id=p.package_id returning id into v;
 v_ordinal:=0;
 for section in select value from jsonb_array_elements(final_result->'sections') loop
 insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,evidence_refs,content_blocks,requirement_ids,volume,fixed,created_by) values(w,v,section->>'key',section->>'title',section->>'body',v_ordinal,section->'evidence_refs',section->'content_blocks',section->'requirement_ids',section->>'volume',coalesce((section->>'fixed')::boolean,false),p.created_by);v_ordinal:=v_ordinal+1;
 end loop;
 for item in select value from jsonb_array_elements(final_result->'questions') loop
 insert into public.questions(workspace_id,opportunity_id,proposal_version_id,question,blocking_level,target_section_key,reason,created_by) values(w,p.opportunity_id,v,item->>'question',item->>'blocking_level',item->>'section_key',coalesce(item->>'reason','Generated question requiring human review'),p.created_by);
 end loop;
 update public.proposals set active_version_id=v,state='draft',revision=revision+1,updated_at=now() where id=p.proposal_id;
 perform app_private.notify_members(w,'proposal:'||p.id,'Proposal draft ready','Review the requirements, evidence, questions and commercial assumptions before approval.',p.proposal_id,p.created_by);
 end if;
end $$;
create function public.fail_generation(job_id uuid,lease uuid,error_code text,retry_after timestamptz default null,split_inputs jsonb default null) returns void language plpgsql security definer set search_path='' as $$
declare w uuid;j public.jobs;p public.generation_plans;s public.generation_steps;state text:='blocked';next_time timestamptz:='infinity';item jsonb;
begin
 select workspace_id into w from public.jobs where id=job_id;perform 1 from public.workspaces where id=w for update;select * into j from public.jobs where id=job_id for update;
 if j.id is null or j.status<>'running' or j.lease_token is distinct from lease or j.lease_until<=now() then raise exception 'STALE_LEASE';end if;
 select * into s from public.generation_steps where generation_steps.job_id=j.id;select * into p from public.generation_plans where id=s.plan_id;
 if j.cancel_requested or p.status='canceled' then state:='canceled';
 elsif split_inputs is not null and s.depth<8 and jsonb_array_length(split_inputs)=2 and error_code in ('MODEL_CONTEXT_TOO_LARGE','MODEL_OUTPUT_TRUNCATED') then
 if (select count(*) from public.generation_steps where plan_id=p.id)+2>300 then error_code:='PLAN_JOB_CAP_REACHED';else
 for item in select value from jsonb_array_elements(split_inputs) loop perform app_private.enqueue_generation(p,s.task,item,s.depth+1);end loop;
 update public.generation_steps set status='split',revision=revision+1,updated_at=now() where id=s.id;state:='succeeded';end if;
 elsif error_code in ('MODEL_OUTPUT_INVALID','EVIDENCE_REFERENCE_INVALID','MODEL_COVERAGE_INCOMPLETE','UNSUPPORTED_COMPANY_CLAIM') and s.repair_count=0 then
 update public.generation_steps set repair_count=1,revision=revision+1 where id=s.id;state:='retry_wait';next_time:=now()+interval '1 minute';
 elsif error_code in ('MODEL_RATE_WAIT','MODEL_DAILY_QUOTA_WAIT','PROVIDER_QUOTA_WAIT') then
 state:='quota_wait';next_time:=case when error_code='MODEL_RATE_WAIT' then now()+interval '1 minute' when error_code='MODEL_DAILY_QUOTA_WAIT' then ((now() at time zone 'Asia/Riyadh')::date+1)::timestamp at time zone 'Asia/Riyadh' else coalesce(retry_after,'infinity') end;
 end if;
 update public.jobs set status=state,error_code=case when state='succeeded' then null else fail_generation.error_code end,next_attempt_at=next_time,lease_token=null,lease_until=null,revision=revision+1,updated_at=now() where id=j.id;
 update public.generation_plans set status=case when state='canceled' then 'canceled' when state='blocked' then 'blocked' else 'running' end,error_code=case when state='succeeded' then null else fail_generation.error_code end,revision=revision+1,updated_at=now() where id=p.id;
 if state='blocked' then perform app_private.notify_members(w,'plan-blocked:'||p.id||':'||error_code,'Generation needs attention',error_code,p.opportunity_id,p.created_by);end if;
end $$;
revoke all on function public.generation_context(uuid,uuid),public.complete_generation_step(uuid,uuid,jsonb),public.advance_generation(uuid,uuid,text,jsonb,jsonb,jsonb),public.fail_generation(uuid,uuid,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.generation_context(uuid,uuid),public.complete_generation_step(uuid,uuid,jsonb),public.advance_generation(uuid,uuid,text,jsonb,jsonb,jsonb),public.fail_generation(uuid,uuid,text,timestamptz,jsonb) to service_role;

create function app_private.generation_call_cap() returns trigger language plpgsql security definer set search_path='' as $$
declare plan uuid;
begin
 select s.plan_id into plan from public.generation_steps s where s.job_id=new.job_id;
 if plan is not null and (select count(*) from public.provider_usage u join public.generation_steps s on s.job_id=u.job_id where s.plan_id=plan)>=300 then raise exception 'PLAN_CALL_CAP_REACHED';end if;return new;
end $$;
revoke all on function app_private.generation_call_cap() from public,anon,authenticated;
create trigger bounded_plan_calls before insert on public.provider_usage for each row execute function app_private.generation_call_cap();
-- A change in the notice or requested language invalidates frozen generation and approval.
create trigger opportunity_evidence_changed after update of title,description,buyer,reference,language on public.opportunities for each row when (old.title is distinct from new.title or old.description is distinct from new.description or old.buyer is distinct from new.buyer or old.reference is distinct from new.reference or old.language is distinct from new.language) execute function app_private.invalidate_evidence();
-- Automatic intake assessment is eligible only after deliberate model activation.
-- Per-content authorization is still checked immediately before any provider call.
create function app_private.schedule_notice_assessment() returns trigger language plpgsql security definer set search_path='' as $$
declare p public.generation_plans;context jsonb;version bigint;
begin
 if not exists(select 1 from public.model_settings where workspace_id=new.workspace_id and enabled) then return new;end if;
 if exists(select 1 from public.generation_plans where workspace_id=new.workspace_id and opportunity_id=new.id and kind='assessment' and status in ('queued','running','blocked')) then return new;end if;
 if (select count(*) from public.jobs where workspace_id=new.workspace_id and status in ('queued','running','retry_wait','quota_wait','blocked'))>=500 then return new;end if;
 context:=app_private.generation_snapshot(new.workspace_id,new.id,null,null);select evidence_revision into version from public.workspaces where id=new.workspace_id;
 insert into public.generation_plans(workspace_id,opportunity_id,kind,stage,evidence_revision,input_hash,frozen_context,created_by) values(new.workspace_id,new.id,'assessment','assessment',version,encode(sha256(convert_to(context::text,'UTF8')),'hex'),context,new.created_by) returning * into p;
 perform app_private.enqueue_generation(p,'classify_opportunity','{}');return new;
end $$;
revoke all on function app_private.schedule_notice_assessment() from public,anon,authenticated;
create trigger new_notice_assessment after insert on public.opportunities for each row execute function app_private.schedule_notice_assessment();
