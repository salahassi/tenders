"""Atomic dispatch release tests on an isolated PostgreSQL engine only."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("tested_dispatch_schema", Path(__file__).with_name("proposal-dispatch-schema.py"))
m = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = m
SPEC.loader.exec_module(m)

# Exact pre-change adapter from f79ecdd. Keep the fixture self-contained for a
# shallow runner checkout and independent of the candidate's dispatcher source.
LEGACY_DISPATCH_SHA256 = "a4049289c865dcf1697622cc792abbbc217e04ca6046079d22be15f35c0fa9ad"
LEGACY_DISPATCH_SQL = r"""-- Apply as the application schema owner after the restored application schema.
-- psql variable service_role is the selected, prefixed service identity.
-- No worker credential is stored in this outbox or returned through its RPCs.
create table if not exists app_private.k8s_dispatch_queue (
 singleton boolean primary key default true check (singleton),
 generation bigint not null default 0 check (generation>=0),
 acknowledged_generation bigint not null default 0,
 lease_generation bigint,
 lease_token uuid,
 lease_until timestamptz,
 next_attempt_at timestamptz not null default '-infinity',
 last_periodic_at timestamptz not null default '-infinity',
 failures integer not null default 0 check (failures>=0),
 check (acknowledged_generation<=generation)
);
alter table app_private.k8s_dispatch_queue enable row level security;
revoke all on app_private.k8s_dispatch_queue from public;
insert into app_private.k8s_dispatch_queue(singleton) values(true)
on conflict(singleton) do nothing;

create or replace function app_private.dispatch_backend()
returns void language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from app_private.dispatcher_settings where singleton and enabled)
 then return;end if;
 -- This write commits together with the existing guarded queue wake receipt.
 -- A process crash or a missed notification cannot discard pending dispatch.
 update app_private.k8s_dispatch_queue set generation=generation+1
 where singleton;
 perform pg_notify('tenderdesk_dispatch','wake');
end $$;
revoke all on function app_private.dispatch_backend() from public;

create or replace function public.configure_dispatcher(
 project_url text,collection_hosts text[] default '{}'
) returns void language plpgsql security definer set search_path='' as $$
begin
 if project_url!~'^https://[a-zA-Z0-9][a-zA-Z0-9.-]*(:[0-9]{1,5})?$'
 or exists(select 1 from unnest(collection_hosts) h where h!~'^[a-z0-9.-]+\.[a-z]{2,}$')
 then raise exception 'INVALID_DISPATCH_CONFIGURATION';end if;
 -- The deployer inserts the secret hash from the Kubernetes worker Secret.
 -- Configuration never generates a different credential or needs Vault/net.
 if not exists(select 1 from app_private.dispatcher_settings
  where singleton and secret_hash~'^[a-f0-9]{64}$')
 then raise exception 'DISPATCH_SECRET_MISSING';end if;
 update app_private.dispatcher_settings d set project_url=configure_dispatcher.project_url,
  collection_hosts=configure_dispatcher.collection_hosts,enabled=true where d.singleton;
 update public.operations set scheduler_enabled=true;
 perform app_private.dispatch_backend();
end $$;
revoke all on function public.configure_dispatcher(text,text[]) from public;

create or replace function public.k8s_claim_dispatch()
returns jsonb language plpgsql security definer set search_path='' as $$
declare q app_private.k8s_dispatch_queue;now_at timestamptz:=clock_timestamp();
begin
 if not exists(select 1 from app_private.dispatcher_settings where singleton and enabled)
 then return null;end if;
 select * into q from app_private.k8s_dispatch_queue where singleton for update;
 if not found then raise exception 'DISPATCH_OUTBOX_MISSING';end if;
 -- Recovery dispatch remains periodic even if no immediate event survived.
 if q.last_periodic_at<=now_at-interval '60 seconds' then
  update app_private.k8s_dispatch_queue set generation=generation+1,last_periodic_at=now_at
  where singleton returning * into q;
 end if;
 if q.generation<=q.acknowledged_generation or q.next_attempt_at>now_at
 or q.lease_until>now_at then return null;end if;
 update app_private.k8s_dispatch_queue set lease_generation=generation,
  lease_token=gen_random_uuid(),lease_until=now_at+interval '180 seconds'
 where singleton returning * into q;
 return jsonb_build_object('lease',q.lease_token,'generation',q.lease_generation);
end $$;
revoke all on function public.k8s_claim_dispatch() from public;
grant execute on function public.k8s_claim_dispatch() to :"service_role";

create or replace function public.k8s_finish_dispatch(
 dispatch_lease uuid,dispatch_generation bigint,succeeded boolean
) returns boolean language plpgsql security definer set search_path='' as $$
begin
 if dispatch_lease is null or dispatch_generation is null or succeeded is null
 then return false;end if;
 update app_private.k8s_dispatch_queue q set
  acknowledged_generation=case when succeeded
   then greatest(q.acknowledged_generation,dispatch_generation)
   else q.acknowledged_generation end,
  failures=case when succeeded then 0 else least(q.failures+1,10) end,
  next_attempt_at=case when succeeded then '-infinity'::timestamptz
   else clock_timestamp()+make_interval(secs=>least(60,power(2,least(q.failures+1,6))::integer)) end,
  lease_token=null,lease_generation=null,lease_until=null
 where q.singleton and q.lease_token=dispatch_lease
  and q.lease_generation=dispatch_generation and q.lease_until>clock_timestamp();
 if not found then return false;end if;
 if succeeded then update app_private.dispatcher_settings
  set last_dispatch_at=clock_timestamp() where singleton;end if;
 return true;
end $$;
revoke all on function public.k8s_finish_dispatch(uuid,bigint,boolean) from public;
grant execute on function public.k8s_finish_dispatch(uuid,bigint,boolean) to :"service_role";
"""


class DispatchSchemaTests(unittest.TestCase):
    def setUp(self):
        self.source = m.SOURCE.read_text()
        self.checksum = hashlib.sha256(self.source.encode()).hexdigest()

    def test_exact_source_and_managed_role_are_required(self):
        self.assertEqual(m.verified_source(self.checksum), self.source)
        for checksum in ("", "0" * 64, "x" * 64):
            with self.assertRaises(m.SchemaError):
                m.verified_source(checksum)
        sql = m.script(self.checksum)
        self.assertIn("statement_timeout='20s'", sql)
        self.assertIn("lock_timeout='5s'", sql)
        self.assertNotIn(':"service_role"', sql)
        self.assertNotIn("PERFORM public.configure_dispatcher(", sql)
        self.assertNotIn("EXECUTE $dispatch_schema_payload$", m.script(self.checksum, read_only=True))
        self.assertNotIn("NOTIFY pgrst", m.script(self.checksum, read_only=True))

    def test_result_requires_exact_receipt_and_zero_processing(self):
        valid = {"release": m.RELEASE, "sql_sha256": self.checksum,
                 "catalog_sha256": "a" * 64, "structure_sha256": "b" * 64,
                 "read_only": False, "legacy_finish_retained": True,
                 "business_rows_changed": 0, "processing_requested": False}
        with patch.object(m, "execute_sql", return_value=json.dumps(valid)):
            self.assertEqual(m.apply(object(), self.checksum), valid)
        for key, value in (("sql_sha256", "0" * 64), ("processing_requested", True),
                           ("legacy_finish_retained", False), ("read_only", True),
                           ("business_rows_changed", 1)):
            with patch.object(m, "execute_sql", return_value=json.dumps({**valid, key: value})):
                with self.assertRaises(m.SchemaError):
                    m.apply(object(), self.checksum)

    def test_real_transaction_preserves_data_legacy_authority_and_rejects_drift(self):
        def sql(source, read_only=False):
            checksum = hashlib.sha256(source.encode()).hexdigest()
            return m.script(checksum, source=source, read_only=read_only).replace(
                "current_database()<>'tenderdesk_app'", "current_database()<>'postgres'")

        old = LEGACY_DISPATCH_SQL
        self.assertEqual(hashlib.sha256(old.encode()).hexdigest(), LEGACY_DISPATCH_SHA256)
        self.assertNotIn("scheduled_at", old, "The fixture must retain the real legacy dispatcher")
        old = old.replace(':"service_role"', '"tdp_app_service"')
        variants = [
            ("UPDATE public.preserved_job SET attempts=0;", "DISPATCH_SCHEMA_EXISTING_ROWS_CHANGED"),
            ("GRANT SELECT ON public.preserved_job TO tdp_app_authenticated;", "DISPATCH_SCHEMA_EXISTING_STRUCTURE_CHANGED"),
            ("GRANT EXECUTE ON FUNCTION public.k8s_finish_dispatch(uuid,bigint,boolean) TO tdp_app_authenticated;", "DISPATCH_SCHEMA_EXISTING_STRUCTURE_CHANGED"),
            ("ALTER TABLE public.preserved_job ADD CONSTRAINT unexpected CHECK(attempts>=0);", "DISPATCH_SCHEMA_EXISTING_STRUCTURE_CHANGED"),
            ("ALTER TABLE app_private.k8s_dispatch_queue ADD COLUMN surprise text;", "DISPATCH_SCHEMA_UNEXPECTED_ADDITION"),
            ("CREATE TABLE public.unreviewed(id int);", "DISPATCH_SCHEMA_UNEXPECTED_ADDITION"),
            ("CREATE FUNCTION public.unreviewed() RETURNS int LANGUAGE sql AS 'SELECT 1';", "DISPATCH_SCHEMA_UNEXPECTED_ADDITION"),
            ("GRANT EXECUTE ON FUNCTION public.k8s_claim_maintenance() TO tdp_app_authenticated;", "DISPATCH_SCHEMA_RPC_AUTHORITY"),
            ("GRANT SELECT ON app_private.k8s_maintenance_queue TO tdp_app_authenticated;", "DISPATCH_SCHEMA_TABLE_AUTHORITY"),
            ("INSERT INTO app_private.k8s_dispatch_timers VALUES(gen_random_uuid(),now());", "DISPATCH_SCHEMA_INITIAL_STATE_CHANGED"),
            ("UPDATE app_private.k8s_maintenance_queue SET failures=2;", "DISPATCH_SCHEMA_INITIAL_STATE_CHANGED"),
        ]
        program = "process.on('uncaughtException',e=>{console.error(e.message);process.exit(1)});\n"
        program += "const old=" + json.dumps(old) + ";\n"
        program += "const release=" + json.dumps(sql(self.source)) + ";\n"
        program += "const verify=" + json.dumps(sql(self.source, True)) + ";\n"
        program += "const changed=" + json.dumps(sql(self.source + "\n-- different reviewed source\n")) + ";\n"
        program += "const variants=" + json.dumps([(sql(self.source + "\n" + suffix), code) for suffix, code in variants]) + ";\n"
        program += "const baseline=" + json.dumps(m.BASE_CATALOG) + ";const manifest=" + json.dumps(m.BASE_MANIFEST) + ";\n"
        program += "const catalog=" + json.dumps(m.CATALOG.replace(" INTO catalog_hash", "")) + ";\n"
        program += r"""
import {PGlite} from '@electric-sql/pglite';
const one=async(db,sql)=>Object.values((await db.query(sql)).rows[0])[0];
const db=new PGlite();
await db.exec(`create role tdp_app_owner nosuperuser nocreatedb nocreaterole nobypassrls;
 create role tdp_app_service;create role tdp_app_authenticated;create role tdp_app_anon;
 grant tdp_app_owner to tdp_app_service;
 alter schema public owner to tdp_app_owner;create schema app_private authorization tdp_app_owner;
 set role tdp_app_owner;set search_path=public;
 create table public.operations(scheduler_enabled boolean not null);
 insert into public.operations values(false);
 create table public.preserved_job(id int primary key,attempts int,payload jsonb);
 insert into public.preserved_job values(1,7,'{"saved":true,"paid_usage":"retained"}');
 create table app_private.dispatcher_settings(singleton boolean primary key,enabled boolean,
  project_url text,collection_hosts text[],secret_hash text,last_dispatch_at timestamptz);
 insert into app_private.dispatcher_settings values(true,false,'https://fixture.invalid','{}',repeat('a',64),null);
 create table app_private.application_release_history(release text primary key,migration_sha256 text not null,
  applied_at timestamptz not null default now());
 alter table app_private.application_release_history enable row level security;
 revoke all on app_private.application_release_history from public;`);
await db.query("insert into app_private.application_release_history(release,migration_sha256) values('proposal-delivery-reliability-v1',$1)",[manifest]);
await db.exec(old);
await db.exec("update app_private.k8s_dispatch_queue set generation=9,acknowledged_generation=5,failures=2");
const before=await one(db,catalog);
const bind=sql=>sql.replaceAll(baseline,before);
const reject=async(sql,code)=>{
 let received;try{await db.exec(bind(sql));}catch(e){received=e.message;await db.exec('rollback');}
 if(received!==code)throw Error('EXPECTED '+code+' GOT '+received);
 if(await one(db,'select attempts from public.preserved_job')!==7)throw Error('CUSTOMER_DATA_CHANGED');
};
await reject(verify,'DISPATCH_SCHEMA_RELEASE_MISSING');
for(const [sql,code] of variants){
 await reject(sql,code);
 if(await one(db,catalog)!==before)throw Error('FAILED_RELEASE_CHANGED_CATALOG');
 if(await one(db,"select to_regclass('app_private.k8s_maintenance_queue') is not null"))throw Error('FAILED_RELEASE_LEFT_SCHEMA');
}
await db.exec(bind(release));await db.exec(bind(release));await db.exec(bind(verify));
if(await one(db,"select count(*)::int from app_private.application_release_history")!==4)throw Error('REPLAY_LEDGER_CHANGED');
if(await one(db,"select count(*)::int from app_private.k8s_maintenance_queue")!==1)throw Error('MAINTENANCE_SINGLETON');
if(await one(db,"select generation::int from app_private.k8s_dispatch_queue")!==9)throw Error('GENERATION_RESET');
if(await one(db,"select acknowledged_generation::int from app_private.k8s_dispatch_queue")!==5)throw Error('ACK_RESET');
if(await one(db,"select scheduler_enabled from public.operations"))throw Error('PROCESSING_ACTIVATED');
if(await one(db,"select enabled from app_private.dispatcher_settings"))throw Error('DISPATCH_ACTIVATED');
if(await one(db,"select has_function_privilege('tdp_app_authenticated','public.k8s_claim_maintenance()','execute')"))throw Error('BROWSER_RPC_ACCESS');
await db.exec("insert into app_private.k8s_dispatch_timers values(gen_random_uuid(),'2100-01-01');update app_private.k8s_dispatch_queue set generation=10;update app_private.k8s_maintenance_queue set generation=3,failures=2,next_attempt_at='2100-01-01'");
await db.exec(bind(release));await db.exec(bind(verify));
if(await one(db,"select due_at>'2099-01-01' from app_private.k8s_dispatch_timers")!==true)throw Error('REPLAY_ERASED_TIMER');
if(await one(db,"select generation::int from app_private.k8s_maintenance_queue")!==3)throw Error('REPLAY_RESET_MAINTENANCE');
await reject(changed,'DISPATCH_SCHEMA_RECEIPT_CHECKSUM');
await db.exec("grant execute on function public.k8s_claim_maintenance() to tdp_app_authenticated");
await reject(verify,'DISPATCH_SCHEMA_POST_CATALOG_CHANGED');
await db.exec("revoke execute on function public.k8s_claim_maintenance() from tdp_app_authenticated");
await db.exec(bind(verify));
const saved=await one(db,"select migration_sha256 from app_private.application_release_history where release='proposal-dispatch-v2-20261108-catalog'");
await db.exec("delete from app_private.application_release_history where release='proposal-dispatch-v2-20261108-catalog'");
await reject(release,'DISPATCH_SCHEMA_PARTIAL_RECEIPT');
await db.query("insert into app_private.application_release_history(release,migration_sha256) values('proposal-dispatch-v2-20261108-catalog',$1)",[saved]);
await db.exec(bind(verify));
await db.close();
console.log('atomic_dispatch_schema_scenarios_passed');
"""
        completed = subprocess.run(["node", "--input-type=module"], input=program,
                                   capture_output=True, text=True, cwd=m.ROOT / "backend", timeout=90)
        self.assertEqual(completed.returncode, 0, completed.stderr[-7000:])
        self.assertIn("atomic_dispatch_schema_scenarios_passed", completed.stdout)


if __name__ == "__main__":
    unittest.main()
