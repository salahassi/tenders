export const MODEL_PROVIDER_IDS = [
  "gemini_free",
  "qwen_free",
  "groq_free",
  "mistral_free",
  "cloudflare_free",
  "zai_free",
  "openai",
  "anthropic",
] as const;
export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];
export const ROUND_ROBIN_PROVIDERS = [
  "gemini_free",
  "qwen_free",
  "mistral_free",
  "groq_free",
  "zai_free",
  "openai",
  "anthropic",
  "cloudflare_free",
] as const;

export function defaultFailoverRank(provider: ModelProviderId): number {
  switch (provider) {
    case "gemini_free":
      return 1;
    case "qwen_free":
      return 2;
    case "groq_free":
      return 3;
    case "mistral_free":
      return 4;
    case "cloudflare_free":
      return 5;
    case "zai_free":
      return 6;
    case "openai":
      return 7;
    case "anthropic":
      return 8;
  }
}

export function isModelProviderId(value: string): value is ModelProviderId {
  return (MODEL_PROVIDER_IDS as readonly string[]).includes(value);
}
