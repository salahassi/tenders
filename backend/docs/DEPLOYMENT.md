# Backend deployment

## Scope and actual state

**Activation blocker:** the Supabase connector declined the first new migration (`connected_workspace_commands`) without a reason. The four baseline migrations and api v2/worker v1 remain deployed. The new source is being published, but connected workspace/invitation activation remains unavailable until migration approval and API deployment.

The stage-1 release adds connected core-record commands, email/password identities, Owner-issued invitations, and restricted first-Owner setup. Production frontend builds use the connected repository; `?mode=demo` retains the separate browser-local demo. Pending/error states and server-confirmed saves prevent local demo data from being presented as remote success.

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
3. Ask the owner to designate the first administrator email. Generate a cryptographically random 256-bit token and store only its SHA-256 digest through administrative `prepare_owner_setup(email,token_hash,workspace_name)`. Share the resulting `https://salahassi.github.io/tenders/#/invite/<token>` privately with the owner; never commit the token or email. Setup expires after 24 hours and closes after workspace creation. The confirmed matching email accepts through the regular invitation API. There is no first-visitor promotion.
4. After setup, Owners issue role-scoped invitation links and manage members in the app. Invitation links require the same confirmed email and expire; revoked or mismatched links fail. The workspace allows at most five active users, including the Owner. Generating/copying a link does not itself send email.
5. The API allowlist defaults to `https://salahassi.github.io`. `APP_ALLOWED_ORIGINS` can override it. Backend environment reads platform key maps with legacy compatibility; keep service credentials out of the frontend and repository.
6. Deploy `api` and `worker` from `backend/supabase/functions`, including `deno.json` and relative dependencies. Both use custom authentication: the API calls Auth `getUser` on every protected request; the worker requires its separate application secret. Public health and invitation preview never grant membership.
7. Verify minimal health, anonymous 401, unapproved 403, actual Owner/Editor/Reviewer behavior, invitation denial/revocation, revision/idempotency conflicts, reload/second-session persistence, and mobile/desktop flows. Use the Supabase connector for supported operations; explain any specific unsupported setting before requesting browser fallback.
8. Complete connected file workflows in stage 2 before claiming hosted file acceptance. Then configure a random `APP_WORKER_SECRET` and cron invocation in stage 3, storing the scheduler secret in Vault rather than source. No keepalive traffic is added merely to avoid provider pausing.
9. Agree on and implement the model in stage 4. Current jobs remain blocked with `MODEL_NOT_CONFIGURED` or `SOURCE_ADAPTER_NOT_CONFIGURED`; no external inference, collection, or generated version is fabricated.

## Original-file protocol

Prepare-upload returns one generated private object path. The browser uploads using its authenticated session, with `upsert:false`. The Storage policy accepts only the uploader's pending reservation within 15 minutes; it grants no client overwrite/delete policy. Complete-upload rechecks identity, membership, size, MIME/extension/signature and SHA-256 before the object is accepted. Downloads recheck access and expire after five minutes. Files needing OCR/processing are retained honestly rather than treated as readable.

The first completion endpoint accepts up to 200,000 extracted characters within the 1 MiB request cap. Full block-batched extraction, immutable extraction versions/package manifests, and larger 1,000,000-character RFP analysis remain pending M4 work. Oversized input is rejected rather than truncated. Do not present this foundation as complete implementation of every historical API route.

## Verified free boundaries

Current official Supabase pricing lists 500 MB database, 1 GB Storage, 500,000 monthly Edge Function invocations, and pausing after inactivity. The application enforces lower caps: 250 MiB retained originals/exports, 250 MiB application tables, 500 pending jobs, 10 MiB per file, ten RFP files. No recurring traffic is added solely to prevent provider pausing.

Sources checked 2026-10-14: https://supabase.com/pricing, https://supabase.com/docs/guides/functions/limits, https://supabase.com/docs/guides/functions/auth, https://supabase.com/docs/guides/storage/buckets/fundamentals.
