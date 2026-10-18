# Free and free-tier model providers

TenderDesk runs **connected-only** with **no paid fallback**. Automatic round robin reads configured free provider slots directly from secrets; manual mode uses verified, **enabled** profiles in `failover_rank` order. Gemini can be configured on its own; an unused Qwen or optional provider does not need a policy or credentials.

Google's [model catalog](https://ai.google.dev/gemini-api/docs/models) and [Interactions API guide](https://ai.google.dev/gemini-api/docs/interactions), checked October 17, 2026, list Gemini 3.8 Flash as `gemini-3.8-flash`. Keep that exact identifier in both the backend secret and workspace policy. This verifies the identifier, not access or free quota for a particular account.

## Active adapters

| Provider id | Console | Backend secrets | Workspace `project_ref` |
|-------------|---------|-----------------|-------------------------|
| `gemini_free` | [Google AI Studio](https://aistudio.google.com/) | `APP_MODEL_GEMINI_NAME`, `APP_MODEL_GEMINI_PROJECT`, `APP_MODEL_GEMINI_KEY` | Google Cloud project id |
| `qwen_free` | [Alibaba Model Studio](https://www.alibabacloud.com/) Singapore, **Free Quota Only** | `APP_MODEL_QWEN_NAME`, `APP_MODEL_QWEN_PROJECT`, `APP_MODEL_QWEN_KEY` | Singapore workspace id |
| `groq_free` *(optional)* | [Groq Console](https://console.groq.com/) | `APP_MODEL_GROQ_NAME`, `APP_MODEL_GROQ_PROJECT`, `APP_MODEL_GROQ_KEY` | Owner-verified account label |
| `mistral_free` *(optional)* | [Mistral Console](https://console.mistral.ai/) | `APP_MODEL_MISTRAL_NAME`, `APP_MODEL_MISTRAL_PROJECT`, `APP_MODEL_MISTRAL_KEY` | Owner-verified account label |
| `zai_free` *(optional)* | [z.ai](https://z.ai/) | `APP_MODEL_ZAI_NAME`, `APP_MODEL_ZAI_PROJECT`, `APP_MODEL_ZAI_KEY` | Owner-verified account label |
| `cloudflare_free` *(optional)* | [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) | `APP_MODEL_CLOUDFLARE_NAME`, `APP_MODEL_CLOUDFLARE_PROJECT`, `APP_MODEL_CLOUDFLARE_KEY` | Cloudflare **account ID** (`project_ref`) |

Legacy `APP_MODEL_PROVIDER` + `APP_MODEL_NAME` + `APP_MODEL_PROJECT` + `APP_MODEL_KEY` still fill **one** slot for older deployments.

Default failover ranks: Gemini 1, Qwen 2, Groq 3, Mistral 4, Cloudflare 5, z.ai 6. In manual mode, only **enabled** rows with matching secrets participate; optional providers can stay disabled.

Authorize each content item **per provider** that may process it.

### API endpoints (adapters)

| Provider | Generation endpoint |
|----------|---------------------|
| `gemini_free` | Gemini Interactions API |
| `qwen_free` | Alibaba compatible-mode `chat/completions` |
| `groq_free` | `https://api.groq.com/openai/v1/chat/completions` |
| `mistral_free` | `https://api.mistral.ai/v1/chat/completions` |
| `zai_free` | `https://api.z.ai/api/paas/v4/chat/completions` |
| `cloudflare_free` | `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions` |

Model identifiers always come from the Owner’s `_NAME` secret and are sent verbatim. No exact model allowlist is maintained. The z.ai adapter uses the standard API endpoint with provider defaults for optional thinking; it does not choose capabilities based on a model-name allowlist. Official [API](https://docs.z.ai/api-reference/llm/chat-completion.md) and [pricing](https://docs.z.ai/guides/overview/pricing.md) were checked October 18, 2026; GLM-4.7-Flash is listed free, but the Owner controls the selected model and confirms its free billing status.

Structured output uses OpenAI-style `response_format: { type: "json_object" }` where supported; TenderDesk still validates JSON against the task schema.

## Other free-tier options (not wired)

| Vendor | Notes |
|--------|--------|
| [Hugging Face Inference](https://huggingface.co/inference-api) | Model-dependent JSON; weaker guarantees |
| [Cohere trial](https://cohere.com/) | Trial credits, not ongoing free-only |
| [OpenRouter](https://openrouter.ai/) | Out of scope (paid router) |

## Automatic round robin

When enabled, Gemini → Qwen → Mistral → Groq → z.ai rotates its starting provider globally. Configured credentials, model and account identity plus `_FREE_ONLY=true` (or a saved Owner-attested free-only profile) make a slot eligible without a separate enable switch. Missing slots are skipped with a visible reason. Model name changes in the same attested account apply to new requests automatically; saved remote requests keep their identity. Provider errors move to alternatives, while unknown usage remains reserved and is never blindly resent to that provider. Daily application ceilings are shared across the pool.

Each provider still needs exact-content consent; public collector permission and Company Knowledge permission are distinct. Groq/z.ai can use provider-managed quotas like Gemini with null expiry/balance, keeping actual provider rate limits and app budgets.

## Manual failover behavior (runtime)

1. Load enabled profiles from `model_settings` ordered by `failover_rank`.
2. Skip profiles that fail attestation, quota expiry, or secret mismatch.
3. Before reserving generation, try the next profile if token counting is unavailable or the provider quota is exhausted. After an explicit HTTP 429 generation rejection, the worker may reserve a different provider for the same job. All attempts still count against conservative daily limits.
4. A timeout, disconnected response, or server error during generation can have consumed tokens. Retain unknown usage and stop; the Owner must reconcile it before another generation. Do **not** fail over on validation, policy, or authorization errors.
5. A proposal can select another provider after its initial explicit rejection. Once a reservation has measured usage or uncertain delivery, its provider/model/project identity stays pinned for subsequent proposal steps.

Unknown usage still blocks further calls until Owner reconciliation.

## Continuous Gemini free tier

The Owner confirmed the configured Gemini project is on the free tier and requested continuous operation. New Gemini policies use `quota_mode=provider_managed`, with `quota_ends_at` and `quota_remaining_tokens` null. Those nulls mean unknown/provider-enforced limits, not unlimited or verified token credit. An Owner confirms free-tier billing and saves the matching identity; no Google account login or manual renewal date is required. Existing verified budgets and other providers retain their expiry rules.

Application limits still renew at midnight Asia/Riyadh. An explicit provider 429 waits and retries the same durable task, with Retry-After bounded to 1 minute–1 day or exponential 1 minute–1 hour waits when absent. Uncertain post-send usage blocks automatic resend. A connection check is an operational job using the same ledger and worker, capped at 256 output tokens, with no customer content or fake business records. Its result is visible in Activity & jobs.

## Activation and diagnosis

Owner settings now read `GET /v1/model-environment` to prefill the model and project when no workspace policy exists. The authenticated route requires actual Owner membership and returns only provider/model/project and `key_configured`; it never returns keys, changes configuration, calls a provider, or claims to verify billing/quota. Existing policies are preserved and mismatches are shown. Untouched optional slots remain unsaved and disabled. Google console login is not required for this check; an Owner may supply verified free-tier/quota facts without giving the assistant Google account access.

The three Gemini secrets must exist in **Supabase Edge Function Secrets**, and the matching workspace policy must have Owner-confirmed free-tier billing. Gemini provider-managed mode does not require a manual free quota or expiry. The provider-pool migrations (`20261016120000`, `20261016130000`, and `20261016220000`) and current `api`/`worker` functions must be deployed. Adding secrets alone does not apply migrations, enable a workspace policy, approve content, or activate the dispatcher. Keep other providers disabled unless separately verified.

| Error | Meaning and next action |
| --- | --- |
| `PROVIDER_AUTH_FAILED` | Google returned HTTP 401 or 403. Verify the key, project access, and applicable API restrictions in the provider console. |
| `PROVIDER_MODEL_NOT_FOUND` | The provider returned HTTP 404. Verify the exact model identifier and account availability. |
| `PROVIDER_REQUEST_INVALID` | The provider returned HTTP 400. Check the deployed adapter's request against the current API contract. |
| `PROVIDER_QUOTA_WAIT` | The provider returned HTTP 429 or the verified local quota cannot cover the reservation. Check quota and retry timing. |
| `MODEL_NOT_CONFIGURED` | No usable enabled policy matches the backend credentials. Check all three secret names and the workspace policy. |
| `MODEL_NETWORK_UNCERTAIN` / `USAGE_REVIEW_REQUIRED` | Delivery or usage could not be established. Reconcile the existing reservation before retrying. |

`GET /functions/v1/api/v1/health` should return HTTP 200 without an account. A platform HTTP 503 `BOOT_ERROR` occurs before application routing and before Gemini processing. It requires the Edge Function startup log and a verified deployment; it is not evidence that a Gemini key or model was rejected. Never include secret values or raw provider response bodies in diagnostics.
