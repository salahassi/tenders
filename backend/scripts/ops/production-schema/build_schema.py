#!/usr/bin/env python3
"""Build application DDL from a privately captured PostgreSQL catalog.

Auth and Storage run their own pinned upstream migrations first. This builder
restores only public/app_private application objects and the application's four
Storage policies. It does not replay hosted platform migrations or copy rows.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path
import re


APPLICATION_SCHEMAS = {"public", "app_private"}
PLATFORM_REPLACEMENTS = {
    ("app_private", "dispatch_backend"),
    ("public", "configure_dispatcher"),
}
ROLE_SUFFIXES = {
    "postgres": "owner", "anon": "anon", "authenticated": "authenticated",
    "service_role": "service", "supabase_auth_admin": "authadmin",
    "supabase_storage_admin": "storageadmin",
}
PRIVILEGES = {
    "r": "SELECT", "a": "INSERT", "w": "UPDATE", "d": "DELETE",
    "D": "TRUNCATE", "x": "REFERENCES", "t": "TRIGGER", "m": "MAINTAIN",
    "U": "USAGE", "C": "CREATE", "X": "EXECUTE",
}


def identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def qualified(schema: str, name: str) -> str:
    return identifier(schema) + "." + identifier(name)


def checked_name(value: str, description: str) -> str:
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,39}", value):
        raise ValueError("Invalid " + description)
    return value


def read_catalog(directory: Path) -> dict:
    names = ["relations", "columns", "constraints", "indexes", "types",
             "sequences", "triggers-policies", "dependencies"]
    catalog = {name: json.loads((directory / (name + ".parsed.json")).read_text())
               for name in names}
    catalog["routines"] = [
        row for name in ("public", "app_private")
        for path in sorted(directory.glob(name + "-routines-*.parsed.json"))
        for row in json.loads(path.read_text())
    ]
    if not catalog["routines"]:
        raise ValueError("Application routines are missing from catalog")
    return catalog


def acl_grants(acl: str | None, object_type: str, target: str,
               role_prefix: str, *, default_public: bool = False) -> list[str]:
    """Replay only reviewed role names, keeping privilege and grant-option scope."""
    output = [f"REVOKE ALL ON {object_type} {target} FROM PUBLIC;"]
    if acl is None:
        if default_public:
            output.append(f"GRANT EXECUTE ON {object_type} {target} TO PUBLIC;")
        return output
    if not acl.startswith("{") or not acl.endswith("}"):
        raise ValueError("Unsupported catalog ACL")
    # The source inventory contains only these simple nonquoted role names.
    # Reject quoted/escaped array elements rather than guessing PostgreSQL syntax.
    for entry in acl[1:-1].split(","):
        match = re.fullmatch(r"([a-z_]*?)=([A-Za-z*]*)/([a-z_]+)", entry)
        if not match:
            raise ValueError("Unsupported catalog ACL entry")
        grantee, codes, grantor = match.groups()
        if grantor != "postgres" or grantee not in {"", *ROLE_SUFFIXES}:
            raise ValueError("Unmapped catalog ACL role")
        if grantee == "postgres":
            continue  # ownership already provides these privileges
        role = "PUBLIC" if not grantee else identifier(role_prefix + "_" + ROLE_SUFFIXES[grantee])
        groups: dict[bool, list[str]] = defaultdict(list)
        index = 0
        while index < len(codes):
            code = codes[index]
            if code not in PRIVILEGES:
                raise ValueError("Unsupported ACL privilege")
            grant_option = index + 1 < len(codes) and codes[index + 1] == "*"
            groups[grant_option].append(PRIVILEGES[code])
            index += 2 if grant_option else 1
        for grant_option, privileges in groups.items():
            suffix = " WITH GRANT OPTION" if grant_option else ""
            output.append(f"GRANT {', '.join(privileges)} ON {object_type} {target} TO {role}{suffix};")
    return output


def build_schema(catalog: dict, role_prefix: str, expected_database: str) -> tuple[str, dict]:
    checked_name(role_prefix, "role prefix")
    checked_name(expected_database, "database")
    roles = {key: identifier(role_prefix + "_" + suffix) for key, suffix in ROLE_SUFFIXES.items()}
    rows = [row for row in catalog["relations"] if row["schema"] in APPLICATION_SCHEMAS]
    relations = {int(row["oid"]): row for row in rows}
    tables = [row for row in rows if row["relkind"] == "r"]
    views = [row for row in rows if row["relkind"] == "v"]
    if not tables or any(row["owner"] != "postgres" for row in rows):
        raise ValueError("Unexpected application ownership or missing tables")
    if any(row["relkind"] not in {"r", "v", "S"} or row["is_partition"]
           or row["relpersistence"] != "p" for row in rows):
        raise ValueError("Unsupported application relation kind")
    if any(not row["relrowsecurity"] for row in tables if row["schema"] == "public"):
        raise ValueError("A public application table does not enable RLS")
    if any(row["schema"] in APPLICATION_SCHEMAS and row["typtype"] not in {"b", "c"}
           for row in catalog["types"]):
        raise ValueError("Explicit application types require a reviewed builder extension")
    columns: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for column in catalog["columns"]:
        if column["schema"] in APPLICATION_SCHEMAS:
            columns[(column["schema"], column["relname"])].append(column)
    constraints = [row for row in catalog["constraints"] if int(row["conrelid"]) in relations]
    if any(row["contypid"] or row["conparentid"] or not row["convalidated"] for row in constraints):
        raise ValueError("Unsupported inherited/domain/unvalidated constraint")
    routines = [row for row in catalog["routines"]
                if row["schema"] in APPLICATION_SCHEMAS
                and row["proname"] != "rls_auto_enable"
                and (row["schema"], row["proname"]) not in PLATFORM_REPLACEMENTS]
    if any(row["owner"] != "postgres" or row["language"] not in {"sql", "plpgsql"}
           or row["prokind"] != "f" for row in routines):
        raise ValueError("Unsupported application routine")
    if any(re.search(r"\b(?:net|vault|cron)\s*\.", re.sub(r"--[^\n]*", "", row["definition"]), re.I)
           for row in routines):
        raise ValueError("An unadapted hosted-platform routine remains")
    export = catalog["triggers-policies"][0]["export"]
    policies = [row for row in export["policies"]
                if row["schema"] in APPLICATION_SCHEMAS or row["schema"] == "storage"]
    triggers = [row for row in export["triggers"]
                if row["schema"] in APPLICATION_SCHEMAS and not row["tgisinternal"]]
    source_hash = hashlib.sha256(json.dumps(catalog, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    sql = [
        "-- Application schema only; generated from reviewed private catalog metadata.",
        "-- Auth/Storage upstream migrations and database-scoped roles are prerequisites.",
        "BEGIN;",
        "SET LOCAL check_function_bodies = false;",
        "SET LOCAL search_path = public, extensions, pg_catalog;",
        f"DO $guard$ BEGIN IF current_database() <> {literal(expected_database)} THEN RAISE EXCEPTION 'APPLICATION_DATABASE_MISMATCH'; END IF;",
        "IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname,c.relname) IN (('auth','users'),('auth','identities'),('storage','objects')) AND c.relkind='r')<>3 THEN RAISE EXCEPTION 'UPSTREAM_MIGRATIONS_REQUIRED'; END IF;",
        "IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','app_private') AND c.relkind IN ('r','p','v','m','S')) THEN RAISE EXCEPTION 'APPLICATION_SCHEMA_NOT_EMPTY'; END IF; END $guard$;",
        f"CREATE SCHEMA app_private AUTHORIZATION {roles['postgres']};",
        f"SET LOCAL ROLE {roles['supabase_auth_admin']};",
        f"GRANT SELECT, REFERENCES ON auth.users, auth.identities TO {roles['postgres']};",
        "RESET ROLE;",
        f"SET LOCAL ROLE {roles['postgres']};",
        "REVOKE ALL ON SCHEMA app_private FROM PUBLIC;",
        f"GRANT USAGE ON SCHEMA app_private TO {roles['authenticated']}, {roles['service_role']}, {roles['supabase_storage_admin']};",
        f"ALTER DEFAULT PRIVILEGES IN SCHEMA public, app_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;",
    ]
    for row in sorted(tables, key=lambda value: (value["schema"], value["relname"])):
        definitions = []
        for column in sorted(columns[(row["schema"], row["relname"])], key=lambda value: value["attnum"]):
            if column["acl"] is not None or column["attgenerated"] or column["collation"] not in {None, '"default"'} or not column["attislocal"]:
                raise ValueError("Unsupported special application column")
            definition = identifier(column["attname"]) + " " + column["data_type"]
            if column["attidentity"]:
                if column["attidentity"] not in {"a", "d"}:
                    raise ValueError("Unknown identity mode")
                mode = "ALWAYS" if column["attidentity"] == "a" else "BY DEFAULT"
                definition += f" GENERATED {mode} AS IDENTITY"
            elif column["default_expression"] is not None:
                definition += " DEFAULT " + column["default_expression"]
            if column["attnotnull"]:
                definition += " NOT NULL"
            definitions.append(definition)
        sql.append(f"CREATE TABLE {qualified(row['schema'], row['relname'])} (\n  " + ",\n  ".join(definitions) + "\n);")
    # AS-string routine bodies defer validation, so mutually dependent routines
    # and views can be restored without weakening their runtime ACLs.
    for row in routines:
        definition = row["definition"]
        if (row["schema"], row["proname"]) == ("app_private", "assessment_inputs_current"):
            definition = definition.replace("'none','service_role'", "'none'," + literal(role_prefix + "_service"))
        sql.append(definition.rstrip().rstrip(";") + ";")
    for row in sorted(constraints, key=lambda value: (value["contype"] == "f", value["schema"], value["conname"])):
        relation = relations[int(row["conrelid"])]
        sql.append(f"ALTER TABLE {qualified(relation['schema'], relation['relname'])} ADD CONSTRAINT {identifier(row['conname'])} {row['definition']};")
    constraint_indexes = {(int(row["conrelid"]), row["conname"]) for row in constraints if row["contype"] in {"p", "u", "x"}}
    index_count = 0
    relation_names = {(row["schema"], row["relname"]): int(row["oid"]) for row in tables}
    for row in catalog["indexes"]:
        relation_id = relation_names.get((row["schema"], row["table_name"]))
        if relation_id is None or (relation_id, row["index_name"]) in constraint_indexes:
            continue
        if not row["indisvalid"] or not row["indisready"] or row["indisclustered"] or row["indisreplident"]:
            raise ValueError("Unsupported application index state")
        sql.append(row["definition"].rstrip(";") + ";")
        index_count += 1
    for row in views:
        if row["reloptions"] != ["security_invoker=true"]:
            raise ValueError("Application view must use security_invoker")
        sql.append(f"CREATE VIEW {qualified(row['schema'], row['relname'])} WITH (security_invoker=true) AS {row['view_definition'].rstrip().rstrip(';')};")
    for row in tables:
        if row["relrowsecurity"]:
            sql.append(f"ALTER TABLE {qualified(row['schema'], row['relname'])} ENABLE ROW LEVEL SECURITY;")
        if row["relforcerowsecurity"]:
            sql.append(f"ALTER TABLE {qualified(row['schema'], row['relname'])} FORCE ROW LEVEL SECURITY;")
    for row in triggers:
        if row["tgenabled"] != "O":
            raise ValueError("Unsupported nondefault trigger state")
        sql.append(row["definition"].rstrip(";") + ";")
    for row in rows:
        target = qualified(row["schema"], row["relname"])
        sql.extend(acl_grants(row["acl"], "SEQUENCE" if row["relkind"] == "S" else "TABLE", target, role_prefix))
    for row in routines:
        target = qualified(row["schema"], row["proname"]) + "(" + row["identity_arguments"] + ")"
        sql.extend(acl_grants(row["acl"], "FUNCTION", target, role_prefix, default_public=True))
    commands = {"r": "SELECT", "a": "INSERT", "w": "UPDATE", "d": "DELETE", "*": "ALL"}
    for row in policies:
        if row["schema"] == "storage":
            sql.extend(["RESET ROLE;", f"SET LOCAL ROLE {roles['supabase_storage_admin']};"])
        elif row["schema"] not in APPLICATION_SCHEMAS:
            raise ValueError("Unmapped policy schema")
        else:
            sql.extend(["RESET ROLE;", f"SET LOCAL ROLE {roles['postgres']};"])
        policy_roles = []
        for role in row["roles"]:
            if role == "public":
                policy_roles.append("PUBLIC")
            elif role in roles:
                policy_roles.append(roles[role])
            else:
                raise ValueError("Unmapped policy role")
        mode = "PERMISSIVE" if row["polpermissive"] else "RESTRICTIVE"
        statement = f"CREATE POLICY {identifier(row['polname'])} ON {qualified(row['schema'], row['relname'])} AS {mode} FOR {commands[row['polcmd']]} TO {', '.join(policy_roles)}"
        if row["using_expression"] is not None:
            statement += " USING (" + row["using_expression"] + ")"
        if row["check_expression"] is not None:
            statement += " WITH CHECK (" + row["check_expression"] + ")"
        sql.append(statement + ";")
    sql.extend(["RESET ROLE;", "COMMIT;"])
    manifest = {
        "format": "tenderdesk-application-schema-v1", "catalog_sha256": source_hash,
        "database": expected_database, "role_prefix": role_prefix,
        "tables": len(tables), "views": len(views), "routines": len(routines),
        "constraints": len(constraints), "standalone_indexes": index_count,
        "triggers": len(triggers), "policies": len(policies),
        "upstream_auth_storage_required": True, "production_rows_included": False,
        "requires_runtime_dispatcher_replacement": True,
    }
    return "\n".join(sql) + "\n", manifest


def private_write(path: Path, content: str) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(content)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog-dir", required=True, type=Path)
    parser.add_argument("--role-prefix", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    sql, manifest = build_schema(read_catalog(args.catalog_dir), args.role_prefix, args.database)
    private_write(args.output, sql)
    private_write(args.output.with_suffix(".manifest.json"), json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, sort_keys=True))


if __name__ == "__main__":
    main()
