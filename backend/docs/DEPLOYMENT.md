# Backend deployment

## Scope and actual state

**Current activation:** twenty-two hosted migrations (through operations/retention plus repair tail), **API v4** / **worker v2**, and GitHub Pages at commit `f338c44` ([run 38770181985](https://github.com/salahassi/tenders/actions/runs/38770181985)). Hosted health and anonymous `/v1/me` denial passed October 15, 2026. Restricted Owner setup is prepared; Auth still has zero users until sign-up and invite acceptance. Cron, worker secret, model, and sources remain off — see the checklist.

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

1. Recheck the selected project before cloud changes. Apply migrations in dependency order; keep local migration versions aligned to hosted history. Keep Storage private, browser table writes revoked, and checked RPC boundaries intact.
2. Use **email/password only**. Do not activate social login. Email confirmation is required. Verify the hosted Site URL and confirmation/recovery redirect allowlist for `https://salahassi.github.io/tenders/`; the local `config.toml` is not evidence of hosted Auth configuration. Verify email delivery and any required SMTP setup with the real account.
3. Use the initial administrator email already supplied privately by the owner. Generate a cryptographically random 256-bit token and store only its SHA-256 digest through administrative `prepare_owner_setup(email,token_hash,workspace_name)`. Share the resulting `https://salahassi.github.io/tenders/#/invite/<token>` privately with the owner; never commit the token or email. Setup expires after 24 hours and closes after workspace creation. The confirmed matching email accepts through the regular invitation API. There is no first-visitor promotion.
4. After setup, Owners issue role-scoped invitation links and manage members in the app. Invitation links require the same confirmed email and expire; revoked or mismatched links fail. The workspace allows at most five active users, including the Owner. Generating/copying a link does not itself send email.
5. The API allowlist defaults to `https://salahassi.github.io`. `APP_ALLOWED_ORIGINS` can override it. Backend environment reads platform key maps with legacy compatibility; keep service credentials out of the frontend and repository.
6. Deploy `api` and `worker` from `backend/supabase/functions`, including `deno.json` and relative dependencies. Both use custom authentication: the API calls Auth `getUser` on every protected request; the worker requires its separate application secret. Public health and invitation preview never grant membership.
7. Verify minimal health, anonymous 401, unapproved 403, actual Owner/Editor/Reviewer behavior, invitation denial/revocation, revision/idempotency conflicts, reload/second-session persistence, and mobile/desktop flows. Use the Supabase connector for supported operations; explain any specific unsupported setting before requesting browser fallback.
8. Deploy the continuation migrations and worker before calling the administrative `configure_dispatcher(project_url, collection_hosts)` function. It generates a new private credential in Vault and registers the minute dispatcher. Supply an empty host list until actual collection permissions and destinations have been reviewed. Verify the cron response and heartbeat separately. No keepalive traffic is added merely to avoid provider pausing.
9. Agree on and implement the model in stage 4. Current jobs remain blocked with `MODEL_NOT_CONFIGURED` or `SOURCE_ADAPTER_NOT_CONFIGURED`; no external inference, collection, or generated version is fabricated.

## Original-file protocol

Prepare-upload returns one generated private object path. The browser uploads using its authenticated session, with `upsert:false`. The Storage policy accepts only the uploader's pending reservation within 15 minutes; it grants no client overwrite/delete policy. Complete-upload rechecks identity, membership, size, MIME/extension/signature and SHA-256 before the object is accepted. Downloads recheck access and expire after five minutes. Files needing OCR/processing are retained honestly rather than treated as readable.

The legacy completion payload accepts up to 200,000 extracted characters. The continuation protocol uploads numbered text parts through `document.extraction`, at most 20 parts and 256 KiB per request, then completes with `from_parts:true`. The browser uses four parts per request to preserve UTF-8 headroom. Finalized originals and text are immutable; overlapping source blocks and confirmed sealed packages preserve evidence. Server checks enforce the aggregate million-character, ten-file and 200-PDF-page package bounds. The checklist distinguishes this implemented protocol from its pending hosted acceptance.

## Verified free boundaries

Current official Supabase pricing lists 500 MB database, 1 GB Storage, 500,000 monthly Edge Function invocations, and pausing after inactivity. The application enforces lower caps: 250 MiB retained originals/exports, 250 MiB application tables, 500 pending jobs, 10 MiB per file, ten RFP files. No recurring traffic is added solely to prevent provider pausing.

Sources checked 2026-10-14: https://supabase.com/pricing, https://supabase.com/docs/guides/functions/limits, https://supabase.com/docs/guides/functions/auth, https://supabase.com/docs/guides/storage/buckets/fundamentals.
