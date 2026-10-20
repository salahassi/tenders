import { measuredCount, strictJsonSchema } from "../modelContract.ts";
import { validRemoteId, type ModelAdapter } from "./types.ts";
export const openaiAdapter: ModelAdapter = {
  provider: "openai",
  prepare(env, input, background) {
    return {
      url: "https://api.openai.com/v1/responses",
      headers: { Authorization: `Bearer ${env.key}` },
      body: {
        model: env.model,
        instructions: input.system,
        input: input.prompt + "\nJSON schema: " + JSON.stringify(input.schema),
        max_output_tokens: input.profile.max_output_tokens,
        text: {
          format:
            input.capabilities.output === "native_strict"
              ? {
                  type: "json_schema",
                  name: `tenderdesk_${input.task}`,
                  strict: true,
                  schema: strictJsonSchema(input.schema),
                }
              : { type: "json_object" },
        },
        ...(input.capabilities.reasoning === "effort"
          ? { reasoning: { effort: input.profile.reasoning } }
          : {}),
        ...(background ? { background: true } : {}),
        store: background,
        stream: false,
      },
    };
  },
  poll(env, remoteId, remove) {
    return {
      url: `https://api.openai.com/v1/responses/${validRemoteId(remoteId)}`,
      headers: { Authorization: `Bearer ${env.key}` },
      method: remove ? "DELETE" : "GET",
    };
  },
  normalize(result) {
    const output = Array.isArray(result.output) ? result.output : [];
    const parts = output
      .filter((item: any) => item.type === "message")
      .flatMap((item: any) =>
        Array.isArray(item.content) ? item.content : [],
      );
    const usage = {
      input: measuredCount(result.usage?.input_tokens),
      output: measuredCount(result.usage?.output_tokens),
      thinking: measuredCount(
        result.usage?.output_tokens_details?.reasoning_tokens,
      ),
    };
    if (["queued", "in_progress"].includes(result.status))
      return { kind: "pending", remoteId: result.id, usage };
    if (["cancelled", "canceled"].includes(result.status))
      return { kind: "cancelled", usage };
    if (result.status === "failed" || result.error)
      return {
        kind: "provider_failure",
        code: "PROVIDER_REQUEST_REJECTED",
        retryAfter: null,
        usage,
      };
    if (parts.some((part: any) => part.type === "refusal"))
      return { kind: "refused", usage };
    return {
      kind: "completed_candidate",
      text: parts
        .filter(
          (part: any) =>
            part.type === "output_text" && typeof part.text === "string",
        )
        .map((part: any) => part.text)
        .join(""),
      usage,
      complete:
        result.status === "completed" &&
        output.every(
          (item: any) => item.type === "message" || item.type === "reasoning",
        ) &&
        parts.length > 0 &&
        parts.every((part: any) => part.type === "output_text"),
    };
  },
};
