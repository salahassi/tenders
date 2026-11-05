"""Fixture-only ownership contract; cannot select a production namespace or DB.

The production retirement adapter is deliberately not imported or retargeted.
Every fixture operation must re-observe the nonce-owned namespace, database
comment and exact captured object UID before a mutation.
"""
from __future__ import annotations
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import uuid

HERE=Path(__file__).resolve().parent
OPS=HERE.parent

def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec)
 sys.modules[name]=module;spec.loader.exec_module(module);return module
bootstrap=load('retirement_fixture_bootstrap',OPS/'digitalocean-bootstrap.py')
restore=load('retirement_fixture_restore',OPS/'proposal-cloud-restore.py')
proof=load('retirement_fixture_process_proof',OPS/'storage-retirement/coordinator.py')
PHASES=('allocated','schema_ready','fixture_ready','protected','interrupted','recovered','retired','verified','cleaning','cleaned')
STATE_NAME='retirement-qualification-state'
PVC_NAME='retirement-objects'
SOURCE_FILES=(
 'backend/scripts/ops/storage-retirement/coordinator.py',
 'backend/scripts/ops/storage-retirement/physical.mjs',
 'backend/scripts/ops/cloud-retirement/contract.py',
)

class FixtureError(Exception):pass

def need(value,code):
 if not value:raise FixtureError(code)
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def sha(value):return hashlib.sha256(value).hexdigest()
def uid(value):return proof.valid_uuid(value)

def revision():
 value=os.environ.get('GITHUB_SHA','');need(re.fullmatch('[a-f0-9]{40}',value),'RETIREMENT_FIXTURE_REVISION_REQUIRED');return value

def origin_attempt():
 actual=os.environ.get('GITHUB_RUN_ATTEMPT','');origin=os.environ.get('RETIREMENT_FIXTURE_ORIGIN_ATTEMPT',actual)
 need(re.fullmatch('[1-9][0-9]{0,5}',actual) and re.fullmatch('[1-9][0-9]{0,5}',origin) and int(origin)<=int(actual),'RETIREMENT_FIXTURE_ORIGIN_ATTEMPT_INVALID')
 return origin

def validate_bootstrap(base):
 # A rerun may recover the same run's original fixture. The workflow supplies
 # this origin attempt from its successful first-job output, never a namespace
 # or database selector. The actual execution attempt remains unchanged.
 expected={'namespace','database','role_prefix','labels','uid','job_uid','setup_started','database_cleanup_confirmed'}
 need(isinstance(base,dict) and set(base)==expected,'RETIREMENT_FIXTURE_BOOTSTRAP_INVALID')
 run=os.environ.get('GITHUB_RUN_ID','');attempt=origin_attempt()
 need(re.fullmatch('[0-9]{1,20}',run),'RETIREMENT_FIXTURE_RUN_INVALID')
 owner=base.get('labels',{}).get('tenderdesk.io/run','')
 match=re.fullmatch(re.escape(run+'-'+attempt+'-')+'([a-f0-9]{8})',owner)
 need(match is not None,'RETIREMENT_FIXTURE_RUN_INVALID');nonce=match.group(1)
 need(base['namespace']=='td-bootstrap-'+owner and base['database']=='td_bootstrap_'+run+'_'+attempt+'_'+nonce and base['role_prefix']=='tdb_'+run[-8:]+'_'+nonce
  and base['labels']=={'app.kubernetes.io/managed-by':'tenderdesk-bootstrap','tenderdesk.io/run':owner}
  and uid(base['uid']) and (base['job_uid'] is None or uid(base['job_uid'])) and type(base['setup_started']) is bool and type(base['database_cleanup_confirmed']) is bool,'RETIREMENT_FIXTURE_BOOTSTRAP_INVALID')
 return base

def manifest_contract():
 manifest=json.loads(restore.release.MANIFEST.read_text());restore.release.verify_source(manifest)
 need(len(manifest['migrations'])==27 and manifest.get('storage_retirement_version')==1 and manifest.get('source_resolution_version')==1 and manifest.get('minimum_worker_executor')==5,'RETIREMENT_FIXTURE_SCHEMA_UNQUALIFIED')
 return restore.release.digest(restore.release.canonical(manifest).encode())

def initial_state(base,manifest_sha256):
 validate_bootstrap(base)
 state={'version':1,'source_revision':revision(),'manifest_sha256':manifest_sha256,
  'operation_nonce':str(uuid.uuid4()),'bootstrap':base,'phase':'allocated',
  'resource_uids':{},'fixture':None,'process_capture':None,'completion':None,'cleanup_proof':None}
 return validate_state(state)

def validate_state(state):
 need(isinstance(state,dict) and set(state)=={'version','source_revision','manifest_sha256','operation_nonce','bootstrap','phase','resource_uids','fixture','process_capture','completion','cleanup_proof'},'RETIREMENT_FIXTURE_STATE_INVALID')
 need(type(state['version']) is int and state['version']==1 and state['source_revision']==revision()
  and isinstance(state['manifest_sha256'],str) and re.fullmatch('[a-f0-9]{64}',state['manifest_sha256'])
  and uid(state['operation_nonce']) and state['phase'] in PHASES,'RETIREMENT_FIXTURE_STATE_INVALID')
 validate_bootstrap(state['bootstrap'])
 need(uid(state['bootstrap']['uid']) and state['bootstrap']['namespace']!='tenderdesk-dev'
  and state['bootstrap']['database']!='tenderdesk_app','RETIREMENT_FIXTURE_PRODUCTION_TARGET_FORBIDDEN')
 resources=state['resource_uids'];need(isinstance(resources,dict) and len(resources)<=100,'RETIREMENT_FIXTURE_RESOURCE_CENSUS_INVALID')
 for key,value in resources.items():
  need(isinstance(key,str) and re.fullmatch('(deployment|service|configmap|secret|pod|job|persistentvolumeclaim|networkpolicy)/[a-z0-9-]{1,63}',key) and uid(value),'RETIREMENT_FIXTURE_RESOURCE_CENSUS_INVALID')
 if state['fixture'] is not None:validate_fixture(state['fixture'])
 if state['cleanup_proof'] is not None:validate_cleanup_proof(state,state['cleanup_proof'])
 return state

def validate_cleanup_proof(state,value):
 """A protected-process cleanup checkpoint retains the full original exit proof.

 Namespace ownership, phase or an absent Pod cannot substitute for this proof.
 Before protection, a distinct full live-original observation can authorize
 ordinary fixture teardown; it cannot authorize retirement or claim an exit.
 Empty workload evidence is allowed only when no process capture ever existed.
 """
 need(isinstance(value,dict) and set(value)=={'version','operation_nonce','namespace_uid','mode','workloads'}
  and type(value['version']) is int and value['version']==1 and value['operation_nonce']==state['operation_nonce']
  and value['namespace_uid']==state['bootstrap']['uid'] and value['mode'] in ('uncaptured','unprotected_originals','terminated_originals') and isinstance(value['workloads'],dict),'RETIREMENT_FIXTURE_CLEANUP_PROOF_INVALID')
 capture=state['process_capture']
 if capture is None:
  need(value['mode']=='uncaptured' and value['workloads']=={},'RETIREMENT_FIXTURE_CLEANUP_PROOF_INVALID');return value
 need(value['mode'] in ('unprotected_originals','terminated_originals'),'RETIREMENT_FIXTURE_CLEANUP_PROOF_INVALID')
 if value['mode']=='unprotected_originals':need(state['phase'] in ('fixture_ready','cleaning'),'RETIREMENT_FIXTURE_CLEANUP_PROOF_INVALID')
 need(isinstance(capture,dict) and isinstance(capture.get('selection'),dict),'RETIREMENT_FIXTURE_CLEANUP_PROOF_INVALID')
 selection=proof.validate_selection(capture['selection'])
 need(selection['operation_nonce']==state['operation_nonce'] and selection['namespace_uid']==state['bootstrap']['uid']
  and set(value['workloads'])==set(proof.NAMES) and set(capture.get('workloads',{}))==set(proof.NAMES)
  and set(capture.get('pods',{}))==set(proof.NAMES),'RETIREMENT_FIXTURE_CLEANUP_PROOF_INVALID')
 for name,item in value['workloads'].items():
  fields={'deployment_uid','journal','protection_released'} if value['mode']=='terminated_originals' else {'deployment_uid','deployment','pods'}
  need(isinstance(item,dict) and set(item)==fields,'RETIREMENT_FIXTURE_CLEANUP_PROOF_INVALID')
  deployment=capture['workloads'][name];expected=selection['expected_workloads'][name];pods=capture['pods'][name]
  need(item['deployment_uid']==deployment['metadata']['uid']==expected['uid']==state['resource_uids'].get('deployment/'+name)
   and deployment['metadata']['namespace']==state['bootstrap']['namespace'] and isinstance(pods,list) and len(pods)==expected['replicas'],'RETIREMENT_FIXTURE_CLEANUP_PROOF_INVALID')
  identities=[proof.pod_identity(pod) for pod in pods]
  if value['mode']=='terminated_originals':
   need(item['protection_released'] is True,'RETIREMENT_FIXTURE_CLEANUP_PROOF_INVALID')
   journal=proof.validate_process_journal(item['journal'],state['operation_nonce'])
   need(journal['pods']==identities and set(journal['termination'])=={x['uid'] for x in identities},'RETIREMENT_FIXTURE_CLEANUP_PROOF_INVALID')
  else:
   observed=item['deployment'];metadata=observed.get('metadata',{})
   need(metadata.get('uid')==item['deployment_uid'] and metadata.get('namespace')==state['bootstrap']['namespace'] and observed.get('spec')==deployment['spec']
    and proof.ANNOTATION not in metadata.get('annotations',{}) and 'tenderdesk.io/storage-retirement-processes' not in metadata.get('annotations',{})
    and isinstance(item['pods'],list) and len(item['pods'])==len(pods),'RETIREMENT_FIXTURE_UNPROTECTED_PROOF_INVALID')
   for original,current in zip(pods,item['pods']):
    metadata=current.get('metadata',{})
    need(proof.pod_identity(current)==proof.pod_identity(original) and current.get('spec')==original['spec'] and metadata.get('namespace')==state['bootstrap']['namespace']
     and not metadata.get('deletionTimestamp') and not metadata.get('finalizers') and proof.ANNOTATION not in metadata.get('annotations',{})
     and all(status.get('ready') is True and isinstance(status.get('state',{}).get('running'),dict) for status in current.get('status',{}).get('containerStatuses',[])), 'RETIREMENT_FIXTURE_UNPROTECTED_PROOF_INVALID')
 return value

def validate_fixture(value):
 need(isinstance(value,dict) and set(value)=={'actor_id','workspace_id','selection','expected_hash','expected_size'},'RETIREMENT_FIXTURE_DATA_INVALID')
 need(uid(value['actor_id']) and uid(value['workspace_id']) and type(value['expected_size']) is int and value['expected_size']==16384
  and isinstance(value['expected_hash'],str) and re.fullmatch('[a-f0-9]{64}',value['expected_hash']),'RETIREMENT_FIXTURE_DATA_INVALID')
 selection=value['selection'];need(isinstance(selection,list) and len(selection)==1,'RETIREMENT_FIXTURE_DATA_INVALID')
 item=selection[0]
 need(isinstance(item,dict) and set(item)=={'id','storage_key','retirement_nonce','revision'} and uid(item['id']) and uid(item['retirement_nonce'])
  and type(item['revision']) is int and item['revision']>=1,'RETIREMENT_FIXTURE_DATA_INVALID')
 proof.validate_key(item['storage_key'])
 need(item['storage_key'].startswith(value['workspace_id']+'/'),'RETIREMENT_FIXTURE_KEY_SCOPE_INVALID')
 return value

def labels(state):return {**state['bootstrap']['labels'],'tenderdesk.io/qualification':'storage-retirement'}
def namespace(state):return state['bootstrap']['namespace']
def database_comment(state):
 base=state['bootstrap'];return 'tenderdesk-isolated-bootstrap:'+base['database']+':'+base['role_prefix']

def owned(state,kind,name,actual,*,known=True):
 validate_state(state);need(isinstance(actual,dict),'RETIREMENT_FIXTURE_RESOURCE_MISSING')
 meta=actual.get('metadata',{})
 need(meta.get('name')==name and meta.get('namespace')==namespace(state) and uid(meta.get('uid'))
  and all(meta.get('labels',{}).get(k)==v for k,v in labels(state).items()),'RETIREMENT_FIXTURE_RESOURCE_OWNERSHIP_CHANGED')
 if known:need(state['resource_uids'].get(kind+'/'+name)==meta['uid'],'RETIREMENT_FIXTURE_RESOURCE_IDENTITY_CHANGED')
 return actual

def database_guard(state):
 validate_state(state);literal=restore.builder.literal
 return "DO $fixture$ BEGIN IF current_database()<>"+literal(state['bootstrap']['database'])+" OR (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()) IS DISTINCT FROM "+literal(database_comment(state))+" THEN RAISE EXCEPTION 'RETIREMENT_FIXTURE_DATABASE_MISMATCH'; END IF; END $fixture$;"

def public_receipt(state,checks,times,*,cleaned):
 validate_state(state)
 need(isinstance(checks,dict) and all(isinstance(k,str) and re.fullmatch('[a-z_]{1,100}',k) and type(v) is bool for k,v in checks.items()),'RETIREMENT_FIXTURE_RESULT_INVALID')
 need(isinstance(times,dict) and all(isinstance(k,str) and re.fullmatch('[a-z_]{1,100}',k) and type(v) in (int,float) and 0<=v<=3600 for k,v in times.items()),'RETIREMENT_FIXTURE_RESULT_INVALID')
 return {'version':1,'source_revision':state['source_revision'],'manifest_sha256':state['manifest_sha256'],
  'origin_run_attempt':origin_attempt(),'execution_run_attempt':os.environ['GITHUB_RUN_ATTEMPT'],
  'checks':checks,'observed_seconds':times,'cleanup_verified':cleaned is True,
  'passed':bool(checks) and all(checks.values()) and cleaned is True,'production_business_mutations':0,'model_calls':0,
  'production_fixed_target_adapter_exercised':False,'whole_cluster_restore_qualified':False,'rto_rpo_target_defined':False,
  'scope':'isolated Kubernetes/PVC, canonical SQL and unchanged coordinator; synthetic writer process'}
