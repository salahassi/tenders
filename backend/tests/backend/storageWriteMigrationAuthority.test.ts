// @vitest-environment node
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { databaseWithMigrations } from "./databaseFixture";

const boundary = "20261104163406_serialize_local_document_rendering.sql";
const migration = new URL(
  "../../supabase/migrations/20261104170442_durable_storage_write_intents.sql",
  import.meta.url,
);

for (const family of ["supabase", "managed"] as const) {
  it(`preserves canonical command authority for the ${family} role family while closing its predecessor`, async () => {
    const db = await databaseWithMigrations(boundary);
    try {
      if (family === "managed") {
        await db.exec(
          "alter role anon rename to tdp_app_anon; alter role authenticated rename to tdp_app_authenticated; alter role service_role rename to tdp_app_service",
        );
      }
      const role = family === "managed" ? "tdp_app_authenticated" : "authenticated";
      const signature = "app_private.app_command(text,jsonb,text)";
      const authority = async () =>
        (
          await db.query(
            "select pg_get_userbyid(proowner) owner,prosecdef,proconfig,proacl::text acl from pg_proc where oid=$1::regprocedure",
            [signature],
          )
        ).rows[0];
      const before = await authority();
      expect(
        (
          await db.query<{ allowed: boolean }>(
            "select has_function_privilege($1,$2,'EXECUTE') allowed",
            [role, signature],
          )
        ).rows[0].allowed,
      ).toBe(true);

      await db.exec(await readFile(migration, "utf8"));

      expect(await authority()).toEqual(before);
      expect(
        (
          await db.query<{ allowed: boolean }>(
            "select has_function_privilege($1,'app_private.app_command_before_storage_intents(text,jsonb,text)','EXECUTE') allowed",
            [role],
          )
        ).rows[0].allowed,
      ).toBe(false);
      expect(
        (
          await db.query<{ grants: number }>(
            "select count(*)::int grants from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid='app_private.app_command_before_storage_intents(text,jsonb,text)'::regprocedure and a.grantee<>p.proowner",
          )
        ).rows[0].grants,
      ).toBe(0);
    } finally {
      await db.close();
    }
  }, 30000);
}
