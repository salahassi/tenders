// @vitest-environment node
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { CurrentRequestGuard, validateInput } from "../../scripts/ops/proposal-current-request.mjs";
import { currentProposalCommands } from "../../../frontend/src/lib/currentProposalRequest";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const input = () => ({
  origin: "https://current-request.example.test", workspace_id: id(1), actor_id: id(2),
  opportunity_id: id(3), plan_id: id(4), proposal_id: id(5), run_id: "12345",
  expected_plan_revision: 17, expected_opportunity_revision: 12, expected_proposal_revision: 8,
  preserved_input_hash: "a".repeat(64), access_token: "private-synthetic-access-token-only",
  session: { access_token: "private-synthetic-access-token-only", refresh_token: "private-refresh-only", user: { id: id(2) } },
});
const details = () => ({
  plan_id: id(4), expected_plan_revision: 17, preserved_input_hash: "a".repeat(64), cancel_required: true,
  opportunity_id: id(3), expected_opportunity_revision: 12, proposal_id: id(5), expected_proposal_revision: 8,
  base_version_id: null, next_operation: "proposal.generate" as const,
});
const probe = () => ({ commands: [{ operation: "generation.retry", input: {
  id: id(4), expected_revision: 17, reason: "User requested continuation of the saved work.",
} }] });
const error = (changed = {}) => ({ error: { code: "PROPOSAL_CURRENT_CONTRACT_REQUIRED", details: { ...details(), ...changed } } });
function ready() {
  const guard = new CurrentRequestGuard(input());
  guard.probe(probe(), id(10)); guard.observeProbe(422, error());
  return guard;
}
const persist = async (request: any) => ({ event: "persisted", body_sha256: request.body_sha256, report_sha256: "b".repeat(64) });
async function sending() {
  const guard = ready(), body = { commands: await currentProposalCommands(details()) };
  await guard.prepare(body, id(11), persist);
  return guard;
}
const successful = () => ({ data: [
  { id: id(4), workspace_id: id(1), status: "canceled" },
  { id: id(20), workspace_id: id(1), opportunity_id: id(3), proposal_id: id(5), kind: "proposal", issuance_request_id: id(21), frozen_context: { generated_delivery_version: 3, proposal_consistency_version: 1 } },
] });

it("uses fresh exact server details and the actual frontend canonical batch only after durable acknowledgement", async () => {
  const guard = ready(), body = { commands: await currentProposalCommands(details()) };
  let acknowledge!: (value: any) => void;
  const stored: any[] = [];
  const pending = guard.prepare(body, id(11), (request: any) => {
    stored.push(request); return new Promise((resolve) => { acknowledge = resolve; });
  });
  await vi.waitFor(() => expect(stored).toHaveLength(1));
  expect(guard.phase).toBe("persisting"); expect(guard.report.browser_commands.batch).toBe(0);
  expect(stored[0]).toMatchObject({ idempotency_key: id(11), body, server_owned_details: details(), body_sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") });
  acknowledge(await persist(stored[0])); await pending;
  expect(guard.phase).toBe("sending"); expect(guard.report.browser_commands.batch).toBe(1);
  guard.observeBatch(200, successful());
  expect(guard.report).toMatchObject({ outcome: "started", successor_plan_id: id(20), issuance_request_id: id(21), prepared_request_sha256: "b".repeat(64) });
  expect(JSON.stringify(guard.report)).not.toContain(input().access_token);
  expect(JSON.stringify(guard.report)).not.toContain(input().session.refresh_token);
});

it.each([
  { plan_id: id(99) }, { opportunity_id: id(99) }, { proposal_id: id(99) },
  { expected_plan_revision: 18 }, { expected_opportunity_revision: 13 }, { expected_proposal_revision: 9 },
  { preserved_input_hash: "c".repeat(64) }, { cancel_required: false }, { base_version_id: id(99) },
])("refuses changed target/revisions before preparing or sending: %j", (changed) => {
  const guard = new CurrentRequestGuard(input()); guard.probe(probe(), id(10));
  expect(() => guard.observeProbe(422, error(changed))).toThrow();
  expect(guard.report.browser_commands.batch).toBe(0);
});

it.each([
  [{ commands: [{ operation: "generation.retry", input: { ...probe().commands[0].input, id: id(99) } }] }, id(10)],
  [{ commands: [{ operation: "generation.retry", input: { ...probe().commands[0].input, expected_revision: 16 } }] }, id(10)],
  [probe(), "missing-key"],
])("rejects wrong probe identity/revision/key", (body, key) => {
  const guard = new CurrentRequestGuard(input());
  expect(() => guard.probe(body, key)).toThrow(); expect(guard.phase).toBe("initial");
});

it("rejects unexpected successful retry and a repeated probe", () => {
  const guard = new CurrentRequestGuard(input()); guard.probe(probe(), id(10));
  expect(() => guard.observeProbe(200, successful())).toThrow("CURRENT_REQUEST_LEGACY_GUARD_REQUIRED");
  expect(() => guard.probe(probe(), id(11))).toThrow("CURRENT_REQUEST_PROBE_REPEATED");
});

it("rejects altered commands, extra business writes and duplicate batch while persistence is pending", async () => {
  for (const mutate of [
    (b: any) => { b.commands[0].input.id = id(99); },
    (b: any) => { b.commands[1].input.expected_revision = 11; },
    (b: any) => { b.commands.push({ operation: "provider.settings", input: {} }); },
    (b: any) => { b.extra = true; },
  ]) {
    const guard = ready(), body: any = { commands: await currentProposalCommands(details()) }, saved = vi.fn();
    mutate(body); await expect(guard.prepare(body, id(11), saved)).rejects.toThrow("CURRENT_REQUEST_CANONICAL_BATCH_CHANGED");
    expect(saved).not.toHaveBeenCalled(); expect(guard.report.browser_commands.batch).toBe(0);
  }
  const guard = ready(), body = { commands: await currentProposalCommands(details()) };
  let acknowledge!: (value: any) => void;
  const first = guard.prepare(body, id(11), (r: any) => new Promise((resolve) => { acknowledge = () => resolve(persist(r)); }));
  await vi.waitFor(() => expect(acknowledge).toBeTypeOf("function"));
  await expect(guard.prepare(body, id(12), persist)).rejects.toThrow("CURRENT_REQUEST_BATCH_ORDER_INVALID");
  acknowledge(null); await first;
});

it("claims preparation before the asynchronous canonical digest can admit a concurrent request", async () => {
  const guard = ready(), body = { commands: await currentProposalCommands(details()) };
  const saved = vi.fn(persist);
  // No await between these calls: both enter before the first canonical builder
  // resumes from its asynchronous work, unlike the persistence-pending case.
  const first = guard.prepare(body, id(11), saved);
  const second = guard.prepare(body, id(12), saved);
  await expect(second).rejects.toThrow("CURRENT_REQUEST_BATCH_ORDER_INVALID");
  await first;
  expect(saved).toHaveBeenCalledTimes(1);
  expect(saved.mock.calls[0][0].idempotency_key).toBe(id(11));
  expect(guard.report.browser_commands.batch).toBe(1);
});

it.each([null, { event: "persisted", body_sha256: "0".repeat(64), report_sha256: "b".repeat(64) }, { event: "persisted", body_sha256: "ignored", report_sha256: "private" }])("does not allow send on missing/mismatched durable receipt", async (ack) => {
  const guard = ready();
  await expect(guard.prepare({ commands: await currentProposalCommands(details()) }, id(11), async () => ack)).rejects.toThrow("CURRENT_REQUEST_DURABLE_RECEIPT_REQUIRED");
  expect(guard.report.browser_commands.batch).toBe(0);
});

it("preserves a lost response as unknown and never prepares a replacement key", async () => {
  const guard = await sending(); guard.failure(new Error("private network body"));
  expect(guard.report).toMatchObject({ outcome: "unknown", code: "CURRENT_REQUEST_BROWSER_FAILED", prepared_request_sha256: "b".repeat(64) });
  await expect(guard.prepare({ commands: await currentProposalCommands(details()) }, id(99), persist)).rejects.toThrow();
  expect(guard.prepared.idempotency_key).toBe(id(11));
});

it.each(["AI_AGENTS_UNAVAILABLE", "MODEL_NOT_CONFIGURED", "FILE_PROCESSING_BUSY", "REVISION_CONFLICT"])("keeps a definite %s rejection distinct from completed issuance", async (code) => {
  const guard = await sending(); guard.observeBatch(503, { error: { code } });
  expect(guard.report).toMatchObject({ outcome: "blocked", code });
  expect(guard.report.successor_plan_id).toBeUndefined();
});

it("unknown server/response faults and malformed successes cannot fabricate a successor", async () => {
  const guard = await sending(); guard.observeBatch(500, { error: { code: "BATCH_STREAM_FAILED" } });
  expect(guard.report.outcome).toBe("unknown");
  const other = await sending(), body = successful(); body.data[1].proposal_id = id(99);
  expect(() => other.observeBatch(200, body)).toThrow("CURRENT_REQUEST_SUCCESSOR_RESPONSE_INVALID");
  other.failure({ code: "CURRENT_REQUEST_SUCCESSOR_RESPONSE_INVALID" });
  expect(other.report.outcome).toBe("unknown");
  expect(other.report.successor_plan_id).toBeUndefined();
});

it("requires exact isolated session identity and HTTPS origin", () => {
  expect(() => validateInput({ ...input(), origin: "http://example.test" })).toThrow();
  expect(() => validateInput({ ...input(), session: { ...input().session, user: { id: id(99) } } })).toThrow();
});

it.each([null, undefined])("defers absent issuance %j to the parent's exact database binding", async issuance => {
  const guard = await sending(), body = successful();
  body.data[1].issuance_request_id = issuance as any;
  guard.observeBatch(200, body);
  expect(guard.report.outcome).toBe("started");
  expect(guard.report.successor_plan_id).toBe(id(20));
  expect(guard.report.issuance_request_id).toBeUndefined();
});

it("rejects a malformed supplied issuance identity", async () => {
  const guard = await sending(), body = successful();
  body.data[1].issuance_request_id = "malformed";
  expect(() => guard.observeBatch(200, body)).toThrow("CURRENT_REQUEST_SUCCESSOR_RESPONSE_INVALID");
});
