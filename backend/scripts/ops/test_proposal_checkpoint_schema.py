"""Actual isolated PostgreSQL release guards; no hosted calls or business retry."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location('tested_checkpoint_schema',HERE/'proposal-checkpoint-schema.py')
m=importlib.util.module_from_spec(SPEC);sys.modules[SPEC.name]=m;SPEC.loader.exec_module(m)


class CheckpointSchemaTests(unittest.TestCase):
    def setUp(self):
        # A local synthetic proof binds the exact candidate bytes under test.
        # It does not freeze or authorize the operational SOURCE_SHA256.
        checksum=hashlib.sha256(m.SOURCE.read_bytes()).hexdigest()
        if m.SOURCE_SHA256 is not None:self.assertEqual(m.SOURCE_SHA256,checksum)
        bound=patch.object(m,'SOURCE_SHA256',checksum);bound.start();self.addCleanup(bound.stop)

    def test_unfrozen_operational_source_is_rejected(self):
        with patch.object(m,'SOURCE_SHA256',None),self.assertRaisesRegex(m.CheckpointSchemaError,'NOT_FROZEN'):m.source()

    def test_only_exact_source_uses_fast_guard_and_read_only_never_applies(self):
        canonical=m.script(read_only=False)
        fault=m.script(read_only=False,payload=m.source()+'\n-- fault\n')
        self.assertNotIn('md5(to_jsonb(x)::text)',canonical)
        self.assertIn('md5(to_jsonb(x)::text)',fault)
        for sql in (canonical,fault):
            self.assertIn('pg_stat_get_xact_tuples_inserted',sql)
            self.assertIn('pg_relation_filenode',sql)
            self.assertLess(sql.index('IF row_activity IS DISTINCT FROM row_activity_before'),sql.index('INSERT INTO app_private.application_release_history'))
            self.assertIn("SET LOCAL statement_timeout='20s'",sql)
        for allow in (False,True):
            sql=m.script(read_only=True,allow_parent=allow)
            self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;',sql)
            self.assertNotIn('$checkpoint_schema_payload$',sql)
            self.assertNotIn('INSERT INTO app_private.application_release_history',sql)
            self.assertNotIn('NOTIFY pgrst',sql)
            self.assertIn(m.PARENT_CATALOG,sql);self.assertIn(m.PARENT_STRUCTURE,sql)
        with self.assertRaises(m.CheckpointSchemaError):m.script(read_only=False,allow_parent=True)

    def test_exact_source_and_fixed_diagnostics(self):
        self.assertEqual(m.parent.source_sha256(),m.PARENT_SQL)
        self.assertEqual(m.source_sha256(),hashlib.sha256(m.SOURCE.read_bytes()).hexdigest())
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'migration.sql';path.write_text(m.source()+'\n-- changed\n')
            with patch.object(m,'SOURCE',path),self.assertRaisesRegex(m.CheckpointSchemaError,'SOURCE_CHANGED'):m.source()
        for stderr,code in [('ERROR:  57014: private payload','CHECKPOINT_SCHEMA_SQLSTATE_57014'),
            ('ERROR:  P0001: CHECKPOINT_SCHEMA_EXISTING_ROWS_CHANGED\nDETAIL: private payload','CHECKPOINT_SCHEMA_EXISTING_ROWS_CHANGED'),
            ('private transport payload','CHECKPOINT_SCHEMA_SQL_TRANSPORT_FAILED')]:
            self.assertEqual(m.sql_error_code(stderr),code)

    def test_full_schema_child_preserves_history_and_rejects_faults_atomically(self):
        local=lambda s:s.replace("current_database()<>'tenderdesk_app'","current_database()<>'postgres'")
        ledger=m.predecessors()
        variants=[
            ('UPDATE public.preserved_job SET attempts=0;','CHECKPOINT_SCHEMA_EXISTING_ROWS_CHANGED'),
            ('DELETE FROM public.preserved_job;','CHECKPOINT_SCHEMA_EXISTING_ROWS_CHANGED'),
            ('INSERT INTO public.preserved_job VALUES(2,0);','CHECKPOINT_SCHEMA_EXISTING_ROWS_CHANGED'),
            ('TRUNCATE public.preserved_job;','CHECKPOINT_SCHEMA_EXISTING_ROWS_CHANGED'),
            ("UPDATE app_private.application_release_history SET applied_at=now()+interval '1 second';",'CHECKPOINT_SCHEMA_EXISTING_ROWS_CHANGED'),
            ('GRANT SELECT ON public.preserved_job TO tdp_app_authenticated;','CHECKPOINT_SCHEMA_EXISTING_STRUCTURE_CHANGED'),
            ('ALTER TABLE public.preserved_job ADD COLUMN unreviewed text;','CHECKPOINT_SCHEMA_UNEXPECTED_ADDITION'),
            ('CREATE TABLE public.unreviewed(id int);','CHECKPOINT_SCHEMA_UNEXPECTED_ADDITION'),
            ("CREATE FUNCTION public.unreviewed() RETURNS int LANGUAGE sql AS 'SELECT 1';",'CHECKPOINT_SCHEMA_UNEXPECTED_ADDITION'),
            ('ALTER FUNCTION '+m.CHANGED+' IMMUTABLE;','CHECKPOINT_SCHEMA_COMMAND_ATTRIBUTES_CHANGED'),
            ('ALTER FUNCTION '+m.CHANGED+' STRICT;','CHECKPOINT_SCHEMA_COMMAND_ATTRIBUTES_CHANGED'),
            ('GRANT EXECUTE ON FUNCTION '+m.CHANGED+' TO authenticated;','CHECKPOINT_SCHEMA_EXISTING_STRUCTURE_CHANGED'),
            ('GRANT EXECUTE ON FUNCTION '+m.ADDED+' TO authenticated;','CHECKPOINT_SCHEMA_HELPER_AUTHORITY'),
            ('GRANT EXECUTE ON FUNCTION '+m.ADDED+' TO public;','CHECKPOINT_SCHEMA_HELPER_AUTHORITY'),
            ('GRANT EXECUTE ON FUNCTION '+m.ADDED+' TO tdp_app_service;','CHECKPOINT_SCHEMA_HELPER_AUTHORITY'),
            ('ALTER FUNCTION '+m.ADDED+' SECURITY DEFINER;','CHECKPOINT_SCHEMA_HELPER_ATTRIBUTES'),
            ('ALTER FUNCTION '+m.ADDED+' VOLATILE;','CHECKPOINT_SCHEMA_HELPER_ATTRIBUTES'),
            ('ALTER FUNCTION '+m.ADDED+' STRICT;','CHECKPOINT_SCHEMA_HELPER_ATTRIBUTES'),
            ('ALTER FUNCTION '+m.ADDED+' PARALLEL SAFE;','CHECKPOINT_SCHEMA_HELPER_ATTRIBUTES'),
        ]
        data={'ledger':ledger,'parent_catalog':m.PARENT_CATALOG,'parent_structure':m.PARENT_STRUCTURE,'parent_release':m.parent.RELEASE,
            'source_name':m.SOURCE.name,'release_name':m.RELEASE,
            'catalog':m.base.CATALOG.replace(' INTO catalog_hash',''),
            'structure':"DO $$DECLARE structure jsonb;BEGIN "+m.base.structure_snapshot(protected=False)+" PERFORM set_config('synthetic.structure',encode(sha256(convert_to(structure::text,'UTF8')),'hex'),false);END$$;",
            'apply':local(m.script(read_only=False)),'verify':local(m.script(read_only=True)),
            'parent':local(m.script(read_only=True,allow_parent=True)),
            'changed':local(m.script(read_only=False,payload=m.source()+'\n-- changed checksum\n')),
            'variants':[(local(m.script(read_only=False,payload=m.source()+'\n'+sql)),code) for sql,code in variants]}
        program=r"""
import{PGlite}from'@electric-sql/pglite';import{readFile,readdir}from'node:fs/promises';let input='';for await(const part of process.stdin)input+=part;
const x=JSON.parse(input),db=new PGlite(),one=async(sql)=>Object.values((await db.query(sql)).rows[0])[0];
await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
create role tdp_app_owner nosuperuser nocreatedb nocreaterole nobypassrls;
create role tdp_app_anon;create role tdp_app_authenticated;create role tdp_app_service;
grant create on database postgres to tdp_app_owner;alter schema public owner to tdp_app_owner;
set role tdp_app_owner;create schema auth;create schema storage;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create table auth.identities(user_id uuid,provider text,identity_data jsonb);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
alter table storage.objects enable row level security;grant usage on schema storage to authenticated;grant insert,select on storage.objects to authenticated;`);
for(const name of(await readdir('supabase/migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)&&n<x.source_name).sort())await db.exec(await readFile('supabase/migrations/'+name,'utf8'));
await db.exec((await readFile('scripts/runtime/dispatcher.sql','utf8')).replaceAll(':"service_role"','"tdp_app_service"'));
await db.exec(`create table public.preserved_job(id int primary key,attempts int);insert into public.preserved_job values(1,7);
create table app_private.application_release_history(release text primary key,migration_sha256 text not null,applied_at timestamptz not null default now());
alter table app_private.application_release_history enable row level security;revoke all on app_private.application_release_history from public;`);
for(const[name,sha]of x.ledger)await db.query('insert into app_private.application_release_history(release,migration_sha256)values($1,$2)',[name,sha]);
const catalog=await one(x.catalog);await db.exec(x.structure);const structure=await one("select current_setting('synthetic.structure')");
const bind=s=>s.replaceAll(x.parent_catalog,catalog).replaceAll(x.parent_structure,structure);
await db.query('update app_private.application_release_history set migration_sha256=$1 where release=$2',[catalog,x.parent_release+'-catalog']);
await db.query('update app_private.application_release_history set migration_sha256=$1 where release=$2',[structure,x.parent_release+'-structure']);
const rows=await one('select jsonb_agg(to_jsonb(h)order by release)::text from app_private.application_release_history h');
const reject=async(sql,code)=>{let got;try{await db.exec(bind(sql));}catch(e){got=e.message;await db.exec('rollback');}if(got!==code)throw Error('EXPECTED '+code+' GOT '+got);};
await db.exec(bind(x.parent));await reject(x.verify,'CHECKPOINT_SCHEMA_RELEASE_MISSING');
for(const[name]of x.ledger){const original=await db.query('select migration_sha256 from app_private.application_release_history where release=$1',[name]);
 await db.query('update app_private.application_release_history set migration_sha256=$1 where release=$2',['0'.repeat(64),name]);
 await reject(x.parent,'CHECKPOINT_SCHEMA_PARENT_LEDGER');
 await db.query('update app_private.application_release_history set migration_sha256=$1 where release=$2',[original.rows[0].migration_sha256,name]);}
for(const[sql,code]of x.variants){await reject(sql,code);if(await one(x.catalog)!==catalog||await one('select attempts from preserved_job')!==7)throw Error('FAILED_RELEASE_MUTATED_PARENT');}
await db.exec(bind(x.apply));await db.exec(bind(x.verify));await db.exec(bind(x.apply));
if(await one('select count(*)::int from app_private.application_release_history')!==22)throw Error('LEDGER_REPLAY');
if(await one("select jsonb_agg(to_jsonb(h)order by release)::text from app_private.application_release_history h where release not like 'proposal-checkpoint-report-ref%'")!==rows)throw Error('ANCESTRY_CHANGED');
await reject(x.changed,'CHECKPOINT_SCHEMA_SOURCE_CHANGED');
await db.exec('grant execute on function app_private.model_graph_checkpoint_report_ref(jsonb) to authenticated');
await reject(x.parent,'CHECKPOINT_SCHEMA_POST_CATALOG_CHANGED');
await db.exec('revoke execute on function app_private.model_graph_checkpoint_report_ref(jsonb) from authenticated');
await db.exec(bind(x.verify));
await db.query('delete from app_private.application_release_history where release=$1',[x.release_name+'-catalog']);
await reject(x.parent,'CHECKPOINT_SCHEMA_PARTIAL_RECEIPT');await db.close();console.log('checkpoint_atomic_guards_passed');
"""
        result=subprocess.run(['node','--input-type=module','-e',program],input=json.dumps(data),capture_output=True,text=True,cwd=m.ROOT/'backend',timeout=150)
        self.assertEqual(result.returncode,0,result.stderr[-7000:]);self.assertIn('checkpoint_atomic_guards_passed',result.stdout)

if __name__=='__main__':unittest.main()
