# Tenderdesk

A responsive workspace for reviewing incoming tender opportunities, uploading a request for proposal (RFP), and preparing one editable proposal file.

Production builds open the connected Supabase application, using email/password and Owner-issued invitations. Connected core records persist through authenticated, revision-checked API commands. The first Owner must accept a restricted setup invitation before any workspace is available. The release still needs real-account/email/callback acceptance; see [Implementation Checklist](../backend/docs/IMPLEMENTATION_CHECKLIST.md) for exact evidence.

The separate browser-local demo is available with `?mode=demo` and is the default during development. Its seeded organizations, tenders, rates, and claims are synthetic. The file, review, and export walkthrough below describes that demo. Connected file/proposal/review writes and restore are explicitly blocked pending later stages. Collection and AI drafting are inactive in both modes.

Update the implementation checklist with every project change. See also [backend deployment](../backend/docs/DEPLOYMENT.md) and [decisions](../backend/docs/DECISIONS.md).

## Run locally

Run these commands from `frontend/`. Requirements: Node.js 22.12+ and npm. The GitHub Pages workflow uses Node.js 24.

```bash
npm ci
npm run dev
```

Open the local URL printed by Vite, normally `http://localhost:5173`. No environment file is required. `npm run dev:demo` is an equivalent demo entry point.

```bash
npm run typecheck
npm test
npm run build
npm run preview
```

The production build is generated in `dist/`. `npm run preview` serves that build locally.

## Try the workflow

1. Open **Review inbox**. Review each discovery’s likelihood of fit, reasons, notice evidence, company references, and open questions before choosing **Add to opportunities** or archiving it. Assessment examples use synthetic notices and profile notes; changed inputs and real notices remain unassessed. **See fit example** always opens a clearly labeled standalone design example.
2. Open **Opportunities** to see only the opportunities you selected. Search, filter, and sort them, or add an opportunity directly. CSV import provides a preview before accepting valid rows.
3. Open a selected opportunity and upload its RFP and addenda. PDF, DOCX, TXT, and Markdown are supported, with a 10 MiB limit per file and up to 10 files per opportunity. Inspect extracted text and download the original when needed. A sample is included at [`public/demo-rfp.txt`](public/demo-rfp.txt).
4. In **Company knowledge**, upload company profiles, team resumes, previous proposals, templates, and other examples. Choose which files to include as references. Additional text notes are optional.
5. Return to the opportunity and choose **Generate proposal**. The intended agent action produces the full RFP-driven proposal, pricing basis, and review questions. This frontend reports the missing AI connection without fabricating a result. There is no manual two-section starter. **View a review example** opens an existing, clearly labeled sample; it does not create a response to your uploaded RFP.
6. Open a proposal to review its current saved version. **Download current Word** exports that version's content. The browser's read-only **Content for review** is text, not a claim of matching Word pagination or layout.
7. Review each section and enter its comments directly beneath it. Answer the recorded questions in their own fields. Every editable review field accepts text, files, or both; attachments stay linked to that section or question. **Pricing and its basis** explains existing recorded costs within the content review. Missing or unverified inputs appear with the other review questions; there is no separate pricing intake button or empty waiting panel. **Save review inputs** saves all section comments, answers, and attachments together without applying them to the file.
8. Choose **Regenerate proposal** once to save the complete set of inputs and a request awaiting the AI connection; a separate Save click is unnecessary. No model is called, content rewritten, or new file version claimed. In the connected workflow, the agent applies all scoped review inputs, reconciles scope and pricing, and returns a new version with remaining questions.
9. Opportunity stages follow actual data: **Awaiting RFP**, **Needs readable RFP**, **Ready to generate**, and **Has proposal**. External submission is recorded separately inside an opportunity with a proposal.

**Download agent input** remains under **Advanced** controls. It includes readable RFP text, enabled company files, saved proposal content, recorded pricing, and saved review inputs, with question/section IDs and readable attachment text. Originals are stored in this browser separately and can be downloaded beside their review field. Unreadable attachments remain listed as requiring processing and are never treated as understood answers. The JSON is an inspectable handoff, not the final prompt or proposal. Downloading does not contact an agent; original file bytes and document layout are not included in JSON backups or agent-input exports.

### Update the Word table of contents

The DOCX contains a native dynamic table of contents (TOC) and requests field updates on opening. In Word, select the entire document and update fields, then select the TOC and choose **Update Table → Update entire table**. Save the file and check pagination and headings. If Word asks whether to update fields, allow the update. The browser does not calculate final Word page numbers or produce a final PDF.

## Screens

| Route                           | Purpose                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `#/dashboard`                   | Inbox count, selected opportunities, recorded submission deadlines, and workflow guide           |
| `#/review`                      | Incoming discoveries, selection decisions, and archived items                                    |
| `#/opportunities`               | Selected opportunities, search, filtering, direct entry, and CSV import/export                   |
| `#/opportunities/:id`           | RFP uploads, generation boundary, linked proposal, closing date, and external submission         |
| `#/proposals`                   | Proposal files with access to the editor and Word download                                       |
| `#/proposals/:id`               | Current Word version, review questions and answers, justified pricing, and regeneration requests |
| `#/sources` and `#/sources/:id` | Website/RSS/JSON source configuration and local activation preferences                           |
| `#/knowledge`                   | Original company files, extracted text, reference selection, and optional notes                  |
| `#/jobs` and `#/notifications`  | Local activity, example jobs, and in-app notices                                                 |
| `#/settings` and `#/setup`      | Preferences, simulated roles, backup/restore/reset, and connection requirements                  |

Sources can be websites, RSS feeds, or JSON feeds. **Added by you** is the built-in origin for manually entered or imported opportunities, not a collection connector. Enabling a source only saves its configuration; no live crawler runs in this release.

## Data and storage

- Workspace metadata, extracted text, and original uploaded files are retained in IndexedDB in the current browser and origin. Original files are stored separately from the JSON workspace record through `src/lib/knowledgeFiles.ts`.
- File extraction runs locally. Searchable PDF text is extracted with page markers; DOCX, TXT, and Markdown yield text. There is no optical character recognition (OCR), and images and formatting are not interpreted. Scanned or partially unreadable documents require a readable replacement.
- Settings exports validated JSON backups containing records, edits, file metadata, and extracted text. **Backups do not contain original attachments.** Keep original files separately; restoring text does not restore original downloads.
- Clearing browser data removes local work and attachments. Reset replaces the workspace with sample records and removes retained originals. There is no cross-device synchronization.
- Only public, sanitized, or synthetic material belongs in this trial. Browser-local storage is not a production document repository or a server-enforced access control system.
- Use one editing tab. Concurrent editing, durable server storage, and operational backups require a backend.

The Settings role selector demonstrates interface permissions only. It is not authentication.

## Implementation and deployment

The frontend uses React, TypeScript, Vite, Tailwind CSS, Radix Dialog, React Router, Lucide, IndexedDB (`idb-keyval`), Decimal.js, Zod, Papa Parse, PDF.js, Mammoth, and `docx`. Document libraries and route pages are loaded on demand. The PDF worker is bundled locally, and dependency versions are pinned in the lockfile.

The existing [`Deploy frontend to GitHub Pages`](../.github/workflows/deploy-pages.yml) workflow checks types, runs tests, builds `dist/`, and deploys through GitHub Actions. It runs on relevant pushes to `main` or manual dispatch; documentation-only changes are ignored. The repository's Pages source must be **GitHub Actions**. Hash-based navigation and relative asset paths support the `/tenders/` deployment without rewrite rules. No server secret belongs in the compiled frontend.

## Verification and project history

Run the commands above before handoff. Component tests use jsdom and an in-memory IndexedDB implementation; they do not establish visual correctness in every browser, server authorization, AI output quality, or compatibility with every document format. Inspect the interface at desktop and mobile widths and review exported files in Word.

[`../backend/docs/IMPLEMENTATION_SPEC.txt`](../backend/docs/IMPLEMENTATION_SPEC.txt) is retained as the **historical implementation blueprint**. The subsequent user feedback and the workflow documented here supersede its earlier interface requirements for fit/evidence displays, acquisition steps, mandatory requirements forms, approval gates, and separate technical/financial exports. Its future backend requirements are not claims of completed functionality. See [`docs/FRONTEND_HANDOFF.md`](docs/FRONTEND_HANDOFF.md) for the current integration boundary.
