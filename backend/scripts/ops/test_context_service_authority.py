"""Execute the real migration permission blocks on isolated PostgreSQL.

Synthetic function bodies isolate ACL preservation from application behavior.
No external network, host port, customer records or production DB is accepted.
"""
import json
from pathlib import Path
import re
import time
import unittest
import uuid

from test_storage_retirement_authority import docker, IMAGE

ROOT = Path(__file__).resolve().parents[2]
CASES = [
    ('20261104152913_durable_ordinary_export_packages.sql', 'artifact_context_permissions',
     'public.artifact_context_before_export_package(uuid)', 'public.artifact_context(uuid)'),
    ('20261104170442_durable_storage_write_intents.sql', 'workspace_status_permissions',
     'public.workspace_status_before_storage_intents()', 'public.workspace_status()'),
]


class ContextServiceAuthorityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.container = 'tdp-context-authority-'+uuid.uuid4().hex[:12]
        cls.addClassCleanup(lambda: docker('rm','-f',cls.container))
        result = docker('run','--pull=never','--rm','-d','--name',cls.container,
                        '--network','none','--memory','128m','--cpus','1',
                        '--label','tenderdesk.synthetic-context-authority=true',
                        '--tmpfs','/var/lib/postgresql/data:rw',
                        '-e','POSTGRES_HOST_AUTH_METHOD=trust',IMAGE)
        if result.returncode:raise RuntimeError(result.stderr)
        for _ in range(100):
            if docker('exec',cls.container,'cat','/proc/1/comm').stdout.strip()=='postgres' and not docker('exec',cls.container,'pg_isready','-U','postgres').returncode:break
            time.sleep(.05)
        else:raise RuntimeError('ISOLATED_POSTGRES_NOT_READY')
        result=cls.sql('create role fixture_owner;alter schema public owner to fixture_owner;create schema app_private authorization fixture_owner;')
        if result.returncode:raise RuntimeError(result.stderr)

    @classmethod
    def sql(cls, source):
        return docker('exec','-i',cls.container,'psql','-X','-qAt','-U','postgres',
                      '--set=ON_ERROR_STOP=1','--file=-',input=source)

    def fixture(self, case, managed, grant):
        filename,tag,prior,target=case
        source=(ROOT/'supabase/migrations'/filename).read_text()
        start='do $'+tag+'$';end='end $'+tag+'$;'
        self.assertEqual(source.count(start),1)
        block=source[source.index(start):source.index(end,source.index(start))+len(end)]
        signatures=sorted(set(re.findall(r'(?:public|app_private)\.[a-z_]+\([a-z0-9_,.]*\)',block)))
        auth,service,anon=('tdp_app_authenticated','tdp_app_service','tdp_app_anon') if managed else ('authenticated','service_role','anon')
        prefix='begin;'+''.join('create role '+role+';' for role in [auth,service,anon])+'set local role fixture_owner;'
        prefix+=''.join('create table public.'+name+'(id integer);' for name in ['export_packages','export_package_volumes','storage_write_intents'])
        prefix+=''.join('create function '+signature+" returns jsonb language sql security definer set search_path='' as $$select '{}'::jsonb$$;" for signature in signatures)
        prefix+='revoke all on function '+prior+' from public;grant execute on function '+prior+' to '+auth+';'
        if grant:
            prefix+='grant execute on function '+prior+' to '+service+(' with grant option' if grant=='grantable' else '')+';'
        prefix+="select set_config('fixture.before_acl',(select to_jsonb(proacl)::text from pg_proc where oid='"+prior+"'::regprocedure),true);"
        return prefix,block,prior,target,auth,service,anon

    def test_existing_service_grants_and_grant_options_preserved_without_new_access(self):
        for case in CASES:
            for managed in [False,True]:
                for grant in [False,True,'grantable']:
                    with self.subTest(function=case[3],managed=managed,grant=grant):
                        prefix,block,prior,target,auth,service,anon=self.fixture(case,managed,grant)
                        query=f"""select jsonb_build_object(
                          'before',current_setting('fixture.before_acl')::jsonb,
                          'after',(select to_jsonb(proacl) from pg_proc where oid='{target}'::regprocedure),
                          'service',has_function_privilege('{service}','{target}','EXECUTE'),
                          'grantable',has_function_privilege('{service}','{target}','EXECUTE WITH GRANT OPTION'),
                          'auth',has_function_privilege('{auth}','{target}','EXECUTE'),
                          'anon',has_function_privilege('{anon}','{target}','EXECUTE'),
                          'legacy_service',has_function_privilege('{service}','{prior}','EXECUTE'),
                          'legacy_auth',has_function_privilege('{auth}','{prior}','EXECUTE'));rollback;"""
                        result=self.sql(prefix+block+query)
                        self.assertEqual(result.returncode,0,result.stderr)
                        value=json.loads(result.stdout.strip().splitlines()[-1])
                        self.assertEqual(value['before'],value['after'])
                        self.assertEqual(value['service'],bool(grant))
                        self.assertEqual(value['grantable'],grant=='grantable')
                        self.assertTrue(value['auth'])
                        for key in ['anon','legacy_service','legacy_auth']:self.assertFalse(value[key])

    def test_an_unreviewed_grantor_is_rejected_before_changing_authority(self):
        for case in CASES:
            with self.subTest(function=case[3]):
                prefix,block,prior,target,auth,service,anon=self.fixture(case,True,False)
                foreign=f'grant usage on schema public to {auth};grant execute on function {prior} to {auth} with grant option;set local role {auth};grant execute on function {prior} to {service};set local role fixture_owner;'
                result=self.sql(prefix+foreign+block+'rollback;')
                self.assertNotEqual(result.returncode,0)
                self.assertIn('LEGACY_CONTEXT_SERVICE_GRANTOR_UNSUPPORTED',result.stderr)
