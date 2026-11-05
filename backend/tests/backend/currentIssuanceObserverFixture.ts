import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import type { workflowFixture } from "./workflowFixture";

// The complete observer SQL runs in its own READ ONLY transaction. Only its
// production database/owner identity is mapped to this synthetic PGlite fixture.
// No claim is made about native PostgreSQL, managed ACLs or hosted evidence.
export async function currentIssuanceObservation(
  f: Awaited<ReturnType<typeof workflowFixture>>,
  target: { opportunity_id: string; proposal_id: string; plan_id: string; issuance_request_id: string },
) {
  let sql = await readFile(new URL("../../scripts/ops/proposal-current-issuance.sql", import.meta.url), "utf8");
  const identity = (await f.db.query<{ role: string; database: string }>("select current_user role,current_database() database")).rows[0];
  expect(identity.role).toMatch(/^[a-z_][a-z0-9_]*$/);
  expect(identity.database).toMatch(/^[a-z_][a-z0-9_]*$/);
  sql = sql.replace("SET LOCAL ROLE tdp_app_owner;", `SET LOCAL ROLE ${identity.role};`)
    .replace("current_database()='tenderdesk_app'", `current_database()='${identity.database}'`);
  const values = { WORKSPACE: f.w, OPPORTUNITY: target.opportunity_id, PROPOSAL: target.proposal_id,
    PLAN: target.plan_id, ISSUANCE: target.issuance_request_id, ACTOR: f.owner };
  for (const [name, value] of Object.entries(values)) {
    expect(value).toMatch(/^[a-f0-9-]{36}$/);
    sql = sql.replaceAll(`__${name}__`, value);
  }
  const results = (await f.db.exec(sql)).flatMap((result) => result.rows)
    .map((row: any) => row.jsonb_build_object).filter((v: any) => v?.kind === "current_proposal_issuance_observation");
  expect(results).toHaveLength(1);
  return results[0];
}
