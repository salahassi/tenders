# Tenderdesk

A responsive workspace for reviewing incoming tender opportunities, uploading a request for proposal (RFP), and preparing one editable proposal file.

This release is a **browser-local frontend demo**. It runs without accounts, application programming interface (API) keys, a database server, or model usage. Seeded organizations, tenders, rates, and claims are synthetic. Live collection and artificial intelligence (AI) drafting are not connected.

## Run locally

Requirements: Node.js 22.12+ and npm. The GitHub Pages workflow uses Node.js 24.

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

1. Open **Review inbox**. Incoming discoveries appear here first. Choose **Add to opportunities** for items you want to pursue, or archive them. Archived items remain available in a separate inbox tab.
2. Open **Opportunities** to see only the opportunities you selected. Search, filter, and sort them, or add an opportunity directly. CSV import provides a preview before accepting valid rows.
3. Open a selected opportunity and upload its RFP and addenda. PDF, DOCX, TXT, and Markdown are supported, with a 10 MiB limit per file and up to 10 files per opportunity. Inspect extracted text and download the original when needed. A sample is included at [`public/demo-rfp.txt`](public/demo-rfp.txt).
4. In **Company knowledge**, upload company profiles, team resumes, previous proposals, templates, and other examples. Choose which files to include as references. Additional text notes are optional.
5. Return to the opportunity and choose **Create editable draft**. This creates a clearly labeled manual starter, not an AI-written proposal. Readable RFP files are required; a deadline, fit assessment, acquisition record, and separate requirements checklist are not.
6. Edit the proposal's title and free-text sections. Add, rename, reorder, or remove sections to match the RFP. Include the optional pricing table only when needed; commercial information can also be written directly in a section.
7. Choose **Generate Word file** to save the latest edits and export one DOCX containing all sections in their displayed order. Review the document before using it externally.
8. When appropriate, change the opportunity status in its details panel. **Preparing proposal** is set when a draft is created. **Submitted** records your manual action; the application never submits a bid.

**Generate with AI** and **Rewrite with AI** explain that the backend is not connected. **Download agent input** creates a JSON handoff containing readable RFP text, enabled readable company files, company notes, and the draft or rewrite request when applicable. It does not contact an agent or provider. Original files, images, and document layout are not included in that JSON.

### Update the Word table of contents

The DOCX contains a native dynamic table of contents (TOC) and requests field updates on opening. In Word, select the entire document and update fields, then select the TOC and choose **Update Table → Update entire table**. Save the file and check pagination and headings. If Word asks whether to update fields, allow the update. The browser does not calculate final Word page numbers or produce a final PDF.

## Screens

| Route                           | Purpose                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `#/dashboard`                   | Inbox count, selected opportunities, recorded submission deadlines, and workflow guide            |
| `#/review`                      | Incoming discoveries, selection decisions, and archived items                                     |
| `#/opportunities`               | Selected opportunities, search, filtering, direct entry, and CSV import/export                    |
| `#/opportunities/:id`           | RFP uploads, company-reference count, draft preparation, closing date, and status control         |
| `#/proposals`                   | Proposal files with access to the editor and Word download                                        |
| `#/proposals/:id`               | Free-text section editing, document preview, optional pricing, agent handoff, and Word generation |
| `#/sources` and `#/sources/:id` | Website/RSS/JSON source configuration and local activation preferences                            |
| `#/knowledge`                   | Original company files, extracted text, reference selection, and optional notes                   |
| `#/jobs` and `#/notifications`  | Local activity, example jobs, and in-app notices                                                  |
| `#/settings` and `#/setup`      | Preferences, simulated roles, backup/restore/reset, and connection requirements                   |

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

The existing [`Deploy frontend to GitHub Pages`](.github/workflows/deploy-pages.yml) workflow checks types, runs tests, builds `dist/`, and deploys through GitHub Actions. It runs on relevant pushes to `main` or manual dispatch; documentation-only changes are ignored. The repository's Pages source must be **GitHub Actions**. Hash-based navigation and relative asset paths support the `/tenders/` deployment without rewrite rules. No server secret belongs in the compiled frontend.

## Verification and project history

Run the commands above before handoff. Component tests use jsdom and an in-memory IndexedDB implementation; they do not establish visual correctness in every browser, server authorization, AI output quality, or compatibility with every document format. Inspect the interface at desktop and mobile widths and review exported files in Word.

[`docs/IMPLEMENTATION_SPEC.txt`](docs/IMPLEMENTATION_SPEC.txt) is retained as the **historical implementation blueprint**. The subsequent user feedback and the workflow documented here supersede its earlier interface requirements for fit/evidence displays, acquisition steps, mandatory requirements forms, approval gates, and separate technical/financial exports. Its future backend requirements are not claims of completed functionality. See [`docs/FRONTEND_HANDOFF.md`](docs/FRONTEND_HANDOFF.md) for the current integration boundary.
