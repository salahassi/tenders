// @vitest-environment node
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  capabilitySchema,
  defaultCapabilities,
  normalizeOptionalNulls,
  resolveProfile,
  strictJsonSchema,
  structuredRequest,
  taskJsonSchema,
  taskRegistry,
} from "../../supabase/functions/_shared/modelContract";
import {
  modelSchemas,
  type ModelTask,
} from "../../supabase/functions/_shared/modelSchemas";
import { modelAdapters } from "../../supabase/functions/_shared/modelAdapters";
import { MODEL_PROVIDER_IDS } from "../../supabase/functions/_shared/modelProviders";

it("registers every task with one canonical local and wire schema", () => {
  expect(Object.keys(taskRegistry)).toEqual(Object.keys(modelSchemas));
  for (const task of Object.keys(taskRegistry) as ModelTask[]) {
    expect(taskRegistry[task].output).toBe(modelSchemas[task]);
    expect(taskJsonSchema(task)).toEqual(z.toJSONSchema(modelSchemas[task]));
    const visit = (schema: any) => {
      if (!schema || typeof schema !== "object") return;
      if (schema.type === "object") {
        expect(schema.required).toEqual(Object.keys(schema.properties));
        expect(schema.additionalProperties).toBe(false);
      }
      Object.values(schema).forEach((v) =>
        Array.isArray(v) ? v.forEach(visit) : visit(v),
      );
    };
    visit(strictJsonSchema(taskJsonSchema(task)));
  }
});
it("translates optional nested fields without weakening constraints or losing nullable domain values", () => {
  const schema = z
    .object({
      optional: z.string().min(2).max(9).optional(),
      nullable: z.string().nullable().optional(),
      rows: z.array(
        z
          .object({
            amount: z.number().int().min(10).max(20),
            detail: z.string().optional(),
          })
          .strict(),
      ),
    })
    .strict();
  const original = z.toJSONSchema(schema);
  const wire = strictJsonSchema(original);
  expect(wire.properties.optional.anyOf[0]).toMatchObject({
    minLength: 2,
    maxLength: 9,
  });
  expect(wire.properties.rows.items.properties.amount).toMatchObject({
    minimum: 10,
    maximum: 20,
  });
  expect(
    schema.parse(
      normalizeOptionalNulls(
        {
          optional: null,
          nullable: null,
          rows: [{ amount: 12, detail: null }],
        },
        original,
      ),
    ),
  ).toEqual({ nullable: null, rows: [{ amount: 12 }] });
  expect(() =>
    schema.parse(
      normalizeOptionalNulls(
        { optional: "x", rows: [{ amount: 9 }] },
        original,
      ),
    ),
  ).toThrow();
  expect(() =>
    schema.parse(
      normalizeOptionalNulls({ rows: [{ amount: 12, extra: true }] }, original),
    ),
  ).toThrow();
});
it("selects bounds and reasoning from capabilities, never model names", () => {
  const capabilities = capabilitySchema.parse({
    output: "native_strict",
    reasoning: "effort",
    reasoning_values: ["low", "medium"],
    max_output_tokens: 12000,
  });
  expect(resolveProfile("draft_section", capabilities)).toMatchObject({
    max_output_tokens: 12000,
    reasoning: "medium",
  });
  expect(resolveProfile("connection_probe", capabilities)).toMatchObject({
    max_output_tokens: 12000,
    reasoning: "low",
  });
  expect(() =>
    resolveProfile("analyze_chunk", defaultCapabilities("zai_free"), {
      ...taskRegistry.analyze_chunk.profile,
      require_native_strict: true,
    }),
  ).toThrow("MODEL_CAPABILITY_UNSUPPORTED");
});
it("rejects ambiguous evidence manifests before building a credential-free envelope", () => {
  const input = {
    task: "connection_probe" as const,
    inputHash: "a".repeat(64),
    language: "en" as const,
    target: {
      provider: "openai" as const,
      model: "owner-choice",
      project: "default",
    },
    evidence: [],
    requiredIds: [],
    routeRevision: null,
    profile: taskRegistry.connection_probe.profile,
    capabilities: defaultCapabilities("openai"),
    prompt: "JSON",
  };
  expect(structuredRequest(input)).toMatchObject({
    contractVersion: "1",
    schemaVersion: "1",
    task: input.task,
  });
  expect(JSON.stringify(structuredRequest(input))).not.toContain("key");
  expect(() =>
    structuredRequest({
      ...input,
      evidence: [
        { id: "same", kind: "rfp", verified: false, hash: "b".repeat(64) },
        { id: "same", kind: "rfp", verified: false, hash: "b".repeat(64) },
      ],
    }),
  ).toThrow("MODEL_REQUEST_INVALID");
});
describe.each(MODEL_PROVIDER_IDS)("%s contract", (provider) => {
  const adapter = modelAdapters[provider];
  const env = {
    provider,
    model: "owner.selected/model",
    projectRef: "syntheticaccount",
    key: "fixture-credential",
  };
  const input = {
    task: "connection_probe",
    prompt: "JSON",
    system: "System boundary",
    schema: taskJsonSchema("connection_probe"),
    profile: taskRegistry.connection_probe.profile,
    capabilities: defaultCapabilities(provider),
    stream: false,
  };
  it("prepares a bounded structured request using the supplied model and fixed provider endpoint", () => {
    const request = adapter.prepare(env, input, false);
    expect(request.url).toMatch(/^https:\/\//);
    expect(JSON.stringify(request.body)).not.toContain(env.key);
    expect(JSON.stringify(request.body)).toContain(input.prompt);
    if (provider !== "gemini_free") expect(request.body?.model).toBe(env.model);
    else expect(request.url).toContain(env.model);
    if (provider === "openai")
      expect(request.body).toMatchObject({
        text: {
          format: {
            type: "json_schema",
            strict: true,
            schema: { additionalProperties: false },
          },
        },
      });
  });
  it("keeps unreported usage unknown instead of inventing zero", () => {
    const result =
      provider === "openai"
        ? {
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: '{"status":"ready"}' }],
              },
            ],
          }
        : provider === "gemini_free"
          ? {
              candidates: [
                {
                  finishReason: "STOP",
                  content: { parts: [{ text: '{"status":"ready"}' }] },
                },
              ],
            }
          : provider === "anthropic"
            ? {
                stop_reason: "end_turn",
                content: [{ type: "text", text: '{"status":"ready"}' }],
              }
            : {
                choices: [
                  {
                    finish_reason: "stop",
                    message: { content: '{"status":"ready"}' },
                  },
                ],
              };
    expect(adapter.normalize(result, false)).toMatchObject({
      kind: "completed_candidate",
      complete: true,
      usage: { input: null, output: null, thinking: null },
    });
  });
  it("distinguishes refusal from a truncated or valid candidate", () => {
    const raw =
      provider === "openai"
        ? { output: [{ type: "message", content: [{ type: "refusal" }] }] }
        : provider === "gemini_free"
          ? { promptFeedback: { blockReason: "SAFETY" } }
          : provider === "anthropic"
            ? { stop_reason: "refusal" }
            : { choices: [{ finish_reason: "content_filter" }] };
    expect(adapter.normalize(raw, false).kind).toBe("refused");
  });
});
