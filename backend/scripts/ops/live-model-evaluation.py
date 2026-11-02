#!/usr/bin/env python3
"""Run explicitly activated bounded synthetic model evaluations using live catalog bindings.

Database reads only. Synthetic inputs stay in the child process; no application
job, proposal, user, or permission is created or updated. Runtime keys cross stdin
in memory and are never placed in logs, artifacts, files, or command arguments.
"""
from __future__ import annotations
from contextlib import redirect_stdout, redirect_stderr
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

observer = load('live_eval_observer', 'observe-assessment-recovery.py')
transfer = load('live_eval_transfer', 'private-transfer.py')
access = observer.access
BUCKET = 'tenderdesk-migration-a6093a76-sfo3'
CATALOG_SQL = """BEGIN READ ONLY;
SET LOCAL ROLE tdp_app_owner; SET LOCAL statement_timeout='15s';
DO $$ BEGIN
 IF current_database()<>'tenderdesk_app' OR (SELECT count(*) FROM public.workspaces)<>1
 OR NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id='__WORKSPACE__')
 THEN RAISE EXCEPTION 'EVAL_DATABASE_MISMATCH'; END IF;
END $$;
SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (
 SELECT c.provider,c.credential_alias,c.project_ref,m.model,m.capabilities
 FROM public.model_connections c JOIN public.model_configurations m
 ON m.connection_id=c.id AND m.workspace_id=c.workspace_id
 WHERE c.workspace_id='__WORKSPACE__' AND c.enabled AND m.enabled
 AND c.provider IN ('openai','qwencloud') ORDER BY c.provider,m.model LIMIT 5
)t; COMMIT;""".replace('__WORKSPACE__', access.WORKSPACE)

class EvaluationError(Exception):
    pass

def targets(catalog, bindings):
    if not isinstance(catalog, list) or not 1 <= len(catalog) <= 4:
        raise EvaluationError('EVAL_CATALOG_LIMIT')
    result = []
    for row in catalog:
        if not isinstance(row, dict) or set(row) != {'provider','credential_alias','project_ref','model','capabilities'}:
            raise EvaluationError('EVAL_CATALOG_INVALID')
        alias = row['credential_alias']
        if row['provider'] not in {'openai','qwencloud'} or not isinstance(alias, str) or not re.fullmatch(r'APP_MODEL_[A-Z0-9_]{1,80}_KEY', alias):
            raise EvaluationError('EVAL_CREDENTIAL_ALIAS_INVALID')
        if not bindings.get(alias):
            raise EvaluationError('EVAL_CONFIGURED_KEY_MISSING')
        result.append({k: row[k] for k in ('provider','model','project_ref','capabilities')} | {'key': bindings[alias]})
    if {r['provider'] for r in result} != {'openai','qwencloud'}:
        raise EvaluationError('EVAL_BOTH_PROVIDERS_REQUIRED')
    return result

def validate_report(report, count):
    if (not isinstance(report, dict) or report.get('version') != 1 or report.get('synthetic') is not True
        or report.get('production_records_created') != 0 or report.get('model_count') != count
        or type(report.get('generations')) is not int or not 0 <= report['generations'] <= 32
        or type(report.get('complete')) is not bool or not isinstance(report.get('results'), list)
        or (len(report['results']) != count * 8 if report.get('complete') else not 0 <= len(report['results']) <= count * 8)
        or type(report.get('passed')) is not bool):
        raise EvaluationError('EVAL_REPORT_INVALID')
    if any(type(r.get('passed')) is not bool for r in report['results']):
        raise EvaluationError('EVAL_REPORT_INVALID')
    return report

def parse_execution_output(raw, count, success):
    lines = []
    nonempty = [line for line in raw.splitlines() if line.strip()]
    for i,line in enumerate(nonempty):
        try: lines.append(json.loads(line))
        except ValueError:
            if success or i != len(nonempty)-1: raise EvaluationError('EVAL_REPORT_INVALID')
    final = next((line['report'] for line in reversed(lines) if 'report' in line), None)
    if success and final is not None: return validate_report(final, count)
    progress = [line['progress'] for line in lines if 'progress' in line]
    results = [p['result'] for p in progress]
    last = progress[-1] if progress else {'generations':0,'requests':0}
    return validate_report({'version':1,'complete':False,'synthetic':True,'production_records_created':0,
      'model_count':count,'generations':last['generations'],'requests':last['requests'],'results':results,'passed':False,
      'failure':'EVAL_PROCESS_INTERRUPTED','generation_count_is_lower_bound':True,'unreported_in_flight':True,
      'measured_input_tokens':sum((r.get('usage') or {}).get('input') or 0 for r in results),
      'measured_output_tokens':sum((r.get('usage') or {}).get('output') or 0 for r in results),
      'unknown_usage_cases':sum(not r.get('usage') or r['usage'].get('input') is None or r['usage'].get('output') is None for r in results)},count)

def main():
    if os.environ.get('RUN_LIVE_AI_EVALUATION') != 'true':
        print('{"live_ai_evaluation":"not_activated"}')
        return 0
    directory = client = None
    failure = None
    receipt = None
    stage = 'initialize'
    private_output = io.StringIO()
    diagnostic = {}
    try:
        os.umask(0o077)
        with redirect_stdout(private_output), redirect_stderr(io.StringIO()):
            stage = 'cluster_prepare'
            directory = access.prepare_cluster()
            client = observer.Client(120)
            stage = 'database_prepare'
            client.prepare()
            stage = 'catalog_read'
            catalog = json.loads(access.d.sql(client.pod, CATALOG_SQL))
            stage = 'routing_read'
            routing = json.loads(access.d.sql(client.pod, (HERE / 'ai-routing-diagnostic.sql').read_text().replace('__WORKSPACE__', access.WORKSPACE)))
            stage = 'target_selection'
            selected = targets(catalog, access.d.decode_secret(access.d.get('secret', 'tenderdesk-runtime')))
            # Release database credentials before making provider calls.
            stage = 'database_cleanup'
            client.cleanup(); client = None
            stage = 'provider_evaluation'
            try:
                execution = subprocess.run(['node','--experimental-transform-types',str(HERE / 'live-model-evaluation.mjs')],
                    input=json.dumps(selected), capture_output=True, text=True, timeout=2400,
                    env={k:v for k,v in os.environ.items() if k not in {'DIGITALOCEAN_ACCESS_TOKEN','GH_TOKEN','GITHUB_TOKEN'}})
                output, success = execution.stdout, execution.returncode == 0
            except subprocess.TimeoutExpired as error:
                output = error.stdout or ''
                if isinstance(output, bytes): output = output.decode('utf-8')
                success = False
            if len(output.encode()) > 2_000_000: raise EvaluationError('EVAL_REPORT_TOO_LARGE')
            stage = 'report_parse'
            report = parse_execution_output(output, len(selected), success)
            report['routing_diagnosis'] = routing
            report['source_sha'] = os.environ.get('GITHUB_SHA', '')
            for row in selected:
                if row['key'] in json.dumps(report):
                    raise EvaluationError('EVAL_SECRET_IN_REPORT')
            stage = 'report_write'
            path = directory / 'live-ai-evaluation.json'
            transfer.write_private(path, json.dumps(report, ensure_ascii=False).encode())
            stage = 'report_upload'
            digest = transfer.upload(os.environ['DIGITALOCEAN_ACCESS_TOKEN'], BUCKET,
                'diagnostics/live-ai-evaluation-' + os.environ['GITHUB_RUN_ID'] + '.bundle', path)
            receipt = {'live_ai_evaluation':'passed' if report['passed'] else 'failed_cases',
                'models':report['model_count'], 'complete':report['complete'], 'cases':len(report['results']),
                'passed_cases':sum(x['passed'] for x in report['results']),
                'generations':report['generations'], 'unknown_usage_cases':report['unknown_usage_cases'],
                'input_tokens':report['measured_input_tokens'], 'output_tokens':report['measured_output_tokens'],
                'report_sha256':digest}
    except Exception as error:
        allowed = (EvaluationError, observer.ObserverError, access.TransferError, access.d.DeployError, access.d.probe.ProbeError, transfer.TransferError)
        failure = str(error) if isinstance(error, allowed) and re.fullmatch(r'[A-Z0-9_]{1,100}',str(error)) else 'EVAL_OPERATION_FAILED'
        for line in private_output.getvalue().splitlines():
            try:
                item = json.loads(line)
                if item.get('status') == 'sql_failed':
                    diagnostic = {'sqlstate':item.get('sqlstate') if re.fullmatch(r'[A-Z0-9]{5}',str(item.get('sqlstate'))) else 'unknown',
                        'line':item.get('line') if type(item.get('line')) is int else None}
            except (ValueError,AttributeError): pass
    finally:
        try:
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                if client is not None: client.cleanup()
            if directory is not None: shutil.rmtree(directory)
        except Exception:
            failure = 'EVAL_CLEANUP_FAILED'
    if failure:
        print(json.dumps({'live_ai_evaluation':'failed','code':failure,'stage':stage,**diagnostic})); return 1
    print(json.dumps(receipt)); return 0 if receipt['live_ai_evaluation'] == 'passed' else 1

if __name__ == '__main__':
    sys.exit(main())
