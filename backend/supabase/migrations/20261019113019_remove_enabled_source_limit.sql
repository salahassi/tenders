-- Remove only the retired trial ceiling on enabled source count.
-- Owner authorization, adapter/access requirements, revisions and auditing remain.
DO $migration$
DECLARE
  target text;
  guard text;
  definition text;
BEGIN
  FOR target, guard IN SELECT * FROM (VALUES
    ('app_private.collection_command(text,jsonb,text)',
     'if src.approval<>''approved'' and (select count(*) from public.sources where workspace_id=w and approval=''approved'' and kind<>''manual'')>=5 then raise exception ''SOURCE_CAP_REACHED''; end if;'),
    ('app_private.evidence_command(text,jsonb,text)',
     'if input->>''action''=''approve'' and src.approval<>''approved'' and (select count(*) from public.sources where workspace_id=w and approval=''approved'' and kind<>''manual'')>=5 then raise exception ''SOURCE_CAP_REACHED''; end if;')
  ) AS patches(target, guard)
  LOOP
    SELECT pg_get_functiondef(target::regprocedure) INTO definition;
    IF position(guard IN definition)=0 THEN
      RAISE EXCEPTION 'Expected source activation guard missing from %', target;
    END IF;
    EXECUTE replace(definition, guard, '-- No separate ceiling on enabled sources.');
  END LOOP;
END
$migration$;
