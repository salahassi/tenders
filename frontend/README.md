# Tenderdesk

A connected workspace for tender opportunities, company information, and proposals. All development and production builds use Supabase email/password authentication and Owner-issued invitations. There is no demo route, sample workspace, or local persistence fallback.

Core records use authenticated, revision-checked server commands. The first Owner requires a restricted setup invitation for their selected email. File/review writes, collection, AI generation, and full backup/restore remain pending stages; unavailable operations must not claim success. Use [the implementation checklist](../backend/docs/IMPLEMENTATION_CHECKLIST.md) for deployment and acceptance evidence.

## Run and verify

Use Node.js 22.12+; CI uses Node.js 24. From `frontend/`:

```sh
npm ci
npm run dev
npm run typecheck
npm test
npm run build
```

The public project configuration is in `src/lib/deployment.ts`; `.env.example` documents optional browser-safe overrides. Never put service-role keys or other secrets in a frontend environment file. Vite builds to `dist/`, published by the repository's GitHub Pages workflow.

## Workspace journey

Sign in through your invitation. Review incoming notices, select opportunities, and maintain sources and company notes. Only actual server records appear; opportunities stay unassessed until an agreed model is activated. The intended next stages add durable RFP/company attachments, complete proposal generation, scoped review and regeneration, and version-bound Word export.

Owner membership controls source approval, workspace settings, and invitations. Editor and Reviewer permissions are enforced by the server. There is no browser role selector.

Test data and the local fixture provider exist only under `src/test/`. Legacy backup parsing is retained for validation tests and compatibility work, but is not an application restore path. Existing browser data is neither imported nor erased by this release.

See [the frontend handoff](docs/FRONTEND_HANDOFF.md) for component contracts and pending service boundaries. Update the implementation checklist with every change and distinguish local tests from hosted acceptance.
