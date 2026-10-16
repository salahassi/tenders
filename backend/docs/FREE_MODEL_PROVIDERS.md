# Free and free-tier model providers

TenderDesk runs **connected-only** with **no paid fallback**. The worker may use **multiple enabled free providers** in failover order when a call cannot reach the primary (network uncertainty, provider quota wait, or token-count failure on that endpoint).

## Active adapters (configure both for failover)

| Provider id | Console / region | Backend secrets (Supabase Edge) | Workspace settings |
|-------------|------------------|----------------------------------|--------------------|
| `gemini_free` | [Google AI Studio](https://aistudio.google.com/) / Gemini API free tier | `APP_MODEL_GEMINI_NAME`, `APP_MODEL_GEMINI_PROJECT`, `APP_MODEL_GEMINI_KEY` | Exact model id, Google Cloud project id, verified quota expiry, billing attestation |
| `qwen_free` | [Alibaba Model Studio](https://www.alibabacloud.com/) Singapore, **Free Quota Only** | `APP_MODEL_QWEN_NAME`, `APP_MODEL_QWEN_PROJECT`, `APP_MODEL_QWEN_KEY` | Exact model id, workspace id, free-quota attestation |

Legacy single-slot secrets (`APP_MODEL_PROVIDER`, `APP_MODEL_NAME`, `APP_MODEL_PROJECT`, `APP_MODEL_KEY`) still populate **one** provider slot for existing deployments; prefer the per-provider names above.

Enable **both** rows in Settings, store **both** secret sets in the backend, and authorize content **per provider**. Failover tries lower `failover_rank` first (default: Gemini 1, Qwen 2).

## Documented free-tier options (no adapter yet)

These are **not** wired in the product until an adapter, policy review, and Owner attestation flow exist. They are listed so you can compare quotas before asking for a future stage.

| Vendor | Typical free access | Structured JSON / notes | Fit for TenderDesk |
|--------|---------------------|-------------------------|-------------------|
| [Groq](https://console.groq.com/) | Free tier with rate limits on select open models | OpenAI-compatible chat; JSON mode varies by model | Possible future `groq_free` adapter; verify data-processing terms |
| [Mistral La Plateforme](https://console.mistral.ai/) | Limited free credits / experimentation tier | Chat + JSON schema on some models | Possible `mistral_free`; EU hosting may matter for data residency |
| [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) | Free daily neurons on Workers | Limited models; schema support varies | Possible `cloudflare_free` if egress from Supabase Edge is acceptable |
| [Hugging Face Inference](https://huggingface.co/inference-api) | Free tier with caps | Model-dependent; often weaker JSON guarantees | Only with strict output validation already in TenderDesk |
| [Cohere trial](https://cohere.com/) | Trial credits (not ongoing free) | Chat API | **Not** recommended as “free-only” |
| [OpenRouter](https://openrouter.ai/) | Mostly paid; occasional promos | Router, not a single free policy | **Out of scope** for free-only policy |

Adapters must be re-verified against vendor docs before enablement. TenderDesk will not auto-upgrade any call to a paid model.

## Failover behavior (runtime)

For each generation step the worker:

1. Loads enabled provider profiles from `model_settings` (ordered by `failover_rank`).
2. Skips a profile when workspace attestation, quota expiry, or backend secrets do not match that profile.
3. On `MODEL_NETWORK_UNCERTAIN`, `PROVIDER_QUOTA_WAIT`, or `TOKEN_COUNT_UNAVAILABLE`, settles or abandons the attempt and tries the next enabled profile.
4. Does **not** failover on validation, policy, or authorization errors (same prompt on another provider would not fix those).

Unknown usage after a failed delivery still blocks further calls until Owner reconciliation, per provider ledger rules.
