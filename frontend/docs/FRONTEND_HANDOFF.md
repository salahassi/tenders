# Frontend handoff

## Current implementation

The connected application implements invitations and members, source review and collection/imports, original upload and extraction, company evidence, fit assessment, persistent generation/regeneration, commercial and delivery review, approval, bilingual Word export, manual acquisition/submission, operational status and complete backup/restore. See [the implementation checklist](../../backend/docs/IMPLEMENTATION_CHECKLIST.md) for source revisions, deployed components, local tests and the distinct hosted acceptance requirements. A feature being implemented does not establish that its model or source is activated.

The user journey is **Review fit → select opportunity → upload and confirm the buyer's request for proposal (RFP) → generate the full linked proposal → review content and unresolved questions → supply scoped feedback → regenerate a new version → approve and export → record manual submission**. The previous active version remains available until every regeneration stage succeeds. The user does not manually construct an outline. Actual prices, resource assumptions and commitments require explicit review.

Every build is connected-only. A legacy demo query cannot create a workspace. Saves await authenticated application programming interface (API) or Storage acceptance; failed writes preserve entered values. Synthetic records are confined to test fixtures. Accounts use invitation-only email/password. Historical actors imported during recovery are not Auth users or memberships. Pending original files in IndexedDB are temporary upload buffers, not a second workspace database.

The later decisions in [DECISIONS.md](../../backend/docs/DECISIONS.md) supersede the original outline, demo and social-login prescriptions. Owner-only controls include model policy, exact content authorization, verified company facts, rates/templates, final approval, member administration, backup/restore and confirmed permanent purge. Browser controls never replace server authorization.

## Records and background execution

Incoming discoveries appear in the review inbox; selected items appear in Opportunities. Actual file and proposal evidence determines the displayed stage. Existing proposals reopen through their linked opportunity. Preliminary fit uses substantive notice evidence and authorized company evidence; a title alone or unavailable model yields uncertainty, not an invented score or probability of winning. A full confirmed RFP refines the analysis. Reassessment preserves human decisions and earlier assessments.

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

At the final local check on October 15, 115 frontend and 103 backend tests passed and both packages built successfully. The published desktop login, password-reset navigation and legacy-demo denial were inspected. Authenticated hosted behavior, real Storage, mobile layout, real provider output and cloud restore remain the explicit acceptance items in the checklist. Do not seed hosted workspaces or replace these checks with simulated success.
