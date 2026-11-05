// @vitest-environment node
import { afterEach, beforeEach, expect, it } from "vitest";
import { workflowFixture } from "./workflowFixture";
import { createRecheckFixture } from "./analysisVerifierRecheckFixture";
import { currentProposalCommands, currentProposalRequest } from "../../../frontend/src/lib/currentProposalRequest";
import { currentIssuanceObservation } from "./currentIssuanceObserverFixture";

let f: Awaited<ReturnType<typeof workflowFixture>>;
let target: { opportunity_id: string; proposal_id: string; plan_id: string; issuance_request_id: string };
beforeEach(async () => {
  f = await workflowFixture();
  await f.db.exec("begin");
  const scenario = await createRecheckFixture(f, { historicalDeliveryContract: true });
  await f.db.exec("commit;begin");
  let guarded: any;
  try { await f.command("generation.retry", { id: scenario.plan.id, expected_revision: scenario.plan.revision, reason: "Synthetic continuation" }); }
  catch (error) { guarded = error; }
  expect(guarded?.message).toBe("PROPOSAL_CURRENT_CONTRACT_REQUIRED");
  const details = currentProposalRequest(JSON.parse(guarded.detail), scenario.opportunity.id)!;
  const commands = await currentProposalCommands(details);
  await f.db.exec("set local role authenticated");
  await f.db.query("select public.app_batch_prepare($1::jsonb,$2)", [JSON.stringify(commands), crypto.randomUUID()]);
  await f.db.exec("reset role;commit");
  const p = (await f.db.query<any>("select * from public.generation_plans where opportunity_id=$1 and status<>'canceled'", [scenario.opportunity.id])).rows[0];
  target = { opportunity_id: p.opportunity_id, proposal_id: p.proposal_id, plan_id: p.id, issuance_request_id: p.issuance_request_id };
}, 30000);
afterEach(async () => f?.db.close());

it("reads the exact active authorization and unchanged 600-second clock without writes", async () => {
  const a = await currentIssuanceObservation(f, target);
  expect(Object.values(a.guards)).toEqual(Array(Object.keys(a.guards).length).fill(true));
  expect(a.issuance).toMatchObject({ id: target.issuance_request_id, outcome: "active", completed_at: null, effective_completed_at: null });
  expect(new Date(a.issuance.deadline_at).getTime() - new Date(a.issuance.accepted_at).getTime()).toBe(600000);
  expect(a.package).toBeNull();
  expect((await currentIssuanceObservation(f, target)).issuance).toEqual(a.issuance);
});

it("returns an immediate worker terminal error and the actual nullable request completion separately", async () => {
  await f.db.query("update public.jobs set status='blocked',error_code='NO_AGENTS_AVAILABLE' where entity_id=$1 and type<>'render_delivery'", [target.plan_id]);
  const a = await currentIssuanceObservation(f, target);
  expect(a.issuance).toMatchObject({ outcome: "active", completed_at: null, effective_completed_at: null });
  expect(a.terminal_jobs.some((job: any) => job.status === "blocked" && job.error_code === "NO_AGENTS_AVAILABLE")).toBe(true);
  await f.db.query("select app_private.fail_proposal_issuance($1,'NO_AGENTS_AVAILABLE')", [target.issuance_request_id]);
  const b = await currentIssuanceObservation(f, target);
  expect(b.issuance).toMatchObject({ outcome: "failed", error_code: "NO_AGENTS_AVAILABLE" });
  expect(new Date(b.issuance.completed_at).getTime()).toBeLessThan(new Date(b.issuance.deadline_at).getTime());
  expect(b.issuance.accepted_at).toBe(a.issuance.accepted_at);
});

it("keeps real failure timestamps when current sources become stale", async () => {
  await f.db.query("select app_private.fail_proposal_issuance($1,'NO_AGENTS_AVAILABLE')", [target.issuance_request_id]);
  const a = await currentIssuanceObservation(f, target);
  await f.db.query("update public.documents set extraction_hash=repeat('e',64) where opportunity_id=$1", [target.opportunity_id]);
  const b = await currentIssuanceObservation(f, target);
  expect(b.guards.sources).toBe(false);
  expect(b.source_check).toBe("STALE_INPUT");
  expect(b.issuance).toEqual(a.issuance);
});

it("reports effective deadline closure without writing a fabricated persisted timestamp", async () => {
  await f.db.query("select app_private.fail_proposal_issuance($1,'SYNTHETIC_SUPERSEDED')", [target.issuance_request_id]);
  const r = (await f.db.query<any>(`insert into public.proposal_issuance_requests(workspace_id,plan_id,requested_by,operation,idempotency_key,accepted_at,deadline_at)
    select $1,$2,$3,'proposal.generate',$4,t,t+interval '600 seconds' from(select clock_timestamp()-interval '601 seconds' t) x returning *`,
    [f.w, target.plan_id, f.owner, crypto.randomUUID()])).rows[0];
  await f.db.query("update public.generation_plans set issuance_request_id=$1 where id=$2", [r.id, target.plan_id]);
  target.issuance_request_id = r.id;
  const a = await currentIssuanceObservation(f, target);
  expect(a.issuance).toMatchObject({ outcome: "active", completed_at: null, effective_outcome: "failed", effective_error_code: "PROPOSAL_ISSUANCE_TIMEOUT" });
  expect(a.issuance.effective_completed_at).toBe(a.issuance.deadline_at);
  expect((await f.db.query<any>("select outcome,completed_at from public.proposal_issuance_requests where id=$1", [r.id])).rows[0])
    .toEqual({ outcome: "active", completed_at: null });
});
