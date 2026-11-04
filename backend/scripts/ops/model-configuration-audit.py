#!/usr/bin/env python3
"""Read enabled model bindings and credential presence without calling providers."""
from contextlib import redirect_stdout, redirect_stderr
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('model_config_inventory', HERE/'digitalocean-inventory.py')
inventory = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = inventory
spec.loader.exec_module(inventory)
PREFIX = {
 'gemini_free':'APP_MODEL_GEMINI', 'qwen_free':'APP_MODEL_QWEN',
 'groq_free':'APP_MODEL_GROQ', 'mistral_free':'APP_MODEL_MISTRAL',
 'cloudflare_free':'APP_MODEL_CLOUDFLARE', 'zai_free':'APP_MODEL_ZAI',
 'openai':'APP_MODEL_OPENAI', 'anthropic':'APP_MODEL_CLAUDE',
 'openrouter':'APP_MODEL_OPENROUTER', 'qwencloud':'APP_MODEL_QWENCLOUD',
}
SQL = """BEGIN READ ONLY;SET LOCAL ROLE tdp_app_owner;SET LOCAL statement_timeout='15s';
DO $$BEGIN IF current_database()<>'tenderdesk_app' OR (SELECT count(*) FROM public.workspaces)<>1
 OR NOT EXISTS(SELECT 1 FROM public.workspaces WHERE id='__WORKSPACE__')
 THEN RAISE EXCEPTION 'MODEL_AUDIT_DATABASE_MISMATCH';END IF;END$$;
SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM (
 SELECT c.provider,c.credential_alias,c.project_ref,m.model
 FROM public.model_connections c JOIN public.model_configurations m
 ON m.connection_id=c.id AND m.workspace_id=c.workspace_id
 WHERE c.workspace_id='__WORKSPACE__' AND c.enabled AND m.enabled
 ORDER BY c.provider,m.model,c.id LIMIT 101)t;ROLLBACK;""".replace('__WORKSPACE__',inventory.observer.access.WORKSPACE)

class AuditError(Exception): pass

def public_binding_audit(catalog, bindings):
 if not isinstance(catalog,list) or len(catalog)>100: raise AuditError('MODEL_AUDIT_CATALOG_INVALID')
 rows=[]
 for row in catalog:
  if (not isinstance(row,dict) or set(row)!={'provider','model','credential_alias','project_ref'}
   or row['provider'] not in PREFIX or not isinstance(row['model'],str)
   or not re.fullmatch(r'[A-Za-z0-9._@/:-]{1,120}',row['model'])
   or not isinstance(row['credential_alias'],str)
   or not re.fullmatch(r'APP_MODEL_[A-Z0-9_]{1,80}_KEY',row['credential_alias'])
   or not isinstance(row['project_ref'],str)): raise AuditError('MODEL_AUDIT_CATALOG_INVALID')
  # Matches Backend.resolveModelEnvironment: a conventional alias may use the
  # provider's legacy binding; an explicit custom alias must exist itself.
  alias=row['credential_alias']; provider=row['provider']
  present=bool(bindings.get(alias))
  if alias==PREFIX[provider]+'_KEY' and bindings.get('APP_MODEL_PROVIDER')==provider:
   present=present or bool(bindings.get('APP_MODEL_KEY'))
  rows.append({'provider':provider,'model':row['model'],'key_configured':present,
   'project_configured':bool(row['project_ref'])})
 return rows

def run():
 if not re.fullmatch('[a-f0-9]{40}',os.environ.get('GITHUB_SHA','')): raise AuditError('MODEL_AUDIT_SOURCE_INVALID')
 inventory.d.probe.validate_cluster()
 client=inventory.observer.Client(60)
 client.labels['app.kubernetes.io/managed-by']=inventory.OWNER
 inventory.save_client(client)
 try:
  client.prepare()
  catalog=json.loads(inventory.d.sql(client.pod,SQL))
  bindings=inventory.d.decode_secret(inventory.d.get('secret','tenderdesk-runtime'))
  rows=public_binding_audit(catalog,bindings)
 finally:
  try: client.cleanup(); inventory.clear_client()
  except Exception: raise AuditError('MODEL_AUDIT_CLEANUP_UNCONFIRMED') from None
 return {'model_configuration_audit':'captured','source_revision':os.environ['GITHUB_SHA'],
  'models':rows,'model_calls':0,'business_mutations':0,'configuration_mutations':0,
  'temporary_client_cleanup_verified':True,
  'scope':'enabled_bindings_and_key_presence_only_not_provider_availability'}

def main():
 try:
  with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()): result=run()
 except Exception as error:
  code=str(error) if isinstance(error,AuditError) else 'MODEL_AUDIT_FAILED'
  print(json.dumps({'model_configuration_audit':'blocked','code':code}));return 1
 print(json.dumps(result,sort_keys=True));return 0

if __name__=='__main__':sys.exit(main())
