# Decisions

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
