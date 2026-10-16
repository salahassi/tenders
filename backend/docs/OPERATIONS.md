# Operating the connected trial

The application runs from GitHub Pages and stores authorized records and originals in the selected Supabase project. The repository checklist records whether a specific revision has been deployed. Building code locally does not configure the hosted scheduler or create an Owner account.

## Recorded activation state

At the October 15, 2026 20:58 UTC verification, the application and API/worker were published, but the private dispatcher was absent. The explicit-schema correction is saved and tested locally, not applied to the hosted project. Follow [DEPLOYMENT.md](DEPLOYMENT.md) and the current checklist before activating it. A published worker alone does not establish that jobs execute while the browser is closed.

## Background collection

An administrator deploys the migrations and worker, then invokes `public.configure_dispatcher(project_url, collection_hosts)` through a trusted database administration session. This function is unavailable to browser and service-role callers. It rotates the dispatcher credential in Vault and registers `tenderdesk-dispatch` once per minute. Do not print the credential. An empty host list safely disables external collection while allowing the worker to report its actual heartbeat.

Only add hostnames after checking the intended source and permitted collection method. The mandatory deployment allowlist is independent of the Owner's source configuration; both must allow a destination. The collector validates public IPv4 results before each request and redirect. The runtime does not pin a DNS result into fetch, so arbitrary user-controlled domains are not supported. Authentication walls, CAPTCHA, access prohibitions, and unsupported adapters require manual import. No bypass, proxy, or paid fallback is provided.

In Sources, configure the feed or link directory, record the access basis, and enable it. Changing its configuration pauses collection. Collect now queues a bounded job; it does not assert a successful collection. Jobs and source history show results, retry limits, or blockers. Unknown rate-limit reset times require review. A missing item in a later feed does not cancel the opportunity or change a business decision.

## Delayed processing and failures

The dashboard displays the last heartbeat and successful collection. A heartbeat older than ten minutes means processing is delayed; it does not identify the cause. Check the Supabase project status, cron run history, pg_net responses, and Edge Function logs without copying credentials or business documents into logs. If the project paused under its free plan, restore it through the provider's supported controls.

The queue holds one active job per workspace. A current lease token is required to finish. A canceled running request retains its lease until it returns or expires. Expired source jobs may retry within the four-attempt ceiling. Model requests with uncertain usage must retain reservations; do not blindly retry them or reset their counters. Model activation and its exact usage workflow are recorded in later implementation stages.

## File intake and evidence

Keep the upload screen open while parsing originals and sending their extracted text. Accepted original bytes and text are immutable. Review the extracted text against the original before confirming completeness; a filename or successful upload does not prove a scanned document was read. Attach a new original for a correction. Removing a current reference archives it and preserves earlier packages and review evidence. Storage remains private; download URLs expire after five minutes.

## Current activation dependencies

The actual Owner must set their own password and confirm the already designated email. No test account or synthetic workspace is created in the cloud. Live source URLs, reviewed collection permission, the chosen free model and backend credential, eligible company evidence, commercial rates, and labeled evaluation examples must come from the Owner. These dependencies do not prevent code and synthetic local workflow testing. No external messages, payments, purchases, or bid submissions are automated.

## Complete backup and clean-project restoration

In Workspace settings, the Owner can download a ZIP containing all supported business records, original uploaded files and registered exports. Auth users, access grants, invitations, credentials and scheduler secrets are excluded. Each metadata row and file has an exact SHA-256 entry. If records change during export, it stops and asks you to retry; pause processing and editing for a stable snapshot. Keep business backups privately, outside GitHub.

Restore only into an empty project running the same migration schema and with the real Owner already registered. Select the unmodified ZIP, wait for local verification, inspect its originals and metadata, and confirm eligibility. The browser verifies every listed hash before uploading. The server stages records/files, checks hashes and references independently, and commits all business rows in one transaction. Retry the same file to resume a temporary failure, or cancel the pending session. A canceled/expired session is eligible for staged-object cleanup.

Historical author IDs are workspace-scoped records, not accounts. Restoration preserves the documents, proposal history and financial amounts while pausing sources, canceling unfinished jobs, disabling models, revoking content authorizations and invalidating approval. Review company facts, templates, rates and extracted RFPs, regenerate from current evidence, and approve a new version before final use. Unknown model usage remains unknown until reconciled. Historical artifact bytes remain available to the Owner through complete backup even though they are not authorized for new final export.

The bounded format allows 128 MiB of metadata and 250 MiB of original/export bytes, with a 400 MiB archive limit. ZIP entries use STORE; recompressed or edited archives are rejected. Large operations need sufficient desktop browser memory. The target checks database staging capacity before accepting a restore. The older metadata-only JSON is not a complete backup.

Retention/purge and model-quality evaluation are tracked separately in the checklist.

## Free model activation

Configure **both** supported free providers when possible so the worker can fail over if one endpoint is unreachable or waiting on quota.

**Backend secrets (Supabase Edge, never in the repo or browser):**

- Gemini: `APP_MODEL_GEMINI_NAME`, `APP_MODEL_GEMINI_PROJECT`, `APP_MODEL_GEMINI_KEY`
- Qwen (Singapore free quota): `APP_MODEL_QWEN_NAME`, `APP_MODEL_QWEN_PROJECT`, `APP_MODEL_QWEN_KEY`
- Optional: `APP_MODEL_GROQ_*`, `APP_MODEL_MISTRAL_*`, `APP_MODEL_CLOUDFLARE_*` (account ID in `PROJECT` for Cloudflare)

Legacy `APP_MODEL_PROVIDER` + `APP_MODEL_NAME` + `APP_MODEL_PROJECT` + `APP_MODEL_KEY` still fill one slot for older setups.

In Workspace settings, enable and verify **each** provider row (exact model id, project/workspace id, quota expiry, billing attestation; Qwen also requires Free Quota Only). Authorize each content item **for each provider** that may process it. A profile without matching secrets is skipped at runtime; if none match, jobs remain blocked.

Additional free-tier vendors are catalogued in [FREE_MODEL_PROVIDERS.md](FREE_MODEL_PROVIDERS.md); only Gemini and Qwen have adapters today.

Provider requests are one call per persistent claim. Unknown delivery/usage retains the reservation; use the provider usage ledger and the Owner reconciliation control before retrying. Rejections retain conservative reserved totals. Actual usage beyond a reservation disables **that provider profile** until reviewed. Neither quota exhaustion nor malformed output permits a paid fallback. The application cannot independently inspect provider billing settings; verification is an explicit dated Owner attestation.

Provider adapter references checked October 15, 2026: Gemini Interactions API (`https://ai.google.dev/api/interactions-api`), structured output and countTokens documentation; Alibaba Cloud Model Studio free quota, OpenAI compatibility and structured-output documentation. Adapters must be re-verified before changing model families or API versions.

## Maintenance and deletion

The private worker checks hourly maintenance before claiming ordinary work. It emits version-keyed deadline reminders, expires uploads after 24 hours and stages object deletion. Cleanup processes at most five objects per invocation with 10-second per-object waits, 180-second leases and five attempts. Retries recheck live document, export and restore references. A timed-out delete can be retried safely; quota is not freed until Storage returns success.

The dashboard reports the actual server heartbeat. More than ten minutes without one means background processing is delayed. Check project pause state, scheduled dispatcher, Vault configuration and worker logs before retrying jobs. A missing heartbeat alone does not identify the cause.

Settings provides reversible opportunity archival and an Owner-only purge preview. Permanent purge requires a fresh preview, exact typed title, acknowledgement and reason after all live leases stop. This removes opportunity evidence, proposal versions, submission history and cached result copies. It preserves shared company/source records, minimal audit hashes and provider usage accounting, including unresolved usage, so deletion cannot reset budgets. Object deletion is tracked separately; its pending bytes count against capacity. No external messages are sent.
