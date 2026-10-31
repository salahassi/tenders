#!/usr/bin/env python3
"""Canonically resume one privately selected, never-sent blocked proposal.

The encrypted input selects existing records only. It cannot supply SQL,
providers, credentials or content. Current blocked analysis jobs use their
canonical per-job retry, with exact revision and immutable-state checks in one
transaction. Existing workspace usage accounting is never changed.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stderr, redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid

HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


observer = load("requested_processing_resume_observer", "observe-assessment-recovery.py")
access = observer.access
transfer = load("requested_processing_resume_transfer", "private-transfer.py")
release = load("requested_processing_resume_release", "requested-processing-update.py")
BUCKET = "tenderdesk-migration-a6093a76-sfo3"


class ResumeError(Exception):
    pass


def validate_selection(value):
    keys = {"version", "workspace_id", "opportunity_id", "plan_id", "expected_revision", "kind", "error_code"}
    if not isinstance(value, dict) or set(value) != keys or type(value["version"]) is not int or value["version"] != 1:
        raise ResumeError("RESUME_SELECTION_INVALID")
    for key in ("workspace_id", "opportunity_id", "plan_id"):
        try:
            if not isinstance(value[key], str) or str(uuid.UUID(value[key])) != value[key]:
                raise ValueError()
        except (ValueError, AttributeError, TypeError):
            raise ResumeError("RESUME_SELECTION_INVALID") from None
    if (value["workspace_id"] != access.WORKSPACE or type(value["expected_revision"]) is not int
            or not 1 <= value["expected_revision"] <= 2147483647 or value["kind"] != "proposal"
            or value["error_code"] != "DATA_AUTHORIZATION_REQUIRED"):
        raise ResumeError("RESUME_SELECTION_INVALID")
    return value


def verify_runtime(expected):
    if not isinstance(expected, str) or not re.fullmatch(r"registry\.digitalocean\.com/tenderdesk-a6093a76/runtime@sha256:[a-f0-9]{64}", expected):
        raise ResumeError("RESUME_VERIFIED_RUNTIME_REQUIRED")
    for name in ("api", "worker"):
        current = release.u.deployment(name)
        if current["spec"]["template"]["spec"]["containers"][0]["image"] != expected:
            raise ResumeError("RESUME_RUNTIME_CHANGED")


def recovery_sql(selection, *, diagnose_only=False):
    validate_selection(selection)
    if type(diagnose_only) is not bool:
        raise ResumeError("RESUME_DIAGNOSTIC_MODE_INVALID")
    encoded = json.dumps(selection, sort_keys=True, separators=(",", ":"))
    key = "requested-processing-resume-" + hashlib.sha256(encoded.encode()).hexdigest()
    migration_hash = hashlib.sha256(release.MIGRATION.read_bytes()).hexdigest()
    # Input has been restricted to UUIDs, bounded integers and fixed constants.
    literal = "'" + encoded.replace("'", "''") + "'::jsonb"
    return r"""BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='10s';
DO $requested_resume$
DECLARE selected jsonb:=__SELECTION__; actor uuid; p public.generation_plans;
 latest uuid; receipt jsonb; result jsonb; immutable_plan jsonb; immutable_jobs jsonb;
 immutable_steps jsonb; retained jsonb; after_retained jsonb; unrelated jsonb;
 retry_job record; selected_job_ids uuid[]; job_revisions jsonb; last_key text; resumed_jobs integer:=0;
 diagnostic_stage text:='database_guard'; diagnostic_state text; diagnostic_message text;
 diagnostic_context text; diagnostic_detail text; diagnostic_hint text; private_state jsonb; auth_state jsonb;
BEGIN
 BEGIN
  IF current_database()<>'tenderdesk_app' OR (SELECT count(*) FROM public.workspaces)<>1
   OR NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id=(selected->>'workspace_id')::uuid)
  THEN RAISE EXCEPTION 'RESUME_DATABASE_IDENTITY_MISMATCH'; END IF;
  PERFORM 1 FROM public.workspaces WHERE id=(selected->>'workspace_id')::uuid FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM app_private.application_release_history
   WHERE release='requested-model-processing-v1' AND migration_sha256='__MIGRATION_HASH__')
  THEN RAISE EXCEPTION 'RESUME_RELEASE_NOT_VERIFIED'; END IF;
  IF EXISTS(SELECT 1 FROM public.restore_sessions WHERE workspace_id=(selected->>'workspace_id')::uuid AND state IN ('staging','committing'))
  THEN RAISE EXCEPTION 'RESUME_RESTORE_IN_PROGRESS'; END IF;
  diagnostic_stage:='owner_lookup';
  -- Delegate the Owner-authorized request through the canonical membership and
  -- allowlist authority. Direct Auth-table visibility is a separate runtime
  -- concern and must not become a second authorization rule for this command.
  SELECT m.user_id INTO STRICT actor FROM public.memberships m JOIN public.identity_allowlist a
   ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
   WHERE m.workspace_id=(selected->>'workspace_id')::uuid AND m.active AND m.role='Owner'
    AND a.status='active' AND a.role='Owner';
  PERFORM set_config('request.jwt.claim.sub',actor::text,true);
  IF app_private.member_role((selected->>'workspace_id')::uuid) IS DISTINCT FROM 'Owner'
  THEN RAISE EXCEPTION 'RESUME_OWNER_REQUIRED'; END IF;
  diagnostic_stage:='plan_lookup';
  SELECT plan.* INTO STRICT p FROM public.generation_plans plan JOIN public.opportunities o
   ON o.workspace_id=plan.workspace_id AND o.id=plan.opportunity_id
   WHERE plan.id=(selected->>'plan_id')::uuid AND plan.workspace_id=(selected->>'workspace_id')::uuid
    AND plan.opportunity_id=(selected->>'opportunity_id')::uuid AND plan.kind='proposal' AND NOT o.archived FOR UPDATE OF plan;
  SELECT id INTO latest FROM public.generation_plans WHERE workspace_id=p.workspace_id
   AND opportunity_id=p.opportunity_id AND kind='proposal' ORDER BY created_at DESC,id DESC LIMIT 1;
  IF latest IS DISTINCT FROM p.id THEN RAISE EXCEPTION 'RESUME_PLAN_NOT_CURRENT'; END IF;
  IF p.status='completed' THEN receipt:=jsonb_build_object('status','already_completed','count',0);
  ELSIF p.status IN ('queued','running') THEN receipt:=jsonb_build_object('status','already_active','count',0);
  ELSE
   IF p.status<>'blocked' OR p.error_code IS DISTINCT FROM 'DATA_AUTHORIZATION_REQUIRED'
   THEN RAISE EXCEPTION 'RESUME_DIFFERENT_BLOCKER'; END IF;
   IF p.revision<>(selected->>'expected_revision')::integer THEN RAISE EXCEPTION 'RESUME_REVISION_CHANGED'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.generation_steps WHERE workspace_id=p.workspace_id AND plan_id=p.id AND status='queued')
   OR EXISTS(SELECT 1 FROM public.generation_steps s LEFT JOIN public.jobs j ON j.workspace_id=s.workspace_id AND j.id=s.job_id
     WHERE s.workspace_id=p.workspace_id AND s.plan_id=p.id AND s.status='queued'
      AND (j.id IS NULL OR j.status<>'blocked' OR j.error_code IS DISTINCT FROM 'DATA_AUTHORIZATION_REQUIRED' OR j.cancel_requested
       OR j.lease_token IS NOT NULL OR j.lease_until IS NOT NULL OR j.input_hash IS DISTINCT FROM p.input_hash OR s.stage IS DISTINCT FROM p.stage))
   THEN RAISE EXCEPTION 'RESUME_JOB_STATE_CHANGED'; END IF;
   IF EXISTS(SELECT 1 FROM public.model_attempts a JOIN public.jobs j ON j.id=a.job_id AND j.workspace_id=a.workspace_id
     WHERE j.entity_id=p.id AND j.workspace_id=p.workspace_id AND a.sent)
   OR EXISTS(SELECT 1 FROM public.provider_usage u JOIN public.jobs j ON j.id=u.job_id AND j.workspace_id=u.workspace_id
     WHERE j.entity_id=p.id AND j.workspace_id=p.workspace_id)
   THEN RAISE EXCEPTION 'RESUME_PROVIDER_ACTIVITY_EXISTS'; END IF;
   diagnostic_stage:='retained_state_snapshot';
   SELECT array_agg(j.id ORDER BY j.id),jsonb_object_agg(j.id::text,j.revision)
    INTO selected_job_ids,job_revisions FROM public.generation_steps s JOIN public.jobs j ON j.workspace_id=s.workspace_id AND j.id=s.job_id
    WHERE s.workspace_id=p.workspace_id AND s.plan_id=p.id AND s.status='queued' AND s.stage=p.stage;
   immutable_plan:=to_jsonb(p)-ARRAY['status','error_code','revision','updated_at','evidence_revision'];
   SELECT coalesce(jsonb_agg(to_jsonb(j)-ARRAY['status','error_code','next_attempt_at','revision','updated_at','cancel_requested'] ORDER BY j.id),'[]')
    INTO immutable_jobs FROM public.jobs j WHERE j.workspace_id=p.workspace_id AND j.entity_id=p.id;
   SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') INTO immutable_steps FROM public.generation_steps s WHERE s.workspace_id=p.workspace_id AND s.plan_id=p.id;
   SELECT jsonb_build_object(
    'threads',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM app_private.model_graph_threads t WHERE t.job_id IN (SELECT id FROM public.jobs WHERE entity_id=p.id AND workspace_id=p.workspace_id)),
    'results',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM app_private.model_graph_results t WHERE t.thread_id IN (SELECT id FROM app_private.model_graph_threads WHERE job_id IN (SELECT id FROM public.jobs WHERE entity_id=p.id AND workspace_id=p.workspace_id))),
    'budgets',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.thread_id,t.unit),'[]') FROM app_private.model_graph_budgets t WHERE t.thread_id IN (SELECT id FROM app_private.model_graph_threads WHERE job_id IN (SELECT id FROM public.jobs WHERE entity_id=p.id AND workspace_id=p.workspace_id))),
    'checkpoints',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.thread_id,t.namespace,t.checkpoint_id),'[]') FROM app_private.model_graph_checkpoints t WHERE t.thread_id IN (SELECT id FROM app_private.model_graph_threads WHERE job_id IN (SELECT id FROM public.jobs WHERE entity_id=p.id AND workspace_id=p.workspace_id))),
    'writes',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM app_private.model_graph_writes t WHERE t.thread_id IN (SELECT id FROM app_private.model_graph_threads WHERE job_id IN (SELECT id FROM public.jobs WHERE entity_id=p.id AND workspace_id=p.workspace_id))),
    'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM public.model_attempts a WHERE a.job_id IN (SELECT id FROM public.jobs WHERE entity_id=p.id AND workspace_id=p.workspace_id)),
    'usage',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM public.provider_usage a WHERE a.job_id IN (SELECT id FROM public.jobs WHERE entity_id=p.id AND workspace_id=p.workspace_id))) INTO retained;
   SELECT jsonb_build_object('jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY id),'[]') FROM public.jobs j WHERE NOT(j.id=ANY(selected_job_ids))),
    'plans',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY id),'[]') FROM public.generation_plans q WHERE q.id<>p.id),
    'usage',(SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY id),'[]') FROM public.provider_usage u WHERE u.workspace_id=p.workspace_id),
    'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM public.model_attempts a WHERE a.workspace_id=p.workspace_id)) INTO unrelated;
   diagnostic_stage:='canonical_retry';
   FOR retry_job IN SELECT j.id,j.revision FROM public.jobs j WHERE j.id=ANY(selected_job_ids) ORDER BY j.id LOOP
    last_key:='__IDEMPOTENCY_KEY__'||':'||retry_job.id::text;
    result:=app_private.app_command('job.action',jsonb_build_object('id',retry_job.id,'expected_revision',retry_job.revision,'action','retry',
      'reason','Owner requested removal of the separate file-processing approval step; resume this saved proposal task.'),last_key);
    resumed_jobs:=resumed_jobs+1;
   END LOOP;
   diagnostic_stage:='immutable_state_validation';
   IF immutable_plan IS DISTINCT FROM (SELECT to_jsonb(q)-ARRAY['status','error_code','revision','updated_at','evidence_revision'] FROM public.generation_plans q WHERE q.id=p.id)
    OR immutable_jobs IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(j)-ARRAY['status','error_code','next_attempt_at','revision','updated_at','cancel_requested'] ORDER BY j.id),'[]') FROM public.jobs j WHERE j.workspace_id=p.workspace_id AND j.entity_id=p.id)
    OR immutable_steps IS DISTINCT FROM (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]') FROM public.generation_steps s WHERE s.workspace_id=p.workspace_id AND s.plan_id=p.id)
   THEN RAISE EXCEPTION 'RESUME_IMMUTABLE_STATE_CHANGED'; END IF;
   SELECT jsonb_build_object(
    'threads',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM app_private.model_graph_threads t WHERE t.job_id IN (SELECT id FROM public.jobs WHERE entity_id=p.id AND workspace_id=p.workspace_id)),
    'results',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]') FROM app_private.model_graph_results t WHERE t.thread_id IN (SELECT id FROM app_private.model_graph_threads WHERE job_id IN (SELECT id FROM public.jobs WHERE entity_id=p.id AND workspace_id=p.workspace_id))),
    'budgets',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.thread_id,t.unit),'[]') FROM app_private.model_graph_budgets t WHERE t.thread_id IN (SELECT id FROM app_private.model_graph_threads WHERE job_id IN (SELECT id FROM public.jobs WHERE entity_id=p.id AND workspace_id=p.workspace_id))),
    'checkpoints',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.thread_id,t.namespace,t.checkpoint_id),'[]') FROM app_private.model_graph_checkpoints t WHERE t.thread_id IN (SELECT id FROM app_private.model_graph_threads WHERE job_id IN (SELECT id FROM public.jobs WHERE entity_id=p.id AND workspace_id=p.workspace_id))),
    'writes',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM app_private.model_graph_writes t WHERE t.thread_id IN (SELECT id FROM app_private.model_graph_threads WHERE job_id IN (SELECT id FROM public.jobs WHERE entity_id=p.id AND workspace_id=p.workspace_id))),
    'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM public.model_attempts a WHERE a.job_id IN (SELECT id FROM public.jobs WHERE entity_id=p.id AND workspace_id=p.workspace_id)),
    'usage',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') FROM public.provider_usage a WHERE a.job_id IN (SELECT id FROM public.jobs WHERE entity_id=p.id AND workspace_id=p.workspace_id))) INTO after_retained;
   IF retained IS DISTINCT FROM after_retained OR unrelated IS DISTINCT FROM
    (SELECT jsonb_build_object('jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY id),'[]') FROM public.jobs j WHERE NOT(j.id=ANY(selected_job_ids))),
     'plans',(SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY id),'[]') FROM public.generation_plans q WHERE q.id<>p.id),
     'usage',(SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY id),'[]') FROM public.provider_usage u WHERE u.workspace_id=p.workspace_id),
     'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY id),'[]') FROM public.model_attempts a WHERE a.workspace_id=p.workspace_id)))
   THEN RAISE EXCEPTION 'RESUME_RETAINED_STATE_CHANGED'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.generation_plans q JOIN public.workspaces w ON w.id=q.workspace_id
     WHERE q.id=p.id AND q.status='queued' AND q.error_code IS NULL AND q.evidence_revision=w.evidence_revision)
    OR EXISTS(SELECT 1 FROM public.generation_steps s JOIN public.jobs j ON j.id=s.job_id AND j.workspace_id=s.workspace_id
     WHERE s.plan_id=p.id AND s.status='queued' AND (j.status<>'queued' OR j.error_code IS NOT NULL OR j.cancel_requested OR j.next_attempt_at>now()
      OR j.revision<>(job_revisions->>j.id::text)::integer+1))
    OR resumed_jobs IS DISTINCT FROM cardinality(selected_job_ids)
    OR EXISTS(SELECT 1 FROM unnest(selected_job_ids) AS selected_jobs(id) WHERE NOT EXISTS(SELECT 1 FROM app_private.idempotency_records i
      WHERE i.workspace_id=p.workspace_id AND i.actor_id=actor AND i.method='COMMAND' AND i.route='job.action'
       AND i.key='__IDEMPOTENCY_KEY__'||':'||selected_jobs.id::text AND i.result->>'id'=selected_jobs.id::text AND i.expires_at>now()))
    OR NOT EXISTS(SELECT 1 FROM app_private.generation_processing_requests WHERE plan_id=p.id AND requested_by=actor AND operation='job.action' AND idempotency_key=last_key)
   THEN RAISE EXCEPTION 'RESUME_CANONICAL_RETRY_NOT_CONFIRMED'; END IF;
   receipt:=jsonb_build_object('status','resumed','count',1,'resumed_jobs',resumed_jobs,'immutable_state_preserved',true);
   IF __DIAGNOSE_ONLY__ THEN RAISE EXCEPTION 'RESUME_DIAGNOSTIC_ROLLBACK'; END IF;
  END IF;
  receipt:=receipt||jsonb_build_object('observed_at',now(),'workspace_id',p.workspace_id,'opportunity_id',p.opportunity_id,'plan_id',p.id,
   'plan',(SELECT jsonb_build_object('status',q.status,'error_code',q.error_code,'revision',q.revision) FROM public.generation_plans q WHERE q.id=p.id));
 EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS diagnostic_state=RETURNED_SQLSTATE,diagnostic_message=MESSAGE_TEXT,
   diagnostic_context=PG_EXCEPTION_CONTEXT,diagnostic_detail=PG_EXCEPTION_DETAIL,diagnostic_hint=PG_EXCEPTION_HINT;
  IF diagnostic_message='RESUME_DIAGNOSTIC_ROLLBACK' THEN
   receipt:=jsonb_build_object('status','checked','count',0,'would_resume',true,'would_resume_jobs',resumed_jobs,'mutation_rolled_back',true);
  ELSE
   receipt:=jsonb_build_object('status','refused','count',0,'code',CASE WHEN diagnostic_message IN (
   'RESUME_DATABASE_IDENTITY_MISMATCH','RESUME_RELEASE_NOT_VERIFIED','RESUME_RESTORE_IN_PROGRESS','RESUME_OWNER_REQUIRED',
   'RESUME_PLAN_NOT_CURRENT','RESUME_DIFFERENT_BLOCKER','RESUME_REVISION_CHANGED','RESUME_JOB_STATE_CHANGED','RESUME_PROVIDER_ACTIVITY_EXISTS',
   'RESUME_IMMUTABLE_STATE_CHANGED','RESUME_RETAINED_STATE_CHANGED','RESUME_CANONICAL_RETRY_NOT_CONFIRMED',
   'STALE_INPUT','USAGE_REVIEW_REQUIRED','GENERATION_BUSY','REVISION_CONFLICT','ROLE_FORBIDDEN') THEN diagnostic_message ELSE 'RESUME_CANONICAL_COMMAND_FAILED' END,
    'private_diagnostics',jsonb_build_object('stage',diagnostic_stage,'sqlstate',diagnostic_state,
      'message',left(diagnostic_message,2000),'context',left(diagnostic_context,12000),
      'detail',left(diagnostic_detail,2000),'hint',left(diagnostic_hint,2000)));
  END IF;
  -- These diagnostics are encrypted by the caller. They never reach stdout.
  -- An unavailable read-only diagnostic must not mask the original exception.
  BEGIN
   private_state:=jsonb_build_object('database',current_database(),'role',current_user,
    'auth_schema_usage',has_schema_privilege(current_user,'auth','USAGE'),
    'auth_users_select',has_table_privilege(current_user,'auth.users','SELECT'),
    'active_owner_memberships',(SELECT count(*) FROM public.memberships m JOIN public.identity_allowlist a
      ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id WHERE m.workspace_id=(selected->>'workspace_id')::uuid
       AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner'),
    'selected_plan',(SELECT jsonb_build_object('status',q.status,'error_code',q.error_code,'revision',q.revision,
      'evidence_revision',q.evidence_revision) FROM public.generation_plans q WHERE q.id=(selected->>'plan_id')::uuid
      AND q.workspace_id=(selected->>'workspace_id')::uuid));
   receipt:=receipt||jsonb_build_object('private_state',private_state);
   IF has_schema_privilege(current_user,'auth','USAGE') AND has_table_privilege(current_user,'auth.users','SELECT') THEN
    SELECT jsonb_build_object('matching_auth_rows',count(*),
      'email_confirmed',count(*) FILTER(WHERE u.email_confirmed_at IS NOT NULL),
      'deleted',count(*) FILTER(WHERE nullif(to_jsonb(u)->>'deleted_at','') IS NOT NULL),
      'currently_banned',count(*) FILTER(WHERE coalesce(nullif(to_jsonb(u)->>'banned_until','')::timestamptz,'-infinity')>now()),
      'usable_auth_rows',count(*) FILTER(WHERE nullif(to_jsonb(u)->>'deleted_at','') IS NULL
       AND coalesce(nullif(to_jsonb(u)->>'banned_until','')::timestamptz,'-infinity')<=now())) INTO auth_state
      FROM public.memberships m JOIN public.identity_allowlist a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
      JOIN auth.users u ON u.id=m.user_id WHERE m.workspace_id=(selected->>'workspace_id')::uuid
       AND m.active AND m.role='Owner' AND a.status='active' AND a.role='Owner';
    receipt:=receipt||jsonb_build_object('private_state',private_state||jsonb_build_object('owner_auth_state',auth_state));
   END IF;
  EXCEPTION WHEN OTHERS THEN NULL; END;
 END;
 PERFORM set_config('tenderdesk.requested_processing_receipt',receipt::text,true);
END $requested_resume$;
SELECT current_setting('tenderdesk.requested_processing_receipt'); COMMIT;
""".replace("__SELECTION__", literal).replace("__IDEMPOTENCY_KEY__", key).replace("__MIGRATION_HASH__", migration_hash).replace("__DIAGNOSE_ONLY__", "true" if diagnose_only else "false")


def public_receipt(receipt):
    if not isinstance(receipt, dict) or receipt.get("status") not in {"resumed", "already_active", "already_completed", "checked", "refused"}:
        raise ResumeError("RESUME_RECEIPT_INVALID")
    expected = 1 if receipt["status"] == "resumed" else 0
    if type(receipt.get("count")) is not int or receipt["count"] != expected:
        raise ResumeError("RESUME_RECEIPT_INVALID")
    return {"requested_processing_resume": receipt["status"], "count": receipt["count"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selection-object", required=True)
    parser.add_argument("--selection-sha256", required=True)
    parser.add_argument("--expected-runtime-image", required=True)
    parser.add_argument("--diagnose-only", action="store_true")
    args = parser.parse_args(argv)
    directory = client = None
    code = None
    receipt = None
    try:
        if not re.fullmatch(r"requests/[A-Za-z0-9][A-Za-z0-9._/-]{0,160}\.bundle", args.selection_object) or not re.fullmatch(r"[a-f0-9]{64}", args.selection_sha256):
            raise ResumeError("RESUME_SELECTION_REFERENCE_INVALID")
        transfer.identity(BUCKET, args.selection_object)
        os.umask(0o077)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            directory = access.prepare_cluster()
            verify_runtime(args.expected_runtime_image)
            path = directory / "selection.json"
            transfer.download(os.environ["DIGITALOCEAN_ACCESS_TOKEN"], BUCKET, args.selection_object, path, args.selection_sha256)
            raw = transfer.read_private(path)
            if len(raw) > 8192:
                raise ResumeError("RESUME_SELECTION_INVALID")
            selection = validate_selection(json.loads(raw))
            client = observer.Client(120)
            client.labels["app.kubernetes.io/managed-by"] = "tenderdesk-requested-processing-resume"
            client.prepare()
            receipt = json.loads(access.d.sql(client.pod, recovery_sql(selection, diagnose_only=args.diagnose_only)))
            public_receipt(receipt)
            output = directory / "receipt.json"
            transfer.write_private(output, json.dumps(receipt, ensure_ascii=False).encode())
            transfer.upload(os.environ["DIGITALOCEAN_ACCESS_TOKEN"], BUCKET,
                            "diagnostics/requested-processing-resume-" + os.environ["GITHUB_RUN_ID"] + ".bundle", output)
    except Exception as error:
        code = str(error) if isinstance(error, (ResumeError, observer.ObserverError, access.TransferError,
            access.d.DeployError, access.d.probe.ProbeError, transfer.TransferError)) and re.fullmatch(r"[A-Z0-9_]{1,100}", str(error)) else "RESUME_REQUESTED_PROCESSING_FAILED"
    finally:
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                if client is not None:
                    client.cleanup()
        except Exception:
            code = "RESUME_CLIENT_CLEANUP_NOT_CONFIRMED"
        try:
            if directory is not None:
                shutil.rmtree(directory)
        except Exception:
            code = "RESUME_RUNNER_CLEANUP_NOT_CONFIRMED"
    if code is not None:
        print(json.dumps({"requested_processing_resume": "failed", "code": code}), flush=True)
        return 1
    print(json.dumps(public_receipt(receipt)), flush=True)
    return 1 if receipt["status"] == "refused" else 0


if __name__ == "__main__":
    sys.exit(main())
