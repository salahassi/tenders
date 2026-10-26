import { measuredCount, strictJsonSchema } from "../modelContract.ts";
import type { ModelProviderId } from "../modelProviders.ts";
import type { AdapterEnvironment, ModelAdapter } from "./types.ts";
type ChatProvider = Exclude<
  ModelProviderId,
  "gemini_free" | "openai" | "anthropic"
>;
const endpoints: Record<ChatProvider, (env: AdapterEnvironment) => string> = {
  qwen_free: (e) =>
    `https://${e.projectRef}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions`,
  qwencloud: () =>
    "https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1/chat/completions",
  openrouter: () => "https://openrouter.ai/api/v1/chat/completions",
  groq_free: () => "https://api.groq.com/openai/v1/chat/completions",
  mistral_free: () => "https://api.mistral.ai/v1/chat/completions",
  zai_free: () => "https://api.z.ai/api/paas/v4/chat/completions",
  cloudflare_free: (e) =>
    `https://api.cloudflare.com/client/v4/accounts/${e.projectRef}/ai/v1/chat/completions`,
};
export function chatAdapter(provider: ChatProvider): ModelAdapter {
  return {
    provider,
    prepare(env, input, background) {
      if (background) throw new Error("MODEL_CAPABILITY_UNSUPPORTED");
      return {
        url: endpoints[provider](env),
        headers: { Authorization: `Bearer ${env.key}` },
        body: {
          model: env.model,
          ...(provider === "openrouter"
            ? { provider: { require_parameters: true } }
            : {}),
          messages: [
            { role: "system", content: input.system },
            {
              role: "user",
              content:
                input.prompt + "\nJSON schema: " + JSON.stringify(input.schema),
            },
          ],
          max_tokens: input.profile.max_output_tokens,
          stream: input.stream && input.capabilities.streaming,
          response_format:
            input.capabilities.output === "validated_json"
              ? { type: "json_object" }
              : provider === "cloudflare_free"
                ? {
                    type: "json_schema",
                    json_schema: strictJsonSchema(input.schema),
                  }
                : {
                    type: "json_schema",
                    json_schema: {
                      name: `tenderdesk_${input.task}`,
                      strict: input.capabilities.output === "native_strict",
                      schema: strictJsonSchema(input.schema),
                    },
                  },
          ...(input.capabilities.reasoning === "effort"
            ? provider === "openrouter"
              ? { reasoning: { effort: input.profile.reasoning } }
              : { reasoning_effort: input.profile.reasoning }
            : {}),
          ...(input.capabilities.reasoning === "qwen_toggle"
            ? { enable_thinking: input.profile.reasoning !== "none" }
            : {}),
        },
      };
    },
    normalize(result) {
      const u = result.usage ?? {},
        choice = result.choices?.[0];
      const usage = {
        input: measuredCount(u.prompt_tokens),
        output: measuredCount(u.completion_tokens),
        thinking: measuredCount(u.completion_tokens_details?.reasoning_tokens),
      };
      if (
        choice?.message?.refusal ||
        choice?.finish_reason === "content_filter"
      )
        return { kind: "refused", usage };
      return {
        kind: "completed_candidate",
        text: choice?.message?.content ?? "",
        usage,
        complete:
          choice?.finish_reason === "stop" &&
          !choice.message?.tool_calls?.length,
      };
    },
  };
}
