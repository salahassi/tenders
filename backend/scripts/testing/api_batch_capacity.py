#!/usr/bin/env python3
"""Synthetic actual-image API -> pinned PostgreSQL/PostgREST capacity proof.

No hosted endpoint, customer data, provider, published port or product override.
The immutable image entrypoint is retained but runtime/main.ts is explicitly
replaced by a qualification harness. Auth lookup is synthetic; JWT membership,
commands and chunks use the real migrated SQL. The client hashes bounded result
segments and never parses the full 100-result response.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import uuid

from postgres_races import PostgresFixture, IMAGE, OWNER, literal, docker
from ordinary_export_races import setup
from upstream_batch_capacity import REST_IMAGE, Monitor, jwt, state, memory_sample, NO_PROXY_ENV

ROOT = Path(__file__).resolve().parents[3]
API_IMAGE = "sha256:89afc8a31d76e1616ad17e5896e0fc54f0acdc41cd7da389af456386f3e998fe"


def source_hashes():
    paths = [Path(__file__), ROOT / "backend/scripts/testing/capacity_api_batch.ts",
             ROOT / "backend/scripts/testing/batchStreamOracle.ts",
             ROOT / "backend/scripts/testing/upstream_batch_capacity.py",
             ROOT / "backend/scripts/testing/postgres_races.py",
             ROOT / "backend/scripts/testing/ordinary_export_races.py"]
    paths += sorted((ROOT / "backend/supabase/migrations").glob("*.sql"))
    return {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--image", default=API_IMAGE)
    args = parser.parse_args()
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", args.image):
        raise ValueError("Exact immutable image required")
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    nonce = uuid.uuid4().hex[:12]
    pg, rest, api = "tdp-races-api-batch-" + nonce, "tdp-api-batch-rest-" + nonce, "tdp-api-batch-native-" + nonce
    secret = "synthetic-local-api-batch-" + uuid.uuid4().hex
    receipt = {"version": 1, "scope": "isolated actual-image API handler and Backend.batchStream with real PostgreSQL/PostgREST",
        "source_revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_hashes": source_hashes(), "passed": False, "hosted_acceptance": False,
        "production_capacity_qualified": False, "model_calls": 0, "customer_rows": 0,
        "auth_user_lookup": "synthetic exact actor/token", "sql_membership_and_authorization": "actual caller JWT",
        "gateway": "loopback HTTP prefix adapter only; no production gateway proof",
        "image_entrypoint_retained": True, "runtime_main_replaced_by_qualification_harness": True,
        "product_code_overrides": False, "aggregate_response_materialized": False,
        "images": {"api": args.image, "postgres": IMAGE, "postgrest": REST_IMAGE},
        "limits": {"api_memory_bytes": 384 * 1024**2, "api_cpus": .7, "postgres_memory_bytes": 1024**3,
            "postgres_cpus": 1, "postgres_tmpfs_bytes_counted_in_memory": 512 * 1024**2,
            "rest_memory_bytes": 128 * 1024**2, "rest_cpus": .5, "swap": False,
            "published_ports": [], "network": "shared_loopback_none", "full_request_deadline_seconds": 150,
            "sql_statement_timeout_seconds": 90},
        "database_limits_are_local_safety_fences_not_observed_managed_resources": True}

    def save():
        (output / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")

    owned = []
    try:
        for image in (IMAGE, REST_IMAGE, args.image):
            if docker("image", "inspect", image).returncode:
                raise RuntimeError("PINNED_IMAGE_NOT_CACHED")
        launched = docker("run", "-d", "--name", pg, "--network", "none", "--pull=never",
            "--memory=1g", "--memory-swap=1g", "--cpus=1", "--pids-limit=128",
            "--label", "tenderdesk.synthetic-api-batch=" + nonce,
            "--tmpfs", "/var/lib/postgresql/data:rw,size=536870912", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE,
            "postgres", "-c", "shared_buffers=32MB", "-c", "max_connections=12", "-c", "work_mem=4MB", "-c", "statement_timeout=90s")
        if launched.returncode:
            raise RuntimeError("PG_START_FAILED")
        owned.append(pg)
        fixture = PostgresFixture(repository=ROOT, container=pg).start()
        receipt["server_version"] = fixture.scalar("show server_version")
        fixture.sql("""create or replace function auth.uid() returns uuid language sql stable as $$
          select coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
            nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
          create role capacity_authenticator login noinherit;
          grant anon,authenticated to capacity_authenticator;
          create schema extensions;
          grant usage on schema extensions to capacity_authenticator,anon,authenticated;
          alter role authenticated set statement_timeout='90s';""")
        _, version, payload = setup(fixture)
        # Exactly the earlier upstream fixture: directly seeded permitted rows,
        # then a genuine authorized export.prepare. This is not writer reachability.
        fixture.sql(f"""insert into public.proposal_sections(workspace_id,proposal_version_id,section_key,title,body,ordinal,created_by)
          select {literal(fixture.workspace)},{literal(version)},'capacity-'||n,'Synthetic capacity section '||n,
          left(repeat('Synthetic workflow capacity review text. ',3000),100000),n,{literal(OWNER)}
          from generate_series(1,41) n;""")
        payload["volume"] = "combined"
        sql = fixture.command_sql("export.prepare", payload).replace("select public.app_command(", "select (public.app_command(")
        export_id = fixture.scalar(sql.replace(");commit;", "))->>'id';commit;"))
        if not re.fullmatch(r"[0-9a-f-]{36}", export_id):
            raise RuntimeError("EXPORT_FIXTURE_INVALID")
        receipt["fixture"] = fixture.value(f"""select jsonb_build_object('snapshot_stored_bytes',pg_column_size(snapshot),
          'snapshot_text_bytes',octet_length(snapshot::text),'snapshot_sha256',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'),
          'sections',(select count(*) from public.proposal_sections where proposal_version_id={literal(version)}))
          from public.export_requests where id={literal(export_id)}""")
        receipt["fixture"]["direct_structural_seed_not_generation_writer"] = True
        if not 4_000_000 <= receipt["fixture"]["snapshot_text_bytes"] <= 4_194_304:
            raise RuntimeError("SNAPSHOT_SERIALIZED_SIZE_OUTSIDE_EXPECTED_FIXTURE")
        # Large checkpoints must stay in the database during summary pagination.
        fixture.sql(f"""insert into public.jobs(workspace_id,type,entity_id,status,input_hash,checkpoint,created_by)
          select {literal(fixture.workspace)},'model_probe',{literal(fixture.workspace)},'failed',repeat('a',64),
          jsonb_build_object('summary_fixture_secret',repeat('PRIVATE_CHECKPOINT_',3300),
            'model_routing',jsonb_build_object('round_attempts',3,'mode','round_robin')),{literal(OWNER)}
          from generate_series(1,1201);""")
        summary_count = int(fixture.scalar('select count(*) from public.jobs'))
        fixture.sql(f"""insert into public.opportunities(workspace_id,source_id,title,description,created_by)
          select {literal(fixture.workspace)},(select source_id from public.opportunities where workspace_id={literal(fixture.workspace)} limit 1),
          'Full page fixture '||n,repeat('Complete synthetic obligation. ',150),{literal(OWNER)}
          from generate_series(1,118) n;""")
        opportunity_count = int(fixture.scalar('select count(*) from public.opportunities'))
        launched = docker("run", "-d", "--name", rest, "--network", "container:" + pg, "--pull=never",
            "--memory=128m", "--memory-swap=128m", "--cpus=.5", "--pids-limit=64",
            "--label", "tenderdesk.synthetic-api-batch=" + nonce,
            "-e", f"PGRST_DB_URI=postgres://capacity_authenticator@127.0.0.1:5432/{fixture.database}",
            "-e", "PGRST_DB_ANON_ROLE=anon", "-e", "PGRST_DB_SCHEMAS=public",
            "-e", "PGRST_DB_EXTRA_SEARCH_PATH=public,extensions", "-e", "PGRST_DB_POOL=5",
            "-e", "PGRST_DB_MAX_ROWS=1000", "-e", "PGRST_SERVER_HOST=127.0.0.1",
            "-e", "PGRST_ADMIN_SERVER_HOST=127.0.0.1", "-e", "PGRST_ADMIN_SERVER_PORT=3001",
            "-e", "PGRST_LOG_LEVEL=error", "-e", "PGRST_JWT_SECRET=" + secret, REST_IMAGE)
        if launched.returncode:
            raise RuntimeError("REST_START_FAILED")
        owned.append(rest)
        for _ in range(60):
            if docker("exec", *NO_PROXY_ENV, pg, "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3001/ready").returncode == 0:
                break
            if not state(rest).get("Running"):
                raise RuntimeError("REST_START_EXITED")
            time.sleep(.2)
        else:
            raise RuntimeError("REST_NOT_READY")
        revision = int(fixture.scalar(f"select revision from public.export_requests where id={literal(export_id)}"))
        key = "synthetic-api-batch-" + str(uuid.uuid4())
        commands = [{"operation": "export.renew", "input": {"id": export_id, "expected_revision": revision + i}} for i in range(100)]
        def counts():
            return fixture.value(f"""select jsonb_build_object('revision',(select revision from public.export_requests where id={literal(export_id)}),
              'audits',(select count(*) from public.audit_events),'commands',(select count(*) from app_private.idempotency_records),
              'batches',(select count(*) from app_private.command_batch_receipts),'chunks',(select count(*) from app_private.command_batch_chunks))""")
        receipt["before"] = counts()
        with tempfile.TemporaryDirectory(prefix="tenderdesk-api-batch-") as temporary:
            stage = Path(temporary); inputs = stage / "inputs"; scripts = stage / "scripts"; results = stage / "outputs"
            for folder in (inputs, scripts, results):
                folder.mkdir()
            for name in ("capacity_api_batch.ts", "batchStreamOracle.ts"):
                shutil.copyfile(ROOT / "backend/scripts/testing" / name, scripts / name)
            (inputs / "fixture.json").write_text(json.dumps({"actor": OWNER, "token": jwt(secret), "key": key, "commands": commands, "summary_count": summary_count, "opportunity_count": opportunity_count}))
            stage.chmod(0o755)
            for path in stage.rglob("*"):
                path.chmod(0o755 if path.is_dir() else 0o644)
            results.chmod(0o777)
            arguments = ["run", "-d", "--name", api, "--network", "container:" + pg, "--pull=never",
                "--memory=384m", "--memory-swap=384m", "--cpus=.7", "--pids-limit=128", "--read-only",
                "--label", "tenderdesk.synthetic-api-batch=" + nonce, "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
                "--mount", f"type=bind,src={scripts},dst=/app/backend/scripts/testing,readonly",
                "--mount", f"type=bind,src={inputs},dst=/inputs,readonly",
                "--mount", f"type=bind,src={results},dst=/outputs", "-e", "APP_RUNTIME_SERVICE=api",
                *NO_PROXY_ENV, args.image, "run", "--cached-only", "--frozen",
                "--config=/app/backend/supabase/functions/deno.json", "--allow-env=APP_RUNTIME_SERVICE",
                "--allow-read=/app,/deno-dir,/inputs,/sys/fs/cgroup", "--allow-write=/outputs",
                "--allow-net=127.0.0.1:3000,127.0.0.1:3002", "/app/backend/scripts/testing/capacity_api_batch.ts", "/inputs/fixture.json"]
            launched = docker(*arguments)
            if launched.returncode:
                raise RuntimeError("API_START_FAILED")
            owned.append(api)
            receipt["api_command"] = arguments[arguments.index(args.image) + 1:]
            with Monitor((pg, rest, api)) as monitor:
                deadline = time.monotonic() + 210
                while state(api).get("Running") and time.monotonic() < deadline:
                    time.sleep(.25)
                if state(api).get("Running"):
                    receipt["harness_wall_limit"] = True
                    docker("kill", api)
            receipt["telemetry"] = {"postgres": monitor.samples.get(pg), "postgrest": monitor.samples.get(rest), "api": monitor.samples.get(api)}
            receipt["api_state"] = state(api)
            for path in results.iterdir():
                if path.is_file():
                    shutil.copyfile(path, output / path.name)
            if (output / "api-batch-result.json").exists():
                receipt["api"] = json.loads((output / "api-batch-result.json").read_text())
            # Bind the proof to the product files actually inside the immutable image.
            actual = stage / "actual-functions"
            copied = docker("cp", f"{api}:/app/backend/supabase/functions", str(actual))
            if copied.returncode:
                raise RuntimeError("ACTUAL_IMAGE_SOURCE_UNAVAILABLE")
            receipt["actual_image_function_hashes"] = {str(path.relative_to(actual)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in actual.rglob("*") if path.is_file() and "node_modules" not in path.parts}
            receipt["actual_image_additional_source_hashes"] = {}
            for relative in ("backend/scripts/runtime", "frontend/src/lib"):
                additional = stage / relative
                additional.parent.mkdir(parents=True, exist_ok=True)
                if docker("cp", f"{api}:/app/{relative}", str(additional)).returncode:
                    raise RuntimeError("ACTUAL_RUNTIME_GRAPH_SOURCE_UNAVAILABLE")
                for path in additional.rglob("*"):
                    if path.is_file():
                        receipt["actual_image_additional_source_hashes"][relative + "/" + str(path.relative_to(additional))] = hashlib.sha256(path.read_bytes()).hexdigest()
        receipt["after"] = counts()
        receipt["database"] = fixture.value(f"""select jsonb_build_object(
          'batch_receipt_count',(select count(*) from app_private.command_batch_receipts where idempotency_key={literal(key)}),
          'result_count',(select count(*) from app_private.command_batch_results r join app_private.command_batch_receipts b on b.id=r.receipt_id where b.idempotency_key={literal(key)}),
          'legacy_aggregate_count',(select count(*) from app_private.idempotency_records where method='BATCH' and key={literal(key)}),
          'ordered_exact_snapshots',(select bool_and((c.result->>'revision')::int={revision}+r.ordinal+1 and c.result->'snapshot'=e.snapshot
            and r.sha256=encode(sha256(convert_to(c.result::text,'UTF8')),'hex'))
            from app_private.command_batch_results r join app_private.command_batch_receipts b on b.id=r.receipt_id
            join app_private.idempotency_records c on c.workspace_id=b.workspace_id and c.actor_id=b.actor_id and c.method='COMMAND' and c.route='export.renew'
            and c.key=encode(sha256(convert_to('batch:'||b.idempotency_key||':'||(r.ordinal+1)::text,'UTF8')),'hex')
            join public.export_requests e on e.id={literal(export_id)} where b.idempotency_key={literal(key)}),
          'result_hashes',(select jsonb_agg(r.sha256 order by r.ordinal) from app_private.command_batch_results r
            join app_private.command_batch_receipts b on b.id=r.receipt_id where b.idempotency_key={literal(key)}),
          'command_receipts',(select count(*) from app_private.idempotency_records c where c.method='COMMAND' and c.route='export.renew'
            and c.key in(select encode(sha256(convert_to('batch:'||{literal(key)}||':'||n::text,'UTF8')),'hex') from generate_series(1,100) n)))""")
        api_result, db = receipt.get("api", {}), receipt["database"]
        receipt["passed"] = bool(receipt["api_state"].get("ExitCode") == 0 and not receipt["api_state"].get("OOMKilled")
            and api_result.get("complete", {}).get("result_hashes") == db["result_hashes"] and db["ordered_exact_snapshots"]
            and db["result_count"] == 100 and db["command_receipts"] == 100 and db["batch_receipt_count"] == 1
            and db["legacy_aggregate_count"] == 0 and receipt["after"]["revision"] == revision + 100
            and receipt["after"]["audits"] == receipt["before"]["audits"] + 100
            and receipt["after"]["commands"] == receipt["before"]["commands"] + 100
            and receipt["after"]["batches"] == receipt["before"]["batches"] + 1)
    except Exception as error:
        receipt["harness_error"] = str(error)[:4000]
    finally:
        receipt["final_states"] = {"postgres": state(pg), "postgrest": state(rest), "api": state(api)}
        # A local create/start error may still have created a container. Recover
        # ownership from the exact private nonce, never delete a name collision.
        for name in (pg, rest, api):
            observed = docker("inspect", "--format", "{{json .Config.Labels}}", name)
            if observed.returncode == 0:
                if json.loads(observed.stdout).get("tenderdesk.synthetic-api-batch") == nonce:
                    if name not in owned:
                        owned.append(name)
                else:
                    receipt["cleanup_ownership_conflict"] = True
        for name in reversed(owned):
            logs = docker("logs", "--tail", "40", name)
            (output / (name + ".container.log")).write_text(logs.stdout + logs.stderr)
            docker("rm", "-f", "-v", name)
        receipt["cleanup_verified"] = not receipt.get("cleanup_ownership_conflict", False) and all(docker("inspect", name).returncode != 0 for name in owned)
        receipt["source_unchanged"] = source_hashes() == receipt["source_hashes"]
        servers_ok = all(receipt["final_states"][name].get("Running") and not receipt["final_states"][name].get("OOMKilled") for name in ("postgres", "postgrest"))
        receipt["passed"] = receipt["passed"] and servers_ok and receipt["cleanup_verified"] and receipt["source_unchanged"]
        save()
    print(json.dumps({"receipt": str(output / "receipt.json"), "passed": receipt["passed"], "cleanup_verified": receipt["cleanup_verified"]}))
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
