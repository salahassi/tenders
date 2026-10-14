# Tenderdesk

The application source is separated into two folders in the same repository.

| Folder | Contents | Runtime |
| --- | --- | --- |
| [frontend](frontend/) | Existing React interface, browser extraction/export, original assets, UI tests and Vite build | GitHub Pages |
| [backend](backend/) | Supabase API and worker, SQL migrations, shared API schemas, backend tests and deployment documentation | Supabase Edge Functions and PostgreSQL |

Each folder has an independent `package.json` and `package-lock.json`. Root files contain repository documentation and configuration. GitHub Actions workflows remain in `.github/workflows/`.

## Install and verify

Use Node.js 22.12 or later. CI uses Node.js 24.

```bash
npm ci --prefix frontend
npm ci --prefix backend
npm --prefix frontend run typecheck
npm --prefix backend run typecheck
npm --prefix frontend test
npm --prefix backend test
npm --prefix frontend run build
npm --prefix backend run build
```

Start the existing interface with `npm --prefix frontend run dev`. Its production output is `frontend/dist/`, which the existing GitHub Pages workflow publishes at the same application URL.

See the [frontend guide](frontend/README.md), [backend guide](backend/README.md), [deployment status](backend/docs/DEPLOYMENT.md), and [original implementation specification](backend/docs/IMPLEMENTATION_SPEC.txt).

The frontend remains the browser-local demo while authenticated repository integration is completed. Supabase's backend foundation is deployed; Owner bootstrap, connected UI commands, cron and AI-provider activation remain separate unfinished steps. Do not infer connected persistence from the folder change.
