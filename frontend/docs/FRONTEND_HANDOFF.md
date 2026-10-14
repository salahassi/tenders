# Frontend handoff

## Current delivery boundary

Tenderdesk is a runnable, browser-local frontend with persistent records, file uploads, local text extraction, editable proposals, and Word export. It has no connected AI provider, discovery crawler, authentication service, scheduler, or procurement portal. AI controls report that dependency explicitly; they do not simulate generated content or connected success.

The current user journey is **Review fit → select opportunity → upload buyer’s RFP → generate its full linked proposal → review the file and identified issues → supply missing inputs or request changes → regenerate a new version**. Generation and regeneration remain disconnected boundaries. The UI no longer asks the user to create an outline, add sections, or fill an optional pricing form. It preserves current content separately from pending review inputs.

`backend/docs/IMPLEMENTATION_SPEC.txt` remains a historical blueprint. The later user feedback and this handoff supersede its earlier interface workflow. Do not restore the removed screens or gates merely because the old specification describes them. Reconcile any future backend contract with this simpler interface.

## Workflow and data compatibility

| Current behavior                            | Implementation detail                                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incoming discoveries appear in Review inbox | `new` and legacy `deferred` statuses are shown together; `declined` items appear under Archived                                                                               |
| Selected items appear in Opportunities      | `shortlisted`, `in_progress`, and `submitted` are the selected set                                                                                                            |
| Actual file/proposal stages                 | `getOpportunityStage` derives Awaiting RFP, Needs readable RFP, Ready to generate, or Has proposal; legacy saved status does not define progress                              |
| One linked proposal per creation journey    | The opportunity opens its existing proposal. Generate requires readable RFPs; the old manual two-section starter was removed                                                  |
| Submission recorded separately              | An opportunity with a proposal can be marked submitted externally; this does not send a file, freeze the document, or hide it from Proposals                                  |
| Preliminary fit before RFP                  | `fitPreview.ts` supplies manually authored synthetic examples with notice/company evidence and unknowns. It never runs a scoring model or reads uploaded files as if assessed |
| Closing dates are informational             | The buyer's submission deadline is optional; source notes identify where a date came from, and sample dates are labeled synthetic                                             |
| Website, RSS, and JSON sources              | Website retains the existing internal `link_directory` value; `manual` is labeled Added by you and has no crawler controls                                                    |
| Review inputs separate from file            | Answers and change requests persist under Proposal.review, with base version and a source signature; they do not alter document content                                       |
| One Word file                               | Download exports current saved content only; pending review inputs are never silently incorporated into the Word file                                                         |

Legacy `score`, `coverage`, `saved`, `requirements`, `gaps`, `acquisition`, and proposal approval fields remain in the data model for compatibility with saved work. Their presence does not establish a current UI gate. Existing approval invalidation rules remain defensive data behavior, not a requirement to obtain approval before generating a file.

Fit previews match the exact synthetic notice, company profile, and RFP context; changed inputs and imports show Not assessed. A separate example modal remains available without overwriting user data. Connected assessment must fetch available notice details/attachments, compare authorized Company Knowledge, cite both sides, and distinguish service fit, information confidence, and mandatory eligibility. A full RFP refines preliminary fit but is not a prerequisite for assessing a substantive notice. An unknown requirement is not a failed requirement. No probability of winning is inferred.

## Files, extraction, and backups

`frontend/src/lib/documents.ts` extracts local PDF, DOCX, TXT, and Markdown files. The current limits are 10 MiB per file, 200 pages per PDF, and 1,000,000 extracted characters per file. An opportunity accepts up to 10 RFP files. DOCX parsing applies bounded archive checks. A file marked `needs_ocr` requires readable text; there is no optical character recognition (OCR) service in this release. Page markers are retained for PDFs, but the extraction is not a layout-preserving representation of the original.

Both RFP and company uploads retain the original Blob in IndexedDB using `frontend/src/lib/knowledgeFiles.ts`. The serializable workspace record retains file metadata, hash, status, and extracted text. Classification selectors were removed; new uploads use the internal unspecified value without asserting whether the user file is public, sanitized, or synthetic. Older values remain compatible. Original downloads depend on the Blob being present in that browser. A restored or older workspace may have readable text without an original attachment, and the interface reports that condition instead of inventing a successful download.

Company files have categories and an include/exclude control. Only enabled files with ready, nonempty text are readable agent context. Additional company notes remain available alongside files; they do not substitute for uploaded references.

JSON workspace backups include records and extracted text, **not original file bytes**. Keep original attachments separately. Reset clears local originals and restores the sample workspace. Browser storage can also be removed by the user or browser; there is no durable remote backup. The current restore interface accepts version 1 JSON backups under 25 MiB.

## Agent input handoff

`frontend/src/lib/agentInput.ts` implements `buildAgentInput` and `downloadAgentInput`. This is a local JSON export, not a model invocation. It contains:

- The opportunity details and requested proposal language.
- Full readable text from attached RFP files, with names, IDs, classifications, and hashes.
- Full readable text from enabled company files, plus the saved company notes.
- The current proposal sections and recorded pricing inputs, with an explicit flag indicating whether pricing is included in the current file.
- Saved review answers, change requests, and pending regeneration context.
- The selected section and rewrite instructions for a rewrite request.
- A list of unreadable documents omitted from the package and explicit extraction limitations.

The package contains no original bytes, images, or document layout. It is not silently truncated to a preview excerpt. Downloading it does not give an external agent access to the browser or send the data anywhere. A connected implementation must validate these inputs, enforce access, and deliberately retrieve the authorized documents.

## Proposal generation

The proposal review page downloads current saved content through `frontend/src/lib/export.ts`. The read-only browser text is not a Word layout preview. Each section has its own comment input anchored by section ID and title; each recorded question has an independent answer input anchored by question ID. All editable review inputs accept text, attachments, or both. File-only responses are preserved without a required text placeholder. Legacy general instructions remain available as optional additional comments, not a combined destination for section edits.

One Save action preserves all inputs. One Regenerate action saves the same complete snapshot and requests a new version, without requiring Save first. Pending answers, section comments, and file references are stored separately; saving or requesting regeneration never changes sections or creates a file version. A request is explicitly awaiting_connection, not an executed job. Changes to source evidence invalidate approval without claiming a new document version. Changing actual proposal content still creates a version and invalidates approval. Older unsaved editor content is retained for explicit recovery.

Review attachment originals use the existing browser IndexedDB file store. Removing a pending attachment reference does not delete its original, because an earlier saved review/request can still refer to it. Metadata, extracted text, and scope IDs round-trip through workspace backups; original bytes do not. The agent-input package includes scoped attachment metadata and readable text, while marking unreadable files as needing processing. A future backend adapter must retrieve authorized originals, process unsupported/scanned content, and resolve conflicting input instead of treating upload presence as an answered business question. Save/regenerate are disabled while uploads are processing; partial upload errors preserve entered text and successful attachments.

Review inputs accept PDF, DOCX, TXT, MD, CSV, PNG, JPG/JPEG, WEBP, XLSX, and PPTX, up to 10 files per field and 10 MiB per file. Text and CSV are read locally; PDF/DOCX use the existing extraction path. Images, spreadsheets, and presentations are preserved as originals with `needs_processing`, not invented extracted content. `needs_ocr` and extraction errors are also retained with visible status. Restored metadata without a local original is identified beside the file.

The review interaction follows contextual document feedback patterns: [Microsoft Word comments](https://support.microsoft.com/en-us/word/give-and-receive-feedback-in-word) are tied to a document location, [Acrobat attachment comments](https://helpx.adobe.com/acrobat/desktop/share-and-review-documents/review-documents/add-attachment-comments.html) attach supporting files at a chosen location, and [GOV.UK upload/error guidance](https://design-system.service.gov.uk/components/file-upload/) calls for specific errors and clear file constraints. These inform interaction design, not a claim that the demo embeds those products.

Pricing review explains each recorded cost through a supporting RFP clause, proposal response, deliverable, quantity/effort justification, and rate source. Unchanged synthetic fixtures have explicitly labeled example traceability; altered or custom inputs are not represented as verified. Missing links, rates, currency, and assumptions become review questions. An optional analytics cost with no proposal response is explicitly flagged. The calculator uses decimal arithmetic and never treats unknown input as confirmed zero. Recorded pricing not present in the current file is labeled as awaiting incorporation into a regenerated proposal. The connected agent must derive the work breakdown from the actual RFP and proposal and follow the buyer’s required financial format; it must not infer tax, rates, or commercial commitments without support.

The DOCX has a native dynamic table of contents (TOC), heading styles, page-number fields, and an update-fields-on-open setting. After opening it in Word, update all fields, choose **Update Table → Update entire table** for the TOC, save, and review the final pagination and content. The browser does not calculate final Word pagination or create a final PDF. Arabic content is preserved and uses right-to-left paragraph settings when the opportunity language is Arabic.

## Backend integration points

| Frontend boundary                                | Required connected work                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `frontend/src/lib/store.tsx` local commands and IndexedDB | Authenticated commands, durable storage, transactional writes, conflict handling, and server-enforced authorization                        |
| Settings role simulation                         | Real identities and workspace membership; remove the role switch in connected mode                                                         |
| Source configuration                             | Permitted website/feed adapters, safe URL fetching, deduplication, schedules, and actual collection results delivered to Review inbox      |
| Original files and extracted text                | Private object storage, authorization, document/extraction versions, secure processing, retention, and recovery                            |
| Enabled company references                       | Authorized retrieval of the selected files and relevant notes, with traceable document references                                          |
| Agent input JSON                                 | A validated model/agent adapter with bounded context, clear omissions, prompt-injection defenses, and accurate job status                  |
| Generate/regenerate AI controls                  | Full document generation, grounded review findings, pricing dependencies, change application, versioned artifacts, and clear failures      |
| Proposal review and Word export                  | Durable document versions, original DOCX plus a faithful rendered preview, change summaries, and explicit handling of unresolved questions |
| Local activity and example jobs                  | Persistent job execution, idempotency, leases, retry limits, and actual run history                                                        |
| Local JSON backup                                | A complete operational recovery process covering both metadata and original files                                                          |

Do not trust browser-provided roles, document classifications, prices, or model requests as server authority. No live purchase, payment, notification to a third party, or external bid submission is implemented. Recording Submitted is a local user decision.

## Deployment and verification

The repository-root `.github/workflows/deploy-pages.yml` remains the deployment path. It installs and checks both independent packages and publishes `frontend/dist`. It installs locked dependencies, checks TypeScript, runs tests, builds, and deploys to GitHub Pages. GitHub Pages uses GitHub Actions as its source. Documentation-only changes do not trigger deployment; manual workflow dispatch is available.

From a clean checkout, run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build`. Tests use jsdom and fake IndexedDB, so they are not proof of real-browser appearance, server security, provider connectivity, or document fidelity. Before production use, check desktop/mobile layouts, keyboard navigation, representative Arabic and scanned documents, and generated DOCX files in the target Word versions. Test the connected backend separately when it exists.
