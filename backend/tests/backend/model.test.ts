// @vitest-environment node
import { it, expect, vi, afterEach } from "vitest";
afterEach(() => vi.restoreAllMocks());
import {
  FreeModelProvider,
  executeModel,
  fitScore,
  validateModelResult,
  systemInstructions,
  available,
  ModelError,
  type Ledger,
  type Evidence,
} from "../../supabase/functions/_shared/model";
const env = {
  provider: "qwen_free",
  model: "synthetic-model",
  projectRef: "synthetic-project",
  key: "synthetic-placeholder",
};
const config = {
  ...env,
  provider: "qwen_free" as const,
  project_ref: env.projectRef,
  enabled: true,
  free_only: true,
  billing_verified: true,
  free_quota_only: true,
  verified_at: new Date().toISOString(),
  quota_ends_at: new Date(Date.now() + 86400000).toISOString(),
};
const evidence: Evidence[] = [
  {
    id: "block-1",
    text: "Implement an approval workflow.",
    kind: "rfp",
    verified: false,
  },
];
it("keeps Owner-attested provider-managed Gemini available without an invented quota expiry", () => {
  const geminiEnv = { ...env, provider: "gemini_free" };
  const continuous = {
    ...config,
    provider: "gemini_free" as const,
    quota_mode: "provider_managed" as const,
    quota_ends_at: null,
    verified_at: "2020-01-01T00:00:00Z",
  };
  expect(() => available(continuous, geminiEnv)).not.toThrow();
  expect(() =>
    available({ ...continuous, billing_verified: false }, geminiEnv),
  ).toThrow("FREE_ONLY_REQUIRED");
  expect(() =>
    available({ ...continuous, provider: "qwen_free" }, env),
  ).toThrow("FREE_ONLY_REQUIRED");
  expect(() =>
    available({ ...continuous, quota_mode: "verified_budget" }, geminiEnv),
  ).toThrow("PROVIDER_VERIFICATION_EXPIRED");
});
const analysis = {
  processed_block_ids: ["block-1"],
  requirements: [
    {
      text: "Approval workflow",
      category: "functional",
      mandatory: true,
      source_refs: [{ id: "block-1", quote: "approval workflow" }],
      interpretation: "Approval workflow",
      acceptance_evidence: "A test",
      owner_question: null,
    },
  ],
  questions: [],
  separate_volumes: false,
  summary: "Synthetic scope",
};
it("requires exactly the selected verified free provider and project", () => {
  expect(() => available(config, env)).not.toThrow();
  for (const changed of [
    { free_only: false },
    { free_quota_only: false },
    { quota_ends_at: "2020-01-01" },
  ])
    expect(() => available({ ...config, ...changed }, env)).toThrow();
  expect(() => available(config, { ...env, model: "another" })).toThrow(
    "MODEL_NOT_CONFIGURED",
  );
});
it("validates full coverage and verbatim quotations rather than accepting plausible evidence", () => {
  expect(
    validateModelResult("analyze_chunk", analysis, evidence, ["block-1"]),
  ).toEqual(analysis);
  expect(() =>
    validateModelResult("analyze_chunk", analysis, evidence, [
      "block-1",
      "missing",
    ]),
  ).toThrow("MODEL_COVERAGE_INCOMPLETE");
  expect(() =>
    validateModelResult(
      "analyze_chunk",
      analysis,
      [{ ...evidence[0], text: "Different text" }],
      ["block-1"],
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});
it("routes title-only and weak-evidence assessments to review", () => {
  const factor = {
    rating: 4,
    reason: "Synthetic",
    notice_evidence: [],
    company_evidence: [],
  };
  const value = {
    factors: {
      capability: factor,
      scope: factor,
      sector: factor,
      prerequisite: factor,
    },
    critical_unknown: false,
    reason_summary: "Synthetic",
    missing_information: [],
    risk_flags: [],
    suggested_tags: [],
  };
  expect(fitScore(value, true).routing).toBe("needs_review");
  expect(fitScore(value, false).fit_score).toBe(100);
  expect(
    fitScore(
      {
        ...value,
        factors: {
          ...value.factors,
          capability: { ...factor, rating: null },
          scope: { ...factor, rating: null },
        },
      },
      false,
    ),
  ).toMatchObject({ evidence_coverage: 25, routing: "needs_review" });
});
it("calls Groq through the OpenAI-compatible chat completions endpoint", async () => {
  const calls: any[] = [];
  const provider = new FreeModelProvider(
    { ...env, provider: "groq_free", projectRef: "groq-label" },
    async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(analysis) },
            },
          ],
          usage: { prompt_tokens: 80, completion_tokens: 30 },
        }),
      );
    },
  );
  await provider.generate("analyze_chunk", "JSON request", {});
  expect(calls[0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
  expect(calls[0].init.body).not.toContain(env.key);
});
it("counts Qwen using a conservative bound including the system and schema; sends no key in body", async () => {
  const calls: any[] = [];
  const provider = new FreeModelProvider(env, async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(analysis) },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 40 },
      }),
    );
  });
  expect(await provider.countTokens("مرحبا", {})).toBeGreaterThan(
    new TextEncoder().encode(systemInstructions).length,
  );
  const output = await provider.generate("analyze_chunk", "JSON request", {});
  expect(output.usage).toEqual({ input: 100, output: 40, thinking: null });
  expect(calls[0].url).toContain(
    "synthetic-project.ap-southeast-1.maas.aliyuncs.com",
  );
  expect(calls[0].init.body).not.toContain(env.key);
  expect(JSON.parse(calls[0].init.body)).toMatchObject({
    enable_thinking: false,
    stream: false,
    response_format: { type: "json_object" },
  });
});
it("records Gemini thought usage and disables stored interactions", async () => {
  const calls: any[] = [];
  const provider = new FreeModelProvider(
    { ...env, provider: "gemini_free" },
    async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          status: "completed",
          steps: [
            { type: "model_output", content: [{ type: "text", text: "{}" }] },
          ],
          usage: {
            total_input_tokens: 7,
            total_output_tokens: 20,
            total_thought_tokens: 22,
          },
        }),
      );
    },
  );
  expect((await provider.generate("analyze_chunk", "JSON", {})).usage).toEqual({
    input: 7,
    output: 42,
    thinking: 22,
  });
  expect(calls[0].body).toMatchObject({
    store: false,
    stream: false,
    response_format: { mime_type: "application/json" },
  });
});
it("reserves before sending and settles actual usage before validating output", async () => {
  const events: string[] = [];
  vi.spyOn(FreeModelProvider.prototype, "countTokens").mockResolvedValue(100);
  vi.spyOn(FreeModelProvider.prototype, "generate").mockImplementation(
    async () => {
      events.push("send");
      return {
        text: JSON.stringify(analysis),
        usage: { input: 100, output: 90, thinking: 0 },
        complete: true,
      };
    },
  );
  const ledger: Ledger = {
    preflight: async () => {
      events.push("preflight");
      return { providers: [config] };
    },
    reserve: async () => {
      events.push("reserve");
      return "reservation";
    },
    settle: async () => {
      events.push("settle");
    },
  };
  await executeModel(
    "analyze_chunk",
    {},
    evidence,
    ["block-1"],
    [],
    { qwen_free: env },
    ledger,
    "en",
  );
  expect(events).toEqual(["preflight", "reserve", "send", "settle"]);
});
it("never sends rejected content and retains unknown usage on uncertain delivery", async () => {
  const send = vi
    .spyOn(FreeModelProvider.prototype, "generate")
    .mockRejectedValue(new Error("Synthetic network error"));
  vi.spyOn(FreeModelProvider.prototype, "countTokens").mockResolvedValue(100);
  const settle = vi.fn();
  const ledger: Ledger = {
    preflight: async () => ({ providers: [config] }),
    reserve: async () => "reservation",
    settle,
  };
  await expect(
    executeModel(
      "analyze_chunk",
      { email: "person@example.test" },
      evidence,
      ["block-1"],
      [],
      { qwen_free: env },
      ledger,
      "en",
    ),
  ).rejects.toThrow("DATA_POLICY_BLOCKED");
  expect(send).not.toHaveBeenCalled();
  await expect(
    executeModel(
      "analyze_chunk",
      {},
      evidence,
      ["block-1"],
      [],
      { qwen_free: env },
      ledger,
      "en",
    ),
  ).rejects.toThrow();
  expect(settle).toHaveBeenCalledWith(
    "reservation",
    { input: null, output: null, thinking: null },
    "MODEL_NETWORK_UNCERTAIN",
  );
  expect(send).toHaveBeenCalledTimes(1);
});
it("fails over before reservation when a provider token-count endpoint is unreachable", async () => {
  const geminiConfig = {
    ...config,
    provider: "gemini_free" as const,
    project_ref: "gemini-project",
    failover_rank: 1,
  };
  const qwenConfig = { ...config, failover_rank: 2 };
  const reserved: string[] = [];
  vi.spyOn(FreeModelProvider.prototype, "countTokens").mockImplementation(
    async function (this: FreeModelProvider) {
      if (this.env.provider === "gemini_free")
        throw new ModelError("MODEL_NETWORK_UNCERTAIN");
      return 100;
    },
  );
  vi.spyOn(FreeModelProvider.prototype, "generate").mockImplementation(
    async function (this: FreeModelProvider) {
      return {
        text: JSON.stringify(analysis),
        usage: { input: 100, output: 90, thinking: 0 },
        complete: true,
      };
    },
  );
  const ledger: Ledger = {
    preflight: async () => ({ providers: [geminiConfig, qwenConfig] }),
    reserve: async (_i, _o, _h, _m, provider) => {
      reserved.push(provider);
      return `reservation-${provider}`;
    },
    settle: async () => {},
  };
  await executeModel(
    "analyze_chunk",
    {},
    evidence,
    ["block-1"],
    [],
    {
      gemini_free: {
        ...env,
        provider: "gemini_free",
        projectRef: "gemini-project",
      },
      qwen_free: env,
    },
    ledger,
    "en",
  );
  expect(reserved).toEqual(["qwen_free"]);
});

it.each([
  [400, "PROVIDER_REQUEST_INVALID"],
  [401, "PROVIDER_AUTH_FAILED"],
  [403, "PROVIDER_AUTH_FAILED"],
  [404, "PROVIDER_MODEL_NOT_FOUND"],
  [429, "PROVIDER_QUOTA_WAIT"],
  [503, "MODEL_NETWORK_UNCERTAIN"],
])(
  "reports actionable provider errors for HTTP %i without exposing the response body",
  async (status, code) => {
    const provider = new FreeModelProvider(
      env,
      async () =>
        new Response("sensitive provider response", { status: Number(status) }),
    );
    await expect(
      provider.generate("analyze_chunk", "JSON", {}),
    ).rejects.toThrow(String(code));
  },
);

it("preserves measured usage when the returned JSON fails validation", async () => {
  vi.spyOn(FreeModelProvider.prototype, "countTokens").mockResolvedValue(100);
  vi.spyOn(FreeModelProvider.prototype, "generate").mockResolvedValue({
    text: "{}",
    usage: { input: 100, output: 20, thinking: 0 },
    complete: true,
  });
  const ledger: Ledger = {
    preflight: async () => ({ providers: [config] }),
    reserve: async () => "measured-reservation",
    settle: vi.fn(),
  };
  await expect(
    executeModel(
      "analyze_chunk",
      {},
      evidence,
      ["block-1"],
      [],
      { qwen_free: env },
      ledger,
      "en",
    ),
  ).rejects.toThrow("MODEL_OUTPUT_INVALID");
  expect(ledger.settle).toHaveBeenCalledExactlyOnceWith(
    "measured-reservation",
    { input: 100, output: 20, thinking: 0 },
  );
});

it("does not try another provider after uncertain generation delivery", async () => {
  vi.spyOn(FreeModelProvider.prototype, "countTokens").mockResolvedValue(100);
  const generate = vi
    .spyOn(FreeModelProvider.prototype, "generate")
    .mockRejectedValue(new ModelError("MODEL_NETWORK_UNCERTAIN"));
  const ledger: Ledger = {
    preflight: async () => ({
      providers: [config, { ...config, provider: "gemini_free" }],
    }),
    reserve: vi.fn(async () => "uncertain-reservation"),
    settle: vi.fn(),
  };
  await expect(
    executeModel(
      "analyze_chunk",
      {},
      evidence,
      ["block-1"],
      [],
      { qwen_free: env, gemini_free: { ...env, provider: "gemini_free" } },
      ledger,
      "en",
    ),
  ).rejects.toThrow("MODEL_NETWORK_UNCERTAIN");
  expect(generate).toHaveBeenCalledTimes(1);
  expect(ledger.reserve).toHaveBeenCalledTimes(1);
  expect(ledger.settle).toHaveBeenCalledExactlyOnceWith(
    "uncertain-reservation",
    { input: null, output: null, thinking: null },
    "MODEL_NETWORK_UNCERTAIN",
  );
});

it("uses the supplied transport and tries the next provider after explicit HTTP quota rejection", async () => {
  const gemini = { ...env, provider: "gemini_free" };
  const transport = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith(":countTokens"))
      return Response.json({ totalTokens: 100 });
    if (String(url).endsWith("/interactions"))
      return new Response(null, { status: 429 });
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(analysis) },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
  });
  const ledger: Ledger = {
    preflight: async () => ({
      providers: [{ ...config, provider: "gemini_free" }, config],
    }),
    reserve: vi.fn(async (_i, _o, _h, _m, provider) => provider),
    settle: vi.fn(),
  };
  expect(
    await executeModel(
      "analyze_chunk",
      {},
      evidence,
      ["block-1"],
      [],
      { gemini_free: gemini, qwen_free: env },
      ledger,
      "en",
      false,
      transport,
    ),
  ).toEqual(analysis);
  expect(transport).toHaveBeenCalledTimes(3);
  expect(ledger.settle).toHaveBeenNthCalledWith(
    1,
    "gemini_free",
    { input: null, output: null, thinking: null },
    "PROVIDER_QUOTA_WAIT",
  );
  expect(ledger.settle).toHaveBeenNthCalledWith(2, "qwen_free", {
    input: 100,
    output: 50,
    thinking: null,
  });
});

it("rejects invented feedback quotations and incomplete segment coverage", () => {
  const evidence: any = [
      {
        id: "review-1",
        kind: "review",
        verified: false,
        text: "Explain acceptance testing.",
      },
    ],
    valid = {
      processed_review_ids: ["review-1"],
      directives: [
        {
          instruction: "Explain tests",
          source_refs: [
            { id: "review-1", quote: "Explain acceptance testing." },
          ],
        },
      ],
      questions: [],
    };
  expect(
    validateModelResult("summarize_review", valid, evidence, ["review-1"]),
  ).toEqual(valid);
  expect(() =>
    validateModelResult(
      "summarize_review",
      { ...valid, processed_review_ids: [] },
      evidence,
      ["review-1"],
    ),
  ).toThrow("MODEL_COVERAGE_INCOMPLETE");
  expect(() =>
    validateModelResult(
      "summarize_review",
      {
        ...valid,
        directives: [
          {
            instruction: "Invented",
            source_refs: [{ id: "review-1", quote: "Company is certified" }],
          },
        ],
      },
      evidence,
      ["review-1"],
    ),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});
