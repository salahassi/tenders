"""Exact source, real SQL rollback/replay, private row and authority invariants."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SPEC=importlib.util.spec_from_file_location('tested_delivery_release',Path(__file__).with_name('proposal-delivery-release.py'))
p=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=p;SPEC.loader.exec_module(p)

class DeliveryReleaseTests(unittest.TestCase):
    def inventory(self):
        return {'version':1,'namespace':'tenderdesk-dev','ready_workloads':10,'inventory':'captured',
          'bootstrap_run':False,'business_mutations':0,'schema_mutations':0,'models_called':0,'temporary_client_cleanup_verified':True,
          'workloads':[{'name':name,'image':'registry.example/runtime@sha256:'+'a'*64} for name in ('api','worker','frontend','auth','rest','storage','source-browser','scheduler','gateway','https')],
          'native_schedules':[{'name':name,'image':'registry.digitalocean.com/tenderdesk-a6093a76/'+name.removeprefix('native-')+'@sha256:'+'a'*64,'schedule':'*/10 * * * *','container_identity_recognized':True,'concurrency_policy':'Forbid','concurrency_policy_explicit':True,'suspended':False,'suspend_explicit':True,'active_deadline_seconds':600,'backoff_limit':0,'effective_backoff_limit':0,'resources':{'requests':None,'limits':None},'generation':1} for name in ('native-browser','native-ocr')],
          'schema':{'routine_catalog_sha256':'0'*64,'canonical_migrations':None,'release_history':[
            {'release':'prior-release-'+str(i),'migration_sha256':str(i)*64} for i in range(1,7)]}}

    def manifest(self):
        return p.freeze(self.inventory())

    def test_every_final_contract_is_required_before_freezing(self):
        manifest=self.manifest()
        self.assertEqual(len(p.REQUIRED),20)
        self.assertEqual({key:manifest[key] for key in p.CAPABILITIES},p.CAPABILITIES)
        with self.assertRaises(p.ReleaseError):p.freeze({'receipt':self.inventory()})
        with tempfile.TemporaryDirectory() as directory:
            folder=Path(directory)
            for row in manifest['migrations']:
                (folder/row['name']).write_bytes((p.ROOT/'supabase/migrations'/row['name']).read_bytes())
            for name in p.REQUIRED:
                path=folder/name;data=path.read_bytes();path.unlink()
                with self.subTest(name=name),self.assertRaisesRegex(p.ReleaseError,'MIGRATION_MISSING'):
                    p.freeze(self.inventory(),migrations=folder)
                path.write_bytes(data)

    def test_final_capabilities_cannot_be_downgraded_or_coerced(self):
        for key,value in (('executor_max',3),('minimum_worker_executor',0),('renderer_versions',[1,2]),
          ('ordinary_renderer_version','ordinary-1'),('current_proposal_issuance_contract',True),
          ('issuance_file_capacity_version',0),('global_renderer_limit',2)):
            manifest=self.manifest();manifest[key]=value
            with self.subTest(key=key),self.assertRaisesRegex(p.ReleaseError,'CAPABILITY_SOURCE_MISMATCH'):
                p.verify_source(manifest)

    def test_source_set_and_bytes_are_frozen(self):
        manifest=self.manifest();self.assertGreaterEqual(len(p.verify_source(manifest)),6)
        for mutate in (lambda m:m['migrations'].pop(),lambda m:m['migrations'][0].update(sha256='f'*64),
          lambda m:m['migrations'][0].update(name='../unexpected.sql'),lambda m:m.update(release='another'),lambda m:m['baseline_native_schedules'].pop()):
            changed=copy.deepcopy(manifest);mutate(changed)
            with self.assertRaises(p.ReleaseError):p.verify_source(changed)
        with tempfile.TemporaryDirectory() as directory:
            for row in manifest['migrations']:
                (Path(directory)/row['name']).write_bytes((p.ROOT/'supabase/migrations'/row['name']).read_bytes())
            (Path(directory)/'20261104999999_unreviewed.sql').write_text('select 1;')
            with self.assertRaisesRegex(p.ReleaseError,'SET_CHANGED'):p.verify_source(manifest,migrations=Path(directory))

    def test_managed_atomic_batch_replay_drift_and_fault_rollback(self):
        manifest=self.manifest();sources=p.verify_source(manifest)
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
        ]
        program="process.on('uncaughtException',e=>{console.error(e.message,e.code,e.position,e.where);process.exit(1)});\nconst release="+json.dumps(script())+';const variants='+json.dumps([(script(sources[:-1]+[sources[-1]+'\n'+s]),code) for s,code in cases])+';\n'
        program+='const baseline='+json.dumps(manifest['baseline_releases'])+';const catalogQuery='+json.dumps(p.CATALOG.replace(' INTO catalog_hash',''))+';\n'
        program+=r"""
import {databaseWithMigrations} from './tests/backend/databaseFixture.ts';
const one=async(db,q)=>Object.values((await db.query(q)).rows[0])[0];
async function fixture(){
 const db=await databaseWithMigrations('20261103032000_model_admission_fairness.sql');
 await db.exec(`create table public.release_preserved_fixture(id int primary key,attempts int,receipt jsonb);
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
await f.db.exec("insert into public.release_preserved_fixture values(2,4,'{\"post_release\":true}')");
await f.db.exec(f.sql(release));
if(await one(f.db,'select count(*)::int from public.release_preserved_fixture')!==2)throw Error('REPLAY_NEW_ROW_CHANGED');
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
