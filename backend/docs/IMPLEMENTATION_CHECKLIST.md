# Implementation status and continuation plan

Reviewed October 14, 2026 against all 814 lines of [the original specification](IMPLEMENTATION_SPEC.txt), the [current frontend handoff](../../frontend/docs/FRONTEND_HANDOFF.md), [later decisions](DECISIONS.md), the implementation, and the connected GitHub and Supabase projects.

**The published application is a browser-local demo. The Supabase backend foundation is deployed, but the frontend does not yet use it for ordinary reads, edits, or uploads. The connected tender-to-proposal journey is incomplete.** Later user decisions govern the current interface and deployment choices.

## Verified baseline

| Area | Evidence and conclusion |
| --- | --- |
| Source publication | Public `salahassi/tenders` branch `main`, implementation commit `73f5ef4ac80a7ee944fcd35e219cfff725496f37`, contains the approved `frontend/` and `backend/` layout. Its tree has 104 tracked files: 71 frontend, 29 backend, and four root/configuration files. |
| Deployment | [GitHub Actions run 38605686546](https://github.com/salahassi/tenders/actions/runs/38605686546) succeeded for that commit: both installs, TypeScript checks, tests, the frontend build, and Pages deployment passed. Direct comparison of public asset bytes was not completed because the execution environment blocked the public-site request. |
| Supabase | TenderDesk, reference `nqfwbqeozmuiuwbiowil`, is `ACTIVE_HEALTHY` in Mumbai. All four migrations are applied. All 17 public application tables have row-level security (RLS). The private bucket has a 10 MiB file limit. The security advisor returned no findings within its check scope. |
| Functions | `api` version 2 and `worker` version 1 are active. Earlier deployment checks returned minimal health 200 and unauthenticated application programming interface (API)/worker 401. Minimal health is not a signed-in workflow test. |
| Connected usage | A fresh read-only query found **0 Auth users, 0 workspaces, 0 memberships, and 0 jobs**. There is no initialized Owner workspace. Neither `pg_cron` nor `pg_net` is installed. |
| Frontend persistence | `frontend/src/lib/store.tsx` loads demo fixtures and saves through IndexedDB. `configuredBackend()` exists in `backendClient.ts` but has no application consumer. Setting an environment flag alone cannot connect the app. |
| Background/model work | The worker has no collector or model handler. It records `SOURCE_ADAPTER_NOT_CONFIGURED` or `MODEL_NOT_CONFIGURED`. No scheduled collection, analysis, or proposal generation is operational. |

The original implementation passed 96 frontend and 19 backend tests. This review adds five PostgreSQL queue integration tests; all **24 backend tests** and backend type checking now pass. The 96 frontend results still apply to unchanged frontend code. This is a combined suite of 120 tests, not 120 end-to-end acceptance tests.

The new integration cases cover worker access denial even for an application Owner, repeated dispatch/single-active-job enforcement, invalid or replayed leases, expiry with checkpoint preservation, and cancellation without releasing a running lease early. They execute the real migrations and SQL functions in PGlite, an embedded PostgreSQL runtime. Auth identities and Storage catalog tables are local fixtures; these tests do not connect to hosted Supabase Auth or Storage and do not prove concurrency across separate database connections.

## Milestone assessment

| Milestone | Current implementation | Remaining work |
| --- | --- | --- |
| M1: local workspace | Local opportunities, sources, company files, extraction, scoped review inputs, saved proposals, calculations, Word export, and typed backups. | The current interface deliberately leaves generation disconnected. A complete generated-proposal journey and all real-browser checks are unverified. |
| M2: authenticated persistence | Migrations, access policies, transactional commands, private upload reservations, original validation, audit/idempotency, and a client helper. | Actual sign-in, verified Owner, connected repository, related-record reads, missing commands, real-role and hosted Storage tests. |
| M3: sources and queue | Source approval commands, manual opportunity creation, and tested queue lease boundaries. | Collectors, import transactions, stable source identities, snapshots, deduplication, due jobs, scheduler, quotas, retries, notifications, and classification. |
| M4: analysis and writing | Local extraction/calculations, scoped review inputs, and a persisted blocked regeneration request. | Immutable evidence packages, source blocks, requirement inventories, provider/budget controls, generation handlers, server estimates, and full version-bound reviews. |
| M5: export and operations | Local Word export, separate submission recording, and metadata/text backup. | Connected export/submission records, original-file backup/restore, retention, heartbeat UI, browser journeys, and rendered-document acceptance. |
| M6: activation/evaluation | GitHub publishing and Supabase foundation active. | Auth/Owner and scheduler activation, signed-in workflow checks, model setup after owner discussion, source approval, and later labeled quality evaluation. |

### Integration gaps that affect the next stage

- Map current frontend entities to server records explicitly. Frontend combined `status` values differ from server `decision` values. Proposal detail currently returns only the proposal row; sections, questions, review inputs, documents, and versions need authorized loading.
- Complete commands per connected journey. Initial proposal creation/generation, acquisition, import preview/commit, extraction blocks/packages, persisted estimates, export completion, submission, and workspace backup/restore are not implemented API workflows. Entering credentials cannot supply them.
- Align extraction limits without truncation. Local extraction allows 1,000,000 characters per file, while completion accepts 200,000. Current PDF limits apply per file rather than package. Local Office archive bounds differ from server bounds. Add bounded block batches and package accounting.
- Implement verified-identity provisioning. The current membership command changes an existing member; it does not provision additional approved users.
- Preserve later UI decisions: each section/question owns its text and attachments; one save/regenerate snapshots all inputs; pending input remains separate from the current file. Do not reinstate removed outline screens or classification selectors from the historical specification.
- Model selection and provider-specific eligibility remain pending decisions. The historical Gemini name is neither activated nor revalidated.

## Ordered continuation plan

The user explicitly requires tests, especially integration tests. Every stage includes implementation, relevant automated tests, a source commit, deployment where appropriate, and a factual progress update. Account-dependent live checks remain open until actually performed. Preserve the demo and its existing browser data.

| Stage | Implementation | Integration and acceptance evidence required |
| --- | --- | --- |
| **1. Identity and core records** | Reconcile current UI/server contracts, implement the connected repository and login/access-pending states, configure GitHub OAuth, bootstrap the verified Owner, and connect opportunities, sources, company references, and role-aware commands. | Drive real API commands through database transactions. An actual Owner creates a record that survives refresh and appears in another authorized session. Test unapproved/revoked identities, prohibited role actions, stale edits, and changed request replays. Connected mode must not report a local write as a remote success. |
| **2. Files and review inputs** | Connect private Storage, original validation/downloads, aligned extraction limits, related-record reads, scoped review persistence, and immutable evidence packages. | Prepare → upload → complete → download preserves exact bytes. Test unauthorized access, expiry, malformed/oversize files, text-only/file-only/combined input, failed uploads, and retries without duplicate records. The current proposal stays unchanged until a new version is generated. |
| **3. Collection and background operation** | Implement bounded RSS/JSON/approved-directory adapters, manual/CSV imports, snapshots, deduplication, due jobs, worker credentials/cron, retries/cancellation, heartbeat, and notifications. | An approved source creates opportunities with the browser closed. Replays create no duplicates; pausing prevents new collection. Test prohibited destinations, redirect policy, timeouts, crash/lease recovery across real connections, and scheduler failure visibility. |
| **4. Owner-agreed model integration** | Discuss/select the model, verify free-account limits and eligible data, implement provider contracts, final-payload validation, quota reservations, retries, and usage records. | A recording fake provider proves forbidden inputs, missing credentials, unknown billing, and exhausted quotas make no inference call. Test timeout accounting and bounded repair. A permitted live test follows owner activation; no paid fallback. |
| **5. Assessment, analysis, generation** | Assess notices against authorized company references; analyze confirmed RFP evidence; retain requirements/questions; generate full proposals; apply scoped feedback as new versions; calculate supported financial figures on the server. | Complete a sample notice → RFP → proposal → scoped feedback → revised proposal journey. Verify citations, unresolved facts, interrupted-job checkpoints, saved earlier versions, and financial fixtures. |
| **6. Export, submission, recovery** | Bind exported files/manual submission to recorded versions while preserving the current UI, implement operational backup/restore including originals, and verify Arabic/English Word output. | Restore a clean test workspace with the same originals, records, review inputs, versions, and totals. Export must not send a bid or mark submission. Render and inspect representative files and applicable volume-separation rules. |
| **7. Complete-trial verification** | Close applicable acceptance gaps, exercise actual roles and browsers, test service/quota failures, and document model quality separately when labeled inputs are supplied. | Reproducible end-to-end evidence identifies passed requirements, superseded historical requirements, and remaining account/data dependencies. No blanket completeness or model-accuracy claim. |

**Next implementation stage: 1, identity and connected core records.** Its code work does not depend on model selection. The actual Owner must sign in once when the login path is ready; never invent that identity or automatically import synthetic demo records into the cloud workspace.

### Test layers and commands

Run from the repository root:

```sh
npm --prefix frontend test
npm --prefix backend test
npm --prefix backend run test:integration
npm --prefix frontend run typecheck
npm --prefix backend run typecheck
```

- Frontend tests cover deterministic domain rules and component/store behavior.
- Backend API tests cover request/authentication boundaries with a test backend.
- `test:integration` executes real migrations and SQL functions, permissions, transactions, idempotency, file reservations, and queue behavior in embedded PostgreSQL.
- Actual Supabase Auth/API/Storage integration and browser end-to-end tests are required deliverables in the stages above. They are not implemented by the local test command and must not be counted as passed.
- Use synthetic fixtures, distinct authorized and unauthorized test identities, bounded cleanup, and no paid/model calls in ordinary continuous integration.

## Acceptance mapping: AT01–AT30

“Partial” means an implemented or tested slice exists, but the full original outcome is not established. Later approved product changes take precedence over the historical UI; reconcile affected tests explicitly.

| ID | Evidence now | Remaining work |
| --- | --- | --- |
| AT01 | Partial: source approval/pause commands and local tests make no collection calls. | Prove due-job scheduling and pause behavior with a collector. |
| AT02 | Pending: no collector or paid workaround exists. | Detect login/prohibited sources and produce tested manual-action states. |
| AT03 | Partial: command replay and local CSV preview tested. | Collection identities, repeated import commits, notification deduplication. |
| AT04 | Pending: no advertisement snapshot collector. | Material-change versions/notifications without changing human decisions. |
| AT05 | Partial: synthetic fit examples preserve insufficient information. | Real title-only and unknown-prerequisite routing. |
| AT06 | Partial: examples distinguish sector interest from service fit. | Grounded classifier tests against company evidence. |
| AT07 | Partial: decisions are stored separately; no live reassessment. | Rescoring/profile-change tests with a declined opportunity. |
| AT08 | Partial: missing deadlines retained; server creation requires timezone for a parsed date. | Ambiguous-date and source-disappearance integration tests. |
| AT09 | Pending policy decision and enforcement; model calls absent and old selectors removed by user instruction. | Selected-provider eligibility across assembled inputs; do not claim the old upload gate exists. |
| AT10 | Pending: no model/external-action execution. | Malicious file/source fixtures and a recording fake provider. |
| AT11 | Partial: local Owner/Editor/Reviewer/unapproved tests, denied writes, file access, and revoked membership. Hosted RLS enabled. | Actual signed-in roles and cross-workspace/object denial. |
| AT12 | Partial: local acquisition/role rules cannot pay. | Connected acquisition transitions and current RFP-first generation journey. |
| AT13 | Partial: local extraction and review tests retain unreadable/failed files. | Representative scanned/encrypted/corrupt files and connected completeness checks. |
| AT14 | Pending: no immutable source-block/requirement inventory workflow. | Every mandatory requirement linked to real evidence and response/question. |
| AT15 | Partial: local evidence changes invalidate approval. | Addenda/package versions retaining prior submissions. |
| AT16 | Partial: review tests retain missing questions and avoid fabricated replacement text. | Generated output/company-claim validation. |
| AT17 | Verified locally: finance tests assert 16698 markup gross and 15125 margin net. | Apply the fixture to the future server calculator. |
| AT18 | Partial: empty/zero rates, tax input, margin limits, decimal rounding tested. | Payment percentages, tax groups, recurring periods, exchange rates, server enforcement. |
| AT19 | Partial: local content/evidence changes invalidate approval. | Connected version/hash binding and export invalidation under current product decisions. |
| AT20 | Partial: DOCX tests inspect live table-of-contents fields, tables, Arabic direction, saved content. | Render documents and verify buyer-specific volume rules; current UI exports one file. |
| AT21 | Partial/product-adjusted: explicit local submission is separate from export. | Connected role/version records aligned to current UI. |
| AT22 | Partial: model jobs blocked with `MODEL_NOT_CONFIGURED`. | Real quota/billing/checkpoint enforcement and exhaustion tests. |
| AT23 | Partial, strengthened in this review: real SQL tests cover repeated claims, active-job constraint, stale/replayed completion, expiry, cancellation, and checkpoint retention. | Separate-connection concurrency, real handler outputs, actual repeated cron/crash scenarios. |
| AT24 | Pending: provider reservations/repair not implemented. | Timeout uncertainty and one-repair budget with a controlled provider/clock. |
| AT25 | Partial: obvious private URL forms rejected; backend fetching disabled. | Resolved-address, hostname, redirect, streamed-response tests in collectors. |
| AT26 | Partial: server size/type/signature/hash/Office bounds and malformed request checks. | Align client/server/package limits; adversarial archives and live authenticated uploads. |
| AT27 | Verified local slice: stale revisions and changed replays rejected; API conflict mapping exists. | Hosted commands and each new workflow. |
| AT28 | Verified demo slice: no credentials required, persistent demo label, generation remains pending. | True connected-mode failure states and no local-success fallback. |
| AT29 | Partial: operation fields and dependency messages exist. | Actual heartbeat display and stopped/paused-backend test. |
| AT30 | Partial: JSON backup preserves typed records, evidence text, review context, approvals, totals. | Original bytes are excluded; full connected backup and clean-target restore. |

## Handover limits

No actual signed-in cloud journey, model-quality result, collector run, scheduled execution, complete cloud restore, browser end-to-end report, or rendered Word acceptance report is claimed. Operational/evaluation guides, end-to-end tooling, and several specification scripts remain deliverables. Generated OpenAPI documents the implemented foundation only.

This review changes documentation and test coverage. It does not activate authentication, connected persistence, cron, or a model.
