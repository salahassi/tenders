// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  recoverBlockedWriter,
  retainInvalidWriter,
} from "../../supabase/functions/_shared/modelWriterRecovery";
import { modelPrompt, sha256 } from "../../supabase/functions/_shared/model";

async function fixture() {
  const evidence = [
    {
      id: "company",
      kind: "company" as const,
      verified: true,
      text: "Our team delivers custom software and integration services.",
    },
  ];
  const candidate = {
    key: "experience",
    title: "Experience",
    content_blocks: [
      {
        type: "paragraph",
        text: "We provide software engineering and system integration.",
      },
    ],
    requirement_ids: ["r1"],
    evidence_refs: [{ id: "company", quote: evidence[0].text }],
    company_claims: [
      {
        claim: "Software and integration capability",
        source_id: "company",
        quote: evidence[0].text,
      },
    ],
    assumptions: [],
    questions: [],
  };
  const context = { key: "experience" };
  const inputHash = await sha256(
    modelPrompt("draft_section", context, evidence, ["r1"], "en", false),
  );
  const config = {
    provider: "openai",
    model: "fixture-model",
    project_ref: "fixture-project",
    connection_id: "fixture-connection",
    model_config_id: "fixture-configuration",
  };
  const usage = {
    id: "usage-paid",
    ...config,
    remote_project_ref: config.project_ref,
    state: "settled",
    graph_candidate_recorded: true,
    input_hash: inputHash,
    execution_metadata: {
      input_hash: inputHash,
      graph_thread: "fixture-thread",
    },
    remote_request_id: "resp_fixture",
  };
  const rows = new Map<string, any>();
  const action = vi.fn(async (name: string, payload?: any): Promise<any> => {
    if (name === "recovery_ready") return true;
    if (name === "writer_recovery_candidates") return [usage];
    if (name === "writer_recovery_resume") return true;
    if (name === "result_get") return rows.get(payload.key) ?? null;
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
    throw Error(`Forbidden recovery action: ${name}`);
  });
  const response: any = {
    id: usage.remote_request_id,
    status: "completed",
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: JSON.stringify(candidate) }],
      },
    ],
    usage: { input_tokens: 110, output_tokens: 90 },
  };
  const fetcher = vi.fn(async (_url: any, init: any) => {
    expect(init.method).toBe("GET");
    return Response.json(response);
  });
  const internal = vi.fn(
    async (_name: string, _args?: Record<string, unknown>) => ({
      providers: [config],
    }),
  );
  const validate = vi.fn();
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
    threadId: "fixture-thread",
    prefix: "draft",
    task: "draft_section",
    context,
    evidence,
    requiredIds: ["r1"],
    manifest: [],
    language: "en" as const,
    repair: false,
    fetcher: fetcher as typeof fetch,
    state: {
      next: ["produce"],
      values: { repairCount: 0 } as Record<string, any>,
    },
    validate,
  };
  return {
    o,
    usage,
    config,
    candidate,
    rows,
    response,
    action,
    fetcher,
    internal,
    validate,
    inputHash,
  };
}

it("recovers an already-paid paraphrase via exact GET and only reopens normal independent verification", async () => {
  const f = await fixture();
  expect(await recoverBlockedWriter(f.o)).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(String(f.fetcher.mock.calls[0][0])).toBe(
    "https://api.openai.com/v1/responses/resp_fixture",
  );
  expect(f.validate).toHaveBeenCalledWith(f.candidate, {
    independentGrounding: true,
  });
  expect(f.rows.get("candidate-0").value).toMatchObject({
    result: f.candidate,
    recovery_usage_id: f.usage.id,
  });
  expect(f.rows.get(`writer-recovery-${f.usage.id}`).value).toMatchObject({
    independent_verification_required: true,
    received_candidate_budgets_unchanged: true,
    new_generation_requests: 0,
  });
  expect(f.action.mock.calls.map(([name]) => name)).not.toEqual(
    expect.arrayContaining([
      "candidate_received",
      "candidate_budget",
      "accept",
      "delete",
    ]),
  );
  expect(f.internal.mock.calls).toHaveLength(1);
  expect(f.internal.mock.calls[0][0]).toBe("task_model_preflight");
  // Crash/replay after artifact/cache persistence does not retrieve or regenerate.
  expect(await recoverBlockedWriter(f.o)).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});

it.each([
  "wrong-task",
  "wrong-node",
  "repair",
  "candidate-ref",
  "pending",
  "no-paid-result",
  "wrong-input",
  "uncounted",
  "unsettled",
  "wrong-config",
  "wrong-metadata",
  "wrong-graph",
  "remote-mismatch",
  "remote-incomplete",
  "remote-refused",
  "remote-error",
  "missing-source",
  "wrong-source",
  "unverified-source",
  "coverage",
  "domain-validation",
  "cache-conflict",
])("fails closed: %s", async (kind) => {
  const f = await fixture();
  const implementation = f.action.getMockImplementation()!;
  if (kind === "wrong-task") f.o.task = "analyze_chunk";
  if (kind === "wrong-node") f.o.state.next = ["verify"];
  if (kind === "repair") f.o.state.values.repairCount = 1;
  if (kind === "candidate-ref") f.o.state.values.candidateRef = "other";
  if (kind === "pending")
    f.action.mockImplementation((name, payload) =>
      name === "recovery_ready"
        ? Promise.resolve(false)
        : implementation(name, payload),
    );
  if (kind === "no-paid-result")
    f.action.mockImplementation((name, payload) =>
      name === "writer_recovery_candidates"
        ? Promise.resolve([])
        : implementation(name, payload),
    );
  if (kind === "wrong-input") f.usage.input_hash = "x";
  if (kind === "wrong-metadata") f.usage.execution_metadata.input_hash = "x";
  if (kind === "wrong-graph") f.usage.execution_metadata.graph_thread = "other";
  if (kind === "uncounted") f.usage.graph_candidate_recorded = false;
  if (kind === "unsettled") f.usage.state = "unknown";
  if (kind === "wrong-config") f.usage.model_config_id = "other";
  if (kind === "remote-mismatch") f.response.id = "resp_other";
  if (kind === "remote-incomplete") f.response.status = "in_progress";
  if (kind === "remote-refused")
    f.response.output[0].content = [{ type: "refusal", refusal: "no" }];
  if (kind === "remote-error")
    f.fetcher.mockImplementation(async () =>
      Response.json({}, { status: 500 }),
    );
  if (kind === "missing-source")
    f.candidate.company_claims[0].source_id = "missing";
  if (kind === "wrong-source")
    f.candidate.company_claims[0].quote = "Invented certification";
  if (kind === "unverified-source") {
    f.o.evidence[0].verified = false;
    f.usage.input_hash = await sha256(
      modelPrompt(
        "draft_section",
        f.o.context,
        f.o.evidence,
        ["r1"],
        "en",
        false,
      ),
    );
    f.usage.execution_metadata.input_hash = f.usage.input_hash;
  }
  if (kind === "coverage") f.candidate.requirement_ids = [];
  if (kind === "domain-validation")
    f.validate.mockImplementation(() => {
      throw Error("invalid business context");
    });
  if (kind === "cache-conflict")
    f.rows.set("candidate-0", {
      id: "other",
      value: { result: f.candidate, recovery_usage_id: "other" },
    });
  if (["missing-source", "wrong-source", "coverage"].includes(kind))
    f.response.output[0].content[0].text = JSON.stringify(f.candidate);
  expect(await recoverBlockedWriter(f.o)).toBe(false);
  expect(
    f.action.mock.calls.some(([name]) => name === "writer_recovery_resume"),
  ).toBe(false);
  expect(f.action.mock.calls.some(([name]) => name === "accept")).toBe(false);
});

it("retains all distinct counted writer candidates without replacing an earlier paid result", async () => {
  const f = await fixture();
  for (const id of ["one", "two", "three", "one"])
    await retainInvalidWriter(f.o.store, {
      usage_id: id,
      request_prefix: "draft:candidate-0",
      request_input_hash: f.inputHash,
      task: "draft_section",
      result: f.candidate,
      code: "UNSUPPORTED_COMPANY_CLAIM",
      producer: f.config,
    });
  expect(f.rows.size).toBe(3);
});
