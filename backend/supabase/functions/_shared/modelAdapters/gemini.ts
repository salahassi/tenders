import { measuredCount } from "../modelContract.ts";
import {
  validRemoteId,
  type ModelAdapter,
  type AdapterRequest,
} from "./types.ts";

/** Gemini's decoding schema is narrower than the canonical local validator.
 * https://ai.google.dev/api/generate-content#GenerationConfig
 * https://ai.google.dev/gemini-api/docs/structured-output
 * Array bounds are checked locally, avoiding expansion of bounded nested arrays
 * in the provider's decoding grammar. This does not relax local acceptance.
 */
export function geminiJsonSchema(
  schema: Record<string, any>,
): Record<string, any> {
  const unsupported = (): never => {
    throw Object.assign(new Error("MODEL_CAPABILITY_UNSUPPORTED"), {
      code: "MODEL_CAPABILITY_UNSUPPORTED",
    });
  };
  const object = (value: unknown): value is Record<string, any> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const ignored = new Set([
    "$schema",
    "pattern",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
  ]);
  const types = [
    "object",
    "array",
    "string",
    "number",
    "integer",
    "boolean",
    "null",
  ];
  const visit = (node: unknown): Record<string, any> => {
    if (!object(node)) return unsupported();
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(node)) {
      if (ignored.has(key) || key === "const") continue;
      if (key === "properties" || key === "$defs") {
        if (!object(value)) return unsupported();
        result[key] = Object.fromEntries(
          Object.entries(value).map(([name, child]) => [name, visit(child)]),
        );
      } else if (key === "items") result[key] = visit(value);
      else if (key === "additionalProperties")
        result[key] = typeof value === "boolean" ? value : visit(value);
      else if (["anyOf", "oneOf", "prefixItems"].includes(key)) {
        if (!Array.isArray(value) || (!value.length && key !== "prefixItems"))
          return unsupported();
        result[key] = value.map(visit);
      } else if (key === "type") {
        const values = Array.isArray(value) ? value : [value];
        if (!values.length || values.some((type) => !types.includes(type)))
          return unsupported();
        result[key] = Array.isArray(value) ? [...value] : value;
      } else if (key === "enum") {
        if (
          !Array.isArray(value) ||
          !value.length ||
          value.some(
            (item) =>
              typeof item !== "string" &&
              !(typeof item === "number" && Number.isFinite(item)),
          )
        )
          return unsupported();
        result[key] = [...value];
      } else if (key === "required" || key === "propertyOrdering") {
        if (
          !Array.isArray(value) ||
          value.some((name) => typeof name !== "string") ||
          new Set(value).size !== value.length
        )
          return unsupported();
        result[key] = [...value];
      } else if (key === "minimum" || key === "maximum") {
        if (typeof value !== "number" || !Number.isFinite(value))
          return unsupported();
        result[key] = value;
      } else if (
        ["$id", "$ref", "$anchor", "format", "title", "description"].includes(
          key,
        )
      ) {
        if (typeof value !== "string") return unsupported();
        result[key] = value;
      } else return unsupported();
    }
    if (Object.hasOwn(node, "const")) {
      const value = node.const;
      const type = value === null ? "null" : typeof value;
      if (
        !["string", "number", "boolean", "null"].includes(type) ||
        (type === "number" && !Number.isFinite(value))
      )
        return unsupported();
      const declared = Array.isArray(result.type) ? result.type : [result.type];
      if (
        result.type !== undefined &&
        !declared.includes(type) &&
        !(
          type === "number" &&
          Number.isInteger(value) &&
          declared.includes("integer")
        )
      )
        return unsupported();
      if (result.enum && !result.enum.includes(value)) return unsupported();
      if (type === "string" || type === "number") {
        result.type ??= type;
        result.enum = [value];
      } else {
        // Gemini documents string/number enums only; local Zod retains literals.
        result.type = type;
      }
    }
    if (result.$ref && Object.keys(result).some((key) => !key.startsWith("$")))
      return unsupported();
    return result;
  };
  return visit(schema);
}

export const geminiAdapter: ModelAdapter = {
  provider: "gemini_free",
  prepare(env, input, background): AdapterRequest {
    // "none" means leave thinking to the provider; it is not a Gemini level.
    const reasoning =
      input.capabilities.reasoning === "gemini_level" &&
      input.profile.reasoning !== "none";
    const schema =
      input.capabilities.output !== "validated_json"
        ? geminiJsonSchema(input.schema)
        : undefined;
    return background
      ? {
          url: "https://generativelanguage.googleapis.com/v1beta/interactions",
          headers: { "x-goog-api-key": env.key, "Api-Revision": "2026-05-20" },
          body: {
            model: env.model,
            system_instruction: input.system,
            input: input.prompt,
            background: true,
            store: true,
            stream: false,
            generation_config: {
              max_output_tokens: input.profile.max_output_tokens,
              ...(reasoning ? { thinking_level: input.profile.reasoning } : {}),
            },
            response_format: {
              type: "text",
              mime_type: "application/json",
              ...(schema ? { schema } : {}),
            },
          },
        }
      : {
          url: `https://generativelanguage.googleapis.com/v1beta/models/${env.model}:generateContent`,
          headers: { "x-goog-api-key": env.key },
          body: {
            systemInstruction: { parts: [{ text: input.system }] },
            contents: [{ role: "user", parts: [{ text: input.prompt }] }],
            generationConfig: {
              candidateCount: 1,
              maxOutputTokens: input.profile.max_output_tokens,
              responseMimeType: "application/json",
              ...(schema ? { responseJsonSchema: schema } : {}),
              ...(reasoning
                ? {
                    thinkingConfig: {
                      thinkingLevel: input.profile.reasoning.toUpperCase(),
                    },
                  }
                : {}),
            },
          },
        };
  },
  poll(env, remoteId, remove) {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/interactions/${validRemoteId(remoteId)}`,
      headers: { "x-goog-api-key": env.key, "Api-Revision": "2026-05-20" },
      method: remove ? "DELETE" : "GET",
    };
  },
  normalize(result, background) {
    const u = background ? (result.usage ?? {}) : (result.usageMetadata ?? {});
    const input = measuredCount(
      background ? u.total_input_tokens : u.promptTokenCount,
    );
    const output = measuredCount(
      background ? u.total_output_tokens : u.candidatesTokenCount,
    );
    const total = measuredCount(u.totalTokenCount);
    const thinking =
      measuredCount(
        background ? u.total_thought_tokens : u.thoughtsTokenCount,
      ) ??
      (!background &&
      input !== null &&
      output !== null &&
      total !== null &&
      total >= input + output
        ? total - input - output
        : null);
    const usage = {
      input,
      output: output === null || thinking === null ? null : output + thinking,
      thinking,
    };
    if (background && ["in_progress", "queued"].includes(result.status))
      return { kind: "pending", remoteId: result.id, usage };
    if (["cancelled", "canceled"].includes(result.status))
      return { kind: "cancelled", usage };
    if (result.status === "failed")
      return {
        kind: "provider_failure",
        code: "PROVIDER_REQUEST_REJECTED",
        retryAfter: null,
        usage,
      };
    const candidate = result.candidates?.[0];
    if (
      result.promptFeedback?.blockReason ||
      ["SAFETY", "RECITATION", "PROHIBITED_CONTENT"].includes(
        candidate?.finishReason,
      )
    )
      return { kind: "refused", usage };
    const parts = background
      ? (result.steps ?? [])
          .filter((s: any) => s.type === "model_output")
          .flatMap((s: any) => s.content ?? [])
      : (candidate?.content?.parts ?? []);
    return {
      kind: "completed_candidate",
      text: parts
        .filter(
          (p: any) =>
            typeof p.text === "string" &&
            !p.thought &&
            (!background || p.type === "text"),
        )
        .map((p: any) => p.text)
        .join(""),
      usage,
      complete: background
        ? result.status === "completed" &&
          !(result.steps ?? []).some((s: any) => s.type === "function_call")
        : result.candidates?.length === 1 &&
          candidate.finishReason === "STOP" &&
          !parts.some((p: any) => p.functionCall || p.executableCode),
    };
  },
};
