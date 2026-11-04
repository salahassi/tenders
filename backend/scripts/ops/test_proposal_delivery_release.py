"""Exact source, real SQL rollback/replay, private row and authority invariants."""
import copy
import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SPEC=importlib.util.spec_from_file_location('tested_delivery_release',Path(__file__).with_name('proposal-delivery-release.py'))
p=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=p;SPEC.loader.exec_module(p)

class DeliveryReleaseTests(unittest.TestCase):
    def setUp(self):
        # This is an isolated source-binding fixture, not an executed gateway
        # qualification receipt. Production freeze always reads its fixed files.
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.gateway_root=Path(temporary.name)
        baseline=(p.ROOT/p.GATEWAY_BEFORE).read_text()
        self.gateway_image='docker.io/nginxinc/nginx-unprivileged:1.29.5-alpine@sha256:99e7cb7bee644b244b2b5e7bb737e972e54dbaa150cabc7ae0598731cdeb7ac8'
        self.gateway_after=baseline+'\n# Synthetic test target; no runtime qualification asserted.\n'
        self.qualification={'passed':True,'actual_binary_exercised':True,'production_calls':0,'customer_calls':0,
          'gateway_resumable_denial_qualified':True,'signed_tus_bypass_confirmed':True,
          'gateway_config_source_sha256':hashlib.sha256(self.gateway_after.encode()).hexdigest(),
          'gateway_image':self.gateway_image,'fixture':'synthetic-only'}
        for name,text in ((p.GATEWAY_BEFORE,baseline),(p.GATEWAY_AFTER,self.gateway_after),
          (p.GATEWAY_QUALIFICATION,json.dumps(self.qualification)),
          ('deploy/kubernetes/render.py','NGINX_IMAGE = '+repr(self.gateway_image)+'\n')):
            path=self.gateway_root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text)

    def verify(self,manifest,**kwargs):
        return p.verify_source(manifest,gateway_root=self.gateway_root,**kwargs)

    def inventory(self):
        return {'version':1,'namespace':'tenderdesk-dev','ready_workloads':10,'inventory':'captured',
          'bootstrap_run':False,'business_mutations':0,'schema_mutations':0,'models_called':0,'temporary_client_cleanup_verified':True,
          'workloads':[{'name':name,'image':self.gateway_image if name=='gateway' else 'registry.example/runtime@sha256:'+'a'*64} for name in ('api','worker','frontend','auth','rest','storage','source-browser','scheduler','gateway','https')],
          'native_schedules':[{'name':name,'image':'registry.digitalocean.com/tenderdesk-a6093a76/'+name.removeprefix('native-')+'@sha256:'+'a'*64,'schedule':'*/10 * * * *','container_identity_recognized':True,'concurrency_policy':'Forbid','concurrency_policy_explicit':True,'suspended':False,'suspend_explicit':True,'active_deadline_seconds':600,'backoff_limit':0,'effective_backoff_limit':0,'resources':{'requests':None,'limits':None},'generation':1} for name in ('native-browser','native-ocr')],
          'schema':{'routine_catalog_sha256':'0'*64,'canonical_migrations':None,'release_history':[
            {'release':'prior-release-'+str(i),'migration_sha256':str(i)*64} for i in range(1,7)]}}

    def manifest(self):
        return p.freeze(self.inventory(),gateway_root=self.gateway_root)

    def test_every_final_contract_is_required_before_freezing(self):
        manifest=self.manifest()
        self.assertEqual(len(p.REQUIRED),22)
        self.assertEqual({key:manifest[key] for key in p.CAPABILITIES},p.CAPABILITIES)
        with self.assertRaises(p.ReleaseError):p.freeze({'receipt':self.inventory()})
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)
            for row in manifest['migrations']:
                (folder/row['name']).write_bytes((p.ROOT/'supabase/migrations'/row['name']).read_bytes())
            for name in p.REQUIRED:
                path=folder/name;data=path.read_bytes();path.unlink()
                with self.subTest(name=name),self.assertRaisesRegex(p.ReleaseError,'MIGRATION_MISSING'):
                    p.freeze(self.inventory(),migrations=folder,gateway_root=self.gateway_root)
                path.write_bytes(data)

    def test_final_capabilities_cannot_be_downgraded_or_coerced(self):
        for key,value in (('executor_max',3),('minimum_worker_executor',0),('renderer_versions',[1,2]),
          ('ordinary_renderer_version','ordinary-1'),('current_proposal_issuance_contract',True),
          ('issuance_file_capacity_version',0),('global_renderer_limit',2),
          ('storage_write_intents_version',False),('storage_retirement_version',0),('storage_gateway_guard_version',True)):
            manifest=self.manifest();manifest[key]=value
            with self.subTest(key=key),self.assertRaisesRegex(p.ReleaseError,'CAPABILITY_SOURCE_MISMATCH'):
                self.verify(manifest)

    def test_source_set_and_bytes_are_frozen(self):
        manifest=self.manifest();self.assertGreaterEqual(len(self.verify(manifest)),6)
        for mutate in (lambda m:m['migrations'].pop(),lambda m:m['migrations'][0].update(sha256='f'*64),
          lambda m:m['migrations'][0].update(name='../unexpected.sql'),lambda m:m.update(release='another'),lambda m:m['baseline_native_schedules'].pop()):
            changed=copy.deepcopy(manifest);mutate(changed)
            with self.assertRaises(p.ReleaseError):self.verify(changed)
        with tempfile.TemporaryDirectory() as directory:
            for row in manifest['migrations']:
                (Path(directory)/row['name']).write_bytes((p.ROOT/'supabase/migrations'/row['name']).read_bytes())
            (Path(directory)/'20261104999999_unreviewed.sql').write_text('select 1;')
            with self.assertRaisesRegex(p.ReleaseError,'SET_CHANGED'):self.verify(manifest,migrations=Path(directory))

    def test_gateway_manifest_binds_raw_and_rendered_config_receipt_and_image(self):
        manifest=self.manifest();value=manifest['gateway_configuration']
        self.assertEqual(value['version'],1)
        self.assertEqual(value['before_source_sha256'],p.GATEWAY_BASELINE_SHA256)
        self.assertEqual(value['after_source_sha256'],hashlib.sha256(self.gateway_after.encode()).hexdigest())
        self.assertEqual(value['after_data_sha256'],hashlib.sha256(json.dumps(
          {'nginx.conf':self.gateway_after.replace('__NAMESPACE__','tenderdesk-dev')},sort_keys=True).encode()).hexdigest())
        self.assertNotEqual(value['after_source_sha256'],value['after_data_sha256'])
        self.assertEqual(value['qualification_sha256'],hashlib.sha256((self.gateway_root/p.GATEWAY_QUALIFICATION).read_bytes()).hexdigest())
        self.assertEqual(value['gateway_image'],self.gateway_image)
        self.verify(manifest)
        for key in value:
            changed=copy.deepcopy(manifest)
            changed['gateway_configuration'][key]=True if key=='version' else 'f'*64
            with self.subTest(key=key),self.assertRaisesRegex(p.ReleaseError,'GATEWAY_SOURCE_CHANGED'):
                self.verify(changed)
        for mutation in ('remove','extra'):
            changed=copy.deepcopy(manifest)
            if mutation=='remove':del changed['gateway_configuration']
            else:changed['gateway_configuration']['unreviewed']=True
            with self.subTest(mutation=mutation),self.assertRaises(p.ReleaseError):self.verify(changed)
        bad=self.inventory();next(row for row in bad['workloads'] if row['name']=='gateway')['image']='registry.example/nginx@sha256:'+'f'*64
        with self.assertRaisesRegex(p.ReleaseError,'GATEWAY_IMAGE_CHANGED'):
            p.freeze(bad,gateway_root=self.gateway_root)

    def test_gateway_qualification_is_strict_and_current(self):
        path=self.gateway_root/p.GATEWAY_QUALIFICATION;raw=path.read_bytes()
        for key,value in (('passed',False),('actual_binary_exercised',1),('gateway_resumable_denial_qualified',False),
          ('signed_tus_bypass_confirmed',False),('production_calls',True),('customer_calls',1),
          ('gateway_config_source_sha256','f'*64),('gateway_image',self.gateway_image[:-1]+'f')):
            changed={**self.qualification,key:value};path.write_text(json.dumps(changed))
            with self.subTest(key=key),self.assertRaisesRegex(p.ReleaseError,'GATEWAY_QUALIFICATION_INVALID'):
                self.manifest()
            path.write_bytes(raw)
        manifest=self.manifest();path.write_text(json.dumps({**self.qualification,'receipt_revision':2}))
        with self.assertRaisesRegex(p.ReleaseError,'GATEWAY_SOURCE_CHANGED'):self.verify(manifest)
        path.write_bytes(raw)
        after=self.gateway_root/p.GATEWAY_AFTER;after.write_text(self.gateway_after+'# unreviewed change\n')
        with self.assertRaisesRegex(p.ReleaseError,'GATEWAY_QUALIFICATION_INVALID'):self.verify(manifest)

    def test_gateway_missing_symlink_and_unreviewed_baseline_fail_closed(self):
        for name in (p.GATEWAY_BEFORE,p.GATEWAY_AFTER,p.GATEWAY_QUALIFICATION,'deploy/kubernetes/render.py'):
            path=self.gateway_root/name;raw=path.read_bytes();path.unlink()
            with self.subTest(name=name),self.assertRaisesRegex(p.ReleaseError,'GATEWAY_SOURCE_UNAVAILABLE'):self.manifest()
            other=path.with_name(path.name+'.copied');other.write_bytes(raw);path.symlink_to(other)
            with self.subTest(name=name,symlink=True),self.assertRaisesRegex(p.ReleaseError,'GATEWAY_SOURCE_UNAVAILABLE'):self.manifest()
            path.unlink();path.write_bytes(raw)
        baseline=self.gateway_root/p.GATEWAY_BEFORE;baseline.write_text(baseline.read_text()+'# changed\n')
        with self.assertRaisesRegex(p.ReleaseError,'GATEWAY_BASELINE_CHANGED'):self.manifest()

    def test_managed_atomic_batch_replay_drift_and_fault_rollback(self):
        self.managed_atomic_batch_cases()

    def test_storage_columns_reject_direct_service_and_public_grants(self):
        self.managed_atomic_batch_cases(column_acl_only=True)

    def managed_atomic_batch_cases(self,column_acl_only=False):
        manifest=self.manifest();sources=self.verify(manifest)
        def script(sources=sources):return p.migration_script(manifest,sources).replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'")
        cases=[
          ('UPDATE public.release_preserved_fixture SET attempts=0;','DELIVERY_RELEASE_EXISTING_ROWS_CHANGED'),
          ('DELETE FROM app_private.release_private_fixture;','DELIVERY_RELEASE_EXISTING_ROWS_CHANGED'),
          ('GRANT SELECT ON public.release_preserved_fixture TO tdp_app_authenticated;','DELIVERY_RELEASE_EXISTING_AUTHORITY_CHANGED'),
          ('GRANT SELECT(id) ON public.release_preserved_fixture TO tdp_app_authenticated;','DELIVERY_RELEASE_EXISTING_AUTHORITY_CHANGED'),
          ('DROP FUNCTION public.export_render_context(uuid,uuid);','DELIVERY_RELEASE_FINAL_RPC_MISSING'),
          ('GRANT EXECUTE ON FUNCTION public.export_render_context(uuid,uuid) TO tdp_app_authenticated;','DELIVERY_RELEASE_FINAL_RPC_AUTHORITY_INVALID'),
          ('REVOKE EXECUTE ON FUNCTION public.export_package_context(uuid) FROM tdp_app_authenticated;','DELIVERY_RELEASE_FINAL_RPC_AUTHORITY_INVALID'),
          ('GRANT EXECUTE ON FUNCTION app_private.ensure_issuance_file_capacity(uuid,uuid) TO tdp_app_anon;','DELIVERY_RELEASE_FINAL_PRIVATE_AUTHORITY_INVALID'),
          ('DROP FUNCTION app_private.app_command_before_current_issuance_contract(text,jsonb,text);','DELIVERY_RELEASE_FINAL_PRIVATE_CONTRACT_MISSING'),
          ('GRANT SELECT(id) ON public.export_packages TO tdp_app_authenticated;','DELIVERY_RELEASE_EXPORT_TABLE_AUTHORITY_INVALID'),
          ('ALTER TABLE public.export_package_volumes DISABLE ROW LEVEL SECURITY;','DELIVERY_RELEASE_EXPORT_TABLE_AUTHORITY_INVALID'),
          ('ALTER TABLE public.proposal_issuance_requests ALTER COLUMN reserved_file_bytes DROP NOT NULL;','DELIVERY_RELEASE_CAPACITY_CONTRACT_INVALID'),
          ('ALTER TABLE public.proposal_issuance_requests DISABLE TRIGGER issuance_capacity_guard;','DELIVERY_RELEASE_CAPACITY_CONTRACT_INVALID'),
          ('DROP FUNCTION app_private.document_render_slot_available();','DELIVERY_RELEASE_RENDER_ADMISSION_INVALID'),
          ('GRANT EXECUTE ON FUNCTION app_private.document_render_slot_available() TO tdp_app_service;','DELIVERY_RELEASE_RENDER_ADMISSION_AUTHORITY_INVALID'),
          ('DROP INDEX public.jobs_active_document_render;','DELIVERY_RELEASE_RENDER_ADMISSION_INVALID'),
          ('DROP INDEX public.one_active_non_render_job_per_workspace;','DELIVERY_RELEASE_RENDER_ADMISSION_INVALID'),
          ("DELETE FROM public.storage_write_intents WHERE storage_key='synthetic/census-pending';",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("INSERT INTO public.storage_write_intents(workspace_id,storage_key,state) VALUES('00000000-0000-4000-8000-000000000099','synthetic/extra','legacy_unfenced');",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET storage_key='synthetic/forged' WHERE storage_key='synthetic/census-pending';",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET state='unstarted';",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET revision=2;",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET expected_hash=repeat('a',64),expected_size=1;",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET state='unknown',expected_hash=repeat('a',64),expected_size=1,started_at=clock_timestamp();",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET observed_at=clock_timestamp();",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET send_closed_at=clock_timestamp();",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET state='quiesced',retirement_receipt='{}';",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("UPDATE public.storage_write_intents SET created_at='2000-01-01';",'DELIVERY_RELEASE_STORAGE_CENSUS_INVALID'),
          ("CREATE TABLE app_private.forbidden_release_seed(value integer);INSERT INTO app_private.forbidden_release_seed VALUES(1);",'DELIVERY_RELEASE_UNREQUESTED_NEW_ROWS'),
          ("INSERT INTO app_private.storage_retirement_batches(operation_nonce,workspace_id,actor_id,scope,scope_sha256) VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'[]',repeat('a',64));",'DELIVERY_RELEASE_UNREQUESTED_NEW_ROWS'),
          ('DROP FUNCTION public.begin_render_storage_write(uuid,uuid,text,text,bigint);','DELIVERY_RELEASE_STORAGE_RPC_MISSING'),
          ('GRANT EXECUTE ON FUNCTION public.begin_render_storage_write(uuid,uuid,text,text,bigint) TO tdp_app_authenticated;','DELIVERY_RELEASE_STORAGE_RPC_AUTHORITY_INVALID'),
          ('GRANT EXECUTE ON FUNCTION app_private.finish_storage_write_retirement(uuid,uuid,jsonb) TO tdp_app_service;','DELIVERY_RELEASE_STORAGE_PRIVATE_AUTHORITY_INVALID'),
          ('GRANT SELECT(storage_key) ON public.storage_write_intents TO tdp_app_authenticated;','DELIVERY_RELEASE_STORAGE_TABLE_AUTHORITY_INVALID'),
          ('ALTER TABLE app_private.storage_retirement_keys DISABLE ROW LEVEL SECURITY;','DELIVERY_RELEASE_STORAGE_TABLE_AUTHORITY_INVALID'),
          ('ALTER TABLE public.proposal_delivery_artifacts DISABLE TRIGGER register_delivery_storage_write;','DELIVERY_RELEASE_STORAGE_CONTRACT_INVALID'),

        ]
        if column_acl_only:
            cases=[
              (f'GRANT SELECT({column}) ON {table} TO {role};','DELIVERY_RELEASE_STORAGE_TABLE_AUTHORITY_INVALID')
              for table,column in (('public.storage_write_intents','storage_key'),
                ('app_private.storage_retirement_batches','operation_nonce'),
                ('app_private.storage_retirement_keys','storage_key'))
              for role in ('tdp_app_service','PUBLIC')]
        program="process.on('uncaughtException',e=>{console.error(e.message,e.code,e.position,e.where);process.exit(1)});\nconst release="+json.dumps(script())+';const variants='+json.dumps([(script(sources[:-1]+[sources[-1]+'\n'+s]),code) for s,code in cases])+';\n'
        program+='const baseline='+json.dumps(manifest['baseline_releases'])+';const catalogQuery='+json.dumps(p.CATALOG.replace(' INTO catalog_hash',''))+';\n'
        program+=r"""
import {databaseWithMigrations} from './tests/backend/databaseFixture.ts';
const one=async(db,q)=>Object.values((await db.query(q)).rows[0])[0];
async function fixture(){
 const db=await databaseWithMigrations('20261103032000_model_admission_fairness.sql');
 await db.exec(`insert into public.workspaces(id,name) values('00000000-0000-4000-8000-000000000099','Synthetic retained storage census');
 insert into public.storage_cleanup_queue(workspace_id,storage_key,estimated_size,reason,status,attempts)
 values('00000000-0000-4000-8000-000000000099','synthetic/census-pending',123,'synthetic historical pending','pending',3),
 ('00000000-0000-4000-8000-000000000099','synthetic/census-done',17,'synthetic historical done','done',2);
 create table public.release_preserved_fixture(id int primary key,attempts int,receipt jsonb);
 insert into public.release_preserved_fixture values(1,7,'{"usage":null,"frozen":true,"budget":1}');
 create table app_private.release_private_fixture(id int primary key,receipt jsonb);
 insert into app_private.release_private_fixture values(1,'{"accepted_sibling":true}');
 create table app_private.application_release_history(release text primary key,migration_sha256 text not null,applied_at timestamptz default now());
 alter table app_private.application_release_history enable row level security;
 revoke all on app_private.application_release_history from public;
 create role tdp_app_owner nosuperuser nobypassrls nocreatedb nocreaterole;
 alter schema public owner to tdp_app_owner;alter schema app_private owner to tdp_app_owner;
 grant usage on schema auth to tdp_app_owner;grant select,references on auth.users,auth.identities to tdp_app_owner;
 DO $ownership$ DECLARE r record; BEGIN
 FOR r IN SELECT n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p','v','m') LOOP
 EXECUTE format('ALTER %s %I.%I OWNER TO tdp_app_owner',CASE WHEN r.relkind='v' THEN 'VIEW' WHEN r.relkind='m' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,r.nspname,r.relname);END LOOP;
 FOR r IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN ('public','app_private') AND p.prokind='f' LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO tdp_app_owner',r.signature);END LOOP;
 END $ownership$;
 ALTER ROLE anon RENAME TO tdp_app_anon;ALTER ROLE authenticated RENAME TO tdp_app_authenticated;
 ALTER ROLE service_role RENAME TO tdp_app_service;ALTER ROLE tdp_app_service NOBYPASSRLS;GRANT tdp_app_owner TO tdp_app_service;`);
 for(const [key,value] of Object.entries(baseline))await db.query('insert into app_private.application_release_history(release,migration_sha256) values($1,$2)',[key,value]);
 const hash=await one(db,catalogQuery);return {db,sql:s=>s.replace("catalog_hash<>'"+'0'.repeat(64)+"'","catalog_hash<>'"+hash+"'")};
}
const f=await fixture();
await f.db.exec(f.sql(release));await f.db.exec(f.sql(release));
if(await one(f.db,'select count(*)::int from app_private.application_release_history')!==8)throw Error('REPLAY_LEDGER');
if(await one(f.db,'select attempts from public.release_preserved_fixture')!==7)throw Error('OLD_ROW_CHANGED');
if(await one(f.db,'select count(*)::int from public.storage_write_intents')!==2)throw Error('LEGACY_CENSUS_MISSING');
if(await one(f.db,"select count(*)::int from public.storage_write_intents where state='legacy_unfenced' and revision=1 and expected_hash is null and expected_size is null and started_at is null and observed_at is null and send_closed_at is null and retirement_receipt is null")!==2)throw Error('LEGACY_CENSUS_FORGED');
await f.db.exec("update public.storage_write_intents set state='unknown',revision=2,expected_hash=repeat('a',64),expected_size=123,started_at=clock_timestamp() where storage_key='synthetic/census-pending'");
await f.db.exec("insert into app_private.storage_retirement_batches(operation_nonce,workspace_id,actor_id,scope,scope_sha256) values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'[]',repeat('a',64))");

await f.db.exec("insert into public.release_preserved_fixture values(2,4,'{\"post_release\":true}')");
await f.db.exec(f.sql(release));
if(await one(f.db,'select count(*)::int from public.release_preserved_fixture')!==2)throw Error('REPLAY_NEW_ROW_CHANGED');
if(await one(f.db,"select state from public.storage_write_intents where storage_key='synthetic/census-pending'")!=='unknown')throw Error('REPLAY_OPERATIONAL_STATE_CHANGED');
if(await one(f.db,'select count(*)::int from app_private.storage_retirement_batches')!==1)throw Error('REPLAY_RETIREMENT_HISTORY_CHANGED');

await f.db.exec("comment on function public.delivery_package(uuid) is 'does not affect function catalog';");
await f.db.exec(f.sql(release));
await f.db.exec("grant execute on function public.delivery_export_context(uuid,uuid) to tdp_app_authenticated");
let rejected=false;try{await f.db.exec(f.sql(release));}catch(e){rejected=e.message==='DELIVERY_RELEASE_POST_CATALOG_CHANGED';await f.db.exec('rollback');if(!rejected)throw e;}
if(!rejected)throw Error('POST_CATALOG_DRIFT_ACCEPTED');await f.db.close();
for(const [source,expected] of variants){
 const f=await fixture();let rejected=false;
 try{await f.db.exec(f.sql(source));}catch(e){rejected=e.message===expected;await f.db.exec('rollback');if(!rejected)throw e;}
 if(!rejected)throw Error('FAULT_ACCEPTED '+expected);
 if(await one(f.db,'select attempts from public.release_preserved_fixture')!==7)throw Error('FAULT_ROW_ESCAPED');
 if(await one(f.db,"select to_regclass('public.proposal_delivery_snapshots')")!==null)throw Error('FAULT_SCHEMA_ESCAPED');
 if(await one(f.db,'select count(*)::int from app_private.application_release_history')!==6)throw Error('FAULT_LEDGER_ESCAPED');
 await f.db.close();
}
for(const kind of ['catalog','ledger','partial','database']){
 const f=await fixture();let source=f.sql(release);let expected;
 if(kind==='catalog'){source=release;expected='DELIVERY_RELEASE_BASELINE_CHANGED';}
 if(kind==='ledger'){await f.db.exec("update app_private.application_release_history set migration_sha256=repeat('f',64) where release='prior-release-1'");expected='DELIVERY_RELEASE_LEDGER_CHANGED';}
 if(kind==='partial'){await f.db.exec("insert into app_private.application_release_history(release,migration_sha256) values('proposal-delivery-reliability-v1',repeat('f',64))");expected='DELIVERY_RELEASE_PARTIAL_RECEIPT';}
 if(kind==='database'){source=source.replace("current_database()<>'postgres'","current_database()<>'tenderdesk_app'");expected='DELIVERY_RELEASE_DATABASE_MISMATCH';}
 let denied=false;try{await f.db.exec(source);}catch(e){denied=e.message===expected;await f.db.exec('rollback');if(!denied)throw e;}
 if(!denied)throw Error('GUARD_ACCEPTED '+kind);await f.db.close();
}
"""
        result=subprocess.run(['node','--experimental-strip-types','--input-type=module'],input=program,text=True,capture_output=True,cwd=p.ROOT,timeout=240)
        self.assertEqual(result.returncode,0,result.stderr[-8000:])

if __name__=='__main__':unittest.main()
