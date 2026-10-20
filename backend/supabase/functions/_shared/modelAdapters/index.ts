import type { ModelProviderId } from "../modelProviders.ts";
import { openaiAdapter } from "./openai.ts";
import { geminiAdapter } from "./gemini.ts";
import { anthropicAdapter } from "./anthropic.ts";
import { chatAdapter } from "./chat.ts";
import type { ModelAdapter } from "./types.ts";
export const modelAdapters: Record<ModelProviderId, ModelAdapter> = {
  openai: openaiAdapter,
  gemini_free: geminiAdapter,
  anthropic: anthropicAdapter,
  qwen_free: chatAdapter("qwen_free"),
  groq_free: chatAdapter("groq_free"),
  mistral_free: chatAdapter("mistral_free"),
  zai_free: chatAdapter("zai_free"),
  cloudflare_free: chatAdapter("cloudflare_free"),
};
