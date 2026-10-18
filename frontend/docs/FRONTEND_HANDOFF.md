# Frontend handoff

## Current implementation

Automatic routing uses the saved provider order (priority or round robin). It supports Gemini, Qwen, Mistral, Groq, z.ai, OpenAI and Claude without requiring individual enable toggles. Configured API keys and owner-supplied model names determine availability; billing attestations do not gate requests. Missing credentials are skipped. An exhausted round waits and retries with visible attempts. Company/tender evidence permissions and workspace daily limits remain in force.

Owner model settings read safe server setup metadata to prefill an unsaved model/project identity. New Gemini setup defaults to Continuous free tier: Owner free-tier attestation replaces manual provider quota/expiry entry, while application daily limits and exact content authorization remain. Gemini requests run in the background with saved request IDs and automatic result checks; a network interruption resumes retrieval instead of resending generation. Check Gemini connection queues a bounded operational probe; Activity & jobs shows newest records first with Riyadh creation times, actual results and scheduled quota retries. Existing policies remain authoritative; server mismatches are visible. Keys never enter the browser, and prefill does not attest free quota or enable a provider. Untouched optional providers remain unsaved.

The connected application implements invitations and members, source review and collection/imports, original upload and extraction, company evidence, fit assessment, persistent generation/regeneration, commercial and delivery review, approval, bilingual Word export, manual acquisition/submission, operational status and complete backup/restore. See [the implementation checklist](../../backend/docs/IMPLEMENTATION_CHECKLIST.md) for source revisions, deployed components, local tests and the distinct hosted acceptance requirements. A feature being implemented does not establish that its model or source is activated.

The user journey is **Review fit → select opportunity → upload and confirm the buyer's request for proposal (RFP) → generate the full linked proposal → review content and unresolved questions → supply scoped feedback → regenerate a new version → approve and export → record manual submission**. The previous active version remains available until every regeneration stage succeeds. The user does not manually construct an outline. Actual prices, resource assumptions and commitments require explicit review.

Every build is connected-only. A legacy demo query cannot create a workspace. Saves await authenticated application programming interface (API) or Storage acceptance; failed writes preserve entered values. Synthetic records are confined to test fixtures. Accounts use invitation-only email/password. Historical actors imported during recovery are not Auth users or memberships. Pending original files in IndexedDB are temporary upload buffers, not a second workspace database.

The later decisions in [DECISIONS.md](../../backend/docs/DECISIONS.md) supersede the original outline, demo and social-login prescriptions. Owner-only controls include model policy, exact content authorization, verified company facts, rates/templates, final approval, member administration, backup/restore and confirmed permanent purge. Browser controls never replace server authorization.

## Records and background execution

Incoming discoveries appear in the review inbox; selected items appear in Opportunities. Actual file and proposal evidence determines the displayed stage. Existing proposals reopen through their linked opportunity. Preliminary fit uses substantive notice evidence and authorized company evidence; a title alone or unavailable model yields uncertainty, not an invented score or probability of winning. A full confirmed RFP refines the analysis. Reassessment preserves human decisions and earlier assessments.

The official source catalog covers Saudi Arabia, Jordan, and Palestine with country filters and institutional classifications. External manual portals keep their real names, official URLs, and access notes; they never become the built-in origin for unrelated manual opportunities. A manual portal needs an appropriate feed/adapter before automated collection, and supplier registration is distinct from a public tender listing.

Sources support bounded RSS/Atom/JSON and approved link-directory collection. The displayed Website kind retains the internal `link_directory` value. Source configuration changes pause collection. Both deployment and source host permissions must allow a destination. Import preview precedes commit. Manual collection creates a durable job; it does not claim that a collection succeeded. Jobs and source history expose attempts, quota waits, cancellation and blockers. Deployment of those handlers is distinct from activating the private scheduler or approving a live source.

Generation persists input snapshots, source-grounded requirements, questions, section steps, commercial/delivery outputs and review checkpoints. Long feedback is processed in complete overlapping segments and retained with its source references. Unsupported claims or unresolved required inputs block final approval. Splitting/repair is bounded; irreducible context or unknown provider usage becomes an explicit blocked state. Failed regeneration does not replace the active proposal version.

## Original files and review inputs

Original bytes and metadata require exact-byte eligibility review before reserving private Storage. Known prohibited patterns fail closed; a checkbox does not override them. The server independently checks size, signature, media type and SHA-256. Upload reservations are short-lived, accepted originals are immutable, and download access is rechecked. Content changes invalidate the affected approvals. Additional RFP originals and addenda preserve previous evidence versions.

`frontend/src/lib/documents.ts` and the extraction worker process PDF, DOCX, TXT and Markdown. Limits include 10 MiB per original, ten RFP files, 200 aggregate PDF pages, one million package characters and bounded extracted blocks. PDF page and DOCX structure markers support traceable quotations; extraction is not a layout-preserving image of the original. The user confirms completeness against the actual document. Scanned or unsupported content remains `needs_ocr` or `needs_processing`; no optical character recognition service or successful reading is fabricated. Browser parsing has a two-minute limit.

Section comments and question answers accept text, attachments or both. Save persists the complete scoped snapshot; Regenerate first saves it, then requests a new version. Inputs keep their original author and base-version references, and pending input does not silently rewrite current content. Reviewer edits are limited to their own inputs. Full saved feedback remains visible. Removing a pending reference does not delete an original still referenced by earlier evidence.

Review attachments accept PDF, DOCX, TXT, MD, CSV, PNG, JPG/JPEG, WEBP, XLSX and PPTX, up to ten files per field and 10 MiB per file. Images, spreadsheets and presentations are retained with honest processing status. Save/regenerate waits while parsing/uploads are active; partial failures preserve text and successful files. Company files can be included/excluded from context; verified company claims and historical examples retain different meanings.

The optional agent-input JSON download contains actual readable text, current proposal context and scoped feedback with omission/readability indicators. It is not a model call, does not include original binary files and does not grant an outside agent access. The connected generation path separately enforces server authorization, content policy and bounded processing.

## Commercial review, approval and Word export

Server-side decimal calculations use approved dated rates, explicit currencies, foreign exchange evidence, taxes, periods, contingency, markup/margin and payment schedules. Unknown input is not zero. Cost lines retain requirement, response, deliverable, quantity/effort and rate evidence. Delivery plans check dependencies and capacity. The Owner confirms the relevant inventories and calculations before approving an exact proposal/evidence version.

Exports use a frozen server-authorized snapshot. Draft and final files, and combined or separate technical/financial volumes, are explicit. The renderer embeds licensed Arabic/Latin fonts, heading styles, a native dynamic table of contents and page fields. Generated artifacts are hash-verified; reviewed Word files must retain authorized content. Reviewed PDFs require explicit Owner attestation. Downloads recheck current approval rather than relying on an old URL.

After opening a Word file, update all fields, choose **Update Table → Update entire table**, save and review the final pagination. Browser generation cannot compute final Word pagination. The read-only proposal page is a content view, not a faithful Word layout preview. Fifteen pages across four synthetic Arabic/English volume fixtures were rendered and inspected; see [EXPORT_QA.md](../../backend/docs/EXPORT_QA.md). Real Word and actual-business-document acceptance remains separate.

Acquisition and submission record human actions. Final submission records bind the exact approved version and final artifact hashes; result/correction events append to history. No file is submitted to a buyer, no purchase is made and no payment is executed by these controls.

## Recovery and operations

Owner backup includes supported business metadata, original uploads and registered export bytes with an exact hash manifest. It excludes Auth users, access grants, invitations and secrets. Restore requires an empty matching-schema target, complete validated references and verified originals; business rows commit atomically. Sources pause, models disable, content authorizations revoke and approvals invalidate. Historical authors do not gain access. The previous metadata-only JSON format is not complete recovery. See [OPERATIONS.md](../../backend/docs/OPERATIONS.md) for bounds and recovery instructions.

Dashboard/settings display actual server heartbeat, source success, queue/blocker counts, model usage and storage reservations. More than ten minutes without a heartbeat reports delayed processing. Hourly maintenance and bounded private cleanup require the hosted worker scheduler. Permanent purge requires archival, a current dependency/file preview, no live worker lease, exact title, acknowledgement and reason. Shared company/rate/source records and minimal usage accounting remain; storage capacity is released only when actual object deletion succeeds.

## Build and verification

Keep assets and build configuration in `frontend/`; shared server contracts, functions, migrations and backend tests belong in `backend/`. Use shared types, domain rules and `AppProvider`; keep business calculations out of presentation components. Preserve Arabic text, visible keyboard focus, loading/error states and responsive layouts.

Each folder owns its package and lockfile. Run `npm ci` when dependencies need installation, then `npm run typecheck`, `npm test` and `npm run build` in each folder. `.github/workflows/deploy-pages.yml` checks both packages and publishes `frontend/dist`. Documentation-only changes do not trigger Pages; a successful Pages build does not migrate Supabase.

At the October 18 completion check, **143 frontend and 171 backend tests** passed, with both typechecks/builds. API v15/worker v12 match all 14 retained files in source `a2c3bb0e7aad4092054a04ae7cf8e46184de87de`. Four real public collectors produced 35 notices; two queue migrations preserve saved-stage progress and resumed source revisions. Actual Owner company note verification, exact notice/company authorization and a real Gemini notice assessment passed. The real 87-page PDF extraction exposed and verified a PDF worker-envelope correction. 437 actual cloud metadata rows restored into isolated local PostgreSQL, with no originals in that snapshot. Hosted original upload, full real RFP generation/export and authenticated mobile remain separate acceptance requirements. See the current checklist and integration report for exact evidence. Hosted synthetic records remain prohibited.

Automatic round robin is enabled in the actual workspace. The newest operational check completed through Gemini while the three unconfigured alternatives were explicitly skipped. A fresh read-only Owner browser run verified the full completion/skipped-provider message after reload and the persisted enabled switch. Alternative-provider live inference remains untested until real account configuration is supplied.

## October 18 completion changes

Four fixed official website adapters are deployed (Jordan GTD, An-Najah, Ramallah, IsDB). Website listing settings preserve the selected adapter and catalog metadata. Real scheduled runs collected 35 notices; IsDB returned no open notice. Full listing coverage and portal registrations are separate from this bounded latest-page polling.

Company notes now expose Owner verification, using the existing audited command, and the knowledge page correctly describes private original storage and complete backups. Financial review supports entering and approving a dated cost for the specific tender without requiring a pre-existing company price catalog. The offer currency initially follows source country (SAR/JOD/ILS); unknown country stays blank, saved estimates retain their currency, and tender documents take precedence. No actual costs or final approvals are invented. Current frontend verification: 137 tests/24 files, typecheck and build.

Assessment processing controls also appear before shortlisting, with saved retry/cancel and role gates. Unknown assessment data no longer implies that AI is disconnected. Currency defaults are suggestions; tender documents take precedence. PDF extraction resolves only tagged application results and ignores library handshakes.

Final completion UI release `2fb0482fcadcbb7d8242960694f32ee97d9c5331` is published by successful [Pages 39081884914](https://github.com/salahassi/tenders/actions/runs/39081884914). 143 frontend tests passed. Collection history now includes actual run counts, including zero, and Riyadh timestamps; superseded assessments do not offer stale resume. Table labels stay within horizontal scroll containers and Knowledge tabs remain within mobile width. 28 isolated Chromium checks and real Owner collection/assessment/profile reload checks passed; fixture UI and hosted transport evidence remain distinct.


## Software scope and assessed discovery admission — October 18

Discovery settings support a software/digital transformation/AI services scope excluding hardware. Owner-selected automatic public-notice permission is exact-hash and collector-snapshot bound, preserves explicit revocations, and does not authorize private files or company notes. The actual workspace is configured for Gemini only; optional-provider code support is distinct from provider content consent.

Review inbox, dashboard and navigation counts use current recorded assessments. New queued work appears under Assessing; unqueued/blocked/failed work appears under Needs attention; excluded records remain under Outside scope. Human decisions remain independent. Clear physical-only procurement has a cited rule-based scope assessment without an inference call; ambiguous or mixed scope proceeds to the model and stays explicitly uncertain when details are missing. New-discovery notifications wait for assessment. `opportunity-discovery` exposes compact progress through an RLS-invoker view, without sending frozen plan contents to the inbox.

191 backend and 145 frontend tests passed, both package checks and Deno entry checks passed. API v16 and worker v13 source readback matched. Hosted policy activation queued all 35 original notices; full completion and browser acceptance are recorded separately in the implementation checklist.


## Notice details and model-only assessment — October 18 follow-up

Owner requires every fit/scope assessment to come from the model. Keyword and exact-phrase automatic exclusions are removed; historical rule-based results become stale. The connected inbox adds a Closed tab using server-resolved submission expiry without archiving or changing the user's decision. Detail/PDF provenance displays actual included page counts and partial/unread/OCR state. Known notice requirements and company proof remain distinct. Deployment and browser acceptance must be reconciled in the implementation checklist.

Company evidence comes from enabled, current, verified Company Knowledge notes and extracted company-file blocks. Small evidence sets are supplied completely; larger selections expose partial coverage. Assessment metadata binds citation IDs to their note/document IDs and hashes; the UI names each cited note/file. Configured scope preferences are no longer rendered as Company Knowledge evidence. Local verification: 147 frontend tests/27 files, typecheck/build.

The hosted browser confirmed Closed-tab evidence and 24/27 public attachment pages. Plans superseded by refreshed notice details do not offer resume. Latest UI verification: 149 tests/27 files and typecheck/build. This browser checkpoint observed ongoing reassessment; final model acceptance is separate.
