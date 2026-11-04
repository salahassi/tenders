#!/usr/bin/env python3
"""Isolated pinned HTTPS -> Nginx -> synthetic JSON streaming qualification.

The exact Caddyfile is retained. PUBLIC_HOST=localhost obtains an offline local
certificate; the client trusts that exact local CA and verifies its hostname.
No production endpoints, published ports, credentials or model calls are used.
"""
from __future__ import annotations
import argparse
import base64
import gzip
import hashlib
import http.client
import importlib.metadata
import json
import os
import re
from pathlib import Path
import shutil
import socket
import ssl
import stat
import subprocess
import tempfile
import threading
import time
import uuid

import zstandard
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from legacy_batch_gateway import NGINX, DOCKER, executed_config
HELPER = 'docker.io/denoland/deno@sha256:3dc638972caa62978182228a5a575e0498ae45129aa1c3ee8548663652ef7ab6'

ROOT = Path(__file__).resolve().parents[3]
CADDY_BASE = 'docker.io/library/caddy:2.11.2-alpine@sha256:6d125e80883be8a2bef5f088c7535945b42cdbb8a0f5471bf36eaf18dc0638f1'
REBUILT_IMAGE = 'sha256:70cfd48b8dab5a2128d23c4a2148023474ced2cc0faa1f96dacd2534c5ce1e0f'
DEPLOYED_IMAGE = 'registry.digitalocean.com/tenderdesk-a6093a76/https@sha256:3a539c44f0907ba846f70ae6e97f477cccf2a34cc84cc492201d5d73e7cfa7ce'
DEFAULT_IMAGE = DEPLOYED_IMAGE
TOTAL = 412_758_765
BLOCK = 65_536
BUDGET = 64 * 1024**2
PREFIX, SUFFIX = b'{"data":"', b'"}'
KEY, IV = bytes([7])*32, bytes([3])*16
UPSTREAM = r'''const http=require('node:http'),crypto=require('node:crypto');const records={};
const total=412758765,prefix=Buffer.from('{"data":"'),suffix=Buffer.from('"}'),zero=Buffer.alloc(49152);
http.createServer((req,res)=>{const url=new URL(req.url,'http://synthetic');const id=url.searchParams.get('id');
 if(!id){res.end('synthetic');return;}const state=records[id]={sent:0,closed:false,completed:false,backpressure:0};
 const hash=crypto.createHash('sha256'),cipher=crypto.createCipheriv('aes-256-ctr',Buffer.alloc(32,7),Buffer.alloc(16,3));
 let remaining=total-prefix.length-suffix.length,stage=0;
 res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.setHeader('content-length',total);
 res.on('close',()=>{state.closed=true;});
 function pump(){while(!state.closed&&stage<3){let chunk;
  if(stage===0){chunk=prefix;stage=1;}
  else if(stage===1&&remaining){const full=Buffer.from(cipher.update(zero).toString('base64'));chunk=full.subarray(0,Math.min(full.length,remaining));remaining-=chunk.length;}
  else{chunk=suffix;stage=3;}
  hash.update(chunk);state.sent+=chunk.length;
  if(!res.write(chunk)){state.backpressure++;res.once('drain',pump);return;}}
  if(!state.closed&&stage===3){state.completed=true;state.sha256=hash.digest('hex');res.end();}}
 pump();}).listen(19080,'0.0.0.0');
http.createServer((req,res)=>res.end(JSON.stringify(records))).listen(19090,'0.0.0.0');'''


def sha(value): return hashlib.sha256(value).hexdigest()

def payload_hash(size=TOTAL):
    if size < len(PREFIX)+len(SUFFIX): raise ValueError('PAYLOAD_TOO_SMALL')
    h=hashlib.sha256();h.update(PREFIX);remaining=size-len(PREFIX)-len(SUFFIX)
    cipher=Cipher(algorithms.AES(KEY),modes.CTR(IV)).encryptor();zero=bytes(49_152)
    while remaining:
        block=base64.b64encode(cipher.update(zero));part=block[:min(remaining,len(block))]
        h.update(part);remaining-=len(part)
    h.update(SUFFIX);return h.hexdigest()


def census(paths, process_ids=()):
    files={};deleted=set();observed=0
    def add(value):
        if stat.S_ISREG(value.st_mode):files[(value.st_dev,value.st_ino)]=value
    for root in paths:
        for base,_,names in os.walk(root):
            for name in names:
                try:add((Path(base)/name).stat())
                except FileNotFoundError:pass
    # Include private open-unlinked spool files; directory names alone miss them.
    for pid in process_ids:
        try:
            for fd in (Path('/proc')/str(pid)/'fd').iterdir():
                try:
                    target=os.readlink(fd)
                    if target.startswith(('/tmp/','/data/','/config/')):
                        value=fd.stat();add(value)
                        if target.endswith(' (deleted)'):deleted.add((value.st_dev,value.st_ino))
                except (FileNotFoundError,ProcessLookupError):pass
            observed+=1
        except (FileNotFoundError,ProcessLookupError):pass
    return {'logical_bytes':sum(x.st_size for x in files.values()),'allocated_bytes':sum(x.st_blocks*512 for x in files.values()),
            'files':len(files),'open_unlinked_files':len(deleted),'observed_processes':observed}


class TLSConnection(http.client.HTTPSConnection):
    """Connect to the isolated IP while retaining actual localhost TLS checks."""
    def __init__(self, ip, context):
        super().__init__('localhost',8443,timeout=15,context=context);self.ip=ip
    def connect(self):
        raw=socket.create_connection((self.ip,8443),self.timeout)
        try: self.sock=self._context.wrap_socket(raw,server_hostname='localhost')
        except BaseException: raw.close();raise


class CountedReader:
    def __init__(self, response): self.response=response;self.bytes=0
    def read(self, size=-1):
        if size < 0: raise RuntimeError('UNBOUNDED_CLIENT_READ')
        value=self.response.read(min(size,BLOCK));self.bytes+=len(value);return value
    def readinto(self, target):
        value=self.read(len(target));target[:len(value)]=value;return len(value)
    def readable(self): return True
    def close(self): self.response.close()


class Proof:
    def __init__(self, output, image):
        self.output=output;self.image=image;self.nonce=uuid.uuid4().hex[:12]
        self.base='tdp-https-stream-'+self.nonce;self.net=self.base+'-net'
        self.helper=self.base+'-upstream';self.gateway=self.base+'-gateway';self.https=self.base+'-https'
        self.temp=Path(tempfile.mkdtemp(prefix=self.base+'-',dir='/workspace/work'));self.temp.chmod(0o755)
        self.owned=[];self.network_owned=False
        self.paths={}
        for name in ('gateway-tmp','https-tmp','data','config'):
            path=self.temp/name;path.mkdir(mode=0o777);path.chmod(0o777);self.paths[name]=path
        self.receipt={'version':1,'passed':False,'synthetic_only':True,'production_calls':0,'customer_calls':0,'model_calls':0,
          'source_revision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
          'source_hashes':self.sources(),'client_library_versions':{name:importlib.metadata.version(name) for name in ('cryptography','zstandard')},'images':{'https':image,'https_declared_source_base':CADDY_BASE,'gateway':NGINX,'helper':HELPER},
          'https_is_deployed_registry_image':image==DEPLOYED_IMAGE,'hosted_resource_observation':{'receipt':'digitalocean-https-capacity-20261104-41928176279.json','sha256':'92298f14f069856591be81a07baff9807b85d7a181ac83e167b3cb0ec1692c4a','source_revision':'f331c28f727f19623715be00f98a001bd04185bb','scope':'read-only observed image/resources only; no hosted transport qualification'},'tls':{'hostname':'localhost','verification_enabled':True,'issuer':'offline local CA'},
          'payload':{'bytes':TOTAL,'content_type':'application/json','algorithm':'AES-256-CTR fixed synthetic key/IV, zero input, per-49152-byte base64 blocks, exact JSON wrapper','aggregate_materialized':False},
          'resources':{'https_memory_bytes':128*1024**2,'https_cpu_millicores':300,'gateway_memory_bytes':BUDGET,'gateway_cpu_millicores':200,'gateway_workers':1,'gateway_worker_count_basis':'exact production directive, no worker-count transform',
            'helper_memory_bytes':128*1024**2,'helper_cpu_millicores':1000,'swap':False,'published_ports':[],
            'network':'nonce-owned internal bridge; gateway shares upstream namespace','docker_injected_proxy_variables_removed_for_fixture_only':True,'client':'external bounded Python stream reader; memory outside service cgroups',
            'decoded_read_bytes':BLOCK,'pause_ms_per_read':4,'per_transfer_wall_limit_seconds':180,'tmp_budget_per_service_bytes':BUDGET,
            'tmp_enforcement':'workspace-overlay bind mount, directory plus owned-process open-unlinked inode census; observed budget, not filesystem ENOSPC','https_limit_provenance':'repository render.py and separate read-only hosted Deployment/ready-Pod observation41928176279; local execution remains separate'},
          'limitations':['Exact selected image is tested locally; no inference that local execution proves production rollout/configuration.',
            'Synthetic varying ASCII JSON has the prior measured batch response byte length, not actual application/Auth/SQL data.',
            'Local certificate-state storage is an overlay bind mount; production PVC durability/latency is not qualified.',
            'HTTP/1.1 TLS and each encoding are measured; HTTP/2, HTTP/3, public CA/ACME, cloud LoadBalancer and hosted traffic are not qualified.',
            'One full response and one early cancellation per encoding, not concurrent load, universal output size or issuance SLO.',
            'Only Nginx loopback service/DNS coordinates are fixture substitutions; exact production worker_processes1, Caddyfile, compression and TLS remain.']}
    def sources(self):
        files=[Path(__file__),Path(__file__).with_name('legacy_batch_gateway.py'),ROOT/'backend/deploy/Dockerfile.https',ROOT/'backend/deploy/kubernetes/Caddyfile',ROOT/'backend/deploy/kubernetes/gateway.conf',ROOT/'backend/deploy/kubernetes/render.py']
        return {str(p.relative_to(ROOT)):sha(p.read_bytes()) for p in files}
    def save(self): self.output.write_text(json.dumps(self.receipt,indent=2,sort_keys=True)+'\n')
    def docker(self,*args,check=True):
        env={k:v for k,v in os.environ.items() if k not in ('DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH')}
        r=subprocess.run(DOCKER+list(args),capture_output=True,text=True,timeout=45,env=env)
        if check and r.returncode: raise RuntimeError('DOCKER_FAILED_'+args[0]+'_'+sha(r.stderr.encode())[:16])
        return r
    def launch(self,name,*args):
        if self.docker('inspect',name,check=False).returncode==0: raise RuntimeError('FOREIGN_NAME_COLLISION')
        # Journal the exact nonce name before create, so an ambiguous ACK is still inspected during cleanup.
        self.owned.append(name)
        self.docker('run','-d','--pull=never','--name',name,'--label','tenderdesk.https-streaming='+self.nonce,*args)
    def inspect(self,name): return json.loads(self.docker('inspect',name).stdout)[0]
    def ip(self,name): return self.inspect(name)['NetworkSettings']['Networks'][self.net]['IPAddress']
    def json_get(self,port):
        c=http.client.HTTPConnection(self.helper_ip,port,timeout=3)
        try:
            c.request('GET','/');r=c.getresponse();body=r.read(65537)
            if r.status!=200 or len(body)>65536: raise RuntimeError('CONTROL_RESPONSE_INVALID')
            return json.loads(body)
        finally:c.close()
    def process_ids(self,name):
        values=self.docker('top',name,'-eo','pid').stdout.splitlines()
        assert values and values[0].strip()=='PID'
        result=sorted(int(x.strip()) for x in values[1:]);assert result and len(result)<=64
        return result
    def memory(self,name):
        raw=self.docker('exec',name,'sh','-c','cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/memory.current; cat /sys/fs/cgroup/memory.swap.current; cat /sys/fs/cgroup/memory.events').stdout.splitlines()
        return {'peak_bytes':int(raw[0]),'current_bytes':int(raw[1]),'swap_bytes':int(raw[2]),'events':{x.split()[0]:int(x.split()[1]) for x in raw[3:]}}
    def start(self):
        for image in (self.image,CADDY_BASE,NGINX,HELPER): self.docker('image','inspect',image)
        https=json.loads(self.docker('image','inspect',self.image).stdout)[0]
        base=json.loads(self.docker('image','inspect',CADDY_BASE).stdout)[0]
        if self.image==DEPLOYED_IMAGE:
            assert DEPLOYED_IMAGE in https.get('RepoDigests',[]),'DEPLOYED_DIGEST_MISMATCH'
            self.receipt['image_binding']={'kind':'exact_deployed_registry_digest','repo_digest':DEPLOYED_IMAGE,'local_image_id':https['Id']}
        else:
            iid=self.temp/'build.iid'
            build_args=('build','--pull=false','--network=none','--iidfile',str(iid),'-f',str(ROOT/'backend/deploy/Dockerfile.https'),str(ROOT))
            built=self.docker(*build_args)
            assert iid.read_text().strip()==self.image,'SOURCE_BUILD_IMAGE_MISMATCH'
            layers=base['RootFS']['Layers']
            assert https['RootFS']['Layers'][:-1]==layers and len(https['RootFS']['Layers'])==len(layers)+1,'PINNED_BASE_LAYER_MISMATCH'
            self.receipt['image_binding']={'kind':'exact_local_source_build','result_image_id':iid.read_text().strip(),
              'output_sha256':sha((built.stdout+built.stderr).encode()),'base_image_id':base['Id'],'base_layers_match':True}
        self.receipt['https_image_id']=https['Id'];self.receipt['https_image_user']=https['Config']['User']
        assert https['Config']['User']=='1000:1000'
        if self.docker('network','inspect',self.net,check=False).returncode==0:raise RuntimeError('FOREIGN_NETWORK_COLLISION')
        self.network_owned=True
        self.docker('network','create','--internal','--label','tenderdesk.https-streaming='+self.nonce,self.net)
        script=self.temp/'upstream.cjs';script.write_text(UPSTREAM);script.chmod(0o644)
        self.receipt['upstream_sha256']=sha(script.read_bytes())
        common=['--user','1000:1000','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64']
        # Docker injects session proxies; the production Pod has none. All traffic here is isolated fixture traffic.
        for name in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy'):common+=['-e',name+'=']
        self.launch(self.helper,'--network',self.net,'--network-alias','gateway',*common,'--memory','128m','--memory-swap','128m','--cpus','1','-v',str(script)+':/upstream.cjs:ro','--entrypoint','deno',HELPER,'run','--no-config','--no-npm','--no-remote','--allow-read','--allow-net=0.0.0.0:19080,0.0.0.0:19090','/upstream.cjs')
        self.helper_ip=self.ip(self.helper)
        for _ in range(60):
            try:self.json_get(19090);break
            except (OSError,ValueError):time.sleep(.1)
        else:raise RuntimeError('UPSTREAM_NOT_READY')
        source=(ROOT/'backend/deploy/kubernetes/gateway.conf').read_text()
        assert source.count('proxy_buffering off;')==2,'GREEN_GATEWAY_STREAMING_REQUIRED'
        assert source.count('worker_processes 1;')==1 and 'worker_processes auto;' not in source,'PINNED_PRODUCTION_WORKER_COUNT_REQUIRED'
        config=self.temp/'nginx.conf';config.write_text(executed_config(source));config.chmod(0o644)
        self.receipt['gateway_executed_config_sha256']=sha(config.read_bytes())
        self.launch(self.gateway,'--network','container:'+self.helper,*common,'--memory','64m','--memory-swap','64m','--cpus','.2',
          '-v',str(self.paths['gateway-tmp'])+':/tmp','-v',str(config)+':/etc/nginx/nginx.conf:ro','--entrypoint','nginx',NGINX,'-g','daemon off;')
        for _ in range(60):
            c=http.client.HTTPConnection(self.helper_ip,8080,timeout=2)
            try:
                c.request('GET','/healthz');r=c.getresponse()
                if r.status==200 and r.read(128)==b'ok\n':break
            except OSError:pass
            finally:c.close()
            time.sleep(.1)
        else:raise RuntimeError('GATEWAY_NOT_READY')
        self.launch(self.https,'--network',self.net,*common,'--memory','128m','--memory-swap','128m','--cpus','.3',
          '-e','PUBLIC_HOST=localhost','-e','XDG_DATA_HOME=/data','-e','XDG_CONFIG_HOME=/config',
          '-v',str(ROOT/'backend/deploy/kubernetes/Caddyfile')+':/etc/caddy/Caddyfile:ro',
          '-v',str(self.paths['https-tmp'])+':/tmp','-v',str(self.paths['data'])+':/data','-v',str(self.paths['config'])+':/config',
          '--entrypoint','caddy',self.image,'run','--config','/etc/caddy/Caddyfile','--adapter','caddyfile')
        self.https_ip=self.ip(self.https)
        self.receipt['mount_filesystems']={}
        for name,paths in ((self.gateway,('/tmp',)),(self.https,('/tmp','/data','/config'))):
            observed=self.docker('exec',name,'stat','-f','-c','%t',*paths).stdout.splitlines()
            assert len(observed)==len(paths) and all(x.lower()=='794c7630' for x in observed),('DISK_BACKED_FIXTURE_REQUIRED',observed)
            self.receipt['mount_filesystems']['gateway' if name==self.gateway else 'https']={'statfs_magic':dict(zip(paths,observed)),'meaning':'Linux overlayfs (0x794c7630); tmpfs magic is rejected'}
        ca=self.paths['data']/'caddy/pki/authorities/local/root.crt'
        for _ in range(100):
            if ca.exists():break
            if not self.inspect(self.https)['State']['Running']:raise RuntimeError('HTTPS_EXITED_AT_START')
            time.sleep(.1)
        else:raise RuntimeError('LOCAL_CA_NOT_READY')
        self.context=ssl.create_default_context(cafile=str(ca));self.receipt['tls']['root_ca_sha256']=sha(ca.read_bytes())
        self.receipt['https_binary_version']=self.docker('exec',self.https,'caddy','version').stdout.strip()
        self.receipt['https_binary_sha256']=self.docker('exec',self.https,'sha256sum','/usr/bin/caddy').stdout.split()[0]
        conn=TLSConnection(self.https_ip,self.context)
        try:
            conn.request('GET','/healthz');response=conn.getresponse();body=response.read(128)
            self.receipt['tls']['health_status']=response.status;self.receipt['tls']['health_body_sha256']=sha(body)
            assert response.status==200 and body==b'ok\n',('TLS_HEALTH_INVALID',response.status,len(body),sha(body))
            self.receipt['tls']['actual_handshake_verified']=True
        finally:conn.close()
        self.receipt['payload']['sha256']=payload_hash()
    def transfer(self,encoding,cancel=False):
        name=encoding+('-cancel' if cancel else '-full');started=time.monotonic();peaks={};stop=threading.Event();bad=[];health=[];observer_errors=[]
        pids={'gateway':self.process_ids(self.gateway),'https':self.process_ids(self.https)}
        assert len(pids['gateway'])==2,'EXACT_NGINX_MASTER_PLUS_ONE_WORKER_REQUIRED'
        def observe():
            next_health=0
            while not stop.is_set():
                for key,paths in [('gateway',[self.paths['gateway-tmp']]),('https',[self.paths['https-tmp'],self.paths['data'],self.paths['config']])]:
                    try:
                        row=census(paths,pids[key])
                        if row['observed_processes']!=len(pids[key]):raise RuntimeError('OWNED_PROCESS_OBSERVATION_INCOMPLETE')
                    except Exception as error:observer_errors.append(type(error).__name__);return
                    prior=peaks.setdefault(key,dict.fromkeys(row,0))
                    for field in row:prior[field]=max(prior[field],row[field])
                    if max(row['logical_bytes'],row['allocated_bytes'])>BUDGET:bad.append(key)
                if time.monotonic()>=next_health:
                    c=http.client.HTTPConnection(self.https_ip,8082,timeout=2)
                    try:c.request('GET','/healthz');r=c.getresponse();health.append(r.status==200 and r.read(32)==b'ok')
                    except OSError:health.append(False)
                    finally:c.close()
                    next_health=time.monotonic()+.5
                stop.wait(.005)
        thread=threading.Thread(target=observe);thread.start();conn=TLSConnection(self.https_ip,self.context);response=None;reader=None;counted=None
        h=hashlib.sha256();count=0;outcome='started'
        try:
            conn.request('GET','/functions/v1/api/v1/synthetic-stream?id='+name,headers={'Accept-Encoding':encoding,'Connection':'close'})
            response=conn.getresponse();headers_ms=round((time.monotonic()-started)*1000)
            actual=response.getheader('Content-Encoding','identity')
            assert response.status==200 and actual==encoding,(response.status,actual)
            counted=CountedReader(response)
            reader=gzip.GzipFile(fileobj=counted,mode='rb') if encoding=='gzip' else zstandard.ZstdDecompressor().stream_reader(counted,read_size=BLOCK) if encoding=='zstd' else counted
            while True:
                if time.monotonic()-started>180:raise RuntimeError('TRANSFER_WALL_DEADLINE')
                if bad:raise RuntimeError('TEMPORARY_DISK_BUDGET_EXCEEDED')
                if observer_errors:raise RuntimeError('TEMPORARY_DISK_OBSERVER_FAILED')
                chunk=reader.read(BLOCK)
                if not chunk:outcome='complete';break
                h.update(chunk);count+=len(chunk)
                if cancel and count>=2*1024**2:outcome='cancelled';break
                time.sleep(.004)
        finally:
            try:
                if reader is not None:reader.close()
            finally:
                try:
                    if response is not None:response.close()
                finally:conn.close();stop.set();thread.join()
        result={'encoding':encoding,'outcome':outcome,'decoded_bytes':count,'wire_body_bytes':counted.bytes,'decoded_sha256':h.hexdigest(),
          'headers_ms':headers_ms,'elapsed_seconds':round(time.monotonic()-started,3),'health_checks':len(health),'health_failed':health.count(False),
          'temporary_peak':peaks,'memory':{'https':self.memory(self.https),'gateway':self.memory(self.gateway),'helper':self.memory(self.helper)}}
        self.receipt['last_transfer']=result
        for key,limit in [('https',128*1024**2),('gateway',BUDGET),('helper',128*1024**2)]:
            row=result['memory'][key];assert row['peak_bytes']<=limit and row['swap_bytes']==0 and row['events'].get('oom_kill',0)==0,row
        assert not bad and not observer_errors and health and all(health)
        assert self.process_ids(self.gateway)==pids['gateway'] and self.process_ids(self.https)==pids['https'],'OWNED_PROCESS_SET_CHANGED'
        deadline=time.monotonic()+4
        while True:
            source=self.json_get(19090)[name]
            if source['closed'] or time.monotonic()>deadline:break
            time.sleep(.05)
        if cancel:
            assert outcome=='cancelled' and source['closed'] and not source['completed'] and source['sent']<TOTAL,source
            time.sleep(.2);assert self.json_get(19090)[name]['sent']==source['sent']
        else:
            assert outcome=='complete' and count==TOTAL and h.hexdigest()==self.receipt['payload']['sha256'],result
            assert source['completed'] and source['sent']==TOTAL and source['sha256']==h.hexdigest(),source
            # Valid encoding can expand incompressible input. The exact negotiated
            # Content-Encoding, successful decoder and full hash are the oracle.
            assert result['wire_body_bytes']>0
        result['upstream_after_completion_or_cancel']=source;return result
    def qualify(self):
        self.start();self.receipt['transfers']=[]
        for encoding in ('identity','gzip','zstd'):
            for cancel in (False,True):
                result=self.transfer(encoding,cancel);self.receipt['transfers'].append(result);self.save()
                print(json.dumps({'encoding':encoding,'outcome':result['outcome'],'seconds':result['elapsed_seconds']}),flush=True)
        self.receipt['source_unchanged']=self.sources()==self.receipt['source_hashes'];assert self.receipt['source_unchanged']
        self.receipt.update(passed=True,actual_binary_exercised=True,exact_delivery_qualified=True,cancellation_qualified=True,
          temporary_budget_qualified=True,resource_envelope_qualified=True,tls_streaming_qualified=True,
          qualified_encodings=['identity','gzip','zstd'])
    def cleanup(self):
        for name in reversed(self.owned):
            result=self.docker('inspect',name,check=False)
            if result.returncode:continue
            state=json.loads(result.stdout)[0]
            self.receipt.setdefault('final_container_states',{})[name.rsplit('-',1)[-1]]={key:state['State'].get(key) for key in ('Running','OOMKilled','Dead','ExitCode','Error')}
            if state['Config'].get('Labels',{}).get('tenderdesk.https-streaming')!=self.nonce:raise RuntimeError('FOREIGN_CLEANUP_REFUSED')
            self.docker('rm','-f',name)
            assert self.docker('inspect',name,check=False).returncode!=0
        network=self.docker('network','inspect',self.net,check=False) if self.network_owned else None
        if network is not None and network.returncode==0:
            value=json.loads(network.stdout)[0]
            assert value['Labels'].get('tenderdesk.https-streaming')==self.nonce
            self.docker('network','rm',self.net)
            assert self.docker('network','inspect',self.net,check=False).returncode!=0
        # A failed inspect alone is not absence proof when the daemon is unavailable.
        assert not self.docker('ps','-aq','--filter','label=tenderdesk.https-streaming='+self.nonce).stdout.strip()
        assert not self.docker('network','ls','-q','--filter','label=tenderdesk.https-streaming='+self.nonce).stdout.strip()
        shutil.rmtree(self.temp);self.receipt['cleanup_confirmed']=True


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--image',default=DEFAULT_IMAGE);args=parser.parse_args()
    if args.image not in (DEPLOYED_IMAGE,REBUILT_IMAGE):raise ValueError('REVIEWED_IMMUTABLE_IMAGE_REQUIRED')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    if args.output.exists():raise ValueError('FRESH_RECEIPT_REQUIRED')
    proof=Proof(args.output,args.image)
    try:proof.qualify()
    except BaseException as error:
        proof.receipt.update(passed=False,failure_class=type(error).__name__,failure_detail=str(error)[:1000])
        diagnostics=[]
        for name in proof.owned:
            result=proof.docker('logs','--tail','20',name,check=False)
            diagnostics.append(name+'\n'+result.stdout[:4000]+result.stderr[:4000])
        data='\n'.join(diagnostics)
        args.output.with_name('local-diagnostic.txt').write_text(data)
        proof.receipt['private_diagnostic_sha256']=sha(data.encode())
    finally:
        try:proof.cleanup()
        except Exception as error:
            proof.receipt.update(passed=False,cleanup_confirmed=False,cleanup_failure_class=type(error).__name__,cleanup_failure_detail=str(error)[:500])
        finally:proof.save()
    print(json.dumps({'passed':proof.receipt['passed'],'cleanup_confirmed':proof.receipt.get('cleanup_confirmed',False),'receipt_sha256':sha(args.output.read_bytes())}))
    return 0 if proof.receipt['passed'] else 1

if __name__=='__main__':raise SystemExit(main())
