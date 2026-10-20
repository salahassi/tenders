import { measuredCount } from "../modelContract.ts";
import {
  validRemoteId,
  type ModelAdapter,
  type AdapterRequest,
} from "./types.ts";
export const geminiAdapter: ModelAdapter = {
  provider: "gemini_free",
  prepare(env, input, background): AdapterRequest {
    const reasoning = input.capabilities.reasoning === "gemini_level";
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
              schema: input.schema,
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
              ...(input.capabilities.output !== "validated_json"
                ? { responseJsonSchema: input.schema }
                : {}),
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
