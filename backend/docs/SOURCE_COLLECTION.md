# Official public listing collection

Verified October 18, 2026. Four reviewed adapters run through the existing host/DNS/redirect/timeout/size controls. Each performs one unauthenticated GET of its listing every six hours. The scheduler continues without a browser. Page structure changes block visibly; no login, human-verification bypass, detail crawl, document purchase or supplier registration is attempted.

| Catalog key | Collection URL | First hosted result | Scope |
| --- | --- | --- | --- |
| jo-gtd | https://gtd.gov.jo/AR/Modules/TendersUnderOffering | 6 notices | Latest published tender table; repeated references retain the newest announcement. |
| ps-najah | https://www.najah.edu/ar/tenders/ | 19 notices | Latest page; repeated references retain the newest announcement. |
| ps-ramallah | https://www.ramallah.ps/ar/Category/33/عطاءات | 10 notices | Latest procurement cards; auctions and cancellation notices excluded. |
| sa-isdb | https://www.isdb.org/corporate-procurement/tenders-and-opportunities | 0 open notices | Closed/cancelled/awarded notices excluded. The institution is Saudi-based; procurement can concern other countries. |

The four existing reference records were activated with the Owner's full-system authorization, preserving their catalog metadata. Deployment hosts were merged into the existing dispatcher setting without changing its credential or schedule. Each activation records `source.official.activate` with prior revision and administrative execution provenance. Source interval is six hours; the backend checks its queue each minute.

Public listing requests returned HTTP 200. The GTD robots endpoint returned 451; An-Najah robots returned 403; Ramallah returned a not-found HTML page instead of robots directives. No claim of an explicit robots permission is made for those sites. IsDB's retrieved directives do not exclude this listing path. Only the already-public listing paths are used; access failures stop or defer the collector.

Collection covers the latest page, not full historical pagination. Dates are retained verbatim without inventing a timezone or classifying ambiguous/old dates as open. Notices are source evidence requiring original-document review. No known notice disappears from the workspace merely because it leaves the latest page. Registration-only and challenged portals remain manual references.

Implementation: `_shared/officialListings.ts`, selected by `adapter_config.official_listing` with kind `link_directory`. Exact origin/path binding prevents applying a trusted parser to an unrelated URL. Generic directories still discover candidate sources. Seven adapter regressions cover malformed Arabic HTML headers, duplicate announcements, schema/URL changes, unsafe detail links, non-procurement/closed records and the existing fetch safeguards.
