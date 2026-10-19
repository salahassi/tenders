-- Automatic routing handles ambiguous usage at the actual provider reservation.
-- An unrelated unknown request must not prevent resuming saved proposal work.
-- Active reservations and the legacy manual policy retain their existing guard.
do $patch$
declare definition text; old_guard text; new_guard text;
begin
 select pg_get_functiondef('app_private.generation_command(text,jsonb,text)'::regprocedure) into definition;
 old_guard := $old$if exists(select 1 from public.provider_usage where workspace_id=w and state in ('unknown','reserved')) then raise exception 'USAGE_REVIEW_REQUIRED';end if;$old$;
 new_guard := $new$if exists(select 1 from public.provider_usage where workspace_id=w and (
  state='reserved' or (state='unknown' and not exists(select 1 from public.model_routing where workspace_id=w and enabled))
 )) then raise exception 'USAGE_REVIEW_REQUIRED';end if;$new$;
 if position(old_guard in definition)=0 then raise exception 'Unexpected generation retry usage guard';end if;
 execute replace(definition,old_guard,new_guard);
end $patch$;
