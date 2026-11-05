// @vitest-environment node
// Canonical SQL contract test only. Auth identities below belong to PGlite;
// actual Auth, HTTP upload and Kubernetes/PVC proof require the hosted drill.
import { afterAll, beforeAll, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { databaseWithMigrations } from "./databaseFixture";

let db: Awaited<ReturnType<typeof databaseWithMigrations>>;
const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
let database: string;
let marker: string;
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const name = (value: string) => {
  if (!/^[a-z_]+$/.test(value)) throw Error("Invalid fixed test identifier");
  return '"' + value + '"';
};
async function rpc(
  operation: string,
  values: Record<string, unknown> = {},
  actor?: string,
): Promise<any> {
  const entries = Object.entries(values);
  await db.exec("savepoint fixture_rpc");
  try {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [
      actor || "",
    ]);
    await db.exec("set local role " + (actor ? "authenticated" : "service_role"));
    return (
      await db.query<{ data: any }>(
        `select public.${name(operation)}(${entries.map(([key], index) => name(key) + "=>$" + (index + 1)).join(",")}) data`,
        entries.map(([, value]) =>
          value !== null && typeof value === "object" ? JSON.stringify(value) : value,
        ),
      )
    ).rows[0].data;
  } catch (error) {
    await db.exec("rollback to savepoint fixture_rpc");
    throw error;
  } finally {
    await db.exec("reset role; release savepoint fixture_rpc");
  }
}
const command = (operation: string, input: unknown) =>
  rpc("app_command", { operation, input, idempotency_key: crypto.randomUUID() }, owner);

beforeAll(async () => {
  db = await databaseWithMigrations();
  database = (await db.query<{ name: string }>("select current_database() name")).rows[0].name;
  marker = "tenderdesk-isolated-bootstrap:" + database + ":test_fixture";
  await db.exec(`comment on database ${name(database)} is ${literal(marker)}`);
  const source = await readFile(new URL("../../scripts/ops/cloud-retirement/fixture.sql", import.meta.url), "utf8");
  const sql = source
    .replaceAll("__OWNER__", "postgres")
    .replaceAll("__SERVICE__", "service_role")
    .replaceAll("__DATABASE_LITERAL__", literal(database))
    .replaceAll("__DATABASE_COMMENT_LITERAL__", literal(marker));
  await db.exec(sql);
  await db.query("insert into auth.users values($1,'owner@example.invalid',now()),($2,'other@example.invalid',now())", [owner, other]);
  await db.query("insert into auth.identities values($1,'email',$3::jsonb),($2,'email',$4::jsonb)",
    [owner, other, JSON.stringify({ sub: owner }), JSON.stringify({ sub: other })]);
}, 30000);
afterAll(async () => db?.close());

it("rejects a changed nonce database comment before creating any workspace", async () => {
  await db.exec("begin");
  try {
    await db.exec(`comment on database ${name(database)} is 'different-fixture'`);
    await expect(rpc("retirement_fixture_users", { source_user: owner, target_user: other }))
      .rejects.toThrow("RETIREMENT_FIXTURE_DATABASE_GUARD");
    expect((await db.query("select id from public.workspaces")).rows).toEqual([]);
    expect((await db.query("select * from app_private.retirement_fixture_identity")).rows).toEqual([]);
  } finally { await db.exec("rollback"); }
});

it("requires service authority for helpers without adding browser private-state access", async () => {
  await db.exec("begin");
  try {
    await expect(rpc("retirement_fixture_users", { source_user: owner, target_user: other }, owner))
      .rejects.toThrow(/permission denied/);
    await expect(rpc("retirement_fixture_status", { storage_key: "fixture/key" }, owner))
      .rejects.toThrow(/permission denied/);
  } finally { await db.exec("rollback"); }
});

it("creates one uncertain canonical intent and real purge allowance without direct business-state writes", async () => {
  await db.exec("begin");
  try {
    const identity = await rpc("retirement_fixture_users", { source_user: owner, target_user: other });
    const source = await command("source.create", { name: "Synthetic retirement contract", kind: "manual" });
    const opportunity = await command("opportunity.create", {
      source_id: source.id, title: "Synthetic retirement qualification", reference: "ISOLATED-RETIREMENT",
      description: "The supplier must document the approval workflow and demonstrate acceptance.",
      language: "en", decision: "shortlisted",
    });
    const snapshot = await command("delivery.snapshot.prepare", { opportunity_id: opportunity.id, expected_revision: opportunity.revision });
    const job = await rpc("claim_backend_job_v4");
    expect(job).toMatchObject({ type: "render_delivery", entity_id: snapshot.id });
    const context = await rpc("delivery_export_context", { job_id: job.id, lease: job.lease_token });
    expect(context.artifacts).toHaveLength(1);
    const key = context.artifacts[0].storage_key;
    const bytes = Buffer.from(Array.from({ length: 16384 }, (_, i) => i % 256));
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(await rpc("begin_render_storage_write", { job_id: job.id, lease: job.lease_token, storage_key: key,
      expected_hash: hash, expected_size: bytes.length })).toMatchObject({ send: true, state: "unknown" });
    // The hosted writer uploads the bytes here and deliberately leaves their
    // completion unacknowledged. This local SQL test makes no HTTP/PVC claim.
    await rpc("fail_delivery_export", { job_id: job.id, lease: job.lease_token, error_code: "DELIVERY_STORAGE_UNAVAILABLE" });
    const current = (await db.query<{ revision: number }>("select revision from public.opportunities where id=$1", [opportunity.id])).rows[0];
    await rpc("archive_opportunity", { opportunity_id: opportunity.id, expected_revision: current.revision,
      archive: true, reason: "Synthetic Owner purge of an unacknowledged isolated upload." }, owner);
    const preview = await rpc("preview_opportunity_purge", { opportunity_id: opportunity.id }, owner);
    expect(preview).toMatchObject({ archived: true, active_worker: false });
    await rpc("purge_opportunity", { opportunity_id: opportunity.id, preview_hash: preview.preview_hash,
      confirmed_title: opportunity.title, reason: "Synthetic Owner purge for isolated process retirement proof.", acknowledge_history: true }, owner);
    const selected = await rpc("retirement_fixture_selection", { storage_key: key, expected_hash: hash, expected_size: bytes.length });
    expect(selected).toMatchObject({ actor_id: owner, workspace_id: identity.workspace_id, expected_hash: hash, expected_size: 16384 });
    expect(selected.selection).toHaveLength(1);
    expect(selected.selection[0]).toMatchObject({ storage_key: key, revision: 2 });
    expect(await rpc("retirement_fixture_status", { storage_key: key })).toMatchObject({ intent_state: "unknown",
      send_closed: false, cleanup_status: "pending", estimated_size: 10485760,
      fence_count: 0, completed_batch_count: 0, completion_audit_count: 0, provider_usage_count: 0 });
    expect((await rpc("workspace_status", {}, owner)).storage_write_uncertainty)
      .toMatchObject({ held_bytes: 10485760, unsettled_keys: 1 });
    await expect(rpc("retirement_fixture_selection", { storage_key: key, expected_hash: "a".repeat(64), expected_size: bytes.length }))
      .rejects.toThrow("RETIREMENT_FIXTURE_CANONICAL_STATE_INVALID");
  } finally { await db.exec("rollback"); }
}, 30000);
