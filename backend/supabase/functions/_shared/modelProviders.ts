export const MODEL_PROVIDER_IDS = [
  "gemini_free",
  "qwen_free",
  "groq_free",
  "mistral_free",
  "cloudflare_free",
] as const;
export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];
export const ROUND_ROBIN_PROVIDERS = [
  "gemini_free",
  "qwen_free",
  "mistral_free",
  "groq_free",
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
  }
}

export function isModelProviderId(value: string): value is ModelProviderId {
  return (MODEL_PROVIDER_IDS as readonly string[]).includes(value);
}
