#!/usr/bin/env python3
"""Update existing provider runtime/frontend images without restoring or activating data."""
from __future__ import annotations

import copy
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import urllib.parse

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("provider_update_deploy", HERE / "digitalocean-deploy.py")
d = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = d
SPEC.loader.exec_module(d)
smoke = d.module("provider_update_smoke", HERE / "digitalocean-smoke.py")
COMPONENTS = ("api", "worker", "source-browser", "scheduler", "frontend")
REGISTRY = "registry.digitalocean.com/tenderdesk-a6093a76/"
MIGRATION = d.ROOT / "supabase/migrations/20261026112011_openrouter_provider.sql"


class UpdateError(Exception):
    pass


def emit(status, **values):
    print(json.dumps({"update": "provider_support", "status": status, **values}, sort_keys=True), flush=True)


def owned(kind, name):
    value = d.get(kind, name)
    meta = (value or {}).get("metadata", {})
    if (meta.get("name") != name or meta.get("namespace") != d.NAMESPACE
            or meta.get("labels", {}).get("app.kubernetes.io/managed-by") != "tenderdesk-deployment"):
        raise UpdateError("UPDATE_RESOURCE_OWNERSHIP_REQUIRED")
    return value


def deployment(name, ready=True):
    value = owned("deployment", name)
    spec, status = value.get("spec", {}), value.get("status", {})
    containers = spec.get("template", {}).get("spec", {}).get("containers", [])
    if len(containers) != 1 or containers[0].get("name") != name or spec.get("replicas") != 1:
        raise UpdateError("UPDATE_WORKLOAD_IDENTITY_INVALID")
    role = "frontend" if name == "frontend" else "runtime"
    image(containers[0].get("image", ""), role)
    if ready and (status.get("observedGeneration", -1) < value["metadata"].get("generation", 0)
                  or status.get("readyReplicas") != 1 or status.get("updatedReplicas") != 1
                  or status.get("unavailableReplicas", 0) != 0):
        raise UpdateError("UPDATE_WORKLOAD_NOT_READY")
    return value


def image(value, role):
    if not re.fullmatch(re.escape(REGISTRY + role) + r"@sha256:[a-f0-9]{64}", value):
        raise UpdateError("UPDATE_IMMUTABLE_IMAGE_REQUIRED")
    return value


def without_image(value):
    spec = copy.deepcopy(value["spec"])
    spec["template"]["spec"]["containers"][0].pop("image")
    return spec


def patch_image(name, selected, expected):
    current = deployment(name, ready=False)
    if without_image(current) != without_image(expected):
        raise UpdateError("UPDATE_WORKLOAD_CONFIGURATION_CHANGED")
    operations = [{"op": "test", "path": "/metadata/resourceVersion", "value": current["metadata"]["resourceVersion"]},
                  {"op": "test", "path": "/spec/template/spec/containers/0/name", "value": name},
                  {"op": "replace", "path": "/spec/template/spec/containers/0/image", "value": selected}]
    d.command(["patch", "deployment", name, "-n", d.NAMESPACE, "--type=json", "--patch", json.dumps(operations)])


# Values remain only in this SQL session. Hashes avoid returning configuration or
# business records; REPEATABLE READ excludes unrelated concurrent worker commits.
SNAPSHOT_SQL = r"""
CREATE TEMP TABLE provider_update_before(state jsonb);
CREATE FUNCTION pg_temp.provider_update_snapshot() RETURNS jsonb LANGUAGE plpgsql AS $snapshot$
DECLARE r record; n bigint; counts jsonb := '{}'; state jsonb;
BEGIN
 FOR r IN SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename LOOP
  EXECUTE format('SELECT count(*) FROM public.%I',r.tablename) INTO n;
  counts:=counts||jsonb_build_object(r.tablename,n);
 END LOOP;
 SELECT jsonb_build_object(
  'counts',counts,
  'workspaces',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY id)::text,'[]')) FROM public.workspaces x),
  'execution',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY workspace_id)::text,'[]')) FROM public.model_execution_settings x),
  'routing',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x)-'provider_order'-'revision'-'updated_at' ORDER BY workspace_id)::text,'[]')) FROM public.model_routing x),
  'model_settings',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY workspace_id,provider)::text,'[]')) FROM public.model_settings x),
  'connections',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY id)::text,'[]')) FROM public.model_connections x),
  'models',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY id)::text,'[]')) FROM public.model_configurations x),
  'routes',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY workspace_id,task)::text,'[]')) FROM public.model_task_routes x),
  'sources',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY id)::text,'[]')) FROM public.sources x)
 ) INTO state;
 RETURN state;
END $snapshot$;
INSERT INTO pg_temp.provider_update_before SELECT pg_temp.provider_update_snapshot();
"""


def migrate(pod):
    state = d.restore_state(pod)
    marker = owned("configmap", "database-restoration").get("data", {})
    if not state or state.get("stage") != "seed" or any(marker.get(k) != state[k] for k in ("schema_sha256", "seed_sha256")):
        raise UpdateError("UPDATE_EXISTING_RESTORATION_REQUIRED")
    d.sql(pod, (d.ASSETS / "check-compatible.sql").read_text())
    script = "BEGIN ISOLATION LEVEL REPEATABLE READ; SET LOCAL ROLE tdp_app_owner;\n" + SNAPSHOT_SQL
    script += MIGRATION.read_text()
    script += """
DO $preserve$ BEGIN
 IF (SELECT state FROM pg_temp.provider_update_before) IS DISTINCT FROM pg_temp.provider_update_snapshot()
 THEN RAISE EXCEPTION 'PROVIDER_UPDATE_EXISTING_DATA_CHANGED'; END IF;
END $preserve$;
NOTIFY pgrst,'reload schema'; COMMIT;
"""
    d.sql(pod, script)
    emit("provider_schema_verified", business_records_preserved=True, model_activation_changed=False)


def public_check(configuration, core):
    expected = smoke.javascript_config(configuration["data"]["runtime-config.js"].encode())
    if not hmac.compare_digest(expected["publishableKey"], core["ANON_KEY"]):
        raise UpdateError("UPDATE_PUBLIC_KEY_CHANGED")
    client = smoke.Client(smoke.Config(expected["appOrigin"], core["ANON_KEY"], core["SERVICE_KEY"], core["JWT_SECRET"]))
    root = client.request("/")
    loaded = client.request("/runtime-config.js")
    if root.status != 200 or loaded.status != 200 or smoke.javascript_config(loaded.body) != expected:
        raise UpdateError("UPDATE_PUBLIC_CONFIGURATION_FAILED")
    pending = [(expected["appOrigin"] + "/", path.decode()) for path in
               re.findall(rb'<script[^>]+src=["\']([^"\']+\.js)["\']', root.body)[:3]]
    seen, content = set(), b""
    while pending and len(seen) < 8:
        base, path = pending.pop(0)
        selected = urllib.parse.urljoin(base, "/" + path if path.startswith("assets/") else path)
        if urllib.parse.urlsplit(selected)[:2] != urllib.parse.urlsplit(expected["appOrigin"])[:2]:
            raise UpdateError("UPDATE_FRONTEND_ASSET_ORIGIN_INVALID")
        if selected in seen:
            continue
        seen.add(selected)
        response = client.request(urllib.parse.urlsplit(selected).path)
        if response.status != 200:
            raise UpdateError("UPDATE_FRONTEND_ASSET_FAILED")
        content += response.body
        for match in re.findall(rb'["\'`](\.?/?(?:assets/)?(?:Settings|modelProviders)-[A-Za-z0-9_-]+\.js)["\'`]', response.body)[:4]:
            pending.append((selected, match.decode()))
    if b"OpenRouter" not in content or b"QwenCloud" not in content:
        raise UpdateError("UPDATE_PROVIDER_FRONTEND_MISSING")
    if client.request("/functions/v1/api/v1/health", headers={"Origin": expected["appOrigin"]}).status != 200:
        raise UpdateError("UPDATE_HEALTH_FAILED")
    if client.request("/functions/v1/api/v1/bootstrap").status != 401:
        raise UpdateError("UPDATE_ANONYMOUS_BOUNDARY_FAILED")
    emit("public_configuration_and_provider_assets_verified")


def update():
    runtime = image(os.environ.get("TENDERDESK_RUNTIME_IMAGE", ""), "runtime")
    frontend = image(os.environ.get("TENDERDESK_FRONTEND_IMAGE", ""), "frontend")
    if not re.fullmatch(r"[0-9]{1,20}", os.environ.get("GITHUB_RUN_ID", "")) or not re.fullmatch(r"[0-9]{1,6}", os.environ.get("GITHUB_RUN_ATTEMPT", "")):
        raise UpdateError("UPDATE_RUN_IDENTITY_REQUIRED")
    d.probe.validate_cluster()
    original = {name: deployment(name) for name in COMPONENTS}
    schedules = {name: owned("cronjob", name)["spec"] for name in ("native-browser", "native-ocr")}
    configuration = owned("configmap", "frontend-config")
    core = d.decode_secret(owned("secret", "tenderdesk-core"))
    credentials, ca = d.probe.target_credentials(os.environ.get("DIGITALOCEAN_ACCESS_TOKEN", ""))
    if not core or not hmac.compare_digest(core.get("PGSSLCA", ""), ca):
        raise UpdateError("UPDATE_DATABASE_CA_CHANGED")
    admin = {**credentials, "APP_DATABASE": d.DATABASE, "ROLE_PREFIX": d.PREFIX}
    pod = "migration-client-" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
    changed = []
    try:
        d.sql_pod(admin)
        migrate(pod)
        try:
            for name in COMPONENTS:
                changed.append(name)  # Also recover an ambiguously accepted patch.
                patch_image(name, frontend if name == "frontend" else runtime, original[name])
            d.wait_deployments(list(COMPONENTS))
            for name in COMPONENTS:
                current = deployment(name)
                target = frontend if name == "frontend" else runtime
                if current["spec"]["template"]["spec"]["containers"][0]["image"] != target or without_image(current) != without_image(original[name]):
                    raise UpdateError("UPDATE_WORKLOAD_ACCEPTANCE_FAILED")
            if any(owned("cronjob", name)["spec"] != spec for name, spec in schedules.items()):
                raise UpdateError("UPDATE_NATIVE_SCHEDULE_CHANGED")
            if owned("configmap", "frontend-config").get("data") != configuration.get("data"):
                raise UpdateError("UPDATE_PUBLIC_CONFIGURATION_CHANGED")
            public_check(configuration, core)
        except Exception:
            failed = False
            for name in reversed(changed):
                try:
                    previous = original[name]["spec"]["template"]["spec"]["containers"][0]["image"]
                    patch_image(name, previous, original[name])
                except Exception:
                    failed = True
            try:
                d.wait_deployments(changed)
            except Exception:
                failed = True
            if failed:
                raise UpdateError("UPDATE_ROLLBACK_NOT_CONFIRMED") from None
            emit("images_rolled_back", provider_schema_retained=True)
            raise
        emit("passed", deployments_verified=len(COMPONENTS), models_activated=False, source_seeded=False)
    finally:
        d.cleanup_administrator(pod)


def main():
    try:
        update()
        return 0
    except (UpdateError, d.DeployError, d.probe.ProbeError, smoke.SmokeFailure) as error:
        allowed = str(error) if re.fullmatch(r"[A-Z_]{1,100}", str(error)) else "UPDATE_FAILED"
        emit("blocked", code=allowed)
    except Exception:
        emit("blocked", code="UNEXPECTED_UPDATE_FAILURE")
    return 1


if __name__ == "__main__":
    sys.exit(main())
