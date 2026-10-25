#!/usr/bin/env python3
"""Select the first Owner and operating configuration, excluding business history.

Inputs and outputs are private files. The printed manifest contains table counts,
never user identities, password hashes, provider credentials or row values.
"""
from __future__ import annotations

import argparse
from collections import Counter
import copy
import hashlib
import json
from pathlib import Path
import re
import uuid

from build_schema import checked_name, identifier, literal, private_write, qualified


CONFIGURATION_TABLES = (
    "model_connections", "model_configurations", "model_settings",
    "model_task_routes", "model_routing", "model_execution_settings",
)
AUTH_CLEAR_FIELDS = {
    "confirmation_token", "recovery_token", "email_change_token_new",
    "email_change_token_current", "email_change", "phone_change",
    "phone_change_token", "reauthentication_token",
}
AUTH_CLEAR_DATES = {
    "confirmation_sent_at", "recovery_sent_at", "email_change_sent_at",
    "phone_change_sent_at", "reauthentication_sent_at", "last_sign_in_at",
}


def load_table(root: Path, schema: str, table: str) -> list[dict]:
    directory = root / "data" / schema
    full = directory / (table + ".json")
    newline = directory / (table + ".ndjson")
    if full.is_file():
        result = json.loads(full.read_text())
    elif newline.is_file():
        result = [json.loads(line) for line in newline.read_text().splitlines() if line.strip()]
    else:
        return []
    if not isinstance(result, list) or not all(isinstance(row, dict) for row in result):
        raise ValueError("Unexpected captured table format")
    return [json.loads(row["row_json"]) if set(row) == {"row_json"} else row for row in result]


def select_essentials(root: Path, role_prefix: str) -> tuple[list[tuple[str, str, dict]], dict]:
    checked_name(role_prefix, "role prefix")
    users = load_table(root, "auth", "users")
    if not users:
        raise ValueError("No source user is available")
    user = copy.deepcopy(min(users, key=lambda row: (row.get("created_at") or "", row["id"])))
    user_id = str(uuid.UUID(user["id"]))
    if user.get("deleted_at") or user.get("is_anonymous") or user.get("is_sso_user") or user.get("banned_until"):
        raise ValueError("First source user is not an active email/password user")
    if not user.get("email") or not user.get("email_confirmed_at"):
        raise ValueError("First user lacks confirmed email")
    if not re.fullmatch(r"\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}", user.get("encrypted_password") or ""):
        raise ValueError("First user lacks the expected preserved password hash")
    members = [copy.deepcopy(row) for row in load_table(root, "public", "memberships")
               if row["user_id"] == user_id and row["active"] and row["role"] == "Owner"]
    if len(members) != 1:
        raise ValueError("First user must have one unambiguous active Owner membership")
    workspace_id = str(uuid.UUID(members[0]["workspace_id"]))
    workspace_rows = [copy.deepcopy(row) for row in load_table(root, "public", "workspaces") if row["id"] == workspace_id]
    identity_rows = [copy.deepcopy(row) for row in load_table(root, "auth", "identities")
                     if row["user_id"] == user_id and row["provider"] == "email"]
    allowlist = [copy.deepcopy(row) for row in load_table(root, "public", "identity_allowlist")
                 if row.get("user_id") == user_id and row["workspace_id"] == workspace_id and row["status"] == "active"]
    if len(workspace_rows) != 1 or len(identity_rows) != 1 or len(allowlist) != 1:
        raise ValueError("First Owner workspace or email authorization is ambiguous")
    if workspace_rows[0]["created_by"] != user_id or members[0]["created_by"] != user_id or allowlist[0]["created_by"] != user_id:
        raise ValueError("Core seed would depend on another Auth user")
    if allowlist[0]["role"] != "Owner" or allowlist[0]["provider"] != "email" or allowlist[0]["verified_email"].lower() != user["email"].lower():
        raise ValueError("Owner authorization does not match the selected email")
    if allowlist[0]["provider_user_id"] != identity_rows[0].get("identity_data", {}).get("sub"):
        raise ValueError("Owner authorization does not match the email identity")
    user["role"] = role_prefix + "_authenticated"
    user["aud"] = "authenticated"
    user["is_super_admin"] = False
    for name in AUTH_CLEAR_FIELDS:
        if name in user:
            user[name] = ""
    for name in AUTH_CLEAR_DATES:
        if name in user:
            user[name] = None
    user["email_change_confirm_status"] = 0
    user.pop("confirmed_at", None)  # generated upstream
    identity_rows[0].pop("email", None)  # generated upstream
    identity_rows[0]["last_sign_in_at"] = None
    workspace = workspace_rows[0]
    workspace["model_enabled"] = False
    workspace["restore_origin"] = None
    selected: list[tuple[str, str, dict]] = [("auth", "users", user), ("auth", "identities", identity_rows[0]), ("public", "workspaces", workspace)]
    configs = [("public", table, copy.deepcopy(row)) for table in CONFIGURATION_TABLES
               for row in load_table(root, "public", table) if row["workspace_id"] == workspace_id]
    actor_ids = {user_id, *(row["created_by"] for _, _, row in configs)}
    for actor_id in sorted(actor_ids):
        uuid.UUID(actor_id)
        # Attribution for a configuration creator does not grant login or membership.
        selected.append(("public", "workspace_actors", {"workspace_id": workspace_id, "id": actor_id, "kind": "member" if actor_id == user_id else "historical"}))
    selected.extend([("public", "memberships", members[0]), ("public", "identity_allowlist", allowlist[0])])
    for _, table, row in configs:
        if table in {"model_execution_settings", "model_routing"}:
            row["enabled"] = False
        if table == "model_task_routes":
            row["next_position"] = 0
        selected.append(("public", table, row))
    selected.extend(("public", "notification_preferences", copy.deepcopy(row))
                    for row in load_table(root, "public", "notification_preferences")
                    if row["workspace_id"] == workspace_id and row["user_id"] == user_id)
    selected.append(("public", "operations", {"workspace_id": workspace_id, "scheduler_enabled": False, "email_transport_ready": False}))
    source_buckets = [row for row in load_table(root, "storage", "buckets") if row["id"] == "tenderdesk-private"]
    if len(source_buckets) != 1 or source_buckets[0]["public"]:
        raise ValueError("Expected private application bucket configuration is missing")
    bucket = {key: source_buckets[0][key] for key in ("id", "name", "public", "file_size_limit", "allowed_mime_types")}
    selected.append(("storage", "buckets", bucket))
    counts = Counter(schema + "." + table for schema, table, _ in selected)
    manifest = {
        "format": "tenderdesk-minimal-seed-v1", "tables": dict(sorted(counts.items())),
        "rows": len(selected), "login_accounts": 1, "existing_password_hash_preserved": True,
        "historical_attribution_actors": len(actor_ids) - 1,
        "auth_sessions_copied": False, "business_history_copied": False,
        "storage_objects_copied": False, "processing_enabled": False,
        "runtime_secret_values_included": False,
    }
    return selected, manifest


def row_insert(schema: str, table: str, row: dict) -> str:
    """Ignore generated/new upstream columns using target catalog introspection."""
    payload = literal(json.dumps(row, ensure_ascii=False, separators=(",", ":")))
    target = qualified(schema, table)
    return f"""DO $seed$ DECLARE payload jsonb := {payload}::jsonb; columns text;
BEGIN
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(payload) key WHERE NOT EXISTS(
  SELECT 1 FROM pg_attribute a WHERE a.attrelid={literal(schema + '.' + table)}::regclass
  AND a.attnum>0 AND NOT a.attisdropped AND a.attname=key))
 THEN RAISE EXCEPTION 'SEED_SOURCE_COLUMN_NOT_SUPPORTED'; END IF;
 SELECT string_agg(quote_ident(a.attname),',' ORDER BY a.attnum) INTO columns
 FROM pg_attribute a WHERE a.attrelid={literal(schema + '.' + table)}::regclass
 AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' AND a.attidentity=''
 AND payload ? a.attname;
 IF columns IS NULL THEN RAISE EXCEPTION 'SEED_COLUMN_MAPPING_FAILED'; END IF;
 EXECUTE format('INSERT INTO {target} (%s) SELECT %s FROM jsonb_populate_record(NULL::{target},$1)',columns,columns) USING payload;
END $seed$;"""


def build_seed(rows: list[tuple[str, str, dict]], manifest: dict,
               role_prefix: str, database: str) -> str:
    checked_name(database, "database")
    checked_name(role_prefix, "role prefix")
    sql = [
        "-- PRIVATE: first-account password hash and operating configuration.",
        "BEGIN; SET LOCAL search_path=public,extensions,pg_catalog;",
        f"DO $guard$ BEGIN IF current_database()<>{literal(database)} THEN RAISE EXCEPTION 'SEED_DATABASE_MISMATCH'; END IF; END $guard$;",
        f"SET LOCAL ROLE {identifier(role_prefix + '_authadmin')};",
        "DO $guard$ BEGIN IF EXISTS(SELECT 1 FROM auth.users) THEN RAISE EXCEPTION 'AUTH_SEED_TARGET_NOT_EMPTY'; END IF; END $guard$;",
        "RESET ROLE;",
        f"SET LOCAL ROLE {identifier(role_prefix + '_owner')};",
        "DO $guard$ BEGIN IF EXISTS(SELECT 1 FROM public.workspaces) THEN RAISE EXCEPTION 'WORKSPACE_SEED_TARGET_NOT_EMPTY'; END IF; END $guard$;",
        "RESET ROLE; SET CONSTRAINTS ALL DEFERRED;",
    ]
    previous_role = None
    for schema, table, row in rows:
        role = role_prefix + ("_authadmin" if schema == "auth" else "_storageadmin" if schema == "storage" else "_owner")
        if role != previous_role:
            sql.extend(["RESET ROLE;", f"SET LOCAL ROLE {identifier(role)};"])
            previous_role = role
        sql.append(row_insert(schema, table, row))
    sql.extend(["RESET ROLE;", f"SET LOCAL ROLE {identifier(role_prefix + '_owner')};",
                "DO $guard$ BEGIN IF EXISTS(SELECT 1 FROM public.jobs) OR EXISTS(SELECT 1 FROM public.documents) OR EXISTS(SELECT 1 FROM public.opportunities) OR EXISTS(SELECT 1 FROM public.proposals) THEN RAISE EXCEPTION 'SEED_BUSINESS_HISTORY_NOT_EMPTY'; END IF; END $guard$;",
                "RESET ROLE; COMMIT;"])
    return "\n".join(sql) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--export-dir", type=Path, required=True)
    parser.add_argument("--role-prefix", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    rows, manifest = select_essentials(args.export_dir, args.role_prefix)
    sql = build_seed(rows, manifest, args.role_prefix, args.database)
    manifest["sql_sha256"] = hashlib.sha256(sql.encode()).hexdigest()
    private_write(args.output, sql)
    private_write(args.output.with_suffix(".manifest.json"), json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, sort_keys=True))


if __name__ == "__main__":
    main()
