# Official tender source catalog

The Owner requested this real reference catalog on October 17, 2026. It contains 35 official source destinations: Saudi Arabia 14, Jordan 11, Palestine 10. It contains no invented opportunities, organizations acting as customers, procurement outcomes, credentials, or company capability claims.

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

These destinations are HTML tender listings, central procurement portals, referrals to a central portal, or supplier registration pages. They are stored as `manual`, `proposed`, `adapter_required=true`, with no approved collection host or schedule. Supported RSS/JSON collection can be configured later when an actual feed and access basis are known. A link directory can discover candidate sources or collect notices using its saved extraction settings. The catalog currently supplies reviewed extraction profiles for four public listings; a profile alone does not approve or enable collection.

Supplier registration does not guarantee invitation or award. Ministry referrals to Etimad should resolve to the same original notice when collection is implemented, avoiding duplicated opportunities. A successful HTTP response does not establish access rights, complete content, or a working collector.

## Verification on October 17, 2026

All destinations were identified through official institutional pages or indexed official procurement pages. Bounded HTTPS GET checks returned 200 for 30 destinations, 503 for SAMA/SHIRAA/Palestine General Supplies/MDLF, and 403 for Birzeit Ritaj. Those five entries explicitly record that page content could not be verified directly in the HTTP check. Etimad returned a human-verification page despite HTTP 200. No CAPTCHA, sign-in, payment, or supplier registration was completed or bypassed.

The database integration tests cover initial insertion, audit, safe text quoting, invalid Owner denial, browser-role denial, replay, existing-URL preservation, user-edited source preservation, and capacity rollback. UI tests cover portal display/filtering, honest access details, and correct attribution of newly entered opportunities. These are not browser E2E results.

## Hosted application evidence

Applied to the existing TenderDesk workspace through Supabase SQL on October 17 at 14:07 UTC. Read-back confirmed 35 distinct sources and 35 seed audit events, distributed 14/11/10 across SA/JO/PS. Reapplying preserved all rows and audit counts; the ordered row hash remained `597be706a186c46a5c47f97380cc2bbc`. Zero opportunities and jobs were created. Frontend publication and live collection acceptance are recorded separately in [the checklist](../docs/IMPLEMENTATION_CHECKLIST.md).

## Directory

| Country | Official source | Purpose | HTTP observation |
| --- | --- | --- | --- |
| SA | [اعتماد — المنافسات الحكومية](https://tenders.etimad.sa/Tender/AllTendersForVisitor) | central_platform | 200 |
| SA | [وزارة المالية السعودية — المنافسات](https://www.mof.gov.sa/tenders/Pages/default.aspx) | central_redirect | 200 |
| SA | [وزارة العدل السعودية — المنافسات](https://www.moj.gov.sa/ar/ministry/pages/tenders.aspx) | central_redirect | 200 |
| SA | [وزارة الموارد البشرية والتنمية الاجتماعية — المنافسات](https://www.hrsd.gov.sa/ministry/about-ministry/competitions-and-purchases) | central_redirect | 200 |
| SA | [وزارة الصحة السعودية — المنافسات](https://www.moh.gov.sa/Ministry/About/Pages/Tenders-and-Procurement.aspx) | central_redirect | 200 |
| SA | [أرامكو السعودية — فرص التعاقد](https://www.aramco.com/ar/what-we-do/suppliers/contracting-opportunities) | supplier_registration | 200 |
| SA | [السعودية للطاقة — الموردون](https://www.se.com.sa/ar-SA/Ourpartners/ColumnA/Our-Supply-Chains/Our-Suppliers) | supplier_registration | 200 |
| SA | [نيوم — بوابة الموردين](https://www.neom.com/en-us/our-business/suppliers) | supplier_registration | 200 |
| SA | [سابك — بوابة الموردين](https://supplier.sabic.com/) | supplier_registration | 200 |
| SA | [البنك المركزي السعودي — بوابة الموردين](https://sama.gov.sa/ar-sa/Services/ProcurementAndVendorRelations/Pages/default.aspx) | supplier_registration | 503 |
| SA | [مصرف الراجحي — الموردون](https://www.alrajhibank.com.sa/en/About-alrajhi-bank/Vendors) | supplier_registration | 200 |
| SA | [مصرف الإنماء — علاقات الموردين](https://www.alinma.com/Quick-Links/Vendor-Relations) | supplier_registration | 200 |
| SA | [صندوق الاستثمارات العامة — بوابة الموردين](https://www.pif.gov.sa/ar/private-sector-hub/become-a-supplier/register-interest/) | supplier_registration | 200 |
| SA | [البنك الإسلامي للتنمية — المشتريات المؤسسية](https://www.isdb.org/corporate-procurement/tenders-and-opportunities) | public_tenders | 200 |
| JO | [نظام الشراء الإلكتروني الأردني — JONEPS](https://www.joneps.gov.jo/) | central_platform | 200 |
| JO | [دائرة المشتريات الحكومية الأردنية — العطاءات](https://www.gpd.gov.jo/Ar/Modules/Tenders) | public_tenders | 200 |
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
| PS | [سلطة النقد الفلسطينية — العطاءات](https://www.pma.ps/tenders) | public_tenders | 200 |
| PS | [بنك فلسطين — العطاءات](https://bankofpalestine.com/ar/personal/tenders) | public_tenders | 200 |
| PS | [صندوق تطوير وإقراض الهيئات المحلية — الإعلانات](https://www.mdlf.org.ps/ar/cmspage/AllAds) | public_tenders | 503 |
| PS | [جامعة بيرزيت — العطاءات](https://ritaj.birzeit.edu/fin/tenders/public/view-tenders?orderby=reference_number%2Cdesc) | public_tenders | 403 |
| PS | [جامعة النجاح الوطنية — العطاءات](https://www.najah.edu/ar/tenders/) | public_tenders | 200 |
| PS | [بلدية رام الله — العطاءات](https://www.ramallah.ps/ar/Category/33/عطاءات) | public_tenders | 200 |
| PS | [Ooredoo فلسطين — دليل الموردين](https://www.ooredoo.ps/عن-ooredoo/دليل-الموردين.html) | supplier_registration | 200 |
| PS | [سلطة المياه الفلسطينية — العطاءات](https://www.pwa.ps/ar/Bids) | public_tenders | 200 |

## Database-owned collection settings (October 19, 2026)

The catalog owns source-specific configuration: collection URL, buyer, timezone, description template, listing/detail selectors and field labels. These optional `extraction` objects are seeded into `sources.adapter_config.extraction`. The worker reads the current source row through `collection_context` and `generation_context`; it never imports this JSON catalog or a runtime registry of institutions. The generic parser supports table, link and card layouts, validates CSS selectors and URLs, and retains host permissions, bounded fetching and schema-change errors. A source with an unsupported page structure still needs an appropriate extraction strategy.

The source editor reads and saves the database profile. Source names, links, country filter options and selectable profile content are not fixed frontend lists. Country names are localized from stored country codes. Editing configuration retains catalog metadata, pauses collection and requires review before re-enabling.

For the explicit one-time transition of existing collectors:

```sh
npm run seed:sources -- --workspace-id WORKSPACE_UUID --actor-id ACTIVE_OWNER_UUID --backfill-extraction --output /absolute/path/source-extraction.sql
```

This additionally fills a **missing** extraction profile only when the stored legacy listing key and URL still match the catalog. It preserves every other source field and increments the revision with a `source.catalog.extraction.seed` audit event. Changed URLs and existing profiles are never overwritten. Repeating the command is idempotent. Ordinary seed replay remains insert-only. No schema migration or automatic startup seed is involved.
