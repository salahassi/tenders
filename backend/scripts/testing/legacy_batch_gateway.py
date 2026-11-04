#!/usr/bin/env python3
"""Offline pinned Nginx routing proof with a synthetic recording upstream.

No host ports, database, real credentials, external HTTP or production calls.
The exact routing rules execute in the pinned binary; only loopback transport
coordinates and worker count differ. This is not database-drain qualification.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
GATEWAY = ROOT / 'backend/deploy/kubernetes/gateway.conf'
BEFORE = ROOT / 'backend/scripts/ops/storage-retirement/gateway-storage-qualified.conf'
STORAGE_RECEIPT = ROOT / 'backend/docs/evidence/storage-retirement-binary-20261104.json'
NGINX = 'docker.io/nginxinc/nginx-unprivileged:1.29.5-alpine@sha256:99e7cb7bee644b244b2b5e7bb737e972e54dbaa150cabc7ae0598731cdeb7ac8'
NODE = 'docker.io/supabase/storage-api:v1.81.0@sha256:92c5fe87ba5291915d0c21ca530ece9a58e13cc76a36a6c84fc69121a8dde799'
DOCKER = ['docker', '--host=unix:///var/run/docker.sock']
UPGRADE = {'code': 'TRANSPORT_UPGRADE_REQUIRED', 'message': 'Refresh the application to use the current command transport.', 'retryable': False, 'details': None}


def sha(value): return hashlib.sha256(value).hexdigest()
def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def legacy_paths():
    paths = []
    for name in ('app_batch', 'apply_batch'):
        paths += [
            '/rest/v1/rpc/' + name,
            '/rest/v1/rpc/' + name + '?commands=%5B%5D&note=/rpc/app_batch_prepare',
            '/REST/V1/RPC/' + name.upper(),
            '/rest//v1//rpc//' + name + '//',
            '/rest/v1/tables/../rpc/' + name,
            '/rest/v1/tables/%2e%2e/rpc/' + name,
            '/rest%2fv1%2frpc%2f' + name,
            '/%72est/%76%31/%72pc/' + name,
            '/rest/v1/rpc/%61' + name[1:],
            '/rest/v1/rpc/' + name.replace('_', '%5F'),
            '/rest/v1/rpc/' + name.replace('_', '%255F'),
            '/rest/v1/%2572pc/' + name,
            '/rest/v1/rpc%252f' + name,
            '/rest/v1/rpc/' + name + '/extra',
            '/rest/v1/rpc/' + name + '%2fextra',
            '/rest/v1/rpc/' + name + '%252fextra',
            '/rest/v1/rpc/' + name + ';ignored',
            '/rest/v1/rpc/' + name + '.json',
            '/rest/v1/rpc/' + name + '\\extra',
            '/rest/v1/rpc/' + name + '%5cextra',
        ]
    return paths


def tus_paths():
    return [
        '/storage/v1/upload/resumable', '/storage/v1/upload/resumable/sign',
        '/storage/v1/upload/resumable/sign/', '/storage//v1//upload//resumable//sign',
        '/storage/v1/object/../upload/resumable/sign', '/storage/v1/object/%2e%2e/upload/resumable/sign',
        '/storage/v1/%75pload/resumable/sign', '/storage/v1/upload/%72esumable/sign',
        '/storage%2fv1%2fupload%2fresumable%2fsign', '/storage/%76%31/upload/resumable/sign',
        '/STORAGE/V1/UPLOAD/RESUMABLE/SIGN', '/storage/v1/%2575pload/resumable/sign',
        '/storage/v1/upload%252fresumable%252fsign', '/storage/v1/upload\\resumable\\sign',
        '/storage/v1/upload;ignored/resumable/sign', '/storage/v1/upload/resumable/sign/extra',
        '/storage/v1/upload/resumableevil', '/storage/v1/upload/resumable/sign?query=/object/allowed',
        '/storage/v1/up%256coad/resumable/sign',
    ]


def ordinary_paths():
    # All are synthetic routing assertions, not successful business operations.
    return [
        ('POST', '/rest/v1/rpc/app_batch_prepare', 3000, '/rpc/app_batch_prepare'),
        ('POST', '/rest/v1/rpc/app_batch_result_chunk', 3000, '/rpc/app_batch_result_chunk'),
        ('POST', '/rest/v1/rpc/app_command', 3000, '/rpc/app_command'),
        ('POST', '/rest/v1/rpc/app_batch_other', 3000, '/rpc/app_batch_other'),
        ('GET', '/rest/v1/documents?select=id&name=eq.app_batch', 3000, '/documents?select=id&name=eq.app_batch'),
        ('GET', '/rest/v1/rpc/workspace_status?note=%252Fapp_batch', 3000, '/rpc/workspace_status?note=%252Fapp_batch'),
        ('GET', '/auth/v1/health', 9999, '/health'),
        ('POST', '/auth/v1/token?grant_type=password', 9999, '/token?grant_type=password'),
        ('POST', '/storage/v1/object/tenderdesk-private/synthetic.docx', 5000, '/object/tenderdesk-private/synthetic.docx'),
        ('GET', '/storage/v1/object/tenderdesk-private/synthetic.docx', 5000, '/object/tenderdesk-private/synthetic.docx'),
        ('POST', '/storage/v1/object/upload/sign/tenderdesk-private/synthetic.docx', 5000, '/object/upload/sign/tenderdesk-private/synthetic.docx'),
        ('GET', '/functions/v1/api/v1/bootstrap', 19080, '/functions/v1/api/v1/bootstrap'),
    ]


def executed_config(source):
    text = source.replace('__NAMESPACE__', 'synthetic')
    for service, port, target in [('rest', 3000, 3000), ('storage', 5000, 5000), ('auth', 9999, 9999), ('api', 8080, 19080), ('frontend', 8080, 19081), ('worker', 8080, 19082), ('source-browser', 8080, 19083)]:
        text = text.replace(f'http://{service}.synthetic.svc.cluster.local:{port}', f'http://127.0.0.1:{target}')
    return text.replace('resolver kube-dns.kube-system.svc.cluster.local', 'resolver 127.0.0.1').replace('worker_processes auto;', 'worker_processes 1;')


class Probe:
    def __init__(self, output):
        self.output = output
        self.temp = Path(tempfile.mkdtemp(prefix='tdp-batch-gateway-'))
        self.temp.chmod(0o755)
        self.name = 'tdp-batch-gateway-' + secrets.token_hex(5)
        self.helper = self.name + '-upstream'
        self.gateway = self.name + '-nginx'
        self.owned = []
        self.receipt = {'version': 1, 'synthetic_only': True, 'production_calls': 0, 'customer_calls': 0,
            'gateway_image': NGINX, 'helper_image': NODE, 'harness_sha256': sha(Path(__file__).read_bytes()),
            'gateway_before_source_sha256': sha(BEFORE.read_bytes()), 'gateway_config_source_sha256': sha(GATEWAY.read_bytes()),
            'storage_qualification_sha256': sha(STORAGE_RECEIPT.read_bytes()),
            'limitations': ['Synthetic recording upstream; no SQL, Auth/Storage business transaction or database-drain proof.',
                'Local binary routing qualification, not hosted rollout or throughput/SLO evidence.',
                'Same-namespace direct REST remains outside this HTTP fence; the release requires its SQL INSERT backstop.',
                'Executed changes are loopback upstream/DNS coordinates, synthetic namespace and one Nginx worker; routing/location/rewrite rules are unchanged.']}

    def docker(self, *args, data=None, check=True):
        if args[0] == 'run': args = ('run', '--pull', 'never', *args[1:])
        env = {k: v for k, v in os.environ.items() if k not in ('DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')}
        result = subprocess.run(DOCKER + list(args), input=data, text=True, capture_output=True, timeout=45, env=env)
        if check and result.returncode:
            raise RuntimeError('LOCAL_DOCKER_COMMAND_FAILED:' + args[0] + ':' + sha(result.stderr.encode())[:16])
        return result

    def node(self, source):
        return json.loads(self.docker('exec', '-i', self.helper, 'node', '-', data=source).stdout)

    def requests(self, cases):
        return self.node("""const http=require('node:http');const cases=""" + canonical(cases) + """;
const send=c=>new Promise((resolve,reject)=>{const r=http.request({host:'127.0.0.1',port:c.port,path:c.path,method:c.method,headers:{'content-length':0,'connection':'close'}},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({...c,status:res.statusCode,body,content_type:res.headers['content-type'],cache_control:res.headers['cache-control']}));});r.on('error',reject);r.setTimeout(4000,()=>r.destroy(new Error('TIMEOUT')));r.end();});
(async()=>{const result=[];for(const c of cases)result.push(await send(c));console.log(JSON.stringify(result));})().catch(()=>process.exit(1));""")

    def stats(self): return self.node("const http=require('node:http');http.get('http://127.0.0.1:19090',r=>{let x='';r.on('data',d=>x+=d);r.on('end',()=>console.log(x));});")

    def start(self):
        for key, image in [('gateway', NGINX), ('helper', NODE)]:
            info = json.loads(self.docker('image', 'inspect', image).stdout)[0]
            assert image.split('@')[1] in ' '.join(info['RepoDigests'])
            self.receipt[key + '_image_id'] = info['Id']
        source = """const http=require('node:http');const counts={};for(const port of [3000,5000,9999,19080,19081,19082,19083])http.createServer((req,res)=>{counts[port]=(counts[port]||0)+1;req.resume();req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({port,method:req.method,path:req.url}));});}).listen(port,'127.0.0.1');http.createServer((req,res)=>res.end(JSON.stringify(counts))).listen(19090,'127.0.0.1');"""
        script = self.temp / 'upstream.js'; script.write_text(source); script.chmod(0o644)
        self.docker('run', '-d', '--name', self.helper, '--network', 'none', '--user', '1000:1000', '--read-only', '--memory', '64m', '--cpus', '0.2', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-v', str(script) + ':/upstream.js:ro', '--entrypoint', 'node', NODE, '/upstream.js')
        self.owned.append(self.helper)
        for _ in range(60):
            try: self.stats(); return
            except (RuntimeError, ValueError): time.sleep(.1)
        raise RuntimeError('SYNTHETIC_UPSTREAM_NOT_READY')

    def start_gateway(self, source):
        config = self.temp / 'nginx.conf'; text = executed_config(source); config.write_text(text); config.chmod(0o644)
        self.docker('run', '-d', '--name', self.gateway, '--network', 'container:' + self.helper, '--user', '1000:1000', '--read-only', '--tmpfs', '/tmp:rw,size=16m', '--memory', '64m', '--cpus', '0.2', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-v', str(config) + ':/etc/nginx/nginx.conf:ro', '--entrypoint', 'nginx', NGINX, '-g', 'daemon off;')
        self.owned.append(self.gateway)
        for _ in range(60):
            try:
                if self.requests([{'port': 8080, 'method': 'GET', 'path': '/healthz'}])[0]['status'] == 200: return sha(text.encode())
            except (RuntimeError, ValueError): pass
            time.sleep(.1)
        raise RuntimeError('PINNED_GATEWAY_NOT_READY')

    def stop_gateway(self):
        self.docker('stop', '-t', '2', self.gateway)
        state = json.loads(self.docker('inspect', self.gateway).stdout)[0]['State']
        assert not state['Running'] and state['Pid'] == 0
        self.docker('rm', self.gateway); self.owned.remove(self.gateway)

    def qualify(self):
        self.start()
        self.receipt['before_executed_config_sha256'] = self.start_gateway(BEFORE.read_text())
        red = self.requests([{'port': p, 'method': 'POST', 'path': '/rest/v1/rpc/' + n} for p in (8080, 8081) for n in ('app_batch', 'apply_batch')])
        assert all(r['status'] == 200 and json.loads(r['body'])['port'] == 3000 for r in red)
        self.receipt['red_legacy_upstream_dispatches'] = [{k: r[k] for k in ('port', 'method', 'path', 'status')} for r in red]
        self.stop_gateway()
        self.receipt['executed_config_sha256'] = self.start_gateway(GATEWAY.read_text())
        prior = self.stats()
        blocked = self.requests([{'port': port, 'method': method, 'path': path} for port in (8080, 8081) for method in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS') for path in legacy_paths()])
        for row in blocked:
            assert row['status'] == 409, {k: row[k] for k in ('port', 'method', 'path', 'status')}
            assert row['content_type'] == 'application/json' and row['cache_control'] == 'no-store'
            if row['method'] != 'HEAD':
                body = json.loads(row['body']); assert body['error'] == UPGRADE and len(body['request_id']) == 32
                assert {k: body[k] for k in ('code', 'message', 'details', 'hint')} == {'code': 'P0001', 'message': 'TRANSPORT_UPGRADE_REQUIRED', 'details': None, 'hint': None}
        assert self.stats() == prior, 'DENIED_LEGACY_REACHED_UPSTREAM'
        self.receipt['legacy_denied_cases'] = [{k: r[k] for k in ('port', 'method', 'path', 'status')} for r in blocked]
        tus = self.requests([{'port': p, 'method': m, 'path': route} for p in (8080, 8081) for m in ('POST', 'PATCH') for route in tus_paths()])
        assert all(r['status'] in (400, 404) for r in tus) and self.stats() == prior
        self.receipt['tus_denied_cases'] = [{k: r[k] for k in ('port', 'method', 'path', 'status')} for r in tus]
        normal = []
        for port in (8080, 8081):
            for method, path, upstream_port, upstream_path in ordinary_paths():
                row = self.requests([{'port': port, 'method': method, 'path': path}])[0]
                assert row['status'] == 200 and json.loads(row['body']) == {'port': upstream_port, 'method': method, 'path': upstream_path}, row
                normal.append({'port': port, 'method': method, 'path': path, 'status': row['status'], 'upstream_port': upstream_port, 'upstream_path': upstream_path})
            health = self.requests([{'port': port, 'method': 'GET', 'path': '/healthz'}])[0]
            assert health['status'] == 200 and health['body'] == 'ok\n'
        self.receipt['ordinary_route_cases'] = normal
        self.stop_gateway(); self.start_gateway(GATEWAY.read_text())
        prior = self.stats()
        restarted = self.requests([{'port': port, 'method': 'POST', 'path': '/rest/v1/rpc/app_batch'} for port in (8080, 8081)])
        assert all(r['status'] == 409 for r in restarted) and self.stats() == prior
        self.receipt.update(actual_binary_exercised=True, legacy_rpc_denial_qualified=True, gateway_resumable_denial_qualified=True, ordinary_routing_preserved=True, restart_denial_qualified=True, postgrest_error_envelope_qualified=True)

    def cleanup(self):
        for name in reversed(self.owned):
            self.docker('rm', '-f', name)
            assert self.docker('inspect', name, check=False).returncode != 0
        self.owned.clear(); shutil.rmtree(self.temp)
        self.receipt['cleanup_confirmed'] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--output', type=Path, required=True); args = parser.parse_args()
    probe = Probe(args.output)
    try:
        probe.qualify(); probe.receipt['passed'] = True
    except Exception as error:
        probe.receipt['passed'] = False; probe.receipt['failure_class'] = type(error).__name__
        # Synthetic-only diagnostic remains local; the committed success receipt
        # has no raw HTTP bodies or credentials.
        probe.receipt['failure_detail'] = str(error)[:400]
    finally:
        probe.cleanup(); args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(probe.receipt, indent=2, sort_keys=True) + '\n')
    print(canonical({'passed': probe.receipt['passed'], 'cleanup_confirmed': probe.receipt['cleanup_confirmed'], 'receipt_sha256': sha(args.output.read_bytes())}))
    return 0 if probe.receipt['passed'] else 1


if __name__ == '__main__': raise SystemExit(main())
