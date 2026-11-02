// @vitest-environment node
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
let f: Awaited<ReturnType<typeof workflowFixture>>;
beforeAll(async () => {
  f = await workflowFixture();
}, 30000);
afterAll(async () => {
  await f?.db.close();
});
const script = (s: string) =>
  s
    .replaceAll("__WORKSPACE__", f.w)
    .replaceAll(
      "current_database() <> 'tenderdesk_app'",
      "current_database() <> 'postgres'",
    )
    .replaceAll(
      "current_database()<>'tenderdesk_app'",
      "current_database()<>'postgres'",
    )
    .replaceAll("SET LOCAL ROLE tdp_app_owner", "SET LOCAL ROLE postgres");
it("executes the exact catalog projection against every current migration in a read-only transaction", async () => {
  const py = readFileSync(
    new URL("../../scripts/ops/live-model-evaluation.py", import.meta.url),
    "utf8",
  );
  const sql = py.split('CATALOG_SQL = """')[1].split('""".replace')[0];
  const result = await f.db.exec(script(sql));
  expect(result.some((r) => r.rows.length === 1)).toBe(true);
});
it("executes the exact expanded routing and frozen-pool diagnostic in a read-only transaction", async () => {
  const sql = readFileSync(
    new URL("../../scripts/ops/ai-routing-diagnostic.sql", import.meta.url),
    "utf8",
  );
  const result = await f.db.exec(script(sql));
  const report: any = result
    .flatMap((r) => r.rows)
    .find((r: any) => r.jsonb_build_object)?.jsonb_build_object;
  expect(report).toHaveProperty("frozen_pools");
  expect(report).toHaveProperty("current_routes");
  expect(report.provider_history).toEqual([]);
});
