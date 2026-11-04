#!/usr/bin/env python3
"""Frozen additive migration batch; no business commands or historical activation.

The coordinator freezes a reviewed manifest after all source merges. The runner
refuses source/ledger/catalog drift, applies the whole batch atomically, and
records its post-migration catalog for safe forward completion after lost ACKs.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
MANIFEST = HERE / 'proposal-delivery-release.json'
RELEASE = 'proposal-delivery-reliability-v1'
CUTOFF = '20261103032000_model_admission_fairness.sql'
REQUIRED = ('20261104121022_partial_document_coverage.sql',
 '20261104121116_proposal_delivery_snapshots.sql', '20261104121423_provider_failure_scope.sql',
 '20261104121443_automatic_usage_recovery.sql', '20261104122015_company_evidence_retrieval.sql',
 '20261104122333_durable_delivery_artifacts.sql',
 '20261104133930_durable_uploaded_document_ocr.sql',
 '20261104134540_source_evidence_authority.sql',
 '20261104134646_structured_proposal_authoring.sql',
 '20261104135306_proposal_consistency_contract.sql',
 '20261104135748_proposal_consistency_review.sql',
 '20261104140628_authored_response_adoption.sql',
 '20261104142525_proposal_issuance_deadline.sql',
 '20261104143632_generated_review_delivery.sql',
 '20261104144002_requirement_applicability_binding.sql',
 '20261104150228_restored_source_review_assurance.sql',
 '20261104151946_current_proposal_issuance_contract.sql',
 '20261104152913_durable_ordinary_export_packages.sql',
 '20261104160125_proposal_issuance_file_capacity.sql',
 '20261104163406_serialize_local_document_rendering.sql')
CAPABILITIES = {'executor_max':4,'renderer_versions':[1,2,3],
 'minimum_worker_executor':4,'ordinary_renderer_version':'ordinary-2',
 'current_proposal_issuance_contract':1,'issuance_file_capacity_version':1,
 'global_renderer_limit':1}
CATALOG = """SELECT encode(sha256(convert_to(coalesce(string_agg(
 p.oid::regprocedure::text||':'||pg_get_functiondef(p.oid)||':'||coalesce(p.proacl::text,''),E'\\n'
 ORDER BY p.oid::regprocedure::text),''),'UTF8')),'hex') INTO catalog_hash
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','app_private') AND p.prokind='f';"""
ROWS = """state:='{}'::jsonb;
 FOR r IN SELECT key,value FROM jsonb_each_text(columns_before) LOOP
 EXECUTE format('SELECT count(*)::bigint,md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM (SELECT %s FROM %s) x',r.value,r.key) INTO row_count,row_digest;
 state:=state||jsonb_build_object(r.key,jsonb_build_object('count',row_count,'digest',row_digest));
 END LOOP;"""
AUTHORITY = """SELECT jsonb_build_object(
 'functions',(SELECT jsonb_object_agg(t.signature,jsonb_build_object('owner',p.proowner,'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig))
  FROM unnest(functions_before)t(signature) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(t.signature)),
 'tables',(SELECT jsonb_object_agg(t.signature,jsonb_build_object('owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity))
  FROM unnest(relations_before)t(signature) LEFT JOIN pg_class c ON c.oid=to_regclass(t.signature)),
 'columns',(SELECT jsonb_object_agg(a.attrelid::regclass::text||':'||a.attnum,a.attacl)
  FROM pg_attribute a WHERE a.attnum>0 AND NOT a.attisdropped
   AND a.attrelid::regclass::text||':'||a.attnum=ANY(attributes_before)),
 'policies',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.schemaname,p.tablename,p.policyname),'[]'::jsonb)
  FROM pg_policies p WHERE format('%I.%I',p.schemaname,p.tablename)=ANY(relations_before)),
 'roles',(SELECT jsonb_agg(to_jsonb(role_row) ORDER BY role_row.rolname) FROM pg_roles role_row),
 'memberships',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.roleid,m.member,m.grantor),'[]'::jsonb) FROM pg_auth_members m)
 ) INTO authority;"""

class ReleaseError(Exception): pass

def canonical(value): return json.dumps(value,sort_keys=True,separators=(',',':'))
def digest(value): return hashlib.sha256(value).hexdigest()
def literal(value): return "'"+value.replace("'","''")+"'"

def freeze(inventory, *, migrations=ROOT/'supabase/migrations'):
    if (inventory.get('version')!=1 or inventory.get('namespace')!='tenderdesk-dev' or inventory.get('ready_workloads')!=10
      or inventory.get('inventory')!='captured' or inventory.get('bootstrap_run') is not False
      or inventory.get('business_mutations')!=0 or inventory.get('schema_mutations')!=0
      or inventory.get('models_called')!=0 or inventory.get('temporary_client_cleanup_verified') is not True):
        raise ReleaseError('DELIVERY_RELEASE_INVENTORY_REQUIRED')
    schema=inventory.get('schema',{})
    if not re.fullmatch('[a-f0-9]{64}',schema.get('routine_catalog_sha256','')) or schema.get('canonical_migrations') is not None:
        raise ReleaseError('DELIVERY_RELEASE_BASELINE_INVALID')
    releases={row['release']:row['migration_sha256'] for row in schema.get('release_history',[])}
    if len(releases)!=6 or any(not re.fullmatch('[a-z][a-z0-9-]{1,100}',k) or not re.fullmatch('[a-f0-9]{64}',v) for k,v in releases.items()):
        raise ReleaseError('DELIVERY_RELEASE_BASELINE_INVALID')
    files=sorted(p for p in migrations.glob('*.sql') if p.name>CUTOFF)
    if not set(REQUIRED)<=set(p.name for p in files): raise ReleaseError('DELIVERY_RELEASE_MIGRATION_MISSING')
    workloads=inventory.get('workloads',[])
    images={row.get('name'):row.get('image') for row in workloads}
    if len(workloads)!=10 or set(images)!={'api','worker','frontend','auth','rest','storage','source-browser','scheduler','gateway','https'} or any(not isinstance(v,str) or not re.fullmatch(r'[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}',v) for v in images.values()): raise ReleaseError('DELIVERY_RELEASE_WORKLOAD_BASELINE_REQUIRED')
    schedules=inventory.get('native_schedules')
    if not isinstance(schedules,list) or {r.get('name') for r in schedules}!={'native-browser','native-ocr'}: raise ReleaseError('DELIVERY_RELEASE_NATIVE_BASELINE_REQUIRED')
    return {'version':1,'release':RELEASE,'baseline_images':images,'baseline_native_schedules':schedules,**json.loads(canonical(CAPABILITIES)),'baseline_catalog_sha256':schema['routine_catalog_sha256'],
      'baseline_releases':releases,'migrations':[{'name':p.name,'sha256':digest(p.read_bytes())} for p in files]}

def validate_runtime_baseline(manifest):
    values=manifest.get('baseline_images')
    names={'api','worker','frontend','auth','rest','storage','source-browser','scheduler','gateway','https'}
    if not isinstance(values,dict) or set(values)!=names or any(not isinstance(v,str) or not re.fullmatch(r'[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}',v) for v in values.values()):raise ReleaseError('DELIVERY_RELEASE_WORKLOAD_BASELINE_REQUIRED')
    schedules=manifest.get('baseline_native_schedules')
    if not isinstance(schedules,list) or len(schedules)!=2 or [r.get('name') for r in schedules]!=['native-browser','native-ocr']:raise ReleaseError('DELIVERY_RELEASE_NATIVE_BASELINE_REQUIRED')
    fields={'name','image','schedule','container_identity_recognized','concurrency_policy','concurrency_policy_explicit','suspended','suspend_explicit','active_deadline_seconds','backoff_limit','effective_backoff_limit','resources','generation'}
    for row in schedules:
        if set(row)!=fields or not re.fullmatch(r'registry\.digitalocean\.com/tenderdesk-a6093a76/(?:browser|ocr)@sha256:[a-f0-9]{64}',row.get('image','')):raise ReleaseError('DELIVERY_RELEASE_NATIVE_BASELINE_REQUIRED')
        if not isinstance(row['schedule'],str) or len(row['schedule'])>100 or not re.fullmatch(r'[0-9*/,\-]+(?: +[0-9*/,\-]+){4}',row['schedule']):raise ReleaseError('DELIVERY_RELEASE_NATIVE_BASELINE_REQUIRED')
        if row['concurrency_policy'] not in ('Allow','Forbid','Replace') or any(type(row[key]) is not bool for key in ('container_identity_recognized','concurrency_policy_explicit','suspended','suspend_explicit')):raise ReleaseError('DELIVERY_RELEASE_NATIVE_BASELINE_REQUIRED')
        for key,maximum,nullable in [('active_deadline_seconds',604800,True),('backoff_limit',100,True),('effective_backoff_limit',100,False),('generation',1000000,False)]:
            value=row[key]
            if value is None and nullable:continue
            if type(value) is not int or not 0<=value<=maximum:raise ReleaseError('DELIVERY_RELEASE_NATIVE_BASELINE_REQUIRED')
        if row['effective_backoff_limit']!=(6 if row['backoff_limit'] is None else row['backoff_limit']):raise ReleaseError('DELIVERY_RELEASE_NATIVE_BASELINE_REQUIRED')
        if not isinstance(row['resources'],dict) or set(row['resources'])!={'requests','limits'}:raise ReleaseError('DELIVERY_RELEASE_NATIVE_BASELINE_REQUIRED')
        for group in row['resources'].values():
            if group is None:continue
            if not isinstance(group,dict) or set(group)!={'cpu','memory','ephemeral-storage'}:raise ReleaseError('DELIVERY_RELEASE_NATIVE_BASELINE_REQUIRED')
            for quantity in group.values():
                if quantity is not None and (not isinstance(quantity,str) or len(quantity)>24 or not re.fullmatch(r'[0-9]{1,15}(?:\.[0-9]{1,9})?(?:m|Ki|Mi|Gi|Ti|K|M|G|T)?',quantity)):raise ReleaseError('DELIVERY_RELEASE_NATIVE_BASELINE_REQUIRED')

def verify_source(manifest, *, migrations=ROOT/'supabase/migrations'):
    if not isinstance(manifest,dict) or set(manifest)!={'version','release','baseline_catalog_sha256','baseline_releases','migrations','baseline_images','baseline_native_schedules',*CAPABILITIES} or manifest['version']!=1 or manifest['release']!=RELEASE:
        raise ReleaseError('DELIVERY_RELEASE_MANIFEST_INVALID')
    if not re.fullmatch('[a-f0-9]{64}',manifest['baseline_catalog_sha256']): raise ReleaseError('DELIVERY_RELEASE_MANIFEST_INVALID')
    validate_runtime_baseline(manifest)
    if canonical({key:manifest[key] for key in CAPABILITIES})!=canonical(CAPABILITIES): raise ReleaseError('DELIVERY_RELEASE_CAPABILITY_SOURCE_MISMATCH')
    receipts=manifest['baseline_releases']
    if not isinstance(receipts,dict) or len(receipts)!=6 or any(not re.fullmatch('[a-z][a-z0-9-]{1,100}',k) or not re.fullmatch('[a-f0-9]{64}',v) for k,v in receipts.items()):
        raise ReleaseError('DELIVERY_RELEASE_MANIFEST_INVALID')
    entries=manifest['migrations']
    if not isinstance(entries,list) or not len(REQUIRED)<=len(entries)<=30: raise ReleaseError('DELIVERY_RELEASE_MANIFEST_INVALID')
    names=[]; sources=[]
    for row in entries:
        if not isinstance(row,dict) or set(row)!={'name','sha256'} or not re.fullmatch(r'20261104[0-9]{6}_[a-z0-9_]+\.sql',row['name']) or not re.fullmatch('[a-f0-9]{64}',row['sha256']): raise ReleaseError('DELIVERY_RELEASE_MANIFEST_INVALID')
        path=migrations/row['name']
        if not path.is_file() or path.is_symlink() or digest(path.read_bytes())!=row['sha256']: raise ReleaseError('DELIVERY_RELEASE_SOURCE_CHANGED')
        names.append(row['name']); sources.append(path.read_text())
    if names!=sorted(set(names)) or not set(REQUIRED)<=set(names) or names!=sorted(p.name for p in migrations.glob('*.sql') if p.name>CUTOFF):
        raise ReleaseError('DELIVERY_RELEASE_MIGRATION_SET_CHANGED')
    return sources

def migration_script(manifest, sources=None):
    # Supplying sources exists solely for isolated fault-injection tests. The
    # production entrypoint always verifies every source byte against the file.
    if sources is None: sources=verify_source(manifest)
    if len(sources)!=len(manifest['migrations']) or any(not s.strip() for s in sources): raise ReleaseError('DELIVERY_RELEASE_SOURCE_EMPTY')
    payload='\n'.join(sources); delimiter='$delivery_release_payload$'
    while delimiter in payload: delimiter=delimiter[:-1]+'_$'
    checksum=digest(canonical(manifest).encode())
    return """BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL ROLE tdp_app_owner;
SET LOCAL statement_timeout='180s';SET LOCAL lock_timeout='15s';
SELECT pg_advisory_xact_lock(hashtextextended('tenderdesk.proposal-delivery.release',0));
DO $delivery_release$
DECLARE r record; target text; catalog_hash text; saved_catalog text; saved_manifest text;
 columns_before jsonb; functions_before text[]; relations_before text[]; attributes_before text[];
 version_number integer; selected_renderer text; selected_executor integer;
 row_count bigint; row_digest text; state jsonb; rows_before jsonb; authority jsonb; authority_before jsonb;
BEGIN
 IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'DELIVERY_RELEASE_DATABASE_MISMATCH';END IF;
 IF to_regclass('app_private.application_release_history') IS NULL THEN RAISE EXCEPTION 'DELIVERY_RELEASE_LEDGER_REQUIRED';END IF;
 IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN RAISE EXCEPTION 'DELIVERY_RELEASE_BASELINE_CHANGED';END IF;
 IF (SELECT coalesce(jsonb_object_agg(release,migration_sha256),'{}') FROM app_private.application_release_history
     WHERE release NOT IN ('__RELEASE__','__RELEASE__-catalog')) IS DISTINCT FROM __BASELINE__::jsonb
 THEN RAISE EXCEPTION 'DELIVERY_RELEASE_LEDGER_CHANGED';END IF;
 SELECT migration_sha256 INTO saved_manifest FROM app_private.application_release_history WHERE release='__RELEASE__' FOR UPDATE;
 SELECT migration_sha256 INTO saved_catalog FROM app_private.application_release_history WHERE release='__RELEASE__-catalog' FOR UPDATE;
 IF (saved_manifest IS NULL)<>(saved_catalog IS NULL) THEN RAISE EXCEPTION 'DELIVERY_RELEASE_PARTIAL_RECEIPT';END IF;
 __CATALOG__
 IF saved_manifest IS NOT NULL THEN
  IF saved_manifest<>'__CHECKSUM__' THEN RAISE EXCEPTION 'DELIVERY_RELEASE_CHECKSUM_CHANGED';END IF;
  IF saved_catalog IS DISTINCT FROM catalog_hash THEN RAISE EXCEPTION 'DELIVERY_RELEASE_POST_CATALOG_CHANGED';END IF;
 ELSE
  IF catalog_hash<>'__BEFORE_HASH__' OR to_regclass('public.proposal_delivery_snapshots') IS NOT NULL
   OR to_regclass('public.proposal_delivery_artifacts') IS NOT NULL
  THEN RAISE EXCEPTION 'DELIVERY_RELEASE_BASELINE_CHANGED';END IF;
  SELECT jsonb_object_agg(signature,cols),array_agg(signature ORDER BY signature) INTO columns_before,relations_before
   FROM (SELECT format('%I.%I',n.nspname,c.relname) signature,string_agg(quote_ident(a.attname),',' ORDER BY a.attnum) cols
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
    GROUP BY n.nspname,c.relname)t;
  SELECT array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text) INTO functions_before
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app_private') AND p.prokind='f';
  SELECT array_agg(a.attrelid::regclass::text||':'||a.attnum ORDER BY a.attrelid,a.attnum) INTO attributes_before
   FROM pg_attribute a WHERE a.attrelid IN (SELECT to_regclass(signature) FROM unnest(relations_before)t(signature))
    AND a.attnum>0 AND NOT a.attisdropped;
  __ROWS__
  rows_before:=state;
  __AUTHORITY__
  authority_before:=authority;
  EXECUTE __DELIMITER____PAYLOAD____DELIMITER__;
  __ROWS__
  IF rows_before IS DISTINCT FROM state THEN RAISE EXCEPTION 'DELIVERY_RELEASE_EXISTING_ROWS_CHANGED';END IF;
  __AUTHORITY__
  IF authority_before IS DISTINCT FROM authority THEN RAISE EXCEPTION 'DELIVERY_RELEASE_EXISTING_AUTHORITY_CHANGED';END IF;
  FOR target IN SELECT format('%I.%I',schemaname,tablename) FROM pg_tables
    WHERE schemaname IN ('public','app_private') AND format('%I.%I',schemaname,tablename)<>ALL(relations_before) LOOP
   EXECUTE format('SELECT count(*) FROM %s',target) INTO row_count;
   IF row_count<>0 THEN RAISE EXCEPTION 'DELIVERY_RELEASE_UNREQUESTED_NEW_ROWS';END IF;
  END LOOP;
  __CATALOG__
  INSERT INTO app_private.application_release_history(release,migration_sha256) VALUES
   ('__RELEASE__','__CHECKSUM__'),('__RELEASE__-catalog',catalog_hash);
 END IF;
 IF to_regprocedure('public.claim_backend_job_v__EXECUTOR__()') IS NULL
  OR to_regprocedure('public.claim_backend_local_job_v__EXECUTOR__()') IS NULL
  OR to_regprocedure('public.delivery_artifact_context(uuid,uuid)') IS NULL
 THEN RAISE EXCEPTION 'DELIVERY_RELEASE_RUNTIME_CONTRACT_MISSING';END IF;
 FOREACH target IN ARRAY ARRAY['public.claim_backend_job_v__EXECUTOR__()','public.delivery_export_context(uuid,uuid)',
  'public.complete_delivery_artifact(uuid,uuid,uuid,text,bigint)','public.delivery_artifact_context(uuid,uuid)'] LOOP
  IF has_function_privilege('tdp_app_authenticated',target,'EXECUTE') OR has_function_privilege('tdp_app_anon',target,'EXECUTE')
   OR NOT has_function_privilege('tdp_app_service',target,'EXECUTE') THEN RAISE EXCEPTION 'DELIVERY_RELEASE_SERVICE_AUTHORITY_INVALID';END IF;
 END LOOP;
 IF __EXECUTOR__=4 THEN
  IF to_regprocedure('app_private.delivery_renderer(public.proposal_delivery_snapshots)') IS NULL
   OR to_regprocedure('app_private.delivery_executor(public.proposal_delivery_snapshots)') IS NULL THEN RAISE EXCEPTION 'DELIVERY_RELEASE_RENDERER_CONTRACT_MISSING';END IF;
  FOREACH version_number IN ARRAY __RENDERERS__ LOOP
   EXECUTE 'SELECT app_private.delivery_renderer(s),app_private.delivery_executor(s) FROM jsonb_populate_record(null::public.proposal_delivery_snapshots,jsonb_build_object(''payload'',jsonb_build_object(''version'',$1))) s'
    INTO selected_renderer,selected_executor USING version_number;
   IF selected_renderer IS DISTINCT FROM version_number::text OR selected_executor IS DISTINCT FROM (case when version_number=1 then 3 else 4 end)
    THEN RAISE EXCEPTION 'DELIVERY_RELEASE_RENDERER_CONTRACT_MISMATCH';END IF;
  END LOOP;
 END IF;
 IF __MINIMUM_EXECUTOR__=4 AND (to_regclass('public.proposal_issuance_requests') IS NULL OR to_regclass('public.proposal_issuance_status') IS NULL)
  THEN RAISE EXCEPTION 'DELIVERY_RELEASE_DEADLINE_CONTRACT_MISSING';END IF;
 -- Source hashes bind the implementation. These independent catalog checks
 -- reject absent/disabled contracts and exposed new RPCs before runtime rollout.
 -- They do not substitute for actual mixed-version claim and capacity tests.
 FOREACH target IN ARRAY ARRAY['public.export_render_context(uuid,uuid)',
  'public.complete_export_package_volume(uuid,uuid,uuid,text,bigint)',
  'public.finish_export_package(uuid,uuid)','public.fail_export_package(uuid,uuid,text)',
  'public.report_export_package_artifact_failure(uuid,uuid,uuid,integer,text,text,text,bigint)',
  'public.reserve_task_model_call(uuid,uuid,text,text,integer,integer,jsonb,uuid,uuid)',
  'public.reserve_model_call(uuid,uuid,text,text,integer,integer,jsonb,text)',
  'public.authorize_artifact_download(uuid,uuid,text)'] LOOP
  IF to_regprocedure(target) IS NULL THEN RAISE EXCEPTION 'DELIVERY_RELEASE_FINAL_RPC_MISSING';END IF;
  IF has_function_privilege('tdp_app_authenticated',target,'EXECUTE') OR has_function_privilege('tdp_app_anon',target,'EXECUTE')
   OR NOT has_function_privilege('tdp_app_service',target,'EXECUTE')
   OR NOT (SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure(target))
   THEN RAISE EXCEPTION 'DELIVERY_RELEASE_FINAL_RPC_AUTHORITY_INVALID';END IF;
 END LOOP;
 FOREACH target IN ARRAY ARRAY['app_private.ensure_issuance_file_capacity(uuid,uuid)',
  'app_private.guard_issuance_file_capacity()','app_private.bind_issuance_job()',
  'app_private.app_command_before_current_issuance_contract(text,jsonb,text)'] LOOP
  IF to_regprocedure(target) IS NULL THEN RAISE EXCEPTION 'DELIVERY_RELEASE_FINAL_PRIVATE_CONTRACT_MISSING';END IF;
  IF has_function_privilege('tdp_app_authenticated',target,'EXECUTE') OR has_function_privilege('tdp_app_anon',target,'EXECUTE')
   THEN RAISE EXCEPTION 'DELIVERY_RELEASE_FINAL_PRIVATE_AUTHORITY_INVALID';END IF;
 END LOOP;
 IF to_regprocedure('public.export_package_context(uuid)') IS NULL
  THEN RAISE EXCEPTION 'DELIVERY_RELEASE_FINAL_RPC_MISSING';END IF;
 IF NOT has_function_privilege('tdp_app_authenticated','public.export_package_context(uuid)','EXECUTE')
  OR has_function_privilege('tdp_app_anon','public.export_package_context(uuid)','EXECUTE')
  THEN RAISE EXCEPTION 'DELIVERY_RELEASE_FINAL_RPC_AUTHORITY_INVALID';END IF;
 FOREACH target IN ARRAY ARRAY['public.export_packages','public.export_package_volumes'] LOOP
  IF to_regclass(target) IS NULL THEN RAISE EXCEPTION 'DELIVERY_RELEASE_EXPORT_TABLE_MISSING';END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass(target))
   OR has_table_privilege('tdp_app_authenticated',target,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_table_privilege('tdp_app_anon',target,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_any_column_privilege('tdp_app_authenticated',target,'SELECT,INSERT,UPDATE,REFERENCES')
   OR has_any_column_privilege('tdp_app_anon',target,'SELECT,INSERT,UPDATE,REFERENCES')
   THEN RAISE EXCEPTION 'DELIVERY_RELEASE_EXPORT_TABLE_AUTHORITY_INVALID';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM (VALUES
    ('file_capacity_version','integer'::regtype,false,'1'),
    ('file_capacity_acquired','boolean'::regtype,true,'false'),
    ('reserved_file_bytes','bigint'::regtype,true,'0')) expected(name,kind,required,default_value)
   LEFT JOIN pg_attribute a ON a.attrelid='public.proposal_issuance_requests'::regclass AND a.attname=expected.name AND NOT a.attisdropped
   LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attname IS NULL OR a.atttypid<>expected.kind OR a.attnotnull<>expected.required
    OR pg_get_expr(d.adbin,d.adrelid) IS DISTINCT FROM expected.default_value)
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.proposal_issuance_requests'::regclass
   AND conname='issuance_file_capacity_bounds' AND contype='c' AND convalidated)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.proposal_issuance_requests'::regclass
   AND tgname='issuance_capacity_guard' AND tgenabled='O' AND tgfoid='app_private.guard_issuance_file_capacity()'::regprocedure)
  OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.jobs'::regclass
   AND tgenabled='O' AND tgfoid='app_private.bind_issuance_job()'::regprocedure)
  THEN RAISE EXCEPTION 'DELIVERY_RELEASE_CAPACITY_CONTRACT_INVALID';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('app_private.document_render_slot_available()')
   AND prorettype='boolean'::regtype AND prosecdef AND provolatile='v' AND proconfig=ARRAY['search_path=""']::text[])
  OR NOT EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('public.jobs_active_document_render')
   AND indrelid='public.jobs'::regclass AND indisvalid AND indisready AND indpred IS NOT NULL)
  OR to_regclass('public.one_active_job_per_workspace') IS NOT NULL
  OR EXISTS(SELECT 1 FROM (VALUES ('public.one_active_non_render_job_per_workspace'),
     ('public.one_active_render_job_per_workspace')) lane(name)
    LEFT JOIN pg_index i ON i.indexrelid=to_regclass(lane.name)
    WHERE i.indexrelid IS NULL OR i.indrelid<>'public.jobs'::regclass OR NOT i.indisunique OR NOT i.indisvalid OR NOT i.indisready
     OR i.indpred IS NULL OR i.indnkeyatts<>1 OR i.indkey[0]<>(SELECT attnum FROM pg_attribute
      WHERE attrelid='public.jobs'::regclass AND attname='workspace_id' AND NOT attisdropped))
  THEN RAISE EXCEPTION 'DELIVERY_RELEASE_RENDER_ADMISSION_INVALID';END IF;
 IF has_function_privilege('tdp_app_authenticated','app_private.document_render_slot_available()','EXECUTE')
  OR has_function_privilege('tdp_app_anon','app_private.document_render_slot_available()','EXECUTE')
  OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
   JOIN pg_roles role_row ON role_row.oid=acl.grantee
   WHERE p.oid='app_private.document_render_slot_available()'::regprocedure
    AND role_row.rolname IN ('service_role','tdp_app_service'))
  THEN RAISE EXCEPTION 'DELIVERY_RELEASE_RENDER_ADMISSION_AUTHORITY_INVALID';END IF;
 PERFORM set_config('tenderdesk.delivery_release_receipt',jsonb_build_object('release','__RELEASE__',
  'manifest_sha256','__CHECKSUM__','catalog_sha256',catalog_hash,'replayed',saved_manifest IS NOT NULL)::text,true);
END $delivery_release$;
SELECT current_setting('tenderdesk.delivery_release_receipt');
NOTIFY pgrst,'reload schema';COMMIT;
""".replace('__RENDERERS__','ARRAY['+','.join(map(str,manifest['renderer_versions']))+']::integer[]').replace('__MINIMUM_EXECUTOR__',str(manifest['minimum_worker_executor'])).replace('__EXECUTOR__',str(manifest['executor_max'])).replace('__BASELINE__',literal(canonical(manifest['baseline_releases']))).replace('__BEFORE_HASH__',manifest['baseline_catalog_sha256']).replace('__RELEASE__',RELEASE).replace('__CHECKSUM__',checksum).replace('__ROWS__',ROWS).replace('__AUTHORITY__',AUTHORITY).replace('__CATALOG__',CATALOG).replace('__DELIMITER__',delimiter).replace('__PAYLOAD__',payload)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--freeze',type=Path,help='Local only: read sanitized inventory and freeze exact source manifest for review')
    parser.add_argument('--print-sql',action='store_true',help='Local review/test only; never executes database commands')
    args=parser.parse_args()
    try:
        if args.freeze:
            value=freeze(json.loads(args.freeze.read_text()));verify_source(value)
            MANIFEST.write_text(json.dumps(value,indent=2,sort_keys=True)+'\n')
            print(json.dumps({'release':RELEASE,'status':'manifest_frozen_for_review','migration_count':len(value['migrations'])}))
        elif args.print_sql:
            print(migration_script(json.loads(MANIFEST.read_text())))
        else:
            value=json.loads(MANIFEST.read_text());verify_source(value)
            print(json.dumps({'release':RELEASE,'status':'source_verified','manifest_sha256':digest(canonical(value).encode()),'migration_count':len(value['migrations'])}))
        return 0
    except Exception as error:
        print(json.dumps({'release':RELEASE,'status':'blocked','code':str(error) if isinstance(error,ReleaseError) else 'DELIVERY_RELEASE_MANIFEST_UNAVAILABLE'}))
        return 1
if __name__=='__main__':sys.exit(main())
