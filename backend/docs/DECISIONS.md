# Decisions

## 2026-10-17: Owner-requested automatic round robin

- The Owner explicitly requested Gemini → Qwen → Mistral → Groq failover even without individual provider activation. A separate audited Owner switch authorizes this mode; disabling it restores the prior manual-policy path. The cursor persists across jobs and rotates again after an exhausted round.
- The worker prepares effective policies from existing server metadata. API keys are never sent to the database. Inactive or absent individual policies do not prevent use of a configured provider. Account free-only confirmation must come from a saved policy or the corresponding `APP_MODEL_<PROVIDER>_FREE_ONLY=true` server setting; key presence alone is not a billing attestation. Qwen still requires its provider-side Free Quota Only setting. Unknown balances remain unknown.
- Each round visits at most four providers. Missing metadata and provider errors are recorded. Automatic mode can move to a different provider after uncertain delivery while retaining all unknown usage and reserved tokens. It never resends an ambiguous same-job/input request to that same provider. A pending recorded Gemini request is retrieved first; a failed retrieval can now fail over. Exhausted rounds retry with finite backoff, and workspace daily limits remain global across providers.
- Exact content hashes and per-provider authorization remain mandatory. Provider/model identity is recorded on each usage reservation, allowing a generation plan to span providers in automatic mode. Legacy manual plans retain identity pinning. Successful results still pass the same evidence/schema validation.
- Automatic routing is operational configuration, excluded from portable business backups and disabled when a restore commits. No paid account, top-up, new credential or external subscription is created by this feature.

Provider references checked October 17, 2026: https://www.alibabacloud.com/help/en/model-studio/new-free-quota, https://console.groq.com/docs/rate-limits and https://docs.mistral.ai/admin/billing-usage/usage-limits.

## 2026-10-17: Durable Gemini background execution

- Real synchronous Gemini requests exceeded the 90-second worker HTTP budget over both Interactions and generateContent. Gemini 3.8 also explicitly rejects `minimal` thinking; operational checks use the supported `low` setting.
- Production Gemini tasks use Interactions background execution with the documented `Api-Revision: 2026-05-20`, `background=true`, `store=true`, no tools, and the existing exact content permissions/output caps. The dedicated background guide documents `store=false` retrieval, but the general Interactions guide requires storage and the first such hosted request was rejected. Use explicit storage and DELETE only after the validated application result commits. If cleanup fails, Google project retention applies; application retrieval expires after 23 hours. Initial requests without a recorded ID still remain unknown and are never automatically resubmitted.
- A saved provider ID permits GET-only continuation after deferral, a lost read response, quota rejection on retrieval, or a worker lease expiry. Polls reuse one generation reservation and do not increment generation call budgets. Cancellation stops application continuation and retains unmeasured consumption conservatively; it does not assert that Google stopped an already accepted computation.
- Independent continuous requests remain possible alongside prior unknown usage. Same-job/hash protections and conservative budget accounting remain. The application never invents measured tokens to unblock work.

Sources: https://ai.google.dev/gemini-api/docs/background-execution and https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash.

## 2026-10-17: Continuous Gemini free tier

- The Owner confirmed the configured Gemini 3.8 Flash project is on the free tier and explicitly requested continuous operation without supplying manual quota balances or expiry dates. This supersedes the earlier requirement to obtain console quota/renewal facts before activation. No additional Google login or general activation permission is required.
- New Gemini policies can use `provider_managed` quota mode: the project free-tier attestation is retained, provider quota fields are null, and the policy does not expire automatically after 30 days. Existing verified-budget policies and other providers retain their rules.
- Provider 429 responses preserve queued work and retry automatically, using bounded Retry-After or exponential waits capped at one hour when missing. Daily application limits remain 50 calls, 250,000 input tokens and 50,000 output tokens, renewing at midnight Asia/Riyadh. A free tier is not a promise of uninterrupted provider availability.
- An uncertain request remains blocked by job and input hash, and its full reservation remains charged to the application day. Independent jobs for the same provider-managed Gemini model may proceed within daily caps; pending reservations still serialize all requests. Other policies retain the workspace-wide unknown-usage guard. No paid fallback or billing change is introduced. Operational model probes use the existing authenticated queue, quota ledger and worker with a bounded fixed connection-check prompt; they create no fake opportunities or customer evidence.

## 2026-10-14: Backend activation

- Keep the existing React/Vite application and the same user-owned GitHub repository. Do not move existing frontend files merely to match a proposed directory layout.
- Implement the backend in `supabase/functions` and schema authority in `supabase/migrations`, matching the specification's Supabase Edge Functions/PostgreSQL/private Storage architecture.
- Preserve the existing GitHub Pages demo deployment. The historical Cloudflare Pages preference does not require migrating a working frontend as part of backend setup. A connected build requires explicit browser-safe Supabase configuration and authenticated membership.
- Preserve subsequent interface decisions: no upload classification selector, no manual starter outline, comments and attachments belong to each section/question, and one regeneration request includes all inputs. These decisions supersede the historical screen/outline prescriptions.
- Defer AI-provider activation and provider-specific data eligibility decisions until the user discusses the model. No default model from the historical specification is silently activated or asserted to be currently available.
- Do not enable billing or paid fallbacks. Provider limits are verified from current official documentation before activation.
- Supabase Free currently documents 500 MB database, 1 GB Storage, 500,000 Edge Function invocations, and possible pausing after inactivity. Application caps remain lower than the service caps. The free tier is a pilot environment, not an availability commitment.
- The installed Supabase integration must expose actual project-management tools before cloud actions are claimed. An installed integration alone is not evidence of project access or a completed deployment.

Sources checked: https://supabase.com/pricing and https://supabase.com/docs/guides/functions/limits.

## 2026-10-14: Account discovery and upload verification

- Connected Supabase account discovery succeeded and the target organization was verified as Free. The owner instructed creation of a new project named Tenderdesk. The existing inactive project is for a different application and is not the destination.
- Project creation is blocked in the integration because `get_cost` and `confirm_cost` are not returned by the connected server's tool inventory. Repeating the cost lookup twice did not resolve this. The user is creating the project through the Dashboard; rediscover its reference before migrations or deployment.
- Reconciled the complete-upload API with the SQL function's idempotency parameter. Completion now passes the HTTP key, checks original bytes, rechecks active membership and allowlisted identity while holding the workspace lock, and rejects a changed replay. Added direct HTTP and SQL tests for this behavior.
- Populated CLI-created migration files in dependency order. Local policy tests discover the committed migration files rather than maintaining a separate hardcoded filename list.
- Use the current platform-provided key maps, with legacy compatibility. Revalidated the Supabase changelog and API-key documentation before this change.

Sources: https://supabase.com/changelog.md and https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys.

## 2026-10-14: Hosted foundation deployed

- The user-created TenderDesk project is healthy in the verified Free organization, in Mumbai (`ap-south-1`). Four migrations and two functions are deployed. Local migration versions were aligned with the actual hosted history.
- Moved the guarded transactional command routine to the unexposed private schema and retained a caller-executed public RPC wrapper. Membership reads execute as the caller. Revoked browser execution of the fresh platform's public RLS event-trigger helper. All existing role/idempotency tests remain the verification authority.
- Verified hosted RLS on 17 application tables, a private Storage bucket, denied anonymous command/bootstrap privileges, minimal health 200 and unauthenticated API/worker 401. Security advisors returned no findings after hardening. No Owner was invented, no model was called, and no scheduler was represented as configured.
- Authenticated Owner bootstrap, connected frontend commands and cron remain incomplete activation steps. Publishing local source changes to public `salahassi/tenders` / `main` was rejected twice by automatic approval review, including after verifying account ownership and repository permissions. Ask for explicit publication authorization; do not route around the rejection through another upload method.

## 2026-10-14: Separate frontend and backend folders

- The owner explicitly requested moving the existing interface into `frontend/` and the new backend source into `backend/` in the same GitHub repository. This supersedes the earlier choice to retain a flat root layout.
- Preserved all 66 existing interface source/configuration/asset files byte-for-byte during the move; only the frontend package and TypeScript scope needed configuration changes. UI behavior and the existing Pages URL are retained.
- Both folders have independent pinned package manifests and lockfiles. Backend-only CLI and PostgreSQL test dependencies belong in the backend package.
- GitHub Actions remains at the repository root, checks both packages, and uploads only `frontend/dist` for Pages. Supabase code, migrations and relative imports stay together under `backend/`; moving their source does not replace or reconfigure the deployed services.
- The frontend handoff is at `frontend/docs/FRONTEND_HANDOFF.md`; the original implementation specification and backend evidence are at `backend/docs/`.

## 2026-10-14: Publication verified

- The owner explicitly approved publishing the reorganized source to public `salahassi/tenders` / `main`. Used the already authenticated GitHub connector after the local HTTPS Git client lacked a saved credential; no credential was requested from the owner or put in source.
- GitHub's `main` branch and recursive tree confirmed all 104 tracked files, including 71 frontend files and 29 backend files, with blob hashes matching the local source. Original local implementation commits were retained on a local backup branch when synchronizing the identical published source tree.
- Both independent lockfile installs, TypeScript checks and builds passed. All 96 frontend and 19 backend tests passed. GitHub Pages workflow 38605686546 completed successfully and deployed the frontend from `frontend/dist`.
- Publishing source and relocating files do not activate remote UI persistence, Owner membership, scheduler credentials or an AI model. Those activation boundaries remain visible.

## 2026-10-14: Specification review and continuation plan

- Re-read the full specification and later frontend handoff against source and hosted state. The owner requested a staged continuation plan, frequent updates, and explicit integration tests.
- Confirmed the client helper is not used by the application store. Hosted Auth users, workspaces, memberships, and jobs all remain zero; scheduler extensions are absent.
- Replaced the stale checklist with milestone gaps, all 30 acceptance dispositions, and seven ordered stages. Start with identity/connected core records; then files/review inputs, collection/scheduling, owner-agreed model integration, analysis/generation, export/recovery, and full-trial verification.
- Added five SQL integration tests for worker privileges, single-active-job enforcement, lease validity/replay, expiry/checkpoint preservation, and cancellation. All 24 backend tests and type checking passed locally. These do not establish hosted authentication, Storage behavior, or separate-connection concurrency.
- Preserve the approved layout, public repository, Pages hosting, and simplified review interface. Actual Owner sign-in and model activation are later dependencies; independent implementation does not wait for them.

## 2026-10-14: Email-only invitations and implementation checkpoint

- The owner finalized email/password with invitations as the sole sign-in method. Google, Apple, Facebook, and GitHub login are not to be activated.
- The working tree includes email login/recovery, connected core-record commands, Owner invitation/member administration, and a restricted first-Owner setup path. Its latest full local run passed 111 frontend and 37 backend tests, including 25 integration/database cases. These are not hosted-account or email-delivery results.
- The owner then requested pausing implementation and deployment to reconcile the plan. No further feature work or cloud mutation is authorized by this planning checkpoint itself. The active task is to resume the existing seven-stage plan when the owner resumes execution.
- Hosted Supabase still has only the four baseline migrations and zero users/workspaces/memberships/jobs. The interrupted migration call was not a successful deployment; the subsequent migration listing confirmed no new migration. Published main remains 8a5912c.
- Stage 1 remains open. Before deployment, consolidate the two pending files with migration version 20261014180222 into the email-only version and validate migration-version uniqueness. Stage 2 file/review writes, collection, model execution, generation, connected export/submission, and full recovery remain separate unfinished work.
- Use IMPLEMENTATION_CHECKLIST.md as the current checkpoint and continuation authority; older deployment/handoff descriptions are historical until reconciled in the stage 1 release.

## 2026-10-14: Resume publication and require continuous checklist maintenance

- The owner explicitly resumed deployment to Supabase, the public GitHub repository, and GitHub Pages. This supersedes the preceding pause; the seven-stage plan and email/password-only decision remain in force.
- Keep IMPLEMENTATION_CHECKLIST.md in the project and update it for every future project change. AGENTS.md and the root README now require the affected stage, local verification, deployment evidence, and remaining work to be recorded together with the change.
- Removed the superseded social-identity migration, consolidated database fixtures, and added unique migration-version validation. The pilot cap of five active users is enforced under the workspace lock on invitation acceptance and membership reactivation.
- Publishing the connected stage-1 code does not close its real-account, email/callback, hosted persistence, or desktop/mobile acceptance gates. No Owner identity or recipient is guessed, and no invitation email is sent by this deployment.

- Release verification passed 111 frontend and 38 backend tests (26 database/integration cases included), both locked installs, type checks, and builds.
- The Supabase connector returned `Migration was declined` for `connected_workspace_commands` without a stated reason. A fresh migration listing still shows only the four baseline migrations; api v2 and worker v1 remain active. The dependent API deployment is withheld. No alternate mutation channel is used to bypass the refusal. GitHub source and Pages publication continue with this limitation recorded.

- Read-only plugin permission inspection shows Supabase inherits “Allow low-risk actions”; it can automatically deny operations. The refusal itself gives no specific reason or confirmation-button location. Spoken authorization is valid user intent, and no additional written authorization is inherently required. No plugin permission was changed.
- Published application commit `99e40cf4a958e5aba73c5dd1f158f58d0e028ab8`; all 119 remote blobs matched the verified source. Pages workflow `38617159700` is the deployment evidence for this application revision. The documentation follow-up records its final outcome without rebuilding the app.

- Pages workflow `38617159700` completed successfully on October 14, 2026 at 18:41 UTC (21:41 Riyadh). This confirms frontend publication, not completion of the blocked database/API activation or real-account acceptance.

## 2026-10-15: Connected-only application and resumed hosted activation

- The owner explicitly retired demo access and all sample UI/data while continuing the seven-stage plan. This supersedes earlier instructions to preserve the browser-local demo. Do not restore a mode query bypass, sample seeding, canned assessment/pricing evidence, role preview, or local reset/restore. Synthetic data remains confined to automated tests; existing user browser data is neither imported nor erased.
- The same Supabase migration connector accepted all four pending migrations after the owner's renewed continuation instruction. No permissions were changed and no denied channel was bypassed. Hosted migration names and versions are recorded in the checklist and mirrored by repository filenames. API v3 is active; worker v1 remains unchanged.
- Hosted health returned 200; unauthenticated bootstrap returned 401; an invalid invitation returned 422. Privileged Owner setup remains unavailable to browser database roles. Real first-Owner email selection and account/email/callback acceptance remain pending.

- Connected-only application `d7f90c947bb50ddcef8fcf251176c11a1a07ca85` published successfully through Pages run `38650846765`. All 100 frontend and 38 backend tests passed locally and in the publication workflow. The deployed desktop login has no demo option; the legacy demo URL opens sign-in; recovery/back navigation works. Real account/email and mobile acceptance remain pending. This documentation-only follow-up records the completed release.

October 18, 2026 — The Owner requires comparisons to receive the company expertise and supporting details from Company Knowledge files and notes, including future additions. A saved continuing policy replaces repeated item-by-item approval for enabled, verified company evidence sent to selected providers. Source quotations, explicit exclusions and verification status remain authoritative. Free billing confirmations belong in workspace settings; FREE_ONLY is an optional legacy deployment flag and does not inspect provider billing. The Owner already confirmed Gemini, Groq and z.ai free accounts.

October 18 follow-up: the Owner explicitly removed application billing-attestation prerequisites. Configured providers participate without FREE_ONLY secrets or free-account confirmation. The Owner requested configurable provider order, fixed priority plus optional rotation, and then clarified that exhaustion should wait/retry automatically instead of becoming permanently blocked. Display round attempts and the next scheduled retry; background polling does not count as a new round. Continuing Company Knowledge permission still covers relevant future verified files/notes. This supersedes earlier free-only activation prescriptions, including the immediately preceding saved-confirmation design.

October 19, 2026 — The Owner requires autonomous polling, immediate assessment scheduling, provider rotation/failover and retry recovery. Automatic routing no longer uses application daily call/token ceilings, token-count API calls, profile token-overrun gates or permanent unknown-usage holds. Actual usage remains audit telemetry; valid output can complete with unreported usage. An ambiguous same-provider request waits at least 15 minutes (and until an accepted remote request deadline) before a fresh round; known remote IDs retain GET continuation. Four failed recovery attempts trigger one alert, followed by hourly retries. Authorization, configured source approval and evidence validation are not bypassed. Manual routing retains its legacy policies.

The Owner selected generic SMTP (using Resend credentials), confirmed APP_SMTP_* Secrets are configured, and requested automatic failure emails and periodic review reminders. Per-user preferences control email, failure alerts, review reminders, interval (6/12/24/48/168 hours) and language. Only active members with verified account email can receive a message. SMTP credentials stay on the server; no provider-specific email API is required. Explicit temporary SMTP rejections retry up to five times; ambiguous acceptance remains visible as delivery_unknown to prevent an unconfirmed duplicate. SMTP acceptance is distinct from inbox delivery.


## October 19, 2026 — source definitions belong to seed data and the database

The Owner requires seeded sources read from the database without hardcoded runtime definitions. Source URLs, buyers, timezones, selectors and field labels now live in the official catalog's optional extraction profiles and in each source's adapter configuration. Generic table/link/card parsing replaces named institutional branches. The frontend derives country options from saved rows and edits a saved profile rather than selecting a fixed institution. Seed replay preserves user changes; explicit missing-profile backfill checks the original URL and listing key, audits changes, and does not approve or enable sources. Generic parsers, schema validation, host permissions and bounded network access remain application logic.


## October 19, 2026 — actionable source activation prerequisites

Unconnected source records must explain why activation is unavailable and expose the path to connection settings. No missing action may imply that a saved directory link is already a working collector. Guidance uses stored source metadata to distinguish public listings, procurement platforms, central redirects and supplier-registration portals. Sources without an extraction profile must choose a collection method explicitly. Existing Owner authorization, connection prerequisites, revision checks and the five-enabled-source cap remain unchanged; the current blockage is missing integrations, not the cap.
