#!/usr/bin/env python3
"""Runner-only restore drill in an exact nonce-owned disposable database.

Production supplies catalog metadata only. Synthetic sources, genuine isolated
Auth/Storage, backup bytes and the application restore RPCs exercise recovery.
No production rows, settings, runtime or model invocation are changed.
"""
from contextlib import redirect_stdout, redirect_stderr
import ast
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import sys

HERE=Path(__file__).resolve().parent
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,HERE/path)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module
inventory=load('cloud_restore_inventory','digitalocean-inventory.py')
bootstrap=load('cloud_restore_bootstrap','digitalocean-bootstrap.py')
release=load('cloud_restore_release','proposal-delivery-release.py')
images=load('cloud_restore_images','proposal-delivery-images.py')
builder=load('cloud_restore_builder','production-schema/build_schema.py')
ASSETS=HERE/'cloud-restore'
MAX_SCHEMA_BYTES=8*1024*1024
CHUNK_BYTES=200000
class RestoreError(Exception):pass

def emit(status,**safe):
    print(json.dumps({'cloud_restore':status,**safe},sort_keys=True),flush=True)

def acceptance_source(base):
    marker='if __name__ == "__main__":'
    if base.count(marker)!=1:raise RestoreError('RESTORE_ACCEPTANCE_BASE_CHANGED')
    extension=(ASSETS/'acceptance.py').read_text()
    tree=ast.parse(extension)
    checks=next((ast.literal_eval(node.value) for node in tree.body if isinstance(node,ast.Assign)
      and any(isinstance(t,ast.Name) and t.id=='RESTORE_CHECKS' for t in node.targets)),None)
    if not isinstance(checks,set) or len(checks)!=13 or any(not re.fullmatch('[a-z_]{1,100}',x) for x in checks):raise RestoreError('RESTORE_ACCEPTANCE_CHECKS_INVALID')
    result=base.split(marker)[0]+extension
    compile(result,'isolated_restore_acceptance.py','exec')
    return result,checks

def validate_catalog(value):
    if (not isinstance(value,dict) or set(value)!={'catalog_sha256','source_rows_copied','source_stage','catalog','auth_read_authority'}
      or value['source_rows_copied']!=0 or value['source_stage'] not in ('baseline','released')
      or not re.fullmatch('[a-f0-9]{64}',value.get('catalog_sha256',''))):raise RestoreError('RESTORE_SOURCE_CATALOG_INVALID')
    catalog=value['catalog']
    if not isinstance(catalog,dict):raise RestoreError('RESTORE_SOURCE_CATALOG_INVALID')
    public={r['relname'] for r in catalog['relations'] if r['schema']=='public' and r['relkind']=='r'}
    if not {'workspaces','opportunities','proposals'}<=public:raise RestoreError('RESTORE_SOURCE_CAPABILITIES_REQUIRED')
    validate_auth_authority(value['auth_read_authority'])
    return value

def validate_auth_authority(value):
    fields={'application_owner','application_owner_superuser','application_owner_bypassrls','bootstrap_function_owner','tables'}
    if not isinstance(value,dict) or set(value)!=fields or value['application_owner']!='tdp_app_owner':raise RestoreError('RESTORE_AUTH_METADATA_INVALID')
    if any(type(value[key]) is not bool for key in ('application_owner_superuser','application_owner_bypassrls')):raise RestoreError('RESTORE_AUTH_METADATA_INVALID')
    if value['bootstrap_function_owner'] is not None and not re.fullmatch('[a-z_][a-z0-9_]{0,62}',value['bootstrap_function_owner']):raise RestoreError('RESTORE_AUTH_METADATA_INVALID')
    tables=value['tables']
    if not isinstance(tables,list) or len(tables)!=2 or {row.get('table') for row in tables if isinstance(row,dict)}!={'users','identities'}:raise RestoreError('RESTORE_AUTH_METADATA_INVALID')
    for row in tables:
        if set(row)!={'table','owner','rls_enabled','force_rls','app_owner_select','app_owner_effective_owner','applicable_policies'}:raise RestoreError('RESTORE_AUTH_METADATA_INVALID')
        if not isinstance(row['owner'],str) or not re.fullmatch('[a-z_][a-z0-9_]{0,62}',row['owner']):raise RestoreError('RESTORE_AUTH_METADATA_INVALID')
        if any(type(row[key]) is not bool for key in ('rls_enabled','force_rls','app_owner_select','app_owner_effective_owner')):raise RestoreError('RESTORE_AUTH_METADATA_INVALID')
        if not isinstance(row['applicable_policies'],list) or len(row['applicable_policies'])>4:raise RestoreError('RESTORE_AUTH_METADATA_INVALID')
        for policy in row['applicable_policies']:
            if (not isinstance(policy,dict) or set(policy)!={'command','permissive','count','unconditional_count'}
              or policy['command'] not in ('r','*') or type(policy['permissive']) is not bool
              or type(policy['count']) is not int or type(policy['unconditional_count']) is not int
              or not 0<=policy['unconditional_count']<=policy['count']<=1000):raise RestoreError('RESTORE_AUTH_METADATA_INVALID')
    return value

def capture(manifest):
    # Same owned, journaled 60-second observer used by inventory. Raw metadata
    # remains in process memory and later in private, owned Kubernetes Secrets.
    client=inventory.observer.Client(60)
    client.labels['app.kubernetes.io/managed-by']=inventory.OWNER
    inventory.save_client(client)
    try:
        client.prepare()
        script=(HERE/'production-schema/capture_managed_catalog.sql').read_text()
        script=script.replace('__RELEASE_MANIFEST_SHA256__',release.digest(release.canonical(manifest).encode()))
        script=script.replace('__BASELINE_CATALOG_SHA256__',manifest['baseline_catalog_sha256'])
        script=script.replace('__BASELINE_RELEASES_JSON__',release.canonical(manifest['baseline_releases']).replace("'","''"))
        raw=inventory.d.sql(client.pod,script)
        if len(raw.encode())>MAX_SCHEMA_BYTES:raise RestoreError('RESTORE_CATALOG_SIZE_LIMIT')
        return validate_catalog(json.loads(raw))
    finally:
        try:client.cleanup();inventory.clear_client()
        except Exception:raise RestoreError('RESTORE_SOURCE_CLIENT_CLEANUP_UNCONFIRMED') from None

def fixture_source(state):
    replacements={'__OWNER__':builder.identifier(state['role_prefix']+'_owner'),'__SERVICE__':builder.identifier(state['role_prefix']+'_service'),
      '__DATABASE_LITERAL__':builder.literal(state['database']),
      '__DATABASE_COMMENT_LITERAL__':builder.literal('tenderdesk-isolated-bootstrap:'+state['database']+':'+state['role_prefix'])}
    sql=(ASSETS/'fixture.sql').read_text()
    for key,replacement in replacements.items():sql=sql.replace(key,replacement)
    if re.search('__+[A-Z_]+__',sql):raise RestoreError('RESTORE_FIXTURE_PLACEHOLDER_INVALID')
    return sql

def isolated_migrations(manifest,state):
    prefix=builder.checked_name(state['role_prefix'],'role prefix')
    mapping={name:prefix+'_'+suffix for name,suffix in {
      'tdp_app_anon':'anon','tdp_app_authenticated':'authenticated','tdp_app_service':'service','tdp_app_owner':'owner',
      'tdp_app_authadmin':'authadmin','tdp_app_storageadmin':'storageadmin','tdp_app_authenticator':'authenticator'}.items()}
    tokens=re.compile(r'(?<![A-Za-z0-9_])('+'|'.join(sorted(mapping,key=len,reverse=True))+r')(?![A-Za-z0-9_])')
    parts=['BEGIN;SET LOCAL ROLE '+builder.identifier(prefix+'_owner')+";SET LOCAL statement_timeout='180s';SET LOCAL lock_timeout='5s';",
      "DO $$BEGIN IF EXISTS(select 1 from pg_roles where rolname in ('anon','authenticated','service_role')) THEN RAISE EXCEPTION 'RESTORE_LEGACY_ROLE_COLLISION';END IF;END$$;"]
    receipts=[]
    for item in manifest['migrations']:
        original=(release.ROOT/'supabase/migrations'/item['name']).read_bytes()
        if release.digest(original)!=item['sha256']:raise RestoreError('RESTORE_MIGRATION_HASH_MISMATCH')
        mapped=tokens.sub(lambda match:mapping[match.group()],original.decode())
        # Keep transaction authority in the coordinator; reviewed migrations
        # contain additive statements only, never their own transaction shell.
        if re.search(r'^\s*(?:BEGIN|COMMIT|ROLLBACK|\\)\s*;',mapped,re.M|re.I):raise RestoreError('RESTORE_MIGRATION_TRANSACTION_INVALID')
        parts.append(mapped)
        receipts.append({'name':item['name'],'source_sha256':item['sha256'],'isolated_role_mapping_sha256':release.digest(mapped.encode())})
    parts.append('COMMIT;')
    return '\n'.join(parts),receipts

def upstream_access_source(state):
    bootstrap.validate_state(state)
    # Upstream function/Storage access only. The same source-bound platform
    # helper used by production now establishes the Auth SELECT policies during
    # managed schema reconstruction; no independent harness policy remains.
    role=lambda suffix:builder.identifier(state['role_prefix']+'_'+suffix)
    comment=builder.literal('tenderdesk-isolated-bootstrap:'+state['database']+':'+state['role_prefix'])
    return f"""DO $$BEGIN IF current_database()<>{builder.literal(state['database'])} OR
      (select shobj_description(oid,'pg_database') from pg_database where datname=current_database()) IS DISTINCT FROM {comment}
      THEN RAISE EXCEPTION 'RESTORE_TARGET_DATABASE_GUARD';END IF;END$$;
      BEGIN;SET LOCAL ROLE {role('authadmin')};
      DO $$BEGIN IF (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='auth' and c.relname in ('users','identities') and c.relkind='r'
          and c.relrowsecurity and c.relowner=current_user::regrole)<>2
        THEN RAISE EXCEPTION 'RESTORE_AUTH_RLS_PREREQUISITE';END IF;END$$;
      GRANT EXECUTE ON FUNCTION auth.uid() TO {role('owner')},{role('anon')},{role('authenticated')},{role('service')};
      RESET ROLE;SET LOCAL ROLE {role('storageadmin')};
      GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects,storage.buckets TO {role('authenticated')},{role('service')};COMMIT;
    """

def schema_source(value,state,release_manifest):
    bootstrap.validate_state(state)
    sql,_=builder.build_schema(value['catalog'],state['role_prefix'],state['database'],source_role_prefix='tdp_app',
      database_marker='tenderdesk-isolated-bootstrap:'+state['database']+':'+state['role_prefix'])
    additions,receipts=isolated_migrations(release_manifest,state) if value['source_stage']=='baseline' else ('',[])
    guard=upstream_access_source(state)
    result=guard+sql+additions+fixture_source(state)
    raw=result.encode()
    if not 1<=len(raw)<=MAX_SCHEMA_BYTES:raise RestoreError('RESTORE_SCHEMA_SIZE_LIMIT')
    return raw,receipts

def assets_factory(value,release_manifest,original_sql_job):
    def prepare(state,owner,assets):
        raw,_=schema_source(value,state,release_manifest)
        chunks=[raw[n:n+CHUNK_BYTES] for n in range(0,len(raw),CHUNK_BYTES)]
        sources=[]
        for index,chunk in enumerate(chunks):
            name='restore-schema-'+str(index).zfill(3);filename=str(index).zfill(3)+'.sql'
            bootstrap.create({'apiVersion':'v1','kind':'Secret','type':'Opaque','metadata':{
              'name':name,'namespace':state['namespace'],'labels':state['labels'],'ownerReferences':owner},
              'data':{'schema':base64.b64encode(chunk).decode()}})
            sources.append({'secret':{'name':name,'items':[{'key':'schema','path':filename}]}})
        digest=hashlib.sha256(raw).hexdigest()
        def sql_job(actual,name,script,database):
            job=original_sql_job(actual,name,script,database)
            if script!='post-migrations.sql':return job
            if actual!=state or database!=state['database']:raise RestoreError('RESTORE_JOB_SCOPE_CHANGED')
            spec=job['spec']['template']['spec'];spec['securityContext']['fsGroup']=999
            spec['volumes'] += [{'name':'restore-schema','projected':{'defaultMode':0o444,'sources':sources}},
                               {'name':'restore-work','emptyDir':{'medium':'Memory','sizeLimit':'12Mi'}}]
            container=spec['containers'][0]
            container['volumeMounts'] += [{'name':'restore-schema','mountPath':'/opt/restore-schema','readOnly':True},
                                         {'name':'restore-work','mountPath':'/tmp/restore'}]
            # Check concatenated bytes before execution. No caller-controlled
            # path or SQL is accepted; original CA and nonroot identity remain.
            container['command']=['sh','-ec',
              'cat /opt/restore-schema/*.sql > /tmp/restore/schema.sql && '
              "printf '%s  %s\\n' '"+digest+"' '/tmp/restore/schema.sql' | sha256sum -c - >/dev/null && "
              'exec psql --no-psqlrc --set=ON_ERROR_STOP=1 --quiet --file=/tmp/restore/schema.sql']
            return job
        bootstrap.sql_job=sql_job
        acceptance,checks=acceptance_source(assets['acceptance.py'])
        bootstrap.ACCEPTANCE_CHECKS=checks
        return {**assets,'post-migrations.sql':'-- Reconstructed catalog is privately mounted and SHA-256 verified.\n','acceptance.py':acceptance}
    return prepare

def cleanup():
    failed=bootstrap.cleanup_from_state()!=0
    try:inventory.cleanup_saved_client()
    except Exception:failed=True
    if failed:raise RestoreError('RESTORE_CLEANUP_UNCONFIRMED')

def validate_final_contract(manifest):
    names={r['name'] for r in manifest.get('migrations',[])}
    required={'20261104150228_restored_source_review_assurance.sql',
      '20261105120000_source_obligation_resolution.sql','20261105120100_worker_capability_five.sql',
      '20261105120200_retirement_catalog_and_retry_scope.sql'}
    if (manifest.get('minimum_worker_executor')!=5 or manifest.get('renderer_versions')!=[1,2,3]
      or manifest.get('source_resolution_version')!=1 or not required<=names):
        raise RestoreError('RESTORE_FINAL_SOURCE_CONTRACT_REQUIRED')

def run():
    images.verify_checkout(os.environ.get('GITHUB_SHA',''))
    manifest=json.loads(release.MANIFEST.read_text());release.verify_source(manifest)
    validate_final_contract(manifest)
    value=capture(manifest)
    emit('source_auth_metadata',source_auth_read_authority=value['auth_read_authority'])
    original=bootstrap.sql_job
    mapped_receipts=[]
    def factory(state,owner,assets):
        if value['source_stage']=='baseline':
            _,receipts=isolated_migrations(manifest,state);mapped_receipts.extend(receipts)
        return assets_factory(value,manifest,original)(state,owner,assets)
    try:
        result=bootstrap.run(assets_factory=factory)
    finally:bootstrap.sql_job=original
    if result:raise RestoreError('RESTORE_ACCEPTANCE_OR_CLEANUP_FAILED')
    return {'source_revision':os.environ['GITHUB_SHA'],'source_catalog_sha256':value['catalog_sha256'],
      'source_auth_read_authority':value['auth_read_authority'],
      'source_manifest_sha256':release.digest(release.canonical(manifest).encode()),'source_rows_copied':0,'source_stage':value['source_stage'],
      'isolated_additive_migrations_applied':len(manifest['migrations']) if value['source_stage']=='baseline' else 0,
      'isolated_migration_receipts':mapped_receipts,
      'production_business_mutations':0,'model_calls':0,'actual_application_renderer_exercised':False,
      'scope':'isolated_current_catalog_auth_storage_synthetic_restore_only','cleanup_verified':True}

def main(argv=()):
    captured=io.StringIO()
    try:
        with redirect_stdout(captured),redirect_stderr(io.StringIO()):
            if argv==['--cleanup']:cleanup();result={'cleanup_verified':True}
            elif not argv:result=run()
            else:raise RestoreError('RESTORE_MODE_INVALID')
        # Only the reviewed boolean checks survive the private upstream output.
        for line in captured.getvalue().splitlines():
            try:value=json.loads(line)
            except ValueError:continue
            if value.get('probe')=='compatible_services' and value.get('status')=='passed':
                checks=value.get('checks',{})
                if isinstance(checks,dict) and len(checks)==13 and all(re.fullmatch('[a-z_]{1,100}',k) and v is True for k,v in checks.items()):result['checks']=checks
        emit('passed',**result);return 0
    except Exception as error:
        safe=str(error) if isinstance(error,(RestoreError,release.ReleaseError,images.ImageError)) and re.fullmatch('[A-Z_]{1,100}',str(error)) else 'RESTORE_DRILL_FAILED'
        # Never expose catalog, SQL, resource manifest or HTTP error bodies.
        diagnostics=[]
        source_auth=None
        for line in captured.getvalue().splitlines():
            try:value=json.loads(line)
            except ValueError:continue
            if value.get('cloud_restore')=='source_auth_metadata':
                try:source_auth=validate_auth_authority(value.get('source_auth_read_authority'))
                except (RestoreError,TypeError):pass
            code=value.get('code')
            if value.get('probe')=='compatible_services' and isinstance(code,str) and re.fullmatch('[A-Z][A-Z0-9_]{2,80}',code):diagnostics.append(code)
        emit('blocked',code=safe,**({'diagnostics':diagnostics[:8]} if diagnostics else {}),
          **({'source_auth_read_authority':source_auth} if source_auth is not None else {}));return 1

if __name__=='__main__':sys.exit(main(sys.argv[1:]))
