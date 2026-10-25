# Tenderdesk

The application source is separated into two folders in the same repository.

| Folder                | Contents                                                                                                | Runtime                                |
| --------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| [frontend](frontend/) | React interface, browser extraction/export, original assets, UI tests and Vite build                    | DigitalOcean Kubernetes HTTPS frontend                           |
| [backend](backend/)   | Deno API/workers, Supabase-compatible Auth/Storage, SQL migrations, API schemas and tests                 | DigitalOcean Kubernetes and managed PostgreSQL |


The live frontend is [TenderDesk on DigitalOcean](https://tenderdesk.129.212.166.115.sslip.io).
The first confirmed Owner and operating configuration were migrated with the
existing password hash; old business records, files and sessions were excluded.
Core application, private storage and background maintenance passed live
acceptance. Provider and SMTP credentials still require secure provisioning;
models remain paused and the source project is retained until complete operation
is verified. See the implementation checklist for exact release evidence.

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

Start the interface with `npm --prefix frontend run dev`. Its production output is `frontend/dist/`, served by the Kubernetes frontend image. The previous GitHub Pages bookmark redirects to the new HTTPS frontend.

See the [frontend guide](frontend/README.md), [backend guide](backend/README.md), [DigitalOcean deployment](backend/docs/DIGITALOCEAN_KUBERNETES.md), [implementation status and continuation plan](backend/docs/IMPLEMENTATION_CHECKLIST.md), and [original implementation specification](backend/docs/IMPLEMENTATION_SPEC.txt).

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
