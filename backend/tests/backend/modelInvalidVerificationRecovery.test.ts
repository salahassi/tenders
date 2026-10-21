// @vitest-environment node
import { expect, it, vi } from "vitest";
import { recoverInvalidVerification } from "../../supabase/functions/_shared/modelInvalidVerificationRecovery";
import { candidateContent } from "../../supabase/functions/_shared/modelGrounding";
import { verificationBatches } from "../../supabase/functions/_shared/modelVerification";
import { sha256 } from "../../supabase/functions/_shared/model";

async function fixture(batched = false) {
  const quote = "The contract term is 12 months.";
  const candidate = {
    key: "approach",
    title: "Approach",
    requirement_ids: [],
    evidence_refs: [],
    company_claims: [],
    assumptions: [],
    questions: [],
    content_blocks: [
      ...(batched
        ? [{ type: "paragraph", text: "Preparation activities. ".repeat(240) }]
        : []),
      {
        type: "paragraph",
        text: quote + (batched ? " Delivery activities.".repeat(200) : ""),
      },
    ],
  };
  const hash = await sha256(JSON.stringify(candidate));
  const batches = verificationBatches(candidate);
  const units = batched ? batches[1] : candidateContent(candidate);
  const phase = batched
    ? `verification-repair-v3-${hash}-content-1`
    : `verification-repair-${hash}`;
  const evidence = [
    {
      id: "source",
      text: "The contract term is months.",
      kind: "notice" as const,
      verified: false,
    },
  ];
  const report = {
    checked_candidate_hash: hash,
    reviewed_all_content: true,
    processed_content_ids: units.map((unit) => unit.id),
    claims: [
      {
        id: "claim",
        claim: quote,
        candidate_quote: quote,
        kind: "tender_fact",
        status: "supported",
        source_refs: [{ id: "source", quote: evidence[0].text }],
        finding: "Reported support.",
      },
    ],
    processed_requirement_ids: [],
    requirement_checks: [],
    findings: [
      {
        severity: "blocking",
        code: "MODALITY",
        detail: "Retained semantic finding, not a verified fact.",
        claim_ids: ["claim"],
        requirement_ids: [],
      },
    ],
  };
  const saved = { id: "candidate", value: { result: candidate } };
  const retained = {
    id: "latest-report",
    value: { result: report, code: "EVIDENCE_REFERENCE_INVALID" },
  };
  const selection = {
    report: retained,
    verification_key: phase,
    writer_count: 1,
    input_hash: "a".repeat(64),
  };
  const rows = new Map<string, any>([["candidate-0", saved]]);
  const action = vi.fn(async (name: string, payload: any): Promise<any> => {
    if (name === "result_get")
      return rows.get(payload.key ?? payload.id) ?? null;
    if (name === "invalid_verification_repair_candidate") return selection;
    if (name === "invalid_verification_repair_resume") return true;
    if (name === "result_put") {
      const previous = rows.get(payload.key);
      if (
        previous &&
        JSON.stringify(previous.value) !== JSON.stringify(payload.value)
      )
        throw Error("IDEMPOTENCY_CONFLICT");
      const row = previous ?? { id: payload.key, value: payload.value };
      rows.set(payload.key, row);
      return row;
    }
    throw Error("Unexpected mutation: " + name);
  });
  const internal = vi.fn(async () => ({ providers: [] }) as any);
  const update = vi.fn(async () => {}),
    validate = vi.fn();
  const o = {
    backend: { internal },
    store: { action },
    job: { id: "job", lease_token: "lease" },
    evidence,
    requiredIds: [] as string[],
    manifest: [],
    state: {
      next: ["verify"],
      values: { candidateRef: saved.id, repairCount: 0 } as Record<string, any>,
    },
    update,
    validate,
  };
  return {
    o,
    candidate,
    hash,
    report,
    retained,
    selection,
    saved,
    rows,
    action,
    internal,
    update,
    validate,
  };
}

it.each([false, true])(
  "routes only exact current numeric citation failure into repair_only, batched=%s",
  async (batched) => {
    const f = await fixture(batched);
    const original = JSON.stringify(f.report);
    expect(await recoverInvalidVerification(f.o)).toBe(true);
    const writes = f.action.mock.calls.filter(
      ([name]) => name === "result_put",
    );
    expect(writes).toHaveLength(1);
    const artifact = writes[0][1].value;
    expect(artifact.coverage).toBe("repair_only");
    expect(artifact.result.reviewed_all_content).toBe(false);
    expect(artifact.result.findings).toEqual([
      expect.objectContaining({
        code: "UNRESOLVED_VALIDATION",
        severity: "blocking",
      }),
    ]);
    expect(artifact.validation_diagnostics).toEqual([
      expect.objectContaining({ reason: "numeric_evidence_mismatch" }),
    ]);
    expect(artifact.untrusted_report).toEqual(f.report);
    expect(JSON.stringify(f.report)).toBe(original);
    expect(artifact.recovery_provenance).toEqual(
      expect.objectContaining({
        candidate_hash: f.hash,
        report_ref: f.retained.id,
        received_candidate_budgets_unchanged: true,
        new_provider_requests: 0,
      }),
    );
    expect(f.update).toHaveBeenCalledWith(
      { reportRef: writes[0][1].key },
      "verify",
    );
    expect(f.action.mock.calls.at(-1)?.[0]).toBe(
      "invalid_verification_repair_resume",
    );
    expect(f.internal.mock.calls).toEqual([
      ["task_model_preflight", { job_id: "job", lease: "lease", manifest: [] }],
    ]);
  },
);

it.each([
  "wrong-candidate",
  "wrong-hash",
  "invalid-schema",
  "missing-content",
  "missing-requirement",
  "wrong-scope",
  "scheduled-writer",
  "repair-limit",
  "task-invalid",
  "pending",
  "no-current-pool",
  "selector-rejected",
  "report-policy-blocked",
])("keeps %s blocked without a recovery write", async (reason) => {
  const f = await fixture();
  if (reason === "wrong-candidate") f.o.state.values.candidateRef = "other";
  if (reason === "wrong-hash") f.report.checked_candidate_hash = "f".repeat(64);
  if (reason === "invalid-schema") (f.report as any).unknown = "invalid";
  if (reason === "missing-content") f.report.processed_content_ids = [];
  if (reason === "missing-requirement") f.o.requiredIds = ["req"];
  if (reason === "wrong-scope")
    f.selection.verification_key = `verification-repair-v3-${f.hash}-content-99`;
  if (reason === "scheduled-writer") f.o.state.next = ["produce"];
  if (reason === "repair-limit") f.o.state.values.repairCount = 2;
  if (reason === "task-invalid")
    f.validate.mockImplementation(() => {
      throw Error("invalid");
    });
  if (reason === "pending")
    f.internal.mockResolvedValue({
      providers: [],
      pending_model_config_id: "pending",
    });
  if (reason === "no-current-pool") f.internal.mockResolvedValue(null);
  if (reason === "selector-rejected") {
    const action = f.action.getMockImplementation()!;
    f.action.mockImplementation((name, payload) =>
      name === "invalid_verification_repair_candidate"
        ? Promise.resolve(null)
        : action(name, payload),
    );
  }
  if (reason === "report-policy-blocked")
    f.report.findings[0].detail = "CONFIDENTIAL: private evidence";
  expect(await recoverInvalidVerification(f.o)).toBe(false);
  expect(f.update).not.toHaveBeenCalled();
  expect(
    f.action.mock.calls.some(
      ([name]) =>
        name === "result_put" || name === "invalid_verification_repair_resume",
    ),
  ).toBe(false);
});

it.each([false, true])(
  "reopens verify with the exact now-valid retained scope and no canonical cache write, batched=%s",
  async (batched) => {
    const f = await fixture(batched);
    f.o.evidence[0].text = f.report.claims[0].candidate_quote;
    f.report.claims[0].source_refs[0].quote = f.o.evidence[0].text;
    const original = JSON.stringify(f.report);
    expect(await recoverInvalidVerification(f.o)).toBe(true);
    const writes = f.action.mock.calls.filter(
      ([name]) => name === "result_put",
    );
    expect(writes).toHaveLength(1);
    const { key, value } = writes[0][1];
    expect(key).toBe(
      "invalid-verification-revalidated-candidate-latest-report",
    );
    expect(value.coverage).toBe("revalidated_scope");
    expect(value.result).toEqual(f.report);
    expect(value.result.findings).toEqual(f.report.findings);
    expect(value).not.toHaveProperty("untrusted_report");
    expect(value).not.toHaveProperty("validation_diagnostics");
    expect(value.recovery_provenance).toMatchObject({
      input_hash: f.selection.input_hash,
      verification_key: f.selection.verification_key,
      new_provider_requests: 0,
    });
    expect(f.update).toHaveBeenCalledWith({ reportRef: key }, "produce");
    expect(JSON.stringify(f.report)).toBe(original);
  },
);

it("replays a crash after artifact/checkpoint persistence using the exact same report and preserves counters", async () => {
  const f = await fixture();
  f.update.mockRejectedValueOnce(Error("checkpoint crash"));
  await expect(recoverInvalidVerification(f.o)).rejects.toThrow(
    "checkpoint crash",
  );
  expect(
    f.action.mock.calls.some(
      ([name]) => name === "invalid_verification_repair_resume",
    ),
  ).toBe(false);
  f.o.state.next = ["decide"];
  expect(await recoverInvalidVerification(f.o)).toBe(true);
  expect(f.o.state.values.repairCount).toBe(0);
  expect(
    [...f.rows.keys()].filter((key) =>
      key.startsWith("invalid-verification-repair-only-"),
    ),
  ).toHaveLength(1);
});

it("propagates revoked permission or stale lease before saving repair artifacts", async () => {
  const f = await fixture();
  f.internal.mockRejectedValue(Error("LEASE_LOST"));
  await expect(recoverInvalidVerification(f.o)).rejects.toThrow("LEASE_LOST");
  expect(f.update).not.toHaveBeenCalled();
  expect(f.action.mock.calls.some(([name]) => name === "result_put")).toBe(
    false,
  );
});
