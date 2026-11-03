// @vitest-environment node
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { commercialHelpers } from "./commercialFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
let selected: Record<string, any>;
beforeAll(async () => {
  f = await workflowFixture();
  await f.db.exec("begin");
  const data = await commercialHelpers(f).setup();
  const row = (
    await f.db.query<any>(
      "select opportunity_id from public.generation_plans where id=$1",
      [data.plan],
    )
  ).rows[0];
  selected = {
    version: 1,
    workspace_id: f.w,
    opportunity_id: row.opportunity_id,
    plan_id: data.plan,
    proposal_version_id: data.version,
    expected_revision: 1,
  };
  await f.db.exec("commit");
}, 30000);
afterAll(async () => {
  await f?.db.close();
});
const sql = (value: unknown) =>
  readFileSync(
    new URL("../../scripts/ops/proposal-export-selection.sql", import.meta.url),
    "utf8",
  )
    .replaceAll("__SELECTION__", JSON.stringify(value))
    .replaceAll(
      "current_database()<>'tenderdesk_app'",
      "current_database()<>'postgres'",
    )
    .replaceAll("SET LOCAL ROLE tdp_app_owner", "SET LOCAL ROLE postgres");
it("selects only the completed current version and active allowlisted Owner using real schema", async () => {
  const rows = (await f.db.exec(sql(selected))).flatMap((x) => x.rows);
  expect(
    rows.some((r: any) => r.jsonb_build_object?.actor_id === f.owner),
  ).toBe(true);
});
it.each(["revision", "plan", "version"])(
  "rejects stale or mismatched %s before Auth or export",
  async (kind) => {
    const changes =
      kind === "revision"
        ? { expected_revision: 2 }
        : kind === "plan"
          ? { plan_id: crypto.randomUUID() }
          : { proposal_version_id: crypto.randomUUID() };
    try {
      await expect(f.db.exec(sql({ ...selected, ...changes }))).rejects.toThrow(
        "EXPORT_COMPLETED_CURRENT_VERSION_REQUIRED",
      );
    } finally {
      await f.db.exec("rollback");
    }
  },
);
it("rejects a real version whose generating plan has not completed", async () => {
  await f.db.query(
    "update public.generation_plans set status='running' where id=$1",
    [selected.plan_id],
  );
  try {
    await expect(f.db.exec(sql(selected))).rejects.toThrow(
      "EXPORT_COMPLETED_CURRENT_VERSION_REQUIRED",
    );
  } finally {
    await f.db.exec("rollback");
    await f.db.query(
      "update public.generation_plans set status='completed' where id=$1",
      [selected.plan_id],
    );
  }
});
