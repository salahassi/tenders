#!/usr/bin/env python3
"""Request fresh verification of one retained settled analysis candidate.

Default check mode rolls back all canonical commands. Activation requires explicit
activation, an encrypted exact inspected selection and the reviewed live runtime.
No writer is resent. Old usage, candidate, pins, budgets and siblings are retained.
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
SPEC = importlib.util.spec_from_file_location('proposal_verifier_recheck_inspector', HERE / 'proposal-recovery.py')
r = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = r
SPEC.loader.exec_module(r)


class RecheckError(Exception):
    pass


def uuid_value(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def positive(value):
    return type(value) is int and 1 <= value <= 9007199254740991


def digest(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{64}', value) is not None


def validate_selection(value):
    keys={'version','workspace_id','opportunity_id','plan_id','proposal_id','expected_runtime_image','payload'}
    if not isinstance(value,dict) or set(value)!=keys or type(value['version']) is not int or value['version']!=1:
        raise RecheckError('PROPOSAL_RECHECK_SELECTION_INVALID')
    if any(not uuid_value(value[key]) for key in ('workspace_id','opportunity_id','plan_id','proposal_id')) or value['workspace_id']!=r.access.WORKSPACE:
        raise RecheckError('PROPOSAL_RECHECK_SELECTION_INVALID')
    if not isinstance(value['expected_runtime_image'],str) or not re.fullmatch(r'registry\.digitalocean\.com/tenderdesk-a6093a76/runtime@sha256:[a-f0-9]{64}',value['expected_runtime_image']):
        raise RecheckError('PROPOSAL_RECHECK_SELECTION_INVALID')
    payload=value['payload']
    fields={'id','expected_revision','expected_plan_revision','expected_step_revision','parent_thread_id','candidate_id','candidate_content_hash','candidate_hash','writer_usage_id','expected_input_hash','expected_graph_input_hash','reason'}
    if not isinstance(payload,dict) or set(payload)!=fields:
        raise RecheckError('PROPOSAL_RECHECK_SELECTION_INVALID')
    if any(not uuid_value(payload[key]) for key in ('id','candidate_id','writer_usage_id')):
        raise RecheckError('PROPOSAL_RECHECK_SELECTION_INVALID')
    if any(not positive(payload[key]) for key in ('expected_revision','expected_plan_revision','expected_step_revision')):
        raise RecheckError('PROPOSAL_RECHECK_SELECTION_INVALID')
    if any(not digest(payload[key]) for key in ('parent_thread_id','candidate_content_hash','candidate_hash','expected_input_hash','expected_graph_input_hash')):
        raise RecheckError('PROPOSAL_RECHECK_SELECTION_INVALID')
    if payload['reason']!='Owner requested fresh verification of the retained settled analysis writer under the corrected source-block verification contract.':
        raise RecheckError('PROPOSAL_RECHECK_SELECTION_INVALID')
    return value


def recovery_sql(selection, *, activate=False):
    validate_selection(selection)
    if type(activate) is not bool:raise RecheckError('PROPOSAL_RECHECK_MODE_INVALID')
    encoded=json.dumps(selection,sort_keys=True,separators=(',',':'))
    selection_hash=hashlib.sha256(encoded.encode()).hexdigest()
    literal="'"+encoded.replace("'","''")+"'::jsonb"
    return (HERE/'proposal-verifier-recheck.sql').read_text().replace('__SELECTION__',literal).replace('__HISTORY__',(HERE/'proposal-verifier-recheck-history.sql').read_text()).replace('__SELECTION_HASH__',selection_hash).replace('__ACTIVATE__','true' if activate else 'false')


def public_receipt(receipt,report_sha256=None):
    if not isinstance(receipt,dict) or receipt.get('status') not in {'checked','started','already_started','refused'}:
        raise RecheckError('PROPOSAL_RECHECK_RECEIPT_INVALID')
    expected=1 if receipt['status']=='started' else 0
    if type(receipt.get('count')) is not int or receipt['count']!=expected:
        raise RecheckError('PROPOSAL_RECHECK_RECEIPT_INVALID')
    result={'proposal_verifier_recheck':receipt['status'],'count':receipt['count']}
    if report_sha256 is not None:
        if not digest(report_sha256):raise RecheckError('PROPOSAL_RECHECK_RECEIPT_INVALID')
        result['report_sha256']=report_sha256
    return result


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--selection-object',required=True)
    parser.add_argument('--selection-sha256',required=True)
    parser.add_argument('--activate',action='store_true')
    args=parser.parse_args(argv)
    directory=client=receipt=report_sha256=None
    code=None
    try:
        if not re.fullmatch(r'requests/[A-Za-z0-9][A-Za-z0-9._/-]{0,160}\.bundle',args.selection_object) or not digest(args.selection_sha256):
            raise RecheckError('PROPOSAL_RECHECK_SELECTION_REFERENCE_INVALID')
        r.transfer.identity(r.BUCKET,args.selection_object)
        os.umask(0o077)
        with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):
            directory=r.access.prepare_cluster()
            path=directory/'selection.json'
            r.transfer.download(os.environ['DIGITALOCEAN_ACCESS_TOKEN'],r.BUCKET,args.selection_object,path,args.selection_sha256)
            raw=r.transfer.read_private(path)
            if len(raw)>262144:raise RecheckError('PROPOSAL_RECHECK_SELECTION_INVALID')
            selection=validate_selection(json.loads(raw))
            r.base.verify_runtime(selection['expected_runtime_image'])
            client=r.observer.Client(180)
            client.labels['app.kubernetes.io/managed-by']='tenderdesk-proposal-verifier-recheck'
            client.prepare()
            # Recheck after client preparation; both workloads must still serve
            # the exact reviewed immutable image before the transaction starts.
            r.base.verify_runtime(selection['expected_runtime_image'])
            receipt=json.loads(r.access.d.sql(client.pod,recovery_sql(selection,activate=args.activate)))
            public_receipt(receipt)
            output=directory/'receipt.json'
            r.transfer.write_private(output,json.dumps(receipt,ensure_ascii=False).encode())
            report_sha256=r.transfer.upload(os.environ['DIGITALOCEAN_ACCESS_TOKEN'],r.BUCKET,
                'diagnostics/proposal-verifier-recheck-'+os.environ['GITHUB_RUN_ID']+'.bundle',output)
            public_receipt(receipt,report_sha256)
    except Exception as error:
        code=str(error) if isinstance(error,(RecheckError,r.base.ResumeError,r.observer.ObserverError,r.access.TransferError,
            r.access.d.DeployError,r.access.d.probe.ProbeError,r.transfer.TransferError,r.base.release.u.UpdateError)) and re.fullmatch(r'[A-Z0-9_]{1,100}',str(error)) else 'PROPOSAL_RECHECK_FAILED'
    finally:
        try:
            with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):
                if client is not None:client.cleanup()
        except Exception:code='PROPOSAL_RECHECK_CLIENT_CLEANUP_NOT_CONFIRMED'
        try:
            if directory is not None:shutil.rmtree(directory)
        except Exception:code='PROPOSAL_RECHECK_RUNNER_CLEANUP_NOT_CONFIRMED'
    if code:
        print(json.dumps({'proposal_verifier_recheck':'failed','code':code}),flush=True)
        return 1
    print(json.dumps(public_receipt(receipt,report_sha256)),flush=True)
    return 1 if receipt['status']=='refused' else 0


if __name__=='__main__':sys.exit(main())
