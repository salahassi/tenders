# Working in this repository

Tenderdesk is connected-only as requested by the owner on October 15, 2026. Never expose demo routes, populate user workspaces with synthetic records, or fall back to local simulated persistence. The Owner explicitly requested real official source seeders on October 17, 2026; the reviewed source directory in `backend/seeders/` is authorized reference data. Seed it only into an explicitly selected workspace, preserving existing records and collection states. Synthetic records belong only in automated test fixtures. Keep zero external model/payment/portal calls until explicitly activated. Do not implement simulated connected success.

- Application code is organized into `frontend/` and `backend/` at the owner's explicit request. Keep frontend assets and build configuration in `frontend/`, and Supabase functions, migrations, contracts and backend tests in `backend/`.
- For every project change, read and update `backend/docs/IMPLEMENTATION_CHECKLIST.md` in the same change. Record the affected stage, implementation status, test evidence, deployment evidence, and remaining work. Code, tests, deployment, and hosted acceptance are separate statuses; never mark a stage complete without its exit evidence. Reconcile the checklist after deployment, including the source revision and workflow result.
- Authentication is email/password with Owner-issued invitations only; do not add social providers.
- Read `frontend/docs/FRONTEND_HANDOFF.md` before connecting services. Full future requirements are in `backend/docs/IMPLEMENTATION_SPEC.txt`.
- Backend schema authority is `backend/supabase/migrations`; shared API validation is `backend/supabase/functions/_shared/contracts.ts`. Later user workflow decisions recorded in `backend/docs/DECISIONS.md` supersede earlier UI prescriptions.
- No browser role or supplied workspace ID grants server authority. Verify Auth and membership, preserve RLS, expected revisions and transactional audit/idempotency.
- Distinguish local PostgreSQL/API tests from live Supabase Auth/Storage/cron/deployment verification. Never claim a plugin installation is a deployed backend.
- Use shared types, domain rules, and `AppProvider`; keep business calculations out of presentation components.
- Preserve Arabic content, keyboard access, visible focus, mobile layouts, unknown values, and explicit loading/error states.
- Content or supporting evidence changes must invalidate approved proposal versions.
- Do not add secrets, credentials, real company claims, customer documents, or sensitive data to the repository or fixtures.
- Each folder has its own package and lockfile. Install from both lockfiles. Before a handoff, run `npm run typecheck`, `npm test`, and `npm run build` in each folder. GitHub Pages publishes `frontend/dist`.
- Record verification limits. jsdom tests are not real-browser visual QA or proof of server authorization.
