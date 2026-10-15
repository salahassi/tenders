# Implementation status and continuation plan

Verified October 15, 2026. This file separates implemented code, local verification, deployed components, and actual hosted acceptance. Requirements remain in [IMPLEMENTATION_SPEC.txt](IMPLEMENTATION_SPEC.txt); later decisions in [DECISIONS.md](DECISIONS.md) and the current [frontend handoff](../../frontend/docs/FRONTEND_HANDOFF.md) take precedence where explicitly recorded. Earlier chronological checkpoints remain in Git history.

**The application features in stages 1–7 are implemented. The complete hosted trial is not yet accepted.** The remaining operational blocker is scheduler activation. The remaining account-dependent checks require the actual Owner session, approved sources/content, and the deliberately deferred model choice. Do not describe the project as fully operational or its model quality as validated.

## Verified release state

| Component | Verified evidence | Remaining limitation |
| --- | --- | --- |
| Published application | `aec73775c397411eddbf2c4256e752ea4dd253fb`; [Pages run 38825944454](https://github.com/salahassi/tenders/actions/runs/38825944454) completed successfully October 15 at 23:51 UTC. Build passed on Node 24, then the deploy job finished in 19 seconds. [Open Tenderdesk](https://salahassi.github.io/tenders/). | Pages publishes the frontend only. The scheduler migration still requires a separate hosted application. |
| Backend local checks | 103 tests passed, TypeScript and build passed, including the corrective dispatcher migration. All migration files are executed by the PostgreSQL test fixture. | PGlite does not execute the hosted pg_net/pg_cron installation path; a migration parsing successfully is not scheduler acceptance. |
| Frontend local checks | 124 tests passed locally on Node 22.22.2, including the workspace skeleton, signed-out sign-in, and overview health hide/show. [Pages run 38825944454](https://github.com/salahassi/tenders/actions/runs/38825944454) repeated typecheck, tests, and the production build on Node 24 and passed. Chrome 154 opened that bundle at 1440×900 and 390×844. | The browser check held the workspace request and returned an empty fixture workspace. It is not an Owner session on the hosted API. |
| Hosted database/functions | 22 migrations; `api` v4 and `worker` v2 ACTIVE. Health returned 200, protected anonymous API returned 401, worker without its credential returned 401. All 98 canonical application function bodies were reconciled, with two comment-only differences. | Connector-assigned migration versions and two repair records differ from canonical clean-project filenames; do not blindly replay them. See [deployment](DEPLOYMENT.md). |
| Owner setup | Workspace `64d3c4c3-0c4a-46fa-b6ce-3b1965d3c72d` exists and the confirmed account is Owner. `claim_designated_owner` lets that same account finish first entry from a password reset, with no separate invitation click. | Reload the published site after this migration and Pages deploy. Later members still need an invitation. |
| Auth email links | Password recovery now stays on a reset-password screen. The app reads `type=recovery` from the email hash or `?auth=recovery` before the hash router runs, and does not show sign-in while that reset is in progress. | Request a **new** reset email after this Pages deploy. Old emails can still point at a previous URL. Hosted Site URL must remain `https://salahassi.github.io/tenders/`. |
| Scheduler | Hosted dispatcher configuration is absent. The first activation failed because pg_net installation had no schema under an empty search path. | `20261015220000_dispatcher_extension_schema.sql` is implemented and locally verified but **not applied**. Two connector application attempts ended without success; a fresh hosted read confirmed the old function remains. Do not repeat via another mutation channel or claim a heartbeat. |
| Published browser | Desktop login and password-reset navigation visually checked without sending email; the legacy `?mode=demo#/dashboard` URL still requires sign-in. The Owner can open the workspace. Chrome 154 on the production bundle showed the app-shell skeleton while loading, at desktop and a 390px width, with no “Check access again” during that wait. Hide removed overview Processing health; Show restored it; Settings “Show on the overview” turned it off and a reload kept it off. That bundle is what [Pages run 38825944454](https://github.com/salahassi/tenders/actions/runs/38825944454) published. | The Chrome check used an empty fixture workspace, so it is not an Owner session on the hosted API. No hosted mobile journey was completed. |
| Models and sources | Gemini/Qwen adapters, policy, quota controls, source adapters and worker handlers are implemented. | No provider credential, model call, approved live source or business evaluation is activated. The empty deployment host list must remain until real sources are reviewed. |

The scheduler correction supplies explicit extension schemas while preserving the empty search path and admin-only execute permissions. It also evaluates the notification recipient identity once without changing membership authorization. The unresolved database-advisor warning therefore remains until the migration is applied. The security review found three intentional private tables with deny-by-default row-level security and 20 authenticated privileged functions with explicit authorization checks; it did not establish a warning-free project. Performance notices also include unused indexes in the empty workspace and unindexed foreign keys; these are recorded rather than disguised as failed business tests. See the [security function advisory](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [private-table advisory](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), and [notification performance advisory](https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan).

## Stage status and remaining acceptance

| Stage | Implemented and locally verified | Remaining evidence required to close the stage |
| --- | --- | --- |
| 1. Identity and core records | Invitation-only email/password, restricted first Owner, five-active-user cap, Owner/Editor/Reviewer authorization, revisions, atomic audit and idempotency, core persistence. Hosted schema/API and interface deployed. | Actual Owner accepts invitation; signed-in create/reload/second-session persistence; invitation acceptance/revocation and role denial through hosted API; confirmation/recovery callbacks and mobile forms. |
| 2. Files and scoped review | Exact-byte original eligibility, private upload/download reservations, size/signature/hash verification, immutable extraction blocks, confirmed evidence packages/addenda, company facts, text/file/combined review, resumable retries. | Actual authorized prepare → upload → complete → download preserves bytes. Real scoped inputs survive reload; unauthorized/expired uploads fail. Representative scanned and Arabic documents retain explicit readability limits. |
| 3. Collection and background operation | Bounded RSS/Atom/JSON and permitted-directory adapters, source/import review, immutable snapshots, deduplication, leases, retries/cancellation, heartbeat and notifications. | Apply dispatcher correction, activate with empty allowed hosts, verify real cron/worker heartbeat. Then add an Owner-approved source and verify browser-closed collection, repeat collection and pause. |
| 4. Free model integration | Gemini/Qwen adapters, exact content consent, free-only policy, verified quota expiry, reservations, daily/rate limits, unknown-usage accounting, no paid fallback. | Owner chooses provider/model/account, supplies backend credential and verifies effective free limits. Make a limited authorized live call only then. Model choice remains deferred. |
| 5. Assessment and generation | Cited weighted fit and reassessment, human decisions preserved, RFP inventory/questions, persisted split/repair checkpoints, full proposal generation/regeneration, bounded complete feedback processing, server decimal commercial/delivery calculations, evidence-bound approval. | Real notice → confirmed RFP → generated proposal → feedback → revised version with supported claims and approved commercial inputs. Validate actual provider output separately from deterministic fixtures. |
| 6. Export, submission and recovery | Bilingual draft/final Word, version/hash-bound artifact authorization, combined/separate volumes, manual acquisition/submission history, complete original-inclusive backup/atomic restore, actor separation, archive/retention/purge. Fifteen rendered export pages visually checked; two-database recovery fixture passed. | Update fields and review pagination in actual Word; test signed-in hosted artifact download and a controlled real cloud backup/restore. No automatic payment or bid submission is included. |
| 7. Verification and operations | Deadline maintenance, bounded private object cleanup, status/usage/capacity UI, delayed-worker signal, reference-checked deletion, AT01–AT30 mapping, held-out evaluation CLI and three increasing synthetic RFP fixtures. | Hosted scheduler/cleanup and real-session desktop/mobile journeys; Owner-labeled evaluation data and actual model output. Do not count synthetic fixture accuracy as business accuracy. |

## Exact continuation point

1. The latest application is already published. Keep remote changes and verify the branch head before another checkpoint.
2. Apply the saved dispatcher correction through the authorized Supabase connector when its migration operation can complete. Keep the empty search path and existing access controls. Verify the recorded migration before retrying any uncertain operation.
3. Invoke administrative `configure_dispatcher` with the actual project URL and an empty hostname array. Verify cron registration, worker authentication and actual `last_dispatch_at`/`last_worker_at`. No credential should appear in output. This is real processing, not traffic solely to prevent free-project pausing.
4. Finish the actual Owner invitation acceptance using the existing confirmed identity. The email is already supplied; do not ask again, fabricate an identity, reset its password or rotate an unexpired invitation without a need. Then complete the hosted account, Storage, role and recovery acceptance above.
5. After deliberate model/source activation and eligible business inputs, execute the real generation and held-out evaluation journeys. Until then, keep those rows pending.

## Decisions that are already settled

- Keep all builds connected-only; synthetic data and local providers are automated test fixtures only.
- Keep the same repository, separate `frontend/` and `backend/` folders, GitHub Pages hosting, and Supabase backend.
- Use **email and password with Owner-issued invitations only**. Do not activate Google, Apple, Facebook, or GitHub login.
- First-Owner setup must be restricted to the owner's selected email, require confirmed identity, expire, and close after initialization. No first-visitor promotion or invented owner account.
- Preserve the approved interface: select an opportunity, upload its request for proposal (RFP), generate the complete linked proposal, then review section/question-specific text and attachments and request a new version. Do not restore manual outlines or removed classification selectors.
- No automatic purchase, payment, external bid submission, or external notification. No paid dependency or paid fallback.
- Model selection remains an explicit later decision. Do not activate the historical model named in the specification.
- Every stage requires relevant integration tests. A stage is complete only when its stated acceptance evidence exists; code, tests, and deployment are tracked separately.

## Mapping to the original specification

| Original milestone | Current stage(s) | Implemented result and outstanding acceptance |
| --- | --- | --- |
| M1: local workspace | 1–7 interface | Superseded by connected-only operation; synthetic local persistence is confined to tests. |
| M2: authenticated persistence | 1–2 | Durable records/files are implemented and deployed; actual Owner/session/Storage acceptance is pending. |
| M3: sources and queue | 3–5 | Adapters and persistent queue are deployed; scheduler activation and approved real source remain pending. |
| M4: analysis and writing | 4–5 | Full generation/regeneration and calculation pipeline is implemented; model activation and business evaluation remain pending. |
| M5: export and operations | 3, 6, 7 | Export, submission history, complete recovery and maintenance are implemented; hosted scheduler/real-account acceptance remains pending. |
| M6: activation/evaluation | All, especially 7 | Deterministic checks and deployment evidence are recorded; no blanket hosted or model-quality acceptance. |

## Acceptance mapping: AT01–AT30

Local implementation and deterministic verification are recorded below. Hosted acceptance and business validation are separate; pending owner inputs are not marked passed. Earlier stage checkpoints above are historical evidence, not current unfinished-code descriptions.

| IDs | Implemented behavior | Local evidence | Remaining live acceptance |
| --- | --- | --- | --- |
| AT01–AT04 | Approved-source scheduling, pause/manual blockers, replay deduplication, immutable material-change snapshots and preserved human decisions. | collection.test.ts; collector.test.ts | Permitted real source and hosted scheduling. |
| AT05–AT08 | Grounded weighted fit, uncertain/title-only routing, stable declined decisions under reassessment, unresolved ambiguous dates. | model.test.ts; generation.test.ts; operations.test.ts | Owner-labeled held-out data and live model. |
| AT09–AT10 | Exact original eligibility, content authorization, prompt-injection data boundary, no model tools or external business actions. | contentEligibility.test.ts; model.test.ts; modelPolicy.test.ts | Owner-approved actual content and model activation. |
| AT11 | Auth membership/RLS, Owner-only commands, review authorship, private Storage design and historical non-authenticating actors. | database.test.ts; onboarding.test.ts; evidence.test.ts; operations.test.ts | Real signed-in role, object and cross-workspace journeys. |
| AT12–AT16 | Manual acquisition, confirmed RFP gate, extraction blockers, cited inventory, addendum invalidation, exact company-claim evidence and missing-input questions. | commercial.test.ts; evidence.test.ts; generation.test.ts; proposalPackages.test.ts | Representative real RFP and authenticated upload/generation. |
| AT17–AT18 | Server decimal calculations, markup/margin fixtures, zero/unknown rates, tax/period/FX/payment rules and delivery dependencies. | finance.test.ts; commercial.test.ts; proposalPackages.test.ts | Owner-supplied approved rates and assumptions. |
| AT19–AT21 | Version/evidence-bound approvals and export authorization, reviewed artifact hashes, editable bilingual Word and manual submission history. | commercial.test.ts; exportRenderer.test.ts; EXPORT_QA.md | Real Word field update and final artifact attestation; hosted account journey. |
| AT22–AT24 | Free-only ledger, reservation/unknown usage, rate/day caps, leases, cancellation, persisted split/repair checkpoints. | modelPolicy.test.ts; model.test.ts; generation.test.ts | Actual provider quota and hosted worker crash/timeout conditions. |
| AT25–AT27 | Hostname/DNS/redirect/size boundaries, actual hash/signature/parser caps, revisions and atomic audit/idempotency. | collector.test.ts; contentEligibility.test.ts; api.test.ts; evidence.test.ts | Authenticated hosted Storage and commands. |
| AT28 | Superseded demo requirement: connected-only login; no simulated persistence or query bypass. | connected.test.tsx; AuthPanel.test.tsx; app.test.tsx | Published mobile and signed-in persistence. |
| AT29 | Actual heartbeat/storage/queue/usage screen, 10-minute delayed signal and reference-checked cleanup. | operations.test.ts; worker handler tests | Hosted cron heartbeat and cleanup. |
| AT30 | Original-inclusive bounded backup, complete graph restore into clean matching schema, actor separation and approval reset. | recovery.test.ts; backupFormat.test.ts | Owner-run real cloud backup/restore. |

## Verification commands and maintenance

Run `npm run typecheck`, `npm test`, and `npm run build` in **both** `frontend/` and `backend/`. Each has its own lockfile. Normal checks use synthetic fixtures only and must not invoke real model APIs. The recovery, authorization, financial and evaluation checks are part of the backend suite, not extra counts to add to the total.

Read and update this checklist for every project change. Record implementation, test, source publication, hosted deployment and real-account acceptance separately. Record the exact Pages run after a source deployment completes. Preserve all stages and AT01–AT30 traceability. An unresolved connector operation, unavailable session or missing business input must remain explicit rather than being marked complete.
