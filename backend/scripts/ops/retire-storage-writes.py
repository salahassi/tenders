#!/usr/bin/env python3
"""Explicit private selection only. Never runs as maintenance/bootstrap."""
import argparse
from contextlib import redirect_stdout,redirect_stderr
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('storage_retirement_runner',HERE/'storage-retirement/kubernetes.py')
k=importlib.util.module_from_spec(spec);sys.modules[spec.name]=k;spec.loader.exec_module(k)
c,base=k.c,k.base

def cleanup_existing():
 run,attempt=os.environ.get('GITHUB_RUN_ID',''),os.environ.get('GITHUB_RUN_ATTEMPT','')
 c.require(re.fullmatch('[0-9]{1,20}',run) and re.fullmatch('[0-9]{1,6}',attempt),'STORAGE_RETIREMENT_RUN_IDENTITY_INVALID')
 directory=Path(os.environ['RUNNER_TEMP'])/('td-sources-'+run+'-'+attempt);journal=directory/'storage-retirement-journal.json'
 if not journal.exists():return
 c.require(not directory.is_symlink() and not journal.is_symlink() and journal.stat().st_size<=1048576 and not journal.stat().st_mode&0o077,'STORAGE_RETIREMENT_JOURNAL_INVALID')
 value=json.loads(base.transfer.read_private(journal));selection=c.validate_selection(value['selection']);client_state=value['client'];nonce=client_state.get('nonce')
 c.require(value.get('version')==1 and value.get('nonce')==selection['operation_nonce'] and isinstance(nonce,str) and re.fullmatch('[a-f0-9]{8}',nonce),'STORAGE_RETIREMENT_JOURNAL_INVALID')
 expected_base='assess-observer-'+run+'-'+attempt+'-'+nonce
 expected={'base':expected_base,'nonce':nonce,'pod':expected_base+'-pg','secret':expected_base+'-db','labels':{'app.kubernetes.io/managed-by':k.MARKER,'tenderdesk.io/observation':nonce},'timeout':1500}
 c.require(client_state==expected,'STORAGE_RETIREMENT_JOURNAL_INVALID')
 os.environ.update(KUBECTL=str(directory/'kubectl'),KUBECONFIG=str(directory/'kubeconfig'))
 client=object.__new__(base.observer.Client);client.__dict__.update(client_state)
 adapter=k.KubernetesAdapter(directory,client,selection)
 adapter.physical_uid=value.get('physical_uid')
 try:
  if value.get('capture') is not None:adapter.restore(value['capture'],selection['operation_nonce'])
 finally:client.cleanup()

def main(argv=None):
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--selection-object');parser.add_argument('--selection-sha256');parser.add_argument('--mode',choices=['retire','restore-services','reconcile-processes'],default='restore-services');parser.add_argument('--cleanup',action='store_true');a=parser.parse_args(argv)
 directory=client=None;error=None;receipt=None;report_hash=None
 try:
  with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):
   if a.cleanup:cleanup_existing();return 0
   c.require(isinstance(a.selection_object,str) and re.fullmatch(r'requests/[A-Za-z0-9][A-Za-z0-9._/-]{0,160}\.bundle',a.selection_object) and isinstance(a.selection_sha256,str) and re.fullmatch('[a-f0-9]{64}',a.selection_sha256),'STORAGE_RETIREMENT_SELECTION_REFERENCE_INVALID')
   base.transfer.identity(base.BUCKET,a.selection_object);os.umask(0o077);directory=base.access.prepare_cluster()
   path=directory/'selection.json';base.transfer.download(os.environ['DIGITALOCEAN_ACCESS_TOKEN'],base.BUCKET,a.selection_object,path,a.selection_sha256)
   raw=base.transfer.read_private(path);c.require(len(raw)<=65536,'STORAGE_RETIREMENT_SELECTION_INVALID');selection=c.validate_selection(json.loads(raw))
   client=base.observer.Client(1500);client.labels['app.kubernetes.io/managed-by']=k.MARKER
   adapter=k.KubernetesAdapter(directory,client,selection);adapter.save()
   if a.mode=='retire':client.prepare()
   if a.mode=='restore-services':adapter.restore(adapter.recovery_capture(),selection['operation_nonce']);receipt={'mode':a.mode,'services_restored':True,'quota_retired':False}
   elif a.mode=='reconcile-processes':adapter.drain_saved_processes();receipt={'mode':a.mode,'services_restored':True,'quota_retired':False,'old_processes_reconciled':True}
   else:receipt={'mode':a.mode,'batch':c.retire(adapter,selection),'services_restored':True}
   output=directory/'receipt.json';base.transfer.write_private(output,c.canonical(receipt).encode())
   report_hash=base.transfer.upload(os.environ['DIGITALOCEAN_ACCESS_TOKEN'],base.BUCKET,'diagnostics/storage-retirement-'+os.environ['GITHUB_RUN_ID']+'.bundle',output)
 except Exception as e:
  text=str(e);error=text if re.fullmatch('[A-Z0-9_]{1,100}',text) else 'STORAGE_RETIREMENT_FAILED'
 finally:
  try:
   with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):
    if client:client.cleanup()
  except Exception:error='STORAGE_RETIREMENT_CLIENT_CLEANUP_REQUIRED'
  # Keep this job's private journal for the always() recovery step if retirement
  # or service restoration failed. That step retries restoration before deletion.
  if directory and error is None:shutil.rmtree(directory)
 print(json.dumps({'storage_retirement':'failed' if error else 'passed',**({'code':error} if error else {'mode':a.mode,'private_receipt_sha256':report_hash,'services_restored':True})}),flush=True)
 return 1 if error else 0
if __name__=='__main__':sys.exit(main())
