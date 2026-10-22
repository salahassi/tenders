# Tenderdesk backend

This folder contains the Supabase Edge Functions, PostgreSQL migrations, API contracts, OpenAPI generator and HTTP/SQL authorization tests.

| Path | Purpose |
| --- | --- |
| `supabase/functions/api/` | Authenticated application API |
| `supabase/functions/worker/` | Internal dispatcher with separate worker authentication |
| `supabase/functions/source-browser/` | Leased browser gateway authenticated by GitHub Actions OIDC |
| `supabase/functions/_shared/` | API validation, request handling and backend clients |
| `supabase/migrations/` | Ordered schema, authorization and storage migrations |
| `tests/backend/` | HTTP boundaries and real SQL policy checks using embedded PostgreSQL |
| `packages/contracts/` | Exported API schema authority |
| `docs/` | Deployment status, implementation specification, decisions and security notes |

Run commands from this folder, or use `npm --prefix backend` from the repository root.

```bash
npm ci
npm run typecheck
npm test
npm run test:integration
npm run build
npm run contracts:generate
```

`build` validates TypeScript. Supabase bundles the Edge Function source when it is deployed; this project does not produce a separate Node.js server bundle.

`test:integration` runs the real SQL migrations and database functions in embedded PostgreSQL, including permissions, transactions, original-file reservations, and queue leases. The local identity and Storage catalog fixtures do not replace actual Supabase Auth/Storage integration tests. See [the staged continuation plan and acceptance evidence](docs/IMPLEMENTATION_CHECKLIST.md).

After authenticating the Supabase CLI and linking the verified project, `npm run serve` serves functions locally and `npm run deploy` publishes `api`, `worker` and `source-browser`. Run Supabase commands from this folder so the CLI discovers `supabase/config.toml` and the migrations. Never commit backend credentials.

JavaScript sources use the scheduled **Collect JavaScript sources** workflow on `main`. It launches Chromium and exchanges its short-lived GitHub identity with the dedicated gateway; no repository management secret is needed. The gateway accepts only this repository's exact workflow, ref and audience. A supported image-code challenge appears in the approved source's details for the Owner to answer while the browser lease remains live. Answers are single-use; server-encrypted browser sessions expire after four hours. Unsupported verification or login remains a visible blocker. The normal collection job still performs grounded extraction and current-source checks before saving any notice.

See [deployment and remaining activation steps](docs/DEPLOYMENT.md) and the dated implementation checklist for current runtime and source acceptance.
