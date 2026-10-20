# Tenderdesk

The application source is separated into two folders in the same repository.

| Folder                | Contents                                                                                                | Runtime                                |
| --------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| [frontend](frontend/) | Existing React interface, browser extraction/export, original assets, UI tests and Vite build           | GitHub Pages                           |
| [backend](backend/)   | Supabase API and worker, SQL migrations, shared API schemas, backend tests and deployment documentation | Supabase Edge Functions and PostgreSQL |

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

See the [frontend guide](frontend/README.md), [backend guide](backend/README.md), [deployment status](backend/docs/DEPLOYMENT.md), [implementation status and continuation plan](backend/docs/IMPLEMENTATION_CHECKLIST.md), and [original implementation specification](backend/docs/IMPLEMENTATION_SPEC.txt).

The [unified model execution and real proposal acceptance plan](backend/docs/MODEL_EXECUTION_PLAN.md)
extends the original milestones with structured model contracts, configurable
task routing, grounded correction and the real RFP-to-Word acceptance matrix.
Its planned work is separate from the deployed runtime.

All builds use the invitation-only email/password connected application. Demo
routes, sample workspace seeding, and local reset/restore controls have been
retired. See the checklist for current source/runtime versions, verified journeys
and remaining hosted generation, export and recovery acceptance.

## Required change record

[Implementation Checklist](backend/docs/IMPLEMENTATION_CHECKLIST.md) is part of the project and must be updated with **every project change**, including fixes, features, tests, configuration, and deployments. Read it before work; record the affected stage, completed work, verification, deployment status, and remaining dependencies in the same change. Update it again with actual deployment evidence. `AGENTS.md` carries the same requirement for future agent work. Passing local tests alone does not complete a stage.
