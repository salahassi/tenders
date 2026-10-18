# Backend deployment

## Scope and actual state

**Current checkpoint — October 17, 2026:** API **v14** and worker **v11** are ACTIVE from `a6056db95dff6d9463b0bb7b6150d9955ab17cd9`, with all 13 retained files in each matching source. Hosted history has **48 migration entries**; automatic Gemini/Qwen/Mistral/Groq routing is implemented and deployed. All 161 backend/133 frontend tests, both typechecks/builds and Deno checks passed. [Pages run 39070202922](https://github.com/salahassi/tenders/actions/runs/39070202922) passed, and the public index, Jobs and Settings bundles match the local build. Health/authentication boundaries and the active minute scheduler passed verification. Actual Owner activation persisted after reload; a real check completed through Gemini, recording all three alternatives as missing configuration. A forward cursor correction is also deployed; final browser result/reload verification passed. Earlier verified Gemini inference and historical deployments follow. The 35 official sources still require collection adapters; no business opportunity or document has been fabricated.

**Verified October 15, 2026:** 22 hosted migrations, API v4 and worker v2; Pages application `d450c8c` passed [run 38807118314](https://github.com/salahassi/tenders/actions/runs/38807118314), completed October 15 at 21:06 UTC. One actual confirmed Auth identity exists, with restricted Owner setup pending and no workspace at the 20:58 UTC read. The hosted dispatcher is not configured. Its explicit-schema correction is saved in `20261015220000_dispatcher_extension_schema.sql` and passed local migration/tests, but two connector application attempts returned no successful result; read-back confirmed it is not applied. Models and real sources remain inactive. See the current checklist for complete acceptance limits.

All frontend builds are connected-only. Demo query parameters, sample workspaces, and local reset/restore are retired. Pending/error states and server-confirmed saves prevent local data from being presented as remote success.

The selected project is **TenderDesk**, reference `nqfwbqeozmuiuwbiowil`, Mumbai (`ap-south-1`). API base: `https://nqfwbqeozmuiuwbiowil.supabase.co/functions/v1/api`. Source and Pages use the owner-approved public repository `salahassi/tenders`, branch `main`.

[IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) is the current authority for exact migration/function versions, source commit, workflow result, test counts, and remaining activation work. Update it with every project change and after each deployment. Historical deployment statements in DECISIONS.md remain dated records.

API startup and its public/authentication boundary now pass hosted checks. Signed-in file/proposal/review writes, submission, and restore still need real-account acceptance. The minute scheduler, internal worker credential and continuous Gemini policy are active. Do not equate deployment with completion of stage 1 or the full application.

## Reproduce local verification

```sh
npm ci --prefix frontend
npm ci --prefix backend
npm --prefix frontend run typecheck
npm --prefix backend run typecheck
npm --prefix frontend test
npm --prefix backend test
npm --prefix backend run test:integration
npm --prefix frontend run build
npm --prefix backend run build
```

`tests/backend/database.test.ts` and `tests/backend/onboarding.test.ts` execute the migrations in embedded PostgreSQL (PGlite), with separate Owner, Editor, Reviewer, and unapproved test identities. It tests real SQL RLS and constraints, not a JavaScript imitation of authorization. Supabase Auth, hosted Storage behavior, pg_cron/pg_net, and live Edge Function deployment still require tests on the actual free project.

## Account-dependent activation

1. Recheck the selected project before cloud changes. For a clean project, apply canonical migrations in dependency order. For this existing project, reconcile the mapping below before any migration; do not replay the canonical filenames against differently timestamped hosted records. Keep Storage private, browser table writes revoked, and checked RPC boundaries intact.
2. Use **email/password only**. Do not activate social login. Email confirmation is required. On the **hosted** project (Dashboard → **Authentication** → **URL configuration**), set **Site URL** to `https://salahassi.github.io/tenders/` and add **Redirect URLs** including `https://salahassi.github.io/tenders/**` (remove `http://localhost:3000` unless you deliberately test locally). If Site URL stays on localhost, every confirmation and password-reset email will send users to localhost even when they use the production site. The frontend always passes `emailRedirectTo` / `redirectTo` as `https://salahassi.github.io/tenders/?auth=recovery` for password reset (see `deployment.appOrigin`). Supabase also appends `#access_token=...&type=recovery` or `?code=`. The app captures those before routing and opens the reset-password screen instead of sign-in. Supabase must allow that origin. Local `config.toml` is not evidence of hosted Auth configuration. Verify email delivery and any required SMTP setup with the real account.
3. Create the first Owner's email/password account, confirm that email, and send one password-reset message. `prepare_owner_setup` still records the designated email. After the Owner saves a new password, the signed-in session calls `claim_designated_owner` and opens the workspace. Do not ask the first Owner to open a separate invitation link. Later members still use Owner-issued invitations. Never commit the password, token, or email.
4. After setup, Owners issue role-scoped invitation links and manage members in the app. Invitation links require the same confirmed email and expire; revoked or mismatched links fail. The workspace allows at most five active users, including the Owner. Generating/copying a link does not itself send email.
5. The API allowlist defaults to `https://salahassi.github.io`. `APP_ALLOWED_ORIGINS` can override it. Backend environment reads platform key maps with legacy compatibility; keep service credentials out of the frontend and repository.
6. Deploy `api` and `worker` from `backend/supabase/functions`, including `deno.json` and relative dependencies. Both use custom authentication: the API calls Auth `getUser` on every protected request; the worker requires its separate application secret. Public health and invitation preview never grant membership.
7. Verify minimal health, anonymous 401, unapproved 403, actual Owner/Editor/Reviewer behavior, invitation denial/revocation, revision/idempotency conflicts, reload/second-session persistence, and mobile/desktop flows. Use the Supabase connector for supported operations; explain any specific unsupported setting before requesting browser fallback.
8. Deploy the continuation migrations and worker before calling the administrative `configure_dispatcher(project_url, collection_hosts)` function. It generates a new private credential in Vault and registers the minute dispatcher. Supply an empty host list until actual collection permissions and destinations have been reviewed. Verify the cron response and heartbeat separately. No keepalive traffic is added merely to avoid provider pausing.
9. The Gemini/Qwen adapters and collector handlers are already implemented. Activate a model only after the Owner selects it and approves its account, effective free quota and exact content. Missing policy/credentials or source permission remains a blocker; no inference, collection, or generated version is fabricated.

## Original-file protocol

Prepare-upload returns one generated private object path. The browser uploads using its authenticated session, with `upsert:false`. The Storage policy accepts only the uploader's pending reservation within 15 minutes; it grants no client overwrite/delete policy. Complete-upload rechecks identity, membership, size, MIME/extension/signature and SHA-256 before the object is accepted. Downloads recheck access and expire after five minutes. Files needing OCR/processing are retained honestly rather than treated as readable.

The legacy completion payload accepts up to 200,000 extracted characters. The continuation protocol uploads numbered text parts through `document.extraction`, at most 20 parts and 256 KiB per request, then completes with `from_parts:true`. The browser uses four parts per request to preserve UTF-8 headroom. Finalized originals and text are immutable; overlapping source blocks and confirmed sealed packages preserve evidence. Server checks enforce the aggregate million-character, ten-file and 200-PDF-page package bounds. The checklist distinguishes this implemented protocol from its pending hosted acceptance.

## Verified free boundaries

Current official Supabase pricing lists 500 MB database, 1 GB Storage, 500,000 monthly Edge Function invocations, and pausing after inactivity. The application enforces lower caps: 250 MiB retained originals/exports, 250 MiB application tables, 500 pending jobs, 10 MiB per file, ten RFP files. No recurring traffic is added solely to prevent provider pausing.

Sources checked 2026-10-14: https://supabase.com/pricing, https://supabase.com/docs/guides/functions/limits, https://supabase.com/docs/guides/functions/auth, https://supabase.com/docs/guides/storage/buckets/fundamentals.

## Existing hosted migration reconciliation

The connector assigned hosted versions to the 12 continuation migrations. The first eight canonical versions already match the server. The following mapping is deployment history, not an instruction to rename or replay migrations.

| Canonical migration name | Hosted version |
| --- | --- |
| durable_evidence_workflows | 20261015165238 |
| collection_and_dispatch | 20261015170322 |
| model_policy_and_budget | 20261015170410 |
| persistent_generation | 20261015170600 |
| commercial_and_approval | 20261015171032 |
| generation_assets | 20261015171153 |
| cloud_content_eligibility | 20261015171207 |
| export_authorization | 20261015171541 |
| acquisition_and_submission | 20261015171648 |
| workspace_recovery | 20261015172105 |
| reassessment_and_feedback | 20261015172337 |
| operations_and_retention | 20261015173911 |

The existing project additionally records `20261015182218_production_operations_repair` and `20261015182509_hosted_operations_repair_tail_oct15`. These repair records are not a complete clean-project migration sequence: the placeholder dropped functions and the actual repair restored the canonical bodies. Reconciliation compared all 98 current canonical function bodies with the hosted definitions: 96 matched exactly and two differed only in comments. The canonical operations migration remains the clean-project authority. Do not copy/replay the incomplete placeholder repair or assume a filename match proves identical schema.

The dispatcher correction is now applied and activation is complete. The following newer mappings extend the historical table above. They record the existing project state; retain the canonical files for clean-project setup and do not blindly replay them.

| Canonical correction | Hosted migration record |
| --- | --- |
| `20261015220000_dispatcher_extension_schema.sql` | `20261017121842_dispatcher_extension_schema` |
| `20261016220000_model_pool_runtime_fixes.sql`: preflight and private helper privileges | `20261017130519_model_runtime_preflight` |
| Same canonical file: reservation, settlement, and generation identity | `20261017130531_model_runtime_usage` |
| Same canonical file: provider policy input keys | `20261017131059_model_runtime_policy` |

The model correction was split because large connector requests expired before execution. All six model function bodies were compared with the canonical source after deployment, and the dispatcher body also matches exactly. The dispatcher supplies explicit extension schemas while preserving the empty search path. The administrative command below has already been executed for this project; rerunning it rotates the internal credential, so it is not a read-only health check:

```sql
select public.configure_dispatcher(
  'https://nqfwbqeozmuiuwbiowil.supabase.co',
  array[]::text[]
);
```

Verify the enabled cron job and the private dispatch/worker timestamps without selecting decrypted Vault values or request headers. The worker supports Vault-backed credential verification; a separate `APP_WORKER_SECRET` is optional and must not disagree with the configured dispatcher credential. Inspect the active worker configuration if authenticated dispatch is rejected. The application never grants browser/service-role permission to run `configure_dispatcher`.


## API v6 BootFailure recovery

The user-supplied API version 6 startup log on October 17, 2026 reports that deployed `api/handler.ts` does not export `createApiHandler`, which its `api/index.ts` imports. The canonical repository file does export that function. A clean extracted copy of the tracked function tree passed actual entry-point loading, health 200, and anonymous bootstrap 401 on Deno 2.1.4, matching the reported hosted runtime. Restore the complete canonical API source and dependencies rather than copying an entry point without its matching handler.

From an authenticated Supabase CLI session with the current `main` checkout and backend dependencies installed:

```sh
cd backend
npx supabase functions deploy api --project-ref nqfwbqeozmuiuwbiowil --import-map supabase/functions/deno.json --no-verify-jwt --use-api
```

These flags are documented in the [Supabase CLI function deployment reference](https://supabase.com/docs/reference/cli/supabase-functions-deploy). The API intentionally performs its own Auth and membership checks; preserve the existing `verify_jwt = false` configuration. The command deploys the API function and does not replay database migrations. For MCP deployment, upload the matching `api/index.ts`, `api/handler.ts`, all referenced `_shared` modules, and the import map with their relative paths intact. Inspect the deployed source first if the same export error persists.

After deployment, record the new version and verify `GET /functions/v1/api/v1/health` returns 200 with `data.status = available`, and anonymous `GET /functions/v1/api/v1/bootstrap` returns 401. Then verify authenticated behavior separately. Reconcile the pending provider migrations against the hosted history before Gemini execution; a successful function restart alone does not establish model readiness.

### Deployment through GitHub Actions

The manually triggered [Deploy Supabase API](https://github.com/salahassi/tenders/actions/workflows/deploy-api.yml) workflow deploys the canonical API file tree from the selected revision to the fixed TenderDesk project. It checks both package test suites and builds, validates the Edge Function imports with Deno, deploys through the pinned backend CLI, then verifies health 200, bootstrap preflight 204 with the application CORS headers, and anonymous bootstrap 401. A failed check fails the workflow. It does not deploy the worker or apply database migrations.

The workflow needs the repository Actions secret `SUPABASE_ACCESS_TOKEN`. Its first step checks presence without printing the value and stops before deployment if it is unavailable. Repository administrators can securely configure it under **Settings → Secrets and variables → Actions** and then run or rerun the workflow. Existing Gemini keys remain in Supabase Edge Function Secrets; this workflow does not transfer them. A configured MCP connection can also deploy the same source directly when available to the active session.


## Continuous Gemini deployment — October 17, 2026

The tested clean-project migration `20261017154306_continuous_gemini_free_tier.sql` is represented on this hosted project by three connector entries: `20261017164711_continuous_gemini_quota_mode`, `20261017175343_continuous_gemini_policy_probe`, and `20261017175356_continuous_gemini_retry_completion`. Full payloads encountered connector request-state errors; read-back confirmed no change before retrying. The policy function was applied with exact pre/post body hashes. All six final function bodies match canonical source, and existing privileges/search paths were verified. Hosted history has 32 entries; do not replay the canonical migration just because its filename differs.

API v9 and worker v5 use `ee5efa405e2dceee8b600f4ecddd4f14def616ce`; deployed file read-back matches. The worker bundle includes `_shared/modelProbe.ts`. Gemini activation uses the real Owner's Settings controls, never a forged user token or synthetic business row.

The follow-up `20261017180227_independent_gemini_requests.sql` changes only reservation scoping for independent continuous Gemini work. Hosted function body MD5 `67ce2e9b0bf625426b7333635af1db59` matches source, with an empty search path, browser execution denied, and service-role execution preserved. API v10 and worker v6 are ACTIVE with all 13/12 retained files matching the tested source. Bundle SHA-256: API `bd0ac2f78b8b09571f0d7fb22eb3c8fbbe695602dbfc4983441e56242670d482`, worker `1de51814817ba7e0a006bdc389442290fcaeca14d6d063a0238faacbe8493d4c`. Health and missing/invalid credential checks passed.

The hosted independent-request entry is `20261017180949_independent_gemini_requests` (33 total entries); its canonical local file remains `20261017180227_independent_gemini_requests.sql`. API v11/worker v8 include bounded fixed-label rejection diagnostics and the documented Gemini 3.8 `LOW` setting. Both deployments passed exact file read-back (13/12 files). Bundle SHA-256: API `45d1c8677aa3871d0bcd41e35fe6b501bafa497b806bca26abc8d8e895af4125`, worker `89a4a70485f58e4754df3d680afd12e057016a9139f7ae940beef595cc345442`. No provider secret or raw provider error is logged.

## Durable background Gemini deployment — October 17, 2026

Canonical migration `20261017182619_durable_gemini_background.sql` is deployed as `20261017183845_gemini_background_requests` and `20261017183856_gemini_background_recovery` (35 hosted entries total). All five SQL bodies match source; empty search paths and browser denial are verified. Resume/checkpoint/defer/claim are executable by service_role only; the trigger function is not directly executable by browser or service roles.

Current API **v13** and worker **v10** use application source `8c41a58af897439194f02ae2a46ef8363870b750`, with exact read-back of all 13 retained files in each. Worker includes `_shared/modelLedger.ts`. Bundle SHA-256: API `602ed0f802d328c9117d6f6529e9bdd6da0bc57ae0a55181b1199ea731fb0437`, worker `1abdc6e3ccde4a04a83b8d8ed984bee64ff42ea68d957c32ed85ff1f9e159d4b`. Tests pass: 147 backend/132 frontend, both typechecks/builds and Deno checks. [Pages run 39059595408](https://github.com/salahassi/tenders/actions/runs/39059595408) passed. Public `index-BM5gzhtC.js` and `Settings-jl32jasQ.js` match the tested frontend. The earlier compatibility deployment (API v12/worker v9) also passed health and invalid-credential denial; no authentication code changed in v13/v10. Security-advisor counts remain unchanged.

## Automatic provider routing

`model.routing` is an audited Owner command with an expected revision. It is independent of per-provider `enabled` controls. The worker reads these existing secret prefixes: `APP_MODEL_GEMINI`, `APP_MODEL_QWEN`, `APP_MODEL_MISTRAL`, `APP_MODEL_GROQ`, `APP_MODEL_ZAI`, each with `_NAME`, `_PROJECT` and `_KEY`. Add `_FREE_ONLY=true` only for an account confirmed to stop at free limits; a matching saved free-only policy is also accepted. Qwen's actual Free Quota Only console setting must be enabled. Groq/Mistral project values identify the configured account locally; Qwen uses its workspace in the Singapore endpoint. No default model, credential, quota balance or account identity is invented.

The rotation is Gemini → Qwen → Mistral → Groq → z.ai. Missing configuration is visible in job details and skipped without an unauthenticated HTTP request. The round uses 20-second provider requests to fit the worker lease; a valid background request defers to scheduled retrieval. Five provider failures exhaust the round and schedule a bounded retry. Daily application caps are shared across providers. Server-only preparation/attempt RPCs retain exact content authorization, active leases and unknown-use accounting. Cloudflare retains its existing manual support but is outside this requested automatic pool.


Automatic routing release `a6056db95dff6d9463b0bb7b6150d9955ab17cd9` deploys API **v14** and worker **v11**. All 13 retained files in each function match the tested source. Bundle SHA-256: API `9316514c599ca1477c78be3cbc143446ca5d32bb6cff927692b6c96026c7ea3a`, worker `001f66803e058dd341a8f193e8c8babe0f424e7371a0fc4a96ebd3a28b01fdd7`. Health returned 200; anonymous routing and missing/invalid worker credentials returned 401.

Canonical `20261017191753_round_robin_model_routing.sql` was applied in the following ten hosted entries (45 entries total). Early owner-wrapper submissions returned `Invalid or expired requestState`; read-back proved they made no changes. The final implementation extends the existing model-policy command, avoiding a command-function rename. All ten final function bodies match canonical MD5 values, with empty search paths and browser denial on internal RPCs.

| Hosted version | Name |
| --- | --- |
| 20261017205247 | round_robin_configuration_table |
| 20261017211138 | round_robin_server_preparation |
| 20261017211235 | round_robin_attempt_journal |
| 20261017211300 | round_robin_effective_preflight |
| 20261017211307 | round_robin_reservations |
| 20261017211329 | round_robin_generation_provenance |
| 20261017211336 | round_robin_retry_schedule |
| 20261017211343 | round_robin_result_checkpoint |
| 20261017211349 | round_robin_restore_pause |
| 20261017211454 | round_robin_owner_policy |

The owner-policy update was guarded by prior body MD5 `35f2c31b1d622f5b5942310080630f83`; the resulting canonical body is `8475641f1167604a09546706fa5033fe`. Do not replay the clean-project file merely because hosted timestamps/names differ. Local acceptance passed all **160 backend tests in 20 files**, **133 frontend tests in 23 files**, both typechecks/builds and Deno checks. [Pages run 39070202922](https://github.com/salahassi/tenders/actions/runs/39070202922) passed. Public `index-BH2H6zrM.js`, `Jobs-Bqizp6nn.js` and `Settings-BZPaphm5.js` match the local build byte-for-byte. Security advisor categories/counts are unchanged. Actual-browser switch persistence and completed-result reload acceptance passed.


Forward cursor correction: `20261017212026_preserve_round_robin_cursor_on_poll.sql` is deployed. Current `public.prepare_model_routing` body MD5 is `727088b5071b6a1be10fb45433ad03d5`, matching source; browser execution remains denied and service execution granted. Polling no longer consumes another turn in the round robin. The complete backend 160/20 and frontend 133/23 checks passed again. Edge Function source remains unchanged from API v14/worker v11; the small follow-up frontend label uses “Model connection check” for every provider.


Final scheduling corrections are deployed as `20261017212219_preserve_round_robin_cursor_on_poll`, `20261017212509_global_model_rotation_cursor`, and `20261017212516_deterministic_model_pool_order` (48 hosted entries total). The latter two map to canonical `20261017212401_deterministic_global_model_rotation.sql`. Latest body MD5 values: `public.prepare_model_routing` = `e3631994ba9d071b4f2610024acd4910`; `public.model_preflight` = `6cd74ed242c3c5614932d66ca61d9f7a`. Read-back matches both exactly; browser execute is false, service execute true. The full backend suite now passes **161 tests across 20 files**; frontend remains **133 across 23 files**. Source is `ffc0056bf3a0ae2820c40889b9261d9e175fb082`; runtime files remain identical to the API v14/worker v11 deployment. [Pages run 39070870332](https://github.com/salahassi/tenders/actions/runs/39070870332) passed. Earlier [label release 39070696200](https://github.com/salahassi/tenders/actions/runs/39070696200) succeeded and already published `index-hsMpcf1J.js`, `Settings-DhuB6njQ.js`, and `Jobs-CbsQBPJq.js`; all three public bundles match the current local build.

Read-only browser run `964dd841-a663-4288-bf07-d33864a3ac0e` confirmed the newest check as completed, 100%, attempt 2, with `Model connection verified; measured usage recorded.` and Qwen/Mistral/Groq missing-configuration reasons plus Gemini completed. Full reload preserved the same row and message; Settings still showed automatic round robin enabled. No additional probe or mutation was made by this run.

## Official listing runtime — October 18, 2026

API v15 and worker v12 are ACTIVE. Every retained file (14 each) matches tested source, including the pinned Cheerio 1.2.0 HTML5 parser. API bundle SHA-256 `fb2ea59571da5936daf9da653aea055910de08f46170369747341251bb90fd06`; worker `8de3a11b751ebab1f35348ab122a85ae97566b4020dd423f7df3579c90f74ca2`. No schema migration was required. Existing JWT settings and in-handler authentication remain. The first deployment attempt failed before replacement because the inherited import-map path referred to the old bundle; explicit `import_map_path: deno.json` resolved it.

Four existing sources were administratively activated under the Owner's full-system authorization; each has an audit event. Hosts were merged without rotating dispatcher credentials. Cron collected Ramallah at 23:39 UTC, An-Najah at 23:40, GTD at 23:41 and IsDB at 23:42 on October 17 (October 18 Riyadh). Results: 10/19/6/0 notices, all succeeded. See SOURCE_COLLECTION.md for scope and limitations.

## Queue completion fixes — October 18, 2026

Canonical `20261017234946_prioritize_collection_and_cancel_stale_source_jobs.sql` maps to hosted `20261017235442`. Canonical `20261017235819_keep_generation_progress_and_resumed_sources_moving.sql` maps to hosted `20261018000051` (50 hosted entries total). Latest `public.claim_backend_job` body MD5 is `9e8c911861a7c48d91fce7b7fbdfebda`; authenticated execution remains false, service_role true. Saved generation stages precede routine classification, pending provider GETs remain first, and >1h fairness is retained. Queued or precisely STALE_INPUT-blocked jobs for old source revisions are canceled and replaced after resumption. Security advisor categories/counts remain unchanged after both migrations. Final health/anonymous bootstrap/worker POST credential/origin boundaries passed. API v15/worker v12 are unchanged. All 171 backend tests/21 files and 141 frontend tests/26 files passed, both packages typecheck/build passed.

Discovery processing controls and queue source are published at `82e9ffbd63ccb74c7e47f7bfd6f375920d67d2b4`, successful [Pages 39081277000](https://github.com/salahassi/tenders/actions/runs/39081277000). Actual scheduler finished the notice assessment at 00:01:01 UTC and revision-4 repeat collection at 00:02:04 UTC, retaining 35 opportunities/snapshots.

Mobile table/tab containment, recorded source-run counts, Riyadh source timestamps and superseded-plan recovery guidance passed 143 frontend tests/26 files, typecheck/build, plus 28 isolated Chromium checks. Backend runtime/SQL remain unchanged from the prior verified release. Final source `2fb0482fcadcbb7d8242960694f32ee97d9c5331` is published by successful [Pages 39081884914](https://github.com/salahassi/tenders/actions/runs/39081884914); six tested public assets match byte-for-byte. Actual Owner final browser verified collection counts/timezone and company-name persistence.

Automatic routing supports five slots after `20261018101911_zai_free_provider.sql`. The API/worker must both be deployed. z.ai uses its standard API endpoint; `_NAME` is Owner supplied, `_PROJECT` is the Owner’s account label, and `_KEY` stays only in Edge Function secrets. Same-account model changes are applied to new automatic calls without resaving the policy. Existing requests retain identity checks.
