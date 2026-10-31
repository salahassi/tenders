#!/usr/bin/env python3
"""Release request-scoped model processing without replaying older migrations.

The ordinary image updater supplies ownership, strict TLS, rollout, rollback and
cleanup guards. This entrypoint pins the requested-processing migration and
records its checksum atomically. It never resumes work or sends model requests.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import re
import sys
import urllib.parse


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("requested_processing_base_update", HERE / "digitalocean-update.py")
u = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = u
SPEC.loader.exec_module(u)
MIGRATION = u.d.ROOT / "supabase/migrations/20261031115846_requested_model_processing.sql"
RELEASE = "requested-model-processing-v1"
ORIGINAL_PUBLIC_CHECK = u.public_check
FRONTEND_MARKER = b"Processing stopped while checking which inputs can be used."

# Hash every existing public row, plus durable processing/accounting tables.
# Contents stay inside PostgreSQL; only equality is tested and no hash is logged.
# The new private request ledger is the sole intended data addition.
SNAPSHOT_SQL = r"""
 state := '{}';
 FOR r IN SELECT schemaname,tablename FROM pg_catalog.pg_tables
  WHERE schemaname='public' OR (schemaname='app_private' AND tablename IN (
   'idempotency_records','model_graph_threads','model_graph_checkpoints',
   'model_graph_writes','model_graph_results','model_graph_budgets'))
  ORDER BY schemaname,tablename
 LOOP
  EXECUTE format('SELECT count(*)::bigint,md5(coalesce(string_agg(md5(to_jsonb(x)::text),'''' ORDER BY md5(to_jsonb(x)::text)),'''')) FROM %I.%I x',r.schemaname,r.tablename)
   INTO n,row_digest;
  state:=state||jsonb_build_object(r.schemaname||'.'||r.tablename,
   jsonb_build_object('count',n,'digest',row_digest));
 END LOOP;
"""


def emit(status, **values):
    print(json.dumps({"update": "requested_processing", "status": status, **values}, sort_keys=True), flush=True)


def migration_script(migration=None):
    migration = MIGRATION.read_text() if migration is None else migration
    if not migration.strip():
        raise u.UpdateError("REQUESTED_PROCESSING_MIGRATION_EMPTY")
    checksum = hashlib.sha256(migration.encode("utf-8")).hexdigest()
    delimiter = "$requested_processing_payload$"
    while delimiter in migration:
        delimiter = delimiter[:-1] + "_$"
    return ("BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL ROLE tdp_app_owner;\n"
            "SELECT pg_advisory_xact_lock(hashtextextended('tenderdesk.requested-processing.release',0));\n"
            "CREATE TABLE IF NOT EXISTS app_private.application_release_history (\n"
            " release text PRIMARY KEY, migration_sha256 text NOT NULL CHECK(migration_sha256 ~ '^[a-f0-9]{64}$'),\n"
            " applied_at timestamptz NOT NULL DEFAULT now());\n"
            "ALTER TABLE app_private.application_release_history ENABLE ROW LEVEL SECURITY;\n"
            "REVOKE ALL ON app_private.application_release_history FROM PUBLIC;\n"
            "DO $requested_processing_release$\n"
            "DECLARE r record; n bigint; row_digest text; state jsonb; before_state jsonb; prior text;\nBEGIN\n"
            " FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN\n"
            "  ('anon','authenticated','service_role','tdp_app_anon','tdp_app_authenticated','tdp_app_service')\n"
            " LOOP EXECUTE format('REVOKE ALL ON app_private.application_release_history FROM %I',r.rolname); END LOOP;\n"
            " SELECT migration_sha256 INTO prior FROM app_private.application_release_history\n"
            "  WHERE release='" + RELEASE + "' FOR UPDATE;\n"
            " IF prior IS NOT NULL AND prior<>'" + checksum + "' THEN\n"
            "  RAISE EXCEPTION 'REQUESTED_PROCESSING_RELEASE_CHECKSUM_MISMATCH'; END IF;\n"
            " IF prior IS NULL THEN\n" + SNAPSHOT_SQL + " before_state:=state;\n"
            " EXECUTE " + delimiter + migration + delimiter + ";\n" + SNAPSHOT_SQL + """
  IF before_state IS DISTINCT FROM state THEN
   RAISE EXCEPTION 'REQUESTED_PROCESSING_EXISTING_DATA_CHANGED'; END IF;
""" + " INSERT INTO app_private.application_release_history(release,migration_sha256)\n"
            "  VALUES('" + RELEASE + "','" + checksum + "');\n END IF;\n" + """
 IF to_regclass('app_private.generation_processing_requests') IS NULL
 OR to_regprocedure('app_private.check_requested_model_payload(uuid,text,jsonb)') IS NULL
 THEN RAISE EXCEPTION 'REQUESTED_PROCESSING_SCHEMA_INCOMPLETE'; END IF;
END $requested_processing_release$;
NOTIFY pgrst,'reload schema'; COMMIT;
""")


def migrate(pod):
    state = u.d.restore_state(pod)
    marker = u.owned("configmap", "database-restoration").get("data", {})
    if not state or state.get("stage") != "seed" or any(marker.get(k) != state[k] for k in ("schema_sha256", "seed_sha256")):
        raise u.UpdateError("UPDATE_EXISTING_RESTORATION_REQUIRED")
    u.d.sql(pod, (u.d.ASSETS / "check-compatible.sql").read_text())
    u.d.sql(pod, migration_script())
    emit("requested_processing_schema_verified", business_records_preserved=True, processing_retried=False)


def public_check(configuration, core):
    ORIGINAL_PUBLIC_CHECK(configuration, core)
    expected = u.smoke.javascript_config(configuration["data"]["runtime-config.js"].encode())
    client = u.smoke.Client(u.smoke.Config(expected["appOrigin"], core["ANON_KEY"], core["SERVICE_KEY"], core["JWT_SECRET"]))
    root = client.request("/")
    pending = [(expected["appOrigin"] + "/", x.decode()) for x in
               re.findall(rb'<script[^>]+src=["\']([^"\']+\.js)["\']', root.body)[:3]]
    seen, settings, generation = set(), b"", b""
    while pending and len(seen) < 12:
        base, path = pending.pop(0)
        selected = urllib.parse.urljoin(base, "/" + path if path.startswith("assets/") else path)
        if urllib.parse.urlsplit(selected)[:2] != urllib.parse.urlsplit(expected["appOrigin"])[:2]:
            raise u.UpdateError("UPDATE_FRONTEND_ASSET_ORIGIN_INVALID")
        if selected in seen:
            continue
        seen.add(selected)
        response = client.request(urllib.parse.urlsplit(selected).path)
        if response.status != 200:
            raise u.UpdateError("UPDATE_FRONTEND_ASSET_FAILED")
        name = urllib.parse.urlsplit(selected).path.rsplit("/", 1)[-1]
        if name.startswith("Settings-"):
            settings += response.body
        if name.startswith(("GenerationPanel-", "generationStatus-")):
            generation += response.body
        for match in re.findall(rb'["\'`](\.?/?(?:assets/)?(?:Settings|OpportunityDetail|GenerationPanel|generationStatus)-[A-Za-z0-9_-]+\.js)["\'`]', response.body)[:8]:
            pending.append((selected, match.decode()))
    if not settings or b"Individual content permissions" in settings or b"Authorize this text" in settings:
        raise u.UpdateError("UPDATE_SEPARATE_CONTENT_PERMISSION_UI_PRESENT")
    if FRONTEND_MARKER not in generation or b"Reference code:" not in generation:
        raise u.UpdateError("UPDATE_IN_CONTEXT_PROCESSING_HELP_MISSING")
    emit("requested_processing_frontend_verified", separate_content_permission_step=False)


def main():
    u.migrate, u.public_check, u.emit = migrate, public_check, emit
    return u.main()


if __name__ == "__main__":
    sys.exit(main())
