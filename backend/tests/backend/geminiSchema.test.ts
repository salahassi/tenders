// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  defaultCapabilities,
  resolveProfile,
  taskJsonSchema,
  taskRegistry,
} from "../../supabase/functions/_shared/modelContract";
import {
  geminiAdapter,
  geminiJsonSchema,
} from "../../supabase/functions/_shared/modelAdapters/gemini";
import {
  modelSchemas,
  primaryModelTasks,
  type ModelTask,
} from "../../supabase/functions/_shared/modelSchemas";

// Google documents a subset for native decoding; canonical local Zod remains
// the acceptance contract. Reducing decoding constraints is a candidate fix for
// a generic HTTP 400, not proof of its remote cause.
// https://ai.google.dev/api/generate-content#GenerationConfig
// https://ai.google.dev/gemini-api/docs/structured-output
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const string = { type: "string" };
const array = (items: Record<string, any>) => ({ type: "array", items });
const object = (properties: Record<string, any>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const quote = object({ id: string, quote: string });
const status = {
  type: "string",
  enum: ["supported", "contradicted", "insufficient"],
};
const expectedVerification = object({
  checked_candidate_hash: string,
  reviewed_all_content: { type: "boolean" },
  processed_content_ids: array(string),
  claims: array(
    object({
      id: string,
      claim: string,
      candidate_quote: string,
      kind: {
        type: "string",
        enum: [
          "company_fact",
          "tender_fact",
          "proposed_solution",
          "assumption",
          "commercial_commitment",
        ],
      },
      status,
      source_refs: array(quote),
      finding: string,
    }),
  ),
  processed_requirement_ids: array(string),
  requirement_checks: array(
    object({
      requirement_id: string,
      status,
      candidate_quote: string,
      source_refs: array(quote),
      finding: string,
    }),
  ),
  findings: array(
    object({
      severity: { type: "string", enum: ["blocking", "advisory"] },
      code: string,
      detail: string,
      claim_ids: array(string),
      requirement_ids: array(string),
    }),
  ),
});

it("translates the complete actual grounding report schema without mutating its canonical constraints", () => {
  const canonical = freeze(taskJsonSchema("verify_grounding"));
  const before = JSON.stringify(canonical);
  expect(Buffer.byteLength(before)).toBe(2732);
  const translated = geminiJsonSchema(canonical);
  expect(translated).toEqual(expectedVerification);
  expect(JSON.stringify(canonical)).toBe(before);
  expect(canonical.properties.reviewed_all_content.const).toBe(true);
  expect(canonical.properties.checked_candidate_hash.pattern).toBe(
    "^[a-f0-9]{64}$",
  );
  expect(canonical.properties.processed_content_ids.maxItems).toBe(2048);
  expect(canonical.properties.claims.maxItems).toBe(128);
  expect(
    canonical.properties.claims.items.properties.source_refs.maxItems,
  ).toBe(20);
});

it("retains full local acceptance checks after simplifying the native decoding schema", () => {
  geminiJsonSchema(taskJsonSchema("verify_grounding"));
  const valid = {
    checked_candidate_hash: "a".repeat(64),
    reviewed_all_content: true,
    processed_content_ids: ["content-1"],
    claims: [],
    processed_requirement_ids: [],
    requirement_checks: [],
    findings: [],
  };
  expect(modelSchemas.verify_grounding.safeParse(valid).success).toBe(true);
  for (const change of [
    { reviewed_all_content: false },
    { checked_candidate_hash: "invalid-hash" },
    {
      processed_content_ids: Array.from({ length: 2049 }, (_, i) => `id-${i}`),
    },
    {
      claims: Array.from({ length: 129 }, () => ({
        id: "c",
        claim: "text",
        candidate_quote: "text",
        kind: "tender_fact",
        status: "supported",
        source_refs: [],
        finding: "",
      })),
    },
    {
      findings: [
        {
          severity: "advisory",
          code: "invalid code!",
          detail: "",
          claim_ids: [],
          requirement_ids: [],
        },
      ],
    },
    { unknown_property: true },
  ])
    expect(
      modelSchemas.verify_grounding.safeParse({ ...valid, ...change }).success,
    ).toBe(false);
});

const env = {
  provider: "gemini_free",
  model: "fixture-model",
  projectRef: "fixture",
  key: "fixture-key",
};
const cases = [
  ...(Object.keys(taskRegistry) as ModelTask[]).map((task) => ({
    task,
    targetTask: undefined,
  })),
  ...primaryModelTasks.map((targetTask) => ({
    task: "repair_result" as const,
    targetTask,
  })),
];
describe.each(cases)(
  "Gemini schema $task / $targetTask",
  ({ task, targetTask }) => {
    it("uses the same supported schema in both transports and leaves canonical input intact", () => {
      const canonical = freeze(taskJsonSchema(task, targetTask));
      const before = JSON.stringify(canonical);
      const capabilities = defaultCapabilities("gemini_free");
      const input = {
        task,
        schema: canonical,
        capabilities,
        profile: resolveProfile(task, capabilities),
        prompt: "synthetic fixture",
        system: "synthetic instruction",
        stream: false,
      };
      const background = geminiAdapter.prepare(env, input, true).body as any;
      const standard = geminiAdapter.prepare(env, input, false).body as any;
      expect(background.response_format.schema).toEqual(
        standard.generationConfig.responseJsonSchema,
      );
      expect(JSON.stringify(canonical)).toBe(before);
      const walk = (node: Record<string, any>) => {
        for (const key of [
          "$schema",
          "const",
          "pattern",
          "minLength",
          "maxLength",
          "minItems",
          "maxItems",
          "minProperties",
          "maxProperties",
        ])
          expect(node).not.toHaveProperty(key);
        for (const child of Object.values(node.properties ?? {}))
          walk(child as any);
        if (node.items) walk(node.items);
        for (const child of node.anyOf ?? node.oneOf ?? []) walk(child);
      };
      walk(standard.generationConfig.responseJsonSchema);
    });
  },
);

it("preserves supported schema semantics and converts scalar literals to supported enums", () => {
  const canonical = freeze({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      pattern: {
        type: "string",
        const: "fixed",
        minLength: 2,
        pattern: "fixed",
      },
      const: { type: "integer", const: 3, minimum: 0, maximum: 5 },
      enabled: { type: "boolean", const: true },
      nothing: { const: null },
      items: {
        type: "array",
        minItems: 1,
        maxItems: 2048,
        items: {
          anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
        },
      },
      ref: { $ref: "#/$defs/text" },
      tuple: {
        type: "array",
        prefixItems: [{ type: "number" }, { type: "string" }],
      },
      options: {
        oneOf: [
          { type: "string", enum: ["a", "b"] },
          { type: "number", enum: [1, 2] },
        ],
      },
      labels: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["pattern", "const", "enabled", "nothing", "items"],
    additionalProperties: false,
    propertyOrdering: ["pattern", "const"],
    minProperties: 1,
    maxProperties: 20,
    $defs: {
      text: {
        type: ["string", "null"],
        title: "Text",
        description: "Nullable text",
        maxLength: 10,
      },
    },
  });
  expect(geminiJsonSchema(canonical)).toEqual({
    type: "object",
    properties: {
      pattern: { type: "string", enum: ["fixed"] },
      const: { type: "integer", enum: [3], minimum: 0, maximum: 5 },
      enabled: { type: "boolean" },
      nothing: { type: "null" },
      items: {
        type: "array",
        items: {
          anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
        },
      },
      ref: { $ref: "#/$defs/text" },
      tuple: {
        type: "array",
        prefixItems: [{ type: "number" }, { type: "string" }],
      },
      options: {
        oneOf: [
          { type: "string", enum: ["a", "b"] },
          { type: "number", enum: [1, 2] },
        ],
      },
      labels: { type: "object", additionalProperties: { type: "string" } },
    },
    required: ["pattern", "const", "enabled", "nothing", "items"],
    additionalProperties: false,
    propertyOrdering: ["pattern", "const"],
    $defs: {
      text: {
        type: ["string", "null"],
        title: "Text",
        description: "Nullable text",
      },
    },
  });
});

it.each([
  { allOf: [{ type: "string" }] },
  { not: { type: "string" } },
  { if: { type: "string" }, then: { type: "number" } },
  { unevaluatedProperties: false },
  { type: "undefined" },
  { const: {} },
  { const: [] },
  { type: "string", const: true },
  { type: "number", const: Infinity },
  { enum: [true, false] },
  { enum: [] },
  { anyOf: [] },
  { type: "object", properties: [] },
  { items: false },
  { required: ["a", "a"] },
  { minimum: Infinity },
  { enum: ["a"], const: "b" },
  { $ref: "#/$defs/a", type: "string" },
  { unknown_keyword: true },
])("fails locally for unsupported structural semantics: %j", (schema) => {
  expect(() => geminiJsonSchema(schema)).toThrowError(
    "MODEL_CAPABILITY_UNSUPPORTED",
  );
});
