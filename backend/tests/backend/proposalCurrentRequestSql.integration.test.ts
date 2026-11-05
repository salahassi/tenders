// @vitest-environment node
import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { createRecheckFixture } from "./analysisVerifierRecheckFixture";
import { currentProposalCommands, currentProposalRequest } from "../../../frontend/src/lib/currentProposalRequest";

// Fully migrated, synthetic PGlite PostgreSQL execution. This is not native PG,
// managed-role ACL, Auth/browser or hosted acceptance. Only the observer's two
// environmental identities are mapped to this isolated fixture's actual owner
// and database. The inspected SQL, source/history guards and READ ONLY boundary
// otherwise run unchanged against the complete canonical migration stack.
let f: Awaited<ReturnType<typeof workflowFixture>>;
let scenario: Awaited<ReturnType<typeof createRecheckFixture>>;
let source: string;
let observerRole: string;
let fixtureDatabase: string;
let before: any;
let unknownId: string;

function mappedSql(mapDatabase = true) {
  expect(source.split("SET LOCAL ROLE tdp_app_owner;")).toHaveLength(2);
  expect(source.split("current_database()='tenderdesk_app'")).toHaveLength(2);
  expect(observerRole).toMatch(/^[a-z_][a-z0-9_]*$/);
  expect(fixtureDatabase).toMatch(/^[a-z_][a-z0-9_]*$/);
  let result = source.replace("SET LOCAL ROLE tdp_app_owner;", `SET LOCAL ROLE ${observerRole};`)
    .replaceAll("__WORKSPACE__", f.w)
    .replaceAll("__OPPORTUNITY__", scenario.opportunity.id)
    .replaceAll("__PLAN__", scenario.plan.id);
  if (mapDatabase) result = result.replace("current_database()='tenderdesk_app'", `current_database()='${fixtureDatabase}'`);
  return result;
}

async function inspect(mapDatabase = true) {
  const rows = (await f.db.exec(mappedSql(mapDatabase))).flatMap((result) => result.rows);
  const proofs = rows.map((row: any) => row.jsonb_build_object)
    .filter((value: any) => value?.kind === "current_proposal_read_only_proof");
  expect(proofs).toHaveLength(1);
  return proofs[0];
}

async function transaction<T>(operation: () => Promise<T>) {
  await f.db.exec("begin");
  try {
    const result = await operation();
    await f.db.exec("commit");
    return result;
  } catch (error) {
    await f.db.exec("rollback; reset role");
    throw error;
  }
}

beforeAll(async () => {
  source = await readFile(new URL("../../scripts/ops/proposal-current-request-inspect.sql", import.meta.url), "utf8");
});
beforeEach(async () => {
  f = await workflowFixture();
  const identity = (await f.db.query<{ role: string; database: string }>("select current_user role,current_database() database")).rows[0];
  observerRole = identity.role;
  fixtureDatabase = identity.database;
  await transaction(async () => {
    scenario = await createRecheckFixture(f, { historicalDeliveryContract: true });
    unknownId = crypto.randomUUID();
    // Explicitly authored unresolved usage, never a provider response. Preserve
    // its complete canonical row across probing and the current-request batch.
    await f.db.query(`insert into public.provider_usage select
      (jsonb_populate_record(null::public.provider_usage,to_jsonb(u)||jsonb_build_object(
      'id',$1::uuid,'call_key','synthetic-current-request-unknown','state','unknown',
      'actual_input',null,'actual_output',null,'thinking_tokens',null,
      'error_code','MODEL_CONNECTION_UNCERTAIN'))).* from public.provider_usage u where u.id=$2`,
      [unknownId, scenario.usage.id]);
  });
  before = await inspect();
}, 30000);
afterEach(async () => f?.db.close());

it("executes the exact read-only projection with accepted history and unknown usage", async () => {
  expect(before.selection).toEqual({ version: 1, workspace_id: f.w, opportunity_id: scenario.opportunity.id, plan_id: scenario.plan.id });
  expect(Object.values(before.guards)).toEqual(Array(Object.keys(before.guards).length).fill(true));
  expect(before.protected_history.completed_steps.count).toBe(1);
  expect(before.protected_history.graph_results.count).toBeGreaterThan(0);
  expect(before.protected_history.phase_pins.count).toBeGreaterThan(0);
  expect(before.protected_history.graph_budgets.count).toBeGreaterThan(0);
  expect(before.protected_history.graph_checkpoints.count).toBeGreaterThan(0);
  expect(before.protected_history.graph_writes.count).toBeGreaterThan(0);
  expect(before.protected_history.unknown_usage.count).toBe(1);
  expect((await inspect()).protected_history).toEqual(before.protected_history);
  // The production database guard is still real: an unmapped name fails here.
  expect((await inspect(false)).guards.database).toBe(false);
});

it("preserves exact history through legacy rejection and one canonical atomic current batch", async () => {
  let guarded: any;
  await transaction(async () => {
    try {
      await f.command("generation.retry", { id: scenario.plan.id, expected_revision: before.expected_plan_revision, reason: "Synthetic explicit continuation" });
    } catch (error) { guarded = error; }
  });
  expect(guarded?.message).toBe("PROPOSAL_CURRENT_CONTRACT_REQUIRED");
  expect((await inspect()).protected_history).toEqual(before.protected_history);
  const details = currentProposalRequest(JSON.parse(guarded.detail), scenario.opportunity.id);
  expect(details).not.toBeNull();
  const commands = await currentProposalCommands(details!);
  const key = crypto.randomUUID();
  const manifest: any = await transaction(async () => {
    await f.db.query("select set_config('request.jwt.claim.sub',$1,false)", [f.owner]);
    await f.db.exec("set local role authenticated");
    return (await f.db.query<{ result: any }>("select public.app_batch_prepare($1::jsonb,$2) result", [JSON.stringify(commands), key])).rows[0].result;
  });
  expect(manifest.result_count).toBe(2);
  const after = await inspect();
  expect(after.protected_history).toEqual(before.protected_history);
  expect(after.source_manifest_sha256).toBe(before.source_manifest_sha256);
  expect(after.plan_status).toBe("canceled");
  expect(after.expected_plan_revision).toBe(before.expected_plan_revision + 1);
  expect(after.proposal_plan_count).toBe(before.proposal_plan_count + 1);
  expect(after.latest_plan).toMatchObject({ current_contract: true, proposal_id: before.proposal_id });
  expect(after.latest_plan.id).not.toBe(scenario.plan.id);
  expect(after.latest_plan.issuance_request_id).toMatch(/^[a-f0-9-]{36}$/);
  expect(after.latest_issuance).toMatchObject({ id: after.latest_plan.issuance_request_id, plan_id: after.latest_plan.id, requested_by: f.owner, operation: "proposal.generate", outcome: "active" });
  expect(new Date(after.latest_issuance.deadline_at).getTime() - new Date(after.latest_issuance.accepted_at).getTime()).toBe(600000);
  const replay: any = await transaction(async () => {
    await f.db.exec("set local role authenticated");
    return (await f.db.query<{ result: any }>("select public.app_batch_prepare($1::jsonb,$2) result", [JSON.stringify(commands), key])).rows[0].result;
  });
  expect(replay).toEqual(manifest);
  expect((await inspect()).proposal_plan_count).toBe(after.proposal_plan_count);
});

it("detects unknown-usage row changes and current document drift without mutating the predecessor", async () => {
  const protectedBaseline = await inspect();
  await f.db.query("update public.provider_usage set error_code='SYNTHETIC_CHANGED_UNKNOWN' where id=$1", [unknownId]);
  const changed = await inspect();
  expect(changed.protected_history.unknown_usage).not.toEqual(protectedBaseline.protected_history.unknown_usage);
  expect(changed.protected_history.paid_usage).not.toEqual(protectedBaseline.protected_history.paid_usage);
  expect(changed.protected_history.frozen_plan).toEqual(protectedBaseline.protected_history.frozen_plan);
  await f.db.query("update public.documents set extraction_hash=repeat('e',64) where id=$1", [scenario.document.id]);
  const drift = await inspect();
  expect(drift.guards.sources_match).toBe(false);
  expect(drift.source_manifest_sha256).toBe(protectedBaseline.source_manifest_sha256);
});
