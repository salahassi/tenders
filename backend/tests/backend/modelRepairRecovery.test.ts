// @vitest-environment node
import { expect, it, vi } from "vitest";
import { recoverUnstartedRepair } from "../../supabase/functions/_shared/modelRepairRecovery";
import {
  verificationBatches,
  mergeVerificationReports,
} from "../../supabase/functions/_shared/modelVerification";
import { sha256 } from "../../supabase/functions/_shared/model";

async function fixture() {
  const candidate = {
    content_blocks: Array.from({ length: 8 }, () => ({
      type: "paragraph",
      text: "Proposed delivery needs buyer confirmation. ".repeat(40),
    })),
  };
  const hash = await sha256(JSON.stringify(candidate));
  const scopes = verificationBatches(candidate);
  const reports = scopes.slice(0, 2).map((units) => ({
    checked_candidate_hash: hash,
    reviewed_all_content: true,
    processed_content_ids: units.map((u) => u.id),
    claims: [
      {
        id: "c",
        claim: "Explicit uncertainty",
        candidate_quote: units[0].text,
        kind: "assumption",
        status: "insufficient",
        source_refs: [],
        finding: "Buyer input is still required.",
      },
    ],
    processed_requirement_ids: [],
    requirement_checks: [],
    findings: [],
  }));
  const report = mergeVerificationReports(hash, reports);
  const rows = new Map<string, any>();
  const prior = {
    id: "prior-candidate",
    value: {
      result: { target_task: "draft_section", result: candidate, changes: [] },
    },
  };
  const retained = {
    id: "retained-report",
    value: { coverage: "repair_only", result: report },
  };
  rows.set("candidate-1", prior);
  rows.set(retained.id, retained);
  const action = vi.fn(async (name: string, payload: any) => {
    if (name === "result_get")
      return rows.get(payload.key ?? payload.id) ?? null;
    if (name === "result_put") {
      const row = { id: payload.key, value: payload.value };
      rows.set(payload.key, row);
      return row;
    }
    throw Error("Unexpected mutation " + name);
  });
  const internal = vi.fn(async (name: string): Promise<any> =>
    name === "model_phase_started" ? false : { providers: [] },
  );
  const update = vi.fn(async () => {});
  const o = {
    backend: { internal },
    store: { action },
    job: { id: "fixture-job", lease_token: "fixture-lease", checkpoint: {} },
    prefix: "step:fixture",
    task: "draft_section" as const,
    context: {},
    evidence: [],
    requiredIds: [],
    manifest: [],
    language: "en" as const,
    state: {
      next: ["produce"],
      values: {
        repairCount: 2,
        candidateRef: prior.id,
        reportRef: retained.id,
      },
    },
    update,
  };
  return { o, rows, report, retained, action, internal, update };
}
it("undoes only a false unstarted schedule and preserves all retained results and received budgets", async () => {
  const f = await fixture();
  const before = JSON.stringify([...f.rows]);
  expect(await recoverUnstartedRepair(f.o)).toBe(true);
  expect(f.update).toHaveBeenCalledWith({ repairCount: 1 });
  expect(JSON.stringify([...f.rows].slice(0, 2))).toBe(before);
  expect(
    f.action.mock.calls.filter(([action]) => action !== "result_get"),
  ).toEqual([
    [
      "result_put",
      expect.objectContaining({
        value: expect.objectContaining({
          scheduled_repair_before: 2,
          scheduled_repair_after: 1,
          received_candidate_budgets_unchanged: true,
        }),
      }),
    ],
  ]);
});
it.each([
  "phase-history",
  "pending-request",
  "saved-round",
  "candidate-cache",
  "malformed-report",
  "wrong-provenance",
  "real-defect",
  "unknown-response",
])("does not rewind %s", async (blocker) => {
  const f = await fixture();
  if (blocker === "phase-history")
    f.internal.mockImplementation(async (name) =>
      name === "model_phase_started" ? true : { providers: [] },
    );
  if (blocker === "unknown-response")
    f.internal.mockImplementation(async (name) =>
      name === "model_phase_started" ? null : { providers: [] },
    );
  if (blocker === "pending-request")
    f.internal.mockImplementation(async (name) =>
      name === "model_phase_started"
        ? false
        : { providers: [], pending_model_config_id: "accepted-writer" },
    );
  if (blocker === "saved-round")
    f.o.job.checkpoint = { model_round: { input_hash: "legacy" } };
  if (blocker === "candidate-cache")
    f.rows.set("candidate-2", { id: "accepted-result" });
  if (blocker === "malformed-report")
    f.report.claims[0].candidate_quote = "Not in the candidate";
  if (blocker === "wrong-provenance")
    f.o.state.values.candidateRef = "another-candidate";
  if (blocker === "real-defect") f.report.claims[0].status = "contradicted";
  expect(await recoverUnstartedRepair(f.o)).toBe(false);
  expect(f.update).not.toHaveBeenCalled();
  expect(f.action.mock.calls.some(([action]) => action === "result_put")).toBe(
    false,
  );
});
