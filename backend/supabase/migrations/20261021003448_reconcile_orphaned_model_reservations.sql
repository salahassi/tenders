-- A generic provider error is not proof that accepted generation terminated.
-- Keep its ID pollable, with a longer reconciliation interval. Only new phases
-- use the observed transport fallback; the same phase cannot duplicate a POST.
update public.provider_usage set error_code='PROVIDER_BACKGROUND_RETRIEVAL_FAILED',revision=revision+1,updated_at=now()
where error_code='PROVIDER_BACKGROUND_FAILED';
do $$ declare definition text;begin
 select pg_get_functiondef('public.resume_task_model_request_phase(uuid,uuid,text,jsonb,uuid,uuid,text)'::regprocedure) into definition;
 definition:=replace(definition,'and p.error_code is distinct from ''PROVIDER_BACKGROUND_FAILED''','');execute definition;
 select pg_get_functiondef('public.model_background_allowed(uuid,uuid,text,text,text,uuid,uuid)'::regprocedure) into definition;
 definition:=replace(definition,'''PROVIDER_BACKGROUND_FAILED''','''PROVIDER_BACKGROUND_RETRIEVAL_FAILED''');execute definition;
end $$;

create or replace function public.claim_abandoned_model_request()
returns jsonb language plpgsql security definer set search_path='' as $$
declare u public.provider_usage;orphan public.provider_usage;
begin
 -- An evidence edit can block a job while its provider continues running.
 -- Release only the workspace reservation; preserve remote work for retrieval.
 for orphan in select p.* from public.provider_usage p join public.jobs j on j.id=p.job_id
  where p.state='reserved' and p.remote_request_id is not null and j.status in ('canceled','blocked','failed')
  for update of p skip locked loop
  update public.provider_usage set state='unknown',revision=revision+1,updated_at=now() where id=orphan.id;
  insert into public.audit_events(workspace_id,actor_id,action,entity_type,entity_id,reason,details)
  values(orphan.workspace_id,orphan.created_by,'model.request.reconciliation','job',orphan.job_id,
   'Stopped job retained an accepted remote request; release its local reservation and reconcile without resubmitting.',
   jsonb_build_object('usage_id',orphan.id,'tokens_known',false));
 end loop;
 select p.* into u from public.provider_usage p join public.jobs j on j.id=p.job_id
 where p.provider in ('gemini_free','openai') and p.state='unknown' and p.remote_request_id is not null
 and p.remote_deadline>now() and (j.status in ('canceled','blocked','failed') or
  (j.status<>'running' and p.error_code in ('PROVIDER_REQUEST_INVALID','PROVIDER_AUTH_FAILED','PROVIDER_QUOTA_WAIT','MODEL_NETWORK_UNCERTAIN','PROVIDER_BACKGROUND_RETRIEVAL_FAILED')))
 and (p.reconciliation_after is null or p.reconciliation_after<=now())
 order by p.created_at,p.id for update of p skip locked limit 1;
 if u.id is null then return null;end if;
 update public.provider_usage set reconciliation_after=now()+case when u.error_code='PROVIDER_BACKGROUND_RETRIEVAL_FAILED' then interval '1 hour' else interval '5 minutes' end,
  revision=revision+1,updated_at=now() where id=u.id;
 return jsonb_build_object('id',u.id,'job_status',(select status from public.jobs where id=u.job_id),
  'provider',u.provider,'model',u.model,'project_ref',u.remote_project_ref,'remote_request_id',u.remote_request_id,
  'connection_id',u.connection_id,'model_config_id',u.model_config_id,
  'credential_alias',(select credential_alias from public.model_connections where id=u.connection_id));
end $$;
revoke all on function public.claim_abandoned_model_request() from public,anon,authenticated;
grant execute on function public.claim_abandoned_model_request() to service_role;
