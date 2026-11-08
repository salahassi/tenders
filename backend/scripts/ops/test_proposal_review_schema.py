"""Actual isolated PostgreSQL guards for the eighth additive schema child."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('tested_review_schema', HERE / 'proposal-review-schema.py')
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)


class ReviewSchemaTests(unittest.TestCase):
    def setUp(self):
        # Bind only the candidate bytes in this isolated test. Native product
        # acceptance and the operational source freeze remain separate gates.
        checksum = hashlib.sha256(m.SOURCE.read_bytes()).hexdigest()
        if m.SOURCE_SHA256 is not None:
            self.assertEqual(m.SOURCE_SHA256, checksum)
        bound = patch.object(m, 'SOURCE_SHA256', checksum)
        bound.start()
        self.addCleanup(bound.stop)

    def test_unfrozen_operational_source_is_rejected(self):
        with patch.object(m, 'SOURCE_SHA256', None), self.assertRaisesRegex(m.ReviewSchemaError, 'NOT_FROZEN'):
            m.source()

    def test_exact_source_fast_guard_and_read_only_modes(self):
        canonical = m.script(read_only=False)
        arbitrary = m.script(read_only=False, payload=m.source() + '\n-- fault injection\n')
        self.assertNotIn('md5(to_jsonb(x)::text)', canonical)
        self.assertIn('md5(to_jsonb(x)::text)', arbitrary)
        for sql in (canonical, arbitrary):
            self.assertIn('pg_stat_get_xact_tuples_inserted', sql)
            self.assertIn('pg_relation_filenode', sql)
            self.assertLess(sql.index('IF row_activity IS DISTINCT FROM row_activity_before'),
                            sql.index('INSERT INTO app_private.application_release_history'))
            self.assertIn("SET LOCAL statement_timeout='20s'", sql)
        for allow in (False, True):
            sql = m.script(read_only=True, allow_parent=allow)
            self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', sql)
            self.assertNotIn('$review_schema_payload$', sql)
            self.assertNotIn('INSERT INTO app_private.application_release_history', sql)
            self.assertNotIn('NOTIFY pgrst', sql)
            self.assertIn(m.PARENT_CATALOG, sql)
            self.assertIn(m.PARENT_STRUCTURE, sql)
        with self.assertRaises(m.ReviewSchemaError):
            m.script(read_only=False, allow_parent=True)

    def test_exact_ancestry_source_and_fixed_diagnostics(self):
        self.assertEqual(m.parent.source_sha256(), m.PARENT_SQL)
        self.assertEqual(m.source_sha256(), hashlib.sha256(m.SOURCE.read_bytes()).hexdigest())
        self.assertEqual(len(m.predecessors()), 22)
        self.assertEqual(len(dict(m.predecessors())), 22)
        self.assertEqual(m.predecessors()[:-3], m.parent.predecessors())
        self.assertEqual(m.predecessors()[-3:], [(m.parent.RELEASE, m.PARENT_SQL),
            (m.parent.RELEASE + '-catalog', m.PARENT_CATALOG),
            (m.parent.RELEASE + '-structure', m.PARENT_STRUCTURE)])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'migration.sql'
            path.write_text(m.source() + '\n-- changed\n')
            with patch.object(m, 'SOURCE', path), self.assertRaisesRegex(m.ReviewSchemaError, 'SOURCE_CHANGED'):
                m.source()
        for stderr, code in [
            ('ERROR:  57014: private payload', 'REVIEW_SCHEMA_SQLSTATE_57014'),
            ('ERROR:  P0001: REVIEW_SCHEMA_EXISTING_ROWS_CHANGED\nDETAIL: private payload',
             'REVIEW_SCHEMA_EXISTING_ROWS_CHANGED'),
            ('private transport payload', 'REVIEW_SCHEMA_SQL_TRANSPORT_FAILED'),
        ]:
            self.assertEqual(m.sql_error_code(stderr), code)

    def test_full_schema_atomic_apply_replay_and_fault_matrix(self):
        local = lambda sql: sql.replace("current_database()<>'tenderdesk_app'", "current_database()<>'postgres'")
        prefix = 'REVIEW_SCHEMA_'
        variants = [
            ('UPDATE public.preserved_job SET attempts=0;', 'EXISTING_ROWS_CHANGED'),
            ('DELETE FROM public.preserved_job;', 'EXISTING_ROWS_CHANGED'),
            ('INSERT INTO public.preserved_job VALUES(2,0);', 'EXISTING_ROWS_CHANGED'),
            ('TRUNCATE public.preserved_job;', 'EXISTING_ROWS_CHANGED'),
            ("UPDATE app_private.application_release_history SET applied_at=now()+interval '1 second';", 'EXISTING_ROWS_CHANGED'),
            ("DELETE FROM app_private.application_release_history WHERE release=" + m.base.literal(m.parent.RELEASE) + ';', 'EXISTING_ROWS_CHANGED'),
            ('GRANT SELECT ON public.preserved_job TO tdp_app_authenticated;', 'EXISTING_STRUCTURE_CHANGED'),
            ('ALTER TABLE public.preserved_job ADD COLUMN unreviewed text;', 'UNEXPECTED_ADDITION'),
            ('CREATE TABLE public.unreviewed(id int);', 'UNEXPECTED_ADDITION'),
            ("CREATE FUNCTION public.unreviewed() RETURNS int LANGUAGE sql AS 'SELECT 1';", 'UNEXPECTED_ADDITION'),
            ("CREATE OR REPLACE FUNCTION app_private.model_graph_checkpoint_report_ref(stored jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$BEGIN RETURN 'unreviewed';END$$;", 'EXISTING_STRUCTURE_CHANGED'),
            # Attributes of every approved body change remain exact.
            *[('ALTER FUNCTION ' + target + ' STRICT;', 'EXISTING_ROUTINES_CHANGED') for target in m.CHANGED],
            ('ALTER FUNCTION ' + m.CHANGED[0] + ' IMMUTABLE;', 'EXISTING_ROUTINES_CHANGED'),
            ('GRANT EXECUTE ON FUNCTION ' + m.CHANGED[0] + ' TO authenticated;', 'EXISTING_STRUCTURE_CHANGED'),
            # The renamed delegate retains its OID and its normalized old body.
            ("CREATE OR REPLACE FUNCTION app_private.app_command_before_legacy_review_recovery(operation text,input jsonb,idempotency_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$BEGIN RETURN NULL;END$$;", 'EXISTING_ROUTINES_CHANGED'),
            ('ALTER FUNCTION ' + m.RENAMED_TO + ' RENAME TO unreviewed_delegate;', 'EXISTING_ROUTINES_CHANGED'),
            ('GRANT EXECUTE ON FUNCTION ' + m.RENAMED_TO + ' TO authenticated;', 'PRIVATE_AUTHORITY'),
            ('GRANT EXECUTE ON FUNCTION app_private.legacy_review_recovery_proof(uuid) TO public;', 'PRIVATE_AUTHORITY'),
            ('GRANT EXECUTE ON FUNCTION app_private.legacy_review_history(uuid,integer) TO tdp_app_service;', 'PRIVATE_AUTHORITY'),
            ('ALTER FUNCTION app_private.legacy_review_history(uuid,integer) IMMUTABLE;', 'ROUTINE_ATTRIBUTES'),
            ('ALTER FUNCTION app_private.legacy_review_base_current(public.generation_plans,uuid) SECURITY INVOKER;', 'ROUTINE_ATTRIBUTES'),
            ('ALTER TABLE public.jobs DISABLE TRIGGER ' + m.NEW_TRIGGER + ';', 'CAPABILITY_TRIGGER'),
            ('DROP TRIGGER ' + m.NEW_TRIGGER + ' ON public.jobs; CREATE TRIGGER ' + m.NEW_TRIGGER + ' BEFORE INSERT ON public.jobs FOR EACH ROW EXECUTE FUNCTION app_private.guard_legacy_review_worker_capability();', 'CAPABILITY_TRIGGER'),
            ('GRANT EXECUTE ON FUNCTION public.claim_backend_job_v7() TO authenticated;', 'PRIVATE_AUTHORITY'),
            ('REVOKE EXECUTE ON FUNCTION public.claim_backend_job_v7() FROM tdp_app_service;', 'RPC_AUTHORITY'),
            ('ALTER FUNCTION public.claim_backend_job_v7() SECURITY INVOKER;', 'ROUTINE_ATTRIBUTES'),
            ('GRANT SELECT ON ' + m.NEW_TABLE + ' TO service_role;', 'LINEAGE_AUTHORITY'),
            ('GRANT SELECT(input_hash) ON ' + m.NEW_TABLE + ' TO authenticated;', 'LINEAGE_AUTHORITY'),
            ('ALTER TABLE ' + m.NEW_TABLE + ' DISABLE ROW LEVEL SECURITY;', 'LINEAGE_AUTHORITY'),
            ('CREATE POLICY unreviewed ON ' + m.NEW_TABLE + ' TO authenticated USING(true);', 'LINEAGE_AUTHORITY'),
            ('ALTER VIEW ' + m.NEW_VIEW + ' SET(security_invoker=false);', 'LINEAGE_AUTHORITY'),
            ('ALTER TABLE ' + m.NEW_TABLE + ' DISABLE TRIGGER immutable_legacy_review_lineage;', 'LINEAGE_TRIGGER'),
            ('CREATE INDEX unreviewed_lineage ON ' + m.NEW_TABLE + '(created_at);', 'LINEAGE_STRUCTURE'),
            ('ALTER TABLE ' + m.NEW_TABLE + ' ALTER COLUMN input_hash DROP NOT NULL;', 'LINEAGE_STRUCTURE'),
            # No customer lineage may be populated by installation. The only
            # fixture FK is removed so this reaches the new-row guard itself.
            ('ALTER TABLE ' + m.NEW_TABLE + ' DROP CONSTRAINT legacy_zero_inventory_review_lineage_workspace_id_fkey;'
             'INSERT INTO ' + m.NEW_TABLE + '(workspace_id,plan_id,input_hash,frozen_context_hash,original_last_ordinal,'
             'predecessor_version_id,predecessor_version_hash,predecessor_sections_hash,predecessor_proposal_revision,'
             'predecessor_projection_job_id,predecessor_projection_job_hash,saved_history,review_job_id,review_step_id,'
             'review_input_hash,issuance_request_id,authorized_by,operation,idempotency_key_hash) '
             "VALUES(gen_random_uuid(),gen_random_uuid(),repeat('a',64),repeat('b',64),1,gen_random_uuid(),"
             "repeat('c',64),repeat('d',64),1,gen_random_uuid(),repeat('e',64),'{}',gen_random_uuid(),"
             "gen_random_uuid(),repeat('f',64),gen_random_uuid(),gen_random_uuid(),'generation.retry',repeat('a',64));", 'NEW_ROWS_CHANGED'),
        ]
        source = m.source()
        # Bind synthetic candidates only in this local test to exercise the
        # canonical activity/storage path, including writes with no net change.
        fast_faults = []
        for sql in (
            'UPDATE public.preserved_job SET attempts=attempts;',
            'INSERT INTO public.preserved_job VALUES(2,0);DELETE FROM public.preserved_job WHERE id=2;',
            'TRUNCATE public.preserved_empty;',
            'UPDATE app_private.application_release_history SET applied_at=applied_at;',
        ):
            with patch.object(m, 'source', return_value=source + '\n' + sql):
                generated = m.script(read_only=False)
            self.assertNotIn('md5(to_jsonb(x)::text)', generated)
            fast_faults.append((local(generated), prefix + 'EXISTING_ROWS_CHANGED'))
        data = {
            'ledger': m.predecessors(), 'parent_catalog': m.PARENT_CATALOG,
            'parent_structure': m.PARENT_STRUCTURE, 'parent_release': m.parent.RELEASE,
            'source_name': m.SOURCE.name, 'release_name': m.RELEASE,
            'catalog': m.base.CATALOG.replace(' INTO catalog_hash', ''),
            'structure': "DO $$DECLARE structure jsonb;BEGIN " + m.base.structure_snapshot(protected=False)
                + " PERFORM set_config('synthetic.structure',encode(sha256(convert_to(structure::text,'UTF8')),'hex'),false);END$$;",
            'apply': local(m.script(read_only=False)),
            'verify': local(m.script(read_only=True)),
            'parent': local(m.script(read_only=True, allow_parent=True)),
            'changed': local(m.script(read_only=False, payload=source + '\n-- changed checksum\n')),
            'variants': [(local(m.script(read_only=False, payload=source + '\n' + sql)), prefix + code)
                         for sql, code in variants] + fast_faults,
        }
        program = r"""
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
let input=''; for await(const part of process.stdin) input+=part;
const x=JSON.parse(input),db=new PGlite();
const one=async(sql)=>Object.values((await db.query(sql)).rows[0])[0];
try {
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
for(const name of(await readdir('supabase/migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)&&n<x.source_name).sort())
  await db.exec(await readFile('supabase/migrations/'+name,'utf8'));
await db.exec((await readFile('scripts/runtime/dispatcher.sql','utf8')).replaceAll(':"service_role"','"tdp_app_service"'));
await db.exec(`create table public.preserved_job(id int primary key,attempts int);insert into public.preserved_job values(1,7);
create table public.preserved_empty(id int primary key);
create table app_private.application_release_history(release text primary key,migration_sha256 text not null,applied_at timestamptz not null default now());
alter table app_private.application_release_history enable row level security;revoke all on app_private.application_release_history from public;`);
for(const[name,sha]of x.ledger)
  await db.query('insert into app_private.application_release_history(release,migration_sha256)values($1,$2)',[name,sha]);
const catalog=await one(x.catalog);
const currentStructure=async()=>{await db.exec(x.structure);return one("select current_setting('synthetic.structure')");};
const structure=await currentStructure();
const bind=s=>s.replaceAll(x.parent_catalog,catalog).replaceAll(x.parent_structure,structure);
await db.query('update app_private.application_release_history set migration_sha256=$1 where release=$2',[catalog,x.parent_release+'-catalog']);
await db.query('update app_private.application_release_history set migration_sha256=$1 where release=$2',[structure,x.parent_release+'-structure']);
const ledgerRows=async()=>one('select jsonb_agg(to_jsonb(h)order by release)::text from app_private.application_release_history h');
const rows=await ledgerRows();
const jobs=await one('select jsonb_agg(to_jsonb(j)order by id)::text from public.preserved_job j');
const reject=async(sql,code)=>{
  let got;
  try{await db.exec(bind(sql));}catch(e){got=e.message;await db.exec('rollback');}
  if(got!==code)throw Error('EXPECTED '+code+' GOT '+got);
};
const assertParentUnchanged=async()=>{
  if(await one(x.catalog)!==catalog||await currentStructure()!==structure||await ledgerRows()!==rows||
     await one('select jsonb_agg(to_jsonb(j)order by id)::text from public.preserved_job j')!==jobs||
     await one('select count(*)::int from public.preserved_empty')!==0)
    throw Error('FAILED_RELEASE_MUTATED_PARENT');
};
const corruptEveryAncestor=async()=>{
  for(const[name]of x.ledger){
    const original=await db.query('select migration_sha256 from app_private.application_release_history where release=$1',[name]);
    await db.query('update app_private.application_release_history set migration_sha256=$1 where release=$2',['0'.repeat(64),name]);
    await reject(x.parent,'REVIEW_SCHEMA_PARENT_LEDGER');
    await reject(x.apply,'REVIEW_SCHEMA_PARENT_LEDGER');
    await db.query('update app_private.application_release_history set migration_sha256=$1 where release=$2',[original.rows[0].migration_sha256,name]);
  }
};
await db.exec(bind(x.parent));await reject(x.verify,'REVIEW_SCHEMA_RELEASE_MISSING');
await corruptEveryAncestor();await assertParentUnchanged();
for(const[index,[sql,code]]of x.variants.entries()){
  try{await reject(sql,code);await assertParentUnchanged();}
  catch(error){throw Error('FAULT '+index+': '+error.message);}
}
await db.exec(bind(x.apply));await db.exec(bind(x.verify));
const childRows=await ledgerRows();await db.exec(bind(x.apply));
if(await ledgerRows()!==childRows||await one('select count(*)::int from app_private.application_release_history')!==25)
  throw Error('LEDGER_REPLAY');
const ancestors=await db.query('select jsonb_agg(to_jsonb(h)order by release)::text as rows from app_private.application_release_history h where release<>all($1::text[])',
  [[x.release_name,x.release_name+'-catalog',x.release_name+'-structure']]);
if(ancestors.rows[0].rows!==rows)throw Error('ANCESTRY_CHANGED');
await corruptEveryAncestor();
await reject(x.changed,'REVIEW_SCHEMA_SOURCE_CHANGED');
await db.exec('grant execute on function app_private.legacy_review_recovery_proof(uuid) to authenticated');
await reject(x.parent,'REVIEW_SCHEMA_POST_CATALOG_CHANGED');
await db.exec('revoke execute on function app_private.legacy_review_recovery_proof(uuid) from authenticated');
await db.exec(bind(x.verify));
await db.query('delete from app_private.application_release_history where release=$1',[x.release_name+'-catalog']);
await reject(x.parent,'REVIEW_SCHEMA_PARTIAL_RECEIPT');
console.log('review_atomic_guards_passed',x.variants.length);
} catch(error) {console.error(error.message);process.exitCode=1;}
finally {await db.close();}
"""
        result = subprocess.run(['node', '--input-type=module', '-e', program], input=json.dumps(data),
            capture_output=True, text=True, cwd=m.ROOT / 'backend', timeout=150)
        self.assertEqual(result.returncode, 0, result.stderr[-7000:])
        self.assertIn('review_atomic_guards_passed', result.stdout)


if __name__ == '__main__':
    unittest.main()
