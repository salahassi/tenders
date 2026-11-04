// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

const source = new URL(
  "../../scripts/ops/digitalocean-inventory.sql",
  import.meta.url,
);
async function fixture() {
  const db = new PGlite();
  await db.exec(
    "create role tdp_app_owner;create schema app_private authorization tdp_app_owner;",
  );
  return db;
}
it("rejects the wrong database before returning a catalog inventory", async () => {
  const db = await fixture();
  try {
    await expect(db.exec(await readFile(source, "utf8"))).rejects.toThrow(
      "INVENTORY_DATABASE_IDENTITY_MISMATCH",
    );
    await db.exec("rollback");
  } finally {
    await db.close();
  }
});
it.each([false, true])(
  "reads optional migration ledgers without exposing routine bodies or changing rows (present: %s)",
  async (present) => {
    const db = await fixture();
    try {
      await db.exec(
        "create function public.synthetic_private_body() returns text language sql as $$select 'Synthetic confidential text, never a public diagnostic'$$;",
      );
      if (present)
        await db.exec(`create table app_private.application_release_history(release text,migration_sha256 text,applied_at timestamptz);
      grant select on app_private.application_release_history to tdp_app_owner;
      insert into app_private.application_release_history values('analysis-verifier-recheck-v1',repeat('a',64),now());
      create schema supabase_migrations;grant usage on schema supabase_migrations to tdp_app_owner;
      create table supabase_migrations.schema_migrations(version text);grant select on supabase_migrations.schema_migrations to tdp_app_owner;
      insert into supabase_migrations.schema_migrations values('20261103022500');`);
      // Production retains its exact database guard; only this isolated fixture
      // substitutes PGlite's fixed database name so the read-only body is exercised.
      const sql = (await readFile(source, "utf8")).replace(
        "current_database()<>'tenderdesk_app'",
        "current_database()<>'postgres'",
      );
      const result = await db.exec(sql);
      const receipt = JSON.parse(
        (
          result.find((r) => (r.rows[0] as any)?.current_setting)
            ?.rows[0] as any
        ).current_setting,
      );
      expect(receipt.releases).toHaveLength(present ? 1 : 0);
      expect(receipt.canonical_migrations).toEqual(
        present ? { count: 1, latest_version: "20261103022500" } : null,
      );
      expect(receipt.routine_catalog_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(receipt.capabilities.delivery_artifacts).toBe(false);
      expect(JSON.stringify(receipt)).not.toContain(
        "Synthetic confidential text",
      );
      if (present)
        expect(
          (
            await db.query<any>(
              "select count(*)::int n from app_private.application_release_history",
            )
          ).rows[0].n,
        ).toBe(1);
    } finally {
      await db.close();
    }
  },
);
