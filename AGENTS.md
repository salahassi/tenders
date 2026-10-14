# Working in this repository

Tenderdesk retains its browser-local demo while the same repository adds a Supabase backend. Preserve truthful mode labeling and zero external model/payment/portal calls until explicitly activated. Do not implement simulated connected success.

- Application code is organized into `frontend/` and `backend/` at the owner's explicit request. Keep frontend assets and build configuration in `frontend/`, and Supabase functions, migrations, contracts and backend tests in `backend/`.
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
