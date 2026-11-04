#!/usr/bin/env python3
"""Bounded synthetic PostgreSQL/PostgREST app_batch capacity probe.

Own local containers only; no ports, external endpoint, provider or customer data.
The database fixture uses the repository's real migrations/commands/triggers.
This is upstream qualification, not an API/runtime or managed PostgreSQL proof.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import threading
import time
import uuid

from postgres_races import PostgresFixture, IMAGE, OWNER, literal, docker
from ordinary_export_races import setup

REST_IMAGE = "docker.io/postgrest/postgrest:v14.18@sha256:c847127074bd26e1b8d3f7c0e6e01e5346f4b85dd34f5d699fd230af960827c0"
ROOT = Path(__file__).resolve().parents[3]
PG_MEMORY = 1024 * 1024**2
PG_DATA = 512 * 1024**2
REST_MEMORY = 128 * 1024**2
WALL_SECONDS = 120
NO_PROXY_ENV = [item for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy") for item in ("-e", key + "=")]


def jwt(secret):
    def part(value):
        return base64.urlsafe_b64encode(json.dumps(value, separators=(",", ":")).encode()).decode().rstrip("=")
    body = part({"alg": "HS256", "typ": "JWT"}) + "." + part({"role": "authenticated", "sub": OWNER, "exp": int(time.time()) + 3600})
    return body + "." + base64.urlsafe_b64encode(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()).decode().rstrip("=")


def state(name):
    result = docker("inspect", "--format", "{{json .State}}", name)
    if result.returncode:
        return {"missing": True}
    value = json.loads(result.stdout)
    return {key: value.get(key) for key in ("Running", "OOMKilled", "ExitCode", "StartedAt", "FinishedAt")}


def memory_sample(name):
    result = docker("inspect", "--format", "{{.Id}}", name)
    if result.returncode:
        return None
    identity = result.stdout.strip()
    if not re.fullmatch(r"[a-f0-9]{64}", identity):
        raise RuntimeError("CONTAINER_ID_INVALID")
    return cgroup_sample(Path("/sys/fs/cgroup/docker") / identity)


def cgroup_sample(path):
    try:
        data = {key: int((path / key).read_text().strip()) for key in ("memory.current", "memory.peak", "memory.max")}
        for key in ("memory.events", "cpu.stat"):
            data[key] = {line.split()[0]: int(line.split()[1]) for line in (path / key).read_text().splitlines()}
        return data
    except FileNotFoundError:
        return None


class Monitor:
    def __init__(self, names):
        self.paths = {}
        for name in names:
            identity = docker("inspect", "--format", "{{.Id}}", name).stdout.strip()
            if not re.fullmatch(r"[a-f0-9]{64}", identity):
                raise RuntimeError("CONTAINER_ID_INVALID")
            self.paths[name] = Path("/sys/fs/cgroup/docker") / identity
        self.samples = {}
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)

    def run(self):
        while not self.done.is_set():
            for name, path in self.paths.items():
                value = cgroup_sample(path)
                if value:
                    saved = self.samples.setdefault(name, {"sample_count": 0, "sampled_peak_bytes": 0, "kernel_peak_bytes": 0})
                    saved["sample_count"] += 1
                    saved["sampled_peak_bytes"] = max(saved["sampled_peak_bytes"], value["memory.current"])
                    saved["kernel_peak_bytes"] = max(saved["kernel_peak_bytes"], value["memory.peak"])
                    saved["last"] = value
            self.done.wait(.05)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.done.set()
        self.thread.join(timeout=5)


def request(pg, token, payload, output, name):
    """Stream the HTTP body to a digest; never parse/materialize its full JSON."""
    args = ["docker", "--host=unix:///var/run/docker.sock", "exec", *NO_PROXY_ENV, pg,
            "wget", "-S", "-O", "-", "-T", "110", "--header=Content-Type: application/json",
            "--header=Authorization: Bearer " + token, "--post-data=" + json.dumps(payload, separators=(",", ":")),
            "http://127.0.0.1:3000/rpc/app_batch"]
    started = time.monotonic()
    size = 0
    digest = hashlib.sha256()
    prefix = b""
    suffix = b""
    first_byte = None
    error = None
    # Wget writes only protocol metadata to stderr. Keep it outside public receipts.
    with (output / (name + ".http.log")).open("wb") as stderr:
        child = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=stderr)
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        try:
            while True:
                if time.monotonic() - started > WALL_SECONDS:
                    error = "PROBE_WALL_LIMIT"
                    child.kill()
                    break
                ready = selector.select(.2)
                if not ready:
                    if child.poll() is not None:
                        break
                    continue
                chunk = os.read(child.stdout.fileno(), 65536)
                if not chunk:
                    break
                if first_byte is None:
                    first_byte = time.monotonic() - started
                if not prefix:
                    prefix = chunk[:1]
                suffix = chunk[-1:]
                digest.update(chunk)
                size += len(chunk)
                if size > 128 * 1024**2:
                    error = "PROBE_RESPONSE_LIMIT"
                    child.kill()
                    break
            child.wait(timeout=5)
        finally:
            selector.close()
            child.stdout.close()
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
    headers = (output / (name + ".http.log")).read_text(errors="replace")
    statuses = re.findall(r"HTTP/\S+\s+(\d{3})", headers)
    return {"elapsed_seconds": round(time.monotonic() - started, 3),
            "first_byte_seconds": None if first_byte is None else round(first_byte, 3),
            "http_status": int(statuses[-1]) if statuses else None,
            "client_exit": child.returncode, "bytes": size, "sha256": digest.hexdigest(),
            "array_delimiters": prefix == b"[" and suffix == b"]", "safety_stop": error}


def source_hashes():
    paths = [Path(__file__), ROOT / "backend/scripts/testing/postgres_races.py",
             ROOT / "backend/scripts/testing/ordinary_export_races.py"]
    paths += sorted((ROOT / "backend/supabase/migrations").glob("*.sql"))
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    nonce = uuid.uuid4().hex[:12]
    pg, rest = "tdp-races-capacity-" + nonce, "tdp-batch-rest-" + nonce
    secret = "synthetic-local-batch-" + uuid.uuid4().hex
    f = None
    receipt = {"version": 1, "scope": "isolated_actual_postgresql_and_postgrest_batch_capacity",
               "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
               "source_hashes": source_hashes(), "cases": [], "passed": False,
               "hosted_calls": 0, "model_calls": 0, "customer_rows": 0,
               "production_capacity_qualified": False, "api_streaming_exercised": False,
               "images": {"postgres": IMAGE, "postgrest": REST_IMAGE},
               "limits": {"postgres_memory": PG_MEMORY, "postgres_cpus": 1,
                          "postgres_tmpfs_bytes_counted_in_memory": PG_DATA,
                          "postgrest_memory": REST_MEMORY, "postgrest_cpus": .5,
                          "swap": False, "published_ports": [], "network": "shared_loopback_none",
                          "per_case_wall_seconds": WALL_SECONDS, "sql_statement_timeout_seconds": 90},
               "limits_are_local_safety_fences_not_observed_managed_database_resources": True}

    def save():
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")

    try:
        for image in (IMAGE, REST_IMAGE):
            if docker("image", "inspect", image).returncode:
                raise RuntimeError("PINNED_IMAGE_NOT_CACHED")
        launched = docker("run", "-d", "--name", pg, "--network", "none", "--pull=never",
                          "--memory=1g", "--memory-swap=1g", "--cpus=1", "--pids-limit=128",
                          "--label", "tenderdesk.synthetic-batch=" + nonce,
                          "--tmpfs", "/var/lib/postgresql/data:rw,size=536870912",
                          "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE,
                          "postgres", "-c", "shared_buffers=32MB", "-c", "max_connections=12", "-c", "work_mem=4MB",
                          "-c", "statement_timeout=90s")
        if launched.returncode:
            raise RuntimeError("PG_START_FAILED")
        f = PostgresFixture(repository=ROOT, container=pg).start()
        receipt["server_version"] = f.scalar("show server_version")
        # Same canonical identity semantics, supporting PostgREST's real claims GUC.
        # Only the existing Auth test stub changes; no application guard is altered.
        f.sql("""create or replace function auth.uid() returns uuid language sql stable as $$
          select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
            nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
          create role capacity_authenticator login noinherit;
          grant anon,authenticated to capacity_authenticator;
          create schema extensions;
          grant usage on schema extensions to capacity_authenticator,anon,authenticated;
          alter role authenticated set statement_timeout='90s';""")
        _, version, payload = setup(f)
        f.sql(f"""insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,created_by)
          select {literal(f.workspace)},{literal(version)},'capacity-'||n,'Synthetic capacity section '||n,
          left(repeat('Synthetic workflow capacity review text. ',3000),100000),n,{literal(OWNER)}
          from generate_series(1,41) n;""")
        payload["volume"] = "combined"
        sql = f.command_sql("export.prepare", payload)
        # Execute the genuine authorization command without copying its large result to Python.
        sql = sql.replace("select public.app_command(", "select (public.app_command(")
        sql = sql.replace(");commit;", "))->>'id';commit;")
        export_id = f.scalar(sql)
        if not re.fullmatch(r"[0-9a-f-]{36}", export_id):
            raise RuntimeError("EXPORT_FIXTURE_INVALID")
        receipt["fixture"] = f.value(f"""select jsonb_build_object('snapshot_stored_bytes',pg_column_size(snapshot),
          'snapshot_text_bytes',octet_length(snapshot::text),'snapshot_sha256',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'),
          'sections',(select count(*) from public.proposal_sections where proposal_version_id={literal(version)}))
          from public.export_requests where id={literal(export_id)}""")
        if not 4_000_000 <= receipt["fixture"]["snapshot_text_bytes"] <= 4_194_304:
            raise RuntimeError("SNAPSHOT_SIZE_NOT_NEAR_ADMITTED_BOUND")
        launched = docker("run", "-d", "--name", rest, "--network", "container:" + pg, "--pull=never",
                          "--memory=128m", "--memory-swap=128m", "--cpus=.5", "--pids-limit=64",
                          "--label", "tenderdesk.synthetic-batch=" + nonce,
                          "-e", f"PGRST_DB_URI=postgres://capacity_authenticator@127.0.0.1:5432/{f.database}",
                          "-e", "PGRST_DB_ANON_ROLE=anon", "-e", "PGRST_DB_SCHEMAS=public",
                          "-e", "PGRST_DB_EXTRA_SEARCH_PATH=public,extensions", "-e", "PGRST_DB_POOL=5",
                          "-e", "PGRST_DB_MAX_ROWS=1000", "-e", "PGRST_SERVER_HOST=127.0.0.1",
                          "-e", "PGRST_ADMIN_SERVER_HOST=127.0.0.1", "-e", "PGRST_ADMIN_SERVER_PORT=3001",
                          "-e", "PGRST_LOG_LEVEL=error", "-e", "PGRST_JWT_SECRET=" + secret, REST_IMAGE)
        if launched.returncode:
            raise RuntimeError("REST_START_FAILED")
        for _ in range(60):
            probe = docker("exec", *NO_PROXY_ENV, pg, "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3001/ready")
            if probe.returncode == 0:
                break
            if not state(rest).get("Running"):
                raise RuntimeError("REST_START_EXITED")
            time.sleep(.2)
        else:
            (output / "readiness.log").write_text(probe.stdout + probe.stderr)
            raise RuntimeError("REST_NOT_READY")
        token = jwt(secret)
        for count in (1, 10, 25):
            revision = int(f.scalar(f"select revision from public.export_requests where id={literal(export_id)}"))
            key = "synthetic-batch-" + str(uuid.uuid4())
            commands = [{"operation": "export.renew", "input": {"id": export_id, "expected_revision": revision + i}} for i in range(count)]
            case = {"count": count, "revision_before": revision, "passed": False,
                    "before": {"postgres": memory_sample(pg), "postgrest": memory_sample(rest)}}
            receipt["cases"].append(case)
            with Monitor((pg, rest)) as monitor:
                case["http"] = request(pg, token, {"commands": commands, "idempotency_key": key}, output, f"count-{count}")
            case["telemetry"] = {"postgres": monitor.samples.get(pg), "postgrest": monitor.samples.get(rest)}
            case["states"] = {"postgres": state(pg), "postgrest": state(rest)}
            case["after"] = {"postgres": memory_sample(pg), "postgrest": memory_sample(rest)}
            save()
            if case["states"]["postgres"].get("Running"):
                case["database"] = f.value(f"""select jsonb_build_object(
                  'revision_after',(select revision from public.export_requests where id={literal(export_id)}),
                  'batch_receipt_count',(select count(*) from app_private.idempotency_records where method='BATCH' and key={literal(key)}),
                  'result_count',(select jsonb_array_length(result) from app_private.idempotency_records where method='BATCH' and key={literal(key)}),
                  'result_text_bytes',(select octet_length(result::text) from app_private.idempotency_records where method='BATCH' and key={literal(key)}),
                  'result_sha256',(select encode(sha256(convert_to(result::text,'UTF8')),'hex') from app_private.idempotency_records where method='BATCH' and key={literal(key)}),
                  'ordered_exact_snapshots',(select bool_and((e.value->>'revision')::int={revision}+e.ordinality and e.value->'snapshot'=r.snapshot)
                    from app_private.idempotency_records b cross join lateral jsonb_array_elements(b.result) with ordinality e(value,ordinality)
                    join public.export_requests r on r.id={literal(export_id)} where b.method='BATCH' and b.key={literal(key)}),
                  'command_receipts',(select count(*) from app_private.idempotency_records c where c.method='COMMAND' and c.route='export.renew'
                    and c.key in(select encode(sha256(convert_to('batch:'||{literal(key)}||':'||n::text,'UTF8')),'hex') from generate_series(1,{count}) n)),
                  'receipts_relation_bytes',pg_total_relation_size('app_private.idempotency_records'))""")
            case["passed"] = (case["http"]["http_status"] == 200 and case["http"]["client_exit"] == 0
                              and case["http"]["array_delimiters"] and not case["http"]["safety_stop"]
                              and case.get("database", {}).get("result_count") == count
                              and case["database"]["command_receipts"] == count
                              and case["database"]["ordered_exact_snapshots"]
                              and case["database"]["revision_after"] == revision + count)
            if case["passed"]:
                case["wire_matches_saved_result"] = case["http"]["sha256"] == case["database"]["result_sha256"]
                case["passed"] = case["wire_matches_saved_result"]
            save()
            print(json.dumps({"count": count, "passed": case["passed"], "http": case["http"], "states": case["states"]}), flush=True)
            if not case["passed"]:
                receipt["stopped_at_first_failure"] = True
                break
        receipt["passed"] = len(receipt["cases"]) == 3 and all(x["passed"] for x in receipt["cases"])
    except Exception as error:
        receipt["harness_error"] = str(error)[:4000]
        print(json.dumps({"harness_error": type(error).__name__}), flush=True)
    finally:
        for name in (rest, pg):
            logs = docker("logs", "--tail", "40", name)
            (output / (name + ".container.log")).write_text(logs.stdout + logs.stderr)
        receipt["final_states"] = {"postgres": state(pg), "postgrest": state(rest)}
        for name in (rest, pg):
            docker("rm", "-f", "-v", name)
        receipt["cleanup_verified"] = all(docker("inspect", name).returncode != 0 for name in (rest, pg))
        receipt["source_unchanged"] = source_hashes() == receipt["source_hashes"]
        save()
    print(json.dumps({"receipt": str(output / "receipt.json"), "passed": receipt["passed"], "cleanup_verified": receipt["cleanup_verified"]}))
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
