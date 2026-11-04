// @vitest-environment node
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>,
  selected: Record<string, any>;
beforeAll(async () => {
  f = await workflowFixture();
  await f.db.exec("begin");
  const source = await f.command("source.create", {
    name: "Synthetic acceptance source",
    kind: "manual",
  });
  const o = await f.command("opportunity.create", {
    source_id: source.id,
    title: "Synthetic early delivery",
    reference: "SYNTHETIC",
    description: "Provide an operating method.",
    language: "en",
    decision: "shortlisted",
  });
  const s = await f.command("delivery.snapshot.prepare", {
    opportunity_id: o.id,
    expected_revision: o.revision,
  });
  const p = (
    await f.db.query<any>(
      "select delivery_revision from public.proposals where id=$1",
      [s.proposal_id],
    )
  ).rows[0];
  selected = {
    workspace_id: f.w,
    opportunity_id: o.id,
    proposal_id: s.proposal_id,
    snapshot_id: s.id,
    content_hash: s.content_hash,
    delivery_revision: p.delivery_revision,
  };
  await f.db.exec("commit");
}, 30000);
afterAll(async () => f?.db.close());
const sql = (value: unknown) =>
  readFileSync(
    new URL(
      "../../scripts/ops/delivery-snapshot-selection.sql",
      import.meta.url,
    ),
    "utf8",
  )
    .replaceAll("__SELECTION__", JSON.stringify(value))
    .replaceAll(
      "current_database()<>'tenderdesk_app'",
      "current_database()<>'postgres'",
    )
    .replaceAll("SET LOCAL ROLE tdp_app_owner", "SET LOCAL ROLE postgres");
it("selects a genuine early snapshot without requiring completed AI generation", async () => {
  const rows = (await f.db.exec(sql(selected))).flatMap((x) => x.rows);
  expect(
    rows.some((r: any) => r.jsonb_build_object?.actor_id === f.owner),
  ).toBe(true);
});
it.each([
  { delivery_revision: 999 },
  { content_hash: "b".repeat(64) },
  { snapshot_id: crypto.randomUUID() },
  { proposal_id: crypto.randomUUID() },
])("rejects stale immutable selection %j", async (changes) => {
  try {
    await expect(f.db.exec(sql({ ...selected, ...changes }))).rejects.toThrow(
      "DELIVERY_CURRENT_SNAPSHOT_REQUIRED",
    );
  } finally {
    await f.db.exec("rollback");
  }
});
it("rejects revoked membership before creating an isolated real Auth session", async () => {
  await f.db.query(
    "update public.memberships set active=false where workspace_id=$1 and user_id=$2",
    [f.w, f.owner],
  );
  try {
    await expect(f.db.exec(sql(selected))).rejects.toThrow(
      "DELIVERY_EXACT_ACTIVE_OWNER_REQUIRED",
    );
  } finally {
    await f.db.exec("rollback");
    await f.db.query(
      "update public.memberships set active=true where workspace_id=$1 and user_id=$2",
      [f.w, f.owner],
    );
  }
});
