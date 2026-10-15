alter table public.documents add column eligibility_hash text,add column eligibility_reviewed_by uuid references auth.users(id),add column eligibility_reviewed_at timestamptz;
create function app_private.assert_business_content(value text) returns void language plpgsql immutable set search_path='' as $$
begin
 if coalesce(value,'') ~* '(\mconfidential\M|strictly private|سري للغاية|سرية|password[[:space:]]*[:=]|api[_ -]?key[[:space:]]*[:=]|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|-----BEGIN .*PRIVATE KEY|\m(sk|sb_secret)_[a-z0-9]{12,}|\+[0-9][0-9 ()-]{7,}[0-9]|\m[0-9]{3}[- .][0-9]{3}[- .][0-9]{4}\M)' then raise exception 'DATA_POLICY_BLOCKED';end if;
end $$;
revoke all on function app_private.assert_business_content(text) from public,anon,authenticated;
alter function app_private.app_command(text,jsonb,text) rename to approval_command;
revoke all on function app_private.approval_command(text,jsonb,text) from public,anon,authenticated,service_role;
create function app_private.app_command(operation text,input jsonb,idempotency_key text) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if operation='document.prepare' then
 if input->'eligibility_attested' is distinct from 'true'::jsonb then raise exception 'ORIGINAL_ELIGIBILITY_REQUIRED';end if;
 perform app_private.assert_business_content(input->>'original_name');
 result:=app_private.approval_command(operation,input-'eligibility_attested',idempotency_key);
 update public.documents set eligibility_hash=original_hash,eligibility_reviewed_by=auth.uid(),eligibility_reviewed_at=coalesce(eligibility_reviewed_at,now()) where id=(result->>'id')::uuid and created_by=auth.uid() and original_hash=input->>'hash';
 return result;
 end if;
 return app_private.approval_command(operation,input,idempotency_key);
end $$;
revoke all on function app_private.app_command(text,jsonb,text) from public,anon;grant execute on function app_private.app_command(text,jsonb,text) to authenticated;
drop policy tenderdesk_upload on storage.objects;
create policy tenderdesk_upload on storage.objects for insert to authenticated with check(
 bucket_id='tenderdesk-private' and exists(select 1 from public.documents d where d.storage_key=name and d.status='pending' and not d.archived and d.created_by=auth.uid() and d.eligibility_hash=d.original_hash and d.eligibility_reviewed_by=auth.uid() and d.eligibility_reviewed_at+interval '15 minutes'>now() and d.created_at+interval '15 minutes'>now() and (app_private.member_role(d.workspace_id) in ('Owner','Editor') or (app_private.member_role(d.workspace_id)='Reviewer' and d.kind='review' and exists(select 1 from public.review_inputs r where r.id=d.review_input_id and r.created_by=auth.uid())))));
create function app_private.guard_business_columns() returns trigger language plpgsql security definer set search_path='' as $$
declare field text;
begin
 foreach field in array TG_ARGV loop perform app_private.assert_business_content(to_jsonb(new)->>field);end loop;return new;
end $$;
revoke all on function app_private.guard_business_columns() from public,anon,authenticated;
create trigger content_eligible before insert or update on public.documents for each row execute function app_private.guard_business_columns('original_name','extracted_text');
create trigger content_eligible before insert or update on app_private.extraction_parts for each row execute function app_private.guard_business_columns('content');
create trigger content_eligible before insert or update on public.knowledge_items for each row execute function app_private.guard_business_columns('title','content');
create trigger content_eligible before insert or update on public.review_inputs for each row execute function app_private.guard_business_columns('body');
create trigger content_eligible before insert or update on public.opportunities for each row execute function app_private.guard_business_columns('title','description','buyer');
create trigger content_eligible before insert or update on public.rate_catalog for each row execute function app_private.guard_business_columns('title','source_reference');
create trigger content_eligible before insert or update on public.templates for each row execute function app_private.guard_business_columns('title','fixed_blocks','style_config');
create trigger content_eligible before insert or update on public.questions for each row execute function app_private.guard_business_columns('question','answer','answer_source','reason');
create trigger content_eligible before insert or update on public.reviews for each row execute function app_private.guard_business_columns('comment','resolution');
create trigger content_eligible before insert or update on public.estimate_versions for each row execute function app_private.guard_business_columns('input');
create trigger content_eligible before insert or update on public.delivery_versions for each row execute function app_private.guard_business_columns('input');
create trigger content_eligible before insert or update on public.proposal_sections for each row execute function app_private.guard_business_columns('title','body');
create function app_private.add_structural_locator() returns trigger language plpgsql security definer set search_path='' as $$
declare preceding text;anchor text;markers jsonb;
begin
 select left(extracted_text,(new.locator->>'start')::integer) into preceding from public.documents where id=new.document_id;
 select m[1] into anchor from regexp_matches(preceding,'\[((Page|Heading|Paragraph|Table) [^\]]+)\]','g') with ordinality as matches(m,ordinal) order by ordinal desc limit 1;
 select jsonb_agg(m[1]) into markers from regexp_matches(new.text,'\[((Page|Heading|Paragraph|Table) [^\]]+)\]','g') as m;
 new.locator:=new.locator||jsonb_build_object('preceding_anchor',anchor,'structural_markers',coalesce(markers,'[]'));return new;
end $$;
revoke all on function app_private.add_structural_locator() from public,anon,authenticated;
create trigger structural_locator before insert on public.document_blocks for each row execute function app_private.add_structural_locator();
