#!/usr/bin/env python3
"""Bounded legacy admission cutover; process proof survives runner loss.

No database session is terminated. The fixed gateway route fence is permanent;
the independent early SQL lock/zero census/INSERT trigger closes cached-function
races after this best-effort admission drain. No customer values are collected.
"""
import json
import re
import time

JOURNAL='tenderdesk.io/command-batch-cutover'
FINALIZER='tenderdesk.io/command-batch-cutover-process'
class CutoverError(Exception):pass

def need(ok,code):
 if not ok:raise CutoverError(code)
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'))
def pointer(v):return v.replace('~','~0').replace('/','~1')
def literal(v):return "'"+v.replace("'","''")+"'"
def items(d,kind='pods'):
 value=json.loads(d.command(['get',kind,'-n',d.NAMESPACE,'-o','json']))
 need(isinstance(value,dict) and isinstance(value.get('items'),list) and len(value['items'])<=1000,'DELIVERY_BATCH_RESOURCE_CENSUS_INVALID')
 return value['items']
def selected(pods,deployment):
 selector=deployment['spec']['selector']['matchLabels']
 need(bool(selector),'DELIVERY_BATCH_SELECTOR_INVALID')
 return [p for p in pods if all(p['metadata'].get('labels',{}).get(k)==v for k,v in selector.items())]

def lineage(d,pods,deployment):
 parents={s['metadata']['uid'] for s in items(d,'replicasets') if any(o.get('uid')==deployment['metadata']['uid'] and o.get('controller') is True for o in s['metadata'].get('ownerReferences',[]))}
 for p in pods:
  need(p['metadata'].get('namespace')==d.NAMESPACE and any(o.get('uid') in parents and o.get('controller') is True for o in p['metadata'].get('ownerReferences',[]))
   and not p['spec'].get('initContainers') and not p['spec'].get('ephemeralContainers'),'DELIVERY_BATCH_POD_LINEAGE_INVALID')

def api_gateway_binding(d,deployment):
 """Check actual Pod literals and inherited runtime values, without secrets."""
 def container(value):
  cs=value.get('containers',[])
  need(len(cs)==1 and cs[0].get('name')=='api' and not cs[0].get('command') and not cs[0].get('args'),'DELIVERY_BATCH_API_BINDING_INVALID')
  for name,value in (('SUPABASE_URL','http://gateway:8081'),('APP_RUNTIME_SERVICE','api')):
   need([e for e in cs[0].get('env',[]) if e.get('name')==name]==[{'name':name,'value':value}],'DELIVERY_BATCH_API_BINDING_INVALID')
 container(deployment['spec']['template']['spec'])
 pods=selected(items(d),deployment)
 need(len(pods)==deployment['spec']['replicas'] and pods,'DELIVERY_BATCH_API_PODS_UNSETTLED')
 lineage(d,pods,deployment)
 for pod in pods:
  container(pod['spec']);statuses=pod.get('status',{}).get('containerStatuses',[])
  need(not pod['metadata'].get('deletionTimestamp') and len(statuses)==1 and statuses[0].get('ready') is True,'DELIVERY_BATCH_API_PODS_UNSETTLED')
  observed=d.command(['exec',pod['metadata']['name'],'-n',d.NAMESPACE,'--','/bin/sh','-c',
   'if [ "$SUPABASE_URL" = "http://gateway:8081" ] && [ "$APP_RUNTIME_SERVICE" = "api" ]; then printf true; else printf false; fi'])
  need(observed.strip()=='true','DELIVERY_BATCH_API_BINDING_INVALID')
 return {'ready_pods':len(pods),'literal_gateway_upstream_verified':True,'runtime_values_verified':True}

class GatewayDrain:
 def __init__(self,d,gateway,state):
  self.d,self.gateway,self.state=d,gateway,state
  self.uid=state['deployment']['metadata']['uid'];self.target=state['contract']['after_source_sha256']
 def deployment(self):
  v=self.gateway.owned(self.d,'deployment','gateway')
  need(v['metadata']['uid']==self.uid,'DELIVERY_BATCH_GATEWAY_IDENTITY_CHANGED');return v
 def save(self,value,previous=None):
  dep=self.deployment();annotations=dep['metadata'].get('annotations');old=(annotations or {}).get(JOURNAL)
  need(old==previous,'DELIVERY_BATCH_GATEWAY_JOURNAL_CHANGED')
  ops=[]
  if annotations is None:ops.append({'op':'add','path':'/metadata/annotations','value':{}})
  if old is not None:ops.append({'op':'test','path':'/metadata/annotations/'+pointer(JOURNAL),'value':old})
  ops.append({'op':'add','path':'/metadata/annotations/'+pointer(JOURNAL),'value':canonical(value)})
  self.gateway.patch(self.d,'deployment','gateway',dep,ops)
 def read(self):
  raw=self.deployment()['metadata'].get('annotations',{}).get(JOURNAL)
  if raw is None:return None
  need(isinstance(raw,str) and len(raw)<=65536,'DELIVERY_BATCH_GATEWAY_JOURNAL_INVALID')
  try:v=json.loads(raw)
  except (ValueError,TypeError):raise CutoverError('DELIVERY_BATCH_GATEWAY_JOURNAL_INVALID') from None
  need(isinstance(v,dict) and set(v)=={'version','deployment_uid','target_source_sha256','pods','termination'}
   and v['version']==1 and v['deployment_uid']==self.uid and v['target_source_sha256']==self.target
   and isinstance(v['pods'],list) and len(v['pods'])<=100 and isinstance(v['termination'],dict),'DELIVERY_BATCH_GATEWAY_JOURNAL_INVALID')
  seen=set()
  for p in v['pods']:
   need(isinstance(p,dict) and set(p)=={'name','uid','container_id'} and all(isinstance(x,str) and x for x in p.values())
    and re.fullmatch('[a-z0-9.-]{1,253}',p['name']) and re.fullmatch('[a-f0-9-]{36}',p['uid'])
    and re.fullmatch('(containerd|docker|cri-o)://[a-f0-9]{64}',p['container_id']) and p['uid'] not in seen,'DELIVERY_BATCH_GATEWAY_JOURNAL_INVALID')
   seen.add(p['uid'])
  need(set(v['termination'])<=seen,'DELIVERY_BATCH_GATEWAY_JOURNAL_INVALID')
  for p in v['pods']:
   proof=v['termination'].get(p['uid'])
   if proof is not None:
    need(isinstance(proof,dict) and set(proof)=={'container_id','finished_at','exit_code'} and proof['container_id']==p['container_id']
     and type(proof['exit_code']) is int and isinstance(proof['finished_at'],str)
     and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z',proof['finished_at']),'DELIVERY_BATCH_GATEWAY_JOURNAL_INVALID')
  return v
 def prepare(self):
  v=self.read()
  if v is None:
   deployment=self.deployment();config=self.gateway.owned(self.d,'configmap','gateway-config')
   # Our own mutation order always saves the original UID set before changing
   # either ConfigMap or Pod template. A target/partial target without it is
   # unexplained state, never proof that unobserved old processes exited.
   need(config.get('data')==self.state['before_data']
    and deployment['spec']['template']['metadata'].get('annotations',{}).get(self.gateway.CHECKSUM)==self.state['contract']['before_data_sha256'],
    'DELIVERY_BATCH_GATEWAY_ORIGINAL_JOURNAL_REQUIRED')
   pods=selected(items(self.d),deployment);old=[]
   need(pods,'DELIVERY_BATCH_GATEWAY_POD_INVALID');lineage(self.d,pods,deployment)
   for p in pods:
    if p['metadata'].get('annotations',{}).get(self.gateway.CHECKSUM)==self.state['contract']['after_data_sha256']:continue
    statuses=p.get('status',{}).get('containerStatuses',[])
    need(len(p['spec'].get('containers',[]))==1 and len(statuses)==1 and statuses[0].get('name')=='gateway'
     and p['spec']['containers'][0].get('image')==self.state['contract']['gateway_image']
     and statuses[0].get('containerID'),'DELIVERY_BATCH_GATEWAY_POD_INVALID')
    old.append({'name':p['metadata']['name'],'uid':p['metadata']['uid'],'container_id':statuses[0]['containerID']})
   v={'version':1,'deployment_uid':self.uid,'target_source_sha256':self.target,'pods':old,'termination':{}}
   self.save(v);v=self.read()
  # The durable complete original UID set is saved before adding any finalizer
  # or sending the rollout. Missing unproved processes can never be forgotten.
  for p in v['pods']:
   if p['uid'] in v['termination']:continue
   current=self.d.get('pod',p['name'])
   need(current and current['metadata']['uid']==p['uid'],'DELIVERY_BATCH_GATEWAY_PROCESS_UNPROVEN')
   finalizers=current['metadata'].get('finalizers',[])
   need(finalizers in ([],[FINALIZER]),'DELIVERY_BATCH_GATEWAY_FINALIZER_CONFLICT')
   if not finalizers:self.gateway.patch(self.d,'pod',p['name'],current,[{'op':'add','path':'/metadata/finalizers','value':[FINALIZER]}])
  return {'captured_old_gateway_pods':len(v['pods'])}
 def after_rollout(self,timeout=180):
  deadline=time.monotonic()+timeout
  while True:
   v=self.read();need(v is not None,'DELIVERY_BATCH_GATEWAY_JOURNAL_INVALID');previous=canonical(v);changed=False
   for p in v['pods']:
    if p['uid'] in v['termination']:continue
    current=self.d.get('pod',p['name'])
    need(current and current['metadata']['uid']==p['uid'],'DELIVERY_BATCH_GATEWAY_PROCESS_UNPROVEN')
    need(current['metadata'].get('finalizers')==[FINALIZER],'DELIVERY_BATCH_GATEWAY_PROCESS_UNPROVEN')
    statuses=current.get('status',{}).get('containerStatuses',[])
    need(len(statuses)==1 and statuses[0].get('containerID')==p['container_id'],'DELIVERY_BATCH_GATEWAY_PROCESS_CHANGED')
    term=statuses[0].get('state',{}).get('terminated')
    if term and (current['metadata'].get('deletionTimestamp') or current.get('status',{}).get('phase') in ('Succeeded','Failed')):
     v['termination'][p['uid']]={'container_id':p['container_id'],'finished_at':term.get('finishedAt'),'exit_code':term.get('exitCode')};changed=True
   if changed:self.save(v,previous);v=self.read()
   if len(v['termination'])==len(v['pods']):break
   need(time.monotonic()<deadline,'DELIVERY_BATCH_GATEWAY_DRAIN_TIMEOUT');time.sleep(2)
  # All actual process exits are durable before any identity can be collected.
  # On failure keep the journal/finalizers. Forward resume never force-deletes.
  for p in v['pods']:
   current=self.d.get('pod',p['name'])
   if current is None:continue
   need(current['metadata']['uid']==p['uid'],'DELIVERY_BATCH_GATEWAY_PROCESS_CHANGED')
   finalizers=current['metadata'].get('finalizers',[])
   need(finalizers in ([],[FINALIZER]),'DELIVERY_BATCH_GATEWAY_FINALIZER_CONFLICT')
   if finalizers:self.gateway.patch(self.d,'pod',p['name'],current,[{'op':'test','path':'/metadata/finalizers','value':[FINALIZER]},{'op':'remove','path':'/metadata/finalizers'}])
  while any(self.d.get('pod',p['name']) is not None for p in v['pods']):
   need(time.monotonic()<deadline,'DELIVERY_BATCH_GATEWAY_COLLECTION_PENDING');time.sleep(2)
  return {'captured_old_gateway_pods':len(v['pods']),'actual_process_exits_proved':True}

def transaction_observation_sql(marker=None):
 if marker is not None:need(isinstance(marker,str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+[+]00:00',marker),'DELIVERY_BATCH_TRANSACTION_MARKER_INVALID')
 boundary='clock_timestamp()' if marker is None else literal(marker)+'::timestamptz'
 return """BEGIN READ ONLY;SET LOCAL statement_timeout='10s';SET LOCAL lock_timeout='5s';
DO $batch_visibility$ BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'DELIVERY_BATCH_DATABASE_IDENTITY_INVALID';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tdp_app_authenticator' AND rolcanlogin)
  THEN RAISE EXCEPTION 'DELIVERY_BATCH_DATABASE_ROLE_INVALID';END IF;
 IF NOT pg_has_role(session_user,'tdp_app_authenticator','SET')
  THEN RAISE EXCEPTION 'DELIVERY_BATCH_TRANSACTION_VISIBILITY_REQUIRED';END IF;
 -- PostgreSQL exposes a login role's own activity even when those sessions
 -- temporarily assume JWT/application roles. Use only this preexisting SET
 -- authority, never a global statistics grant or guessed hidden-row count.
 SET LOCAL ROLE tdp_app_authenticator;
 IF current_user<>'tdp_app_authenticator' THEN RAISE EXCEPTION 'DELIVERY_BATCH_TRANSACTION_VISIBILITY_REQUIRED';END IF;
END $batch_visibility$;
WITH boundary AS MATERIALIZED (SELECT """+boundary+""" marker)
SELECT jsonb_build_object('marker',to_char(boundary.marker AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'+00:00',
 'visibility_verified',true,'old_transactions',(SELECT count(*) FROM pg_stat_activity a
  WHERE a.datname=current_database() AND a.usename='tdp_app_authenticator' AND a.pid<>pg_backend_pid()
   AND a.xact_start IS NOT NULL AND a.xact_start<=boundary.marker)) FROM boundary;
ROLLBACK;"""

def observe_transactions(d,client,marker=None):
 value=json.loads(d.sql(client.pod,transaction_observation_sql(marker)))
 need(isinstance(value,dict) and set(value)=={'marker','visibility_verified','old_transactions'}
  and value['visibility_verified'] is True and type(value['old_transactions']) is int and value['old_transactions']>=0,'DELIVERY_BATCH_TRANSACTION_OBSERVATION_INVALID')
 transaction_observation_sql(value['marker'])
 need(marker is None or marker==value['marker'],'DELIVERY_BATCH_TRANSACTION_MARKER_CHANGED');return value

def drain_transactions(d,client,timeout=180):
 first=observe_transactions(d,client);marker=first['marker'];pending=first['old_transactions'];deadline=time.monotonic()+timeout
 while pending:
  need(time.monotonic()<deadline,'DELIVERY_BATCH_TRANSACTION_DRAIN_TIMEOUT');time.sleep(2)
  pending=observe_transactions(d,client,marker)['old_transactions']
 return {'database_marker':marker,'initial_old_transactions':first['old_transactions'],
  'visibility_basis':'existing_set_authority_to_exact_login_role','old_transactions_settled':True,'sessions_terminated':0,'direct_namespace_rest_admission_fenced':False}
