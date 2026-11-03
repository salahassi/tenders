#!/usr/bin/env python3
"""Create one reviewed canonical successor while retaining paid proposal history.

Default check mode rolls back all canonical commands. Restart requires explicit
activation, an encrypted exact inspected selection and the reviewed live runtime.
No usage, correction budget, prompt pin, admission or content grant is reset.
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
SPEC = importlib.util.spec_from_file_location('proposal_successor_inspector', HERE / 'proposal-recovery.py')
r = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = r
SPEC.loader.exec_module(r)


class SuccessorError(Exception):
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
    keys = {'version','workspace_id','opportunity_id','plan_id','proposal_id','expected_plan_revision',
            'expected_opportunity_revision','expected_proposal_revision','expected_workspace_evidence_revision',
            'expected_frozen_snapshot_sha256','expected_prospective_snapshot_sha256','expected_input_hash','expected_jobs','expected_documents',
            'expected_usage','expected_admission','expected_workflow_version','expected_runtime_image'}
    if not isinstance(value, dict) or set(value) != keys or type(value['version']) is not int or value['version'] != 1:
        raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
    if any(not uuid_value(value[key]) for key in ('workspace_id','opportunity_id','plan_id','proposal_id')) or value['workspace_id'] != r.access.WORKSPACE:
        raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
    if any(not positive(value[key]) for key in ('expected_plan_revision','expected_opportunity_revision','expected_proposal_revision','expected_workspace_evidence_revision')):
        raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
    if any(not digest(value[key]) for key in ('expected_frozen_snapshot_sha256','expected_prospective_snapshot_sha256','expected_input_hash')):
        raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
    if type(value['expected_workflow_version']) is not int or value['expected_workflow_version'] not in (1,3):
        raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
    if not isinstance(value['expected_runtime_image'],str) or not re.fullmatch(r'registry\.digitalocean\.com/tenderdesk-a6093a76/runtime@sha256:[a-f0-9]{64}',value['expected_runtime_image']):
        raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
    for field,maximum,properties in [('expected_jobs',300,{'id','revision'}),('expected_usage',2000,{'id','record_sha256'})]:
        rows=value[field]
        if not isinstance(rows,list) or not 1<=len(rows)<=maximum or any(not isinstance(row,dict) or set(row)!=properties or not uuid_value(row['id']) for row in rows):
            raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
        if len({row['id'] for row in rows}) != len(rows):
            raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
        if any(not (positive(row['revision']) if field=='expected_jobs' else digest(row['record_sha256'])) for row in rows):
            raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
    documents=value['expected_documents']
    document_keys={'id','revision','kind','status','archived','original_hash','extraction_hash','extracted_characters'}
    if not isinstance(documents,list) or not 1<=len(documents)<=1000:
        raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
    for document in documents:
        if (not isinstance(document,dict) or set(document)!=document_keys or not uuid_value(document['id']) or not positive(document['revision'])
            or document['kind']!='rfp' or document['status'] not in ('pending','ready','needs_ocr','needs_processing','error','expired')
            or type(document['archived']) is not bool or not digest(document['original_hash'])
            or (document['extraction_hash'] is not None and not digest(document['extraction_hash']))
            or type(document['extracted_characters']) is not int or document['extracted_characters']<0):
            raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
    if len({d['id'] for d in documents}) != len(documents):
        raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
    admission=value['expected_admission']
    if admission is not None and (not isinstance(admission,dict) or set(admission)!={'enabled','trial_opportunity_id','selected_target_admitted'}
        or type(admission['enabled']) is not bool or type(admission['selected_target_admitted']) is not bool
        or (admission['trial_opportunity_id'] is not None and not uuid_value(admission['trial_opportunity_id']))):
        raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
    if value['expected_workflow_version'] != (3 if admission and admission['selected_target_admitted'] else 1):
        raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
    return value


def selection_from_inspection(report):
    r.public_receipt(report)
    plan,opportunity,proposal=report['plan'],report['opportunity'],report['proposal']
    images=report['runtime_images']
    if images['api']!=images['worker'] or report['latest_plan']['id']!=plan['id']:
        raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
    admission=report['workflow_admission']
    selection={'version':1,**report['selection'],'proposal_id':proposal['id'],
      'expected_plan_revision':plan['revision'],'expected_opportunity_revision':opportunity['revision'],
      'expected_proposal_revision':proposal['revision'],'expected_workspace_evidence_revision':report['workspace_evidence_revision'],
      'expected_frozen_snapshot_sha256':plan['frozen_snapshot_sha256'],'expected_prospective_snapshot_sha256':report['prospective_draft_snapshot_sha256'],'expected_input_hash':plan['input_hash'],
      'expected_jobs':sorted([{'id':j['id'],'revision':j['revision']} for j in report['jobs'] if j['plan_id']==plan['id']],key=lambda j:j['id']),
      'expected_documents':sorted(report['documents'],key=lambda d:d['id']),
      'expected_usage':sorted([{'id':u['id'],'record_sha256':u['record_sha256']} for u in report['usage'] if u['job_id'] in {j['id'] for j in report['jobs'] if j['plan_id']==plan['id']}],key=lambda u:u['id']),
      'expected_admission':admission,'expected_workflow_version':3 if admission and admission['selected_target_admitted'] else 1,
      'expected_runtime_image':images['api']}
    return validate_selection(selection)


def recovery_sql(selection, *, restart=False):
    validate_selection(selection)
    if type(restart) is not bool:
        raise SuccessorError('PROPOSAL_SUCCESSOR_MODE_INVALID')
    encoded=json.dumps(selection,sort_keys=True,separators=(',',':'))
    selection_hash=hashlib.sha256(encoded.encode()).hexdigest()
    literal="'"+encoded.replace("'","''")+"'::jsonb"
    return (HERE/'proposal-successor.sql').read_text().replace('__SELECTION__',literal).replace('__HISTORY_SNAPSHOT__',(HERE/'proposal-successor-history.sql').read_text()).replace('__SELECTION_HASH__',selection_hash).replace('__RESTART__','true' if restart else 'false')


def public_receipt(receipt,report_sha256=None):
    if not isinstance(receipt,dict) or receipt.get('status') not in {'checked','started','already_started','refused'}:
        raise SuccessorError('PROPOSAL_SUCCESSOR_RECEIPT_INVALID')
    expected=1 if receipt['status']=='started' else 0
    if type(receipt.get('count')) is not int or receipt['count']!=expected:
        raise SuccessorError('PROPOSAL_SUCCESSOR_RECEIPT_INVALID')
    result={'proposal_successor':receipt['status'],'count':receipt['count']}
    if report_sha256 is not None:
        if not digest(report_sha256):raise SuccessorError('PROPOSAL_SUCCESSOR_RECEIPT_INVALID')
        result['report_sha256']=report_sha256
    return result


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--selection-object',required=True)
    parser.add_argument('--selection-sha256',required=True)
    parser.add_argument('--restart',action='store_true')
    args=parser.parse_args(argv)
    directory=client=receipt=report_sha256=None
    code=None
    try:
        if not re.fullmatch(r'requests/[A-Za-z0-9][A-Za-z0-9._/-]{0,160}\.bundle',args.selection_object) or not digest(args.selection_sha256):
            raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_REFERENCE_INVALID')
        r.transfer.identity(r.BUCKET,args.selection_object)
        os.umask(0o077)
        with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):
            directory=r.access.prepare_cluster()
            path=directory/'selection.json'
            r.transfer.download(os.environ['DIGITALOCEAN_ACCESS_TOKEN'],r.BUCKET,args.selection_object,path,args.selection_sha256)
            raw=r.transfer.read_private(path)
            if len(raw)>262144:raise SuccessorError('PROPOSAL_SUCCESSOR_SELECTION_INVALID')
            selection=validate_selection(json.loads(raw))
            r.base.verify_runtime(selection['expected_runtime_image'])
            client=r.observer.Client(180)
            client.labels['app.kubernetes.io/managed-by']='tenderdesk-proposal-successor'
            client.prepare()
            # Recheck after client preparation; both workloads must still serve
            # the exact reviewed immutable image before the transaction starts.
            r.base.verify_runtime(selection['expected_runtime_image'])
            receipt=json.loads(r.access.d.sql(client.pod,recovery_sql(selection,restart=args.restart)))
            public_receipt(receipt)
            output=directory/'receipt.json'
            r.transfer.write_private(output,json.dumps(receipt,ensure_ascii=False).encode())
            report_sha256=r.transfer.upload(os.environ['DIGITALOCEAN_ACCESS_TOKEN'],r.BUCKET,
                'diagnostics/proposal-successor-'+os.environ['GITHUB_RUN_ID']+'.bundle',output)
    except Exception as error:
        code=str(error) if isinstance(error,(SuccessorError,r.base.ResumeError,r.observer.ObserverError,r.access.TransferError,
            r.access.d.DeployError,r.access.d.probe.ProbeError,r.transfer.TransferError,r.base.release.u.UpdateError)) and re.fullmatch(r'[A-Z0-9_]{1,100}',str(error)) else 'PROPOSAL_SUCCESSOR_FAILED'
    finally:
        try:
            with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):
                if client is not None:client.cleanup()
        except Exception:code='PROPOSAL_SUCCESSOR_CLIENT_CLEANUP_NOT_CONFIRMED'
        try:
            if directory is not None:shutil.rmtree(directory)
        except Exception:code='PROPOSAL_SUCCESSOR_RUNNER_CLEANUP_NOT_CONFIRMED'
    if code:
        print(json.dumps({'proposal_successor':'failed','code':code}),flush=True)
        return 1
    print(json.dumps(public_receipt(receipt,report_sha256)),flush=True)
    return 1 if receipt['status']=='refused' else 0


if __name__=='__main__':sys.exit(main())
