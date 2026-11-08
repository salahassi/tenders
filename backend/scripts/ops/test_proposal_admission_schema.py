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


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec);sys.modules[name] = value;spec.loader.exec_module(value)
    return value


m = module('tested_admission_schema', 'proposal-admission-schema.py')
old = module('latency_dispatch_fixture', 'test_proposal_dispatch_schema.py')


class AdmissionSchemaTests(unittest.TestCase):
    def test_only_frozen_payload_skips_full_customer_value_hashing(self):
        canonical = m.script(read_only=False)
        arbitrary = m.script(read_only=False, payload=m.source()+'\n-- explicit fault payload\n')
        self.assertNotIn('md5(to_jsonb(x)::text)', canonical)
        self.assertIn('md5(to_jsonb(x)::text)', arbitrary)
        for sql in (canonical, arbitrary):
            self.assertIn('pg_stat_get_xact_tuples_inserted', sql)
            self.assertIn('pg_relation_filenode', sql)
            self.assertLess(sql.index('IF row_activity IS DISTINCT FROM row_activity_before'),
                sql.index('INSERT INTO app_private.application_release_history'))
            self.assertIn("SET LOCAL statement_timeout='20s'", sql)

    def test_fast_activity_guard_itself_rejects_dml_truncate_and_reset_attempts(self):
        # This matrix contains no full-row digest. It directly executes the
        # exact production activity/storage proof against actual PostgreSQL.
        mutations = {
            'insert': "INSERT INTO saved VALUES(3,'new');",
            'update': "UPDATE saved SET body='changed' WHERE id=1;",
            'same_value_update': 'UPDATE saved SET body=body WHERE id=1;',
            'delete': 'DELETE FROM saved WHERE id=1;',
            'delete_reinsert': "DELETE FROM saved WHERE id=1;INSERT INTO saved VALUES(1,'saved');",
            'insert_delete': "INSERT INTO saved VALUES(3,'new');DELETE FROM saved WHERE id=3;",
            'swap': "UPDATE saved SET body=CASE id WHEN 1 THEN 'other' ELSE 'saved' END;",
            'truncate': 'TRUNCATE saved;',
            'truncate_reinsert': "TRUNCATE saved;INSERT INTO saved VALUES(1,'saved'),(2,'other');",
            'subtransaction_commit': "DO $nested$BEGIN UPDATE saved SET body='nested' WHERE id=1;END$nested$;",
            'subtransaction_abort': "DO $nested$BEGIN UPDATE saved SET body='nested' WHERE id=1;RAISE EXCEPTION 'rollback';EXCEPTION WHEN OTHERS THEN NULL;END$nested$;",
            'hidden_function_dml': 'PERFORM hidden_write();',
            'clear_snapshot': "UPDATE saved SET body='changed' WHERE id=1;PERFORM pg_stat_clear_snapshot();",
            'reset_shared_stats': "UPDATE saved SET body='changed' WHERE id=1;PERFORM pg_stat_reset_single_table_counters('saved'::regclass);",
            'partition_leaf': "INSERT INTO partitioned VALUES(1,'leaf');",
        }
        template = """BEGIN ISOLATION LEVEL REPEATABLE READ;
DO $guard$
DECLARE relations_before oid[];row_activity jsonb;row_activity_before jsonb;
BEGIN
 SELECT array_agg(c.oid) INTO relations_before FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname IN ('public','app_private');
 __GUARD__ row_activity_before:=row_activity;
 __MUTATION__
 __GUARD__
 IF row_activity IS DISTINCT FROM row_activity_before
 THEN RAISE EXCEPTION 'ADMISSION_SCHEMA_EXISTING_ROWS_CHANGED';END IF;
END $guard$;COMMIT;""".replace('__GUARD__',m.ROW_ACTIVITY)
        data = {'cases': {key:template.replace('__MUTATION__',sql) for key,sql in mutations.items()},
            'noop':template.replace('__MUTATION__','PERFORM 1;'),
            'off':template.replace('__MUTATION__','PERFORM 1;').replace('DO $guard$',"SET LOCAL track_counts=off;DO $guard$",1)}
        program = r"""
import {PGlite} from '@electric-sql/pglite';let input='';for await(const part of process.stdin)input+=part;
const x=JSON.parse(input),db=new PGlite();
await db.exec(`create table saved(id int primary key,body text);insert into saved values(1,'saved'),(2,'other');
create table partitioned(id int,body text) partition by range(id);create table leaf partition of partitioned for values from(0) to(10);
create function hidden_write() returns void language plpgsql as $$begin update saved set body='hidden' where id=1;end$$;`);
const reject=async(sql,code)=>{let found;try{await db.exec(sql);}catch(e){found=e.message;await db.exec('rollback');}if(found!==code)throw Error('EXPECTED '+code+' GOT '+found);};
for(const [name,sql]of Object.entries(x.cases)){await reject(sql,'ADMISSION_SCHEMA_EXISTING_ROWS_CHANGED');}
await reject(x.off,'ADMISSION_SCHEMA_ROW_TRACKING_DISABLED');await db.exec(x.noop);
if(JSON.stringify((await db.query('select * from saved order by id')).rows)!==JSON.stringify([{id:1,body:'saved'},{id:2,body:'other'}]))throw Error('MUTATION_ESCAPED');
await db.close();console.log('direct_fast_guard_cases='+Object.keys(x.cases).length);
"""
        result = subprocess.run(['node','--input-type=module','-e',program],input=json.dumps(data),
            capture_output=True,text=True,cwd=m.ROOT/'backend',timeout=30)
        self.assertEqual(result.returncode,0,result.stderr[-3000:])
        self.assertIn('direct_fast_guard_cases=15',result.stdout)

    def test_unreviewed_source_bytes_cannot_be_applied_or_inspected(self):
        with tempfile.TemporaryDirectory() as directory:
            changed = Path(directory) / 'migration.sql'
            changed.write_bytes(m.SOURCE.read_bytes() + b'\n-- unreviewed\n')
            with patch.object(m, 'SOURCE', changed), self.assertRaisesRegex(m.AdmissionSchemaError, 'SOURCE_CHANGED'):
                m.source_sha256()

    def test_source_and_parent_are_bound_and_read_only_never_applies(self):
        self.assertEqual(m.source_sha256(), hashlib.sha256(m.SOURCE.read_bytes()).hexdigest())
        self.assertEqual(m.parent.source_sha256(), m.PARENT_SQL)
        for allow in (True, False):
            sql = m.script(read_only=True, allow_parent=allow)
            self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', sql)
            self.assertNotIn('INSERT INTO app_private.application_release_history', sql)
            self.assertNotIn('$admission_schema_payload$', sql)
            self.assertIn(m.PARENT_CATALOG, sql)
            self.assertIn(m.parent.PARENT_CATALOG, sql)
            self.assertIn(m.PARENT_STRUCTURE, sql)
        with self.assertRaises(m.AdmissionSchemaError):
            m.script(read_only=False, allow_parent=True)

    def test_diagnostics_never_return_sql_or_customer_text(self):
        cases = [
            ('ERROR:  P0001: ADMISSION_SCHEMA_PARENT_CATALOG\nCONTEXT: private text', 'ADMISSION_SCHEMA_PARENT_CATALOG'),
            ('ERROR:  P0001: PROPOSAL_ADMISSION_WAKE_CONTRACT_CHANGED\nDETAIL: private text', 'PROPOSAL_ADMISSION_WAKE_CONTRACT_CHANGED'),
            ('ERROR:  P0001: RETRY_SCHEMA_HELPER_AUTHORITY\nDETAIL: private text', 'RETRY_SCHEMA_HELPER_AUTHORITY'),
            ('ERROR:  57014: private text', 'ADMISSION_SCHEMA_SQLSTATE_57014'),
            ('private transport error', 'ADMISSION_SCHEMA_SQL_TRANSPORT_FAILED'),
        ]
        for raw, expected in cases:
            self.assertEqual(m.sql_error_code(raw), expected)

    def test_atomic_four_level_chain_preserves_rows_attributes_and_authority(self):
        guard = """if exists(select 1 from public.provider_usage where workspace_id=w and (
  state='reserved' or (state='unknown' and not exists(select 1 from public.model_routing where workspace_id=w and enabled))
 )) then raise exception 'USAGE_REVIEW_REQUIRED';end if;"""
        setup = """
create role tdp_app_owner nosuperuser nocreatedb nocreaterole nobypassrls;
create role tdp_app_service;create role tdp_app_authenticated;create role tdp_app_anon;
grant tdp_app_owner to tdp_app_service;
alter schema public owner to tdp_app_owner;create schema app_private authorization tdp_app_owner;
set role tdp_app_owner;set search_path=public;
create table operations(scheduler_enabled boolean);insert into operations values(false);
create table preserved_job(id int primary key,attempts int,payload jsonb);
insert into preserved_job values(1,7,'{"saved":true,"accounting":"retained"}');
create table generation_plans(id uuid,workspace_id uuid,created_at timestamptz);
create table jobs(id uuid,workspace_id uuid,entity_id uuid,checkpoint jsonb,next_attempt_at timestamptz);
create table model_execution_settings(workspace_id uuid,enabled boolean,admitted_after timestamptz);
create table provider_usage(workspace_id uuid,state text);create table model_attempts(id bigint);
create table model_routing(workspace_id uuid,enabled boolean);
create table app_private.dispatcher_settings(singleton boolean primary key,enabled boolean,
 project_url text,collection_hosts text[],secret_hash text,last_dispatch_at timestamptz);
insert into app_private.dispatcher_settings values(true,false,'https://fixture.invalid','{}',repeat('a',64),null);
create table app_private.application_release_history(release text primary key,migration_sha256 text not null,
 applied_at timestamptz not null default now());
alter table app_private.application_release_history enable row level security;
revoke all on app_private.application_release_history from public;
create function app_private.generation_command(operation text,input jsonb,idempotency_key text)
returns void language plpgsql security definer set search_path='' as $body$
declare w uuid;p public.generation_plans;begin __GUARD__ end $body$;
revoke all on function app_private.generation_command(text,jsonb,text) from public;
""".replace('__GUARD__', guard)
        setup += """
create function app_private.admit_proposal_issuance() returns trigger
language plpgsql security definer set search_path='' as $body$
declare previous text;begin
 perform set_config('app.issuance_authorizing',coalesce(previous,''),true);
 return new;
end $body$;
revoke all on function app_private.admit_proposal_issuance() from public;
"""
        setup += (m.ROOT / 'backend/supabase/migrations/20261021010317_healthy_model_poll_eligibility.sql').read_text().replace(
            'public,anon,authenticated', 'public,tdp_app_anon,tdp_app_authenticated').replace('to service_role;', 'to tdp_app_service;')
        local = lambda sql: sql.replace("current_database()<>'tenderdesk_app'", "current_database()<>'postgres'")
        variants = [
            ('UPDATE public.preserved_job SET attempts=0;', 'ADMISSION_SCHEMA_EXISTING_ROWS_CHANGED'),
            ("UPDATE app_private.application_release_history SET applied_at=now()+interval '1 second';", 'ADMISSION_SCHEMA_EXISTING_ROWS_CHANGED'),
            ('GRANT SELECT ON public.preserved_job TO tdp_app_authenticated;', 'ADMISSION_SCHEMA_EXISTING_STRUCTURE_CHANGED'),
            ('GRANT EXECUTE ON FUNCTION app_private.admit_proposal_issuance() TO tdp_app_authenticated;', 'ADMISSION_SCHEMA_EXISTING_STRUCTURE_CHANGED'),
            ('ALTER FUNCTION app_private.admit_proposal_issuance() IMMUTABLE;', 'ADMISSION_SCHEMA_COMMAND_ATTRIBUTES_CHANGED'),
            ('ALTER FUNCTION app_private.admit_proposal_issuance() STRICT;', 'ADMISSION_SCHEMA_COMMAND_ATTRIBUTES_CHANGED'),
            ('ALTER TABLE public.preserved_job ADD COLUMN unexpected text;', 'ADMISSION_SCHEMA_UNEXPECTED_ADDITION'),
            ('CREATE TABLE public.unreviewed(id int);', 'ADMISSION_SCHEMA_UNEXPECTED_ADDITION'),
            ("CREATE FUNCTION public.unreviewed() RETURNS int LANGUAGE sql AS 'SELECT 1';", 'ADMISSION_SCHEMA_UNEXPECTED_ADDITION'),
        ]
        data = {'setup': setup, 'old': old.LEGACY_DISPATCH_SQL.replace(':"service_role"', '"tdp_app_service"'),
            'manifest': m.base.BASE_MANIFEST, 'catalog': m.base.CATALOG.replace(' INTO catalog_hash', ''),
            'dispatch': local(m.base.script(m.retry.PARENT_SQL)), 'retry': local(m.retry.script(read_only=False)),
            'latency': local(m.parent.script(read_only=False)), 'latency_verify': local(m.parent.script(read_only=True)),
            'old_catalog': m.base.BASE_CATALOG, 'dispatch_catalog': m.retry.PARENT_CATALOG,
            'dispatch_structure': m.retry.PARENT_STRUCTURE,
            'retry_catalog': m.parent.PARENT_CATALOG, 'retry_structure': m.parent.PARENT_STRUCTURE, 'parent_catalog': m.PARENT_CATALOG,
            'parent_structure': m.PARENT_STRUCTURE, 'release_name': m.RELEASE,
            'release': local(m.script(read_only=False)), 'verify': local(m.script(read_only=True)),
            'allow': local(m.script(read_only=True, allow_parent=True)),
            'changed': local(m.script(read_only=False, payload=m.source()+'\n-- changed source\n')),
            'variants': [(local(m.script(read_only=False, payload=m.source()+'\n'+suffix)), code) for suffix, code in variants]}
        program = r"""
import {PGlite} from '@electric-sql/pglite';let input='';for await(const part of process.stdin)input+=part;
const x=JSON.parse(input),db=new PGlite(),one=async(sql)=>Object.values((await db.query(sql)).rows[0])[0];
await db.exec(x.setup);await db.query("insert into app_private.application_release_history(release,migration_sha256) values('proposal-delivery-reliability-v1',$1)",[x.manifest]);
await db.exec(x.old);const original=await one(x.catalog);await db.exec(x.dispatch.replaceAll(x.old_catalog,original));
const dc=await one(x.catalog),ds=await one("select migration_sha256 from app_private.application_release_history where release='proposal-dispatch-v2-20261108-structure'");
const bindDispatch=s=>s.replaceAll(x.dispatch_catalog,dc).replaceAll(x.dispatch_structure,ds);
await db.exec(bindDispatch(x.retry));
const rc=await one(x.catalog),rs=await one("select migration_sha256 from app_private.application_release_history where release='proposal-retry-modern-usage-v1-20261108-structure'");
const bindRetry=s=>bindDispatch(s).replaceAll(x.retry_catalog,rc).replaceAll(x.retry_structure,rs);
await db.exec(bindRetry(x.latency));
const pc=await one(x.catalog),ps=await one("select migration_sha256 from app_private.application_release_history where release='proposal-latency-v1-20261108-structure'");
const bind=s=>bindRetry(s).replaceAll(x.parent_catalog,pc).replaceAll(x.parent_structure,ps);
const rows=await one('select jsonb_agg(to_jsonb(h) order by release)::text from app_private.application_release_history h');
const reject=async(s,code)=>{let got;try{await db.exec(bind(s));}catch(e){got=e.message;await db.exec('rollback');}if(got!==code)throw Error('EXPECTED '+code+' GOT '+got);};
await db.exec(bind(x.allow));await reject(x.verify,'ADMISSION_SCHEMA_RELEASE_MISSING');
for(const [sql,code] of x.variants){await reject(sql,code);if(await one(x.catalog)!==pc)throw Error('FAILED_RELEASE_CHANGED_CATALOG');if(await one('select attempts from preserved_job')!==7)throw Error('FAILED_RELEASE_CHANGED_ROWS');}
await db.exec(bind(x.release));await db.exec(bind(x.release));await db.exec(bind(x.verify));await db.exec(bind(x.allow));
await reject(x.latency_verify,'LATENCY_SCHEMA_POST_CATALOG_CHANGED');
if(await one('select count(*)::int from app_private.application_release_history')!==13)throw Error('LEDGER_REPLAY');
if(await one("select jsonb_agg(to_jsonb(h) order by release)::text from app_private.application_release_history h where release not like 'proposal-admission-wake%'")!==rows)throw Error('PREDECESSOR_CHANGED');
await reject(x.changed,'ADMISSION_SCHEMA_SOURCE_CHANGED');
await db.exec('grant execute on function app_private.admit_proposal_issuance() to tdp_app_authenticated');
await reject(x.verify,'ADMISSION_SCHEMA_POST_CATALOG_CHANGED');await db.exec('revoke execute on function app_private.admit_proposal_issuance() from tdp_app_authenticated');
await db.exec(bind(x.verify));const saved=await one("select migration_sha256 from app_private.application_release_history where release='"+x.release_name+"-catalog'");
await db.query('delete from app_private.application_release_history where release=$1',[x.release_name+'-catalog']);await reject(x.allow,'ADMISSION_SCHEMA_PARTIAL_RECEIPT');
await db.query('insert into app_private.application_release_history(release,migration_sha256) values($1,$2)',[x.release_name+'-catalog',saved]);await db.exec(bind(x.verify));
await db.close();console.log('atomic_admission_chain_passed');
"""
        result = subprocess.run(['node', '--input-type=module', '-e', program], input=json.dumps(data),
            capture_output=True, text=True, cwd=m.ROOT/'backend', timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr[-7000:])
        self.assertIn('atomic_admission_chain_passed', result.stdout)


if __name__ == '__main__':
    unittest.main()
