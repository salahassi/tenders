# Frontend handoff

## Current delivery boundary

The repository contains a runnable frontend and a deterministic, persisted local demo. It intentionally has no connected-mode success path. A successful frontend build does not establish that a procurement portal, model provider, authentication service, or scheduler is integrated.

The English interface preserves Arabic content and supports Arabic proposal text direction. Generated DOCX content is editable. Word calculates the dynamic TOC and pagination after the user updates fields; the browser does not render a final PDF.

## Backend integration points

| Frontend responsibility                                  | Required connected implementation                                                                                                                    |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/store.tsx` supplies state and command mutations | Replace local mutation execution with authenticated commands and server responses; retain loading, errors, revision conflicts, and pending states    |
| Demo role preview in Settings                            | GitHub OAuth, approved workspace membership, server-side authorization, and RLS; remove role simulation in connected mode                            |
| Sources and source tests                                 | Approved connector adapters, access policy checks, SSRF protection, bounded collection, deduplication, and actual run records                        |
| Opportunity score and evidence presentation              | Versioned classifications with supporting evidence; preserve unknown values and human decisions                                                      |
| Local extracted document records                         | Private original storage, immutable document/extraction versions, sealed packages, package-wide limits, retention, and safe server validation        |
| Keyword requirement suggestions                          | Structured model analysis with complete inventory review, source references, gaps, and explicit coverage limitations                                 |
| Template proposal draft                                  | Section generation with evidence-constrained prompts, verified company facts, budget reservations, and checkpointed jobs                             |
| Current proposal content/version                         | Immutable historical snapshots, separate compliance responses per proposal version, optimistic concurrency, audit integrity, and export invalidation |
| Local Owner approval and DOCX download                   | Exact-version authorization, approved artifact hashes, expiring export grants, final file review, and traceable manual submission records            |
| Jobs screen and local fixture tests                      | Persistent queue, leases, idempotency, cancellation, retry limits, scheduler heartbeat, and transactional quotas                                     |
| JSON backup                                              | Operational backup/restore and a documented recovery procedure                                                                                       |

Use the API contracts and security rules in `IMPLEMENTATION_SPEC.txt` when adding the backend. The frontend store is a seam for integration, not a substitute for server validation. Never trust a role, approval, price, document classification, or model request supplied by the browser without validation.

## Intentional frontend simplifications

- Data belongs to one browser workspace. There is no server login, cross-device synchronization, concurrent editing, background collection while the browser is closed, or offline service worker.
- Seeded scores are example assessment results. Manually added opportunities start with unknown fit and zero evidence coverage; there is no hidden model call.
- Source tests validate selected local fixtures or visibly report the connected dependency. They never fetch arbitrary user URLs.
- Document text extraction supports searchable PDF, DOCX, TXT, and Markdown. No OCR is included. Scanned/partially unreadable documents require replacement.
- Local document metadata and extracted text are retained, not original bytes. Uploading an addendum changes current supporting evidence; immutable sealed package history is backend work.
- The current proposal snapshot and action trail are saved. Historical complete content versions are not retained. Requirement responses currently belong to the opportunity; connected storage must move response ownership to each proposal version.
- Financial inputs cover direct cost lines, optional lines, markup or margin, contingency, and one explicitly entered tax percentage in SAR. Multi-currency, recurring periods, tax groups, and payment schedule validation remain additional commercial engine work; describe assumptions in commercial terms.
- Role checks in components and the local store are a demonstration of UX behavior. Anyone controlling their browser can change local data. They are not a security boundary.
- Technical/financial export separation uses section titles. The author must verify that pricing has not been entered in an unrelated technical section. Production templates should carry explicit section classifications.
- No externally submitted artifact is verified by this frontend. Manual submission records identify the recorded proposal version and receipt only.

## Verification

Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` from a clean checkout. The test suite exercises real React routes and IndexedDB state, plus financial/domain invariants. Vitest uses jsdom and a fake IndexedDB implementation. Production parsing/export code is bundled, but this does not prove every PDF/DOCX format or every target browser will work.

Before making connected mode available, run desktop/mobile visual QA, keyboard-only navigation, screen-reader checks, parser fixtures (including Arabic and scanned pages), DOCX inspection in the target Word versions, and the full backend acceptance suite. Keep actual provider pricing and quotas separate from the frontend's locally stored preferences.
