#!/usr/bin/env python3
"""Privately export bounded blocked-work metadata without changing business state.

No model calls, retries, approval changes or workflow transitions occur. The only
cluster writes are nonce-owned temporary SQL-client resources, removed in finally.
Source documents, company knowledge, candidate bodies, prompts and credentials
are excluded from the export. Public output contains only a generic receipt.
"""
from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys


HERE = Path(__file__).resolve().parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


observer = load("blocked_work_observer", "observe-assessment-recovery.py")
access = observer.access
transfer = load("blocked_work_transfer", "private-transfer.py")
BUCKET = "tenderdesk-migration-a6093a76-sfo3"

# Every table scope is rooted in the configured existing workspace. Explicit
# projections prevent later schema columns or arbitrary serialized content from
# silently becoming diagnostic output. No opportunity identifier is embedded.
SQL = r"""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='25s';
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF current_database()<>'tenderdesk_app'
 OR (SELECT count(*) FROM public.workspaces)<>1
 OR NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id='__WORKSPACE__')
 THEN RAISE EXCEPTION 'BLOCKED_WORK_DATABASE_MISMATCH'; END IF;
END $$;
WITH plans AS MATERIALIZED (
 SELECT p.id,p.opportunity_id,p.kind,p.stage,p.status,p.error_code,p.input_hash,
        p.evidence_revision,p.workflow_version,p.execution_policy,
        p.created_at,p.updated_at,p.revision
 FROM public.generation_plans p
 WHERE p.workspace_id='__WORKSPACE__'
 AND (p.status IN ('blocked','failed') OR EXISTS(
   SELECT 1 FROM public.jobs j WHERE j.workspace_id=p.workspace_id
   AND j.entity_id=p.id AND j.status IN ('blocked','failed')))
 ORDER BY p.updated_at DESC,p.id DESC LIMIT 100
), jobs AS MATERIALIZED (
 SELECT j.id,j.entity_id AS plan_id,j.type,j.status,j.error_code,j.attempts,
        j.failure_count,j.next_attempt_at,j.cancel_requested,j.input_hash,
        j.created_at,j.updated_at,j.revision,
        jsonb_build_object(
          'model_executor',j.checkpoint->'model_executor',
          'graph_thread',j.checkpoint->'graph_thread',
          'model_operation',j.checkpoint->'model_operation',
          'model_round',j.checkpoint->'model_round',
          'model_routing',jsonb_build_object(
             'mode',j.checkpoint#>'{model_routing,mode}',
             'strategy',j.checkpoint#>'{model_routing,strategy}',
             'round_attempts',j.checkpoint#>'{model_routing,round_attempts}',
             'checks',j.checkpoint#>'{model_routing,checks}')) AS checkpoint
 FROM public.jobs j JOIN plans p ON p.id=j.entity_id
 WHERE j.workspace_id='__WORKSPACE__'
 ORDER BY CASE WHEN j.status IN ('blocked','failed') THEN 0 ELSE 1 END,
          j.updated_at DESC,j.id DESC LIMIT 500
), steps AS MATERIALIZED (
 SELECT s.id,s.plan_id,s.job_id,s.task,s.stage,s.ordinal,s.status,
        s.depth,s.repair_count,s.created_at,s.updated_at,s.revision
 FROM public.generation_steps s JOIN jobs j ON j.id=s.job_id
 WHERE s.workspace_id='__WORKSPACE__'
 ORDER BY s.updated_at DESC,s.id DESC LIMIT 500
), attempts AS MATERIALIZED (
 SELECT a.id,a.job_id,a.provider,a.model,a.operation,a.round_number,
        a.worker_attempt,a.status,a.result_code,a.sent,a.usage_id,
        a.started_at,a.finished_at,a.http_status,a.reported_model,
        a.finish_reason,a.request_phase,a.retry_after,
        a.provider_error_code,a.provider_error_type,a.provider_error_reason,
        a.connection_id,a.model_config_id,a.execution_metadata
 FROM public.model_attempts a JOIN jobs j ON j.id=a.job_id
 WHERE a.workspace_id='__WORKSPACE__'
 ORDER BY a.id DESC LIMIT 1500
), threads AS MATERIALIZED (
 SELECT t.id,t.job_id,t.input_hash,t.task,t.graph_version,t.budget_version,
        t.status,t.candidate_count,t.result_id,t.created_at,t.updated_at
 FROM app_private.model_graph_threads t JOIN jobs j ON j.id=t.job_id
 WHERE t.workspace_id='__WORKSPACE__'
 ORDER BY t.updated_at DESC,t.id DESC LIMIT 500
), budgets AS MATERIALIZED (
 SELECT b.thread_id,b.unit,b.candidates
 FROM app_private.model_graph_budgets b JOIN threads t ON t.id=b.thread_id
 WHERE b.workspace_id='__WORKSPACE__'
 ORDER BY b.thread_id,b.unit LIMIT 2000
), results AS MATERIALIZED (
 SELECT r.id,r.thread_id,r.result_key,r.content_hash,r.created_at,
        jsonb_build_object(
          'code',r.value->'code',
          'coverage',r.value->'coverage',
          'producer',r.value->'producer',
          'validation_diagnostics',r.value->'validation_diagnostics',
          'local_validation',r.value->'local_validation',
          'checked_candidate_hash',r.value#>'{result,checked_candidate_hash}',
          'reviewed_all_content',r.value#>'{result,reviewed_all_content}',
          'findings',(SELECT coalesce(jsonb_agg(jsonb_build_object(
              'severity',finding->'severity','code',finding->'code',
              'claim_ids',finding->'claim_ids','requirement_ids',finding->'requirement_ids')),'[]'::jsonb)
             FROM (SELECT value AS finding FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(r.value#>'{result,findings}')='array'
                 THEN r.value#>'{result,findings}' ELSE '[]'::jsonb END)
               WITH ORDINALITY f(value,ord) ORDER BY ord LIMIT 32) bounded_findings)
        ) AS diagnostic
 FROM app_private.model_graph_results r JOIN threads t ON t.id=r.thread_id
 WHERE r.workspace_id='__WORKSPACE__'
 ORDER BY r.created_at DESC,r.id DESC LIMIT 2000
), checkpoints AS MATERIALIZED (
 SELECT c.thread_id,c.namespace,c.checkpoint_id,c.parent_id,c.created_at,
        pg_column_size(c.checkpoint) AS encoded_checkpoint_bytes,
        pg_column_size(c.metadata) AS encoded_metadata_bytes
 FROM app_private.model_graph_checkpoints c JOIN threads t ON t.id=c.thread_id
 WHERE c.workspace_id='__WORKSPACE__'
 ORDER BY c.created_at DESC,c.thread_id DESC LIMIT 1500
)
SELECT jsonb_build_object(
 'version',1,'observed_at',now(),'workspace_id','__WORKSPACE__',
 'scope','bounded_recent_blocked_work_metadata',
 'plans',(SELECT coalesce(jsonb_agg(to_jsonb(p)),'[]') FROM plans p),
 'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j)),'[]') FROM jobs j),
 'steps',(SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') FROM steps s),
 'attempts',(SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]') FROM attempts a),
 'threads',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM threads t),
 'budgets',(SELECT coalesce(jsonb_agg(to_jsonb(b)),'[]') FROM budgets b),
 'results',(SELECT coalesce(jsonb_agg(to_jsonb(r)),'[]') FROM results r),
 'checkpoints',(SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]') FROM checkpoints c),
 'limits',jsonb_build_object('plans',100,'jobs',500,'steps',500,
   'attempts',1500,'threads',500,'budgets',2000,'results',2000,'checkpoints',1500)
); COMMIT;
""".replace("__WORKSPACE__", access.WORKSPACE)


class DiagnosticError(Exception):
    pass


def validate_result(value):
    expected = {"version", "observed_at", "workspace_id", "scope", "plans", "jobs",
                "steps", "attempts", "threads", "budgets", "results", "checkpoints", "limits"}
    limits = {"plans": 100, "jobs": 500, "steps": 500, "attempts": 1500,
              "threads": 500, "budgets": 2000, "results": 2000, "checkpoints": 1500}
    if (not isinstance(value, dict) or set(value) != expected
        or value["version"] != 1 or value["workspace_id"] != access.WORKSPACE
        or value["scope"] != "bounded_recent_blocked_work_metadata"
        or value["limits"] != limits or not isinstance(value["observed_at"], str)):
        raise DiagnosticError("BLOCKED_WORK_RESULT_INVALID")
    for name, limit in limits.items():
        if not isinstance(value[name], list) or len(value[name]) > limit:
            raise DiagnosticError("BLOCKED_WORK_RESULT_LIMIT_INVALID")
        if any(not isinstance(row, dict) for row in value[name]):
            raise DiagnosticError("BLOCKED_WORK_ROW_INVALID")
    return value


def safe_code(error):
    allowed = (DiagnosticError, observer.ObserverError, access.TransferError,
               access.d.DeployError, access.d.probe.ProbeError, transfer.TransferError)
    if isinstance(error, allowed) and re.fullmatch(r"[A-Z_0-9]{1,100}", str(error)):
        return str(error)
    return "BLOCKED_WORK_DIAGNOSTIC_FAILED"


def main():
    directory = None
    client = None
    code = None
    try:
        os.umask(0o077)
        # Suppress helper receipts too: even SQLSTATE diagnostics remain private.
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            directory = access.prepare_cluster()
            client = observer.Client(120)
            client.prepare()
            raw = access.d.sql(client.pod, SQL)
            if len(raw.encode("utf-8")) > 32 * 1024 * 1024:
                raise DiagnosticError("BLOCKED_WORK_EXPORT_TOO_LARGE")
            value = validate_result(json.loads(raw))
            path = directory / "blocked-work.json"
            transfer.write_private(path, json.dumps(value, ensure_ascii=False).encode("utf-8"))
            transfer.upload(os.environ["DIGITALOCEAN_ACCESS_TOKEN"], BUCKET,
                            "diagnostics/blocked-work-" + os.environ["GITHUB_RUN_ID"] + ".bundle", path)
    except Exception as error:
        code = safe_code(error)
    finally:
        # Cleanup errors are caught so Python never dumps credential-bearing
        # exception context or private subprocess output to a public runner log.
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                if client is not None:
                    client.cleanup()
        except Exception:
            code = "BLOCKED_WORK_CLIENT_CLEANUP_NOT_CONFIRMED"
        try:
            if directory is not None:
                shutil.rmtree(directory)
        except Exception:
            code = "BLOCKED_WORK_RUNNER_CLEANUP_NOT_CONFIRMED"
    if code is not None:
        print(json.dumps({"blocked_work_diagnostic": "failed", "code": code}), flush=True)
        return 1
    print('{"blocked_work_diagnostic":"uploaded"}', flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
