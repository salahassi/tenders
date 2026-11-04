"""Actual local PostgreSQL authority checks for the retirement adapter SQL.

No kubeconfig, host port, external endpoint, production database or customer
record is accepted. The synthetic role graph matches managed setup's explicit
SET permission without inherited ownership. This does not qualify Storage's
binary deletion contract or Kubernetes process quiescence.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

from test_storage_retirement import selection

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "retirement_authority_adapter", HERE / "storage-retirement/kubernetes.py"
)
k = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(k)
IMAGE = "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"


def docker(*args, **kwargs):
    environment = dict(os.environ)
    for name in (
        "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS",
        "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
    ):
        environment.pop(name, None)
    return subprocess.run(
        ["docker", "--host=unix:///var/run/docker.sock", *args],
        env=environment, text=True, capture_output=True, timeout=30, **kwargs,
    )


class ManagedRoleAuthorityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.container = "tdp-retirement-authority-" + uuid.uuid4().hex[:12]
        cls.addClassCleanup(lambda: docker("rm", "-f", cls.container))
        # --pull=never ensures qualification cannot silently become an external
        # registry call or use a different binary when the pinned image is absent.
        result = docker(
            "run", "--pull=never", "--rm", "-d", "--name", cls.container,
            "--network", "none", "--memory", "128m", "--cpus", "1",
            "--label", "tenderdesk.synthetic-authority=true",
            "--tmpfs", "/var/lib/postgresql/data:rw",
            "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE,
        )
        if result.returncode:
            raise RuntimeError(result.stderr)
        for _ in range(100):
            process = docker("exec", cls.container, "cat", "/proc/1/comm")
            if process.stdout.strip() == "postgres" and not docker(
                "exec", cls.container, "pg_isready", "-U", "postgres"
            ).returncode:
                break
            time.sleep(0.05)
        else:
            raise RuntimeError("Isolated PostgreSQL did not start")
        cls.sql("create database tenderdesk_app", database="postgres")
        cls.sql("""
create role tdp_app_owner nologin inherit nosuperuser nobypassrls;
create role tdp_app_storageadmin nologin noinherit nosuperuser nobypassrls;
create role fixture_admin login noinherit nosuperuser nobypassrls;
create role fixture_inherit_only login inherit nosuperuser nobypassrls;
create role fixture_no_owner_set login inherit nosuperuser nobypassrls;
create role fixture_no_storage_set login inherit nosuperuser nobypassrls;
create role fixture_unrelated login noinherit nosuperuser nobypassrls;
grant tdp_app_owner,tdp_app_storageadmin to fixture_admin with inherit false,set true;
grant tdp_app_owner,tdp_app_storageadmin to fixture_inherit_only with inherit true,set false;
grant tdp_app_owner to fixture_no_owner_set with inherit true,set false;
grant tdp_app_storageadmin to fixture_no_owner_set with inherit false,set true;
grant tdp_app_owner to fixture_no_storage_set with inherit false,set true;
grant tdp_app_storageadmin to fixture_no_storage_set with inherit true,set false;
alter schema public owner to tdp_app_owner;
revoke all on schema public from public;
grant usage on schema public to tdp_app_storageadmin;
create schema storage authorization tdp_app_storageadmin;
create table storage.objects(id integer primary key,bucket_id text,name text);
alter table storage.objects owner to tdp_app_storageadmin;
alter table storage.objects enable row level security;
create table storage.s3_multipart_uploads(bucket_id text,key text);
create table storage.s3_multipart_uploads_parts(bucket_id text,key text);
alter table storage.s3_multipart_uploads owner to tdp_app_storageadmin;
alter table storage.s3_multipart_uploads_parts owner to tdp_app_storageadmin;
do $$declare name text;begin
 foreach name in array array['storage_write_intents','storage_cleanup_queue','documents',
 'export_artifacts','proposal_delivery_artifacts','export_package_volumes','restore_files'] loop
 execute format('create table public.%I(storage_key text)',name);
 execute format('alter table public.%I owner to tdp_app_owner',name);
 execute format('insert into public.%I values(%L)',name,'synthetic/'||name);
 end loop;end$$;
insert into storage.s3_multipart_uploads values
 ('tenderdesk-private','synthetic/multipart'),('unrelated-bucket','synthetic/ignored-upload');
insert into storage.s3_multipart_uploads_parts values
 ('tenderdesk-private','synthetic/part'),('unrelated-bucket','synthetic/ignored-part');
create function public.guard_retired_storage_write() returns trigger
language plpgsql security definer set search_path='' as $$begin return new;end$$;
alter function public.guard_retired_storage_write() owner to tdp_app_owner;
revoke all on function public.guard_retired_storage_write() from public;
create function storage.require_local_delete_setting() returns trigger
language plpgsql as $$begin
 if current_setting('storage.allow_delete_query',true) is distinct from 'true'
 then raise exception 'SYNTHETIC_DELETE_SETTING_REQUIRED';end if;
 return old;end$$;
create trigger synthetic_delete_setting before delete on storage.objects
for each row execute function storage.require_local_delete_setting();
""")
        cls.version = cls.sql("select version()").strip()
        print("authority_postgres_version", cls.version, flush=True)

    @classmethod
    def sql(cls, statement, user="postgres", database="tenderdesk_app"):
        result = docker(
            "exec", "-i", cls.container, "psql", "-XAtq",
            "-v", "ON_ERROR_STOP=1", "-U", user, "-d", database,
            input=statement,
        )
        if result.returncode:
            raise RuntimeError(result.stderr)
        return result.stdout.strip()

    def setUp(self):
        self.sql("""
drop trigger if exists tenderdesk_retired_storage_write on storage.objects;
truncate storage.objects;
insert into storage.objects values
 (1,'tenderdesk-private','synthetic/selected''quote'),
 (2,'tenderdesk-private','synthetic/untouched'),
 (3,'unrelated-bucket','synthetic/selected''quote');
""")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        client = type("Client", (), {"pod": "synthetic-local-postgres"})()
        self.adapter = k.KubernetesAdapter(self.temp.name, client, selection())
        self.adapter.binary = {
            "guard_body_sha256": self.sql(
                "select encode(sha256(convert_to(prosrc,'UTF8')),'hex') "
                "from pg_proc where oid='public.guard_retired_storage_write()'::regprocedure"
            )
        }

    def as_user(self, user):
        # Only the transport is replaced: execute the actual adapter-produced
        # transaction and role statements in a genuine non-superuser session.
        return patch.object(k.d, "sql", side_effect=lambda _pod, sql: self.sql(sql, user))

    def state(self):
        return json.loads(self.sql("""select jsonb_build_object(
 'rows',(select jsonb_agg(to_jsonb(o) order by id) from storage.objects o),
 'function_acl',(select to_jsonb(proacl) from pg_proc where oid='public.guard_retired_storage_write()'::regprocedure),
 'function_owner',(select proowner from pg_proc where oid='public.guard_retired_storage_write()'::regprocedure),
 'table_owner',(select relowner from pg_class where oid='storage.objects'::regclass),
 'schema_acl',(select jsonb_agg(jsonb_build_array(nspname,nspowner,nspacl) order by nspname) from pg_namespace where nspname in ('public','storage')),
 'memberships',(select jsonb_agg(to_jsonb(m) order by roleid,member,grantor) from pg_auth_members m),
 'triggers',(select jsonb_agg(pg_get_triggerdef(oid) order by tgname) from pg_trigger where tgrelid='storage.objects'::regclass)
)"""))

    def test_actual_set_authority_is_distinct_from_inherited_usage(self):
        for user, usage, can_set in (
            ("fixture_admin", False, True),
            ("fixture_inherit_only", True, False),
            ("fixture_unrelated", False, False),
        ):
            with self.subTest(user=user):
                actual = json.loads(self.sql("""select jsonb_build_object(
 'session',session_user,'current',current_user,
 'super',(select rolsuper from pg_roles where rolname=current_user),
 'usage',pg_has_role(session_user,'tdp_app_owner','USAGE'),
 'set',pg_has_role(session_user,'tdp_app_owner','SET'))""", user))
                self.assertEqual(actual, {
                    "session": user, "current": user, "super": False,
                    "usage": usage, "set": can_set,
                })
                if can_set:
                    self.assertEqual(
                        self.sql("begin;set local role tdp_app_owner;select current_user;rollback", user),
                        "tdp_app_owner",
                    )
                else:
                    with self.assertRaisesRegex(RuntimeError, "permission denied to set role"):
                        self.sql("set role tdp_app_owner", user)

    def test_installs_and_replays_with_set_without_inherit_preserving_acl(self):
        before = self.state()
        with self.as_user("fixture_admin"):
            self.adapter.install_fence(None)
            first_sha = self.adapter.fence_sha
            self.adapter.install_fence(None)
        after = self.state()
        self.assertEqual(first_sha, self.adapter.fence_sha)
        self.assertRegex(first_sha, r"^[a-f0-9]{64}$")
        self.assertEqual(len(after["triggers"]), len(before["triggers"]) + 1)
        for key in before.keys() - {"triggers"}:
            self.assertEqual(after[key], before[key], key)
        self.assertEqual(self.sql("""select has_function_privilege(
 'tdp_app_storageadmin','public.guard_retired_storage_write()','EXECUTE')"""), "f")

    def test_deletes_only_exact_selected_metadata_with_set_without_inherit(self):
        before = self.state()
        with self.as_user("fixture_admin"):
            self.adapter.delete_metadata("synthetic/selected'quote")
        after = self.state()
        self.assertEqual(after["rows"], [row for row in before["rows"] if row["id"] != 1])
        for key in before.keys() - {"rows"}:
            self.assertEqual(after[key], before[key], key)

    def test_install_requires_set_permission_for_both_owners(self):
        before = self.state()
        for user in ("fixture_no_owner_set", "fixture_no_storage_set", "fixture_inherit_only", "fixture_unrelated"):
            with self.subTest(user=user), self.as_user(user):
                with self.assertRaisesRegex(RuntimeError, "STORAGE_RETIREMENT_OWNER_AUTHORITY_REQUIRED"):
                    self.adapter.install_fence(None)
                self.assertEqual(self.state(), before)

    def test_delete_rejects_inherited_or_unrelated_authority_without_set(self):
        before = self.state()
        for user in ("fixture_inherit_only", "fixture_unrelated"):
            with self.subTest(user=user), self.as_user(user):
                with self.assertRaisesRegex(RuntimeError, "STORAGE_RETIREMENT_OWNER_AUTHORITY_REQUIRED"):
                    self.adapter.delete_metadata("synthetic/selected'quote")
                self.assertEqual(self.state(), before)

    def test_complete_census_reads_both_explicit_owners_without_schema_grants(self):
        before = self.state()
        for schema, table in (("storage", "objects"), ("public", "documents")):
            with self.subTest(schema=schema):
                self.assertEqual(self.sql(
                    f"select has_schema_privilege(current_user,'{schema}','USAGE')",
                    "fixture_admin",
                ), "f")
                with self.assertRaisesRegex(RuntimeError, "permission denied for schema"):
                    self.sql(f"select count(*) from {schema}.{table}", "fixture_admin")
        with self.as_user("fixture_admin"):
            found = self.adapter.census()
        self.assertEqual(set(found), {
            "synthetic/selected'quote", "synthetic/untouched",
            "synthetic/multipart", "synthetic/part",
            *["synthetic/" + name for name in (
                "storage_write_intents", "storage_cleanup_queue", "documents",
                "export_artifacts", "proposal_delivery_artifacts",
                "export_package_volumes", "restore_files",
            )],
        })
        self.assertEqual(len(found), len(set(found)))
        self.assertEqual(self.state(), before)

    def test_scoped_readbacks_detect_multipart_and_actual_metadata_absence(self):
        with self.as_user("fixture_admin"):
            for key in ("synthetic/multipart", "synthetic/part"):
                with self.subTest(key=key), self.assertRaisesRegex(
                    k.c.RetirementError, "STORAGE_RETIREMENT_MULTIPART_PRESENT"
                ):
                    self.adapter.assert_no_multipart(key)
            self.adapter.assert_no_multipart("synthetic/selected'quote")
            self.assertEqual(self.adapter.metadata_remaining("synthetic/selected'quote"), 1)
            self.adapter.delete_metadata("synthetic/selected'quote")
            self.assertEqual(self.adapter.metadata_remaining("synthetic/selected'quote"), 0)
            self.assertEqual(self.adapter.metadata_remaining("synthetic/untouched"), 1)

    def test_readbacks_do_not_use_inheritance_as_set_authority(self):
        before = self.state()
        for user in ("fixture_inherit_only", "fixture_unrelated"):
            with self.subTest(user=user), self.as_user(user):
                for call in (
                    self.adapter.census,
                    lambda: self.adapter.assert_no_multipart("synthetic/untouched"),
                    lambda: self.adapter.metadata_remaining("synthetic/untouched"),
                ):
                    with self.assertRaisesRegex(RuntimeError, "STORAGE_RETIREMENT_OWNER_AUTHORITY_REQUIRED"):
                        call()
        with self.as_user("fixture_no_owner_set"):
            with self.assertRaisesRegex(RuntimeError, "STORAGE_RETIREMENT_OWNER_AUTHORITY_REQUIRED"):
                self.adapter.census()
        self.assertEqual(self.state(), before)


if __name__ == "__main__":
    unittest.main()
