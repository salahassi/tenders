#!/usr/bin/env python3
"""Real-PG visibility and fixed-marker drain proof in one owned local container.

Uses canonical database/login names only inside a fresh network-none PostgreSQL
container. No production connection, row payload, query text, backend termination
or timing/capacity qualification is involved.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from types import SimpleNamespace
import uuid

from command_batch_cutover_races import Session, require
from postgres_races import IMAGE, docker, literal
from upstream_batch_capacity import memory_sample, state

ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / "backend/scripts/ops/command-batch-cutover.py"


class LocalPg:
    def __init__(self, container, role="postgres", database="tenderdesk_app"):
        require(re.fullmatch(r"tdp-races-activity-[a-f0-9]{12}", container), "Owned local container required")
        require(role in ("postgres", "tdp_app_authenticator", "synthetic_hidden_monitor", "synthetic_usage_only", "synthetic_set_only"), "Unreviewed local role")
        require(database in ("postgres", "tenderdesk_app"), "Unreviewed local database")
        self.container, self.role, self.database = container, role, database

    def psql_args(self):
        return ["docker", "--host=unix:///var/run/docker.sock", "exec", "-i", self.container,
                "psql", "-XAtq", "-v", "ON_ERROR_STOP=1", "-U", self.role, "-d", self.database]

    def sql(self, query, check=True):
        result = subprocess.run(self.psql_args(), input=query, text=True, capture_output=True, timeout=15)
        if check and result.returncode:
            raise RuntimeError(result.stderr)
        return result

    def value(self, query):
        return json.loads(self.sql(query).stdout)


class Observer:
    """The production helper's SQL transport backed by actual isolated psql."""
    def __init__(self, pg):
        self.pg = pg
        self.observations = []
        self.first_pending = threading.Event()

    def sql(self, pod, query):
        require(pod == self.pg.container, "Unexpected client identity")
        result = self.pg.sql(query).stdout.strip()
        observation = json.loads(result)
        self.observations.append(observation)
        if observation.get("old_transactions", 0):
            self.first_pending.set()
        return result


def expect_error(callback, code):
    try:
        callback()
    except Exception as error:
        require(code in str(error), "Wrong fail-closed error: " + str(error))
        return
    raise AssertionError("Required fail-closed error was not raised: " + code)


def pending(pg):
    return pg.value("""select coalesce(jsonb_agg(jsonb_build_object('pid',pid,'state',state,
      'transaction_started',xact_start is not null) order by pid),'[]') from pg_stat_activity
      where datname='tenderdesk_app' and usename='tdp_app_authenticator'""")


def role_switch_visibility(admin, app, monitor, helper, client, cases):
    """Observe real active lock waits and idle transactions after role switches."""
    with ExitStack() as stack:
        blocker = stack.enter_context(Session(admin, "synthetic_activity_blocker"))
        blocker.send("begin;select pg_advisory_xact_lock(819221);\n\\echo BLOCKER_READY")
        blocker.marker("BLOCKER_READY")
        sessions = []
        try:
            for role in ("authenticated", "tdp_app_owner"):
                for kind in ("idle", "active"):
                    session = stack.enter_context(Session(app, f"synthetic_{role}_{kind}"))
                    sessions.append(session)
                    session.send("begin;set local role " + role + ";select jsonb_build_object('session',session_user,'current',current_user);\n\\echo ROLE_SET")
                    session.marker("ROLE_SET")
                    actual = [json.loads(line) for line in session.stdout if line.startswith("{")][-1]
                    require(actual == {"session": "tdp_app_authenticator", "current": role}, "Application session did not actually switch roles")
                    if kind == "active":
                        session.send("select pg_advisory_xact_lock(819221);\n\\echo ACTIVE_DONE")
            metadata_sql = """select coalesce(jsonb_agg(jsonb_build_object('application',application_name,
              'state',state,'wait',wait_event,'started',xact_start is not null) order by application_name),'[]')
              from pg_stat_activity where datname='tenderdesk_app' and usename='tdp_app_authenticator'"""
            deadline = time.monotonic() + 5
            while True:
                expected = admin.value(metadata_sql)
                if (len(expected) == 4 and
                    sum(row["state"] == "active" and row["wait"] == "advisory" and row["started"] for row in expected) == 2 and
                    sum(row["state"] == "idle in transaction" and row["started"] for row in expected) == 2):
                    break
                require(time.monotonic() < deadline, "Actual active lock waits and idle transactions were not observed")
                time.sleep(.05)
            masked = monitor.pg.value(metadata_sql)
            require(len(masked) == 4 and all(not row["started"] and row["state"] is None for row in masked), "SET-only observer should have masked activity before SET ROLE")
            census = helper.observe_transactions(monitor, client)
            require(census["old_transactions"] == 4, "Exact helper missed role-switched active or idle transactions")
            require(pending(admin) and len(pending(admin)) == 4, "Observation changed application sessions")
            cases.append({"case": "own-login-visibility-covers-active-and-idle-local-role-switches", "passed": True,
                          "admin_metadata": expected, "helper_old_transactions": 4,
                          "without_set_role_fields_masked": True, "global_monitoring_grants": 0,
                          "sessions_terminated": 0})
        finally:
            # Release only our owned advisory lock; each application session
            # then finishes its own transaction normally.
            require(blocker.finish("commit;").returncode == 0, "Owned advisory blocker failed to commit")
            for session in sessions:
                require(session.finish("commit;").returncode == 0, "Role-switched application session failed to commit")


def run(container, helper, cases):
    admin = LocalPg(container, database="postgres")
    admin.sql("""create database tenderdesk_app;
      create role synthetic_hidden_monitor login noinherit;
      create role synthetic_usage_only login inherit;
      create role synthetic_set_only login noinherit;
      """)
    admin = LocalPg(container)
    monitor_pg = LocalPg(container, "synthetic_set_only")
    monitor = Observer(monitor_pg)
    client = SimpleNamespace(pod=container)
    expect_error(lambda: helper.observe_transactions(Observer(LocalPg(container, database="postgres")), client), "DELIVERY_BATCH_DATABASE_IDENTITY_INVALID")
    expect_error(lambda: helper.observe_transactions(Observer(admin), client), "DELIVERY_BATCH_DATABASE_ROLE_INVALID")
    admin.sql("create role tdp_app_authenticator nologin noinherit;")
    expect_error(lambda: helper.observe_transactions(Observer(admin), client), "DELIVERY_BATCH_DATABASE_ROLE_INVALID")
    admin.sql("""alter role tdp_app_authenticator login;
      create role authenticated;create role tdp_app_owner;
      grant authenticated,tdp_app_owner to tdp_app_authenticator with inherit false,set true;
      grant tdp_app_authenticator to synthetic_set_only with inherit false,set true;
      grant tdp_app_authenticator to synthetic_usage_only with inherit true,set false;""")
    cases.append({"case": "canonical-database-and-login-role-required", "passed": True})

    app = LocalPg(container, "tdp_app_authenticator")
    role_switch_visibility(admin, app, monitor, helper, client, cases)
    direct = helper.observe_transactions(Observer(app), client)
    require(direct["old_transactions"] == 0, "Direct-authenticator observation counted its own transaction")
    cases.append({"case": "direct-authenticator-observer-excludes-own-transaction", "passed": True,
                  "old_transactions": 0, "sessions_terminated": 0})
    with Session(app, "synthetic_old_transaction") as old, Session(app, "synthetic_later_transaction") as later:
        old.send("begin;select 1;\n\\echo OLD_IDLE")
        old.marker("OLD_IDLE")
        old_rows = pending(admin)
        require(sum(row["transaction_started"] for row in old_rows) == 1, "Old idle transaction was not established")
        hidden_pg = LocalPg(container, "synthetic_hidden_monitor")
        hidden = hidden_pg.value("""select jsonb_build_object('matching_sessions',count(*),
          'visible_started_transactions',count(xact_start)) from pg_stat_activity
          where datname='tenderdesk_app' and usename='tdp_app_authenticator'""")
        require(hidden["matching_sessions"] >= 1 and hidden["visible_started_transactions"] == 0,
                "The denial case did not demonstrate PostgreSQL's masked activity fields")
        expect_error(lambda: helper.observe_transactions(Observer(hidden_pg), client), "DELIVERY_BATCH_TRANSACTION_VISIBILITY_REQUIRED")
        membership = monitor_pg.value("select jsonb_build_object('usage',pg_has_role(current_user,'tdp_app_authenticator','USAGE'),'set',pg_has_role(current_user,'tdp_app_authenticator','SET'),'global_stats',pg_has_role(current_user,'pg_read_all_stats','USAGE'))")
        require(membership == {"usage": False, "set": True, "global_stats": False}, "Observer must have only SET authority, with no global monitoring grant")
        usage_only = LocalPg(container, "synthetic_usage_only")
        wrong_authority = usage_only.value("select jsonb_build_object('usage',pg_has_role(current_user,'tdp_app_authenticator','USAGE'),'set',pg_has_role(current_user,'tdp_app_authenticator','SET'))")
        require(wrong_authority == {"usage": True, "set": False}, "USAGE-only denial fixture must lack SET authority")
        expect_error(lambda: helper.observe_transactions(Observer(usage_only), client), "DELIVERY_BATCH_TRANSACTION_VISIBILITY_REQUIRED")
        require(pending(admin) == old_rows, "Denied monitoring changed or terminated another backend")
        cases.append({"case": "hidden-and-usage-only-monitoring-fail-closed", "passed": True,
                      "masked_transaction_count": hidden["visible_started_transactions"],
                      "actual_started_transactions": 1, "usage_authority_without_set_rejected": True,
                      "allowed_observer_authority": membership,
                      "unknown_visibility_keeps_drain_blocked": True, "sessions_terminated": 0})

        first = helper.observe_transactions(monitor, client)
        require(first["visibility_verified"] and first["old_transactions"] == 1, "Allowed monitor missed old idle transaction")
        require(helper.observe_transactions(Observer(app), client)["old_transactions"] == 1,
                "Direct-authenticator observation missed the old transaction or included itself")
        marker = first["marker"]
        later.send("begin;select 1;\n\\echo LATER_IDLE")
        later.marker("LATER_IDLE")
        require(sum(row["transaction_started"] for row in pending(admin)) == 2, "Two actual open transactions were not established")
        late_order = admin.value("select to_json(count(*)=1) from pg_stat_activity where datname='tenderdesk_app' and application_name='synthetic_later_transaction' and xact_start>" + literal(marker) + "::timestamptz")
        require(late_order, "Later transaction does not follow the actual database marker")
        still_old = helper.observe_transactions(monitor, client, marker)
        require(still_old["marker"] == marker and still_old["old_transactions"] == 1, "Fixed marker included a later transaction")
        require(old.finish("commit;").returncode == 0, "Old transaction commit failed")
        settled = helper.observe_transactions(monitor, client, marker)
        require(settled["old_transactions"] == 0 and settled["marker"] == marker, "Old transaction did not settle under the fixed marker")
        require(sum(row["transaction_started"] for row in pending(admin)) == 1, "Later transaction was terminated or lost")
        cases.append({"case": "fixed-marker-excludes-later-transaction-and-observes-old-commit", "passed": True,
                      "initial_old_transactions": 1, "later_transaction_excluded": True,
                      "old_transactions_after_commit": 0, "later_transaction_still_open": True,
                      "sessions_terminated": 0})

        # The actual helper fixes a fresh marker and keeps polling it. Release
        # the remaining transaction only after its first real observation.
        draining = Observer(monitor_pg)
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(helper.drain_transactions, draining, client, 8)
            require(draining.first_pending.wait(timeout=5), "Drain did not observe its real pending transaction")
            require(later.finish("commit;").returncode == 0, "Later transaction commit failed")
            result = future.result(timeout=10)
        require(result["old_transactions_settled"] is True and result["sessions_terminated"] == 0,
                "Drain did not complete naturally")
        require(len(draining.observations) >= 2 and len({value["marker"] for value in draining.observations}) == 1,
                "Drain changed its marker while polling")
        cases.append({"case": "actual-drain-keeps-one-marker-until-natural-settlement", "passed": True,
                      "observations": len(draining.observations), "marker_unchanged": True,
                      "sessions_terminated": 0})

    with Session(app, "synthetic_timeout_transaction") as held:
        held.send("begin;select 1;\n\\echo TIMEOUT_IDLE")
        held.marker("TIMEOUT_IDLE")
        before = pending(admin)
        expect_error(lambda: helper.drain_transactions(Observer(monitor_pg), client, timeout=0), "DELIVERY_BATCH_TRANSACTION_DRAIN_TIMEOUT")
        require(pending(admin) == before and any(row["transaction_started"] for row in before),
                "Timeout terminated or changed the still-open transaction")
        # Visibility loss is a real SQL refusal, not an empty successful census.
        expect_error(lambda: helper.drain_transactions(Observer(LocalPg(container, "synthetic_hidden_monitor")), client, timeout=0), "DELIVERY_BATCH_TRANSACTION_VISIBILITY_REQUIRED")
        require(pending(admin) == before, "Unknown visibility changed the pending transaction")
        require(held.finish("commit;").returncode == 0, "Held transaction could not commit after refusals")
    cases.append({"case": "timeout-and-unknown-visibility-retain-blocked-state", "passed": True,
                  "timeout_error": "DELIVERY_BATCH_TRANSACTION_DRAIN_TIMEOUT",
                  "unknown_error": "DELIVERY_BATCH_TRANSACTION_VISIBILITY_REQUIRED",
                  "pending_transaction_preserved": True, "sessions_terminated": 0})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location("batch_activity_cutover", HELPER)
    helper = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = helper
    spec.loader.exec_module(helper)
    paths = [Path(__file__), HELPER, ROOT / "backend/scripts/testing/command_batch_cutover_races.py",
             ROOT / "backend/scripts/testing/postgres_races.py", ROOT / "backend/scripts/testing/upstream_batch_capacity.py"]
    def hashes():
        return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
    container = "tdp-races-activity-" + uuid.uuid4().hex[:12]
    receipt = {"version": 1, "scope": "isolated actual PostgreSQL activity visibility and fixed-marker drain",
               "source_hashes": hashes(), "image": IMAGE, "cases": [], "passed": False,
               "source_revision": subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, capture_output=True, check=True).stdout.strip(),
               "limits": {"memory_bytes": 402653184, "cpus": 1, "tmpfs_bytes": 134217728,
                          "pids": 64, "swap": False, "network": "none", "published_ports": []},
               "production_calls": 0, "provider_calls": 0, "sessions_terminated_by_drain": 0,
               "capacity_or_slo_qualification": False}
    launched = False
    try:
        require(docker("image", "inspect", IMAGE).returncode == 0, "Pinned PostgreSQL image must be cached")
        result = docker("run", "-d", "--name", container, "--network", "none", "--pull=never",
                        "--memory=384m", "--memory-swap=384m", "--cpus=1", "--pids-limit=64",
                        "--label", "tenderdesk.synthetic-activity-drain=true",
                        "--tmpfs", "/var/lib/postgresql/data:rw,size=134217728", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
                        IMAGE, "postgres", "-c", "shared_buffers=16MB", "-c", "max_connections=12", "-c", "statement_timeout=20s")
        require(result.returncode == 0, "Owned PostgreSQL container could not start")
        launched = True
        for _ in range(100):
            process = docker("exec", container, "cat", "/proc/1/comm")
            if process.returncode == 0 and process.stdout.strip() == "postgres" and docker("exec", container, "pg_isready", "-U", "postgres").returncode == 0:
                break
            time.sleep(.1)
        else:
            raise RuntimeError("Owned PostgreSQL did not become ready")
        run(container, helper, receipt["cases"])
        receipt["passed"] = len(receipt["cases"]) == 7 and all(case["passed"] for case in receipt["cases"])
    except Exception as error:
        receipt["error"] = {"type": type(error).__name__, "message": str(error)[:4000]}
    finally:
        if launched:
            receipt["final_state"] = state(container)
            receipt["passed"] = receipt["passed"] and receipt["final_state"].get("Running") is True and receipt["final_state"].get("OOMKilled") is False
            receipt["memory"] = memory_sample(container)
            logs = docker("logs", "--tail", "40", container)
            (output / "postgres.log").write_text(logs.stdout + logs.stderr)
            docker("rm", "-f", "-v", container)
            receipt["cleanup_verified"] = docker("inspect", container).returncode != 0
        else:
            receipt["cleanup_verified"] = True
        receipt["source_unchanged"] = receipt["source_hashes"] == hashes()
        receipt["passed"] = receipt["passed"] and receipt["cleanup_verified"] and receipt["source_unchanged"]
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps({"receipt": str(output / "receipt.json"), "passed": receipt["passed"],
                      "cleanup_verified": receipt["cleanup_verified"]}))
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
