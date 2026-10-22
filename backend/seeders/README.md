# Official tender source catalog

The Owner requested this real reference catalog on October 17, 2026 and its cleanup on October 22. The current catalog contains 20 public tender destinations: Saudi Arabia 2, Jordan 10, Palestine 8. Supplier-registration pages, ministry referral pages, a legacy archive and the PMA supplier-information page have been retired. Existing workspace records require audited rejection; removing a catalog entry never deletes its history or opportunities. The catalog contains no invented opportunities, procurement outcomes, credentials, or company capability claims.

## Reuse the seeder

From `backend/`:

```sh
npm run seed:sources -- --workspace-id WORKSPACE_UUID --actor-id ACTIVE_OWNER_UUID --output /absolute/path/official-sources.sql
```

The command validates the catalog and generates SQL only. Execute the reviewed SQL using the administrative Supabase SQL connector or SQL editor on the selected project. It never connects to a database or requests credentials itself. Optional `--country ISO_CODE` limits a batch to a country present in the catalog. No seed runs automatically during signup, migration, build, or deployment. Generated SQL is workspace-specific and should stay outside Git.

Each application is atomic, locks the workspace against concurrent app commands, verifies an active Owner and identity allowlist entry, and appends an audit event for every inserted source. Audit details identify administrative execution on the Owner's request; no session or JWT is fabricated. The script creates no privileges or persistent SQL functions. Browser roles cannot execute its administrative writes.

Re-running preserves existing records, approval/pause decisions, collection settings, revisions, and audit history. It recognizes the workspace-scoped stable UUID, stored catalog key, and existing URL (including a trailing slash or fragment). It does not canonicalize arbitrary query parameters or different vendor URLs. Catalog updates add new keys; corrections to an already imported source need an explicit normal source edit. The 500-source capacity failure rolls back the entire batch.

## What an entry provides

Each entry records its country, institution type, purpose, official URL/evidence reference, review date, HTTP observation, and Arabic access note. Source tags support country filtering and institution search. Metadata is retained under `adapter_config.catalog`; notes remain visible in source details.

These destinations are public HTML tender listings or central procurement lists. They are initially stored as `manual`, `proposed`, `adapter_required=true`, with no approved collection host or schedule. A link directory can collect notices using saved extraction settings. The catalog supplies reviewed extraction profiles for ten public listings; a profile alone does not approve or enable collection. Unverified access, image-only content, PDFs and browser-dependent navigation remain explicit limits and are not treated as passing collector tests.

Supplier registration does not guarantee invitation or award. Ministry referrals to Etimad should resolve to the same original notice when collection is implemented, avoiding duplicated opportunities. A successful HTTP response does not establish access rights, complete content, or a working collector.

## October 22 preflight

Fresh requests through the canonical collector extracted Royal Jordanian 6, NEPCO 9, Arab Potash 12, JPMC 2 and Ministry of Water 8 notices. MODEE explicitly reported no current tenders. One detail URL from each nonempty source returned HTTP 200 with matching notice content; documents and bidding can have separate access requirements. Closed dated records and auctions are excluded by the saved profiles; absent deadlines remain unknown. The optional hidden supplier-login dialogs on Royal Jordanian do not make its published listing private.

A fresh Chromium request to Etimad with `PageNumber=1` returned HTTP 200 and six distinct real notice references/detail URLs. Direct HTTP can still return 403; the configured application source uses its browser-capable automatic reader. Hosted ingestion is recorded separately in the implementation checklist. No new source was accepted solely on a search result or HTTP status.

## Verification on October 17, 2026

All destinations were identified through official institutional pages or indexed official procurement pages. Bounded HTTPS GET checks returned 200 for 30 destinations, 503 for SAMA/SHIRAA/Palestine General Supplies/MDLF, and 403 for Birzeit Ritaj. Those five entries explicitly record that page content could not be verified directly in the HTTP check. Etimad returned a human-verification page despite HTTP 200. No CAPTCHA, sign-in, payment, or supplier registration was completed or bypassed.

The database integration tests cover initial insertion, audit, safe text quoting, invalid Owner denial, browser-role denial, replay, existing-URL preservation, user-edited source preservation, and capacity rollback. UI tests cover portal display/filtering, honest access details, and correct attribution of newly entered opportunities. These are not browser E2E results.

## Hosted application evidence

Applied to the existing TenderDesk workspace through Supabase SQL on October 17 at 14:07 UTC. Read-back confirmed 35 distinct sources and 35 seed audit events, distributed 14/11/10 across SA/JO/PS. Reapplying preserved all rows and audit counts; the ordered row hash remained `597be706a186c46a5c47f97380cc2bbc`. Zero opportunities and jobs were created. Frontend publication and live collection acceptance are recorded separately in [the checklist](../docs/IMPLEMENTATION_CHECKLIST.md).

## Directory

| Country | Official source | Purpose | HTTP observation |
| --- | --- | --- | --- |
| SA | [اعتماد — المنافسات الحكومية](https://tenders.etimad.sa/Tender/AllTendersForVisitor?PageNumber=1) | central_platform | 200 |
| SA | [البنك الإسلامي للتنمية — المشتريات المؤسسية](https://www.isdb.org/corporate-procurement/tenders-and-opportunities) | public_tenders | 200 |
| JO | [نظام الشراء الإلكتروني الأردني — JONEPS](https://www.joneps.gov.jo/ep/invt/selectListTendInvitAL.do?menuId=EP03000000&upperMenuId=EP03020000&subMenuId=EP03020100) | central_platform | 200 |
| JO | [دائرة العطاءات الحكومية الأردنية — عطاءات قيد الطرح](https://gtd.gov.jo/AR/Modules/TendersUnderOffering) | public_tenders | 200 |
| JO | [وزارة المياه والري الأردنية — العطاءات](https://mwi.gov.jo/AR/Modules/tenders) | public_tenders | 200 |
| JO | [وزارة الاقتصاد الرقمي والريادة — العطاءات](https://www.modee.gov.jo/AR/Modules/Tenders) | public_tenders | 200 |
| JO | [البنك المركزي الأردني — العطاءات](https://www.cbj.gov.jo/AR/List/العطاءات) | public_tenders | 200 |
| JO | [شركة الكهرباء الوطنية الأردنية — العطاءات](https://www.nepco.com.jo/en/Tenders.aspx) | public_tenders | 200 |
| JO | [شركة مناجم الفوسفات الأردنية — العطاءات](https://www.jpmc.com.jo/ar/tender) | public_tenders | 200 |
| JO | [شركة البوتاس العربية — العطاءات](https://arabpotash.com/EN/Modules/Tenders) | public_tenders | 200 |
| JO | [أمانة عمان الكبرى — المناقصات](https://www.gamtenders.gov.jo/localtenders.aspx) | public_tenders | 200 |
| JO | [الملكية الأردنية — بوابة المشتريات](https://procurement.rj.com/) | public_tenders | 200 |
| PS | [شرا — بوابة الشراء العام الفلسطينية](https://www.shiraa.gov.ps/ProcurementList) | central_platform | 503 |
| PS | [وزارة المالية الفلسطينية — مديرية اللوازم العامة](https://www.gs.pmof.ps/index.php?p=annonc) | public_tenders | 503 |
| PS | [بنك فلسطين — العطاءات](https://bankofpalestine.com/ar/personal/tenders) | public_tenders | 200 |
| PS | [صندوق تطوير وإقراض الهيئات المحلية — الإعلانات](https://mdlf.org.ps/ar/cmspage/AllAds) | public_tenders | 200 |
| PS | [جامعة بيرزيت — العطاءات](https://ritaj.birzeit.edu/fin/tenders/public/view-tenders?orderby=reference_number%2Cdesc) | public_tenders | 403 |
| PS | [جامعة النجاح الوطنية — العطاءات](https://www.najah.edu/ar/tenders/) | public_tenders | 200 |
| PS | [بلدية رام الله — العطاءات](https://www.ramallah.ps/ar/Category/33/عطاءات) | public_tenders | 200 |
| PS | [سلطة المياه الفلسطينية — العطاءات](https://www.pwa.ps/ar/Bids) | public_tenders | 200 |

## Database-owned collection settings (October 19, 2026)

The catalog owns source-specific configuration: collection URL, buyer, timezone, description template, listing/detail selectors and field labels. These optional `extraction` objects are seeded into `sources.adapter_config.extraction`. The worker reads the current source row through `collection_context` and `generation_context`; it never imports this JSON catalog or a runtime registry of institutions. The generic parser supports table, link, card and records layouts, validates CSS selectors and URLs, and retains host permissions, bounded fetching and schema-change errors. A source with an unsupported page structure still needs an appropriate extraction strategy.

The source editor reads and saves the database profile. Source names, links, country filter options and selectable profile content are not fixed frontend lists. Country names are localized from stored country codes. Editing configuration retains catalog metadata, pauses collection and requires review before re-enabling.

For the explicit one-time transition of existing collectors:

```sh
npm run seed:sources -- --workspace-id WORKSPACE_UUID --actor-id ACTIVE_OWNER_UUID --backfill-extraction --output /absolute/path/source-extraction.sql
```

This additionally fills a **missing** extraction profile only when the stored legacy listing key and URL still match the catalog. It preserves every other source field and increments the revision with a `source.catalog.extraction.seed` audit event. Changed URLs and existing profiles are never overwritten. Repeating the command is idempotent. Ordinary seed replay remains insert-only. No schema migration or automatic startup seed is involved.
