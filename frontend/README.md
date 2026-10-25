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

The application loads `runtime-config.js` before its bundle. Kubernetes mounts this
public configuration from a ConfigMap, so one image can connect to the selected
API without rebuilding. Set `window.__TENDERDESK_CONFIG__` to an object containing
`apiUrl`, `publishableKey`, and the canonical `appOrigin` used by Auth email links.
Only the anonymous/publishable key belongs here; service keys, database credentials,
and provider secrets must remain on the server. Responses for this file and the
HTML entry point are not cached across deployments.

`.env.example` documents browser-safe Vite overrides for local development or a
static host. Runtime settings take priority. With no selected API, the client uses
its current origin; without a public key, it reports setup required. There is no
fallback to the previous Supabase project. Vite builds to `dist/`.

Build the Kubernetes image with the `frontend/` directory as its Docker context.
Its production TypeScript project excludes test-only imports of backend fixtures;
the ordinary typecheck/build and CI still check the complete frontend test suite.
It serves the application as an unprivileged user on port 8080, with `/healthz` for
readiness. Mount the generated public configuration at
`/usr/share/nginx/html/runtime-config.js`. The gateway serves this frontend and
the Auth, Data, Storage and application API routes under the same HTTPS origin.

## Workspace journey

Sign in through your invitation. Review incoming notices, select opportunities, and maintain sources and company notes. Only actual server records appear; opportunities stay unassessed until an agreed model is activated. The intended next stages add durable RFP/company attachments, complete proposal generation, scoped review and regeneration, and version-bound Word export.

Owner membership controls source approval, workspace settings, and invitations. Editor and Reviewer permissions are enforced by the server. There is no browser role selector.

Test data and the local fixture provider exist only under `src/test/`. Legacy backup parsing is retained for validation tests and compatibility work, but is not an application restore path. Existing browser data is neither imported nor erased by this release.

See [the frontend handoff](docs/FRONTEND_HANDOFF.md) for component contracts and pending service boundaries. Update the implementation checklist with every change and distinguish local tests from hosted acceptance.
