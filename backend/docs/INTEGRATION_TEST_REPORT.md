# Integration and hosted acceptance report

Verified October 17, 2026. The Owner has explicitly authorized full system activation followed by integration and browser end-to-end testing. Model/source activation is authorized; missing account configuration, source inputs, and a usable browser connection are the current dependencies.

## Verified results

| Verification | Result | Scope |
| --- | --- | --- |
| Backend | 122 tests passed across 17 files; type check and build passed | Includes all canonical migrations in embedded PostgreSQL, authorization, quota accounting, generation, finance, export, and recovery fixtures. |
| Frontend | 125 tests passed across 23 files; type check and production build passed | Component and application tests use jsdom. The existing bundle-size warning remains. |
| Composed HTTP/database/worker integration | Three new scenarios passed | Production API and worker handlers execute against the actual SQL functions and RLS. Auth token verification, object transport, DNS, and feed responses are local test doubles. |
| Hosted HTTP boundaries | 16 checks passed | API health 200; permitted-origin command preflight 204; ten protected read endpoints without authentication 401; invalid-token bootstrap 401; forbidden-origin health 403; worker with missing/invalid credential 401. |
| Hosted scheduler | Last three runs at 13:38, 13:39, and 13:40 UTC succeeded | Worker authentication reached 13:40:01.453 UTC and heartbeat 13:40:01.939 UTC; scheduler enabled and no recorded operational error. |

The application source remains `8c2a4b22704351d380953762922b557b729527cb`, deployed as API v7 and worker v4. This continuation adds test coverage and documentation only. It does not change production application code or require a new Edge Function deployment. The public frontend entry remains `index-D9NWCIMr.js`.

## New integration scenarios

`tests/backend/httpDatabase.integration.test.ts` covers the following paths without creating cloud fixtures:

1. Create and approve a source through HTTP, execute its durable job through the worker and real SQL functions, reload the stored opportunity, collect again, and verify deduplication and preservation of a human decision. Changed idempotent replays are rejected.
2. Save a Gemini-only policy through the same command route used by the interface, reload it through bootstrap, reject Reviewer/unapproved/invalid sessions, reject a stale revision, and disable it using the current revision. This uses a synthetic local policy and makes no provider call.
3. Reserve an original through HTTP, reject mismatched bytes and a different uploader, verify its SHA-256 at completion, reload persisted extraction blocks, and reject a changed completion replay. Original transport uses an in-memory object map; hosted Storage acceptance remains pending.

Run the focused database/onboarding/HTTP integration group with `npm run test:integration -- --maxWorkers=2` from `backend/`. Run all backend suites with `npm test -- --maxWorkers=2`. Each new scenario is isolated in a rolled-back local transaction.

## Hosted inputs and browser status

The hosted workspace is empty: no model policy, source, document, opportunity, or business job was present at inspection. The deployment collection-host allowlist is also empty. The Owner previously selected Gemini 3.8 Flash and reported adding its secrets; the matching project identity, effective free quota, and billing status still need verification in the account. No quota value or billing attestation has been invented.

The available tool registry has neither the connected Browser control tool nor a cloud browser control tool. The Browser skill was read and plugin discovery checked; no browser session was opened. The Owner was asked to connect Browser so they can sign in directly, and to provide the first source URL. Passwords were not requested in chat. Public HTTP checks and jsdom results are not browser end-to-end results.

## Browser acceptance still to execute

| Journey | Required evidence | Current status |
| --- | --- | --- |
| Identity and persistence | Actual Owner sign-in, reload, sign-out, protected-route denial, and desktop/mobile navigation | Waiting for browser session |
| Source collection | Reviewed real source, matching deployment allowlist, collection, deduplication, pause, and browser-closed execution | Waiting for source URL and session |
| Original evidence | Eligible real RFP upload, byte-preserving download, extraction review, and persistence after reload | Waiting for session and real input |
| Model and generation | Account/project/quota verification, provider configuration, eligible content authorization, measured provider usage, and a persisted generated proposal | Waiting for account verification and inputs |
| Review and commercial flow | Scoped text/file feedback, regenerated version, approved rates/assumptions, and evidence-bound approval | Depends on the preceding proposal journey |
| Export and recovery | Authorized Word download and field/pagination review; complete backup and controlled restore into an empty matching-schema target | Depends on actual proposal/artifact inputs and restore target |

Full hosted acceptance remains open. The latest instruction supplies activation authorization; completing it requires the missing access and inputs above.
