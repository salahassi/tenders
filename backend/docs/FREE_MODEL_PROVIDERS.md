# Free and free-tier model providers

TenderDesk runs **connected-only** with **no paid fallback**. The worker uses **enabled** free provider profiles in `failover_rank` order and switches when a call cannot complete on the current endpoint (network uncertainty, provider quota wait, or token-count failure on that endpoint).

## Active adapters

| Provider id | Console | Backend secrets | Workspace `project_ref` |
|-------------|---------|-----------------|-------------------------|
| `gemini_free` | [Google AI Studio](https://aistudio.google.com/) | `APP_MODEL_GEMINI_NAME`, `APP_MODEL_GEMINI_PROJECT`, `APP_MODEL_GEMINI_KEY` | Google Cloud project id |
| `qwen_free` | [Alibaba Model Studio](https://www.alibabacloud.com/) Singapore, **Free Quota Only** | `APP_MODEL_QWEN_NAME`, `APP_MODEL_QWEN_PROJECT`, `APP_MODEL_QWEN_KEY` | Singapore workspace id |
| `groq_free` *(optional)* | [Groq Console](https://console.groq.com/) | `APP_MODEL_GROQ_NAME`, `APP_MODEL_GROQ_PROJECT`, `APP_MODEL_GROQ_KEY` | Owner-verified account label |
| `mistral_free` *(optional)* | [Mistral Console](https://console.mistral.ai/) | `APP_MODEL_MISTRAL_NAME`, `APP_MODEL_MISTRAL_PROJECT`, `APP_MODEL_MISTRAL_KEY` | Owner-verified account label |
| `cloudflare_free` *(optional)* | [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) | `APP_MODEL_CLOUDFLARE_NAME`, `APP_MODEL_CLOUDFLARE_PROJECT`, `APP_MODEL_CLOUDFLARE_KEY` | Cloudflare **account ID** (`project_ref`) |

Legacy `APP_MODEL_PROVIDER` + `APP_MODEL_NAME` + `APP_MODEL_PROJECT` + `APP_MODEL_KEY` still fill **one** slot for older deployments.

Default failover ranks: Gemini 1, Qwen 2, Groq 3, Mistral 4, Cloudflare 5. Only **enabled** rows with matching secrets participate; optional providers can stay disabled.

Authorize each content item **per provider** that may process it.

### API endpoints (adapters)

| Provider | Generation endpoint |
|----------|---------------------|
| `gemini_free` | Gemini Interactions API |
| `qwen_free` | Alibaba compatible-mode `chat/completions` |
| `groq_free` | `https://api.groq.com/openai/v1/chat/completions` |
| `mistral_free` | `https://api.mistral.ai/v1/chat/completions` |
| `cloudflare_free` | `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions` |

Structured output uses OpenAI-style `response_format: { type: "json_object" }` where supported; TenderDesk still validates JSON against the task schema.

## Other free-tier options (not wired)

| Vendor | Notes |
|--------|--------|
| [Hugging Face Inference](https://huggingface.co/inference-api) | Model-dependent JSON; weaker guarantees |
| [Cohere trial](https://cohere.com/) | Trial credits, not ongoing free-only |
| [OpenRouter](https://openrouter.ai/) | Out of scope (paid router) |

## Failover behavior (runtime)

1. Load enabled profiles from `model_settings` ordered by `failover_rank`.
2. Skip profiles that fail attestation, quota expiry, or secret mismatch.
3. Fail over on `MODEL_NETWORK_UNCERTAIN`, `PROVIDER_QUOTA_WAIT`, or `TOKEN_COUNT_UNAVAILABLE`.
4. Do **not** fail over on validation, policy, or authorization errors.

Unknown usage still blocks further calls until Owner reconciliation.
