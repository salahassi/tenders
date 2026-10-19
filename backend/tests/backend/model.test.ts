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
  blockedContent,
} from "../../supabase/functions/_shared/model";
it("allows confidentiality requirements without accepting a Confidential marking or a secret", () => {
  expect(
    blockedContent(
      "The supplier shall maintain confidentiality of project data.",
    ),
  ).toBe(false);
  for (const text of [
    "CONFIDENTIAL: project data",
    "Strictly private document",
    "سرية",
    "api_key=example",
    "person@example.test",
  ]) {
    expect(blockedContent(text)).toBe(true);
  }
});
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
it("accepts configured provider-managed models without billing confirmation or invented quota expiry", () => {
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
  ).not.toThrow();
  expect(() =>
    available({ ...continuous, provider: "qwen_free" }, env),
  ).not.toThrow();
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
it("requires the selected provider identity and honors an explicitly configured quota expiry", () => {
  expect(() => available(config, env)).not.toThrow();
  for (const changed of [{ quota_ends_at: "2020-01-01" }])
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
it("accepts PDF line wrapping in citations but rejects changed amounts, negation and blank quotes", () => {
  const source = [
    {
      ...evidence[0],
      text: "كفالة دخول\u00a0العطاء بقيمة\n20,000 شيكل. لا تُقبل العطاءات الإلكترونية.",
    },
  ];
  const result = structuredClone(analysis);
  result.requirements[0].source_refs[0].quote =
    "كفالة دخول العطاء بقيمة 20,000 شيكل";
  expect(() =>
    validateModelResult("analyze_chunk", result, source, ["block-1"]),
  ).not.toThrow();
  for (const quote of [
    "كفالة دخول العطاء بقيمة 2,000 شيكل",
    "العطاءات الإلكترونية مقبولة",
    " \n ",
  ]) {
    result.requirements[0].source_refs[0].quote = quote;
    expect(() =>
      validateModelResult("analyze_chunk", result, source, ["block-1"]),
    ).toThrow("EVIDENCE_REFERENCE_INVALID");
  }
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
it("records Gemini thought usage through stateless structured generation", async () => {
  const calls: any[] = [];
  const provider = new FreeModelProvider(
    { ...env, provider: "gemini_free", model: "gemini-3.8-flash" },
    async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(
        JSON.stringify({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "{}" }] } },
          ],
          usageMetadata: {
            promptTokenCount: 7,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 22,
            totalTokenCount: 49,
          },
        }),
      );
    },
  );
  expect(
    (await provider.generate("connection_probe", "JSON", {})).usage,
  ).toEqual({
    input: 7,
    output: 42,
    thinking: 22,
  });
  expect(calls[0].body).toMatchObject({
    generationConfig: {
      responseMimeType: "application/json",
      candidateCount: 1,
      thinkingConfig: { thinkingLevel: "LOW" },
    },
  });
});
it("keeps missing Gemini usage unknown and rejects incomplete or tool output", async () => {
  const provider = new FreeModelProvider(
    { ...env, provider: "gemini_free" },
    async () =>
      Response.json({
        candidates: [
          { finishReason: "MAX_TOKENS", content: { parts: [{ text: "{}" }] } },
        ],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 20 },
      }),
  );
  expect(await provider.generate("connection_probe", "JSON", {})).toMatchObject(
    { usage: { input: 7, output: null, thinking: null }, complete: false },
  );
  const toolProvider = new FreeModelProvider(
    { ...env, provider: "gemini_free" },
    async () =>
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ functionCall: { name: "unexpected" } }] },
          },
        ],
        usageMetadata: {
          promptTokenCount: 7,
          candidatesTokenCount: 20,
          totalTokenCount: 27,
        },
      }),
  );
  expect(
    await toolProvider.generate("connection_probe", "JSON", {}),
  ).toMatchObject({
    usage: { input: 7, output: 20, thinking: 0 },
    complete: false,
  });
});
it("diagnoses rejected Gemini settings without logging provider text or secrets", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const provider = new FreeModelProvider(
    { ...env, provider: "gemini_free" },
    async () =>
      Response.json(
        {
          error: {
            message: `Unknown field responseJsonSchema for model. Synthetic credential ${env.key} and private customer text`,
          },
        },
        { status: 400 },
      ),
  );
  await expect(
    provider.generate("connection_probe", "private customer text", {}),
  ).rejects.toMatchObject({ code: "PROVIDER_REQUEST_INVALID" });
  expect(warn).toHaveBeenCalledWith(
    "provider_request_diagnostic",
    JSON.stringify({
      provider: "gemini_free",
      status: 400,
      provider_error_reason: "provider_rejected",
      labels: ["unknown_field", "json_schema", "credentials", "model"],
    }),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain(env.key);
  expect(JSON.stringify(warn.mock.calls)).not.toContain(
    "private customer text",
  );
  warn.mockRestore();
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

it("reports an exhausted automatic round while retaining the truncated-provider diagnostic", async () => {
  const gemini = {
    ...config,
    provider: "gemini_free" as const,
    retry_after: new Date(Date.now() + 3600000).toISOString(),
  };
  const resume = vi.fn(async () => ({
    id: "settled-reservation",
    remote_request_id: "synthetic-truncated",
    remote_deadline: new Date(Date.now() + 60000).toISOString(),
    state: "settled",
  }));
  const ledger: Ledger = {
    preflight: async () => ({
      routing_mode: "round_robin",
      providers: [gemini, config],
    }),
    reserve: vi.fn(),
    settle: vi.fn(),
    resume,
    checkpoint: vi.fn(),
    defer: vi.fn(),
    attempt: vi.fn(),
  };
  const send = vi.spyOn(FreeModelProvider.prototype, "startBackground");
  vi.spyOn(FreeModelProvider.prototype, "pollBackground").mockResolvedValue({
    id: "synthetic-truncated",
    status: "incomplete",
    usage: {
      total_input_tokens: 100,
      total_output_tokens: 2048,
      total_thought_tokens: 0,
    },
    steps: [],
  });
  await expect(
    executeModel(
      "classify_opportunity",
      {},
      [],
      [],
      [],
      { gemini_free: { ...env, provider: "gemini_free" } },
      ledger,
      "en",
    ),
  ).rejects.toThrow("MODEL_ROUND_EXHAUSTED");
  expect(ledger.attempt).toHaveBeenNthCalledWith(
    1,
    "gemini_free",
    "MODEL_OUTPUT_TRUNCATED",
    true,
  );
  expect(ledger.attempt).toHaveBeenNthCalledWith(
    2,
    "qwen_free",
    "MODEL_NOT_CONFIGURED",
    false,
  );
  expect(ledger.settle).toHaveBeenCalledExactlyOnceWith("settled-reservation", {
    input: 100,
    output: 2048,
    thinking: 0,
  });
  expect(send).not.toHaveBeenCalled();
  expect(ledger.reserve).not.toHaveBeenCalled();
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
    if (String(url).endsWith(":generateContent"))
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

it("sends the configured z.ai model verbatim and counts only returned usage", async () => {
  const send = vi.fn<typeof fetch>(async () =>
    Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { content: JSON.stringify(analysis) },
        },
      ],
      usage: { prompt_tokens: 80, completion_tokens: 30 },
    }),
  );
  const provider = new FreeModelProvider(
    { ...env, provider: "zai_free", model: "owner-selected/model.v2" },
    send,
  );
  const result = await provider.generate("analyze_chunk", "JSON request", {});
  const [url, init] = send.mock.calls[0];
  expect(url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
  expect(JSON.parse(String(init?.body))).toMatchObject({
    model: "owner-selected/model.v2",
    response_format: { type: "json_object" },
    stream: false,
  });
  expect(JSON.parse(String(init?.body))).not.toHaveProperty("thinking");
  expect(init?.body).not.toContain(env.key);
  expect(result).toMatchObject({
    complete: true,
    usage: { input: 80, output: 30, thinking: null },
  });
});

it.each([
  ["1302", "rate_limit"],
  ["1305", "overloaded"],
  ["1113", "insufficient_balance"],
])(
  "records z.ai rejection %s independently of HTTP 429 without retaining raw text",
  async (code, reason) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new FreeModelProvider(
      { ...env, provider: "zai_free" },
      async () =>
        Response.json(
          { error: { code, message: `private customer text ${env.key}` } },
          {
            status: 429,
            headers: { "retry-after": "60", "x-request-id": "synthetic-429" },
          },
        ),
    );
    await expect(
      provider.generate("connection_probe", "JSON", {}),
    ).rejects.toMatchObject({ code: "PROVIDER_QUOTA_WAIT" });
    expect(provider.telemetry).toMatchObject({
      http_status: 429,
      request_id: "synthetic-429",
      provider_error_code: code,
      provider_error_reason: reason,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(env.key);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "private customer text",
    );
    warn.mockRestore();
  },
);
it("retains a definitive 429 when the rejection body is malformed and does not invent a quota cause", async () => {
  const provider = new FreeModelProvider(
    env,
    async () => new Response("not JSON", { status: 429 }),
  );
  await expect(
    provider.generate("connection_probe", "JSON", {}),
  ).rejects.toMatchObject({ code: "PROVIDER_QUOTA_WAIT" });
  expect(provider.telemetry.provider_error_reason).toBe("unspecified_429");
  expect(provider.telemetry.provider_error_code).toBeUndefined();
});

it("allows a single-provider connection check to return after 20 seconds", async () => {
  vi.useFakeTimers();
  try {
    vi.spyOn(FreeModelProvider.prototype, "countTokens").mockResolvedValue(100);
    const fetcher = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve(
                Response.json({
                  choices: [
                    {
                      finish_reason: "stop",
                      message: { content: '{"status":"ready"}' },
                    },
                  ],
                  usage: { prompt_tokens: 100, completion_tokens: 10 },
                }),
              ),
            21000,
          );
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        }),
    );
    const ledger: Ledger = {
      preflight: async () => ({
        routing_mode: "round_robin",
        providers: [config],
      }),
      reserve: async () => "synthetic-reservation",
      settle: vi.fn(),
    };
    const pending = executeModel(
      "connection_probe",
      {},
      [],
      [],
      [],
      { qwen_free: env },
      ledger,
      "en",
      false,
      fetcher,
    );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(21000);
    expect(await pending).toEqual({ status: "ready" });
  } finally {
    vi.useRealTimers();
  }
});

it.each(["only available", "failover", "all time out"] as const)(
  "bounds the automatic round while allowing slow proposal responses: %s",
  async (scenario) => {
    vi.useFakeTimers();
    try {
      const waiting = new Date(Date.now() + 3600000).toISOString();
      const zai = { ...env, provider: "zai_free" };
      const providers =
        scenario === "only available"
          ? [
              { ...config, retry_after: waiting },
              { ...config, provider: "groq_free" as const },
              { ...config, provider: "zai_free" as const },
            ]
          : [config, { ...config, provider: "zai_free" as const }];
      const endAttempt = vi.fn();
      const settle = vi.fn();
      const ledger: Ledger = {
        preflight: async () => ({ routing_mode: "round_robin", providers }),
        beginAttempt: async (provider) => provider,
        endAttempt,
        reserve: async (_input, _output, _hash, _manifest, provider) =>
          provider,
        settle,
      };
      const fetcher = vi.fn<typeof fetch>(
        async (url, init) =>
          new Promise((resolve, reject) => {
            const succeeds =
              scenario !== "all time out" && String(url).includes("api.z.ai");
            const timer = setTimeout(
              () =>
                resolve(
                  Response.json({
                    choices: [
                      {
                        finish_reason: "stop",
                        message: { content: JSON.stringify(analysis) },
                      },
                    ],
                    usage: { prompt_tokens: 100, completion_tokens: 90 },
                  }),
                ),
              succeeds ? 25000 : 120000,
            );
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            });
          }),
      );
      const outcome = executeModel(
        "analyze_chunk",
        {},
        evidence,
        ["block-1"],
        [],
        { qwen_free: env, zai_free: zai },
        ledger,
        "en",
        false,
        fetcher,
      ).then(
        (value) => ({ value }),
        (error: ModelError) => ({ error }),
      );
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(
        scenario === "only available" ? 25000 : 90000,
      );
      const result = await outcome;
      expect(fetcher).toHaveBeenCalledTimes(
        scenario === "only available" ? 1 : 2,
      );
      if (scenario === "all time out") {
        expect(result).toMatchObject({
          error: { code: "MODEL_ROUND_EXHAUSTED" },
        });
      } else {
        expect(result).toMatchObject({ value: analysis });
      }
      if (scenario !== "only available") {
        expect(endAttempt).toHaveBeenCalledWith(
          "qwen_free",
          "MODEL_NETWORK_UNCERTAIN",
          true,
          "qwen_free",
          expect.objectContaining({ provider_error_reason: "request_timeout" }),
        );
        expect(settle).toHaveBeenCalledWith(
          "qwen_free",
          { input: null, output: null, thinking: null },
          "MODEL_NETWORK_UNCERTAIN",
        );
      }
    } finally {
      vi.useRealTimers();
    }
  },
);

it("uses OpenAI Responses with the supplied model and preserves reasoning usage without extracting reasoning text", async () => {
  const send = vi.fn<typeof fetch>(async () =>
    Response.json(
      {
        id: "resp_test",
        model: "owner-model",
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ text: "not output" }] },
          {
            type: "message",
            content: [{ type: "output_text", text: '{"status":"ready"}' }],
          },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 19,
          output_tokens_details: { reasoning_tokens: 9 },
        },
      },
      { headers: { "x-request-id": "req_test" } },
    ),
  );
  const provider = new FreeModelProvider(
    { ...env, provider: "openai", model: "owner-selected.model" },
    send,
  );
  expect(await provider.generate("connection_probe", "JSON", {})).toEqual({
    text: '{"status":"ready"}',
    complete: true,
    usage: { input: 11, output: 19, thinking: 9 },
  });
  const [url, init] = send.mock.calls[0];
  const body = JSON.parse(String(init?.body));
  expect(url).toBe("https://api.openai.com/v1/responses");
  expect(body).toMatchObject({
    model: "owner-selected.model",
    store: false,
    stream: false,
    max_output_tokens: 1024,
  });
  expect(body).not.toHaveProperty("temperature");
  expect(body).not.toHaveProperty("reasoning");
  expect(new Headers(init?.headers).get("authorization")).toBe(
    `Bearer ${env.key}`,
  );
  expect(provider.telemetry).toMatchObject({
    request_id: "req_test",
    response_id: "resp_test",
    reported_model: "owner-model",
    finish_reason: "completed",
  });
});
it("uses Claude Messages and totals uncached and cached input without inventing thinking counts", async () => {
  const send = vi.fn<typeof fetch>(async () =>
    Response.json(
      {
        id: "msg_test",
        model: "owner-model",
        stop_reason: "end_turn",
        content: [
          { type: "thinking", thinking: "not output" },
          { type: "text", text: '{"status":"ready"}' },
        ],
        usage: {
          input_tokens: 11,
          cache_creation_input_tokens: 7,
          cache_read_input_tokens: 13,
          output_tokens: 19,
        },
      },
      { headers: { "request-id": "req_claude" } },
    ),
  );
  const provider = new FreeModelProvider(
    { ...env, provider: "anthropic", model: "owner-selected.model" },
    send,
  );
  expect(await provider.generate("connection_probe", "JSON", {})).toEqual({
    text: '{"status":"ready"}',
    complete: true,
    usage: { input: 31, output: 19, thinking: null },
  });
  const [url, init] = send.mock.calls[0];
  const body = JSON.parse(String(init?.body));
  expect(url).toBe("https://api.anthropic.com/v1/messages");
  expect(body).toMatchObject({
    model: "owner-selected.model",
    stream: false,
    max_tokens: 1024,
  });
  expect(body).not.toHaveProperty("thinking");
  expect(body).not.toHaveProperty("response_format");
  expect(new Headers(init?.headers).get("x-api-key")).toBe(env.key);
  expect(new Headers(init?.headers).get("anthropic-version")).toBe(
    "2023-06-01",
  );
  expect(provider.telemetry).toMatchObject({
    request_id: "req_claude",
    response_id: "msg_test",
    finish_reason: "end_turn",
  });
});
it.each([
  [
    "openai",
    {
      status: "incomplete",
      output: [
        { type: "message", content: [{ type: "output_text", text: "{}" }] },
      ],
      usage: { input_tokens: 2, output_tokens: 4 },
    },
  ],
  [
    "openai",
    {
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "refusal", refusal: "declined" }],
        },
      ],
    },
  ],
  [
    "anthropic",
    {
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "{}" }],
      usage: { input_tokens: 2, output_tokens: 4 },
    },
  ],
  [
    "anthropic",
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "unexpected" }],
    },
  ],
] as const)(
  "does not validate incomplete or non-text %s output as success",
  async (provider, result) => {
    const adapter = new FreeModelProvider({ ...env, provider }, async () =>
      Response.json(result),
    );
    expect(
      (await adapter.generate("connection_probe", "JSON", {})).complete,
    ).toBe(false);
  },
);

it("skips only the provider in Retry-After cooldown and uses the next configured model", async () => {
  const later = new Date(Date.now() + 12 * 3600000).toISOString();
  const ledger: Ledger = {
    preflight: async () => ({
      routing_mode: "round_robin",
      providers: [
        { ...config, retry_after: later },
        { ...config, provider: "groq_free" },
      ],
    }),
    reserve: vi.fn(async () => "synthetic"),
    settle: vi.fn(),
    attempt: vi.fn(),
    beginAttempt: vi.fn(async () => "1"),
    endAttempt: vi.fn(),
  };
  const generate = vi
    .spyOn(FreeModelProvider.prototype, "generate")
    .mockResolvedValue({
      text: JSON.stringify(analysis),
      usage: { input: 50, output: 30, thinking: 0 },
      complete: true,
    });
  expect(
    await executeModel(
      "analyze_chunk",
      {},
      evidence,
      ["block-1"],
      [],
      { qwen_free: env, groq_free: { ...env, provider: "groq_free" } },
      ledger,
      "en",
    ),
  ).toEqual(analysis);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(ledger.endAttempt).toHaveBeenCalledWith(
    "1",
    "PROVIDER_QUOTA_WAIT",
    false,
    null,
    { retry_after: later },
  );
});
it("does not apply the last provider's long wait to another provider's temporary failure", async () => {
  const later = new Date(Date.now() + 12 * 3600000).toISOString();
  const ledger: Ledger = {
    preflight: async () => ({
      routing_mode: "round_robin",
      providers: [
        config,
        { ...config, provider: "groq_free", retry_after: later },
      ],
    }),
    reserve: vi.fn(async () => "synthetic"),
    settle: vi.fn(),
    attempt: vi.fn(),
  };
  vi.spyOn(FreeModelProvider.prototype, "generate").mockRejectedValue(
    new ModelError("MODEL_NETWORK_UNCERTAIN"),
  );
  await expect(
    executeModel(
      "analyze_chunk",
      {},
      evidence,
      ["block-1"],
      [],
      { qwen_free: env, groq_free: { ...env, provider: "groq_free" } },
      ledger,
      "en",
    ),
  ).rejects.toMatchObject({ code: "MODEL_ROUND_EXHAUSTED", retryAfter: null });
});
it("normalizes invisible page formatting in citations while still rejecting invented facts", () => {
  const supplied = [
    { ...evidence[0], text: "Implement an approval\u200b workflow." },
  ];
  expect(() =>
    validateModelResult("analyze_chunk", analysis, supplied, ["block-1"]),
  ).not.toThrow();
  const changed = structuredClone(analysis);
  changed.requirements[0].source_refs[0].quote =
    "Implement no approval workflow";
  expect(() =>
    validateModelResult("analyze_chunk", changed, supplied, ["block-1"]),
  ).toThrow("EVIDENCE_REFERENCE_INVALID");
});
