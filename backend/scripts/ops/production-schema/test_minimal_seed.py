import copy
import json
from pathlib import Path
import tempfile
import unittest

from build_minimal_seed import build_seed, select_essentials
from build_schema import acl_grants, checked_name


class MinimalSeedGuards(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.owner = "00000000-0000-4000-8000-000000000001"
        self.editor = "00000000-0000-4000-8000-000000000002"
        self.workspace = "00000000-0000-4000-8000-000000000010"
        self.user = {"id": self.owner, "created_at": "2026-01-01T00:00:00Z", "email": "owner@example.invalid",
                     "email_confirmed_at": "2026-01-01T00:00:00Z", "encrypted_password": "$2b$10$" + "a" * 53,
                     "role": "authenticated", "aud": "authenticated", "confirmed_at": "generated",
                     "recovery_token": "synthetic-token-must-not-migrate", "last_sign_in_at": "2026-01-01T00:00:00Z"}
        self.identity = {"id": self.owner, "user_id": self.owner, "provider": "email", "provider_id": self.owner,
                         "identity_data": {"sub": self.owner}, "email": "owner@example.invalid"}
        self.member = {"workspace_id": self.workspace, "user_id": self.owner, "role": "Owner", "active": True, "created_by": self.owner}
        self.allowlist = {"workspace_id": self.workspace, "user_id": self.owner, "role": "Owner", "status": "active", "provider": "email",
                          "provider_user_id": self.owner, "verified_email": "owner@example.invalid", "created_by": self.owner}
        self.write("auth", "users", [self.user, {**self.user, "id": self.editor, "created_at": "2026-01-02T00:00:00Z"}])
        self.write("auth", "identities", [self.identity])
        self.write("public", "workspaces", [{"id": self.workspace, "created_by": self.owner, "model_enabled": True, "restore_origin": "old-origin"}])
        self.write("public", "memberships", [self.member])
        self.write("public", "identity_allowlist", [self.allowlist])
        self.write("public", "model_connections", [{"workspace_id": self.workspace, "created_by": self.editor, "credential_alias": "APP_MODEL_EXAMPLE_KEY"}])
        self.write("public", "model_execution_settings", [{"workspace_id": self.workspace, "created_by": self.owner, "enabled": True}])
        self.write("storage", "buckets", [{"id": "tenderdesk-private", "name": "tenderdesk-private", "public": False, "file_size_limit": 10485760, "allowed_mime_types": ["text/plain"]}])

    def write(self, schema, table, rows):
        destination = self.root / "data" / schema
        destination.mkdir(parents=True, exist_ok=True)
        (destination / (table + ".json")).write_text(json.dumps(rows))

    def select(self):
        return select_essentials(self.root, "tdp_app")

    def test_copies_exactly_one_login_and_preserves_password_hash(self):
        rows, manifest = self.select()
        users = [row for schema, table, row in rows if (schema, table) == ("auth", "users")]
        self.assertEqual(len(users), 1)
        self.assertEqual(users[0]["encrypted_password"], self.user["encrypted_password"])
        self.assertEqual(users[0]["role"], "tdp_app_authenticated")
        self.assertEqual(users[0]["aud"], "authenticated")
        self.assertNotIn("confirmed_at", users[0])
        self.assertEqual(users[0]["recovery_token"], "")
        self.assertIsNone(users[0]["last_sign_in_at"])
        self.assertEqual(manifest["login_accounts"], 1)

    def test_preserves_only_actor_uuid_for_secondary_creator(self):
        rows, manifest = self.select()
        actors = [row for schema, table, row in rows if table == "workspace_actors"]
        self.assertIn({"id": self.editor, "workspace_id": self.workspace, "kind": "historical"}, actors)
        self.assertEqual(manifest["historical_attribution_actors"], 1)
        self.assertFalse(any(table == "memberships" and row["user_id"] == self.editor for _, table, row in rows))

    def test_excludes_sessions_old_files_and_business_rows(self):
        self.write("auth", "sessions", [{"user_id": self.owner, "sensitive": "synthetic-session"}])
        self.write("public", "opportunities", [{"workspace_id": self.workspace, "title": "excluded"}])
        self.write("storage", "objects", [{"bucket_id": "tenderdesk-private", "name": "excluded"}])
        rows, manifest = self.select()
        self.assertFalse(any(table in {"sessions", "opportunities", "objects"} for _, table, _ in rows))
        self.assertFalse(manifest["auth_sessions_copied"])
        self.assertFalse(manifest["business_history_copied"])

    def test_disables_processing_and_recreates_unverified_operations(self):
        rows, _ = self.select()
        workspace = next(row for _, table, row in rows if table == "workspaces")
        execution = next(row for _, table, row in rows if table == "model_execution_settings")
        operations = next(row for _, table, row in rows if table == "operations")
        self.assertFalse(workspace["model_enabled"])
        self.assertIsNone(workspace["restore_origin"])
        self.assertFalse(execution["enabled"])
        self.assertEqual(operations, {"workspace_id": self.workspace, "scheduler_enabled": False, "email_transport_ready": False})

    def test_refuses_ambiguous_or_non_owner_first_account(self):
        self.write("public", "memberships", [{**self.member, "role": "Editor"}])
        with self.assertRaisesRegex(ValueError, "active Owner"):
            self.select()

    def test_refuses_mismatched_identity_and_cross_auth_dependencies(self):
        self.write("public", "identity_allowlist", [{**self.allowlist, "provider_user_id": self.editor}])
        with self.assertRaisesRegex(ValueError, "email identity"):
            self.select()
        self.write("public", "identity_allowlist", [self.allowlist])
        self.write("public", "memberships", [{**self.member, "created_by": self.editor}])
        with self.assertRaisesRegex(ValueError, "another Auth user"):
            self.select()

    def test_refuses_public_bucket_or_missing_password(self):
        self.write("auth", "users", [{**self.user, "encrypted_password": ""}])
        with self.assertRaisesRegex(ValueError, "password hash"):
            self.select()
        self.write("auth", "users", [self.user])
        self.write("storage", "buckets", [{"id": "tenderdesk-private", "public": True}])
        with self.assertRaisesRegex(ValueError, "private application bucket"):
            self.select()

    def test_sql_guards_nonempty_target_generated_columns_and_unknown_columns(self):
        rows, manifest = self.select()
        sql = build_seed(rows, manifest, "tdp_app", "tenderdesk_app")
        for guard in ["AUTH_SEED_TARGET_NOT_EMPTY", "WORKSPACE_SEED_TARGET_NOT_EMPTY", "SEED_DATABASE_MISMATCH", "SEED_SOURCE_COLUMN_NOT_SUPPORTED", "SEED_BUSINESS_HISTORY_NOT_EMPTY"]:
            self.assertIn(guard, sql)
        self.assertIn("a.attgenerated=''", sql)
        self.assertNotIn("synthetic-token-must-not-migrate", sql)
        self.assertIn("jsonb_populate_record", sql)

    def test_refuses_role_injection_and_unmapped_acl_roles(self):
        with self.assertRaises(ValueError):
            checked_name('tdp; SELECT 1', 'role')
        with self.assertRaises(ValueError):
            acl_grants('{unknown=r/postgres}', 'TABLE', 'public.test', 'tdp_app')
        result = acl_grants('{postgres=arwdDxtm/postgres,authenticated=r/postgres}', 'TABLE', 'public.test', 'tdp_app')
        self.assertEqual(result, ['REVOKE ALL ON TABLE public.test FROM PUBLIC;', 'GRANT SELECT ON TABLE public.test TO "tdp_app_authenticated";'])


if __name__ == "__main__":
    unittest.main()
