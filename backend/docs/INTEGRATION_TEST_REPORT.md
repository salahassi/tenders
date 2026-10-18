# Integration and hosted acceptance report

Verified October 18, 2026 (Asia/Riyadh). Full activation and integration/browser testing are authorized. Local fixtures, hosted transport/database evidence and actual browser journeys are separate. Authenticated Owner browser access works; its available automation tools cannot create/select upload files.

## Current deployed and local baseline

- API **v15** / worker **v12**, all 14 retained files each match source `a2c3bb0e7aad4092054a04ae7cf8e46184de87de`. Fifty hosted migration entries are reconciled in DEPLOYMENT.md. The minute scheduler and automatic round robin are enabled.
- PDF browser fix `2d8380ec981ab43a386e194efef0c3b1221a789f` published successfully in [Pages 39080451104](https://github.com/salahassi/tenders/actions/runs/39080451104). Discovery-access UI publication is pending.
- **171 backend tests/21 files and 141 frontend tests/26 files**, both typechecks/builds passed. Deno checked the deployed runtime. Two concurrent frontend runs hit journey timing limits; final isolated full frontend run passed without weakened assertions/timeouts. Existing large-bundle warning remains.
- Four exact-URL official collectors produced 35 actual opportunities/snapshots: GTD 6, An-Najah 19, Ramallah 10, IsDB 0 open notices. Owner browser pause/resume persisted Ramallah revision 4. The stale repeat job was canceled by the verified follow-up; fresh collection is queued. Other 31 directory references remain manual.
- Owner browser saved/reloaded the real public company note, verified revision 2 and authorized exact company/notice text for Gemini. Actual assessment completed at 00:01:01 UTC: one settled request, **798 input / 1,400 output tokens**, needs_review, coverage 0 and unknown fit score. Sparse notice evidence is not treated as a failed requirement or a fabricated numerical fit.
- Actual Chromium extracted an 87-page public Arabic/English procurement PDF: 143,462 characters, ready status, exact original SHA-256 and no page errors. This found/fixed the PDF.js worker handshake regression. Local extraction is not hosted Storage acceptance.
- Actual cloud metadata recovery: all 437 hashed rows restored via production RPCs into separate local PostgreSQL; 35 opportunities, 35 sources and one note; sources paused and identities not copied. Snapshot had zero files; hosted/original-inclusive restoration remains unverified.
- Hosted runtime health/auth/worker boundaries and actual Owner session persistence were previously verified; final follow-up checks are recorded below when completed. Security advisor counts remain 3 private-table INFO, 20 deliberate authenticated security-definer WARN and 1 disabled leaked-password-protection WARN; this is not a warning-free project.

## Local integration coverage

`continuousModel.test.ts` composes real PostgreSQL policies/leases/usage accounting with the production worker and explicit provider transport fixtures. Thirteen scenarios verify continuous attestation without fake quota values, restricted Gemini/Owner/content boundaries, idempotent operational probes, automatic recovery from headerless 429, bounded Retry-After/backoff, daily application budget renewal, no automatic resend after uncertain usage, independent continuous jobs, same-hash/pending-reservation guards, and conservative unknown-usage budgets. These are real local database/worker integration tests, not a claim that Google's quota was deliberately exhausted.

`httpDatabase.integration.test.ts` joins the production API/worker handlers to canonical PostgreSQL commands and RLS. It covers source creation/approval/collection/deduplication, Gemini-only policy persistence and role/revision denial, and original-byte verification with extraction and replay protection. Auth token verification, object transport, DNS and feed responses remain explicit local test doubles.

`sourceCatalog.test.ts` covers catalog validation, reference/audit insertion without business jobs, replay and user-edit preservation, capacity rollback, active-Owner/browser-role denial, and safe SQL quoting. Three connected UI regressions cover portal display/filtering, access details, and correct attribution of user-entered opportunities.

Run `npm run test:integration -- --maxWorkers=2` from `backend/` for the database/onboarding/composed HTTP/catalog group. Full package checks remain `npm run typecheck`, `npm test -- --maxWorkers=2`, and `npm run build` in both packages.

## Hosted official source directory

The reviewed catalog contains **35 official destinations: Saudi Arabia 14, Jordan 11, Palestine 10**. It was applied to the existing TenderDesk workspace through the tested administrative seeder at 14:07 UTC. Read-back found 35 distinct sources and 35 audit events. Reapplication preserved every source and audit count; ordered source-row hash remained `597be706a186c46a5c47f97380cc2bbc`.

Sources are real reference records, not fabricated opportunities. All 35 are currently manual references requiring a suitable collection adapter; they have no approved collection hosts or schedules. Supplier-registration pages, central platform referrals, and public tender listings remain distinct. See [catalog evidence and reuse instructions](../seeders/README.md).

## Actual authenticated browser evidence

The Owner signed into a TinyFish setup browser and confirmed readiness. Its saved browser state was reused successfully even though TinyFish's `signed_in_sites` metadata remained empty. No credentials or tokens were extracted or added to this repository. These are live browser observations on the published app, not a jsdom fixture.

| Journey | Actual observation | Evidence |
| --- | --- | --- |
| Authenticated source directory | The saved session opened TenderDesk with 35 sources; Saudi filtering showed 14 and Palestine 10. Arabic search for `المنافسات` produced five matching Saudi entries. | TinyFish run `235d9614-ce50-4711-9130-9fc780a40ce1` |
| Source details and reload | Opened `الملكية الأردنية — بوابة المشتريات`, source `56020167-e3ee-5e1d-9881-c79cb5852aa6`. Its official URL was `https://procurement.rj.com/`, with the expected Arabic access notes and Manual review method. No Enable source button was present. Title, URL, notes and method remained after reload. | TinyFish run `e8c63fb1-4622-4fc3-a85c-b35666b404be` |
| Owner preference write and reload | Changed only Source polling interval from **6 → 12**, saved, and verified **12** after reload. Restored **6**, saved again, and verified **6** after another reload. Both saves displayed `Workspace preferences saved to your account.` | TinyFish run `9f492648-8235-45a9-85fe-cde5a08685c5` |
| Independent database confirmation | At **14:58:15 UTC**, workspace revision was **3**, polling interval **6**, with two `workspace.settings` audit events by the actual Owner at **14:56:45.918578** and **14:57:15.829262 UTC**. The other effective preference values remained their defaults. | Hosted Supabase read-back |

A focused follow-up, TinyFish run `e14999cd-988c-4b1d-84ab-788feeba3224`, cleared search and set country JO with status All sources. It read exactly `11 sources · open a source for its official link and access notes` and counted **11** table rows. The global Not enabled metric remained 35 as designed. Earlier search/filter ambiguity is resolved; no filtering defect was found. Dashboard, Opportunities, Activity & jobs, and Settings loaded through actual sidebar navigation without errors. Operations displayed scheduling enabled and the current heartbeat; model controls remained unconfigured.

Fresh anonymous run `08ed8172-8641-4515-b296-531748e63190` opened `#/sources`, `#/settings`, and `?mode=demo#/dashboard`. All three showed the sign-in screen without workspace data or a demo workspace. TinyFish did not provide viewport resizing, so mobile acceptance was not tested.

At the post-write database check, there were still 35 sources and **zero** jobs, opportunities, documents, and model policies. The preference test created no fabricated business records or provider calls. Saving writes explicit default preference values into the settings object; it does not restore the original empty JSON representation. It restores the original effective settings.

TinyFish run `c10e3e26-c210-4681-9da3-5cdd04dafc77` clicked **Download complete backup** once. The UI confirmed `Backup verified and downloaded, including all listed originals.` The tool did not return a filename or archive bytes. This verifies the live backup flow for the current reference-only workspace; it does not establish original-byte backup or restore. No restore was attempted. The model fields in this run were from the earlier bundle, and its ambiguous accessibility report is not configuration evidence.

Browser run summaries are the evidence available from TinyFish. No screenshot files were returned for independent image inspection, even though capture was requested. Do not claim pixel-level or mobile acceptance from these desktop summaries alone.

## Remaining acceptance

| Journey | Verified portion | Remaining evidence |
| --- | --- | --- |
| Identity and persistence | Real Owner session, all country filters, source-detail reload, preference write/reload/restore and server audit, desktop navigation, anonymous route/demo denial | Explicit sign-out/revocation, additional invitations/roles, mobile navigation |
| Source collection | Real catalog persistence and local collector integration | Suitable adapter/feed for a selected public listing, host configuration, actual collection/deduplication/pause and browser-closed collection |
| Original evidence | Local exact-byte hash and eligibility workflows | Eligible real RFP upload/download, extraction review and hosted original-byte persistence |
| Model and generation | Continuous Gemini enabled; actual diagnostic inference and 294/11 measured tokens; local full proposal pipeline and recovery/quota tests | Eligible content authorization and persisted hosted business generation from real RFP/company inputs |
| Review and commercial flow | Local supported-claim, feedback, calculation and approval tests | Real RFP/company inputs, scoped feedback/regeneration, approved rates/assumptions and evidence-bound approval |
| Export and recovery | Local bilingual Word and two-database recovery tests; live current-workspace backup completion | Actual artifact download/Word field review, archived-byte/original inspection, and restore to an empty matching-schema target |

The Owner confirmed the required Gemini values were already saved in Supabase Secrets. Google account login is not required to read the configured model identity. The existing environment loader reads provider-specific or legacy name/project/key settings; it does not read billing attestations or quota values from secrets. An Owner-only metadata route and settings prefill passed local security and UI tests and were deployed to use that configuration without returning keys. This is a presence/matching check, not proof of provider authentication, free billing, or remaining quota. No billing or quota facts have been invented.

Actual Owner browser run `f5b476d6-ac19-4372-ab26-b2795428c395` loaded the new deployed panel. It read exact model `gemini-3.8-flash`, a populated project input and the status `API key is configured on the server. Model and project loaded from server configuration. Verify free quota before enabling.` Billing verification and activation were unchecked. No load or authorization error occurred. The account-specific project identifier is intentionally omitted from this report. This confirms configured secret presence/identity, not successful Google authentication or inference. The Owner was asked only for free-tier/quota facts without Google login or key disclosure.

Independent SQL at **15:19:38 UTC** confirmed workspace revision 3, polling interval 6, 35 sources, and zero model policies, provider usage, jobs, opportunities and documents. Heartbeat was fresh. At that historical checkpoint, model execution and real collection remained explicitly unaccepted despite the passing infrastructure, settings and directory journeys.


## Continuous free-tier activation

The Owner confirmed free-tier billing for the configured Gemini 3.8 Flash project and requested continuous operation without manual quota facts. This supersedes the earlier request for provider balance/expiry data. `provider_managed` mode stores those fields as null and keeps the Owner attestation without a 30-day shutdown. Provider 429 waits and application daily limits remain automatic; uncertain generation usage remains blocked by job/hash and conservatively charged, without stopping independent work on the same continuous Gemini model.

The migration was applied in three verified connector entries and API v9/worker v5 were deployed. Hosted health 200 and anonymous/invalid worker denial 401 passed. Actual Owner run `a8a4ff8e-2751-470a-a8f6-f307067ab389` saved Gemini enabled with `provider_managed` mode and null quota/expiry. Application daily limits remain 50/250000/50000. It queued the first operational check exactly once. The scheduler claimed it at 17:59:01 UTC; token counting succeeded, reserving 563 input and 256 output tokens. Generation over Interactions timed out at 90 seconds; the request was recorded unknown and blocked with `MODEL_NETWORK_UNCERTAIN`. Actual usage is not invented. Fresh browser run `ce19f686-c95c-40c9-9335-662b5e370211` confirmed the blocked attempt and saved policy match the database. The first run's stale queued display was not completion evidence.

The follow-up uses documented stateless `generateContent`, JSON output and low thinking for the bounded operational check. Thought usage is reported or derived only from measured prompt/candidate/total counts; absent measurements stay unknown. API v10/worker v6 and the independent-request migration are verified deployed. A new actual Owner check is in progress; no live model success is claimed yet.

The first `generateContent` check and a separate instrumented diagnostic both received HTTP 400. The latter used fixed diagnostic labels only (`unsupported`, `thinking`, `model`), and browser run `0f612eb1-32f5-41cc-908c-bfd321d93c11` confirmed blocked/attempt 1 after full reload. The initial probe used `MINIMAL`, which [Gemini 3.8 Flash documentation](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) explicitly rejects. Corrected to `LOW` and deployed API v11/worker v8 with exact file read-back. A fresh real check is in progress. The original unknown record is retained. No unknown request was replayed or reconciled with invented usage.

## Durable background continuation

The supported LOW request also timed out at 18:23:32 UTC. Browser run `498a3fc4-a1eb-4b39-b5a6-c166d92d1ccb` ended while showing running; independent SQL later confirmed blocked/unknown. There are two preserved unknown requests and two explicit HTTP 400 rejections; none establish successful inference.

Background continuation is implemented with persisted request identity, GET-only polling, a 23-hour deadline, finite scheduling, and lease recovery. Local composed tests cover polling network loss and 429, one reservation across repeated polls, worker interruption, identity/cancellation boundaries, expiration without replay, and the entire proposal pipeline with real PostgreSQL/production generation code plus explicit provider fixtures. That pipeline exposed and fixed missing commercial-scope provenance when there were no approved rates or explicit commercial requirements. The later completion checkpoint below supersedes this initial pending-deployment status.

Actual background check `09723679-9b08-46a5-b804-52614be4e86f` was queued by the Owner browser at 18:47:26 UTC. At 18:48:06 UTC the worker had saved Google's real request ID and entered finite `MODEL_IN_PROGRESS` waiting, with exactly one reserved usage row. No measured completion is claimed at this checkpoint. The prior five diagnostic jobs remain unchanged (two unknown synchronous calls and three explicit request rejections). Provider request IDs and project identifiers are omitted from this report.

At **21:50:06 Riyadh (18:50:06 UTC)** that actual background check completed with checkpoint `ready` and exactly one settled provider row: **294 input, 11 output, 0 thinking tokens**. Two worker attempts represent create plus GET continuation, not two generation calls. Gemini remains enabled. The earlier five diagnostic jobs and their uncertainty/rejection evidence are preserved. The same browser run's final report incorrectly identified an old blocked row; it is not completion evidence. Jobs now sorts newest first with Riyadh creation times. Read-only TinyFish run `f4f91162-26ec-4cd8-bbed-4aac5be79cc6` verified the newest check (created 21:47 Riyadh) as completed, 100%, attempt 2, with `Gemini connection verified; measured usage recorded.` The same row persisted after a full reload. Settings still showed Gemini enabled and `Continuous free tier`. The two attempts are create plus result retrieval, not two generation calls. No mutation or additional model call was made by this verification. No cleanup failure was logged after application completion; tests verify DELETE occurs only after commit and cleanup failure preserves the committed result.

## Automatic round robin — implementation verification

The new composed `roundRobin.test.ts` uses actual PostgreSQL policies, leases, command authorization, reservations and the production worker with explicit provider-response fixtures. It covers absent/disabled provider policies, all missing credentials, 400→401→429→success, persistent four-provider rotation, uncertain calls retained while another provider succeeds, no repeat of ambiguous same-provider/input calls, known Gemini request retrieval before another generation, GET failure failover, global daily caps, exact per-provider content permissions, service-only RPC grants and free-only confirmation boundaries. The full production proposal-pipeline fixture additionally completes across multiple providers after an initial rejection. No actual provider outage or free-limit exhaustion is claimed from these fixtures.

Pre-deployment read-only browser run `32a46725-2356-489e-9b22-cd72a27e8c21` confirmed only Gemini has server key/model/project configuration; Qwen, Mistral and Groq have none. Live alternative-provider inference cannot be verified without their actual configuration. The run returned no credential values.


Owner browser run `b19f7a39-bd78-477c-bd34-4b4760a0e45f` enabled automatic round robin and confirmed the saved switch after reload, then queued exactly one real operational check. The browser reported an early/stale job state; independent SQL establishes the lifecycle. Job `8917afe5-4060-4a2b-8260-dbca24f87248` recorded Qwen/Mistral/Groq as `MODEL_NOT_CONFIGURED`, `sent=false`, and completed using Gemini at **00:21:07 Riyadh, October 18 (21:21:07 UTC, October 17)**. There is exactly one settled generation reservation with **291 input tokens and 99 output tokens including 88 thinking tokens**. Its two worker attempts represent creation and retrieval. Existing diagnostic evidence remains unchanged; no business records were fabricated.

Review of the pending-request case found that result polling also advanced the routing cursor. The forward migration `20261017212026_preserve_round_robin_cursor_on_poll.sql` corrects this: retrieving an existing request leaves the cursor untouched, even when another job has advanced it. The strengthened composed regression and both complete suites pass again (160 backend/133 frontend). No new inference was needed to validate this scheduling-only correction. Final read-only browser completion/reload verification passed as recorded below.


The final `deterministic_global_model_rotation` forward migration explicitly orders the SQL provider pool by its stored ordinal and chooses the current global cursor for a fresh retry round. The regression interleaves a failed job, a second job succeeding on Qwen, then the first job resuming on Mistral. All **161 backend tests across 20 files** pass. Result polling still preserves the cursor. Frontend remains unchanged from the 133-test passing build, except for the already-published generic connection-check label.

Read-only browser run `964dd841-a663-4288-bf07-d33864a3ac0e` confirmed the newest check as completed, 100%, attempt 2, with `Model connection verified; measured usage recorded.` and Qwen/Mistral/Groq missing-configuration reasons plus Gemini completed. Full reload preserved the same row and message; Settings still showed automatic round robin enabled. No additional probe or mutation was made by this run.
