"""Schema-only release boundary: synthetic PostgreSQL, never production."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


m = module('retry_schema_tested', 'proposal-retry-schema.py')
fixture = module('retry_parent_fixture', 'test_proposal_dispatch_schema.py')


class RetrySchemaTests(unittest.TestCase):
    def test_read_only_verifier_never_replays_ddl_or_writes_receipts(self):
        for allow_parent in (True, False):
            sql = m.script(read_only=True, allow_parent=allow_parent)
            self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', sql)
            self.assertNotIn('INSERT INTO app_private.application_release_history', sql)
            self.assertNotIn('$retry_schema_payload$', sql)
            self.assertNotIn('NOTIFY pgrst', sql)
            self.assertIn(m.PARENT_CATALOG, sql)
            self.assertIn(m.PARENT_STRUCTURE, sql)
            self.assertIn('RETRY_SCHEMA_PARTIAL_RECEIPT', sql)

    def test_checksum_bound_source_and_invalid_modes(self):
        self.assertEqual(m.source_sha256(), hashlib.sha256(m.SOURCE.read_bytes()).hexdigest())
        self.assertIn(m.source_sha256(), m.script(read_only=False))
        with self.assertRaises(m.RetrySchemaError):
            m.script(read_only=False, allow_parent=True)
        with self.assertRaises(m.RetrySchemaError):
            m.script(read_only=False, payload='$retry_schema_payload$')

    def test_transport_is_bounded_and_receipt_drift_fails(self):
        valid = {'release': m.RELEASE, 'sql_sha256': m.source_sha256(), 'parent_release': m.parent.RELEASE,
            'parent_sql_sha256': m.PARENT_SQL, 'catalog_sha256': 'a' * 64, 'structure_sha256': 'b' * 64,
            'applied': True, 'replayed': True, 'read_only': True, 'predecessor_receipts_preserved': True,
            'business_rows_changed': 0, 'processing_requested': False}
        with patch.object(m, 'execute_sql', return_value=json.dumps(valid)) as transport:
            self.assertEqual(m.verify(Mock(pod='owned-client')), valid)
            for change in ({'sql_sha256': 'c' * 64}, {'applied': False}, {'business_rows_changed': 1},
                           {'processing_requested': True}, {'predecessor_receipts_preserved': False}):
                transport.return_value = json.dumps(valid | change)
                with self.assertRaises(m.RetrySchemaError):
                    m.verify(Mock(pod='owned-client'))

    def test_verbose_sql_errors_are_strictly_sanitized(self):
        cases = [
            ('psql:<stdin>:5: ERROR:  P0001: RETRY_SCHEMA_PARENT_CATALOG\nCONTEXT: private SQL and customer data', 'RETRY_SCHEMA_PARENT_CATALOG'),
            ('ERROR:  P0001: DISPATCH_SCHEMA_RPC_AUTHORITY\nDETAIL: private value', 'DISPATCH_SCHEMA_RPC_AUTHORITY'),
            ('ERROR:  P0001: GENERATION_RETRY_USAGE_GUARD_CHANGED\nCONTEXT: private source', 'GENERATION_RETRY_USAGE_GUARD_CHANGED'),
            ('ERROR:  57014: canceling statement due to statement timeout\nCONTEXT: private SQL', 'RETRY_SCHEMA_SQLSTATE_57014'),
            ('ERROR:  42703: column "private customer value" does not exist', 'RETRY_SCHEMA_SQLSTATE_42703'),
            ('ERROR:  P0001: RETRY_SCHEMA_INVENTED_CUSTOMER_VALUE', 'RETRY_SCHEMA_SQLSTATE_P0001'),
            ('Error from server: private infrastructure value', 'RETRY_SCHEMA_SQL_TRANSPORT_FAILED'),
        ]
        for raw, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(m.sql_error_code(raw), expected)

    def test_transport_keeps_original_ca_and_bound_without_leaking_streams(self):
        deploy = Mock(NAMESPACE='fixture', DATABASE='fixture')
        with patch.dict(os.environ, {'KUBECTL': '/private/kubectl'}), patch.object(m, 'module', return_value=deploy), \
             patch.object(m.subprocess, 'run', return_value=Mock(returncode=1,
                stderr='ERROR:  57014: private customer details', stdout='private response')) as command:
            with self.assertRaisesRegex(m.RetrySchemaError, '^RETRY_SCHEMA_SQLSTATE_57014$'):
                m.execute_sql(Mock(pod='owned-client'), 'SELECT 1')
            self.assertEqual(command.call_args.kwargs['timeout'], 30)
            self.assertIn('--set=VERBOSITY=verbose', command.call_args.args[0])
            self.assertNotIn('--insecure-skip-tls-verify', command.call_args.args[0])
            command.side_effect = subprocess.TimeoutExpired(['private-command'], 30, output='private output')
            with self.assertRaisesRegex(m.RetrySchemaError, '^RETRY_SCHEMA_SQL_TRANSPORT_TIMEOUT$'):
                m.execute_sql(Mock(pod='owned-client'), 'SELECT 1')

    def test_row_cost_probe_is_read_only_and_returns_no_customer_digests(self):
        sql = m.row_digest_probe_sql()
        self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;', sql)
        self.assertIn("statement_timeout='20s'", sql)
        self.assertIn(m.parent.ROWS, sql)
        self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
        self.assertNotRegex(sql, r'(?i)\b(insert|update|delete|truncate|grant|revoke)\b')
        with patch.object(m, 'execute_sql', return_value='{"completed":true}'):
            result = m.row_digest_probe(Mock(pod='owned-client'))
        self.assertTrue(result['completed'])
        self.assertEqual(set(result), {'probe', 'completed', 'code', 'duration_seconds', 'read_only'})

    def test_row_cost_timeout_preserves_read_only_probe_status(self):
        with patch.object(m, 'execute_sql', side_effect=m.RetrySchemaError('RETRY_SCHEMA_SQLSTATE_57014')):
            result = m.row_digest_probe(Mock(pod='owned-client'))
        self.assertFalse(result['completed'])
        self.assertEqual(result['code'], 'RETRY_SCHEMA_SQLSTATE_57014')
        self.assertTrue(result['read_only'])

    def test_atomic_apply_replay_chain_authority_and_mutation_rejection(self):
        payload = m.source()
        def sql(value=payload, read_only=False, allow_parent=False):
            return m.script(read_only=read_only, allow_parent=allow_parent, payload=value).replace(
                "current_database()<>'tenderdesk_app'", "current_database()<>'postgres'")
        original_guard = """if exists(select 1 from public.provider_usage where workspace_id=w and (
  state='reserved' or (state='unknown' and not exists(select 1 from public.model_routing where workspace_id=w and enabled))
 )) then raise exception 'USAGE_REVIEW_REQUIRED';end if;"""
        setup = """
create role tdp_app_owner nosuperuser nocreatedb nocreaterole nobypassrls;
create role tdp_app_service;create role tdp_app_authenticated;create role tdp_app_anon;
grant tdp_app_owner to tdp_app_service;
alter schema public owner to tdp_app_owner;create schema app_private authorization tdp_app_owner;
set role tdp_app_owner;set search_path=public;
create table public.operations(scheduler_enabled boolean not null);
insert into public.operations values(false);
create table public.preserved_job(id int primary key,attempts int,payload jsonb);
insert into public.preserved_job values(1,7,'{"saved":true,"unknown_usage":"retained"}');
create table public.generation_plans(id uuid,workspace_id uuid,created_at timestamptz);
create table public.jobs(id uuid,workspace_id uuid,entity_id uuid,checkpoint jsonb);
create table public.model_execution_settings(workspace_id uuid,enabled boolean,admitted_after timestamptz);
create table public.provider_usage(workspace_id uuid,state text);
create table public.model_routing(workspace_id uuid,enabled boolean);
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
""".replace('__GUARD__', original_guard)
        dispatch = m.parent.script(m.PARENT_SQL).replace("current_database()<>'tenderdesk_app'", "current_database()<>'postgres'")
        variants = [
            ("UPDATE public.preserved_job SET attempts=0;", 'RETRY_SCHEMA_EXISTING_ROWS_CHANGED'),
            ("UPDATE app_private.application_release_history SET applied_at=now()+interval '1 second';", 'RETRY_SCHEMA_EXISTING_ROWS_CHANGED'),
            ("GRANT SELECT ON public.preserved_job TO tdp_app_authenticated;", 'RETRY_SCHEMA_EXISTING_STRUCTURE_CHANGED'),
            ("GRANT EXECUTE ON FUNCTION app_private.generation_command(text,jsonb,text) TO tdp_app_authenticated;", 'RETRY_SCHEMA_EXISTING_STRUCTURE_CHANGED'),
            ("ALTER TABLE public.preserved_job ADD COLUMN unauthorized text;", 'RETRY_SCHEMA_UNEXPECTED_ADDITION'),
            ("CREATE TABLE public.unreviewed(id int);", 'RETRY_SCHEMA_UNEXPECTED_ADDITION'),
            ("CREATE FUNCTION public.unreviewed() RETURNS int LANGUAGE sql AS 'SELECT 1';", 'RETRY_SCHEMA_UNEXPECTED_ADDITION'),
            ("GRANT EXECUTE ON FUNCTION app_private.assert_generation_retry_usage(public.generation_plans,text) TO tdp_app_authenticated;", 'RETRY_SCHEMA_HELPER_AUTHORITY'),
            ("ALTER FUNCTION app_private.assert_generation_retry_usage(public.generation_plans,text) SECURITY DEFINER;", 'RETRY_SCHEMA_HELPER_AUTHORITY'),
            ("ALTER FUNCTION app_private.generation_command(text,jsonb,text) IMMUTABLE;", 'RETRY_SCHEMA_COMMAND_ATTRIBUTES_CHANGED'),
            ("ALTER FUNCTION app_private.generation_command(text,jsonb,text) STRICT;", 'RETRY_SCHEMA_COMMAND_ATTRIBUTES_CHANGED'),
        ]
        data = {'setup': setup, 'old': fixture.LEGACY_DISPATCH_SQL.replace(':"service_role"', '"tdp_app_service"'),
            'manifest': m.parent.BASE_MANIFEST, 'dispatch': dispatch, 'old_catalog': m.parent.BASE_CATALOG,
            'catalog': m.parent.CATALOG.replace(' INTO catalog_hash', ''), 'release': sql(), 'verify': sql(read_only=True),
            'probe': m.row_digest_probe_sql().replace("current_database()<>'tenderdesk_app'", "current_database()<>'postgres'"),
            'allow': sql(read_only=True, allow_parent=True), 'changed': sql(payload + '\n-- changed reviewed source\n'),
            'variants': [(sql(payload + '\n' + suffix), code) for suffix, code in variants],
            'parent_catalog': m.PARENT_CATALOG, 'parent_structure': m.PARENT_STRUCTURE, 'release_name': m.RELEASE}
        program = r"""
import {PGlite} from '@electric-sql/pglite';
let input='';for await(const part of process.stdin)input+=part;const x=JSON.parse(input),db=new PGlite();
const one=async(sql)=>Object.values((await db.query(sql)).rows[0])[0];
await db.exec(x.setup);await db.query("insert into app_private.application_release_history(release,migration_sha256) values('proposal-delivery-reliability-v1',$1)",[x.manifest]);
await db.exec(x.old);const old=await one(x.catalog);await db.exec(x.dispatch.replaceAll(x.old_catalog,old));
const parentCatalog=await one(x.catalog),parentStructure=await one("select migration_sha256 from app_private.application_release_history where release='proposal-dispatch-v2-20261108-structure'");
const baselineRows=await one("select jsonb_agg(to_jsonb(h) order by release)::text from app_private.application_release_history h");
const bind=s=>s.replaceAll(x.parent_catalog,parentCatalog).replaceAll(x.parent_structure,parentStructure);
const reject=async(s,code)=>{let got;try{await db.exec(bind(s));}catch(e){got=e.message;await db.exec('rollback');}if(got!==code)throw Error('EXPECTED '+code+' GOT '+got);};
await db.exec(bind(x.allow));await reject(x.verify,'RETRY_SCHEMA_RELEASE_MISSING');
for(const [s,code] of x.variants){await reject(s,code);if(await one(x.catalog)!==parentCatalog)throw Error('FAILED_RELEASE_CHANGED_CATALOG');if(await one('select attempts from public.preserved_job')!==7)throw Error('FAILED_RELEASE_CHANGED_ROWS');}
await db.exec(bind(x.release));await db.exec(bind(x.release));await db.exec(bind(x.verify));await db.exec(bind(x.allow));
await db.exec(x.probe);
if(await one('select count(*)::int from app_private.application_release_history')!==7)throw Error('LEDGER_REPLAY');
if(await one("select jsonb_agg(to_jsonb(h) order by release)::text from app_private.application_release_history h where release not like 'proposal-retry-modern-usage%'")!==baselineRows)throw Error('PARENT_LEDGER_CHANGED');
await reject(x.changed,'RETRY_SCHEMA_SOURCE_CHANGED');
await db.exec('grant execute on function app_private.assert_generation_retry_usage(public.generation_plans,text) to tdp_app_authenticated');
await reject(x.verify,'RETRY_SCHEMA_POST_CATALOG_CHANGED');await db.exec('revoke execute on function app_private.assert_generation_retry_usage(public.generation_plans,text) from tdp_app_authenticated');
await db.exec(bind(x.verify));
const saved=await one("select migration_sha256 from app_private.application_release_history where release='"+x.release_name+"-catalog'");
await db.query('delete from app_private.application_release_history where release=$1',[x.release_name+'-catalog']);
await reject(x.allow,'RETRY_SCHEMA_PARTIAL_RECEIPT');
await db.query('insert into app_private.application_release_history(release,migration_sha256) values($1,$2)',[x.release_name+'-catalog',saved]);
await db.exec(bind(x.verify));await db.close();console.log('atomic_retry_release_passed');
"""
        result = subprocess.run(['node', '--input-type=module', '-e', program], input=json.dumps(data),
            text=True, capture_output=True, cwd=m.ROOT / 'backend', timeout=90)
        self.assertEqual(result.returncode, 0, result.stderr[-7000:])
        self.assertIn('atomic_retry_release_passed', result.stdout)


if __name__ == '__main__':
    unittest.main()
