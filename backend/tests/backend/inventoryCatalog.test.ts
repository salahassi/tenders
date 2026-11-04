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

it("measures real queue ages and storage reservations without exposing identities or inferring a delivery SLO", async () => {
  const db = await fixture();
  try {
    await db.exec(`create table public.jobs(class text,status text,created_at timestamptz,updated_at timestamptz,next_attempt_at timestamptz,lease_until timestamptz,private_text text);
    create function app_private.queue_work_class(j public.jobs) returns text language sql as $$select j.class$$;
    create table public.workspaces(id uuid);
    create function app_private.storage_reserved_bytes(uuid) returns bigint language sql as $$select 1000::bigint$$;
    create table public.proposal_delivery_artifacts(status text,reserved_bytes bigint,expected_size bigint);
    create table public.proposal_issuance_requests(outcome text,accepted_at timestamptz,deadline_at timestamptz,completed_at timestamptz,deadline_version int);
    grant select on public.proposal_issuance_requests to tdp_app_owner;
    insert into public.proposal_issuance_requests values
      ('issued',now()-interval '200 seconds',now()+interval '400 seconds',now()-interval '20 seconds',1),
      ('active',now()-interval '700 seconds',now()-interval '100 seconds',null,1),
      ('issued',now()-interval '700 seconds',now()-interval '100 seconds',now()-interval '50 seconds',1);
    grant usage on schema public to tdp_app_owner;
    grant select on public.jobs,public.workspaces,public.proposal_delivery_artifacts to tdp_app_owner;
    insert into public.workspaces values(gen_random_uuid());
    insert into public.proposal_delivery_artifacts values('pending',10485760,null),('ready',1000,1000);
    insert into public.jobs values
      ('local','queued',now()-interval '120 seconds',now(),now()-interval '1 minute',null,'Synthetic private text'),
      ('local','running',now()-interval '2 minutes',now(),now(),now()-interval '1 second','Synthetic private text'),
      ('local','succeeded',now()-interval '20 seconds',now()-interval '10 seconds',now(),null,'Synthetic private text'),
      ('proposal','retry_wait',now()-interval '1 hour',now(),now()+interval '1 hour',null,'Synthetic private text');`);
    const sql = (await readFile(source, "utf8")).replace(
      "current_database()<>'tenderdesk_app'",
      "current_database()<>'postgres'",
    );
    const result = await db.exec(sql);
    const receipt = JSON.parse(
      (result.find((r) => (r.rows[0] as any)?.current_setting)?.rows[0] as any)
        .current_setting,
    );
    expect(receipt.metrics.jobs).toHaveLength(2);
    const local = receipt.metrics.jobs.find((r: any) => r.class === "local");
    expect(local).toMatchObject({
      pending: 1,
      due: 1,
      running: 1,
      expired_leases: 1,
      succeeded_in_window: 1,
      terminal_row_elapsed_p95_seconds: 10,
    });
    expect(local.oldest_due_age_seconds).toBeGreaterThanOrEqual(120);
    expect(
      receipt.metrics.jobs.find((r: any) => r.class === "proposal"),
    ).toMatchObject({ pending: 1, due: 0, oldest_due_age_seconds: 0 });
    expect(receipt.metrics.delivery).toEqual({
      pending: 1,
      ready: 1,
      expired: 0,
      reserved_bytes: 10486760,
      ready_bytes: 1000,
    });
    expect(receipt.metrics.capacity).toMatchObject({
      workspace_count: 1,
      total_reserved_bytes: 1000,
      largest_workspace_reserved_bytes: 1000,
      workspaces_at_or_above_limit: 0,
      workspace_limit_bytes: 262144000,
    });
    expect(receipt.metrics.issuance).toMatchObject({
      active_before_deadline: 0,
      expired_unsettled: 1,
      issued_in_window: 2,
      failed_in_window: 0,
      issued_after_deadline: 1,
      invalid_deadline_bindings: 0,
      issued_latency_max_seconds: 650,
      deadline_seconds: 600,
    });
    expect(JSON.stringify(receipt)).not.toContain("Synthetic private text");
    expect(
      (await db.query<any>("select count(*)::int n from public.jobs")).rows[0]
        .n,
    ).toBe(4);
  } finally {
    await db.close();
  }
});
