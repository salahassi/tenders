# Implementation status and continuation plan

Verified October 18, 2026 (Asia/Riyadh). This file separates code, deterministic tests, deployment, and actual hosted acceptance. Requirements remain in [IMPLEMENTATION_SPEC.txt](IMPLEMENTATION_SPEC.txt); later [DECISIONS.md](DECISIONS.md) and the [frontend handoff](../../frontend/docs/FRONTEND_HANDOFF.md) apply. Historical investigation checkpoints remain in Git history and [INTEGRATION_TEST_REPORT.md](INTEGRATION_TEST_REPORT.md).

**The application is deployed with an active scheduler, real official collections and working Gemini inference. Full hosted proposal acceptance is still incomplete.** Full system activation, migrations, publication and tests are already authorized. Do not request the same permission or another Google login. Only Gemini is configured; optional provider credentials and actual tender costs must never be invented.

## Current release and completion work

- Runtime: API **v15**, worker **v12**, all 14 retained files each match source `a2c3bb0e7aad4092054a04ae7cf8e46184de87de`. Both Deno entry checks passed. Minute scheduling is active; source interval is six hours. Runtime hashes and migration mappings are in [DEPLOYMENT.md](DEPLOYMENT.md).
- Published PDF fix: source `2d8380ec981ab43a386e194efef0c3b1221a789f`, successful [Pages run 39080451104](https://github.com/salahassi/tenders/actions/runs/39080451104). PDF.js library handshakes no longer prematurely resolve/terminate document extraction.
- Four reviewed exact-URL public collectors are active: Jordan GTD, An-Najah, Ramallah and IsDB corporate procurement. Real scheduled collection produced **35 opportunities and 35 snapshots**: 6 GTD, 19 An-Najah, 10 Ramallah; IsDB completed with no open notices. The other 31 official directory entries remain manual destinations, not active collectors. See [SOURCE_COLLECTION.md](SOURCE_COLLECTION.md).
- Owner browser saved and reloaded the user-supplied public IIH company profile and verified it (revision 2). Its exact text and one actual Ramallah notice are authorized for Gemini. No claims of certifications, past projects, staff availability, rates or commercial approvals were fabricated.
- Tender costs now have direct dated scope-specific entry with auditable Owner approval and retry without duplicate creation. Currency is suggested from country (SAR/JOD/ILS), with tender requirements taking precedence and existing saved estimates preserved. A fixed company price list is not required.
- Owner browser exposed processing controls hidden until shortlisting. The current change exposes assessment/progress/resume/cancel for an unselected discovery and removes obsolete disconnected messages. Role restrictions and expected revisions remain intact. All 143 frontend tests/26 files and typecheck/build passed; published by [Pages 39081277000](https://github.com/salahassi/tenders/actions/runs/39081277000), source `82e9ffbd63ccb74c7e47f7bfd6f375920d67d2b4`.
- Queue migration `20261017234946` is deployed as hosted `20261017235442`. Claim hash `8cc7ff949e99c9763a476dcbe6e5a4e5`; authenticated execute false, service execute true. A follow-up covers source jobs already blocked by STALE_INPUT and all saved generation continuation stages. The follow-up is deployed as `20261018000051`; canonical file `20261017235819`, claim MD5 `9e8c911861a7c48d91fce7b7fbdfebda`, unchanged service-only grants. All 171 backend tests/21 files and typecheck/build passed. Exact content permissions remain enforced.
- Final application checks: **171 backend tests/21 files and 143 frontend tests/26 files**, both typechecks/builds passed. The private actual-metadata recovery drill also passed separately. Concurrent package runs hit the existing UI journey timing limit; the isolated final frontend run passed every test without changing timeouts or assertions. Do not count retries as extra tests.

## Actual browser and data evidence

- Real Owner TinyFish profile works. Directory filters/details, preferences/reload, navigation, Gemini configuration, automatic round robin and completed diagnostic reload are verified. Do not fabricate an account or rotate credentials to obtain another session.
- Public IIH note save/reload: run `1a853873-0f10-4149-b641-df719ece93c8`. Verification and exact Gemini content permissions: `ed2fe939-6e85-4654-bb32-0e37f63f430d`.
- Ramallah source pause/reload/resume: run `4bd07bee-03f3-467f-b5f2-325dd8a61f2f`, independently confirmed at source revision 4. The old repeat job blocked on its earlier revision; latest migration canceled that obsolete job and queued revision 4. The revision-4 repeat succeeded at 00:02:04 UTC, processed the same 10 notices, and preserved totals at 35 opportunities/35 snapshots with zero duplicate source identities.
- Actual Chromium extracted a public 87-page procurement PDF into 143,462 characters, retaining Arabic and technical English, status ready, with original SHA-256 `95249b383c62dd2fe277889fc796120694442e8882e672d0ce4fd756831c0238`; no browser errors. This revealed and verified the PDF worker fix. Public bytes/text remain outside the repository.
- Published anonymous sign-in at 390×844 was visually reviewed with no horizontal overflow. Authenticated mobile is not established by this result.
- Actual cloud snapshot: **437 metadata rows, zero files**. Every row hash passed, and production restore RPCs restored it into isolated local PostgreSQL with 35 opportunities, 35 sources and one knowledge record. Restored sources were paused and access identities were not copied. Private snapshot and temporary harness remain outside the repository. This is not original-inclusive or hosted-target restoration.
- TinyFish run `bf80a51f-1139-47f6-b6a3-b6fa30e1ad1a` could not create/select upload files with its available browser tools. No actual hosted original upload happened. Do not equate local extraction or fixture object transport with hosted Storage acceptance.

## Stage status and remaining acceptance

| Stage | Implemented and verified | Remaining actual acceptance |
| --- | --- | --- |
| 1. Identity/core | Invitation-only email/password, restricted Owner, membership/RLS, revisions, audit/idempotency; actual Owner session and persisted settings. | Hosted multi-role/cross-workspace journeys and authenticated mobile forms. Do not create fake cloud users. |
| 2. Files/review | Private original reservations, byte/signature/hash checks, extraction/packages/addenda, scoped text/files/retries; actual Arabic PDF extraction and verified company note. | Eligible real original prepare → upload → download with exact bytes in hosted Storage. Browser tool lacks file-input capability. |
| 3. Collection/background | Four public collectors deployed, 35 real notices, minute scheduling, immutable snapshots, deduplication fixtures, actual pause/resume. | Hosted repeat/pause/resume/deduplication passed; other portals require their own suitable public feeds/adapters. |
| 4. Free providers | Gemini live inference/usage and background retrieval verified. Automatic Gemini → Qwen → Mistral → Groq round robin enabled; missing config skipped without HTTP. Unknown usage retained without same-input resend. | Actual alternative inference requires genuine free-only account configuration. Simulated outage/quota cases are explicitly local fixtures. |
| 5. Assessment/proposals | Grounded weighted assessment, persistent generation/regeneration, feedback, decimal costing/delivery, evidence-bound approval; full production pipeline integrated against local DB/provider fixtures. | Live notice assessment completed at 00:01 UTC with insufficient evidence (no invented score); eligible confirmed RFP → real proposal → scoped feedback → regenerated version and approved actual costs. No invented prices or approvals. |
| 6. Export/recovery | Editable bilingual draft/final Word, content/hash-bound authorization, separate volumes, manual submission history; 15 fixture export pages visually checked; actual cloud metadata restored locally. | Hosted original-inclusive backup/restore and artifact download; actual Word field/pagination review. No buyer submission/payment. |
| 7. Operations/evaluation | Maintenance/cleanup, real heartbeat/usage/queue, AT01–AT30, increasing RFP fixtures and evaluation CLI. | Real object cleanup, authenticated mobile and Owner-labeled business-quality evaluation. Synthetic scores are not business accuracy. |

## Exact continuation point

1. Package checks and both queue migrations passed. Commit/publish discovery-access UI and record the successful Pages run.
2. Verify the in-progress real Ramallah notice assessment and repeat collection via SQL and actual Owner browser, retaining measured usage and deduplication evidence.
3. Complete any remaining browser/technical checks that do not depend on missing original-upload capability or genuine business inputs. Record limitations, not false passes.
4. Full hosted proposal/export acceptance requires an eligible complete RFP plus its actual pricing/capacity decisions. The public 87-page PDF used for extraction contains contact/confidentiality content and was not silently approved/uploaded. The user supplies company details through their public website; prices are determined per tender scope and currency.
5. Existing credentials, content permissions, reservations and uncertainty must be preserved. No external invitation/email, purchase or bid submission is authorized.

## Settled decisions

- Connected-only builds; synthetic users/company claims/business data remain test fixtures only.
- Keep GitHub Pages, Supabase and separate frontend/backend packages.
- Owner supplied the company website; public sourced notes are allowed. No invented certifications, projects or rates.
- Selection → confirmed RFP → full linked proposal → scoped review/questions → regenerated version remains the workflow.
- Gemini Free is confirmed by the Owner. Do not require account login or invented quota-reset facts. Provider quotas/application budgets use persisted automatic retry; unknown generation usage never permits blind resend.
- Automatic optional-provider rotation is authorized independently of individual provider enable switches; real secrets/free-only configuration and exact content authorization remain required.
- Implementation, local tests, publication, hosted acceptance and output quality are different statuses.

## Mapping to the original specification

| Milestone | Current result |
| --- | --- |
| M1 local workspace | Superseded by connected-only production; local simulation is tests only. |
| M2 persistence | Auth/metadata verified in real session; original Storage journey pending. |
| M3 sources/queue | Four active real collectors, durable queue and scheduler; remaining portals manual. |
| M4 analysis/writing | Complete integrated pipeline; Gemini inference verified; actual proposal acceptance pending. |
| M5 export/operations | Export/recovery implemented and tested; actual metadata recovery and scheduler verified. |
| M6 evaluation | Local deterministic and partial hosted evidence recorded separately; no blanket quality acceptance. |

## Acceptance mapping: AT01–AT30

Local implementation and deterministic verification are recorded below. Hosted acceptance and business validation are separate; pending owner inputs are not marked passed. Earlier deployment and investigation checkpoints remain in Git history and the integration report.

| IDs | Implemented behavior | Local evidence | Remaining live acceptance |
| --- | --- | --- | --- |
| AT01–AT04 | Approved-source scheduling, pause/manual blockers, replay deduplication, immutable material-change snapshots and preserved human decisions. | collection.test.ts; collector.test.ts | Four public collectors and scheduled first collections verified; repeat after source revision recovery is being checked. |
| AT05–AT08 | Grounded weighted fit, uncertain/title-only routing, stable declined decisions under reassessment, unresolved ambiguous dates. | model.test.ts; generation.test.ts; operations.test.ts | Owner-labeled held-out data and live model. |
| AT09–AT10 | Exact original eligibility, content authorization, prompt-injection data boundary, no model tools or external business actions. | contentEligibility.test.ts; model.test.ts; modelPolicy.test.ts | Gemini activated; exact public notice/company evidence authorized. Full RFP eligibility remains separate. |
| AT11 | Auth membership/RLS, Owner-only commands, review authorship, private Storage design and historical non-authenticating actors. | database.test.ts; onboarding.test.ts; evidence.test.ts; operations.test.ts | Real signed-in role, object and cross-workspace journeys. |
| AT12–AT16 | Manual acquisition, confirmed RFP gate, extraction blockers, cited inventory, addendum invalidation, exact company-claim evidence and missing-input questions. | commercial.test.ts; evidence.test.ts; generation.test.ts; proposalPackages.test.ts | Representative real RFP and authenticated upload/generation. |
| AT17–AT18 | Server decimal calculations, markup/margin fixtures, zero/unknown rates, tax/period/FX/payment rules and delivery dependencies. | finance.test.ts; commercial.test.ts; proposalPackages.test.ts | Owner-supplied approved rates and assumptions. |
| AT19–AT21 | Version/evidence-bound approvals and export authorization, reviewed artifact hashes, editable bilingual Word and manual submission history. | commercial.test.ts; exportRenderer.test.ts; EXPORT_QA.md | Real Word field update and final artifact attestation; hosted account journey. |
| AT22–AT24 | Free-only ledger, reservation/unknown usage, rate/day caps, leases, cancellation, persisted split/repair checkpoints. | modelPolicy.test.ts; model.test.ts; generation.test.ts | Actual provider quota and hosted worker crash/timeout conditions. |
| AT25–AT27 | Hostname/DNS/redirect/size boundaries, actual hash/signature/parser caps, revisions and atomic audit/idempotency. | collector.test.ts; contentEligibility.test.ts; api.test.ts; evidence.test.ts | Authenticated hosted Storage and commands. |
| AT28 | Superseded demo requirement: connected-only login; no simulated persistence or query bypass. | connected.test.tsx; AuthPanel.test.tsx; app.test.tsx | Published mobile and signed-in persistence. |
| AT29 | Actual heartbeat/storage/queue/usage screen, 10-minute delayed signal and reference-checked cleanup. | operations.test.ts; worker handler tests | Hosted cron heartbeat verified; real original-object cleanup remains untested. |
| AT30 | Original-inclusive bounded backup, complete graph restore into clean matching schema, actor separation and approval reset. | recovery.test.ts; backupFormat.test.ts | 437 actual cloud metadata rows restored into isolated local PostgreSQL. Original-inclusive hosted restore remains untested. |

## Verification commands and maintenance

Run `npm run typecheck`, `npm test`, and `npm run build` in **both** `frontend/` and `backend/`. Each has its own lockfile. Normal checks use synthetic fixtures only and must not invoke real model APIs. The recovery, authorization, financial and evaluation checks are part of the backend suite, not extra counts to add to the total.

Read and update this checklist for every project change. Record implementation, test, source publication, hosted deployment and real-account acceptance separately. Record the exact Pages run after a source deployment completes. Preserve all stages and AT01–AT30 traceability. An unresolved connector operation, unavailable session or missing business input must remain explicit rather than being marked complete.


The real Ramallah notice assessment completed at **00:01:01 UTC / 03:01 Riyadh**, with one settled Gemini request: **798 input / 1,400 output tokens**. It returned needs_review, coverage 0 and no numeric fit score because the available title/company evidence was insufficient. This proves the actual collection → authorized evidence → model → recorded assessment path; it does not establish complete RFP coverage or business model accuracy.

### Browser mobile follow-up (in progress)

Local Chromium with the isolated synthetic fixture exposed horizontal page overflow at 390px: an absolutely positioned screen-reader table label escaped its scroll container, and Knowledge tabs exceeded their flex parent. The table scroll wrapper now establishes a positioning context; tabs are bounded to the available width. All 24 Chromium desktop/mobile route and file/review/export checks passed with no JavaScript errors or external requests; original inputs and persisted Arabic answers were used. The downloaded DOCX is a valid package. These are isolated UI fixture results, not hosted Auth/Storage/model acceptance. This fixture uses no hosted accounts, objects, provider calls or fabricated cloud records.

Final hosted transport checks passed: health 200, anonymous bootstrap 401, missing/invalid worker POST credentials 401, forbidden origin 403. A preliminary GET to the worker correctly returned method-not-allowed 405; the credential tests use its supported POST. Security advisor categories/counts remain unchanged after both queue migrations (3 private-table INFO, 20 deliberate authenticated security-definer WARN, 1 disabled leaked-password-protection WARN).

Actual Owner read-only browser run `0fb194dd-c7b6-4c12-baad-63530b6ea156` confirmed the recorded insufficient-evidence assessment, pre-shortlist processing controls and reload persistence; Ramallah enabled/latest completed collection; verified IIH profile. It exposed missing processed counts in source history and browser-local timezone labels. The connected repository now attaches actual source-run counts (including zero; absent remains unknown), source jobs sort newest first, and dates explicitly use Riyadh. Source-count mapping regression passed for recorded 10, recorded zero, and absent counts. An additional regression prevents a superseded assessment from offering an invalid resume action. All 143 frontend tests/26 files and typecheck/build passed. Publication is pending.

Four additional Chromium checks passed for the local Reviewer fixture: review saving, attachment upload, opportunity creation and preference editing remain unavailable. These verify interface gates, with server authorization separately covered by the PostgreSQL/API integration tests. Actual Owner hosted browser run confirmed assessment/progress and profile reload persistence, plus newest successful Ramallah job and enabled source. No authenticated mobile or hosted original-byte upload is claimed.
