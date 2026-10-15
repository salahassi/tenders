# Operating the connected trial

The application runs from GitHub Pages and stores authorized records and originals in the selected Supabase project. The repository checklist records whether a specific revision has been deployed. Building code locally does not configure the hosted scheduler or create an Owner account.

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

Full original-inclusive backup, clean-target restore, retention/purge, and model-quality evaluation are tracked in stages 4–7. Do not treat the historical metadata-only JSON format as a complete backup.

## Free model activation

Model selection remains deferred. After the Owner chooses a provider, put `APP_MODEL_PROVIDER` (`gemini_free` or `qwen_free`), `APP_MODEL_NAME`, `APP_MODEL_PROJECT`, and `APP_MODEL_KEY` in the backend secret store. Never add credentials to repository files, the browser, or audit records. Match these exact non-secret identifiers in Workspace settings, verify billing and quota expiry, and authorize each exact content item after review. Qwen requires the Singapore workspace and effective Free Quota Only. A setting without matching server credentials remains blocked.

Provider requests are one call per persistent claim. Unknown delivery/usage retains the reservation; use the provider usage ledger and the Owner reconciliation control before retrying. Rejections retain conservative reserved totals. Actual usage beyond a reservation disables the model until reviewed. Neither quota exhaustion nor malformed output permits a paid fallback. The application cannot independently inspect provider billing settings; verification is an explicit dated Owner attestation.

Provider adapter references checked October 15, 2026: Gemini Interactions API (`https://ai.google.dev/api/interactions-api`), structured output and countTokens documentation; Alibaba Cloud Model Studio free quota, OpenAI compatibility and structured-output documentation. Adapters must be re-verified before changing model families or API versions.
