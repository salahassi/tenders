#!/usr/bin/env python3
"""Actual PostgreSQL races for the bounded-batch release cutover.

Synthetic data only, one owned capped network-none container, no HTTP/provider
calls. Reuse the canonical race fixture and apply all prior migrations once;
database clones isolate the cutover cases. This is not API capacity evidence.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid

from ordinary_export_races import setup
from postgres_races import PostgresFixture, IMAGE, OWNER, docker, literal
from upstream_batch_capacity import memory_sample, state

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = "20261104212818_bounded_command_batch_results.sql"
ZERO_ERROR = "DELIVERY_RELEASE_LEGACY_BATCH_PRESENT"
OLD_ERROR = "TRANSPORT_UPGRADE_REQUIRED"


def require(value, message):
    if not value:
        raise AssertionError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Session:
    """Tagged interactive psql with bounded marker waits and captured output."""

    def __init__(self, fixture, tag):
        self.fixture = fixture
        self.tag = tag
        self.events = queue.Queue()
        self.stdout = []
        self.stderr = []
        self.process = subprocess.Popen(
            fixture.psql_args(), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )

        def capture(source, target, notify=False):
            retained = 0
            for line in source:
                if retained < 65536:
                    target.append(line[:65536 - retained])
                    retained += len(line)
                if notify:
                    self.events.put(line.rstrip("\r\n"))
            if notify:
                self.events.put(None)

        self.threads = [
            threading.Thread(target=capture, args=(self.process.stdout, self.stdout, True), daemon=True),
            threading.Thread(target=capture, args=(self.process.stderr, self.stderr), daemon=True),
        ]
        for thread in self.threads:
            thread.start()
        self.send("set application_name=" + literal(tag) + ";set statement_timeout='30s';set lock_timeout='15s';")

    def send(self, sql):
        self.process.stdin.write(sql + "\n")
        self.process.stdin.flush()

    def marker(self, expected, seconds=15):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                line = self.events.get(timeout=min(.2, max(.001, deadline - time.monotonic())))
            except queue.Empty:
                continue
            if line == expected:
                return
            if line is None:
                raise RuntimeError("Session ended before marker: " + expected + " " + "".join(self.stderr))
        raise TimeoutError("Session marker not observed: " + expected)

    def finish(self, sql="", seconds=20):
        if self.process.poll() is None:
            try:
                self.send(sql + "\n\\q")
                self.process.stdin.close()
            except BrokenPipeError:
                pass
        self.process.wait(timeout=seconds)
        for thread in self.threads:
            thread.join(timeout=2)
        return subprocess.CompletedProcess([], self.process.returncode, "".join(self.stdout), "".join(self.stderr))

    def close(self):
        if self.process.poll() is None:
            try:
                self.finish("rollback;", seconds=3)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=3)
        for thread in self.threads:
            thread.join(timeout=2)
        for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
            if pipe and not pipe.closed:
                pipe.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def activity(fixture, tag):
    return fixture.value("""select coalesce((select jsonb_build_object(
      'pid',a.pid,'state',a.state,'wait_event_type',a.wait_event_type,'wait_event',a.wait_event,
      'blocking_pids',to_jsonb(pg_blocking_pids(a.pid)),
      'receipt_locks',(select coalesce(jsonb_agg(jsonb_build_object('mode',l.mode,'granted',l.granted)),'[]')
        from pg_locks l where l.pid=a.pid and l.relation='app_private.idempotency_records'::regclass))
      from pg_stat_activity a where a.datname=current_database() and a.application_name=""" + literal(tag) + "),'null'::jsonb)")


def wait_for_lock(fixture, session, predicate):
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        observed = activity(fixture, session.tag)
        if observed and observed["wait_event_type"] == "Lock" and predicate(observed):
            return observed
        if session.process.poll() is not None:
            raise AssertionError("Contender exited before the required database lock wait")
        time.sleep(.03)
    raise TimeoutError("Required pg_stat_activity/pg_locks wait was not observed")


def business_state(fixture, export_id):
    return fixture.value(f"""select jsonb_build_object(
      'revision',(select revision from public.export_requests where id={literal(export_id)}),
      'export_hash',(select encode(sha256(convert_to(to_jsonb(e)::text,'UTF8')),'hex') from public.export_requests e where id={literal(export_id)}),
      'audit_count',(select count(*) from public.audit_events),
      'audit_hash',(select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(a)::text,'' order by id),''),'UTF8')),'hex') from public.audit_events a),
      'command_count',(select count(*) from app_private.idempotency_records where method='COMMAND'),
      'legacy_batch_count',(select count(*) from app_private.idempotency_records where method='BATCH' and route='commands'),
      'idempotency_hash',(select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(r)::text,'' order by workspace_id,actor_id,method,route,key),''),'UTF8')),'hex') from app_private.idempotency_records r))""")


def cutover_catalog(fixture):
    return fixture.value("""select jsonb_build_object(
      'batch_table',to_regclass('app_private.command_batch_receipts')::text,
      'prepare_function',to_regprocedure('public.app_batch_prepare(jsonb,text)')::text,
      'insert_trigger',(select count(*) from pg_trigger where tgrelid='app_private.idempotency_records'::regclass and tgname='reject_legacy_batch_insert'),
      'old_entrypoint_hash',(select encode(sha256(convert_to(string_agg(pg_get_functiondef(p.oid),'' order by p.oid),'UTF8')),'hex')
        from pg_proc p where p.oid in ('public.app_batch(jsonb,text)'::regprocedure,'app_private.apply_batch(jsonb,text)'::regprocedure)))""")


def commands_for(export_id, revision, count=1):
    return [{"operation": "export.renew", "input": {"id": export_id, "expected_revision": revision + index}} for index in range(count)]


def as_user(sql):
    return "begin;set local role authenticated;set local request.jwt.claim.sub=" + literal(OWNER) + ";" + sql


def old_call(commands, key, entrypoint="public.app_batch"):
    require(entrypoint in ("public.app_batch", "app_private.apply_batch"), "Unreviewed old entrypoint")
    return "select jsonb_typeof(" + entrypoint + "(" + literal(commands) + "::jsonb," + literal(key) + "));"


def assert_error(result, code):
    require(result.returncode != 0 and code in result.stderr, "Expected typed failure " + code + ": " + result.stderr)


def run_cases(baseline, export_id, cutover_sql, cases):
    def clone(label):
        name = "races_cutover_" + label + "_" + uuid.uuid4().hex[:10]
        baseline.sql('create database "' + name + '" template "' + baseline.database + '";')
        fixture = PostgresFixture(repository=baseline.repository, container=baseline.container, database=name)
        fixture.workspace = baseline.workspace
        fixture.migrations = list(baseline.migrations)
        return fixture

    a = clone("cached")
    before = business_state(a, export_id)
    key = "synthetic-cached-before-receipt-" + uuid.uuid4().hex
    commands = commands_for(export_id, before["revision"])
    with Session(a, "cutover_holder_" + uuid.uuid4().hex[:10]) as holder, Session(a, "cutover_cached_" + uuid.uuid4().hex[:10]) as old:
        # Compile the genuine old body in this backend before taking the race
        # lock. Its invalid empty input performs no command/receipt writes.
        old.send(as_user("""do $warm_old_batch$ begin
          begin perform public.app_batch('[]'::jsonb,'synthetic-cache-warmup');
            raise exception 'WARMUP_EXPECTED_INVALID_INPUT';
          exception when others then
            if sqlerrm<>'INVALID_INPUT' then raise;end if;
          end;
        end $warm_old_batch$;""") + "commit;\n\\echo OLD_BODY_WARMED")
        old.marker("OLD_BODY_WARMED")
        require(business_state(a, export_id) == before, "Old-body compilation warmup changed fixture state")
        holder.send(f"begin;select 1 from public.workspaces where id={literal(a.workspace)} for update;\n\\echo WORKSPACE_HELD")
        holder.marker("WORKSPACE_HELD")
        holder_pid = activity(a, holder.tag)["pid"]
        old.send(as_user(old_call(commands, key)) + "commit;\n\\echo OLD_COMMITTED")
        observed = wait_for_lock(a, old, lambda row: holder_pid in row["blocking_pids"] and not row["receipt_locks"])
        a.sql(cutover_sql)
        catalog = cutover_catalog(a)
        require(catalog["insert_trigger"] == 1 and catalog["batch_table"] is not None, "Cutover did not commit while the old body waited")
        require(holder.finish("commit;").returncode == 0, "Workspace holder failed")
        rejected = old.finish()
        assert_error(rejected, OLD_ERROR)
    require(business_state(a, export_id) == before, "Cached old body did not roll back business/audit/command receipts")
    cases.append({"case": "cached-old-body-before-idempotency-access", "passed": True,
                  "observed_wait": observed, "old_body_warmed_without_writes": True,
                  "cutover_committed_before_waiter_release": True,
                  "typed_error": OLD_ERROR, "business_audit_command_receipts_unchanged": True})

    # Both previously exposed entrypoints stay bounded after replacement.
    for entrypoint in ("public.app_batch", "app_private.apply_batch"):
        rejected = a.sql(as_user(old_call(commands, "synthetic-old-entry-" + uuid.uuid4().hex, entrypoint)) + "commit;", False)
        assert_error(rejected, OLD_ERROR)
        require(business_state(a, export_id) == before, "An old entrypoint changed business state")
    new_commands = commands_for(export_id, before["revision"], 2)
    new_key = "synthetic-new-path-" + uuid.uuid4().hex
    prepare = as_user("select public.app_batch_prepare(" + literal(new_commands) + "::jsonb," + literal(new_key) + ");") + "commit;"
    manifest = a.value(prepare)
    require(manifest["result_count"] == 2 and manifest["chunk_bytes"] == 262144, "New manifest shape changed")
    for index, descriptor in enumerate(manifest["results"]):
        require(descriptor["ordinal"] == index and descriptor["chunk_count"] == 1, "Tiny fixture must return one bounded chunk per result")
        chunk = a.value(as_user(f"select public.app_batch_result_chunk({literal(manifest['receipt_id'])},{index},0);") + "commit;")
        raw = base64.b64decode(chunk["data_base64"], validate=True)
        require(len(raw) == descriptor["byte_length"] == chunk["byte_length"], "New chunk length mismatch")
        require(sha(raw) == descriptor["sha256"] == chunk["sha256"], "New chunk hash mismatch")
        value = json.loads(raw)
        require(value["revision"] == before["revision"] + index + 1 and value["id"] == export_id, "New result order/value mismatch")
    after_new = business_state(a, export_id)
    require(after_new["revision"] == before["revision"] + 2 and after_new["command_count"] == before["command_count"] + 2, "New path did not execute each command once")
    require(after_new["legacy_batch_count"] == 0, "New path created an aggregate receipt")
    require(a.value(prepare) == manifest and business_state(a, export_id) == after_new, "New replay repeated commands or changed manifest")
    cases.append({"case": "replaced-entrypoints-and-bounded-new-path", "passed": True,
                  "old_entrypoints": ["public.app_batch", "app_private.apply_batch"],
                  "new_results": 2, "chunk_hashes_verified": True, "replay_no_extra_writes": True})

    b = clone("commit")
    before = business_state(b, export_id)
    catalog_before = cutover_catalog(b)
    key = "synthetic-old-uncommitted-" + uuid.uuid4().hex
    with Session(b, "cutover_writer_" + uuid.uuid4().hex[:10]) as old, Session(b, "cutover_controller_" + uuid.uuid4().hex[:10]) as controller:
        old.send(as_user(old_call(commands_for(export_id, before["revision"]), key)) + "\n\\echo OLD_RECEIPT_WRITTEN")
        old.marker("OLD_RECEIPT_WRITTEN")
        writer = activity(b, old.tag)
        require(any(lock["granted"] and lock["mode"] == "RowExclusiveLock" for lock in writer["receipt_locks"]), "Old transaction did not hold its real receipt-write lock")
        controller.send(cutover_sql)
        observed = wait_for_lock(b, controller, lambda row: writer["pid"] in row["blocking_pids"] and any(
            not lock["granted"] and lock["mode"] == "AccessExclusiveLock" for lock in row["receipt_locks"]))
        require(old.finish("commit;").returncode == 0, "Old writer did not commit")
        rejected = controller.finish()
        assert_error(rejected, ZERO_ERROR)
    after = business_state(b, export_id)
    require(after["revision"] == before["revision"] + 1 and after["legacy_batch_count"] == 1, "Committed old business/receipt was not preserved")
    require(after["command_count"] == before["command_count"] + 1, "Committed old command receipt changed")
    require(cutover_catalog(b) == catalog_before, "Refused release persisted migration objects or changed old entrypoints")
    cases.append({"case": "early-lock-sees-old-commit-in-fresh-repeatable-read-snapshot", "passed": True,
                  "observed_wait": observed, "typed_error": ZERO_ERROR,
                  "committed_old_revision_and_receipts_preserved": True, "migration_rolled_back": True})

    c = clone("existing")
    key = "synthetic-existing-expired-" + uuid.uuid4().hex
    revision = business_state(c, export_id)["revision"]
    c.sql(as_user(old_call(commands_for(export_id, revision), key)) + "commit;")
    # Expiry cannot turn authoritative historical bytes into permission to
    # normalize, rewrite, delete, or rerun a committed batch during deployment.
    c.sql("update app_private.idempotency_records set expires_at=now()-interval '1 day' where method='BATCH' and route='commands' and key=" + literal(key))
    before = business_state(c, export_id)
    catalog_before = cutover_catalog(c)
    rejected = c.sql(cutover_sql, False)
    assert_error(rejected, ZERO_ERROR)
    require(business_state(c, export_id) == before and cutover_catalog(c) == catalog_before, "Preexisting receipt refusal rewrote history or left DDL")
    cases.append({"case": "preexisting-expired-legacy-receipt-refuses-without-rewrite", "passed": True,
                  "typed_error": ZERO_ERROR, "exact_business_audit_receipt_hashes_preserved": True,
                  "migration_rolled_back": True})
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    migration = ROOT / "backend/supabase/migrations" / MIGRATION
    release_path = ROOT / "backend/scripts/ops/proposal-delivery-release.py"
    spec = importlib.util.spec_from_file_location("batch_cutover_release", release_path)
    release = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = release
    spec.loader.exec_module(release)
    early = release.BATCH_EARLY_LOCK_SQL
    zero = release.BATCH_ZERO_CHECK_SQL
    # SET and LOCK precede every snapshot-taking statement in this controller.
    cutover_sql = ("begin isolation level repeatable read;set local statement_timeout='30s';set local lock_timeout='15s';\n"
                   + early + "\n" + zero + "\n" + migration.read_text() + "\ncommit;")
    paths = [Path(__file__), release_path, migration,
             ROOT / "backend/scripts/testing/postgres_races.py",
             ROOT / "backend/scripts/testing/ordinary_export_races.py",
             ROOT / "backend/scripts/testing/upstream_batch_capacity.py"]
    paths += sorted(path for path in migration.parent.glob("[0-9]*_*.sql") if path.name < MIGRATION)
    hashes = {str(path.relative_to(ROOT)): sha(path.read_bytes()) for path in paths}
    container = "tdp-races-batch-cutover-" + uuid.uuid4().hex[:12]
    receipt = {"version": 1, "scope": "synthetic_actual_postgresql_cached_batch_cutover_races",
               "passed": False, "cases": [], "image": IMAGE, "source_hashes": hashes,
               "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
               "limits": {"memory_bytes": 1073741824, "cpus": 1, "tmpfs_bytes": 536870912,
                          "swap": False, "pids": 128, "network": "none", "published_ports": []},
               "shared_early_lock_sha256": sha(early.encode()), "shared_zero_check_sha256": sha(zero.encode()),
               "hosted_calls": 0, "provider_calls": 0, "api_capacity_qualified": False,
               "managed_database_capacity_qualified": False}
    launched = False
    try:
        require(docker("image", "inspect", IMAGE).returncode == 0, "Pinned PostgreSQL image must already be cached")
        run = docker("run", "-d", "--name", container, "--network", "none", "--pull=never",
                     "--memory=1g", "--memory-swap=1g", "--cpus=1", "--pids-limit=128",
                     "--label", "tenderdesk.synthetic-batch-cutover=true",
                     "--tmpfs", "/var/lib/postgresql/data:rw,size=536870912",
                     "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE,
                     "postgres", "-c", "shared_buffers=32MB", "-c", "max_connections=12",
                     "-c", "work_mem=4MB", "-c", "statement_timeout=30s")
        require(run.returncode == 0, "Owned PostgreSQL container could not start")
        launched = True
        with tempfile.TemporaryDirectory(prefix="tdp-batch-prior-migrations-") as temporary:
            staged = Path(temporary)
            target = staged / "backend/supabase/migrations"
            target.mkdir(parents=True)
            for path in migration.parent.glob("[0-9]*_*.sql"):
                if path.name < MIGRATION:
                    shutil.copyfile(path, target / path.name)
            fixture = PostgresFixture(repository=staged, container=container).start()
            receipt["server_version"] = fixture.scalar("show server_version")
            receipt["prior_migrations"] = fixture.migrations
            _, _, payload = setup(fixture)
            payload["volume"] = "combined"
            export_id = fixture.command("export.prepare", payload)["id"]
            run_cases(fixture, export_id, cutover_sql, receipt["cases"])
            receipt["passed"] = len(receipt["cases"]) == 4 and all(case["passed"] for case in receipt["cases"])
    except Exception as error:
        receipt["error"] = {"type": type(error).__name__, "message": str(error)[:4000]}
    finally:
        if launched:
            receipt["final_state"] = state(container)
            receipt["memory"] = memory_sample(container)
            logs = docker("logs", "--tail", "50", container)
            (output / "postgres.log").write_text(logs.stdout + logs.stderr)
            docker("rm", "-f", "-v", container)
            receipt["cleanup_verified"] = docker("inspect", container).returncode != 0
        else:
            receipt["cleanup_verified"] = True
        receipt["source_unchanged"] = hashes == {str(path.relative_to(ROOT)): sha(path.read_bytes()) for path in paths}
        receipt["passed"] = receipt["passed"] and receipt["cleanup_verified"] and receipt["source_unchanged"]
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"receipt": str(output / "receipt.json"), "passed": receipt["passed"],
                      "cleanup_verified": receipt["cleanup_verified"]}))
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
