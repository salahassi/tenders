# Backend deployment

## Scope and actual state

The same repository now contains the M2 backend foundation in `backend/`: four database migrations, row-level read policies, authenticated transactional commands, private file reservations and validation, scoped review records, job leases, and an authenticated dispatcher. Models and collection handlers are deliberately inactive.

The existing frontend remains the working browser-local demo. `frontend/src/lib/backendClient.ts` supplies authenticated API and upload calls, but the existing `AppProvider` has **not** been replaced by a connected repository adapter. Do not set a connected-mode environment flag and claim that ordinary demo edits are remotely persisted. Frontend command integration is a remaining implementation step after project access and API verification, not a completed cloud feature.

The owner created **TenderDesk** through the Dashboard after the integration's project-creation cost operations returned unavailable. On October 14, 2026, the project was verified as healthy in the owner's Free organization. Its actual region is Mumbai (`ap-south-1`). All four migrations are applied, and `api` (version 2) and `worker` (version 1) are deployed. The API base is `https://nqfwbqeozmuiuwbiowil.supabase.co/functions/v1/api`.

Hosted checks confirmed 17 public application tables with RLS, a private `tenderdesk-private` bucket, denied anonymous command/bootstrap execution, HTTP 200 for minimal health, and HTTP 401 for requests without user or worker credentials. Supabase's security advisor reported no findings after RPC hardening. No Owner identity has been bootstrapped; actual signed-in role workflows and authenticated uploads remain unverified. The worker secret and cron are not activated. The frontend remains the browser-local demo.

Source changes are committed locally. GitHub publication to `salahassi/tenders` / `main` remains blocked by automatic approval review, which requires explicit authorization for that public destination and default branch. Do not claim that the local commits are already on GitHub.

## Reproduce local verification

```sh
npm ci --prefix frontend
npm ci --prefix backend
npm --prefix frontend run typecheck
npm --prefix backend run typecheck
npm --prefix frontend test
npm --prefix backend test
npm --prefix frontend run build
npm --prefix backend run build
```

`tests/backend/database.test.ts` executes the migrations in embedded PostgreSQL (PGlite), with separate Owner, Editor, Reviewer, and unapproved test identities. It tests real SQL RLS and constraints, not a JavaScript imitation of authorization. Supabase Auth, hosted Storage behavior, pg_cron/pg_net, and live Edge Function deployment still require tests on the actual free project.

## Account-dependent activation

1. The owner's **TenderDesk** Free project is selected and verified. Recheck the project identity before future cloud changes.
2. Four migrations are already applied. Local filenames match the hosted migration history. Keep the Storage bucket private. Direct application-table writes are revoked for browser users; commands run through the checked RPC.
3. Configure GitHub OAuth and the exact application callback URL. OAuth may create an identity but cannot create a workspace or membership. Anonymous authentication is disabled.
4. Let the intended Owner sign into the application once. Inspect their verified Supabase Auth identity and GitHub provider identity server-side. Call `bootstrap_workspace(verified_user_uuid,workspace_name)` through an administrative connection. The function permanently closes once the pilot workspace exists; there is no seeded or automatic Owner.
5. The API defaults to the existing frontend's exact origin, `https://salahassi.github.io`. An explicit `APP_ALLOWED_ORIGINS` secret can override that allowlist. A URL path is not an origin. Configure a random `APP_WORKER_SECRET` in backend secrets before activating cron. The backend prefers the platform's default entries in `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS`, with compatibility fallback to existing legacy platform variables. Keep all service credentials out of the browser and repository.
6. Run Supabase CLI commands from `backend/`, which contains `supabase/config.toml`. Deploy `api` and `worker` from `backend/supabase/functions`. Both functions deliberately implement their own authentication before privileged work; see `config.toml`. The API calls Supabase Auth `getUser` for every protected request. The worker rejects any request without its separate application secret.
7. Verify public minimal health, unauthenticated 401, unapproved 403, Owner/Editor/Reviewer behavior, revision conflicts, idempotency conflicts, object access denial, original-file hash validation, and revoked-membership access on the live project.
8. Configure the cron invocation only after the worker secret and URL are confirmed. Store its secret in Vault; never put it in a committed SQL file. The scheduler must use the worker secret, not a publishable key as authorization.
9. Finish the frontend's connected repository integration and test the full journey before activating `CONNECTED_FREE`. Existing IndexedDB data remains available separately; migration must be explicit and must not seed the remote workspace with synthetic claims.
10. Discuss the AI model with the owner. Only then implement and verify its eligibility, quotas, secret and provider adapter. Current model jobs are persisted as `blocked / MODEL_NOT_CONFIGURED`; no request, output or completed version is fabricated.

## Original-file protocol

Prepare-upload returns one generated private object path. The browser uploads using its authenticated session, with `upsert:false`. The Storage policy accepts only the uploader's pending reservation within 15 minutes; it grants no client overwrite/delete policy. Complete-upload rechecks identity, membership, size, MIME/extension/signature and SHA-256 before the object is accepted. Downloads recheck access and expire after five minutes. Files needing OCR/processing are retained honestly rather than treated as readable.

The first completion endpoint accepts up to 200,000 extracted characters within the 1 MiB request cap. Full block-batched extraction, immutable extraction versions/package manifests, and larger 1,000,000-character RFP analysis remain pending M4 work. Oversized input is rejected rather than truncated. Do not present this foundation as complete implementation of every historical API route.

## Verified free boundaries

Current official Supabase pricing lists 500 MB database, 1 GB Storage, 500,000 monthly Edge Function invocations, and pausing after inactivity. The application enforces lower caps: 250 MiB retained originals/exports, 250 MiB application tables, 500 pending jobs, 10 MiB per file, ten RFP files. No recurring traffic is added solely to prevent provider pausing.

Sources checked 2026-10-14: https://supabase.com/pricing, https://supabase.com/docs/guides/functions/limits, https://supabase.com/docs/guides/functions/auth, https://supabase.com/docs/guides/storage/buckets/fundamentals.
