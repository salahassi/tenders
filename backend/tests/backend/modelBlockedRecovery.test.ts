// @vitest-environment node
import { expect, it, vi } from "vitest";
import { recoverBlockedVerification } from "../../supabase/functions/_shared/modelBlockedRecovery";
import { candidateContent } from "../../supabase/functions/_shared/modelGrounding";
import { sha256 } from "../../supabase/functions/_shared/model";

async function fixture() {
  const candidate = {
    content_blocks: [
      { type: "paragraph", text: "The deadline is 10 March 2026." },
    ],
  };
  const hash = await sha256(JSON.stringify(candidate));
  const evidence = [
    {
      id: "notice",
      text: candidate.content_blocks[0].text,
      kind: "notice" as const,
      verified: false,
    },
  ];
  const report = {
    checked_candidate_hash: hash,
    reviewed_all_content: true,
    processed_content_ids: candidateContent(candidate).map((unit) => unit.id),
    claims: [
      {
        id: "claim",
        claim: evidence[0].text,
        candidate_quote: evidence[0].text,
        kind: "tender_fact",
        status: "supported",
        source_refs: [{ id: "notice", quote: evidence[0].text }],
        finding: "Exact deadline.",
      },
    ],
    processed_requirement_ids: ["req"],
    requirement_checks: [
      {
        requirement_id: "req",
        status: "supported",
        candidate_quote: evidence[0].text,
        source_refs: [{ id: "notice", quote: evidence[0].text }],
        finding: "Deadline covered.",
      },
    ],
    findings: [] as any[],
  };
  const retained = {
    id: "retained-corrective-report",
    value: {
      result: report,
      code: "EVIDENCE_REFERENCE_INVALID",
      coverage: "complete",
    },
  };
  const saved = { id: "current-candidate", value: { result: candidate } };
  const rows = new Map<string, any>([
    ["candidate-0", saved],
    [`invalid-verification-repair-${hash}`, retained],
  ]);
  const action = vi.fn(async (name: string, payload: any) => {
    if (name === "recovery_ready") return true;
    if (name === "result_get")
      return rows.get(payload.key ?? payload.id) ?? null;
    if (name === "result_put") {
      const row = { id: payload.key, value: payload.value };
      rows.set(payload.key, row);
      return row;
    }
    throw Error("Unexpected mutation " + name);
  });
  const internal = vi.fn(async (): Promise<any> => ({ providers: [] }));
  const update = vi.fn(async () => {});
  const validate = vi.fn();
  const o = {
    backend: { internal },
    store: { action },
    job: { id: "fixture-job", lease_token: "fixture-lease" },
    evidence,
    requiredIds: ["req"],
    manifest: [],
    state: {
      next: ["verify"],
      values: {
        repairCount: 0,
        candidateRef: saved.id,
      },
    },
    validate,
    update,
  };
  return {
    o,
    candidate,
    hash,
    report,
    rows,
    retained,
    saved,
    action,
    internal,
    update,
    validate,
  };
}

it("revalidates the unchanged complete report and resumes only normal decision/accept with private provenance", async () => {
  const f = await fixture();
  const before = JSON.stringify([...f.rows]);
  expect(await recoverBlockedVerification(f.o)).toBe(true);
  expect(f.validate).toHaveBeenCalledWith(f.candidate);
  expect(f.internal.mock.calls).toEqual([
    [
      "task_model_preflight",
      {
        job_id: "fixture-job",
        lease: "fixture-lease",
        manifest: [],
      },
    ],
  ]);
  expect(f.update).toHaveBeenCalledWith({ reportRef: f.retained.id });
  expect(JSON.stringify([...f.rows].slice(0, 2))).toBe(before);
  expect(
    f.action.mock.calls.filter(
      ([name]) => !["result_get", "recovery_ready"].includes(name),
    ),
  ).toEqual([
    [
      "result_put",
      {
        key: `validated-recovery-${f.saved.id}-${f.retained.id}`,
        value: expect.objectContaining({
          candidate_ref: f.saved.id,
          candidate_hash: f.hash,
          report_ref: f.retained.id,
          repair_count: 0,
          received_candidate_budgets_unchanged: true,
          new_provider_requests: 0,
        }),
      },
    ],
  ]);
});

it.each([
  "wrong-candidate",
  "wrong-hash",
  "missing-content",
  "missing-requirement",
  "changed-evidence",
  "partial-report",
  "actionable-defect",
  "uncited-fact",
  "pending-request",
  "unknown-preflight",
  "scheduled-writer",
  "exhausted-writer",
  "accepted-result",
  "task-invalid",
  "latest-report-invalid",
  "unresolved-usage",
  "saved-round",
])(
  "leaves %s blocked without a model request or recovery mutation",
  async (blocker) => {
    const f = await fixture();
    if (blocker === "wrong-candidate")
      f.o.state.values.candidateRef = "other-candidate";
    if (blocker === "wrong-hash")
      f.report.checked_candidate_hash = "f".repeat(64);
    if (blocker === "missing-content") f.report.processed_content_ids = [];
    if (blocker === "missing-requirement") f.report.requirement_checks = [];
    if (blocker === "changed-evidence")
      f.o.evidence[0].text = "Changed source text.";
    if (blocker === "partial-report") f.retained.value.coverage = "repair_only";
    if (blocker === "actionable-defect")
      f.report.findings.push({
        severity: "blocking",
        code: "UNSUPPORTED",
        detail: "Needs correction.",
        claim_ids: ["claim"],
        requirement_ids: [],
      });
    if (blocker === "uncited-fact") f.report.claims[0].source_refs = [];
    if (blocker === "pending-request")
      f.internal.mockResolvedValue({
        providers: [],
        pending_model_config_id: "accepted-request",
      });
    if (blocker === "unknown-preflight") f.internal.mockResolvedValue(null);
    if (["unresolved-usage", "saved-round"].includes(blocker)) {
      const original = f.action.getMockImplementation()!;
      f.action.mockImplementation(async (name, payload) =>
        name === "recovery_ready" ? false : original(name, payload),
      );
    }
    if (blocker === "scheduled-writer") f.o.state.next = ["produce"];
    if (blocker === "exhausted-writer") f.o.state.values.repairCount = 3;
    if (blocker === "accepted-result")
      f.rows.set("accepted", { id: "accepted", value: f.candidate });
    if (blocker === "task-invalid")
      f.validate.mockImplementation(() => {
        throw Error("MODEL_SCHEMA_INVALID");
      });
    if (blocker === "latest-report-invalid") {
      f.rows.set(`invalid-verification-${f.hash}`, structuredClone(f.retained));
      f.report.claims[0].candidate_quote = "Not in candidate.";
    }
    expect(await recoverBlockedVerification(f.o)).toBe(false);
    expect(f.update).not.toHaveBeenCalled();
    expect(
      f.action.mock.calls.some(
        ([name]) => !["result_get", "recovery_ready"].includes(name),
      ),
    ).toBe(false);
  },
);

it("propagates a stale lease or revoked permission before writing a marker", async () => {
  const f = await fixture();
  f.internal.mockRejectedValue(Error("LEASE_LOST"));
  await expect(recoverBlockedVerification(f.o)).rejects.toThrow("LEASE_LOST");
  expect(f.update).not.toHaveBeenCalled();
  expect(
    f.action.mock.calls.some(
      ([name]) => !["result_get", "recovery_ready"].includes(name),
    ),
  ).toBe(false);
});

it("replays a crash after the identical accepted result was saved only with its matching recovery proof", async () => {
  const f = await fixture();
  expect(await recoverBlockedVerification(f.o)).toBe(true);
  f.rows.set("accepted", { id: "accepted", value: f.candidate });
  f.o.state.next = ["accept"];
  expect(await recoverBlockedVerification(f.o)).toBe(true);
  f.rows.get(
    `validated-recovery-${f.saved.id}-${f.retained.id}`,
  ).value.report_hash = "changed";
  expect(await recoverBlockedVerification(f.o)).toBe(false);
});
