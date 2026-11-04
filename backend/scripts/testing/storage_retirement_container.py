#!/usr/bin/env python3
"""Synthetic, offline pinned StorageAPI retirement qualification. Never targets a host.

Creates its own --network none PostgreSQL and a Storage container sharing only that
network namespace. No ports, service credentials, existing DBs or external calls.
Receipt separates exact binary behavior from application/coordinator authorization.
"""
from __future__ import annotations
import argparse, base64, hashlib, hmac, json, os, pathlib, secrets, shutil, subprocess, tempfile, time, uuid, urllib.parse

STORAGE = 'docker.io/supabase/storage-api:v1.81.0@sha256:92c5fe87ba5291915d0c21ca530ece9a58e13cc76a36a6c84fc69121a8dde799'
POSTGRES = 'postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
NGINX = 'docker.io/nginxinc/nginx-unprivileged:1.29.5-alpine@sha256:99e7cb7bee644b244b2b5e7bb737e972e54dbaa150cabc7ae0598731cdeb7ac8'
ROOT = pathlib.Path(__file__).resolve().parents[3]
PHYSICAL = ROOT / 'backend/scripts/ops/storage-retirement/physical.mjs'
GATEWAY = ROOT / 'backend/deploy/kubernetes/gateway.conf'
BUCKET = 'tenderdesk-private'
DOCKER = ['docker', '--host=unix:///var/run/docker.sock']


def canonical(value): return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
def digest(value): return hashlib.sha256(value).hexdigest()
def run(args, data=None, check=True, timeout=90):
    p = subprocess.run(args, input=data, text=True, capture_output=True, timeout=timeout)
    if check and p.returncode:
        error = RuntimeError('LOCAL_COMMAND_FAILED:' + args[0] + ':' + digest(p.stderr.encode())[:16]); error.private_stderr = p.stderr; raise error
    return p

def jwt(secret, role):
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=')
    msg = b64(b'{"alg":"HS256","typ":"JWT"}') + b'.' + b64(canonical({'role': role, 'iss': 'supabase', 'iat': int(time.time()) - 60, 'exp': int(time.time()) + 3600}).encode())
    return (msg + b'.' + b64(hmac.new(secret.encode(), msg, hashlib.sha256).digest())).decode()


class Probe:
    def __init__(self, out):
        self.out = out
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix='tdp-storage-proof-'))
        # Shared mount is synthetic; readable to the non-root Storage uid.
        self.tmp.chmod(0o755)
        self.files = self.tmp / 'objects'; self.files.mkdir(); self.files.chmod(0o777)
        self.control = self.tmp / 'control'; self.control.mkdir(); self.control.chmod(0o777)
        self.name = 'tdp-retirement-' + secrets.token_hex(5)
        self.pg = self.name + '-pg'; self.storage = self.name + '-storage'
        self.gateway = self.name + '-gateway'
        self.started = []
        self.receipt = {'version': 1, 'synthetic_only': True, 'production_calls': 0, 'customer_calls': 0, 'storage_image': STORAGE, 'postgres_image': POSTGRES, 'cases': [], 'limitations': ['Local pinned binary and filesystem evidence; not hosted PVC power-loss qualification.', 'Minimal fixture installs the exact retirement table/guard only; canonical actor/intent/quota CAS and Kubernetes quiescence are separate tests.', 'No app-quota release is performed by this harness.']}
    def docker(self, *args, **kwargs):
        if args[0] == 'run': args = ('run', '--pull', 'never', *args[1:])
        return run(DOCKER + list(args), **kwargs)
    def sql(self, sql): return self.docker('exec', '-i', self.pg, 'psql', '-U', 'postgres', '-d', 'postgres', '-XAtq', '-v', 'ON_ERROR_STOP=1', data=sql).stdout.strip()
    def node(self, js): return self.docker('exec', '-i', self.storage, 'node', '-', data=js).stdout.strip()
    def record(self, name, **details):
        self.receipt['cases'].append({'name': name, 'passed': True, **details})
        print(name + ': passed', flush=True)
    def physical(self, key, mode='inspect', expected=None):
        scope = {'version': 1, 'operationNonce': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'globalBucket': 'retirement', 'tenantId': 'retirement', 'bucketId': BUCKET, 'storageKey': key, 'versionSeparator': '/'}
        js = "import {inspectScope,reconcileScope} from " + json.dumps(PHYSICAL.as_uri()) + "; const args=JSON.parse(process.argv[1]);const r=args.mode==='inspect'?await inspectScope(args.root,args.scope):await reconcileScope(args.root,args.scope,args.expected);console.log(JSON.stringify(r));"
        return json.loads(run(['node', '--input-type=module', '-e', js, canonical({'root': str(self.files), 'scope': scope, 'mode': mode, 'expected': expected})]).stdout)
    def physical_cli_remove(self, key, expected):
        scope = {'version': 1, 'operationNonce': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'globalBucket': 'retirement', 'tenantId': 'retirement', 'bucketId': BUCKET, 'storageKey': key, 'versionSeparator': '/'}
        for name, value in [('scope.json', scope), ('expected-manifest.json', expected)]:
            file = self.control / name; file.write_text(canonical(value)); file.chmod(0o644)
        helper = self.control / 'physical.mjs'; helper.write_bytes(PHYSICAL.read_bytes()); helper.chmod(0o644)
        result = self.docker('run', '--rm', '--network', 'none', '--user', '1000:1000', '--read-only', '--memory', '128m', '--cpus', '0.5', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-v', str(self.files) + ':/var/lib/storage', '-v', str(self.control) + ':/run/storage-retirement:ro', '--entrypoint', 'node', STORAGE, '/run/storage-retirement/physical.mjs', 'remove')
        return json.loads(result.stdout)
    def request(self, method, route, body='', headers=None, port=5000):
        # Tokens remain exclusively inside the container env, never command text/output.
        js = "const http=require('http');const p=" + canonical({'method': method, 'route': route, 'body': body, 'headers': headers or {}, 'port': port}) + ";const b=Buffer.from(p.body); const r=http.request({host:'127.0.0.1',port:p.port,path:p.route,method:p.method,headers:{authorization:'Bearer '+process.env.SERVICE_KEY,'content-type':'application/octet-stream','content-length':b.length,...p.headers}},res=>{let x='';res.on('data',d=>x+=d);res.on('end',()=>console.log(JSON.stringify({status:res.statusCode,body:x,headers:res.headers})));});r.on('error',()=>{process.exitCode=1});r.end(b);"
        return json.loads(self.node(js))
    def fence(self, key):
        self.sql("INSERT INTO app_private.storage_retirement_keys(bucket_id,storage_key,workspace_id,intent_id,operation_nonce,retirement_nonce) VALUES ('tenderdesk-private','" + key + "','11111111-1111-4111-8111-111111111111',gen_random_uuid(),gen_random_uuid(),gen_random_uuid()) ON CONFLICT DO NOTHING;")
    def count(self, key): return int(self.sql("SELECT count(*) FROM storage.objects WHERE bucket_id='tenderdesk-private' AND name='" + key + "';"))
    def slow(self, key, route=None):
        gate = secrets.token_hex(5)
        js = """const fs=require('fs'),http=require('http'); const p=JSON.parse(process.argv[2]);
const req=http.request({host:'127.0.0.1',port:5000,path:p.route,method:'POST',headers:{authorization:'Bearer '+process.env.SERVICE_KEY,'content-type':'application/octet-stream','content-length':65536}},res=>{let b='';res.on('data',x=>b+=x);res.on('end',()=>{fs.writeFileSync('/control/'+p.gate+'.result',JSON.stringify({status:res.statusCode,body:b}));clearInterval(timer);});});
req.on('error',e=>{fs.writeFileSync('/control/'+p.gate+'.error',e.code||'ERROR');clearInterval(timer);});
req.write(Buffer.alloc(4096,65));fs.writeFileSync('/control/'+p.gate+'.started','yes');
const timer=setInterval(()=>{if(fs.existsSync('/control/'+p.gate+'.finish')){clearInterval(timer);req.end(Buffer.alloc(61440,66));}},25);
setTimeout(()=>{req.destroy();process.exitCode=1},45000).unref();
"""
        # Store only the synthetic script; no token in argv or output.
        script = self.control / (gate + '.js'); script.write_text(js); script.chmod(0o644)
        child = subprocess.Popen(DOCKER + ['exec', self.storage, 'node', '/control/' + gate + '.js', canonical({'route': route or '/object/' + BUCKET + '/' + key, 'gate': gate})], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.wait(lambda: (self.control / (gate + '.started')).exists() or child.poll() is not None)
        if not (self.control / (gate + '.started')).exists():
            _, stderr = child.communicate()
            (self.out / 'private-stream-child.log').write_text(stderr)
            raise AssertionError('STREAM_CHILD_EXITED_BEFORE_START')
        return gate, child
    def wait(self, predicate, seconds=15):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            result = predicate()
            if result: return result
            time.sleep(.05)
        raise AssertionError('CONDITION_TIMEOUT')
    def result(self, gate, child):
        try: self.wait(lambda: (self.control / (gate + '.result')).exists(), 30)
        except Exception:
            (self.out / 'private-stream-state.json').write_text(canonical({'files': [p.name for p in self.control.iterdir()], 'child_exit': child.poll()}))
            (self.out / 'private-stream-storage.log').write_text(self.docker('logs', self.storage, check=False).stdout + self.docker('logs', self.storage, check=False).stderr)
            raise
        child.communicate(timeout=20)
        return json.loads((self.control / (gate + '.result')).read_text())
    def attest(self):
        info = json.loads(self.docker('image', 'inspect', STORAGE).stdout)[0]
        assert STORAGE.split('@')[1] in ' '.join(info['RepoDigests'])
        self.receipt['storage_image_id'] = info['Id']
        js = "const fs=require('fs'),crypto=require('crypto');const files=['dist/storage/locator.js','dist/storage/backend/adapter.js','dist/storage/backend/file.js','dist/storage/uploader.js','dist/storage/events/objects/object-admin-delete.js',...fs.readdirSync('dist',{recursive:true}).filter(p=>p.includes('tus')&&p.endsWith('.js')).map(p=>'dist/'+p)];console.log(JSON.stringify(files.map(path=>{const b=fs.readFileSync(path);return {path,sha256:crypto.createHash('sha256').update(b).digest('hex'),source:b.toString()}})));"
        p = self.docker('run', '--rm', '--network', 'none', '--read-only', '--memory', '128m', '--cpus', '0.5', '--entrypoint', 'node', STORAGE, '-e', js)
        files = json.loads(p.stdout)
        for entry in files:
            target = self.out / ('binary-' + entry['path'].replace('/', '-'))
            target.write_text(entry.pop('source'))
        self.receipt['binary_files'] = files
        self.receipt['physical_module_sha256'] = digest(PHYSICAL.read_bytes())
        self.receipt['harness_sha256'] = digest(pathlib.Path(__file__).read_bytes())
    def setup(self):
        self.attest()
        self.docker('run', '-d', '--name', self.pg, '--network', 'none', '--memory', '256m', '--cpus', '0.5', '--tmpfs', '/var/lib/postgresql/data:rw,size=192m', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES)
        self.started.append(self.pg)
        self.wait(lambda: self.docker('exec', self.pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', check=False).returncode == 0)
        # Distinct service role matches production custom-role mode. Passwordless
        # DB connections exist only in this isolated network namespace.
        self.sql("""CREATE ROLE probe_storageadmin LOGIN NOINHERIT; CREATE ROLE probe_authenticator LOGIN NOINHERIT;
CREATE ROLE probe_anon NOLOGIN NOINHERIT; CREATE ROLE probe_authenticated NOLOGIN NOINHERIT; CREATE ROLE probe_service NOLOGIN INHERIT;
GRANT probe_storageadmin TO probe_service; GRANT probe_anon,probe_authenticated,probe_service TO probe_authenticator;
GRANT CREATE ON DATABASE postgres TO probe_storageadmin;
CREATE SCHEMA storage AUTHORIZATION probe_storageadmin; CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions; CREATE EXTENSION \"uuid-ossp\" WITH SCHEMA extensions; CREATE EXTENSION pg_trgm WITH SCHEMA extensions;
CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
GRANT USAGE ON SCHEMA public,extensions,auth TO probe_storageadmin,probe_service,probe_anon,probe_authenticated;
GRANT REFERENCES ON auth.users TO probe_storageadmin;
GRANT CREATE ON SCHEMA public TO probe_storageadmin;
ALTER ROLE probe_storageadmin SET search_path=storage,public,extensions;
""")
        secret = secrets.token_urlsafe(48)
        env = {'DATABASE_URL': 'postgres://probe_storageadmin@127.0.0.1:5432/postgres', 'DATABASE_POOL_URL': 'postgres://probe_authenticator@127.0.0.1:5432/postgres', 'AUTH_JWT_SECRET': secret, 'ANON_KEY': jwt(secret, 'probe_anon'), 'SERVICE_KEY': jwt(secret, 'probe_service'), 'DB_ANON_ROLE': 'probe_anon', 'DB_AUTHENTICATED_ROLE': 'probe_authenticated', 'DB_SERVICE_ROLE': 'probe_service', 'DB_SUPER_USER': 'probe_storageadmin', 'DB_INSTALL_ROLES': 'false', 'DB_ALLOW_MIGRATION_REFRESH': 'false', 'DATABASE_SEARCH_PATH': 'storage,public,extensions', 'DATABASE_MAX_CONNECTIONS': '3', 'SERVER_HOST': '0.0.0.0', 'SERVER_PORT': '5000', 'STORAGE_PUBLIC_URL': 'http://127.0.0.1:5000', 'STORAGE_BACKEND': 'file', 'FILE_STORAGE_BACKEND_PATH': '/var/lib/storage', 'GLOBAL_S3_BUCKET': 'retirement', 'TENANT_ID': 'retirement', 'REGION': 'local', 'FILE_SIZE_LIMIT': '10485760', 'IMAGE_TRANSFORMATION_ENABLED': 'false', 'S3_PROTOCOL_ENABLED': 'false', 'PG_QUEUE_ENABLE': 'false', 'LOG_LEVEL': 'error', 'LOGFLARE_ENABLED': 'false', 'TRACING_ENABLED': 'false', 'OTEL_METRICS_ENABLED': 'false', 'NODE_OPTIONS': '--max-old-space-size=256'}
        self.env = self.tmp / 'storage.env'; self.env.write_text(''.join(k + '=' + v + '\n' for k, v in env.items())); self.env.chmod(0o600)
        self.start_storage()
        self.sql("SET ROLE probe_storageadmin; INSERT INTO storage.buckets(id,name,public) VALUES ('tenderdesk-private','tenderdesk-private',false);")
        tables = json.loads(self.sql("SELECT json_agg(json_build_object('name',tablename,'owner',tableowner) ORDER BY tablename) FROM pg_tables WHERE schemaname='storage';"))
        self.receipt['storage_tables'] = tables
        self.receipt['object_columns'] = json.loads(self.sql("SELECT json_agg(json_build_object('name',column_name,'type',data_type) ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='storage' AND table_name='objects';"))
        self.receipt['multipart_columns'] = json.loads(self.sql("SELECT json_agg(json_build_object('table',table_name,'name',column_name,'type',data_type) ORDER BY table_name,ordinal_position) FROM information_schema.columns WHERE table_schema='storage' AND table_name IN ('s3_multipart_uploads','s3_multipart_uploads_parts');"))
        self.receipt['object_triggers_before_fence'] = json.loads(self.sql("SELECT json_agg(pg_get_triggerdef(oid) ORDER BY tgname) FROM pg_trigger WHERE tgrelid='storage.objects'::regclass;"))
        self.receipt['object_delete_protection_source'] = self.sql("SELECT pg_get_functiondef('storage.protect_delete()'::regprocedure);")
        migration = pathlib.Path(self.migration).read_text()
        # Execute exact immutable supplied guard/table source, excluding unrelated
        # application helper definitions. Hash binds the complete source as well.
        ddl = migration[:migration.index('create function app_private.check_storage_retirement_reference')]
        self.sql('CREATE ROLE probe_appowner NOLOGIN NOINHERIT NOBYPASSRLS; CREATE SCHEMA app_private AUTHORIZATION probe_appowner;\n' + ddl + """
ALTER TABLE app_private.storage_retirement_batches OWNER TO probe_appowner;
ALTER TABLE app_private.storage_retirement_keys OWNER TO probe_appowner;
ALTER FUNCTION public.guard_retired_storage_write() OWNER TO probe_appowner;
GRANT EXECUTE ON FUNCTION public.guard_retired_storage_write() TO probe_storageadmin;
SET ROLE probe_storageadmin;
CREATE TRIGGER tenderdesk_retired_storage_write BEFORE INSERT OR UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION public.guard_retired_storage_write();
RESET ROLE;
REVOKE EXECUTE ON FUNCTION public.guard_retired_storage_write() FROM probe_storageadmin;
""")
        self.receipt['retirement_migration_sha256'] = digest(migration.encode())
        self.receipt['executed_guard_ddl_sha256'] = digest(ddl.encode())
        guard_start = ddl.index('create function public.guard_retired_storage_write()')
        guard = ddl[guard_start:ddl.index('end$$;', guard_start) + len('end$$;')]
        self.receipt['guard_function_source_sha256'] = digest(guard.encode())
        self.receipt['guard_body_sha256'] = self.sql("SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='public.guard_retired_storage_write()'::regprocedure;")
        assert self.receipt['guard_body_sha256'] == digest(guard.split('$$', 2)[1].encode())
        self.receipt['guard_security'] = json.loads(self.sql("SELECT json_build_object('owner',pg_get_userbyid(p.proowner),'security_definer',p.prosecdef,'owner_superuser',r.rolsuper,'owner_bypass_rls',r.rolbypassrls,'configuration',p.proconfig,'storage_owner_execute_after_install',has_function_privilege('probe_storageadmin',p.oid,'execute')) FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid='public.guard_retired_storage_write()'::regprocedure;"))
        assert self.receipt['guard_security'] == {'owner': 'probe_appowner', 'security_definer': True, 'owner_superuser': False, 'owner_bypass_rls': False, 'configuration': ['search_path=""'], 'storage_owner_execute_after_install': False}
    def start_storage(self):
        self.docker('run', '-d', '--name', self.storage, '--network', 'container:' + self.pg, '--user', '1000:1000', '--read-only', '--tmpfs', '/tmp:rw,size=32m', '--memory', '384m', '--cpus', '0.5', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--env-file', str(self.env), '-v', str(self.files) + ':/var/lib/storage', '-v', str(self.control) + ':/control', STORAGE)
        self.started.append(self.storage)
        def ready():
            return self.docker('exec', self.storage, 'node', '-e', "fetch('http://127.0.0.1:5000/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))", check=False).returncode == 0
        try: self.wait(ready, 60)
        except Exception:
            # Private local diagnostic only, never a receipt or stdout dump.
            (self.out / 'private-startup.log').write_text(self.docker('logs', self.storage, check=False).stdout + self.docker('logs', self.storage, check=False).stderr)
            raise
    def start_gateway(self, source):
        # Only transport coordinates differ from reviewed production text. All
        # URI normalization/location/rewrite logic is executed unmodified.
        text = source.replace('__NAMESPACE__', 'tenderdesk').replace('storage.tenderdesk.svc.cluster.local', '127.0.0.1').replace('resolver kube-dns.kube-system.svc.cluster.local', 'resolver 127.0.0.1').replace('worker_processes auto;', 'worker_processes 1;')
        config = self.control / 'nginx.conf'; config.write_text(text); config.chmod(0o644)
        self.docker('run', '-d', '--name', self.gateway, '--network', 'container:' + self.pg, '--user', '1000:1000', '--read-only', '--tmpfs', '/tmp:rw,size=16m', '--memory', '64m', '--cpus', '0.2', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-v', str(config) + ':/etc/nginx/nginx.conf:ro', '--entrypoint', 'nginx', NGINX, '-g', 'daemon off;')
        self.started.append(self.gateway)
        try: self.wait(lambda: self.docker('exec', self.storage, 'node', '-e', "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))", check=False).returncode == 0, 30)
        except Exception:
            (self.out / 'private-nginx-startup.log').write_text(self.docker('logs', self.gateway, check=False).stderr)
            raise
        return digest(text.encode())
    def stop_container(self, name):
        self.docker('stop', '-t', '2', name)
        state = json.loads(self.docker('inspect', name).stdout)[0]['State']
        assert state['Running'] is False and state['Pid'] == 0
        self.docker('rm', name); self.started.remove(name)
    def qualify_gateway(self):
        image = json.loads(self.docker('image', 'inspect', NGINX).stdout)[0]
        assert NGINX.split('@')[1] in ' '.join(image['RepoDigests'])
        self.receipt['gateway_image'] = NGINX; self.receipt['gateway_image_id'] = image['Id']
        before = pathlib.Path(self.gateway_before).read_text(); fixed = GATEWAY.read_text()
        self.receipt['gateway_before_source_sha256'] = digest(before.encode())
        self.receipt['gateway_config_source_sha256'] = digest(fixed.encode())
        self.receipt['gateway_fixture_changes'] = ['namespace tenderdesk', 'Storage upstream and DNS loopback in isolated namespace', 'one Nginx worker rather than host CPU count; no throughput/SLO claim']
        self.receipt['gateway_before_executed_sha256'] = self.start_gateway(before)
        key = 'fixture/signed-resumable.docx'
        signing = self.request('POST', '/storage/v1/object/upload/sign/' + BUCKET + '/' + key, '{}', {'content-type': 'application/json'}, port=8080)
        assert signing['status'] == 200, signing
        token = urllib.parse.parse_qs(urllib.parse.urlsplit(json.loads(signing['body'])['url']).query)['token'][0]
        self.fence(key)
        metadata = ','.join(k + ' ' + base64.b64encode(v.encode()).decode() for k, v in [('bucketName', BUCKET), ('objectName', key), ('contentType', 'application/octet-stream')])
        headers = {'tus-resumable': '1.0.0', 'upload-length': '65536', 'upload-metadata': metadata, 'x-signature': token}
        created = self.request('POST', '/storage/v1/upload/resumable/sign', '', headers, port=8080)
        assert created['status'] == 201, created
        location = urllib.parse.urlsplit(created['headers']['location']).path
        patch_headers = {'tus-resumable': '1.0.0', 'upload-offset': '0', 'content-type': 'application/offset+octet-stream', 'x-signature': token}
        patched = self.request('PATCH', '/storage/v1' + location, 'S' * 4096, patch_headers, port=8080)
        assert patched['status'] == 204, patched
        red = self.physical(key)
        assert any(file['sha256'] == digest(b'S' * 4096) for file in red['files']) and self.count(key) == 0
        self.receipt['signed_tus_bypass_confirmed'] = True
        self.record('red_old_gateway_signed_tus_recreates_retired_physical_bytes', create_status=created['status'], patch_status=patched['status'], metadata_rows=0, physical=red)
        self.stop_container(self.gateway)
        self.receipt['gateway_executed_config_sha256'] = self.start_gateway(fixed)
        paths = ['/storage/v1/upload/resumable', '/storage/v1/upload/resumable/sign', '/storage/v1/upload/resumable/sign/',
            '/storage//v1//upload//resumable//sign', '/storage/v1/object/../upload/resumable/sign',
            '/storage/v1/object/%2e%2e/upload/resumable/sign', '/storage/v1/%75pload/resumable/sign',
            '/storage/v1/upload/%72esumable/sign', '/storage%2fv1%2fupload%2fresumable%2fsign',
            '/storage/%76%31/upload/resumable/sign', '/STORAGE/V1/UPLOAD/RESUMABLE/SIGN',
            '/storage/v1/%2575pload/resumable/sign', '/storage/v1/upload%252fresumable%252fsign',
            '/storage/v1/upload\\resumable\\sign', '/storage/v1/upload;ignored/resumable/sign',
            '/storage/v1/upload/resumable/sign/extra', '/storage/v1/upload/resumableevil',
            '/storage/v1/upload/resumable/sign?query=/object/allowed', '/storage/v1/up%256coad/resumable/sign']
        results = []
        for port in [8080, 8081]:
            for route in paths:
                blocked = self.request('POST', route, '', headers, port=port)
                assert blocked['status'] in [400, 404], {'port': port, 'route': route, 'status': blocked['status']}
                results.append({'port': port, 'path': route, 'status': blocked['status']})
            blocked = self.request('PATCH', '/storage/v1' + location, 'S' * 4096, patch_headers, port=port)
            assert blocked['status'] == 404
        assert self.physical(key)['files'] == red['files']
        self.receipt['gateway_normalized_route_cases'] = results
        ordinary = self.request('POST', '/storage/v1/object/' + BUCKET + '/fixture/gateway-control.docx', 'ordinary gateway bytes', port=8080)
        download = self.request('GET', '/storage/v1/object/' + BUCKET + '/fixture/gateway-control.docx', port=8081)
        assert ordinary['status'] == 200 and download['status'] == 200 and download['body'] == 'ordinary gateway bytes'
        self.receipt['ordinary_endpoint_success'] = {'public_upload': ordinary['status'], 'internal_download': download['status'], 'download_sha256': digest(download['body'].encode())}
        self.receipt['gateway_resumable_denial_qualified'] = True
        self.record('green_both_gateway_ports_block_resumable_normalizations_preserve_object_io', normalized_cases=len(results), old_patch_status=404)
        self.receipt['limitations'].append('Pinned Storage binary remains directly vulnerable to signed TUS; the exact gateway denial on both ports and cluster-only Storage/network boundary are mandatory, not optional defense in depth.')
        return key, location, headers, patch_headers
    def tests(self):
        known = 'fixture/known.docx'; payload = 'synthetic known bytes'
        response = self.request('POST', '/object/' + BUCKET + '/' + known, payload)
        assert response['status'] == 200, response
        manifest = self.physical(known); assert len(manifest['files']) == 1 and manifest['files'][0]['sha256'] == digest(payload.encode())
        version = self.sql("SELECT version FROM storage.objects WHERE name='" + known + "';")
        assert manifest['files'][0]['relativePath'] == 'retirement/retirement/' + BUCKET + '/' + known + '/' + version
        self.record('actual_binary_successful_upload_matches_exact_locator', manifest=manifest)
        tus_key = 'fixture/resumable.docx'
        tus_metadata = ','.join(k + ' ' + base64.b64encode(v.encode()).decode() for k, v in [('bucketName', BUCKET), ('objectName', tus_key), ('contentType', 'application/octet-stream')])
        tus_headers = {'tus-resumable': '1.0.0', 'upload-length': '65536', 'upload-metadata': tus_metadata}
        tus_created = self.request('POST', '/upload/resumable', '', tus_headers)
        assert tus_created['status'] == 201, tus_created
        tus_location = urllib.parse.urlsplit(tus_created['headers']['location'])
        tus_path = tus_location.path + ('?' + tus_location.query if tus_location.query else '')
        tus_original = self.physical(tus_key)
        assert not tus_original['absent'], 'a real resumable resource must exist for the replay test'
        self.fence(tus_key)
        tus_new = self.request('POST', '/upload/resumable', '', tus_headers)
        assert tus_new['status'] >= 400, tus_new
        assert self.physical(tus_key)['files'] == tus_original['files'], 'fenced new TUS creation must not add sidecars or bytes'
        tus_patch_headers = {'tus-resumable': '1.0.0', 'upload-offset': '0', 'content-type': 'application/offset+octet-stream'}
        tus_old_patch = self.request('PATCH', tus_path, 'R' * 4096, tus_patch_headers)
        self.record('actual_resumable_creation_and_existing_session_after_fence', create_status=tus_created['status'], fenced_new_status=tus_new['status'], existing_session_patch_status=tus_old_patch['status'], before_quiescence_manifest=self.physical(tus_key))
        signed_key = 'fixture/signed.docx'
        signed = self.request('POST', '/object/upload/sign/' + BUCKET + '/' + signed_key, '{}', {'content-type': 'application/json'})
        assert signed['status'] == 200, signed
        signed_path = json.loads(signed['body'])['url']
        signed_alias = self.request('POST', '/object/upload/sign/' + BUCKET + '/' + signed_key + '.info', '{}', {'content-type': 'application/json'})
        assert signed_alias['status'] == 200, signed_alias
        signed_alias_path = json.loads(signed_alias['body'])['url']
        self.fence(signed_key)
        signed_response = self.request('PUT', signed_path, 'signed stale bytes')
        assert signed_response['status'] >= 400 and 'P0001' in signed_response['body'], signed_response
        assert self.physical(signed_key)['absent'] and self.count(signed_key) == 0
        self.record('pre_existing_signed_upload_rejected_by_permanent_fence', status=signed_response['status'])
        alias_replay = self.request('PUT', signed_alias_path, 'old signed alias bytes')
        assert alias_replay['status'] >= 400 and 'P0001' in alias_replay['body'], alias_replay
        for alias in [signed_key + '.info', signed_key + '/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.info', signed_key + '-$v-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'fixture']:
            denied = self.request('POST', '/object/' + BUCKET + '/' + alias, 'future alias bytes')
            assert denied['status'] >= 400 and 'P0001' in denied['body'], denied
        assert self.physical(signed_key)['absent']
        self.record('future_physical_namespace_aliases_rejected_by_permanent_fence', service_alias_cases=4, old_signed_alias_status=alias_replay['status'])
        self.fence(known)
        update = self.request('PUT', '/object/' + BUCKET + '/' + known, 'must never replace existing bytes')
        assert update['status'] >= 400 and 'P0001' in update['body'], update
        assert self.physical(known)['files'] == manifest['files'] and self.count(known) == 1
        self.record('service_put_of_existing_retired_object_preserves_exact_original_bytes', status=update['status'])
        signed_tus_key, signed_tus_location, signed_tus_headers, signed_tus_patch_headers = self.qualify_gateway()
        # Header+4KiB sent; body remains unfinished. A response now proves this
        # rejection precedes physical body completion/final metadata commit.
        key = 'fixture/preflight.docx'; self.fence(key)
        gate, child = self.slow(key); result = self.result(gate, child)
        assert result['status'] >= 400 and 'P0001' in result['body'], result
        assert not (self.control / (gate + '.finish')).exists()
        assert self.physical(key)['absent'] and self.count(key) == 0
        self.record('service_upload_fence_rejects_before_unfinished_body_is_consumed', status=result['status'])
        # Control proves the same stream really creates physical bytes while
        # unfinished, then forces final-metadata rejection and EACCES cleanup.
        delayed = 'fixture/delayed.docx'; gate, child = self.slow(delayed)
        partial = self.wait(lambda: next((p for p in (self.files / 'retirement/retirement' / BUCKET / delayed).glob('*') if p.is_file() and p.stat().st_size >= 4096), None))
        assert self.count(delayed) == 0
        partial.parent.chmod(0o555)
        self.fence(delayed); (self.control / (gate + '.finish')).touch()
        result = self.result(gate, child)
        assert result['status'] >= 400, result
        assert partial.exists() and partial.stat().st_size == 65536 and self.count(delayed) == 0
        self.record('inflight_body_outlives_fence_failed_metadata_cleanup_leaves_orphan', status=result['status'], orphan_bytes=partial.stat().st_size, metadata_rows=0)
        self.stop_container(self.gateway)
        self.stop_container(self.storage)
        partial.parent.chmod(0o755)
        before = self.physical(delayed); assert len(before['files']) == 1
        after = self.physical_cli_remove(delayed, before)
        assert after['remainingCount'] == 0 and after['removedBytes'] == 65536
        self.record('terminated_writer_exact_physical_reconciliation_durably_removes_orphan', before=before, after=after)
        tus_before = self.physical(tus_key); tus_removed = self.physical(tus_key, 'remove', tus_before)
        assert tus_removed['remainingCount'] == 0
        signed_tus_removed = self.physical(signed_tus_key, 'remove', self.physical(signed_tus_key))
        assert signed_tus_removed['remainingCount'] == 0
        self.fence(known)
        known_before = self.physical(known); self.physical(known, 'remove', known_before)
        self.sql("BEGIN; SET LOCAL ROLE probe_storageadmin; SELECT set_config('storage.allow_delete_query','true',true); DELETE FROM storage.objects WHERE bucket_id='tenderdesk-private' AND name='" + known + "'; COMMIT;")
        assert self.count(known) == 0 and self.physical(known)['absent']
        self.record('observed_storage_owner_exact_metadata_delete_after_quiescent_physical_removal', object_rows_remaining=0)
        self.start_storage()
        self.start_gateway(GATEWAY.read_text())
        for port in [8080, 8081]:
            assert self.request('PATCH', '/storage/v1' + signed_tus_location, 'S' * 4096, signed_tus_patch_headers, port=port)['status'] == 404
            assert self.request('POST', '/storage/v1/upload/resumable/sign', '', signed_tus_headers, port=port)['status'] == 404
        assert self.physical(signed_tus_key)['absent'] and self.count(signed_tus_key) == 0
        self.record('fresh_storage_and_gateway_cannot_recreate_retired_signed_tus_bytes', public_and_internal_denied=True, removed=signed_tus_removed)
        tus_replay = self.request('PATCH', tus_path, 'R' * 4096, tus_patch_headers)
        tus_recreate = self.request('POST', '/upload/resumable', '', tus_headers)
        assert tus_replay['status'] >= 400 and tus_recreate['status'] >= 400
        assert self.physical(tus_key)['absent'] and self.count(tus_key) == 0
        self.record('fresh_process_cannot_resume_or_recreate_retired_tus_resource', old_session_status=tus_replay['status'], new_session_status=tus_recreate['status'], removed=tus_removed)
        rejected = self.request('POST', '/object/' + BUCKET + '/' + delayed, 'late retry')
        oldsigned = self.request('PUT', signed_path, 'late old signed retry')
        assert rejected['status'] >= 400 and oldsigned['status'] >= 400
        assert self.physical(delayed)['absent'] and self.physical(signed_key)['absent']
        restored = self.request('POST', '/object/' + BUCKET + '/fixture/new-restore-key.docx', 'restored under new key')
        assert restored['status'] == 200, restored
        self.record('fresh_storage_process_old_keys_stay_retired_new_restore_key_writable', rejected_status=rejected['status'], signed_status=oldsigned['status'], new_key_status=restored['status'])
    def cleanup(self):
        for name in reversed(self.started): self.docker('rm', '-f', name, check=False)
        for current, dirs, files in os.walk(self.tmp):
            try: os.chmod(current, 0o755)
            except OSError: pass
        shutil.rmtree(self.tmp, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--migration', required=True, type=pathlib.Path)
    parser.add_argument('--gateway-before', required=True, type=pathlib.Path)
    args = parser.parse_args(); args.output.mkdir(parents=True, exist_ok=True)
    probe = Probe(args.output); probe.migration = args.migration
    probe.gateway_before = args.gateway_before
    try:
        probe.setup(); probe.tests(); probe.receipt['passed'] = True
        probe.receipt['actual_binary_exercised'] = True
        assert probe.receipt['physical_module_sha256'] == digest(PHYSICAL.read_bytes())
    except Exception as error:
        probe.receipt['passed'] = False; probe.receipt['failure_type'] = type(error).__name__
        (args.output / 'private-failure.txt').write_text(str(error) + '\n' + getattr(error, 'private_stderr', ''))
        raise
    finally:
        probe.cleanup()
        (args.output / 'receipt.json').write_text(json.dumps(probe.receipt, indent=2, ensure_ascii=False) + '\n')
if __name__ == '__main__': main()
