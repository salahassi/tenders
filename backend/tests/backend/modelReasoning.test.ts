// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  geminiReasoningConfiguration,
  rejectedGeminiReasoning,
} from "../../supabase/functions/_shared/modelReasoning";
import {
  defaultCapabilities,
  taskRegistry,
} from "../../supabase/functions/_shared/modelContract";
import {
  FreeModelProvider,
  executeModel,
  type Ledger,
  type ModelConfiguration,
} from "../../supabase/functions/_shared/model";
import { geminiAdapter } from "../../supabase/functions/_shared/modelAdapters/gemini";
afterEach(() => vi.restoreAllMocks());
const env = {
  provider: "gemini_free",
  model: "arbitrary-configured-model",
  key: "fixture-key",
  projectRef: "fixture-account",
};
const profile = {
  ...taskRegistry.verify_grounding.profile,
  reasoning: "medium" as const,
};
const config = {
  enabled: true,
  automatic: true,
  provider: "gemini_free" as const,
  model: env.model,
  project_ref: env.projectRef,
  free_only: false,
  billing_verified: false,
  free_quota_only: false,
  verified_at: new Date().toISOString(),
  quota_ends_at: null,
  quota_mode: "provider_managed" as const,
  capabilities: { ...defaultCapabilities("gemini_free"), background: false },
  profile,
};
const success = () =>
  Response.json({
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: '{"status":"ready"}' }] },
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 8,
      thoughtsTokenCount: 2,
    },
  });
const ledgerFor = (c: ModelConfiguration = config): Ledger => ({
  preflight: async () => ({ routing_mode: "round_robin", providers: [c] }),
  reserve: vi.fn(async () => "reservation"),
  settle: vi.fn(),
  reasoningAllowed: vi.fn(async () => true),
  requestPrepared: vi.fn(),
});
it.each(["low", "medium", "high"] as const)(
  "sends the requested %s thinking level in both Gemini transports without changing output limits",
  async (reasoning) => {
    const requested = { ...profile, reasoning };
    const c = { ...config, profile: requested };
    const ledger = ledgerFor(c);
    const fetcher = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.generationConfig.thinkingConfig).toEqual({
        thinkingLevel: reasoning.toUpperCase(),
      });
      expect(body.generationConfig.maxOutputTokens).toBe(16384);
      return success();
    });
    expect(
      await executeModel(
        "connection_probe",
        {},
        [],
        [],
        [],
        { gemini_free: env },
        ledger,
        "en",
        false,
        fetcher,
      ),
    ).toEqual({ status: "ready" });
    expect(ledger.reasoningAllowed).toHaveBeenCalledWith(
      c,
      "generate_content:v1beta",
      reasoning,
    );
    expect(ledger.requestPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: requested,
        reasoningControl: {
          transport: "generate_content:v1beta",
          requested: reasoning,
          effective: reasoning,
        },
      }),
    );
    const prepared = geminiReasoningConfiguration(
      defaultCapabilities("gemini_free"),
      requested,
      true,
    )!;
    const request = geminiAdapter.prepare(
      env,
      {
        ...prepared,
        task: "connection_probe",
        prompt: "JSON",
        schema: {},
        system: "System",
        stream: false,
      },
      true,
    );
    expect(request.body?.generation_config).toEqual({
      max_output_tokens: 16384,
      thinking_level: reasoning,
    });
  },
);
it("uses LOW only as the new verification default and preserves explicit none, pinned medium and other task defaults", async () => {
  expect(taskRegistry.verify_grounding.profile).toMatchObject({
    reasoning: "low",
    max_output_tokens: 16384,
  });
  expect(taskRegistry.draft_section.profile.reasoning).toBe("medium");
  expect(taskRegistry.analyze_chunk.profile.reasoning).toBe("medium");
  expect(
    geminiReasoningConfiguration(config.capabilities, profile, true)?.profile,
  ).toEqual(profile);
  const c = { ...config, profile: { ...profile, reasoning: "none" as const } };
  const ledger = ledgerFor(c);
  await executeModel(
    "connection_probe",
    {},
    [],
    [],
    [],
    { gemini_free: env },
    ledger,
    "en",
    false,
    async (_url, init) => {
      expect(
        JSON.parse(String(init?.body)).generationConfig.thinkingConfig,
      ).toBeUndefined();
      return success();
    },
  );
  expect(ledger.reasoningAllowed).not.toHaveBeenCalled();
  expect(
    geminiReasoningConfiguration(
      config.capabilities,
      { ...profile, reasoning: "minimal" },
      true,
    ),
  ).toBeNull();
});
it.each([
  [{ message: "Unknown parameter: thinking_level" }, true],
  [{ message: "Thinking level is not supported for this model." }, true],
  [{ message: "This model does not support thinking level." }, true],
  [
    {
      message:
        "Invalid JSON payload received. Unknown name \"thinkingLevel\" at 'generation_config.thinking_config': Cannot find field.",
    },
    true,
  ],
  [
    {
      param: "generationConfig.thinkingConfig.thinkingLevel",
      code: "unsupported_parameter",
      message: "Unsupported parameter",
    },
    true,
  ],
  [
    {
      message:
        "Invalid value at 'generation_config.thinking_config.thinking_level' (TYPE_ENUM), \"MEDIUM\"",
    },
    true,
  ],
  [
    {
      message:
        "Invalid value at 'generation_config.thinking_config.thinking_level' (TYPE_ENUM), \"HIGH\"",
    },
    false,
  ],
  [
    {
      message: "Invalid JSON payload",
      details: [
        {
          fieldViolations: [
            {
              field: "generationConfig.thinkingConfig.thinkingLevel",
              description: "Unsupported field",
            },
          ],
        },
      ],
    },
    true,
  ],
  [{ message: "Schema property thinkingLevel is unsupported." }, false],
  [
    {
      message:
        "When thinking_level is enabled, output schema is not supported.",
    },
    false,
  ],
  [
    {
      message:
        'Request body text contains "Unknown parameter: thinking_level".',
    },
    false,
  ],
  [
    {
      message: "Invalid request",
      user_data: "Unknown parameter: thinking_level",
    },
    false,
  ],
  [{ message: "Unknown parameter: thinking_budget" }, false],
  [{ message: "Invalid request" }, false],
  [null, false],
] as const)(
  "classifies only an explicit rejection of the sent optional control (%j)",
  (error, expected) => {
    const args = {
      provider: "gemini_free",
      phase: "generation",
      status: 400,
      sentLevel: "medium",
      error,
    };
    expect(rejectedGeminiReasoning(args)).toBe(expected);
    expect(rejectedGeminiReasoning({ ...args, phase: "poll" })).toBe(false);
    expect(rejectedGeminiReasoning({ ...args, status: 429 })).toBe(false);
    expect(rejectedGeminiReasoning({ ...args, status: 500 })).toBe(false);
    expect(rejectedGeminiReasoning({ ...args, provider: "openai" })).toBe(
      false,
    );
    expect(rejectedGeminiReasoning({ ...args, sentLevel: undefined })).toBe(
      false,
    );
  },
);
it("records only safe diagnostics for rejected optional fields and never logs response/request content", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const client = new FreeModelProvider(env, async () =>
    Response.json(
      {
        error: {
          param: "thinking_level",
          code: "unsupported_parameter",
          message: "Unsupported parameter. PRIVATE_RESPONSE_SENTINEL",
        },
      },
      { status: 422 },
    ),
  );
  const prepared = geminiReasoningConfiguration(
    config.capabilities,
    profile,
    true,
  )!;
  client.usePreparedRequest(prepared.profile, prepared.capabilities);
  await expect(
    client.generate("connection_probe", "PRIVATE_PROMPT_SENTINEL", {}),
  ).rejects.toMatchObject({ code: "PROVIDER_REQUEST_INVALID" });
  expect(client.telemetry.provider_error_reason).toBe("reasoning_unsupported");
  const logs = JSON.stringify([
    warn.mock.calls,
    info.mock.calls,
    client.telemetry,
  ]);
  expect(logs).not.toContain("PRIVATE_RESPONSE_SENTINEL");
  expect(logs).not.toContain("PRIVATE_PROMPT_SENTINEL");
  expect(logs).not.toContain(env.key);
});
it.each([true, false])(
  "polls accepted Gemini work without new reasoning inference (saved metadata: %s)",
  async (hasMetadata) => {
    const ledger = ledgerFor();
    ledger.resume = vi.fn(async () => ({
      id: "original-usage",
      remote_request_id: "accepted-id",
      remote_deadline: new Date(Date.now() + 60000).toISOString(),
    }));
    ledger.checkpoint = vi.fn();
    ledger.defer = vi.fn();
    ledger.backgroundAllowed = vi.fn();
    const { modelPrompt, sha256 } =
      await import("../../supabase/functions/_shared/model");
    const inputHash = await sha256(
      modelPrompt("connection_probe", {}, [], [], "en"),
    );
    const original = {
      input_hash: inputHash,
      profile: { ...profile, reasoning: "none" as const },
      capabilities: { ...config.capabilities, background: true },
    };
    if (hasMetadata)
      ledger.resume = vi.fn(async () => ({
        id: "original-usage",
        remote_request_id: "accepted-id",
        remote_deadline: new Date(Date.now() + 60000).toISOString(),
        execution_metadata: original,
      }));
    const fetcher = vi.fn(async (_url, init) => {
      expect(init?.method).toBe("GET");
      return Response.json({
        id: "accepted-id",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: '{"status":"ready"}' }],
          },
        ],
        usage: {
          total_input_tokens: 10,
          total_output_tokens: 8,
          total_thought_tokens: 0,
        },
      });
    });
    await executeModel(
      "connection_probe",
      {},
      [],
      [],
      [],
      { gemini_free: env },
      ledger,
      "en",
      false,
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ledger.reasoningAllowed).not.toHaveBeenCalled();
    expect(ledger.backgroundAllowed).not.toHaveBeenCalled();
    expect(ledger.reserve).not.toHaveBeenCalled();
    expect(ledger.requestPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: original.profile,
        capabilities: original.capabilities,
        inputHash,
      }),
    );
  },
);

it.each(["generic400", "ambiguous-send"] as const)(
  "uses normal failover for %s without suppressing reasoning or retrying the same target",
  async (failure) => {
    const targets = [config, { ...config, model: "other-configured-model" }];
    const ledger = ledgerFor();
    ledger.preflight = async () => ({
      routing_mode: "round_robin",
      providers: targets,
    });
    ledger.environment = (c) => ({ ...env, model: c.model });
    ledger.saveRound = vi.fn();
    ledger.loadRound = vi.fn(async () => null);
    const urls: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      urls.push(String(url));
      expect(
        JSON.parse(String(init?.body)).generationConfig.thinkingConfig,
      ).toEqual({ thinkingLevel: "MEDIUM" });
      if (urls.length === 1) {
        if (failure === "ambiguous-send")
          throw Error("Network outcome unknown");
        return Response.json(
          { error: { message: "Invalid request" } },
          { status: 400 },
        );
      }
      return success();
    };
    expect(
      await executeModel(
        "connection_probe",
        {},
        [],
        [],
        [],
        { gemini_free: env },
        ledger,
        "en",
        false,
        fetcher,
      ),
    ).toEqual({ status: "ready" });
    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toBe(urls[1]);
    expect(ledger.saveRound).not.toHaveBeenCalled();
  },
);
