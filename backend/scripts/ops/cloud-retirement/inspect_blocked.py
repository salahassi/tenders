"""Read-only diagnosis of the one retained fixture; never selects production."""
import base64
from contextlib import redirect_stdout,redirect_stderr
import io
import json
import re
import sys
import contract as c
import resources as r
import runner

ORIGIN_RUN='41999178689'
ORIGIN_SHA='cac55b91d4fed22871aff14f05a98fca68ea4b53'
ORIGIN_ATTEMPT='1'
SQLSTATES=frozenset(('42501','42P01','42703','42883','28P01','28000','3D000','53300','57P03','08001','08006','23505'))
LOG_CATEGORIES=(('permission denied','permission_denied'),('password authentication failed','authentication_failed'),
 ('connection refused','connection_refused'),('timed out','timeout'),('timeout','timeout'),
 ('migration','migration'),('no space left on device','disk_full'),('read-only file system','read_only'),
 ('address already in use','address_in_use'))

def need(value):c.need(value,'RETIREMENT_INSPECTION_SCOPE_INVALID')
def label(value):return value if isinstance(value,str) and value in r.POD_LABELS else 'other'
def select_namespace(items):
 prefix='td-bootstrap-'+ORIGIN_RUN+'-'+ORIGIN_ATTEMPT+'-'
 matches=[x for x in items if re.fullmatch(re.escape(prefix)+'[a-f0-9]{8}',x.get('metadata',{}).get('name',''))]
 need(len(matches)==1);ns=matches[0];meta=ns['metadata'];owner=meta['name'][len('td-bootstrap-'):]
 need(c.uid(meta.get('uid')) and meta.get('labels',{}).get('tenderdesk.io/run')==owner
  and meta.get('labels',{}).get('app.kubernetes.io/managed-by')=='tenderdesk-bootstrap')
 return ns

def bind_state(ns,secret):
 data=base64.b64decode(secret['data']['state'],validate=True);need(len(data)<=750000)
 state=json.loads(data);meta=ns['metadata'];base=state['bootstrap']
 expected={'app.kubernetes.io/managed-by':'tenderdesk-bootstrap','tenderdesk.io/run':meta['name'][len('td-bootstrap-'): ]}
 need(state['source_revision']==ORIGIN_SHA and state['manifest_sha256']==c.manifest_contract()
  and base['namespace']==meta['name'] and base['uid']==meta['uid'] and base['labels']==expected)
 need(secret['metadata']['namespace']==meta['name'] and secret['metadata']['name']==c.STATE_NAME
  and secret['metadata']['uid']==state['resource_uids']['secret/'+c.STATE_NAME])
 need(all(secret['metadata'].get('labels',{}).get(k)==v for k,v in {**expected,'tenderdesk.io/qualification':'storage-retirement'}.items()))
 return state

def summarize(status,events,logs):
 reasons=set();categories=set();sqlstates=set();log_categories=set()
 for event in events:
  reasons.add(label(event.get('reason')));message=str(event.get('message',''))[:65536].lower()
  categories.update(category for fragment,category in r.EVENT_CATEGORIES if fragment in message)
 for line in logs.splitlines():
  lowered=line.lower();log_categories.update(category for fragment,category in LOG_CATEGORIES if fragment in lowered)
  try:
   value=json.loads(line)
   def codes(value,depth=0):
    if depth>8:return
    if isinstance(value,dict):
     for key,item in value.items():
      if key in ('code','sqlstate') and isinstance(item,str) and item in SQLSTATES:sqlstates.add(item)
      elif isinstance(item,(dict,list)):codes(item,depth+1)
    elif isinstance(value,list):
     for item in value[:100]:codes(item,depth+1)
   codes(value)
  except (ValueError,TypeError):pass
 containers=[]
 for item in status.get('containerStatuses',[])[:4]:
  state=item.get('state',{});ended=state.get('terminated',item.get('lastState',{}).get('terminated',{}));exit_code=ended.get('exitCode')
  containers.append({'ready':item.get('ready') is True,'waiting_reason':label(state.get('waiting',{}).get('reason')),
   'termination_reason':label(ended.get('reason')),'exit_code':exit_code if type(exit_code) is int and 0<=exit_code<=255 else None})
 return {'phase':label(status.get('phase')),'containers':containers,'event_reasons':sorted(reasons),
  'event_categories':sorted(categories),'log_categories':sorted(log_categories),'sqlstates':sorted(sqlstates)}

def inspect():
 namespace=select_namespace(json.loads(r.command(['get','namespaces','-l','app.kubernetes.io/managed-by=tenderdesk-bootstrap','-o','json']))['items'])
 ns=namespace['metadata']['name'];ns_uid=namespace['metadata']['uid']
 def observe(kind,name=None,extra=()):
  current=json.loads(r.command(['get','namespace',ns,'-o','json']))
  need(current['metadata']['uid']==ns_uid and current['metadata']['labels']==namespace['metadata']['labels'])
  return json.loads(r.command(['get',kind,*([name] if name else []),'-n',ns,*extra,'-o','json']))
 state=bind_state(namespace,observe('secret',c.STATE_NAME));labels=c.labels(state)
 def owned(value,kind,name=None):
  meta=value['metadata'];need(meta.get('namespace')==ns and c.uid(meta.get('uid')) and all(meta.get('labels',{}).get(k)==v for k,v in labels.items()))
  if name:need(meta.get('name')==name and meta['uid']==state['resource_uids'][kind+'/'+name])
  return value
 dep=owned(observe('deployment','storage'),'deployment','storage')
 selector=','.join(k+'='+v for k,v in sorted(dep['spec']['selector']['matchLabels'].items()))
 replicas=observe('replicasets',extra=('-l',selector))['items'];need(len(replicas)<=10)
 for rs in replicas:
  owned(rs,'replicaset');need(any(x.get('controller') is True and x.get('uid')==dep['metadata']['uid'] for x in rs['metadata'].get('ownerReferences',[])))
 parents={x['metadata']['uid'] for x in replicas};pods=observe('pods',extra=('-l',selector))['items'];need(len(pods)<=10)
 summaries=[]
 for pod in pods:
  owned(pod,'pod');meta=pod['metadata'];need(any(x.get('controller') is True and x.get('uid') in parents for x in meta.get('ownerReferences',[])))
  events=observe('events',extra=('--field-selector','involvedObject.uid='+meta['uid']))['items'];need(len(events)<=100)
  need(all(x.get('metadata',{}).get('namespace')==ns and x.get('involvedObject',{}).get('uid')==meta['uid'] for x in events))
  logs='';logs_available=False
  try:
   need(observe('pod',meta['name'])['metadata']['uid']==meta['uid'])
   logs=r.command(['logs',meta['name'],'-n',ns,'--container=storage','--tail=100','--limit-bytes=32768'],timeout=15);logs_available=True
   need(observe('pod',meta['name'])['metadata']['uid']==meta['uid'])
  except c.FixtureError:logs='';logs_available=False
  summaries.append({**summarize(pod.get('status',{}),events,logs),'logs_available':logs_available})
 return {'status':'observed','origin_run':ORIGIN_RUN,'origin_source':ORIGIN_SHA,'pod_count':len(pods),
  'storage_pods':summaries,'mutations':0,'customer_rows':0,'model_calls':0}

def main():
 try:
  with redirect_stdout(io.StringIO()),redirect_stderr(io.StringIO()):runner.prepare_access();value=inspect()
  print(json.dumps(value));return 0
 except Exception:print(json.dumps({'status':'blocked','code':'RETIREMENT_INSPECTION_FAILED'}));return 1

if __name__=='__main__':sys.exit(main())
