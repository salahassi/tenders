#!/usr/bin/env python3
"""Synchronize discovered provider key bindings without changing model admission.

Values travel only from the runner environment to Kubernetes stdin and to a
bounded in-pod equality check. No key values or key-derived hashes are logged.
Missing repository bindings retain an existing runtime value.
"""
from __future__ import annotations

import argparse
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sys

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("provider_credentials_access", HERE / "transfer-sources.py")
access = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = access
SPEC.loader.exec_module(access)
d = access.d
ALIAS = re.compile(r"APP_MODEL_[A-Z0-9_]{1,80}_KEY")
SECRET = "tenderdesk-runtime"
ANNOTATION = "tenderdesk.io/provider-credential-refresh"
COMPONENTS = ("api", "worker")
REGISTRY = HERE.parents[1] / "supabase/functions/_shared/modelProviders.ts"
BACKEND = REGISTRY.with_name("backend.ts")
ENVIRONMENT_CHECK = r"""const expected=JSON.parse(await new Response(Deno.stdin.readable).text());
console.log(JSON.stringify(Object.fromEntries(Object.entries(expected).map(([name,value])=>[name,Deno.env.get(name)===value]))));"""


class SyncError(Exception):
    """Only fixed error codes may leave this module."""


def canonical_aliases(registry_path=REGISTRY, backend_path=BACKEND):
    registry = registry_path.read_text()
    ids_match = re.search(r"export\s+const\s+MODEL_PROVIDER_IDS\s*=\s*\[([\s\S]*?)\]\s*as\s+const", registry)
    prefixes_match = re.search(r"const\s+SECRET_PREFIX\s*:[^=]+?=\s*\{([\s\S]*?)\};", backend_path.read_text())
    if not ids_match or not prefixes_match:
        raise SyncError("PROVIDER_REGISTRY_NOT_DISCOVERABLE")
    providers = re.findall(r'"([a-z][a-z0-9_-]*)"', ids_match.group(1))
    entries = re.findall(r'^\s*(?:"([a-z][a-z0-9_-]*)"|([a-z][a-z0-9_]*)):\s*"(APP_MODEL_[A-Z0-9_]+)"\s*,?\s*$', prefixes_match.group(1), re.M)
    prefixes = {quoted or bare: prefix for quoted, bare, prefix in entries}
    if not providers or len(providers) != len(set(providers)) or set(prefixes) != set(providers):
        raise SyncError("PROVIDER_REGISTRY_PREFIX_MISMATCH")
    result = {prefixes[provider] + "_KEY" for provider in providers}
    if not all(ALIAS.fullmatch(alias) for alias in result):
        raise SyncError("PROVIDER_REGISTRY_ALIAS_INVALID")
    return result


def decode_bindings(raw):
    if not isinstance(raw, str) or len(raw.encode()) > 2_097_152:
        raise SyncError("PROVIDER_BINDINGS_INVALID")
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        raise SyncError("PROVIDER_BINDINGS_INVALID") from None
    if not isinstance(value, dict):
        raise SyncError("PROVIDER_BINDINGS_INVALID")
    # Ignore unrelated repository Secrets before any child process is started.
    return {name: item for name, item in value.items() if isinstance(name, str) and ALIAS.fullmatch(name)}


def owned(kind, name):
    value = d.get(kind, name)
    metadata = (value or {}).get("metadata", {})
    if (metadata.get("name") != name or metadata.get("labels", {}).get("app.kubernetes.io/managed-by") != "tenderdesk-deployment"
            or (kind != "namespace" and metadata.get("namespace") != d.NAMESPACE)):
        raise SyncError("PROVIDER_RESOURCE_OWNERSHIP_REQUIRED")
    return value


def workload(name):
    value = owned("deployment", name)
    spec = value.get("spec", {})
    containers = spec.get("template", {}).get("spec", {}).get("containers", [])
    status = value.get("status", {})
    if (len(containers) != 1 or containers[0].get("name") != name or spec.get("replicas") != 1
            or status.get("observedGeneration", -1) < value["metadata"].get("generation", 0)
            or status.get("readyReplicas") != 1 or status.get("updatedReplicas") != 1
            or status.get("unavailableReplicas", 0) != 0):
        raise SyncError("PROVIDER_WORKLOAD_NOT_READY")
    container = containers[0]
    references = [entry.get("secretRef", {}).get("name") for entry in container.get("envFrom", [])]
    if SECRET not in references or any(ALIAS.fullmatch(entry.get("name", "")) for entry in container.get("env", [])):
        raise SyncError("PROVIDER_WORKLOAD_ENVIRONMENT_MISMATCH")
    return value


def environment_matches(name, expected):
    if not expected:
        return True
    # The script is fixed; expected key values enter the process over stdin.
    raw = d.command(["exec", "-i", "deployment/" + name, "-n", d.NAMESPACE, "--container=" + name,
                     "--", "deno", "eval", ENVIRONMENT_CHECK], payload=json.dumps(expected), timeout=45)
    try:
        observed = json.loads(raw)
    except (ValueError, TypeError):
        raise SyncError("PROVIDER_ENVIRONMENT_PROOF_INVALID") from None
    if not isinstance(observed, dict) or set(observed) != set(expected) or any(type(value) is not bool for value in observed.values()):
        raise SyncError("PROVIDER_ENVIRONMENT_PROOF_INVALID")
    return all(observed.values())


def restart(name, expected):
    current = workload(name)
    if current["spec"] != expected["spec"]:
        raise SyncError("PROVIDER_WORKLOAD_CHANGED_CONCURRENTLY")
    annotations = {**current["spec"]["template"].get("metadata", {}).get("annotations", {}), ANNOTATION: secrets.token_hex(16)}
    operations = [{"op": "test", "path": "/metadata/resourceVersion", "value": current["metadata"]["resourceVersion"]},
                  {"op": "add", "path": "/spec/template/metadata/annotations", "value": annotations}]
    d.command(["patch", "deployment", name, "-n", d.NAMESPACE, "--type=json", "--patch-file=/dev/stdin"], payload=json.dumps(operations))
    return annotations[ANNOTATION]


def sync(bindings, aliases, *, reload_processes=True):
    if not isinstance(bindings, dict) or not aliases or any(not isinstance(alias, str) or not ALIAS.fullmatch(alias) for alias in aliases):
        raise SyncError("PROVIDER_ALIAS_DISCOVERY_INVALID")
    aliases = sorted(set(aliases))
    incoming = {}
    for alias in aliases:
        value = bindings.get(alias)
        if value is None or value == "":
            continue
        if not isinstance(value, str) or len(value) > 16_384 or "\x00" in value or value != value.strip():
            raise SyncError("PROVIDER_KEY_BINDING_INVALID")
        incoming[alias] = value
    owned("namespace", d.NAMESPACE)
    original = {name: workload(name) for name in COMPONENTS}
    secret = owned("secret", SECRET)
    existing = d.decode_secret(secret)
    if secret.get("type") != "Opaque" or not isinstance(secret.get("data"), dict) or not secret["metadata"].get("resourceVersion"):
        raise SyncError("PROVIDER_SECRET_SHAPE_INVALID")
    merged = {**existing, **incoming}
    changed = {alias: value for alias, value in incoming.items() if existing.get(alias) != value}
    if changed:
        operations = [{"op": "test", "path": "/metadata/resourceVersion", "value": secret["metadata"]["resourceVersion"]}]
        operations += [{"op": "add", "path": "/data/" + alias, "value": base64.b64encode(value.encode()).decode()}
                       for alias, value in sorted(changed.items())]
        d.command(["patch", "secret", SECRET, "-n", d.NAMESPACE, "--type=json", "--patch-file=/dev/stdin"], payload=json.dumps(operations))
        observed = d.decode_secret(owned("secret", SECRET))
        if observed != merged:
            raise SyncError("PROVIDER_SECRET_READBACK_MISMATCH")
    expected = {alias: merged[alias] for alias in aliases if merged.get(alias)}
    restarted = []
    for name in COMPONENTS if reload_processes else ():
        if not environment_matches(name, expected):
            restart(name, original[name])
            restarted.append(name)
            d.wait_deployments([name], seconds=300)
        current = workload(name)
        before, after = copy.deepcopy(original[name]["spec"]), copy.deepcopy(current["spec"])
        for spec in (before, after):
            metadata = spec["template"].get("metadata", {})
            annotations = metadata.get("annotations", {})
            annotations.pop(ANNOTATION, None)
            if not annotations:
                metadata.pop("annotations", None)
        if before != after:
            raise SyncError("PROVIDER_WORKLOAD_CONFIGURATION_CHANGED")
        if not environment_matches(name, expected):
            raise SyncError("PROVIDER_ENVIRONMENT_NOT_RELOADED")
    return {"provider_sync": "verified" if reload_processes else "patched", "aliases_discovered": len(aliases), "bindings_supplied": len(incoming),
            "keys_updated": len(changed), "key_presence": {alias: bool(merged.get(alias)) for alias in aliases},
            "restarted": restarted, "reload_deferred": not reload_processes, "model_admission_changed": False}


def discover_aliases():
    aliases = canonical_aliases()
    if d.get("secret", "tenderdesk-migration-admin"):
        raise SyncError("PROVIDER_OTHER_ADMIN_IN_PROGRESS")
    credentials, ca = d.probe.target_credentials(os.environ["DIGITALOCEAN_ACCESS_TOKEN"])
    core = owned("secret", "tenderdesk-core")
    if d.decode_secret(core).get("PGSSLCA") != ca:
        raise SyncError("PROVIDER_DATABASE_CA_MISMATCH")
    pod = "migration-client-" + os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]
    try:
        d.sql_pod({**credentials, "APP_DATABASE": d.DATABASE, "ROLE_PREFIX": d.PREFIX})
        raw = d.sql(pod, """BEGIN READ ONLY; SET LOCAL ROLE tdp_app_owner;
DO $$ BEGIN IF current_database()<>'tenderdesk_app' THEN RAISE EXCEPTION 'PROVIDER_DATABASE_MISMATCH'; END IF; END $$;
SELECT coalesce(jsonb_agg(DISTINCT credential_alias),'[]') FROM public.model_connections; COMMIT;""")
        custom = json.loads(raw)
        if not isinstance(custom, list) or any(not isinstance(alias, str) or not ALIAS.fullmatch(alias) for alias in custom):
            raise SyncError("PROVIDER_DATABASE_ALIAS_INVALID")
        return aliases | set(custom)
    finally:
        d.cleanup_administrator(pod)


def approved_aliases(raw):
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        raise SyncError("PROVIDER_APPROVED_ALIASES_INVALID") from None
    if (not isinstance(value, list) or not 1 <= len(value) <= 256
            or any(not isinstance(alias, str) or not ALIAS.fullmatch(alias) for alias in value)):
        raise SyncError("PROVIDER_APPROVED_ALIASES_INVALID")
    return set(value)


def write_discovery_output(aliases):
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        raise SyncError("PROVIDER_DISCOVERY_OUTPUT_REQUIRED")
    if not aliases or len(aliases) > 256 or any(not ALIAS.fullmatch(alias) for alias in aliases):
        raise SyncError("PROVIDER_ALIAS_DISCOVERY_INVALID")
    with open(path, "a", encoding="utf-8") as stream:
        stream.write("provider_aliases=" + json.dumps(sorted(aliases), separators=(",", ":")) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", choices=("discover", "apply", "reload"), default="reload")
    args = parser.parse_args(argv)
    directory = None
    try:
        # A matrix apply job receives exactly one requested repository binding.
        # Pop it before running kubectl, including for missing/invalid input.
        value = os.environ.pop("PROVIDER_KEY_VALUE", "")
        # Discard the former broad binding interface rather than passing it on.
        os.environ.pop("PROVIDER_SECRET_BINDINGS", None)
        if args.action == "apply":
            aliases = approved_aliases(os.environ.get("APPROVED_PROVIDER_ALIASES", "[]"))
            alias = os.environ.get("PROVIDER_ALIAS", "")
            if alias not in aliases:
                raise SyncError("PROVIDER_ALIAS_NOT_APPROVED")
            if not value:
                print(json.dumps({"provider_sync": "skipped", "alias": alias, "repository_binding_present": False,
                                  "existing_runtime_binding_preserved": True, "reload_deferred": True}), flush=True)
                return 0
            if len(value) > 16_384 or "\x00" in value or value != value.strip():
                raise SyncError("PROVIDER_KEY_BINDING_INVALID")
        directory = access.prepare_cluster()
        if args.action == "discover":
            aliases = discover_aliases()
            write_discovery_output(aliases)
            report = {"provider_sync": "discovered", "aliases_discovered": len(aliases)}
        elif args.action == "apply":
            report = sync({alias: value}, {alias}, reload_processes=False)
        else:
            aliases = discover_aliases()
            report = sync({}, aliases)
        print(json.dumps(report, sort_keys=True), flush=True)
    except Exception as error:
        code = str(error) if isinstance(error, (SyncError, d.DeployError, d.probe.ProbeError)) and re.fullmatch(r"[A-Z_0-9]{1,100}", str(error)) else "PROVIDER_CREDENTIAL_SYNC_FAILED"
        print(json.dumps({"provider_sync": "blocked", "code": code}), flush=True)
        return 1
    finally:
        if directory:
            shutil.rmtree(directory)
    return 0


if __name__ == "__main__":
    sys.exit(main())
