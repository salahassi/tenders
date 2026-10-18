# Model providers and routing

TenderDesk uses configured credentials and Owner-selected model names. Billing confirmation, free-tier metadata and `APP_MODEL_*_FREE_ONLY` are not runtime prerequisites; the worker no longer reads those secrets. Legacy `_free` provider IDs and billing columns remain for compatibility, not pricing enforcement. Vendor billing and quota are controlled by the configured account; the application does not inspect them.

## Provider configuration

| Provider id | Console | Backend secrets | Workspace `project_ref` |
|-------------|---------|-----------------|-------------------------|
| `gemini_free` | [Google AI Studio](https://aistudio.google.com/) | `APP_MODEL_GEMINI_NAME`, `APP_MODEL_GEMINI_PROJECT`, `APP_MODEL_GEMINI_KEY` | Google Cloud project id |
| `qwen_free` | [Alibaba Model Studio](https://www.alibabacloud.com/) Singapore | `APP_MODEL_QWEN_NAME`, `APP_MODEL_QWEN_PROJECT`, `APP_MODEL_QWEN_KEY` | Singapore workspace id |
| `groq_free` *(optional)* | [Groq Console](https://console.groq.com/) | `APP_MODEL_GROQ_NAME`, `APP_MODEL_GROQ_PROJECT`, `APP_MODEL_GROQ_KEY` | Account label |
| `mistral_free` *(optional)* | [Mistral Console](https://console.mistral.ai/) | `APP_MODEL_MISTRAL_NAME`, `APP_MODEL_MISTRAL_PROJECT`, `APP_MODEL_MISTRAL_KEY` | Account label |
| `zai_free` *(optional)* | [z.ai](https://z.ai/) | `APP_MODEL_ZAI_NAME`, `APP_MODEL_ZAI_PROJECT`, `APP_MODEL_ZAI_KEY` | Account label |
| `cloudflare_free` *(optional)* | [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/) | `APP_MODEL_CLOUDFLARE_NAME`, `APP_MODEL_CLOUDFLARE_PROJECT`, `APP_MODEL_CLOUDFLARE_KEY` | Cloudflare **account ID** (`project_ref`) |
| `openai` *(optional)* | [OpenAI Platform](https://platform.openai.com/) | `APP_MODEL_OPENAI_NAME`, `APP_MODEL_OPENAI_PROJECT`, `APP_MODEL_OPENAI_KEY` | Optional account label; defaults to `default` |
| `anthropic` *(optional)* | [Claude Console](https://console.anthropic.com/) | `APP_MODEL_CLAUDE_NAME`, `APP_MODEL_CLAUDE_PROJECT`, `APP_MODEL_CLAUDE_KEY` | Optional account label; defaults to `default` |

Legacy `APP_MODEL_PROVIDER`, `APP_MODEL_NAME`, `APP_MODEL_PROJECT` and `APP_MODEL_KEY` can still populate one slot. Server metadata exposes model/project and whether a key exists, never the key. No model name or account identity is invented. Model names are sent verbatim; there is no exact-name allowlist.

| Provider | Generation endpoint |
|----------|---------------------|
| `gemini_free` | Gemini Interactions API |
| `qwen_free` | Alibaba compatible-mode `chat/completions` |
| `groq_free` | `https://api.groq.com/openai/v1/chat/completions` |
| `mistral_free` | `https://api.mistral.ai/v1/chat/completions` |
| `zai_free` | `https://api.z.ai/api/paas/v4/chat/completions` |
| `cloudflare_free` | `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions` |
| `openai` | `https://api.openai.com/v1/responses` |
| `anthropic` | `https://api.anthropic.com/v1/messages` |

The z.ai adapter uses provider defaults for optional thinking and the standard JSON chat-completion endpoint. Changing a model name does not introduce a model-specific toggle. Qwen uses its Singapore workspace; Cloudflare requires its account ID. Groq, Mistral and z.ai project labels are local identity records.

## Automatic routing

Settings provides one ordered list of Gemini, Qwen, Mistral, Groq, z.ai, OpenAI, Claude and Cloudflare Workers AI with accessible Move up/Move down controls. Cloudflare uses the same automatic routing, targeted connection checks and activity logs as the other providers. The Owner saves the complete order and strategy through the revision-checked, audited `model.routing` command. Duplicate, unknown or missing providers are rejected, except that legacy five/seven-provider clients are normalized by appending the newly supported providers during publication. Older clients that only toggle routing preserve the saved order.

- **Priority** starts each new round with the first configured provider in the saved order. This is the default.
- **Round robin** rotates the starting position through that same saved order. Polling an existing background request preserves its identity and does not advance the rotation or round-attempt count.

Automatic routing can use configured server slots even if their manual profile switch is off. Missing credentials are recorded and skipped. Provider authentication, model availability, HTTP quota/network and invalid-output failures continue to the next candidate. An authorized valid result completes the task. All provider outcomes are retained for diagnosis.

If no candidate yields a valid result, the task records `MODEL_ROUND_EXHAUSTED` in `retry_wait`. The plan stays active; the UI says **Waiting for an available provider**, shows the actual round-attempt count and next attempt time, and retries with bounded exponential delay (one minute to one hour, honoring a bounded Retry-After). A recovered provider can complete the same task without a manual unblock. No fit assessment is fabricated during this wait.

Actual application daily ceilings and rate controls remain enforced across the pool and renew at midnight Asia/Riyadh. They are separate from vendor billing declarations. Unknown usage stays recorded conservatively and the same uncertain request is not blindly resent; another eligible provider may proceed. Known Gemini request IDs are retrieved instead of creating duplicates.

## Company evidence

The Owner can permit current and future enabled, verified, unexpired Company Knowledge files and notes for selected destinations. Each request checks the current exact hashes, workspace membership and explicit revocations. Turning off the policy stops policy-derived authorization. The real comparison receives company expertise, capabilities, projects and qualifications from those sources, together with the tender evidence. Classification includes complete eligible source text instead of silently limiting large company profiles to twelve keyword-selected excerpts; context limits are checked before sending.

Disabled, unverified, expired and style-only materials do not establish company qualifications. Explicit one-off approvals remain separate. The model must cite exact supplied evidence; absent proof remains unknown and fit ratings are not hardcoded.

A connection probe is a separate operational diagnostic with no company payload. It tests transport and credentials, never substitutes for an assessment or claims to verify billing.

## Manual profiles

With automatic routing disabled, enabled profiles use their existing `failover_rank`, saved model/account identity and proposal identity rules. Every supported provider accepts provider-managed quota without a billing attestation or fabricated balance/expiry. An explicitly configured verified budget still enforces its declared expiry and balance. Manual uncertain requests retain the existing reconciliation workflow.

## Diagnosis

| Error | Meaning |
| --- | --- |
| `PROVIDER_AUTH_FAILED` | Provider rejected credentials or account access. |
| `PROVIDER_MODEL_NOT_FOUND` | Configured model was not found. |
| `PROVIDER_REQUEST_INVALID` | Provider rejected the request shape. |
| `PROVIDER_QUOTA_WAIT` | Provider returned a quota response or an explicitly declared budget cannot cover the request. |
| `MODEL_NOT_CONFIGURED` | Credentials, model or account identity are missing/mismatched. |
| `MODEL_ROUND_EXHAUSTED` | No candidate returned a valid result; another round is scheduled. |
| `USAGE_REVIEW_REQUIRED` | An earlier uncertain request remains reserved for reconciliation. |

Never include secret values, raw provider bodies or company prompts in diagnostics. Hosted health, deployed source equality, local integration tests and browser acceptance are separate verification steps.
