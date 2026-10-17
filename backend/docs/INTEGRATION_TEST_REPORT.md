# Integration and hosted acceptance report

Verified October 17, 2026. Full system activation and integration/browser E2E testing are authorized. This report distinguishes local fixtures, hosted HTTP/database evidence, and actual browser journeys. Authenticated browser access now works through the Owner-saved TinyFish profile. Collection adapters, verified Gemini free-quota configuration, eligible RFP/company inputs, and a separate recovery target remain necessary for the complete business journey.

## Current deployed and local baseline

- API v7 and worker v4 use application source `8c2a4b22704351d380953762922b557b729527cb`; 29 hosted migration entries include the approved corrections. Minute scheduling is active.
- The frontend source `55327cbd37bc47dd44718377ea929c431874e9d1` was published by [Pages run 39039577266](https://github.com/salahassi/tenders/actions/runs/39039577266). The public entry is `index-CS2TYTey.js`; the entry and both source-page bundles matched the tested build byte-for-byte.
- Latest application checks: **130 backend tests across 18 files**, **131 frontend tests across 23 files**, both type checks and builds, plus Deno checks in CI. These counts exclude live browser checks below. The existing large frontend chunk warning remains.
- Sixteen hosted HTTP checks passed earlier: health 200, allowed-origin preflight 204, protected anonymous/invalid-token reads 401, forbidden-origin request 403, and missing/invalid worker credentials 401.
- Hosted scheduler dispatch and maintenance are verified. A read at 14:47 UTC showed heartbeat `14:47:01.584144+00`, scheduler enabled and no recorded operational error. Empty-queue maintenance does not establish successful collection or generation.

## Local integration coverage

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

Browser run summaries are the evidence available from TinyFish. No screenshot files were returned for independent image inspection, even though capture was requested. Do not claim pixel-level or mobile acceptance from these desktop summaries alone.

## Remaining acceptance

| Journey | Verified portion | Remaining evidence |
| --- | --- | --- |
| Identity and persistence | Real Owner session, all country filters, source-detail reload, preference write/reload/restore and server audit, desktop navigation, anonymous route/demo denial | Explicit sign-out/revocation, additional invitations/roles, mobile navigation |
| Source collection | Real catalog persistence and local collector integration | Suitable adapter/feed for a selected public listing, host configuration, actual collection/deduplication/pause and browser-closed collection |
| Original evidence | Local exact-byte hash and eligibility workflows | Eligible real RFP upload/download, extraction review and hosted original-byte persistence |
| Model and generation | Model runtime correction and compatible worker deployed; local policy and quota tests | Actual project/free-quota/billing verification, matching model policy, eligible content authorization, measured provider usage and persisted generation |
| Review and commercial flow | Local supported-claim, feedback, calculation and approval tests | Real RFP/company inputs, scoped feedback/regeneration, approved rates/assumptions and evidence-bound approval |
| Export and recovery | Local bilingual Word and two-database recovery tests | Actual artifact download/Word field review, current-workspace backup, and restore to an empty matching-schema target |

The Owner confirmed the required Gemini values were already saved in Supabase Secrets. Google account login is not required to read the configured model identity. The existing environment loader reads provider-specific or legacy name/project/key settings; it does not read billing attestations or quota values from secrets. An Owner-only metadata route and settings prefill passed local security and UI tests to use that configuration without returning keys. This is a presence/matching check, not proof of provider authentication, free billing, or remaining quota. No billing or quota facts have been invented.
