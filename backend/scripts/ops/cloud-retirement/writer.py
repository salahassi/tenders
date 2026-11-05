#!/usr/bin/env python3
"""Private HTTP client for the nonce-owned Kubernetes/PVC qualification.

Run beside the unchanged bootstrap acceptance.py inside its isolated client Pod.
stdout is private coordinator input, never a public workflow log/artifact. The
surrounding coordinator proves physical absence and exactly-once SQL completion;
an HTTP error alone is deliberately not called physical retirement proof here.
"""
from __future__ import annotations

from dataclasses import replace
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import urllib.parse
import uuid

from acceptance import Acceptance, Config, ProbeFailure, expect

STATE=Path('/tmp/retirement-client-state.json')
DATA=bytes(range(256))*64
CHECKSUM=hashlib.sha256(DATA).hexdigest()
BUCKET='tenderdesk-private'


def require(value,code):
    if not value:raise ProbeFailure(code)


def save_private(value,*,initial=False):
    raw=json.dumps(value,sort_keys=True,separators=(',',':')).encode()
    require(len(raw)<=32768,'RETIREMENT_FIXTURE_PRIVATE_STATE_SIZE')
    target=STATE if initial else STATE.with_suffix('.next')
    flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW
    descriptor=os.open(target,flags,0o600)
    try:
        with os.fdopen(descriptor,'wb') as stream:
            stream.write(raw);stream.flush();os.fsync(stream.fileno())
        if not initial:os.replace(target,STATE)
        directory=os.open(STATE.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(directory)
        finally:os.close(directory)
    except BaseException:
        try:target.unlink()
        except OSError:pass
        raise


def load_private(config):
    descriptor=os.open(STATE,os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(descriptor,'rb') as stream:
        observed=os.fstat(stream.fileno())
        require(stat.S_ISREG(observed.st_mode) and stat.S_IMODE(observed.st_mode)==0o600
          and observed.st_uid==os.getuid() and observed.st_nlink==1 and 0<observed.st_size<=32768,
          'RETIREMENT_FIXTURE_PRIVATE_STATE_INVALID')
        value=json.loads(stream.read(32769))
    require(isinstance(value,dict) and set(value)=={'version','database','prefix','actor_id','refresh_token','fixture'}
      and type(value['version']) is int and value['version']==1 and value['database']==config.database and value['prefix']==config.prefix
      and value['actor_id']==value['fixture']['actor_id'] and isinstance(value['refresh_token'],str)
      and 20<=len(value['refresh_token'])<=4096,'RETIREMENT_FIXTURE_PRIVATE_STATE_INVALID')
    validate_fixture(value['fixture'])
    return value


def identifier(value):
    try:return isinstance(value,str) and str(uuid.UUID(value))==value
    except (ValueError,TypeError):return False


def validate_fixture(value):
    require(isinstance(value,dict) and set(value)=={'actor_id','workspace_id','selection','expected_hash','expected_size'}
      and identifier(value['actor_id']) and identifier(value['workspace_id'])
      and value['expected_size']==len(DATA) and value['expected_hash']==CHECKSUM,
      'RETIREMENT_FIXTURE_RESULT_INVALID')
    selection=value['selection']
    require(isinstance(selection,list) and len(selection)==1,'RETIREMENT_FIXTURE_RESULT_INVALID')
    item=selection[0]
    require(isinstance(item,dict) and set(item)=={'id','storage_key','retirement_nonce','revision'}
      and identifier(item['id']) and identifier(item['retirement_nonce'])
      and type(item['revision']) is int and item['revision']>=1
      and isinstance(item['storage_key'],str) and item['storage_key'].startswith(value['workspace_id']+'/')
      and len(item['storage_key'].encode())<=1024
      and all(re.fullmatch('[A-Za-z0-9_.-]{1,255}',part) and part not in ('.','..') for part in item['storage_key'].split('/')),
      'RETIREMENT_FIXTURE_RESULT_INVALID')
    return value


class RetirementClient(Acceptance):
    def __init__(self,config,client=None):
        super().__init__(config,client);self.refresh_tokens={}

    def session(self,value):
        user,token=super().session(value)
        refresh=value.get('refresh_token')
        require(isinstance(refresh,str) and 20<=len(refresh)<=4096,'RETIREMENT_FIXTURE_REFRESH_MISSING')
        self.refresh_tokens[user]=refresh
        return user,token

    def rpc(self,name,body=None,token=None):
        require(re.fullmatch('[a-z_][a-z0-9_]{0,63}',name),'RETIREMENT_FIXTURE_RPC_INVALID')
        response=self.client.request(self.config.rest_url,'/rpc/'+name,method='POST',
          token=token or self.config.service_key,data=body or {})
        if response.status==204 and name=='fail_delivery_export':return None
        if response.status!=200:
            # No body/error details, SQL or private values escape this boundary.
            raise ProbeFailure('RETIREMENT_FIXTURE_RPC_'+name.upper()+'_FAILED',response.status)
        return response.json('RETIREMENT_FIXTURE_RPC_RESULT_INVALID')

    def command(self,operation,body,token):
        return self.rpc('app_command',{'operation':operation,'input':body,'idempotency_key':str(uuid.uuid4())},token)

    def rows(self,table,query,token):
        return expect(self.client.request(self.config.rest_url,'/'+table+'?'+query,token=token),
          {200},'RETIREMENT_FIXTURE_READ_FAILED').json('RETIREMENT_FIXTURE_READ_INVALID')

    def ready(self):
        deadline=time.monotonic()+240
        while time.monotonic()<deadline:
            statuses=[self.client.request(self.config.auth_url,'/health').status,
              self.client.request(self.config.storage_url,'/status').status,
              self.client.request(self.config.rest_url,'/proposal_delivery_records?select=id&limit=1',token=self.config.service_key).status]
            if statuses==[200,200,200]:return
            time.sleep(2)
        raise ProbeFailure('RETIREMENT_FIXTURE_SERVICES_NOT_READY')

    def private_bucket(self):
        result=expect(self.client.request(self.config.storage_url,'/bucket',method='POST',token=self.config.service_key,
          data={'id':BUCKET,'name':BUCKET,'public':False,'file_size_limit':1048576}),{200,201},
          'RETIREMENT_FIXTURE_BUCKET_CREATE_FAILED').json('RETIREMENT_FIXTURE_BUCKET_INVALID')
        require(isinstance(result,dict) and result.get('name')==BUCKET,'RETIREMENT_FIXTURE_BUCKET_INVALID')
        bucket=expect(self.client.request(self.config.storage_url,'/bucket/'+BUCKET,token=self.config.service_key),
          {200},'RETIREMENT_FIXTURE_BUCKET_READ_FAILED').json('RETIREMENT_FIXTURE_BUCKET_INVALID')
        require(bucket.get('id')==BUCKET and bucket.get('public') is False and bucket.get('file_size_limit')==1048576,
          'RETIREMENT_FIXTURE_BUCKET_INVALID')

    def upload(self,key,*,denied=False):
        response=self.client.request(self.config.storage_url,'/object/'+BUCKET+'/'+urllib.parse.quote(key,safe='/'),
          method='POST',token=self.config.service_key,raw=DATA,
          headers={'Content-Type':'application/octet-stream','x-upsert':'false'})
        if denied:
            # The pinned Storage binary reports PostgreSQL P0001 as HTTP 500.
            # A bare 5xx/network failure is insufficient; require the exact
            # database error class established by the native binary proof.
            require(response.status==500,'RETIREMENT_FIXTURE_OLD_KEY_DENIAL_UNPROVEN')
            body=response.json('RETIREMENT_FIXTURE_OLD_KEY_DENIAL_INVALID')
            require(isinstance(body,dict) and 'P0001' in json.dumps(body),
              'RETIREMENT_FIXTURE_OLD_KEY_DENIAL_INVALID')
            return
        expect(response,{200,201},'RETIREMENT_FIXTURE_UPLOAD_FAILED')
        actual=expect(self.client.request(self.config.storage_url,'/object/authenticated/'+BUCKET+'/'+urllib.parse.quote(key,safe='/'),
          token=self.config.service_key),{200},'RETIREMENT_FIXTURE_DOWNLOAD_FAILED').body
        require(actual==DATA,'RETIREMENT_FIXTURE_UPLOADED_BYTES_CHANGED')

    def prepare_upload(self,token,label):
        source=self.command('source.create',{'name':'Synthetic retirement '+label,'kind':'manual'},token)
        opportunity=self.command('opportunity.create',{'source_id':source['id'],'title':'Synthetic retirement '+label,
          'reference':'ISOLATED-RETIREMENT','description':'The supplier must document the approval workflow and demonstrate acceptance.',
          'language':'en','decision':'shortlisted'},token)
        snapshot=self.command('delivery.snapshot.prepare',{'opportunity_id':opportunity['id'],
          'expected_revision':opportunity['revision']},token)
        job=self.rpc('claim_backend_job_v4')
        require(isinstance(job,dict) and job.get('type')=='render_delivery' and job.get('entity_id')==snapshot['id'],
          'RETIREMENT_FIXTURE_CLAIM_MISMATCH')
        export=self.rpc('delivery_export_context',{'job_id':job['id'],'lease':job['lease_token']})
        require(isinstance(export,dict) and isinstance(export.get('artifacts'),list) and len(export['artifacts'])==1,
          'RETIREMENT_FIXTURE_ARTIFACT_SCOPE_INVALID')
        artifact=export['artifacts'][0]
        intent=self.rpc('begin_render_storage_write',{'job_id':job['id'],'lease':job['lease_token'],
          'storage_key':artifact['storage_key'],'expected_hash':CHECKSUM,'expected_size':len(DATA)})
        require(isinstance(intent,dict) and intent.get('send') is True and intent.get('state')=='unknown',
          'RETIREMENT_FIXTURE_SEND_NOT_AUTHORIZED')
        self.upload(artifact['storage_key'])
        # Fault injection: bytes reached real Storage, but this synthetic worker
        # does not acknowledge artifact completion. The canonical failure RPC
        # preserves uncertainty and clears its actual lease before Owner purge.
        self.rpc('fail_delivery_export',{'job_id':job['id'],'lease':job['lease_token'],
          'error_code':'DELIVERY_STORAGE_UNAVAILABLE'})
        return opportunity,artifact['storage_key']

    def prepare(self):
        require(not STATE.exists(),'RETIREMENT_FIXTURE_ALREADY_INITIALIZED')
        self.ready();owner,other=self.auth();actor,token=owner
        identities=self.rpc('retirement_fixture_users',{'source_user':actor,'target_user':other[0]})
        require(identities.get('actor_id')==actor and identifier(identities.get('workspace_id')),
          'RETIREMENT_FIXTURE_OWNER_INVALID')
        settings=self.rows('model_execution_settings','select=enabled',token)
        operations=self.rows('operations','select=scheduler_enabled',token)
        require(not any(row.get('enabled') is not False for row in settings) and operations
          and not any(row.get('scheduler_enabled') is not False for row in operations),
          'RETIREMENT_FIXTURE_EXTERNAL_PROCESSING_ENABLED')
        self.private_bucket();opportunity,key=self.prepare_upload(token,'interrupted write')
        current=self.rows('opportunities','id=eq.'+opportunity['id']+'&select=revision',token)
        require(len(current)==1,'RETIREMENT_FIXTURE_OPPORTUNITY_CHANGED')
        self.rpc('archive_opportunity',{'opportunity_id':opportunity['id'],'expected_revision':current[0]['revision'],
          'archive':True,'reason':'Synthetic Owner purge of an unacknowledged isolated upload.'},token)
        preview=self.rpc('preview_opportunity_purge',{'opportunity_id':opportunity['id']},token)
        require(preview.get('archived') is True and preview.get('active_worker') is False,
          'RETIREMENT_FIXTURE_CANONICAL_PURGE_NOT_READY')
        self.rpc('purge_opportunity',{'opportunity_id':opportunity['id'],'preview_hash':preview['preview_hash'],
          'confirmed_title':opportunity['title'],'reason':'Synthetic Owner purge for isolated process retirement proof.',
          'acknowledge_history':True},token)
        fixture=validate_fixture(self.rpc('retirement_fixture_selection',{'storage_key':key,'expected_hash':CHECKSUM,'expected_size':len(DATA)}))
        uncertainty=self.rpc('workspace_status',token=token)['storage_write_uncertainty']
        require(uncertainty['held_bytes']==10485760 and uncertainty['unsettled_keys']==1,
          'RETIREMENT_FIXTURE_UNKNOWN_QUOTA_NOT_RETAINED')
        save_private({'version':1,'database':self.config.database,'prefix':self.config.prefix,
          'actor_id':actor,'refresh_token':self.refresh_tokens[actor],'fixture':fixture},initial=True)
        return fixture

    def loaded(self):
        state=load_private(self.config)
        result=expect(self.client.request(self.config.auth_url,'/token?grant_type=refresh_token',method='POST',
          token=self.config.anon_key,data={'refresh_token':state['refresh_token']}),{200},
          'RETIREMENT_FIXTURE_SESSION_REFRESH_FAILED').json('RETIREMENT_FIXTURE_SESSION_REFRESH_INVALID')
        actor,token=self.session(result)
        require(actor==state['actor_id'],'RETIREMENT_FIXTURE_OWNER_CHANGED')
        state['refresh_token']=self.refresh_tokens[actor];save_private(state)
        return state,token

    def status(self):
        state,token=self.loaded();key=state['fixture']['selection'][0]['storage_key']
        value=self.rpc('retirement_fixture_status',{'storage_key':key})
        value['uncertainty']=self.rpc('workspace_status',token=token)['storage_write_uncertainty']
        return value

    def verify(self):
        self.ready();state,token=self.loaded();key=state['fixture']['selection'][0]['storage_key']
        status=self.rpc('retirement_fixture_status',{'storage_key':key})
        uncertainty=self.rpc('workspace_status',token=token)['storage_write_uncertainty']
        require(status['intent_state']=='quiesced' and status['send_closed'] is True and status['cleanup_status']=='done'
          and status['fence_count']==1 and status['completed_batch_count']==1 and status['completion_audit_count']==1
          and status['provider_usage_count']==0 and uncertainty['held_bytes']==0 and uncertainty['unsettled_keys']==0,
          'RETIREMENT_FIXTURE_COMPLETION_NOT_EXACT')
        self.upload(key,denied=True)
        # A distinct positive control uses another real canonical reservation.
        # Its retained uncertainty belongs only to this disposable fixture and
        # is not included in the completed old-key accounting check above.
        _,new_key=self.prepare_upload(token,'new key after restart')
        require(new_key!=key and new_key.startswith(state['fixture']['workspace_id']+'/'),
          'RETIREMENT_FIXTURE_NEW_KEY_INVALID')
        return {'checks':{'old_intent_quiesced':True,'old_quota_released_with_one_completion_audit':True,
          'old_key_http_upload_denied':True,
          'new_canonical_key_uploaded_and_read':True,'provider_usage_absent_before_positive_control':True},
          'new_storage_key':new_key,'physical_absence_proven_by_http':False}


def main():
    try:
        require(sys.argv[1:] in (['prepare'],['verify'],['status']),'RETIREMENT_FIXTURE_MODE_INVALID')
        original=Config.from_env()
        require(original.database.rsplit('_',1)[-1]==original.prefix.rsplit('_',1)[-1],
          'RETIREMENT_FIXTURE_ENDPOINT_SCOPE_INVALID')
        client=RetirementClient(replace(original,storage_url='http://gateway:8081/storage/v1'))
        result=getattr(client,sys.argv[1])()
        print(json.dumps(result,sort_keys=True,separators=(',',':')),flush=True)
        return 0
    except ProbeFailure as error:
        print(json.dumps({'failed':True,'code':error.code,'http_status':error.http_status}),flush=True)
        return 1
    except Exception:
        print(json.dumps({'failed':True,'code':'RETIREMENT_FIXTURE_UNEXPECTED_FAILURE'}),flush=True)
        return 1


if __name__=='__main__':raise SystemExit(main())
