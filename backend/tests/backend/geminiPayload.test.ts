// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  defaultCapabilities,
  resolveProfile,
  taskJsonSchema,
  taskRegistry,
  type ModelCapabilities,
} from "../../supabase/functions/_shared/modelContract";
import {
  geminiAdapter,
  geminiJsonSchema,
} from "../../supabase/functions/_shared/modelAdapters/gemini";
import type { AdapterInput } from "../../supabase/functions/_shared/modelAdapters/types";
import {
  primaryModelTasks,
  type ModelTask,
  type PrimaryModelTask,
} from "../../supabase/functions/_shared/modelSchemas";

// Wire contract reviewed against Google's current schemas and examples:
// https://ai.google.dev/static/api/interactions.openapi.json
// https://ai.google.dev/gemini-api/docs/structured-output
// https://ai.google.dev/api/generate-content#GenerationConfig
// These fixtures assert request construction, not successful remote processing.
const env = {
  provider: "gemini_free",
  model: "owner-selected-model",
  projectRef: "synthetic-project",
  key: "synthetic-credential",
};

function inputFor(
  task: ModelTask,
  capabilities: ModelCapabilities = defaultCapabilities("gemini_free"),
  targetTask?: PrimaryModelTask,
): AdapterInput {
  return {
    task,
    prompt: "Public fixture: the requested service is a web portal.",
    system: "Return the requested JSON using only the supplied evidence.",
    schema: taskJsonSchema(task, targetTask),
    capabilities,
    profile: resolveProfile(task, capabilities),
    stream: false,
  };
}

function wireBody(input: AdapterInput, background: boolean) {
  // Inspect the serialized wire representation, not TypeScript's optional fields.
  return JSON.parse(
    JSON.stringify(geminiAdapter.prepare(env, input, background).body),
  );
}

it("builds the documented Interactions envelope for the failing analysis profile", () => {
  const input = inputFor("analyze_chunk");
  expect(input.capabilities.reasoning).toBe("none");
  expect(input.capabilities.reasoning_values).toEqual([]);
  expect(input.profile.max_output_tokens).toBe(40000);
  const request = geminiAdapter.prepare(env, input, true);
  expect(request.url).toBe(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
  );
  expect(request.headers).toEqual({
    "x-goog-api-key": env.key,
    "Api-Revision": "2026-05-20",
  });
  expect(wireBody(input, true)).toEqual({
    model: env.model,
    system_instruction: input.system,
    input: input.prompt,
    background: true,
    store: true,
    stream: false,
    generation_config: { max_output_tokens: 40000 },
    response_format: {
      type: "text",
      mime_type: "application/json",
      schema: geminiJsonSchema(taskJsonSchema("analyze_chunk")),
    },
  });
  expect(JSON.stringify(request.body)).not.toContain(env.key);
});

const tasks = Object.keys(taskRegistry) as ModelTask[];
describe.each(tasks)("Gemini %s payload", (task) => {
  it("uses the translated real task schema and resolved output profile in both transports", () => {
    const input = inputFor(task);
    const background = wireBody(input, true);
    const standard = wireBody(input, false);
    expect(background.generation_config).toEqual({
      max_output_tokens: input.profile.max_output_tokens,
    });
    expect(background.response_format).toEqual({
      type: "text",
      mime_type: "application/json",
      schema: geminiJsonSchema(taskJsonSchema(task)),
    });
    expect(standard).toEqual({
      systemInstruction: { parts: [{ text: input.system }] },
      contents: [{ role: "user", parts: [{ text: input.prompt }] }],
      generationConfig: {
        candidateCount: 1,
        maxOutputTokens: input.profile.max_output_tokens,
        responseMimeType: "application/json",
        responseJsonSchema: geminiJsonSchema(taskJsonSchema(task)),
      },
    });
  });
});

it.each(primaryModelTasks)(
  "uses the targeted repair schema for %s without weakening local constraints",
  (targetTask) => {
    const input = inputFor("repair_result", undefined, targetTask);
    expect(wireBody(input, true).response_format.schema).toEqual(
      geminiJsonSchema(taskJsonSchema("repair_result", targetTask)),
    );
    expect(wireBody(input, false).generationConfig.responseJsonSchema).toEqual(
      geminiJsonSchema(taskJsonSchema("repair_result", targetTask)),
    );
  },
);

it.each([
  { label: "no configured levels", reasoning_values: [] },
  { label: "explicit provider default", reasoning_values: ["none"] },
] satisfies {
  label: string;
  reasoning_values: ModelCapabilities["reasoning_values"];
}[])(
  "omits thinking controls when the resolved level is provider default ($label)",
  ({ reasoning_values }) => {
    const input = inputFor("analyze_chunk", {
      ...defaultCapabilities("gemini_free"),
      reasoning: "gemini_level",
      reasoning_values,
    });
    expect(input.profile.reasoning).toBe("none");
    expect(wireBody(input, true).generation_config).not.toHaveProperty(
      "thinking_level",
    );
    expect(wireBody(input, false).generationConfig).not.toHaveProperty(
      "thinkingConfig",
    );
  },
);

it.each(["minimal", "low", "medium", "high"] as const)(
  "uses the documented %s thinking level with the correct transport spelling",
  (reasoning) => {
    const input = inputFor("analyze_chunk", {
      ...defaultCapabilities("gemini_free"),
      reasoning: "gemini_level",
      reasoning_values: [reasoning],
    });
    expect(wireBody(input, true).generation_config.thinking_level).toBe(
      reasoning,
    );
    expect(wireBody(input, false).generationConfig.thinkingConfig).toEqual({
      thinkingLevel: reasoning.toUpperCase(),
    });
  },
);

it("does not emit a thinking control when the model has no Gemini-level capability", () => {
  const input = inputFor("analyze_chunk");
  input.profile.reasoning = "high";
  expect(wireBody(input, true).generation_config).not.toHaveProperty(
    "thinking_level",
  );
  expect(wireBody(input, false).generationConfig).not.toHaveProperty(
    "thinkingConfig",
  );
});

it("uses JSON mode without a native schema in both transports when configured for validated JSON", () => {
  const input = inputFor("analyze_chunk", {
    ...defaultCapabilities("gemini_free"),
    output: "validated_json",
  });
  expect(wireBody(input, true).response_format).toEqual({
    type: "text",
    mime_type: "application/json",
  });
  const generation = wireBody(input, false).generationConfig;
  expect(generation.responseMimeType).toBe("application/json");
  expect(generation).not.toHaveProperty("responseJsonSchema");
  expect(input.schema).toEqual(taskJsonSchema("analyze_chunk"));
});
