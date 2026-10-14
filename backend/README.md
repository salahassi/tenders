# Tenderdesk backend

This folder contains the Supabase Edge Functions, PostgreSQL migrations, API contracts, OpenAPI generator and HTTP/SQL authorization tests.

| Path | Purpose |
| --- | --- |
| `supabase/functions/api/` | Authenticated application API |
| `supabase/functions/worker/` | Internal dispatcher with separate worker authentication |
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
npm run build
npm run contracts:generate
```

`build` validates TypeScript. Supabase bundles the Edge Function source when it is deployed; this project does not produce a separate Node.js server bundle.

After authenticating the Supabase CLI and linking the verified project, `npm run serve` serves functions locally and `npm run deploy` publishes `api` and `worker`. Run Supabase commands from this folder so the CLI discovers `supabase/config.toml` and the migrations. Never commit backend credentials.

See [deployment and remaining activation steps](docs/DEPLOYMENT.md). The deployed functions, backend URLs and database records are unaffected by moving their source files in Git. No AI model is active yet.
