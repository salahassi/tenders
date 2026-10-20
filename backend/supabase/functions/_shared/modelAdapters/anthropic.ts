import { measuredCount, strictJsonSchema } from "../modelContract.ts";
import type { ModelAdapter } from "./types.ts";
export const anthropicAdapter: ModelAdapter = {
  provider: "anthropic",
  prepare(env, input, background) {
    if (background) throw new Error("MODEL_CAPABILITY_UNSUPPORTED");
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": env.key, "anthropic-version": "2023-06-01" },
      body: {
        model: env.model,
        system: input.system,
        messages: [
          {
            role: "user",
            content:
              input.prompt + "\nJSON schema: " + JSON.stringify(input.schema),
          },
        ],
        max_tokens: input.profile.max_output_tokens,
        stream: input.stream && input.capabilities.streaming,
        ...(input.capabilities.output !== "validated_json"
          ? {
              output_config: {
                format: {
                  type: "json_schema",
                  schema: strictJsonSchema(input.schema),
                },
              },
            }
          : {}),
      },
    };
  },
  normalize(result) {
    const parts = Array.isArray(result.content) ? result.content : [],
      u = result.usage ?? {};
    const inputs = [
      measuredCount(u.input_tokens),
      u.cache_creation_input_tokens == null
        ? 0
        : measuredCount(u.cache_creation_input_tokens),
      u.cache_read_input_tokens == null
        ? 0
        : measuredCount(u.cache_read_input_tokens),
    ];
    const usage = {
      input: inputs.every((v) => v !== null)
        ? inputs.reduce<number>((s, v) => s + v!, 0)
        : null,
      output: measuredCount(u.output_tokens),
      thinking: null,
    };
    if (result.stop_reason === "refusal") return { kind: "refused", usage };
    return {
      kind: "completed_candidate",
      text: parts
        .filter((p: any) => p.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join(""),
      usage,
      complete:
        result.stop_reason === "end_turn" &&
        parts.length > 0 &&
        parts.every((p: any) =>
          ["text", "thinking", "redacted_thinking"].includes(p.type),
        ),
    };
  },
};
