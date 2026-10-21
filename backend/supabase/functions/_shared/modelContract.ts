import { z } from "zod";
import {
  modelSchemas,
  repairOutputSchema,
  type PrimaryModelTask,
  type ModelTask,
} from "./modelSchemas.ts";
import type { ModelProviderId } from "./modelProviders.ts";

export const MODEL_CONTRACT_VERSION = "1";
export const capabilitySchema = z
  .object({
    revision: z.number().int().positive().default(1),
    output: z.enum(["native_strict", "schema", "validated_json"]),
    background: z.boolean().default(false),
    streaming: z.boolean().default(true),
    reasoning: z
      .enum(["none", "effort", "gemini_level", "qwen_toggle"])
      .default("none"),
    reasoning_values: z
      .array(z.enum(["none", "minimal", "low", "medium", "high"]))
      .max(5)
      .default([]),
    max_output_tokens: z
      .number()
      .int()
      .min(1024)
      .max(131072)
      .nullable()
      .default(null),
  })
  .strict();
export type ModelCapabilities = z.infer<typeof capabilitySchema>;
export const executionProfileSchema = z
  .object({
    revision: z.number().int().positive().default(1),
    max_output_tokens: z.number().int().min(1024).max(131072),
    reasoning: z.enum(["none", "minimal", "low", "medium", "high"]),
    require_native_strict: z.boolean().default(false),
  })
  .strict();
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;

const defaults = (
  max_output_tokens: number,
  reasoning: ExecutionProfile["reasoning"],
): ExecutionProfile => ({
  revision: 1,
  max_output_tokens,
  reasoning,
  require_native_strict: false,
});
const profiles: Record<ModelTask, ExecutionProfile> = {
  connection_probe: defaults(1024, "minimal"),
  inspect_source_page: defaults(8192, "low"),
  classify_opportunity: defaults(8192, "low"),
  summarize_review: defaults(8192, "low"),
  analyze_chunk: defaults(16384, "medium"),
  plan_proposal: defaults(8192, "low"),
  plan_blueprint: defaults(16384, "medium"),
  draft_section: defaults(16384, "medium"),
  plan_commercial: defaults(8192, "low"),
  review_proposal: defaults(16384, "medium"),
  verify_grounding: defaults(16384, "low"),
  repair_result: defaults(16384, "medium"),
};
export const taskRegistry = Object.fromEntries(
  Object.entries(modelSchemas).map(([task, output]) => [
    task,
    {
      output,
      schemaVersion: "1",
      // Preserve legacy prompt identities for accepted requests and resumable jobs.
      promptVersion:
        task === "classify_opportunity"
          ? "tenderdesk-v6-configurable-service-scope"
          : task === "verify_grounding"
            ? "tenderdesk-grounding-v1"
            : task === "repair_result"
              ? "tenderdesk-repair-v1"
              : "tenderdesk-v3",
      profile: profiles[task as ModelTask],
    },
  ]),
) as {
  [T in ModelTask]: {
    output: (typeof modelSchemas)[T];
    schemaVersion: string;
    promptVersion: string;
    profile: ExecutionProfile;
  };
};

export type StructuredRequest = {
  contractVersion: typeof MODEL_CONTRACT_VERSION;
  task: ModelTask;
  schemaVersion: string;
  promptVersion: string;
  inputHash: string;
  language: "en" | "ar";
  target: {
    provider: ModelProviderId;
    model: string;
    project: string;
    connectionId?: string;
    modelId?: string;
  };
  evidence: { id: string; kind: string; verified: boolean; hash: string }[];
  requiredIds: string[];
  routeRevision: number | null;
  profile: ExecutionProfile;
  capabilities: ModelCapabilities;
  reasoningControl?: {
    transport: string;
    requested: ExecutionProfile["reasoning"];
    effective: ExecutionProfile["reasoning"];
  };
  schema: Record<string, any>;
  prompt: string;
  targetTask?: PrimaryModelTask;
};
export function structuredRequest(
  input: Omit<
    StructuredRequest,
    "contractVersion" | "schemaVersion" | "promptVersion" | "schema"
  >,
): StructuredRequest {
  const definition = taskRegistry[input.task];
  if (
    !definition ||
    !/^[0-9a-f]{64}$/.test(input.inputHash) ||
    new Set(input.requiredIds).size !== input.requiredIds.length ||
    new Set(input.evidence.map((e) => e.id)).size !== input.evidence.length ||
    input.evidence.some((e) => !/^[0-9a-f]{64}$/.test(e.hash))
  )
    throw Object.assign(new Error("MODEL_REQUEST_INVALID"), {
      code: "MODEL_REQUEST_INVALID",
    });
  return {
    ...input,
    contractVersion: MODEL_CONTRACT_VERSION,
    schemaVersion: definition.schemaVersion,
    promptVersion: definition.promptVersion,
    schema: taskJsonSchema(input.task, input.targetTask),
  };
}
export type ModelUsage = {
  input: number | null;
  output: number | null;
  thinking: number | null;
};
export type TransportResult =
  | {
      kind: "completed_candidate";
      text: string;
      usage: ModelUsage;
      complete: boolean;
    }
  | { kind: "pending"; remoteId: string; usage: ModelUsage }
  | {
      kind: "provider_failure";
      code: string;
      retryAfter: string | null;
      usage: ModelUsage;
    }
  | { kind: "refused" | "cancelled"; usage: ModelUsage };

/** Conservative transport defaults; capabilities are model configuration, never name heuristics. */
export function defaultCapabilities(
  provider: ModelProviderId,
): ModelCapabilities {
  return capabilitySchema.parse({
    output:
      provider === "openai"
        ? "native_strict"
        : provider === "gemini_free"
          ? "schema"
          : "validated_json",
    background: provider === "openai" || provider === "gemini_free",
    streaming: provider !== "openai" && provider !== "gemini_free",
    reasoning: provider === "qwen_free" ? "qwen_toggle" : "none",
    reasoning_values: provider === "qwen_free" ? ["none"] : [],
  });
}
export function resolveProfile(
  task: ModelTask,
  capabilities: ModelCapabilities,
  saved?: ExecutionProfile,
): ExecutionProfile {
  const requested = executionProfileSchema.parse(
    saved ?? taskRegistry[task].profile,
  );
  if (
    requested.require_native_strict &&
    capabilities.output !== "native_strict"
  )
    throw Object.assign(new Error("MODEL_CAPABILITY_UNSUPPORTED"), {
      code: "MODEL_CAPABILITY_UNSUPPORTED",
    });
  return {
    ...requested,
    max_output_tokens: Math.min(
      requested.max_output_tokens,
      capabilities.max_output_tokens ?? requested.max_output_tokens,
    ),
    reasoning: capabilities.reasoning_values.includes(requested.reasoning)
      ? requested.reasoning
      : (capabilities.reasoning_values[0] ?? "none"),
  };
}
export function taskOutputSchema(
  task: ModelTask,
  targetTask?: PrimaryModelTask,
) {
  return task === "repair_result" && targetTask
    ? repairOutputSchema(targetTask)
    : taskRegistry[task].output;
}
export function taskJsonSchema(
  task: ModelTask,
  targetTask?: PrimaryModelTask,
): Record<string, any> {
  return z.toJSONSchema(taskOutputSchema(task, targetTask));
}

/**
 * Strict APIs require every property. Nullable optional fields are converted back
 * against the original schema before local validation. Constraints are retained.
 */
export function strictJsonSchema(
  schema: Record<string, any>,
): Record<string, any> {
  const visit = (value: any): any => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const result = Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "$schema")
        .map(([key, child]) => [key === "oneOf" ? "anyOf" : key, visit(child)]),
    ) as any;
    if (result.type === "object" && result.properties) {
      const required = new Set(value.required ?? []);
      for (const key of Object.keys(result.properties)) {
        if (!required.has(key))
          result.properties[key] = {
            anyOf: [result.properties[key], { type: "null" }],
          };
      }
      result.required = Object.keys(result.properties);
      result.additionalProperties = false;
    }
    return result;
  };
  return visit(schema);
}
export function normalizeOptionalNulls(
  value: any,
  schema: Record<string, any>,
): any {
  if (value === null || value === undefined) return value;
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) {
    const matching = variants.find(
      (v: any) =>
        v.type === "object" &&
        value &&
        typeof value === "object" &&
        Object.entries(v.properties ?? {}).every(
          ([key, prop]: [string, any]) =>
            prop.const === undefined || value[key] === prop.const,
        ),
    );
    return matching ? normalizeOptionalNulls(value, matching) : value;
  }
  if (Array.isArray(value) && schema.items)
    return value.map((item) => normalizeOptionalNulls(item, schema.items));
  if (schema.type !== "object" || typeof value !== "object") return value;
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const property = schema.properties?.[key];
      // Explicit nullable domain values stay null; only optional absence is removed.
      const nullable =
        property &&
        (property.type === "null" ||
          (Array.isArray(property.type) && property.type.includes("null")) ||
          property.anyOf?.some((variant: any) => variant.type === "null"));
      if (child === null && property && !required.has(key) && !nullable)
        return [];
      return [
        [key, property ? normalizeOptionalNulls(child, property) : child],
      ];
    }),
  );
}
export const measuredCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
