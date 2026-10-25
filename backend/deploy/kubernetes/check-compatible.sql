-- Run after schema restoration/adaptation and before making workers available.
-- The administrative connection does not inherit application schema access.
BEGIN;
SET LOCAL ROLE tdp_app_owner;
DO $compatibility$
BEGIN
 IF to_regprocedure('public.resume_task_model_request_phase(uuid,uuid,text,jsonb,uuid,uuid,text)') IS NULL
 OR to_regprocedure('public.defer_pending_model_request(uuid,uuid,uuid)') IS NULL
 OR to_regprocedure('public.claim_backend_job_v2()') IS NULL
 THEN
  RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='BACKEND_DATABASE_COMPATIBILITY_REQUIRED';
 END IF;
END
$compatibility$;
COMMIT;
