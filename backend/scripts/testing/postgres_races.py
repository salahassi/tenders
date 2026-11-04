#!/usr/bin/env python3
"""Isolated, real multi-session PostgreSQL harness; synthetic fixtures only.

No host port, remote endpoint, credentials, volumes or customer data are accepted.
Run from any directory: python3 backend/scripts/testing/postgres_races.py --keep-container
Other suites may import PostgresFixture and use a fresh database in the same
container with --container <printed name>. Every database must start empty.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

IMAGE = "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94"
OWNER = "00000000-0000-4000-8000-000000000001"
STUBS = """
do $$begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role bypassrls;end if;
end$$;
create schema auth;create schema storage;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
create table auth.identities(user_id uuid,provider text,identity_data jsonb);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema auth to authenticated;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;grant insert,select on storage.objects to authenticated;
"""

def literal(value):
    if value is None:
        return "null"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False)
    return "'" + str(value).replace("'", "''") + "'"


def docker(*args, **kwargs):
    env = dict(os.environ)
    for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
        env.pop(key, None)
    return subprocess.run(["docker", "--host=unix:///var/run/docker.sock", *args], env=env,
                          text=True, capture_output=True, timeout=60, **kwargs)


class PostgresFixture:
    def __init__(self, repository=None, container=None, database=None):
        self.repository = Path(repository or Path(__file__).resolve().parents[3])
        self.container = container or "tdp-races-" + uuid.uuid4().hex[:12]
        self.database = database or "races_" + uuid.uuid4().hex[:12]
        self.owns_container = container is None
        if not re.fullmatch(r"tdp-races-[a-z0-9-]{1,48}", self.container):
            raise ValueError("Only an isolated tdp-races-* container is allowed")
        if not re.fullmatch(r"races_[a-z0-9_]{1,48}", self.database):
            raise ValueError("Only a synthetic races_* database is allowed")
        self.migrations = []
        self.workspace = None

    def start(self):
        if self.owns_container:
            run = docker("run", "--rm", "-d", "--name", self.container, "--network", "none",
                         "--label", "tenderdesk.synthetic-races=true", "--tmpfs", "/var/lib/postgresql/data:rw",
                         "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE)
            if run.returncode:
                raise RuntimeError(run.stderr)
        inspect = docker("inspect", "--format", '{{json .HostConfig}}', self.container)
        config = json.loads(inspect.stdout)
        if config["NetworkMode"] != "none" or config.get("PortBindings"):
            raise RuntimeError("Refusing a container with network/host-port exposure")
        for _ in range(100):
            # The official image briefly starts a temporary initialization
            # server before replacing PID 1 with the final postmaster. A ready
            # response from that temporary socket is not stable acceptance.
            pid1 = docker("exec", self.container, "cat", "/proc/1/comm")
            if (pid1.returncode == 0 and pid1.stdout.strip() == "postgres"
                    and docker("exec", self.container, "pg_isready", "-U", "postgres").returncode == 0):
                break
            time.sleep(.1)
        else:
            raise RuntimeError("Local PostgreSQL did not become ready")
        created = docker("exec", self.container, "createdb", "-U", "postgres", self.database)
        if created.returncode:
            raise RuntimeError("Fresh database required: " + created.stderr)
        self.sql(STUBS)
        paths = sorted((self.repository / "backend/supabase/migrations").glob("[0-9]*_*.sql"))
        if len({p.name.split("_")[0] for p in paths}) != len(paths):
            raise RuntimeError("Duplicate migration versions")
        for path in paths:
            data = path.read_text()
            self.sql(data)
            self.migrations.append({"name": path.name, "sha256": hashlib.sha256(data.encode()).hexdigest()})
        self.sql(f"insert into auth.users values({literal(OWNER)},'owner@example.test',now());"
                 f"insert into auth.identities values({literal(OWNER)},'email',jsonb_build_object('sub',{literal(OWNER)}));")
        self.workspace = self.scalar(f"select public.bootstrap_workspace({literal(OWNER)},'Synthetic PostgreSQL race fixture')")
        return self

    def psql_args(self):
        return ["docker", "--host=unix:///var/run/docker.sock", "exec", "-i", self.container,
                "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", self.database]

    def sql(self, query, check=True):
        result = subprocess.run(self.psql_args(), input=query, text=True, capture_output=True, timeout=60)
        if check and result.returncode:
            raise RuntimeError(result.stderr)
        return result

    def scalar(self, query):
        return self.sql(query).stdout.strip()

    def value(self, query):
        return json.loads(self.scalar(query))

    def command_sql(self, operation, payload, key=None):
        return ("begin;set local role authenticated;"
                f"set local request.jwt.claim.sub={literal(OWNER)};"
                f"select public.app_command({literal(operation)},{literal(payload)}::jsonb,{literal(key or str(uuid.uuid4()))});commit;")

    def command(self, operation, payload, key=None):
        return self.value(self.command_sql(operation, payload, key))

    def race(self, statements, before_release=""):
        """Both sessions must demonstrably wait on the real workspace row lock.

        No timing-only 'concurrent' assertion: pg_stat_activity must observe all
        contenders waiting before the holder commits. A caller can stage a human
        edit/revocation while holding that lock before releasing the contenders.
        """
        holder = subprocess.Popen(self.psql_args(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True, bufsize=1)
        try:
            holder.stdin.write(f"begin;select 1 from public.workspaces where id={literal(self.workspace)} for update;\n\\echo HELD\n")
            holder.stdin.flush()
            while holder.stdout.readline().strip() != "HELD":
                if holder.poll() is not None:
                    raise RuntimeError("Lock holder exited")
            with ThreadPoolExecutor(max_workers=len(statements)) as pool:
                futures = [pool.submit(self.sql, statement, False) for statement in statements]
                deadline = time.monotonic() + 15
                observed = False
                while time.monotonic() < deadline:
                    waiting = int(self.scalar("select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock'"))
                    if waiting >= len(statements):
                        observed = True
                        break
                    if any(f.done() for f in futures):
                        break
                    time.sleep(.03)
                holder.stdin.write(before_release + "\ncommit;\n\\q\n")
                holder.stdin.flush()
                results = [future.result(timeout=30) for future in futures]
            if not observed:
                raise AssertionError("Not all contenders were observed waiting on real database locks")
            return results
        finally:
            if holder.poll() is None:
                holder.communicate("rollback;\n\\q\n", timeout=10)

    def opportunity(self, description="Synthetic RFP: implement two approval stages and preserve the handover condition."):
        source = self.command("source.create", {"name": "Synthetic manual", "kind": "manual"})
        return self.command("opportunity.create", {"source_id": source["id"], "title": "Synthetic race procurement",
                            "description": description, "reference": "SYNTHETIC", "language": "en", "decision": "shortlisted"})

    def upload(self, opportunity):
        text = "Synthetic scope: implement two approval stages. Do not omit the handover condition."
        digest = hashlib.sha256(text.encode()).hexdigest()
        doc = self.command("document.prepare", {"eligibility_attested": True, "kind": "rfp",
                           "opportunity_id": opportunity["id"], "original_name": "synthetic.txt", "mime_type": "text/plain",
                           "size": len(text), "hash": digest})
        return self.value(f"select public.accept_uploaded_document({literal(doc['id'])},{literal(OWNER)},{literal(digest)},"
                          f"{len(text)},{literal(text)},'ready',{literal(str(uuid.uuid4()))})")

    def receipt(self, cases):
        return {"fixture": "synthetic-only", "level": "real-postgresql-multiple-sessions",
                "image": IMAGE, "server_version": self.scalar("show server_version"),
                "container": self.container, "database": self.database, "network": "none", "published_ports": [],
                "migrations": self.migrations, "cases": cases}

    def close(self, keep=False):
        if self.owns_container and not keep:
            docker("rm", "-f", self.container)


def run_delivery(f):
    results = []
    opportunity = f.opportunity()
    payload = {"opportunity_id": opportunity["id"], "expected_revision": opportunity["revision"]}
    key = str(uuid.uuid4())
    sql = f.command_sql("delivery.snapshot.prepare", payload, key)
    raced = f.race([sql, sql])
    assert all(result.returncode == 0 for result in raced), [r.stderr for r in raced]
    snapshots = [json.loads(result.stdout) for result in raced]
    assert snapshots[0] == snapshots[1]
    snapshot = snapshots[0]
    assert f.scalar("select count(*) from public.proposal_delivery_snapshots") == "1"
    assert f.scalar("select count(*) from public.audit_events where action='delivery.snapshot.created'") == "1"
    assert f.scalar("select count(*) from public.provider_usage") == "0"
    results.append({"case": "AR-01/AR-05 duplicate prepare", "passed": True, "contenders_observed_waiting": 2,
                    "snapshot_id": snapshot["id"], "content_hash": snapshot["content_hash"], "snapshots": 1, "audit_events": 1})
    f.upload(opportunity)
    generation = f.command("proposal.generate", {"id": opportunity["id"], "expected_revision": opportunity["revision"]})
    proposal = f.value(f"select to_jsonb(p) from public.proposals p where id={literal(snapshot['proposal_id'])}")
    assert proposal["active_version_id"] is None and generation["base_version_id"] is None
    assert proposal["active_delivery_snapshot_id"] != snapshot["id"]
    job = f.value("select public.claim_backend_job()")
    context = f.value(f"select public.generation_context({literal(job['id'])},{literal(job['lease_token'])})")
    assert context["plan"]["id"] == generation["id"]
    assert context["plan"]["base_version_id"] is None
    results.append({"case": "AR-01 early delivery does not stale its generation base", "passed": True,
                    "plan_id": generation["id"], "active_version_id": None, "base_version_id": None})
    # Two synthetic already-accepted graph results arrive independently. This
    # exercises publication, not model acceptance or provider semantics.
    statements, expected_units = [], []
    for ordinal in (1, 2):
        step_input = {"section": {"key": f"part-{ordinal}", "title": f"Synthetic part {ordinal}", "volume": "technical"}}
        job_id = f.scalar(f"select app_private.enqueue_generation(p,'draft_section',{literal(step_input)}::jsonb) from public.generation_plans p where id={literal(generation['id'])}")
        step_id = f.scalar(f"select id from public.generation_steps where job_id={literal(job_id)}")
        output = {"key": f"part-{ordinal}", "title": f"Synthetic part {ordinal}",
                  "content_blocks": [{"type": "paragraph", "text": f"Synthetic accepted response {ordinal}; preserve this condition."}]}
        thread = uuid.uuid4().hex.ljust(64, "b")
        f.sql(f"update public.jobs set checkpoint='{{\"model_executor\":2}}' where id={literal(job_id)};"
              f"insert into app_private.model_graph_threads(id,workspace_id,job_id,input_hash,task,status) values({literal(thread)},{literal(f.workspace)},{literal(job_id)},{literal(generation['input_hash'])},'draft_section','accepted');")
        result_id = f.scalar(f"insert into app_private.model_graph_results(thread_id,result_key,value,content_hash) values({literal(thread)},'accepted',{literal(output)}::jsonb,encode(sha256(convert_to(({literal(output)}::jsonb)::text,'UTF8')),'hex')) returning id")
        f.sql(f"update app_private.model_graph_threads set result_id={literal(result_id)} where id={literal(thread)};")
        statements.append(f"begin;update public.generation_steps set status='completed',output={literal(output)}::jsonb where id={literal(step_id)};commit;")
        expected_units.append(step_id)
    raced = f.race(statements)
    assert all(result.returncode == 0 for result in raced), [r.stderr for r in raced]
    proposal = f.value(f"select to_jsonb(p) from public.proposals p where id={literal(proposal['id'])}")
    saved = f.value(f"select payload from public.proposal_delivery_snapshots where id={literal(proposal['active_delivery_snapshot_id'])}")
    units = [section for section in saved["sections"] if section["kind"] == "accepted_unit"]
    assert {unit["provenance"]["step_id"] for unit in units} == set(expected_units)
    assert saved["substantive_complete"] is False and saved["assurance_state"] == "legacy_reviewed"
    assert f.value(f"select payload from public.proposal_delivery_snapshots where id={literal(snapshot['id'])}") == snapshot["payload"]
    repeated = f.command("delivery.snapshot.prepare", payload)
    assert repeated["id"] == proposal["active_delivery_snapshot_id"]
    results.append({"case": "AR-03 concurrent accepted siblings survive repeated prepare", "passed": True,
                    "contenders_observed_waiting": 2, "accepted_units": 2, "assurance_state": "legacy_reviewed", "substantive_complete": False})
    refresh = f.command_sql("delivery.snapshot.refresh", {"proposal_id": proposal["id"], "expected_revision": proposal["revision"],
                           "expected_delivery_revision": proposal["delivery_revision"]})
    edit = f"update public.proposals set revision=revision+1 where id={literal(proposal['id'])};"
    raced = f.race([refresh], before_release=edit)
    assert raced[0].returncode != 0 and "REVISION_CONFLICT" in raced[0].stderr
    assert f.value(f"select to_jsonb(p) from public.proposals p where id={literal(proposal['id'])}")["active_delivery_snapshot_id"] == proposal["active_delivery_snapshot_id"]
    results.append({"case": "AR-05 concurrent human edit rejects stale delivery writer", "passed": True, "contenders_observed_waiting": 1})
    raced = f.race([sql], before_release=f"update public.opportunities set description='Synthetic changed scope' where id={literal(opportunity['id'])};")
    assert raced[0].returncode != 0 and "STALE_INPUT" in raced[0].stderr
    results.append({"case": "AR-04 source change denies replay after lock release", "passed": True, "contenders_observed_waiting": 1})
    raced = f.race([sql], before_release=f"update public.memberships set active=false where user_id={literal(OWNER)};")
    assert raced[0].returncode != 0 and "ROLE_FORBIDDEN" in raced[0].stderr
    results.append({"case": "AR-04 membership revocation denies in-flight replay", "passed": True, "contenders_observed_waiting": 1})
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path)
    parser.add_argument("--container")
    parser.add_argument("--database")
    parser.add_argument("--keep-container", action="store_true")
    parser.add_argument("--init-only", action="store_true")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    fixture = PostgresFixture(args.repository, args.container, args.database)
    try:
        fixture.start()
        cases = [] if args.init_only else run_delivery(fixture)
        receipt = fixture.receipt(cases)
        if args.receipt:
            args.receipt.parent.mkdir(parents=True, exist_ok=True)
            args.receipt.write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps({key: value for key, value in receipt.items() if key != "migrations"}, indent=2))
    finally:
        fixture.close(args.keep_container)


if __name__ == "__main__":
    main()
