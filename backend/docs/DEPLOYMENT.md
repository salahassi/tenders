# Backend deployment

## Scope and actual state

**Verified October 15, 2026:** 22 hosted migrations, API v4 and worker v2; Pages application `d450c8c` passed [run 38807118314](https://github.com/salahassi/tenders/actions/runs/38807118314), completed October 15 at 21:06 UTC. One actual confirmed Auth identity exists, with restricted Owner setup pending and no workspace at the 20:58 UTC read. The hosted dispatcher is not configured. Its explicit-schema correction is saved in `20261015220000_dispatcher_extension_schema.sql` and passed local migration/tests, but two connector application attempts returned no successful result; read-back confirmed it is not applied. Models and real sources remain inactive. See the current checklist for complete acceptance limits.

All frontend builds are connected-only. Demo query parameters, sample workspaces, and local reset/restore are retired. Pending/error states and server-confirmed saves prevent local data from being presented as remote success.

The selected project is **TenderDesk**, reference `nqfwbqeozmuiuwbiowil`, Mumbai (`ap-south-1`). API base: `https://nqfwbqeozmuiuwbiowil.supabase.co/functions/v1/api`. Source and Pages use the owner-approved public repository `salahassi/tenders`, branch `main`.

[IMPLEMENTATION_CHECKLIST.md](IMPLEMENTATION_CHECKLIST.md) is the current authority for exact migration/function versions, source commit, workflow result, test counts, and remaining activation work. Update it with every project change and after each deployment. Historical deployment statements in DECISIONS.md remain dated records.

Connected file/proposal/review writes, submission, and restore are still blocked. No collector or model handler executes; the worker reports the missing dependency. Cron and worker credentials are not activated. Do not equate deployment with completion of stage 1 or the full application.

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
3. Use the initial administrator email already supplied privately by the owner. Generate a cryptographically random 256-bit token and store only its SHA-256 digest through administrative `prepare_owner_setup(email,token_hash,workspace_name)`. Share the resulting `https://salahassi.github.io/tenders/#/invite/<token>` privately with the owner; never commit the token or email. Setup expires after 24 hours and closes after workspace creation. The confirmed matching email accepts through the regular invitation API. There is no first-visitor promotion.
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

The only saved unapplied correction at this checkpoint is `20261015220000_dispatcher_extension_schema.sql`. It specifies `pg_catalog`, `extensions` and `vault` when enabling the required extensions and preserves the deliberately empty function search path. After applying it through the authorized connector, use a trusted administrative connection to invoke:

```sql
select public.configure_dispatcher(
  'https://nqfwbqeozmuiuwbiowil.supabase.co',
  array[]::text[]
);
```

Verify the enabled cron job and the private dispatch/worker timestamps without selecting decrypted Vault values or request headers. The worker supports Vault-backed credential verification; a separate `APP_WORKER_SECRET` is optional and must not disagree with the configured dispatcher credential. Inspect the active worker configuration if authenticated dispatch is rejected. The application never grants browser/service-role permission to run `configure_dispatcher`.
