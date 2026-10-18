export const MODEL_PROVIDERS = [
  {
    id: "gemini_free",
    label: "Gemini",
    prefix: "APP_MODEL_GEMINI",
    rank: 1,
    accountLabel: "Google Cloud project identifier",
  },
  {
    id: "qwen_free",
    label: "Qwen",
    prefix: "APP_MODEL_QWEN",
    rank: 2,
    accountLabel: "Singapore workspace identifier",
  },
  {
    id: "groq_free",
    label: "Groq",
    prefix: "APP_MODEL_GROQ",
    rank: 3,
    accountLabel: "Account label",
  },
  {
    id: "mistral_free",
    label: "Mistral",
    prefix: "APP_MODEL_MISTRAL",
    rank: 4,
    accountLabel: "Account label",
  },
  {
    id: "zai_free",
    label: "z.ai",
    prefix: "APP_MODEL_ZAI",
    rank: 6,
    accountLabel: "Account label",
  },
  {
    id: "openai",
    label: "OpenAI",
    prefix: "APP_MODEL_OPENAI",
    rank: 7,
    accountLabel: "Account label (defaults to default)",
  },
  {
    id: "anthropic",
    label: "Claude",
    prefix: "APP_MODEL_CLAUDE",
    rank: 8,
    accountLabel: "Account label (defaults to default)",
  },
  {
    id: "cloudflare_free",
    label: "Cloudflare Workers AI",
    prefix: "APP_MODEL_CLOUDFLARE",
    rank: 5,
    accountLabel: "Cloudflare account ID",
  },
] as const;
export type ProviderId = (typeof MODEL_PROVIDERS)[number]["id"];
export const DEFAULT_PROVIDER_ORDER: ProviderId[] = [
  "gemini_free",
  "qwen_free",
  "mistral_free",
  "groq_free",
  "zai_free",
  "openai",
  "anthropic",
  "cloudflare_free",
];
export const providerLabel = (id: string) =>
  MODEL_PROVIDERS.find((p) => p.id === id)?.label || id;
export type ServerModel = {
  provider: ProviderId;
  model: string;
  project_ref: string;
  key_configured: boolean;
};
