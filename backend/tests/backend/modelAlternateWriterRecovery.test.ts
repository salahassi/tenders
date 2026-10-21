// @vitest-environment node
import { expect, it, vi } from "vitest";
import { recoverAlternatePaidWriter } from "../../supabase/functions/_shared/modelAlternateWriterRecovery";
import { candidateContent } from "../../supabase/functions/_shared/modelGrounding";
import { modelPrompt, sha256 } from "../../supabase/functions/_shared/model";
async function fixture() {
  const evidence = [
    {
      id: "rfp",
      kind: "rfp" as const,
      verified: true,
      text: "Missing mandatory records will result in rejection.",
    },
  ];
  const draft = (text: string) => ({
    key: "eligibility",
    title: "Eligibility",
    content_blocks: [{ type: "paragraph", text }],
    requirement_ids: [],
    evidence_refs: [{ id: "rfp", quote: evidence[0].text }],
    company_claims: [],
    assumptions: [],
    questions: [],
  });
  const previous = draft("Missing mandatory records may result in rejection.");
  const candidate = draft(evidence[0].text);
  const hash = await sha256(JSON.stringify(previous));
  const report = {
    checked_candidate_hash: hash,
    reviewed_all_content: true,
    processed_content_ids: candidateContent(previous).map((unit) => unit.id),
    claims: [
      {
        id: "claim",
        claim: previous.content_blocks[0].text,
        candidate_quote: previous.content_blocks[0].text,
        kind: "tender_fact",
        status: "contradicted",
        source_refs: [{ id: "rfp", quote: evidence[0].text }],
        finding: "The buyer's mandatory consequence was weakened.",
      },
    ],
    processed_requirement_ids: [],
    requirement_checks: [],
    findings: [],
  };
  const previousRow = {
    id: "candidate-0",
    value: { result: previous, recovery_usage_id: "paid-initial" },
  };
  const reportRow = { id: "latest-report", value: { result: report } };
  const rows = new Map<string, any>([
    ["candidate-0", previousRow],
    [`invalid-verification-repair-${hash}`, reportRow],
  ]);
  const inputHash = await sha256(
    modelPrompt("draft_section", {}, evidence, [], "en", false),
  );
  const config = {
    provider: "openai",
    model: "synthetic-model",
    project_ref: "synthetic-project",
    connection_id: "connection",
    model_config_id: "model",
  };
  const usage = {
    id: "paid-alternative",
    ...config,
    remote_project_ref: config.project_ref,
    state: "settled",
    graph_candidate_recorded: true,
    input_hash: inputHash,
    execution_metadata: { input_hash: inputHash, graph_thread: "thread" },
    remote_request_id: "resp_paid",
  };
  const selections: any[] = [];
  let ready = true;
  const action = vi.fn(
    async (name: string, payload: any = {}): Promise<any> => {
      if (name === "recovery_ready") return ready;
      if (name === "writer_alternative_selections") return selections;
      if (name === "writer_recovery_candidates")
        return payload.input_hash === inputHash ? [usage] : [];
      if (name === "result_get")
        return (
          rows.get(payload.key) ??
          [...rows.values()].find((row) => row.id === payload.id) ??
          null
        );
      if (name === "result_put") {
        const row = { id: payload.key, value: payload.value };
        rows.set(payload.key, row);
        return row;
      }
      if (name === "writer_alternative_select") {
        selections.push({
          ...payload,
          request_input_hash: payload.input_hash,
          resumed_at: null,
        });
        return true;
      }
      if (name === "writer_alternative_resume") {
        selections.at(-1).resumed_at = "2026-01-01";
        return true;
      }
      throw Error("Forbidden action " + name);
    },
  );
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.method).toBe("GET");
    return Response.json({
      id: usage.remote_request_id,
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(candidate) }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 80 },
    });
  });
  const update = vi.fn(async (_values: any) => {});
  const internal = vi.fn(async () => ({ providers: [config] }));
  const o = {
    backend: {
      internal,
      resolveModelEnvironment: () => ({
        provider: "openai",
        model: config.model,
        projectRef: config.project_ref,
        key: "synthetic-key",
      }),
    },
    store: { action },
    job: { id: "job", lease_token: "lease" },
    threadId: "thread",
    prefix: "draft",
    task: "draft_section",
    context: {},
    evidence,
    requiredIds: [],
    manifest: [],
    language: "en" as const,
    repair: false,
    fetcher,
    state: {
      next: ["verify"],
      values: { repairCount: 0, candidateRef: previousRow.id, reportRef: "" },
    },
    update,
  };
  return {
    o,
    previous,
    candidate,
    report,
    reportRow,
    rows,
    hash,
    usage,
    selections,
    action,
    fetcher,
    update,
    internal,
    setReady: (value: boolean) => {
      ready = value;
    },
  };
}
it("retrieves a distinct paid candidate without replacing the latest defective result or granting writer allowance", async () => {
  const f = await fixture(),
    previous = structuredClone(f.rows.get("candidate-0")),
    report = structuredClone(f.reportRow);
  expect(await recoverAlternatePaidWriter(f.o)).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.update).toHaveBeenCalledWith({
    candidateRef: "paid-writer-alternative-paid-alternative",
    reportRef: "",
  });
  expect(f.rows.get("candidate-0")).toEqual(previous);
  expect(f.reportRow).toEqual(report);
  expect(f.o.state.values.repairCount).toBe(0);
  expect(f.selections[0]).toMatchObject({
    previous_candidate_id: "candidate-0",
    previous_report_id: "latest-report",
  });
  expect(
    f.action.mock.calls.some(([name]) =>
      /budget|candidate_received|accept/.test(name),
    ),
  ).toBe(false);
});
for (const phase of ["before_checkpoint", "after_checkpoint"] as const)
  it(`replays the same selection after a crash ${phase} without another GET`, async () => {
    const f = await fixture();
    f.update.mockRejectedValueOnce(Error("synthetic-crash"));
    await expect(recoverAlternatePaidWriter(f.o)).rejects.toThrow(
      "synthetic-crash",
    );
    if (phase === "after_checkpoint")
      f.o.state.values.candidateRef = f.selections[0].candidate_id;
    expect(await recoverAlternatePaidWriter(f.o)).toBe(true);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.selections).toHaveLength(1);
  });
it.each([
  "pending",
  "accepted",
  "incomplete_report",
  "no_defects",
  "later_repair",
  "scheduled_writer",
  "same_content",
  "used_usage",
  "no_permission",
  "wrong_response",
])("fails closed for %s", async (reason) => {
  const f = await fixture();
  if (reason === "pending") f.setReady(false);
  if (reason === "accepted")
    f.rows.set("accepted", { id: "accepted", value: f.previous });
  if (reason === "incomplete_report") f.report.processed_content_ids = [];
  if (reason === "no_defects") {
    f.previous.content_blocks[0].text = f.o.evidence[0].text;
    f.report.claims[0].status = "supported";
    f.report.claims[0].candidate_quote = f.o.evidence[0].text;
    f.report.checked_candidate_hash = await sha256(JSON.stringify(f.previous));
    f.rows.set(
      `invalid-verification-repair-${f.report.checked_candidate_hash}`,
      f.reportRow,
    );
  }
  if (reason === "later_repair") f.o.state.values.repairCount = 1;
  if (reason === "scheduled_writer") f.o.state.next = ["produce"];
  if (reason === "same_content") Object.assign(f.candidate, f.previous);
  if (reason === "used_usage") f.usage.id = "paid-initial";
  if (reason === "no_permission")
    f.internal.mockResolvedValue({ providers: [] });
  if (reason === "wrong_response")
    f.fetcher.mockResolvedValue(
      Response.json({ id: "wrong", status: "completed" }),
    );
  expect(await recoverAlternatePaidWriter(f.o)).toBe(false);
  expect(f.update).not.toHaveBeenCalled();
  expect(f.selections).toHaveLength(0);
  expect(
    f.action.mock.calls.some(([name]) =>
      /budget|candidate_received|accept/.test(name),
    ),
  ).toBe(false);
});
it("retains the latest contradictory report instead of preferring an older favorable report", async () => {
  const f = await fixture(),
    favorable = structuredClone(f.report);
  favorable.claims[0].status = "supported";
  f.rows.set(`invalid-verification-${f.hash}`, {
    id: "older-report",
    value: { result: favorable },
  });
  expect(await recoverAlternatePaidWriter(f.o)).toBe(true);
  expect(f.selections[0].previous_report_id).toBe("latest-report");
});
it("does not select an already-resumed candidate again after its report fails", async () => {
  const f = await fixture();
  expect(await recoverAlternatePaidWriter(f.o)).toBe(true);
  f.o.state.values.candidateRef = f.selections[0].candidate_id;
  expect(await recoverAlternatePaidWriter(f.o)).toBe(false);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.selections).toHaveLength(1);
});
